import { describe, test, expect } from 'bun:test';
import { runControlOp, parseControlOp } from '../../../extension/peerd-engine/vm-net/control-ops.js';

const b64json = (o: any) => btoa(JSON.stringify(o));
const td = new TextDecoder();

// A mock IO that records calls and serves canned JSON / bytes by URL.
const makeIo = (jsonByUrl: Record<string, any> = {}, bytesByUrl: Record<string, string> = {}) => {
  const calls: { kind: string; url: string; auth?: string }[] = [];
  const staged: { name: string; bytes: Uint8Array }[] = [];
  return {
    calls, staged,
    io: {
      fetchJson: async (url: string, opts: any = {}) => { calls.push({ kind: 'json', url, auth: opts.auth }); return jsonByUrl[url] ?? null; },
      fetchBytes: async (url: string, opts: any = {}) => { calls.push({ kind: 'bytes', url, auth: opts.auth }); return url in bytesByUrl ? new TextEncoder().encode(bytesByUrl[url]) : null; },
      stage: async (name: string, bytes: Uint8Array) => { staged.push({ name, bytes }); return `/peerd-data/pkgstage_X_${name}`; },
    },
  };
};

describe('parseControlOp', () => {
  test('reads the op from the peerd:// host', () => {
    expect(parseControlOp('peerd://git-clone')).toBe('git-clone');
    expect(parseControlOp('peerd://npm-install')).toBe('npm-install');
  });
  test('unknown op → clear error', async () => {
    const r = await runControlOp({ url: 'peerd://bogus', body: null }, makeIo().io) as any;
    expect(r.errMsg).toMatch(/unknown control op 'bogus'/);
  });
});

describe('git-clone', () => {
  const cloneReq = (o: any) => ({ url: 'peerd://git-clone', body: b64json(o) });

  test('explicit ref → fetches the archive WITH git auth, returns the zip bytes', async () => {
    const url = 'https://github.com/a/b/archive/v1.0.0.zip';
    const m = makeIo({}, { [url]: 'PKZIP-BYTES' });
    const r = await runControlOp(cloneReq({ url: 'https://github.com/a/b', ref: 'v1.0.0' }), m.io) as any;
    expect(td.decode(r.bodyBytes)).toBe('PKZIP-BYTES');
    expect(r.meta.headers['x-peerd-clone-url']).toBe(url);
    // every git fetch carries auth:'git' (host-side; never from VM input)
    expect(m.calls.every((c) => c.auth === 'git')).toBe(true);
  });

  test('no ref → probes default branch, then fetches that archive', async () => {
    const m = makeIo(
      { 'https://api.github.com/repos/a/b': { default_branch: 'develop' } },
      { 'https://github.com/a/b/archive/develop.zip': 'DEV-ZIP' },
    );
    const r = await runControlOp(cloneReq({ url: 'https://github.com/a/b' }), m.io) as any;
    expect(td.decode(r.bodyBytes)).toBe('DEV-ZIP');
    expect(m.calls[0]).toMatchObject({ kind: 'json', url: 'https://api.github.com/repos/a/b', auth: 'git' });
  });

  test('probe fails → falls back to main, then master', async () => {
    const m = makeIo({}, { 'https://github.com/a/b/archive/master.zip': 'MASTER' });
    const r = await runControlOp(cloneReq({ url: 'https://github.com/a/b' }), m.io) as any;
    expect(td.decode(r.bodyBytes)).toBe('MASTER');
    const archiveTries = m.calls.filter((c) => c.kind === 'bytes').map((c) => c.url);
    expect(archiveTries).toEqual([
      'https://github.com/a/b/archive/main.zip',   // tried first
      'https://github.com/a/b/archive/master.zip', // then this
    ]);
  });

  test('gitlab clone uses the gitlab archive layout', async () => {
    const url = 'https://gitlab.com/g/s/proj/-/archive/main/proj-main.zip';
    const m = makeIo({}, { [url]: 'GL' });
    const r = await runControlOp(cloneReq({ url: 'https://gitlab.com/g/s/proj', ref: 'main' }), m.io) as any;
    expect(td.decode(r.bodyBytes)).toBe('GL');
  });

  test('no archive anywhere → descriptive error', async () => {
    const r = await runControlOp(cloneReq({ url: 'https://github.com/a/b' }), makeIo().io) as any;
    expect(r.errMsg).toMatch(/no archive found for a\/b/);
  });

  test('bad clone URL / malformed body → error', async () => {
    expect(((await runControlOp(cloneReq({ url: 'not-a-url' }), makeIo().io)) as any).errMsg).toMatch(/not a clone URL/);
    expect(((await runControlOp({ url: 'peerd://git-clone', body: 'not-base64-json!' }, makeIo().io)) as any).errMsg).toMatch(/malformed/);
  });
});

