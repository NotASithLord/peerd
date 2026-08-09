// design js-superpower/06 — the resolver's `peerd:toolbox/<name>` branch.
// Toolbox modules resolve through the INJECTED readToolboxModule dep and then
// transform/blob exactly like a local OPFS module; the dep's ABSENCE is the
// lane refusal (a2a / site-client / page_code hosts never inject it).

import { describe, test, expect } from 'bun:test';
import {
  buildEntry,
  buildModule,
  TOOLBOX_SPECIFIER_PREFIX,
} from '../../extension/peerd-engine/module-resolver.js';

const hash = (s: string) => s.length.toString(36) + '-' + s.charCodeAt(0).toString(16);

const makeDeps = (
  files: Record<string, string>,
  toolbox: Record<string, string> | null,
  builtins: Record<string, string> = {},
) => ({
  readFile: async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  },
  makeBlobUrl: (src: string) => `blob:test/${src.length}-${hash(src)}`,
  builtins,
  ...(toolbox ? {
    readToolboxModule: async (name: string) => {
      if (!(name in toolbox)) throw new Error(`unknown toolbox module '${name}'`);
      return toolbox[name];
    },
  } : {}),
});

describe('resolver — peerd:toolbox static imports', () => {
  test('an entry toolbox import resolves via readToolboxModule and rewrites to a blob URL', async () => {
    const deps = makeDeps({}, { tables: 'export const dedupeRows = (rows) => [...new Set(rows)];' });
    const out = await buildEntry(
      "import { dedupeRows } from 'peerd:toolbox/tables';\nreturn dedupeRows([1, 1, 2]);",
      'job.js',
      deps,
    );
    expect(out.imports).toContain('blob:test/');
    expect(out.imports).not.toContain("'peerd:toolbox/tables'");
    expect(out.cache.has(`${TOOLBOX_SPECIFIER_PREFIX}tables`)).toBe(true);
  });

  test('a toolbox module may import a builtin (peerd:std) — nested rewrite to the native URL', async () => {
    const deps = makeDeps(
      {},
      { stats: "import { mean } from 'peerd:std';\nexport const avg = mean;" },
      { 'peerd:std': 'chrome-extension://abc/notebook-std.js' },
    );
    const entry = await buildModule(`${TOOLBOX_SPECIFIER_PREFIX}stats`, deps as any);
    expect(entry.source).toContain('chrome-extension://abc/notebook-std.js');
    expect(entry.source).not.toContain("'peerd:std'");
  });

  test('a toolbox module may import another toolbox module', async () => {
    const deps = makeDeps({}, {
      a: "import { b } from 'peerd:toolbox/b';\nexport const a = () => b();",
      b: 'export const b = () => 42;',
    });
    const entry = await buildModule(`${TOOLBOX_SPECIFIER_PREFIX}a`, deps as any);
    expect(entry.source).toContain('blob:test/');
    expect(entry.source).not.toContain("'peerd:toolbox/b'");
  });

  test('a toolbox→toolbox cycle is refused (circular import)', async () => {
    const deps = makeDeps({}, {
      a: "import { b } from 'peerd:toolbox/b';\nexport const a = 1;",
      b: "import { a } from 'peerd:toolbox/a';\nexport const b = 2;",
    });
    await expect(buildModule(`${TOOLBOX_SPECIFIER_PREFIX}a`, deps as any))
      .rejects.toThrow(/circular import/);
  });

  test('WITHOUT the injected dep, a toolbox import fails loudly (the lane refusal)', async () => {
    const deps = makeDeps({}, null);
    await expect(buildEntry(
      "import { x } from 'peerd:toolbox/tables';\nreturn x;",
      'job.js',
      deps,
    )).rejects.toThrow(/toolbox modules are not available in this run/);
  });

  test('an unknown toolbox module surfaces the reader error with the full specifier', async () => {
    const deps = makeDeps({}, {});
    await expect(buildModule(`${TOOLBOX_SPECIFIER_PREFIX}ghost`, deps as any))
      .rejects.toThrow(/peerd:toolbox\/ghost/);
  });

  test("a relative import INSIDE a toolbox module resolves as a toolbox sibling ('./b' → b)", async () => {
    const read: string[] = [];
    const deps = makeDeps({}, {});
    (deps as any).readToolboxModule = async (name: string) => {
      read.push(name);
      if (name === 'a') return "import { b } from './b';\nexport const a = 1;";
      if (name === 'b') return 'export const b = 2;';
      throw new Error(`unknown toolbox module '${name}'`);
    };
    await buildModule(`${TOOLBOX_SPECIFIER_PREFIX}a`, deps as any);
    expect(read).toEqual(['a', 'b']);
  });
});

describe('remote modules cannot read local toolbox modules', () => {
  const remoteDeps = (remote: Record<string, string>, toolbox: Record<string, string>) => ({
    ...makeDeps({}, toolbox),
    remoteModulesEnabled: true,
    fetchRemote: async (url: string) => {
      if (!(url in remote)) throw new Error(`unknown remote module '${url}'`);
      return remote[url];
    },
  });

  test('a direct remote to toolbox edge is refused before the toolbox reader runs', async () => {
    let toolboxReads = 0;
    const resolverDeps = remoteDeps({
      'https://cdn.test/remote.js': "import { secret } from 'peerd:toolbox/private'; export { secret };",
    }, { private: 'export const secret = "canary";' });
    const readToolboxModule = resolverDeps.readToolboxModule;
    resolverDeps.readToolboxModule = async (name: string) => {
      toolboxReads += 1;
      return readToolboxModule!(name);
    };

    await expect(buildEntry(
      "import { secret } from 'https://cdn.test/remote.js'; return secret;",
      'notebook.js', resolverDeps,
    )).rejects.toThrow('remote modules cannot import local toolbox modules');
    expect(toolboxReads).toBe(0);
  });

  test('a nested remote edge cannot reach toolbox through another remote module', async () => {
    await expect(buildEntry(
      "import { value } from 'https://cdn.test/outer.js'; return value;",
      'notebook.js',
      remoteDeps({
        'https://cdn.test/outer.js': "import { value } from './inner.js'; export { value };",
        'https://cdn.test/inner.js': "import { value } from 'peerd:toolbox/private'; export { value };",
      }, { private: 'export const value = "canary";' }),
    )).rejects.toThrow('remote modules cannot import local toolbox modules');
  });
});

describe('resolver — peerd:toolbox dynamic imports', () => {
  test('a string-literal dynamic toolbox import is refused before worker execution', async () => {
    const deps = makeDeps({}, { tables: 'export const x = 1;' });
    await expect(buildEntry(
      "const m = await import('peerd:toolbox/tables');\nreturn m.x;",
      'job.js',
      deps,
    )).rejects.toThrow('cannot run this import form');
  });
});
