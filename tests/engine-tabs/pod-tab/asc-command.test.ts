import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  runAssemblyScript,
  type AssemblyScriptCompiler,
} from '../../../extension/engine-tabs/pod-tab/asc-command.js';

// why a variable: tsc must not type-walk the 15 MB vendored compiler.
const ASC_PATH: string = fileURLToPath(new URL('../../../extension/vendor/assemblyscript/asc.js', import.meta.url));
const loadCompiler = () => import(ASC_PATH) as Promise<AssemblyScriptCompiler>;
const GAME = 'const SPEED: f32 = 2; export function step(x: f32): f32 { return x + SPEED; }';
const COMPILE_TIMEOUT = 60_000;

const podPath = (path: string, cwd: string): string => {
  const parts = path.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`path escapes Pod workspace: ${path}`);
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

const memoryPod = (initial: Record<string, string | Uint8Array>, cwd = '/') => {
  const files = new Map<string, string | Uint8Array>(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ path: string, content: string | Uint8Array }> = [];
  return {
    files, reads, writes,
    resolve: (path: string) => podPath(path, cwd),
    workspace: {
      read: async (path: string) => {
        reads.push(path);
        const content = files.get(path);
        if (typeof content !== 'string') throw new Error(`NotFoundError: ${path}`);
        return content;
      },
      write: async (path: string, content: string | Uint8Array) => {
        writes.push({ path, content });
        files.set(path, content);
      },
      listDir: async (path: string) => [...files.keys()]
        .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/'))
        .map((file) => ({ name: file.slice(path.length + 1), kind: 'file' })),
    },
  };
};

const compileDirect = async (source: string, argv: string[]): Promise<Uint8Array> => {
  const compiler = await loadCompiler();
  let output: Uint8Array | null = null;
  const sink = { write: () => true };
  const { error } = await compiler.main(argv, {
    stdout: sink, stderr: sink,
    readFile: async (name) => (name === 'game.ts' ? source : null),
    writeFile: async (_name, contents) => { if (contents instanceof Uint8Array) output = new Uint8Array(contents); },
    listFiles: async () => [],
  });
  if (error || !output) throw new Error(`direct compile failed: ${error?.message}`);
  return output;
};

const stepOf = async (bytes: Uint8Array, x: number): Promise<number> => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return (instance.exports.step as (value: number) => number)(x);
};

