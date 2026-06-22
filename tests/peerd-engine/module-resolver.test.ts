import { describe, test, expect } from 'bun:test';
import {
  resolveRelativePath,
  buildEntry,
  buildModule,
  stripExports,
} from '../../extension/peerd-engine/module-resolver.js';

const makeDeps = (files: Record<string, string>, log: any[] = []) => ({
  readFile: async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  },
  makeBlobUrl: (src: string) => `blob:test/${src.length}-${hash(src)}`,
  log: (entry: any) => log.push(entry),
});

const hash = (s: string) => s.length.toString(36) + '-' + s.charCodeAt(0).toString(16);

describe('resolveRelativePath', () => {
  test.each([
    ['scratch.js',  './utils.js',  'utils.js'],
    ['lib/foo.js',  './bar.js',    'lib/bar.js'],
    ['lib/foo.js',  '../utils.js', 'utils.js'],
    ['a/b/c.js',    '../../d.js',  'd.js'],
    ['scratch.js',  'lodash',      'lodash'],         // non-relative passes through
    ['scratch.js',  'https://x.js','https://x.js'],
  ])('resolves %s + %s → %s', (base, rel, want) => {
    expect(resolveRelativePath(base, rel)).toBe(want);
  });
});

describe('stripExports', () => {
  test('strips export keyword on declarations, keeps binding', () => {
    expect(stripExports('export const x = 1;')).toBe('const x = 1;');
    expect(stripExports('export function f(){}')).toBe('function f(){}');
    expect(stripExports('export async function g(){}')).toBe('async function g(){}');
    expect(stripExports('export class C {}')).toBe('class C {}');
  });

  test('removes export default prefix, leaves the value as expression stmt', () => {
    expect(stripExports('export default 42;')).toBe('42;');
  });

  test('drops named-export and re-export statements entirely', () => {
    expect(stripExports('export { a, b };')).toBe('');
    expect(stripExports("export { a } from './m.js';")).toBe('');
    expect(stripExports("export * from './m.js';")).toBe('');
    expect(stripExports("export * as ns from './m.js';")).toBe('');
  });

  test('preserves unrelated code', () => {
    const code = 'const z = 1;\nexport const x = 2;\nconst y = 3;';
    expect(stripExports(code)).toBe('const z = 1;\nconst x = 2;\nconst y = 3;');
  });
});

describe('buildEntry — static imports', () => {
  test('rewrites import path to blob URL', async () => {
    const files = {
      'utils.js': 'export const greet = (n) => `Hi ${n}`;',
    };
    const log: any[] = [];
    const out = await buildEntry(
      "import { greet } from './utils.js';\nreturn greet('peerd');",
      'scratch.js',
      makeDeps(files, log),
    );
    expect(out.imports).toContain('blob:test/');
    expect(out.body).not.toContain("from './utils.js'");
    expect(out.body).toContain("return greet('peerd')");
    // utils.js had `export const greet` — stays exported in the imported
    // module (we don't strip exports on imports).
    const utils = out.cache.get('utils.js');
    expect(utils?.source).toContain('export const greet');
  });

  test('chains nested imports', async () => {
    const files = {
      'a.js': "import { b } from './b.js'; export const a = () => b() + 1;",
      'b.js': "export const b = () => 1;",
    };
    const out = await buildEntry(
      "import { a } from './a.js';\nreturn a();",
      'scratch.js',
      makeDeps(files),
    );
    expect(out.cache.has('a.js')).toBe(true);
    expect(out.cache.has('b.js')).toBe(true);
    // a.js's body had `from './b.js'` — must now point at the blob URL.
    const aSrc = out.cache.get('a.js')!.source;
    expect(aSrc).not.toContain("from './b.js'");
    expect(aSrc).toContain('blob:test/');
  });

  test('relative paths resolve against the importing module dir', async () => {
    const files = {
      'lib/foo.js': "import { bar } from './bar.js'; export const foo = () => bar();",
      'lib/bar.js': 'export const bar = () => 42;',
    };
    const out = await buildEntry(
      "import { foo } from './lib/foo.js';\nreturn foo();",
      'scratch.js',
      makeDeps(files),
    );
    expect(out.cache.has('lib/foo.js')).toBe(true);
    expect(out.cache.has('lib/bar.js')).toBe(true);
  });

  test('throws on circular import', async () => {
    const files = {
      'a.js': "import './b.js';",
      'b.js': "import './a.js';",
    };
    await expect(buildEntry(
      "import './a.js';",
      'scratch.js',
      makeDeps(files),
    )).rejects.toThrow('circular import');
  });

  test('throws on missing module with the path in the message', async () => {
    await expect(buildEntry(
      "import { x } from './missing.js';\n",
      'scratch.js',
      makeDeps({}),
    )).rejects.toThrow('./missing.js');
  });
});

describe('buildEntry — re-exports', () => {
  test('re-exports are rewritten', async () => {
    const files = {
      'index.js': "export { greet } from './utils.js'; export * from './other.js';",
      'utils.js': "export const greet = () => 'hi';",
      'other.js': "export const other = 1;",
    };
    const out = await buildEntry(
      "import { greet, other } from './index.js';\nreturn { greet: greet(), other };",
      'scratch.js',
      makeDeps(files),
    );
    const indexSrc = out.cache.get('index.js')!.source;
    expect(indexSrc).not.toContain("from './utils.js'");
    expect(indexSrc).not.toContain("from './other.js'");
    expect(indexSrc).toContain('blob:test/');
  });
});

