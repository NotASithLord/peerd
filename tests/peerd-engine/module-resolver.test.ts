import { describe, test, expect } from 'bun:test';
import {
  resolveRelativePath,
  buildEntry,
  buildModule,
  stripExports,
  isRemoteSpecifier,
  makeFetchRemote,
  REMOTE_MODULE_MAX_CHARS,
  REMOTE_MODULES_MAX_PER_RUN,
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

describe('resolveRelativePath — URL base (remote modules)', () => {
  test.each([
    ['https://cdn.test/a/b.js', './c.js',  'https://cdn.test/a/c.js'],
    ['https://cdn.test/a/b.js', '../c.js', 'https://cdn.test/c.js'],
    ['https://cdn.test/lib.js#sha256-abc', './x.js', 'https://cdn.test/x.js'],  // pin never inherits
  ])('resolves %s + %s → %s', (base, rel, want) => {
    expect(resolveRelativePath(base, rel)).toBe(want);
  });
});

describe('remote (https) imports via injected fetchRemote', () => {
  const makeRemoteDeps = (
    remote: Record<string, string>,
    files: Record<string, string> = {},
    fetched: string[] = [],
  ) => ({
    ...makeDeps(files),
    fetchRemote: async (url: string) => {
      fetched.push(url);
      if (!(url in remote)) throw new Error(`denylisted: ${url}`);
      return remote[url];
    },
  });

  test('isRemoteSpecifier matches http(s) URLs only — case-insensitively (schemes are)', () => {
    expect(isRemoteSpecifier('https://cdn.test/x.js')).toBe(true);
    expect(isRemoteSpecifier('http://cdn.test/x.js')).toBe(true);
    expect(isRemoteSpecifier('HTTPS://cdn.test/x.js')).toBe(true);
    expect(isRemoteSpecifier('Http://cdn.test/x.js')).toBe(true);
    expect(isRemoteSpecifier('lodash')).toBe(false);
    expect(isRemoteSpecifier('./x.js')).toBe(false);
    expect(isRemoteSpecifier('//cdn.test/x.js')).toBe(false);
    expect(isRemoteSpecifier('peerd:std')).toBe(false);
  });

  test('an UPPERCASE-scheme import rides the audited path, never the native loader', async () => {
    const fetched: string[] = [];
    const out = await buildEntry(
      "import { x } from 'HTTPS://cdn.test/lib.js';\nreturn x;",
      'scratch.js',
      makeRemoteDeps({ 'HTTPS://cdn.test/lib.js': 'export const x = 1;' }, {}, fetched),
    );
    expect(fetched).toEqual(['HTTPS://cdn.test/lib.js']);
    expect(out.imports).toContain('blob:test/');
    expect(out.imports).not.toContain('HTTPS://');
  });

  test('a protocol-relative specifier fails CLOSED with a named refusal (static + dynamic)', async () => {
    // '//cdn…' is not remote per the predicate and would otherwise pass
    // through to the worker's native loader — the unaudited near-miss.
    await expect(buildEntry(
      "import '//cdn.test/x.js';",
      'scratch.js',
      makeRemoteDeps({}),
    )).rejects.toThrow('protocol-relative');
    await expect(buildEntry(
      "return import('//cdn.test/x.js');",
      'scratch.js',
      makeRemoteDeps({}),
    )).rejects.toThrow('protocol-relative');
  });

  test('a static https import is fetched through fetchRemote and re-blobbed', async () => {
    const fetched: string[] = [];
    const out = await buildEntry(
      "import { answer } from 'https://cdn.test/lib.js';\nreturn answer;",
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/lib.js': 'export const answer = 42;' }, {}, fetched),
    );
    expect(fetched).toEqual(['https://cdn.test/lib.js']);
    expect(out.imports).toContain('blob:test/');
    expect(out.imports).not.toContain('https://cdn.test/lib.js');
    expect(out.cache.get('https://cdn.test/lib.js')?.source).toContain('export const answer');
  });

  test('a remote module’s relative import resolves against ITS url', async () => {
    const fetched: string[] = [];
    const out = await buildEntry(
      "import { lib } from 'https://cdn.test/pkg/lib.js';\nreturn lib;",
      'scratch.js',
      makeRemoteDeps({
        'https://cdn.test/pkg/lib.js': "import { base } from './base.js'; export const lib = base + 1;",
        'https://cdn.test/pkg/base.js': 'export const base = 41;',
      }, {}, fetched),
    );
    expect(fetched.sort()).toEqual(['https://cdn.test/pkg/base.js', 'https://cdn.test/pkg/lib.js']);
    const libSrc = out.cache.get('https://cdn.test/pkg/lib.js')!.source;
    expect(libSrc).not.toContain("'./base.js'");
    expect(libSrc).toContain('blob:test/');
  });

  test('a remote module importing a builtin (peerd:std) is rewritten to its native URL', async () => {
    const STD = 'chrome-extension://abc/notebook-std.js';
    const out = await buildEntry(
      "import { m } from 'https://cdn.test/stats.js';\nreturn m;",
      'scratch.js',
      {
        ...makeRemoteDeps({ 'https://cdn.test/stats.js': "import { mean } from 'peerd:std'; export const m = mean([1]);" }),
        builtins: { 'peerd:std': STD },
      },
    );
    const src = out.cache.get('https://cdn.test/stats.js')!.source;
    expect(src).toContain(`from '${STD}'`);
    expect(src).not.toContain("'peerd:std'");
  });

  test('the same URL imported twice is fetched once (per-run cache)', async () => {
    const fetched: string[] = [];
    await buildEntry(
      [
        "import { a } from 'https://cdn.test/shared.js';",
        "import { b } from './local.js';",
        'return a + b;',
      ].join('\n'),
      'scratch.js',
      makeRemoteDeps(
        { 'https://cdn.test/shared.js': 'export const a = 1;\nexport const b = 2;' },
        { 'local.js': "import { a } from 'https://cdn.test/shared.js'; export const b = a + 1;" },
        fetched,
      ),
    );
    expect(fetched).toEqual(['https://cdn.test/shared.js']);
  });

  test('a remote↔remote cycle is detected across the URL branch', async () => {
    await expect(buildEntry(
      "import 'https://cdn.test/a.js';",
      'scratch.js',
      makeRemoteDeps({
        'https://cdn.test/a.js': "import './b.js';",
        'https://cdn.test/b.js': "import './a.js';",
      }),
    )).rejects.toThrow('circular import');
  });

  test('without fetchRemote, an https import fails closed with the WHY (no network)', async () => {
    await expect(buildEntry(
      "import { x } from 'https://cdn.test/lib.js';\nreturn x;",
      'scratch.js',
      makeDeps({}),
    )).rejects.toThrow('no network');
  });

  test('a fetch failure (denylist et al) surfaces as the resolver error', async () => {
    await expect(buildEntry(
      "import { x } from 'https://evil.test/lib.js';\nreturn x;",
      'scratch.js',
      makeRemoteDeps({}),
    )).rejects.toThrow('denylisted: https://evil.test/lib.js');
  });

  test('a module over the per-module size cap is refused', async () => {
    await expect(buildEntry(
      "import 'https://cdn.test/huge.js';",
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/huge.js': 'x'.repeat(REMOTE_MODULE_MAX_CHARS + 1) }),
    )).rejects.toThrow('per-module cap');
  });

  test('the per-run remote-fetch count cap is enforced across the graph', async () => {
    const remote: Record<string, string> = {};
    const importLines: string[] = [];
    for (let i = 0; i <= REMOTE_MODULES_MAX_PER_RUN; i += 1) {
      remote[`https://cdn.test/m${i}.js`] = `export const v${i} = ${i};`;
      importLines.push(`import 'https://cdn.test/m${i}.js';`);
    }
    await expect(buildEntry(
      importLines.join('\n'),
      'scratch.js',
      makeRemoteDeps(remote),
    )).rejects.toThrow('per-run cap');
  });

  test('a graph of EXACTLY the per-run cap resolves (boundary — a tightening regresses loud)', async () => {
    const remote: Record<string, string> = {};
    const importLines: string[] = [];
    for (let i = 0; i < REMOTE_MODULES_MAX_PER_RUN; i += 1) {
      remote[`https://cdn.test/m${i}.js`] = `export const v${i} = ${i};`;
      importLines.push(`import 'https://cdn.test/m${i}.js';`);
    }
    const fetched: string[] = [];
    const out = await buildEntry(
      importLines.join('\n'),
      'scratch.js',
      makeRemoteDeps(remote, {}, fetched),
    );
    expect(fetched.length).toBe(REMOTE_MODULES_MAX_PER_RUN);
    expect(out.cache.size).toBe(REMOTE_MODULES_MAX_PER_RUN);
  });

  test('a FAILED fetch still consumes cap budget (no free retries for a hostile graph)', async () => {
    const deps = makeRemoteDeps({ 'https://cdn.test/ok.js': 'export const x = 1;' });
    const cache = new Map<string, { blobUrl: string, source: string }>();
    for (let i = 0; i < REMOTE_MODULES_MAX_PER_RUN; i += 1) {
      await buildModule(`https://evil.test/m${i}.js`, deps, cache).catch(() => {});
    }
    await expect(buildModule('https://cdn.test/ok.js', deps, cache)).rejects.toThrow('per-run cap');
  });

  test('a #sha256 pin verifies (and a mismatch is refused)', async () => {
    const source = 'export const pinned = true;';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const pin = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const ok = await buildEntry(
      `import { pinned } from 'https://cdn.test/lib.js#sha256-${pin}';\nreturn pinned;`,
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/lib.js': source }),
    );
    expect(ok.cache.has(`https://cdn.test/lib.js#sha256-${pin}`)).toBe(true);
    await expect(buildEntry(
      "import { pinned } from 'https://cdn.test/lib.js#sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';\nreturn pinned;",
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/lib.js': source }),
    )).rejects.toThrow('failed its #sha256 pin');
  });

  test.each([
    ['https://cdn.test/lib.js#sha256-abc!def'],   // stray char in the hash
    ['https://cdn.test/lib.js#sha384-AAAA'],      // wrong algorithm tag
    ['https://cdn.test/lib.js#sha256=AAAA'],      // wrong separator
    ['https://cdn.test/lib.js#sha256-AAAA#x'],    // second fragment
    ['https://cdn.test/lib.js#readme'],           // any non-pin fragment
  ])('a malformed pin fails CLOSED without fetching unpinned (%s)', async (spec) => {
    // A near-miss pin must never degrade to "no pin" — the author believed
    // this code was pinned. Fragments never reach the server, so refusing
    // every non-pin fragment costs nothing legitimate.
    const fetched: string[] = [];
    await expect(buildEntry(
      `import '${spec}';`,
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/lib.js': 'export const x = 1;' }, {}, fetched),
    )).rejects.toThrow('integrity pin');
    expect(fetched).toEqual([]);   // refused BEFORE any fetch
  });

  test('a #sha256 pin applies on the dynamic-import (compose-module) path too', async () => {
    const source = 'export const pinned = 7;';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const pin = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const good = await buildModule(
      `https://cdn.test/lazy.js#sha256-${pin}`,
      makeRemoteDeps({ 'https://cdn.test/lazy.js': source }),
    );
    expect(good.source).toContain('export const pinned');
    await expect(buildModule(
      'https://cdn.test/lazy.js#sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      makeRemoteDeps({ 'https://cdn.test/lazy.js': source }),
    )).rejects.toThrow('failed its #sha256 pin');
  });

  test('a base64url pin verifies the same bytes as standard base64', async () => {
    const source = 'export const pinned = 1;';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const out = await buildEntry(
      `import { pinned } from 'https://cdn.test/lib.js#sha256-${b64url}';\nreturn pinned;`,
      'scratch.js',
      makeRemoteDeps({ 'https://cdn.test/lib.js': source }),
    );
    expect(out.imports).toContain('blob:test/');
  });

  test('a string-literal dynamic import of an https URL routes through __peerd_dynamic_import', async () => {
    const out = await buildEntry(
      "const m = await import('https://cdn.test/lazy.js'); return m.x;",
      'scratch.js',
      makeDeps({}),
    );
    // resolution is deferred to the host compose-module path at runtime,
    // where buildModule applies the SAME fetchRemote gating.
    expect(out.body).toContain('__peerd_dynamic_import("https://cdn.test/lazy.js")');
  });

  test('a relative dynamic import INSIDE a remote module resolves against its URL', async () => {
    const out = await buildEntry(
      "import { lazy } from 'https://cdn.test/pkg/loader.js';\nreturn lazy();",
      'scratch.js',
      makeRemoteDeps({
        'https://cdn.test/pkg/loader.js': "export const lazy = () => import('./helper.js');",
      }),
    );
    const src = out.cache.get('https://cdn.test/pkg/loader.js')!.source;
    expect(src).toContain('__peerd_dynamic_import("https://cdn.test/pkg/helper.js")');
  });
});

describe('makeFetchRemote (the shared host fetch/decode)', () => {
  test('decodes utf-8 body bytes and sends noCache:true on EVERY module fetch', async () => {
    const reqs: any[] = [];
    const fetchRemote = makeFetchRemote(async (req) => {
      reqs.push(req);
      return { ok: true, status: 200, bodyB64: Buffer.from('export const s = "héllo";', 'utf8').toString('base64') };
    });
    expect(await fetchRemote('https://cdn.test/x.js')).toBe('export const s = "héllo";');
    // noCache is the load-bearing bit: module source must never serve from the
    // IDB cache (a warm hit would skip the denylist re-check + audit).
    expect(reqs).toEqual([{ url: 'https://cdn.test/x.js', method: 'GET', noCache: true }]);
  });

  test('a relay refusal surfaces as its error message; a bodyless 200 decodes empty', async () => {
    const refused = makeFetchRemote(async () => ({ ok: false, status: 0, error: 'denylisted: https://evil.test/x.js' }));
    await expect(refused('https://evil.test/x.js')).rejects.toThrow('denylisted: https://evil.test/x.js');
    const empty = makeFetchRemote(async () => ({ ok: true, status: 200, bodyB64: null }));
    expect(await empty('https://cdn.test/empty.js')).toBe('');
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