describe('Pod asc command', () => {
  test('compiles a source relative to the Pod cwd and writes the exact wasm bytes', async () => {
    const pod = memoryPod({ '/game/src/game.ts': GAME }, '/game');
    const result = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
    });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(pod.reads).toContain('/game/src/game.ts');
    expect(pod.writes.map((write) => write.path)).toEqual(['/game/build/game.wasm']);
    const written = pod.files.get('/game/build/game.wasm');
    expect(written).toBeInstanceOf(Uint8Array);
    const direct = await compileDirect(GAME, ['game.ts', '-o', 'game.wasm']);
    expect([...written as Uint8Array]).toEqual([...direct]);
    expect(await stepOf(written as Uint8Array, 10)).toBe(12);
  }, COMPILE_TIMEOUT);

  test('passes asc flags through, including a text output next to the binary', async () => {
    const pod = memoryPod({ '/src/game.ts': GAME.replace('= 2', '= 5') });
    const result = await runAssemblyScript(
      ['src/game.ts', '-O3', '--runtime', 'stub', '-o', 'out/game.wasm', '-t', 'out/game.wat'],
      { available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler },
    );
    expect(result.exitCode).toBe(0);
    const wasm = pod.files.get('/out/game.wasm') as Uint8Array;
    expect([...wasm]).toEqual([...await compileDirect(GAME.replace('= 2', '= 5'),
      ['game.ts', '-O3', '--runtime', 'stub', '-o', 'game.wasm'])]);
    expect(await stepOf(wasm, 10)).toBe(15);
    expect(typeof pod.files.get('/out/game.wat')).toBe('string');
    expect(String(pod.files.get('/out/game.wat'))).toContain('(export "step"');
    const version = await runAssemblyScript(['--version'], {
      available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
    });
    expect(version).toEqual({ stdout: 'Version 0.28.20\n', stderr: '', exitCode: 0 });
  }, COMPILE_TIMEOUT);

  test('reports a compile error as plain text with the source location', async () => {
    const pod = memoryPod({ '/src/game.ts': 'export function step(): i32 { return "fast"; }' });
    const result = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR TS2322');
    expect(result.stderr).toContain('in src/game.ts(1,38)');
    expect(result.stderr).toContain('FAILURE 1 compile error(s)');
    expect(result.stderr).not.toContain('\u001B[');
    expect(pod.writes).toEqual([]);
  }, COMPILE_TIMEOUT);

  test('reports a missing source and a refused write as plain text', async () => {
    const missing = memoryPod({});
    const absent = await runAssemblyScript(['src/missing.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: missing.resolve, workspace: missing.workspace, loadCompiler,
    });
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr).toContain("File 'src/missing.ts' not found.");

    const full = memoryPod({ '/src/game.ts': GAME });
    const refused = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: full.resolve, loadCompiler,
      workspace: { ...full.workspace, write: async () => { throw new Error('file write exceeds Pod limit: 17 > 16'); } },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('file write exceeds Pod limit: 17 > 16');
  }, COMPILE_TIMEOUT);

  test('a source path cannot leave the Pod workspace', async () => {
    const pod = memoryPod({ '/src/game.ts': GAME });
    const result = await runAssemblyScript(['../../outside.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
    expect(pod.reads.every((path) => path.startsWith('/'))).toBe(true);
    expect(pod.writes).toEqual([]);
  }, COMPILE_TIMEOUT);

  test('refuses a transform flag before the compiler loads', async () => {
    for (const argv of [['src/game.ts', '--transform', './t.js'], ['src/game.ts', '--transform=./t.js']]) {
      let loads = 0;
      const pod = memoryPod({ '/src/game.ts': GAME });
      const result = await runAssemblyScript(argv, {
        available: true, resolve: pod.resolve, workspace: pod.workspace,
        loadCompiler: () => { loads += 1; return loadCompiler(); },
      });
      expect(result).toEqual({
        stdout: '', stderr: 'asc: transforms run JavaScript, so a Pod does not allow them.\n', exitCode: 2,
      });
      expect(loads).toBe(0);
    }
  });

  test('refuses a config file that sets a transform, at the top level or in a target', async () => {
    for (const config of [
      { options: { transform: ['./transform.js'] } },
      { targets: { release: { transform: './transform.js' } } },
    ]) {
      const pod = memoryPod({ '/src/game.ts': GAME, '/asconfig.json': JSON.stringify(config) });
      const result = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
        available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('asc: transforms run JavaScript, so a Pod does not allow them');
      expect(pod.reads).toContain('/asconfig.json');
      expect(pod.writes).toEqual([]);
    }
    const pod = memoryPod({ '/src/game.ts': GAME, '/asconfig.json': '{"options":{"runtime":"stub"}}' });
    const allowed = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
      available: true, resolve: pod.resolve, workspace: pod.workspace, loadCompiler,
    });
    expect(allowed.exitCode).toBe(0);
  }, COMPILE_TIMEOUT);

  test('a build without the compiler answers in plain words and never loads it', async () => {
    let loads = 0;
    const pod = memoryPod({ '/src/game.ts': GAME });
    const result = await runAssemblyScript(['src/game.ts', '-o', 'build/game.wasm'], {
      available: false, resolve: pod.resolve, workspace: pod.workspace,
      loadCompiler: () => { loads += 1; return loadCompiler(); },
    });
    expect(result).toEqual({
      stdout: '', stderr: 'asc: the AssemblyScript compiler is only in the Preview build for Chrome.\n', exitCode: 127,
    });
    expect(loads).toBe(0);
  });
});