describe('npm-install', () => {
  const npmReq = (pkgs: string[]) => ({ url: 'peerd://npm-install', body: b64json({ packages: pkgs }) });
  const registry = {
    'https://registry.npmjs.org/a': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'http://r/a.tgz' }, dependencies: { b: '^2.0.0' } } } },
    'https://registry.npmjs.org/b': { 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { dist: { tarball: 'http://r/b.tgz' }, dependencies: {} } } },
  };

  test('resolves the tree, downloads (NO auth), stages, returns a TSV manifest', async () => {
    const m = makeIo(registry, { 'http://r/a.tgz': 'A', 'http://r/b.tgz': 'B' });
    const r = await runControlOp(npmReq(['a']), m.io) as any;
    const lines = td.decode(r.bodyBytes).trim().split('\n');
    expect(lines).toHaveLength(2); // a + transitive b
    expect(lines[0]).toMatch(/^a\t1\.0\.0\t\/peerd-data\/pkgstage_X_a-1\.0\.0\.tgz$/);
    expect(m.staged.map((s) => s.name).sort()).toEqual(['a-1.0.0.tgz', 'b-2.0.0.tgz']);
    // package downloads must NOT carry git auth
    expect(m.calls.filter((c) => c.kind === 'bytes').every((c) => c.auth === undefined)).toBe(true);
  });

  test('scoped name is URL-encoded in the registry request', async () => {
    const m = makeIo({ 'https://registry.npmjs.org/@scope%2fpkg': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'http://r/s.tgz' }, dependencies: {} } } } }, { 'http://r/s.tgz': 'S' });
    await runControlOp(npmReq(['@scope/pkg']), m.io);
    expect(m.calls[0].url).toBe('https://registry.npmjs.org/@scope%2fpkg');
  });

  test('a download failure → named error', async () => {
    const m = makeIo(registry, {}); // registry resolves but tarballs 404
    const r = await runControlOp(npmReq(['a']), m.io) as any;
    expect(r.errMsg).toMatch(/peerd-npm: download failed for/);
  });

  test('no packages → error', async () => {
    expect(((await runControlOp(npmReq([]), makeIo().io)) as any).errMsg).toMatch(/no packages/);
  });
});

describe('pip-install', () => {
  test('selects a pure-python wheel and passes pyTags through', async () => {
    const m = makeIo(
      { 'https://pypi.org/pypi/requests/json': { info: { version: '2.31.0', requires_dist: [] }, urls: [{ filename: 'requests-2.31.0-py3-none-any.whl', url: 'http://w/req.whl', packagetype: 'bdist_wheel' }] } },
      { 'http://w/req.whl': 'WHEEL' },
    );
    const r = await runControlOp({ url: 'peerd://pip-install', body: btoa(JSON.stringify({ packages: ['requests'], pyTags: ['i686'] })) }, m.io) as any;
    expect(m.staged[0].name).toBe('requests-2.31.0-py3-none-any.whl');
    expect(td.decode(r.bodyBytes)).toMatch(/^requests\t2\.31\.0\t/);
  });
});
