#!/usr/bin/env bun
// Headless TWO-PEER dweb integration harness.
//
// The honest boundary: real WebRTC bytes
// between real browser contexts can't run under bun, so the live peer-to-peer
// flows (join a room → see each other → messages flow) were verified by hand in
// two Chrome profiles every release. This harness automates that beat: it stands
// up the LOCAL signaling node (no cloud), launches one headless Chrome, opens
// TWO browser contexts each running a real peer (tests/dweb-twopeer.js → the
// production joinRoom + createBaseNetwork composition), and asserts both form a
// WebRTC mesh and exchange gossip. Same raw-CDP-over-Bun toolchain as
// run-inbrowser-tests.mjs (no npm CDP client, no Playwright — house rule).
//
// Usage:  bun scripts/cdp/run-dweb-twopeer.mjs [path/to/extension]
// Env:    CHROME_PATH or CHROME — explicit Chrome/Chromium binary.
// Exit:   0 if both peers link AND each hears the other's gossip; 1 otherwise.

import { resolve, join, dirname, extname, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const EXT = resolve(process.argv[2] ?? join(REPO, 'extension'));

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const CHROME = process.env.CHROME_PATH || process.env.CHROME
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  || ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(onPath).find(Boolean);

// A healthy loopback connect is ~1-2s; two contexts spinning up + the rendezvous
// + a couple gossip rounds still finish well inside 30s. If the peers haven't
// paired by then it's a hard transient, not slowness — so fail fast and let the
// CI retry re-run it (a longer budget only burns wall-clock before the retry).
const RESULT_BUDGET_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static file server rooted at extension/ (same as the in-browser harness) -
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const server = createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = join(EXT, p);
  if (!file.startsWith(EXT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

let chrome, profile, signaling;
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch { /* */ }
  try { signaling?.kill('SIGKILL'); } catch { /* */ }
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close(), events };
};

// Open a fresh tab pointed at `url`, with Runtime/Page enabled before nav so
// load-time import errors surface instead of a silent blank.
const openPeer = async (cdpPort, url) => {
  const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const peer = await attach(created.webSocketDebuggerUrl);
  await peer.send('Runtime.enable');
  await peer.send('Page.enable');
  await peer.send('Page.navigate', { url });
  return peer;
};

const main = async () => {
  if (typeof WebSocket !== 'function') { console.error('needs a global WebSocket — run with Bun or Node >= 22.'); process.exit(1); }
  if (!CHROME) { console.error('no Chrome/Chromium binary found — set CHROME_PATH (or CHROME).'); process.exit(1); }

  // 1. local signaling node on an ephemeral port. PORT=0 → it binds an OS-chosen
  // port and prints the real one; read it back (no probe-then-bind TOCTOU race).
  let sigPort = null;
  signaling = spawn(process.execPath, [join(REPO, 'signaling-node', 'bun-server.mjs')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('signaling node did not announce a port within 10s')), 10_000);
    let buf = '';
    signaling.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/ws:\/\/localhost:(\d+)\/rendezvous/);
      if (m) { sigPort = Number(m[1]); clearTimeout(t); res(); }
    });
    signaling.on('exit', (c) => { clearTimeout(t); rej(new Error(`signaling node exited early (code ${c})`)); });
  });
  const rendezvous = `ws://localhost:${sigPort}/rendezvous`;
  console.log(`[twopeer] signaling node up at ${rendezvous}`);

  // 2. static server for extension/ on an ephemeral port.
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const httpPort = server.address().port;

  // 3. one headless Chrome.
  // why --disable-features=WebRtcHideLocalIpsWithMdns: Chrome otherwise masks
  // host candidates behind a *.local mDNS name that doesn't resolve in a
  // headless CI sandbox, so loopback ICE never pairs. Exposing the real
  // loopback IP lets the two contexts connect with no STUN/TURN.
  profile = mkdtempSync(join(tmpdir(), 'peerd-dweb-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  const cdpPort = await waitForCdpPort();

  // 4. two peers in the same room.
  const room = `harness-${Math.random().toString(36).slice(2, 8)}`;
  const pageUrl = (who) => `http://localhost:${httpPort}/tests/dweb-twopeer.html`
    + `?room=${room}&name=${who}&url=${encodeURIComponent(rendezvous)}`;
  const alice = await openPeer(cdpPort, pageUrl('alice'));
  const bob = await openPeer(cdpPort, pageUrl('bob'));
  console.log(`[twopeer] two contexts joining room "${room}"`);

  // 5. poll until both link AND each has heard the other's gossip.
  const reportExpr = 'window.__DWEB__?.ready ? JSON.stringify(window.__DWEB__.report()) : ""';
  let a = null; let b = null;
  const deadline = Date.now() + RESULT_BUDGET_MS;
  const done = (r) => r && r.linked >= 1 && r.heard >= 1;
  while (Date.now() < deadline) {
    const [ja, jb] = await Promise.all([alice.evaluate(reportExpr), bob.evaluate(reportExpr)]);
    a = ja ? JSON.parse(ja) : a;
    b = jb ? JSON.parse(jb) : b;
    if (a?.error || b?.error) break;
    if (done(a) && done(b)) {
      console.log(`[twopeer] ✅ PASS — alice⇄bob meshed (alice linked ${a.linked}/heard ${a.heard}, bob linked ${b.linked}/heard ${b.heard})`);
      cleanup();
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error('[twopeer] ✗ FAIL — peers did not fully connect within the budget');
  console.error('  alice:', JSON.stringify(a));
  console.error('  bob:  ', JSON.stringify(b));
  for (const [who, peer] of [['alice', alice], ['bob', bob]]) {
    if (peer.events.length) console.error(`  ${who} page errors:\n   ` + peer.events.slice(0, 8).join('\n   '));
  }
  cleanup();
  process.exit(1);
};

main().catch((e) => { console.error('[twopeer] FATAL', e); cleanup(); process.exit(1); });
