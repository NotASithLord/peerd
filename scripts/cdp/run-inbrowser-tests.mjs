#!/usr/bin/env bun
// Real-Chrome harness for peerd's IN-BROWSER test suite.
//
// The in-browser runner (extension/tests/runner.html) is designed to run over
// http too — bootstrap.js synthesizes chrome.runtime.id and the suite uses
// mocks (extension/tests/mocks) for chrome.* — so we don't need to load the
// extension at all (which Chrome blocks from top-level CDP navigation). We
// serve extension/ as the web root over http and drive a headless Chrome over
// the DevTools Protocol with the runtime's built-in WebSocket (no npm CDP
// client). Runs under Bun (global WebSocket + fetch, node:* builtins) — which
// is what CI and local both use; also works under plain Node >= 22.
//
// Usage:  bun scripts/cdp/run-inbrowser-tests.mjs [path/to/extension]
// Env:    CHROME_PATH or CHROME — explicit Chrome/Chromium binary
//         (browser-actions/setup-chrome exports CHROME_PATH in CI).
// Exit:   0 if all in-browser tests pass, 1 otherwise.

import { resolve, join, dirname, extname, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

// why fileURLToPath: this repo lives under a path with SPACES (iCloud
// Desktop). new URL(...).pathname leaves them %20-encoded, so the derived
// default extension dir 404s on every request. fileURLToPath decodes.
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(process.argv[2] ?? join(HERE, '..', '..', 'extension'));

// why PATH scan + mac fallback: CI (ubuntu + setup-chrome) sets CHROME_PATH;
// local macOS dev machines have the .app binary; everything else is a
// best-effort PATH lookup. No fixed path, no fixed platform.
const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const CHROME = process.env.CHROME_PATH || process.env.CHROME
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  || ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(onPath).find(Boolean);

// The suite takes ~40s on a dev laptop; CI runners are slower and module
// loading over localhost http adds tail latency. 180s of budget keeps the
// poll from racing the suite it is waiting for.
const RESULT_BUDGET_MS = 180_000;
const POLL_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static file server rooted at extension/ ------------------------------
// Absolute module specifiers like /peerd-egress/index.js resolve here.
// Ephemeral port (listen(0)) — never collides with another dev process.
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const server = createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = join(EXT, p);
  // join() collapses any ../ — refuse anything that escaped the web root.
  if (!file.startsWith(EXT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// --- chrome + CDP ---------------------------------------------------------
let chrome, profile;
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// --remote-debugging-port=0 lets Chrome pick an ephemeral port; it writes
// the chosen one to <profile>/DevToolsActivePort. Poll for that file.
const waitForCdpPort = async () => {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    try {
      const port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (port > 0) {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return port;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint never came up');
};

const attach = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') events.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') events.push('ERR ' + (m.params.args || []).map((a) => a.value || a.description || a.type).join(' '));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close(), events };
};

const main = async () => {
  if (typeof WebSocket !== 'function') {
    console.error('this harness needs a global WebSocket — run with Node >= 22 (or Bun).');
    process.exit(1);
  }
  if (!CHROME) {
    console.error('no Chrome/Chromium binary found — set CHROME_PATH (or CHROME) to one.');
    process.exit(1);
  }

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const httpPort = server.address().port;

  profile = mkdtempSync(join(tmpdir(), 'peerd-prof-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    // why --no-sandbox: required inside CI containers/runners without
    // user-namespace privileges; harmless for this throwaway profile that
    // only ever loads 127.0.0.1.
    '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  const cdpPort = await waitForCdpPort();

  // why ?ci=1: the runner only writes the __TEST_RESULT__ marker we poll
  // for in CI mode (extension/tests/runner.js) — without it this harness
  // can never see a result.
  //
  // why localhost (not 127.0.0.1) in the URL: WebAuthn refuses IP
  // addresses as RP IDs ("SecurityError: This is an invalid domain"),
  // and the suite drives real navigator.credentials ceremonies against
  // CDP virtual authenticators. "localhost" is both a secure context and
  // a valid RP ID; Chrome resolves it to the loopback the server is
  // bound to.
  const url = `http://localhost:${httpPort}/tests/runner.html?ci=1`;

  // Create a blank target first and enable Runtime BEFORE navigating, so
  // load-time exceptions (broken imports, top-level throws) are captured
  // instead of silently producing a blank "no result marker" failure.
  const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, close, events } = await attach(created.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');

  // --- WebAuthn virtual authenticators --------------------------------
  // Two deliberately different personalities so the suite can exercise
  // both enrollment flavors AND the PRF-honesty failure path:
  //   - 'internal' + hasPrf  → a platform authenticator (Touch ID-like);
  //     attachment 'platform' ceremonies land here.
  //   - 'usb' WITHOUT hasPrf → an old security key; attachment
  //     'cross-platform' ceremonies land here and must FAIL enrollment
  //     (prf.enabled comes back false).
  // The injected flag tells the suite the authenticators exist — the
  // WebAuthn ceremony tests register only under this harness (a manually
  // opened runner.html has no virtual authenticators to ceremony
  // against). Failure is non-fatal: an older Chrome without the WebAuthn
  // domain just runs the suite without the flag.
  try {
    const en = await send('WebAuthn.enable');
    if (en.error) throw new Error(en.error.message);
    const common = {
      protocol: 'ctap2', ctap2Version: 'ctap2_1',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    };
    for (const opts of [
      { ...common, transport: 'internal', hasPrf: true },
      { ...common, transport: 'usb', hasPrf: false },
    ]) {
      const r = await send('WebAuthn.addVirtualAuthenticator', { options: opts });
      if (r.error) throw new Error(r.error.message);
    }
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__PEERD_VIRTUAL_AUTHENTICATOR__ = true;',
    });
  } catch (e) {
    console.error('WebAuthn virtual authenticators unavailable — ceremony tests will not register:', e?.message ?? e);
  }

  await send('Page.navigate', { url });

  let result = null;
  const deadline = Date.now() + RESULT_BUDGET_MS;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: "document.getElementById('ci-marker')?.textContent || ''", returnByValue: true });
    const txt = r.result?.result?.value || '';
    if (txt.startsWith('__TEST_RESULT__')) { result = JSON.parse(txt.slice('__TEST_RESULT__'.length).trim()); break; }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!result) {
    const body = await send('Runtime.evaluate', { expression: "document.getElementById('summary')?.textContent || document.body?.innerText?.slice(0,400) || '(none)'", returnByValue: true });
    console.error('IN-BROWSER: no result marker.  summary:', body.result?.result?.value);
    if (events.length) console.error('  page errors:\n   ' + events.slice(0, 12).join('\n   '));
    else console.error('  (no console errors/exceptions captured)');
    close(); process.exit(1);
  }
  if (result.failed > 0) {
    // Names + first error line of every failing test — the marker alone
    // says "N failed" which is useless in a CI log.
    const fails = await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('li.test.fail')].map((li) => {
        const name = li.querySelectorAll(':scope > span')[1]?.textContent ?? '(unnamed)';
        const err = li.querySelector('details summary')?.textContent ?? '';
        return name + (err ? ' — ' + err : '');
      }).join('\\n')`,
      returnByValue: true,
    });
    const lines = (fails.result?.result?.value || '').split('\n').filter(Boolean);
    if (lines.length) console.error('FAILING:\n  ' + lines.join('\n  '));
    if (events.length) console.error('  page errors:\n   ' + events.slice(0, 12).join('\n   '));
  }
  close();
  console.log(`IN-BROWSER: ${result.passed} passed, ${result.failed} failed — ${result.ms}ms`);
  process.exit(result.failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