describe('buildEntry — dynamic imports', () => {
  test('import(./literal.js) is rewritten to __peerd_dynamic_import("<resolved>")', async () => {
    const files = { 'lazy.js': 'export const lazy = () => 42;' };
    const out = await buildEntry(
      "const m = await import('./lazy.js'); return m.lazy();",
      'scratch.js',
      makeDeps(files),
    );
    expect(out.body).not.toContain("'./lazy.js'");
    expect(out.body).toContain('__peerd_dynamic_import("lazy.js")');
  });

  test('dynamic import inside an imported module is rewritten too', async () => {
    const files = {
      'a.js': "export const a = async () => (await import('./b.js')).b;",
      'b.js': 'export const b = 99;',
    };
    const out = await buildEntry(
      "import { a } from './a.js';\nreturn await a();",
      'scratch.js',
      makeDeps(files),
    );
    const aSrc = out.cache.get('a.js')!.source;
    expect(aSrc).not.toContain("import('./b.js')");
    expect(aSrc).toContain('__peerd_dynamic_import("b.js")');
  });

  test('relative dynamic import resolves against the importing module dir', async () => {
    const files = {
      'lib/loader.js': "export const lazy = () => import('./helper.js');",
      'lib/helper.js': "export const x = 1;",
    };
    const out = await buildEntry(
      "import { lazy } from './lib/loader.js';\nreturn lazy();",
      'scratch.js',
      makeDeps(files),
    );
    const loaderSrc = out.cache.get('lib/loader.js')!.source;
    expect(loaderSrc).toContain('__peerd_dynamic_import("lib/helper.js")');
  });

  test('bare specifier dynamic import passes through', async () => {
    const out = await buildEntry(
      "return import('lodash');",
      'scratch.js',
      makeDeps({}),
    );
    expect(out.body).toContain('__peerd_dynamic_import("lodash")');
  });
});

describe('buildEntry — logging', () => {
  test('emits resolved log entry per module', async () => {
    const files = {
      'a.js': "import './b.js';",
      'b.js': '',
    };
    const log: any[] = [];
    await buildEntry("import './a.js';", 'scratch.js', makeDeps(files, log));
    const resolved = log.filter((l) => l.type === 'resolved').map((l) => l.path);
    expect(resolved.sort()).toEqual(['a.js', 'b.js']);
  });

  test('emits resolve-failed on missing file', async () => {
    const log: any[] = [];
    await buildEntry("import './missing.js';", 'scratch.js', makeDeps({}, log))
      .catch(() => {});
    expect(log.some((l) => l.type === 'resolve-failed' && l.path === 'missing.js')).toBe(true);
  });
});

describe('buildModule (imported-module path)', () => {
  test('keeps exports intact (we only strip on entry)', async () => {
    const files = { 'utils.js': 'export const x = 1;' };
    const entry = await buildModule('utils.js', makeDeps(files));
    // buildModule's cache.get fast path widens the return to | undefined
    if (!entry) throw new Error('expected built module');
    expect(entry.source).toContain('export const x = 1');
  });
});

describe('buildEntry — peerd:std builtin', () => {
  const STD_URL = 'chrome-extension://abc/notebook-std.js';
  const withStd = (files: Record<string, string> = {}, log: any[] = []) => ({
    ...makeDeps(files, log),
    builtins: { 'peerd:std': STD_URL },
  });

  test('rewrites a bare builtin import to its native URL', async () => {
    const out = await buildEntry(
      "import { table } from 'peerd:std';\nreturn table([]);",
      'notebook.js',
      withStd(),
    );
    expect(out.imports).toContain(`from '${STD_URL}'`);
    expect(out.imports).not.toContain("'peerd:std'");
  });

  test('without a builtins map, the bare specifier passes through untouched', async () => {
    const out = await buildEntry(
      "import { table } from 'peerd:std';\nreturn 1;",
      'notebook.js',
      makeDeps({}),
    );
    expect(out.imports).toContain("from 'peerd:std'");
  });

  test('a NESTED module importing peerd:std is rewritten too', async () => {
    const files = { 'helper.js': "import { mean } from 'peerd:std';\nexport const m = (xs) => mean(xs);" };
    const out = await buildEntry(
      "import { m } from './helper.js';\nreturn m([1, 2, 3]);",
      'notebook.js',
      withStd(files),
    );
    const helper = out.cache.get('helper.js');
    expect(helper?.source).toContain(`from '${STD_URL}'`);
    expect(helper?.source).not.toContain("'peerd:std'");
  });

  test('other bare specifiers still pass through when builtins is set', async () => {
    const out = await buildEntry(
      "import x from 'lodash';\nreturn 1;",
      'notebook.js',
      withStd(),
    );
    expect(out.imports).toContain("from 'lodash'");
  });

  test('dynamic import("peerd:std") becomes a NATIVE import of the URL (not the OPFS helper)', async () => {
    const out = await buildEntry(
      "const std = await import('peerd:std');\nreturn std.mean([1, 2, 3]);",
      'notebook.js',
      withStd(),
    );
    expect(out.body).toContain(`import(${JSON.stringify(STD_URL)})`);
    expect(out.body).not.toContain('__peerd_dynamic_import("peerd:std")');
  });
});
