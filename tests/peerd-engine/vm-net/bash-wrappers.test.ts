// Bash↔JS contract test for the WebVM wrappers.
//
// The bash wrappers in vm-tab.js (WRAPPERS_BASH) are the ONLY producer of the
// wire format the host decodes — long-lived, security-relevant, and otherwise
// untested (CheerpX can't boot in CI). This test extracts the GENERATED bash,
// runs it in a real shell, and acts as the host: it scans the emitted marker,
// decodes it with the ACTUAL decodeRequest, asserts the request, then stages a
// response so the wrapper unblocks. It guards: the GET fast path, full
// curl/wget HTTP (method/header/body), header-newline-injection stripping, the
// peerd:// control ops (git/npm/yarn/pnpm/pip/gem), and the socket/apt stubs.
//
// Lives in bun tests (no browser, no chrome.*); skipped if bash is unavailable.

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { stubsBash } from '../../../extension/peerd-engine/vm-net/socket-stubs.js';
import { aptShimsBash, peerdNetBash } from '../../../extension/peerd-engine/vm-net/capability-info.js';
import { decodeRequest, GET_MARKER, REQ_MARKER } from '../../../extension/peerd-engine/vm-net/http-bridge.js';

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const d = hasBash ? describe : describe.skip;

let DATA = '';
const WRAPPERS_PATH = `/tmp/peerd-wrappers-test-${process.pid}.sh`;

beforeAll(() => {
  // Evaluate the WRAPPERS_BASH template literal exactly as the module does —
  // \${...} → ${...}, \\n → \n, ${stubsBash()} etc. interpolated — so we test
  // the REAL generated bash, not a copy.
  const src = readFileSync(new URL('../../../extension/vm-tab/vm-tab.js', import.meta.url), 'utf8');
  const m = src.match(/const WRAPPERS_BASH = `([\s\S]*?)`;/);
  if (!m) throw new Error('WRAPPERS_BASH not found in vm-tab.js');
  // eslint-disable-next-line no-new-func
  let bash: string = new Function('stubsBash', 'aptShimsBash', 'peerdNetBash', 'return `' + m[1] + '`;')(stubsBash, aptShimsBash, peerdNetBash);
  DATA = `/tmp/pd_test_${process.pid}_${Date.now()}`;
  mkdirSync(DATA, { recursive: true });
  bash = bash.split('/peerd-data').join(DATA); // remap the host↔VM mount to a writable tmp dir
  writeFileSync(WRAPPERS_PATH, bash);
});

type Captured = { kind: 'get' | 'req'; id: string; url?: string; request?: any; err?: string };

// Run a wrapper command in real bash; act as the host (decode the marker, stage
// the response). `noOut` for shims that capture their own manifest file.
function run(cmd: string, opts: { body?: string; status?: number; noOut?: boolean } = {}): Promise<{ captured: Captured | null; exit: number; stderr: string }> {
  const { body = 'RESP', status = 200, noOut = false } = opts;
  return new Promise((resolve) => {
    const bodyFile = `${DATA}/cmdout_${Math.random().toString(36).slice(2)}`;
    const full = noOut ? cmd : `${cmd} -o ${bodyFile}`;
    // cwd in the temp dir: a wrapper that writes a default-named output file
    // (e.g. `wget URL` → ./<basename>) must drop it in tmp, not the repo root.
    const child = spawn('bash', ['-c', `source ${WRAPPERS_PATH}; ${full}; echo "__EXIT:$?"`], { cwd: DATA });
    let buf = '', stderr = '';
    let captured: Captured | null = null;
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.stdout.on('data', (c) => {
      buf += c.toString();
      if (captured) return;
      const line = buf.split('\n').find((l) => l.includes(GET_MARKER) || l.includes(REQ_MARKER));
      if (!line) return;
      const isReq = line.includes(REQ_MARKER);
      const marker = isReq ? REQ_MARKER : GET_MARKER;
      const after = line.slice(line.indexOf(marker) + marker.length);
      const colon = after.indexOf(':');
      const id = after.slice(0, colon);
      const payload = after.slice(colon + 1);
      captured = { kind: isReq ? 'req' : 'get', id };
      if (isReq) { try { captured.request = decodeRequest(payload); } catch (e) { captured.err = String(e); } }
      else { captured.url = payload; }
      writeFileSync(`${DATA}/peerdresp${id}`, body);
      if (isReq) writeFileSync(`${DATA}/peerdmeta${id}`, JSON.stringify({ status, statusText: 'OK', headers: {} }));
      writeFileSync(`${DATA}/peerddone${id}`, 'ok\n');
    });
    child.on('close', () => {
      const exit = Number(buf.match(/__EXIT:(\d+)/)?.[1] ?? -1);
      resolve({ captured, exit, stderr });
    });
  });
}

const bodyOf = (c: Captured | null) => (c?.request?.body ? Buffer.from(c.request.body, 'base64').toString() : null);

