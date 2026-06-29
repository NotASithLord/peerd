#!/usr/bin/env bun
// Headless validation for the peerd-lite Notebook-substrate PoC.
//
// Proves the central claim: the sealed
// Notebook worker substrate runs in a PLAIN web page (no extension) via the web
// host adapter (notebook-host.js), with the substrate files imported VERBATIM
// from the extension tree. We serve extension/ as the web root (so the worker's
// own absolute imports — /notebook-tab/*, /shared/*, peerd:std — resolve) and
// /poc/* from web-prototype/poc/, open the page in headless Chrome, and drive
// window.runNotebookCell() over CDP.
//
// Asserts: (1) the worker runs + returns the computed index result, (2) console
// + display bridges work, (3) OPFS PERSISTS across two separate worker runs in
// the page (a fresh worker reads the prior run's file) — the durability that
// makes this a Notebook, not a scratch job.
//
// Usage:  bun web-prototype/poc/run-poc.mjs
// Exit:   0 if all checks pass, 1 otherwise.

import { resolve, join, dirname, extname, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..', '..', 'extension');
const POC = HERE;

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const CHROME = process.env.CHROME_PATH || process.env.CHROME
  || [`${process.env.HOME}/.cache/peerd-cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  || ['chromium', 'chromium-browser', 'google-chrome'].map(onPath).find(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain' };

// extension/ at root; /poc/* from web-prototype/poc/. The worker's blob spawns
// with the page origin, so its absolute imports (/notebook-tab/*) hit the root.
const server = createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  let root = EXT;
  if (p === '/poc' || p === '/poc/') { p = '/index.html'; root = POC; }
  else if (p.startsWith('/poc/')) { p = p.slice('/poc'.length); root = POC; }
  if (p.endsWith('/')) p += 'index.html';
  const file = join(root, p);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

let chrome, profile;
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const waitForCdpPort = async () => {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    try {
      const port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (port > 0 && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return port;
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') events.push('ERR ' + (m.params.args || []).map((a) => a.value || a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close(), events };
};

const evalJson = async (send, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.result?.value;
};

const main = async () => {
  if (!CHROME) { console.error('no Chrome/Chromium found — set CHROME_PATH'); process.exit(1); }
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const httpPort = server.address().port;
  profile = mkdtempSync(join(tmpdir(), 'peerd-poc-'));
  chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const cdpPort = await waitForCdpPort();

  const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, events } = await attach(created.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${httpPort}/poc/` });

  // wait for the adapter to load (window.runNotebookCell defined)
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await evalJson(send, 'typeof window.runNotebookCell === "function"').catch(() => false);
    if (!ready) await sleep(250);
  }

  const checks = [];
  const check = (name, pass, detail = '') => { checks.push({ name, pass, detail }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

  check('the page + web host adapter loaded', ready);
  if (ready) {
    // Run 1: build + query the on-device index.
    const r1 = await evalJson(send, 'window.runNotebookCell()').catch((e) => ({ error: String(e) }));
    const v1 = r1?.result;
    check('the sealed worker ran in the page (no error)', !!v1 && !v1.error, v1?.error || `${v1?.durationMs}ms`);
    check('code-mode returned the computed index result', v1?.value?.total === 35.5 && v1?.value?.count === 3, JSON.stringify(v1?.value));
    check('the console bridge works', (v1?.consoleOutput || []).some((l) => /indexed 3 orders/.test(l.text)), JSON.stringify(v1?.consoleOutput));
    check('OPFS holds the index file on device', (r1?.files || []).some((f) => /orders\.jsonl/.test(f.path) && f.size > 0), JSON.stringify(r1?.files));

    // Run 2: a FRESH worker reads the prior run's file — durability across runs.
    const readScript = "return (await peerd.self.readFile('orders.jsonl')).split('\\n').filter(Boolean).length";
    const r2 = await evalJson(send, `window.runNotebookCell(${JSON.stringify(readScript)})`).catch((e) => ({ error: String(e) }));
    check('OPFS persists across worker runs (fresh worker reads the prior file)', r2?.result?.value === 3 && !r2?.result?.error, JSON.stringify(r2?.result?.value ?? r2?.result?.error));

    // Run 3: the other named host swap — the seal-pinned fetch resolves to the
    // IN-PAGE fetch bridge (not the extension SW route).
    const fetchScript = "const r = await fetch('data:text/plain,peerd-lite-egress'); return await r.text()";
    const r3 = await evalJson(send, `window.runNotebookCell(${JSON.stringify(fetchScript)})`).catch((e) => ({ error: String(e) }));
    check('the in-page fetch bridge works (seal-pinned fetch → host fetch)', r3?.result?.value === 'peerd-lite-egress' && !r3?.result?.error, JSON.stringify(r3?.result?.value ?? r3?.result?.error));
  }

  if (events.length) console.error('  page errors:\n   ' + events.slice(0, 8).join('\n   '));
  const passed = checks.filter((c) => c.pass).length;
  console.log(`\nPOC: ${passed}/${checks.length} checks`);
  cleanup();
  process.exit(passed === checks.length && checks.length > 0 ? 0 : 1);
};

main().catch((e) => { console.error('poc harness error:', e?.stack || e); cleanup(); process.exit(1); });
