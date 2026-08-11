// peerd:wasi — run wasm32-wasi command modules against caller-built
// capabilities. The wrapper is pure values-in/values-out (module bytes + opts
// → exit/stdout/files), so it's exercised directly in bun; the fixtures are
// hand-assembled wasm (wasi-test-module.ts), so the whole path — compile,
// link against the vendored shim, _start, exit — runs for real here.

import { describe, test, expect } from 'bun:test';
import {
  runWasi, runWasiWorkspace, reconcileWorkspaceFiles,
  buildFileTree, readFileTree, WasiRunError, demoModule,
} from '../../../extension/engine-tabs/notebook-tab/notebook-wasi.js';
import {
  buildHelloModule, buildEchoModule, buildFloodModule,
  buildEmptyModule, buildNonWasiModule, buildWriteFileModule,
} from './wasi-test-module.ts';

describe('runWasi', () => {
  test('runs a command module: stdout + exit code 0', async () => {
    const result = await runWasi(buildHelloModule('hello, wasi\n'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello, wasi\n');
    expect(result.stderr).toBe('');
    expect(result.stdoutTruncated).toBe(false);
  });

  test('proc_exit code comes back as a value, not a throw', async () => {
    const result = await runWasi(buildHelloModule('failing\n', 3));
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('failing\n');
  });

  test('stdin reaches fd 0 (echo module round-trips it)', async () => {
    const result = await runWasi(buildEchoModule(), { stdin: 'piped input' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('piped input');
  });

  test('accepts a precompiled WebAssembly.Module', async () => {
    const compiled = await WebAssembly.compile(buildHelloModule('precompiled\n') as BufferSource);
    const result = await runWasi(compiled);
    expect(result.stdout).toBe('precompiled\n');
  });

  test('caps a runaway stdout and flags the truncation', async () => {
    // 200 × 4096 B ≈ 800 KiB attempted — must clamp at the 512 KiB cap.
    const result = await runWasi(buildFloodModule(200));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(512 * 1024);
    expect(result.stderrTruncated).toBe(false);
  });

  test('seed files come back in the result (unchanged tree round-trips)', async () => {
    const result = await runWasi(buildHelloModule('ok\n'), {
      files: { 'input.txt': 'seed data', 'data/nested.txt': 'deeper' },
    });
    expect(result.files['input.txt']).toBe('seed data');
    expect(result.files['data/nested.txt']).toBe('deeper');
  });

  test('refuses a module without _start (reactor / empty)', async () => {
    await expect(runWasi(buildEmptyModule())).rejects.toThrow(WasiRunError);
    await expect(runWasi(buildEmptyModule())).rejects.toThrow(/command module/);
  });

  test('refuses a module that wants non-WASI imports, with an actionable message', async () => {
    await expect(runWasi(buildNonWasiModule())).rejects.toThrow(WasiRunError);
    await expect(runWasi(buildNonWasiModule())).rejects.toThrow(/WASI preview1/);
  });

  test('rejects junk bytes at compile', async () => {
    await expect(runWasi(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  test('the shim debug logger stays OFF (no per-syscall console spam)', async () => {
    // Upstream gotcha: the WASI ctor treats an omitted debug option as
    // enable(TRUE). The wrapper passes { debug: false }; a regression here
    // floods every Notebook run's captured console with "wasi:" lines.
    const original = console.log;
    const logged: unknown[][] = [];
    console.log = (...logArgs: unknown[]) => { logged.push(logArgs); };
    try {
      await runWasi(buildHelloModule('quiet\n'), { files: { 'f.txt': 'x' } });
    } finally {
      console.log = original;
    }
    expect(logged.filter((l) => l.some((a) => String(a).includes('wasi:'))).length).toBe(0);
  });
});

describe('buildFileTree / readFileTree', () => {
  test('nested paths round-trip through the tree', () => {
    const tree = buildFileTree({
      'a.txt': 'top',
      'dir/b.txt': 'mid',
      'dir/sub/c.txt': 'deep',
    });
    expect(readFileTree(tree)).toEqual({
      'a.txt': 'top',
      'dir/b.txt': 'mid',
      'dir/sub/c.txt': 'deep',
    });
  });

  test('binary (non-UTF-8) content stays Uint8Array on the way out', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const out = readFileTree(buildFileTree({ 'blob.bin': bytes }));
    expect(out['blob.bin']).toBeInstanceOf(Uint8Array);
    expect([...(out['blob.bin'] as Uint8Array)]).toEqual([0xff, 0xfe, 0x00, 0x80]);
  });

  test('a path through an existing FILE is a conflict, not silent nesting', () => {
    expect(() => buildFileTree({ 'x': 'file', 'x/y.txt': 'nested' })).toThrow(/conflict/);
  });

  test('empty path segments are rejected', () => {
    expect(() => buildFileTree({ '': 'nope' })).toThrow(TypeError);
  });
});

describe('runWasiWorkspace: Pod shared workspace adapter', () => {
  test('a real WASI path_open/fd_write mutation is reconciled into the host workspace', async () => {
    const files = new Map<string, Uint8Array>([
      ['kept.txt', new TextEncoder().encode('existing')],
    ]);
    const writes: string[] = [];
    const deletes: string[] = [];
    const workspace = {
      list: async () => [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength })),
      readBytes: async (path: string) => files.get(path)!.slice(),
      write: async (path: string, content: string | Uint8Array | ArrayBuffer) => {
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content)
          : content instanceof Uint8Array ? content.slice() : new Uint8Array(content.slice(0));
        files.set(path, bytes);
        writes.push(path);
      },
      delete: async (path: string) => { files.delete(path); deletes.push(path); },
    };
    const result = await runWasiWorkspace(buildWriteFileModule('made.txt', 'from wasi\n'), { workspace });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(files.get('made.txt'))).toBe('from wasi\n');
    expect(new TextDecoder().decode(files.get('kept.txt'))).toBe('existing');
    expect(writes).toEqual(['made.txt']);
    expect(deletes).toEqual([]);
    expect(result.changedFiles).toEqual(['made.txt']);
  });

  test('minimal reconciliation writes changed/new files and deletes vanished files only', () => {
    const before = { same: 'x', changed: 'old', removed: 'bye' };
    const after = { same: 'x', changed: 'new', added: new Uint8Array([1, 2]) };
    const result = reconcileWorkspaceFiles(before, after);
    expect(Object.keys(result.writes).sort()).toEqual(['added', 'changed']);
    expect(result.deletes).toEqual(['removed']);
  });

  test('snapshot file/byte budgets fail before WASM receives authority', async () => {
    let read = false;
    const workspace = {
      list: async () => [{ path: 'big.bin', size: 5 }],
      readBytes: async () => { read = true; return new Uint8Array(5); },
      write: async () => {}, delete: async () => {},
    };
    await expect(runWasiWorkspace(demoModule(), { workspace, maxBytes: 4 })).rejects.toThrow(/snapshot budget/);
    expect(read).toBe(false);
  });

  test('unsafe snapshot paths fail before reads or mutations', async () => {
    let touched = false;
    const workspace = {
      list: async () => [{ path: '../escape.txt', size: 1 }],
      readBytes: async () => { touched = true; return new Uint8Array(1); },
      write: async () => { touched = true; }, delete: async () => { touched = true; },
    };
    await expect(runWasiWorkspace(demoModule(), { workspace })).rejects.toThrow(/unsafe WASI workspace path/);
    expect(touched).toBe(false);
  });

  test('a safe in-budget snapshot reaches the read capability', async () => {
    let read = false;
    const workspace = {
      list: async () => [{ path: 'safe.txt', size: 1 }],
      readBytes: async () => { read = true; return Uint8Array.of(120); },
      write: async () => {}, delete: async () => {},
    };
    const result = await runWasiWorkspace(demoModule(), { workspace, maxBytes: 4 });
    expect(read).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe('demoModule — the embedded self-test fixture', () => {
  test('the embedded blob IS buildHelloModule("hello from wasi\\n") — blob and source cannot drift', () => {
    expect([...demoModule()]).toEqual([...buildHelloModule('hello from wasi\n')]);
  });

  test('runWasi(demoModule()) runs green: the agent-facing smoke test works', async () => {
    const result = await runWasi(demoModule());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from wasi\n');
    expect(result.stderr).toBe('');
  });
});