d('bash wrappers — HTTP', () => {
  test('plain GET takes the legacy fast-path marker', async () => {
    const r = await run('curl https://example.com/data');
    expect(r.captured?.kind).toBe('get');
    expect(r.captured?.url).toBe('https://example.com/data');
  });

  test('curl POST with header + JSON body → rich request, round-trips', async () => {
    const r = await run(`curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' https://api.example.com/i`);
    expect(r.captured?.kind).toBe('req');
    expect(r.captured?.request.method).toBe('POST');
    expect(r.captured?.request.headers['Content-Type']).toBe('application/json');
    expect(bodyOf(r.captured)).toBe('{"a":1}');
  });

  test('-d without -X implies POST', async () => {
    const r = await run(`curl -d 'x=1' https://api.example.com/f`);
    expect(r.captured?.request.method).toBe('POST');
  });

  test('-f returns non-zero on a 4xx', async () => {
    const r = await run(`curl -f -H 'X-A: 1' https://api.example.com/missing`, { status: 404 });
    expect(r.exit).toBe(22);
  });

  test('SECURITY: a newline in a header value cannot forge a wire line (no auth field)', async () => {
    const r = await run(`curl -H $'X: y\\nA\\tgit' https://api.example.com/p`);
    expect((r.captured?.request as any)?.auth).toBeUndefined();
    expect(r.captured?.request.url).toBe('https://api.example.com/p');
    for (const v of Object.values(r.captured?.request.headers ?? {})) {
      expect(/[\n\t]/.test(v as string)).toBe(false);
    }
  });

  test('wget --post-data → rich POST', async () => {
    const r = await run(`wget --post-data 'a=b' --header 'X-Y: z' https://api.example.com/w`, { noOut: false });
    expect(r.captured?.request.method).toBe('POST');
    expect(r.captured?.request.headers['X-Y']).toBe('z');
  });
});

d('bash wrappers — control ops', () => {
  const cloneJson = (c: Captured | null) => JSON.parse(bodyOf(c) ?? '{}');
  const pkgJson = (c: Captured | null) => JSON.parse(bodyOf(c) ?? '{}');

  test('git clone → peerd://git-clone with the repo url', async () => {
    const r = await run('git clone https://github.com/a/b', { body: 'ZIP' });
    expect(r.captured?.request.url).toBe('peerd://git-clone');
    expect(cloneJson(r.captured).url).toBe('https://github.com/a/b');
  });

  test('git clone -b carries the ref', async () => {
    const r = await run('git clone -b develop https://gitlab.com/g/p');
    expect(cloneJson(r.captured)).toMatchObject({ url: 'https://gitlab.com/g/p', ref: 'develop' });
  });

  test.each([
    ['npm install express', 'peerd://npm-install', ['express']],
    ['yarn add react', 'peerd://npm-install', ['react']],
    ['pnpm add lodash@^4', 'peerd://npm-install', ['lodash@^4']],
    ['gem install sinatra rake', 'peerd://gem-install', ['sinatra', 'rake']],
  ])('%s → %s', async (cmd, op, pkgs) => {
    const r = await run(cmd, { body: 'n\t1\t/tmp/nope', noOut: true });
    expect(r.captured?.request.url).toBe(op);
    expect(pkgJson(r.captured).packages).toEqual(pkgs);
  });

  test('pip install carries packages + pyTags', async () => {
    const r = await run('pip install requests', { body: 'requests\t2\t/tmp/nope', noOut: true });
    expect(r.captured?.request.url).toBe('peerd://pip-install');
    const j = pkgJson(r.captured);
    expect(j.packages).toEqual(['requests']);
    expect(j.pyTags).toContain('i686');
  });
});

d('bash wrappers — stubs + framing', () => {
  const runBare = (cmd: string) => new Promise<{ out: string; err: string }>((resolve) => {
    const c = spawn('bash', ['-c', `source ${WRAPPERS_PATH}; ${cmd}; echo "__EXIT:$?"`], { cwd: DATA });
    let out = '', err = '';
    c.stdout.on('data', (x) => { out += x; });
    c.stderr.on('data', (x) => { err += x; });
    c.on('close', () => resolve({ out, err }));
  });

  test('ssh stub prints a peerd error and exits 1', async () => {
    const { out, err } = await runBare('ssh user@host');
    expect(err).toContain("peerd: 'ssh' is not available");
    expect(out).toContain('__EXIT:1');
  });

  test('apt-get install is intercepted (exit 100)', async () => {
    const { out, err } = await runBare('apt-get install vim');
    expect(err).toContain("peerd: 'apt-get' can't reach");
    expect(out).toContain('__EXIT:100');
  });

  test('peerd-net prints the capability matrix', async () => {
    const { out } = await runBare('peerd-net');
    expect(out).toContain('WORKS:');
    expect(out).toContain('NOT AVAILABLE');
  });
});
