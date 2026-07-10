#!/usr/bin/env bun
// Headless TWO-TAB game-arena harness (the dream-demo arc, end to end).
//
// run-dweb-twopeer.mjs proves the base mesh; this proves what the demo
// PROMISES on top of it (docs/specs/PEERD-GAME-ARENA.md §6): two real browser
// contexts on the built web target (web-dist/), where the host SHARES the
// puzzle-race game dwapp (signed card on lobby gossip), the guest DISCOVERS +
// INSTALLS it (bundle over the signed direct channel, hash-verified against
// the card), CHALLENGES the host, and the full match protocol runs — commit-
// reveal seed, sealed-worker solving, answer commit/reveal, verdicts, and an
// Ed25519 CO-SIGNED result — with both sides converging on the same outcome.
//
// Usage:  bun scripts/cdp/run-arena-twotab.mjs
// Env:    CHROME_PATH or CHROME — explicit Chrome/Chromium binary.
//         SKIP_WEB_BUILD=1 — reuse an existing web-dist/ (default: rebuild).
// Exit:   0 on a co-signed, outcome-agreed match on both contexts; 1 otherwise.

import { resolve, join, dirname, extname, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const WEB_DIST = join(REPO, 'web-dist');

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((d) => join(d, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const CHROME = process.env.CHROME_PATH || process.env.CHROME
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  || ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(onPath).find(Boolean);

// The pow puzzle's solve time is geometric (typically <1s in the sealed
// worker, tail tens of seconds) and the match's solve window is 90s — so the
// whole-arc budget is generous, and finishing early exits early.
const RESULT_BUDGET_MS = 150_000;
const POLL_INTERVAL_MS = 1_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static server: web-dist/ as the site root + this dir's harness page ----
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const serveFile = (res, file) => {
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
};
const server = createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  if (p.endsWith('/')) p += 'index.html';
  // the harness page itself is NOT part of the deployable tree
  if (p === '/harness/arena-twotab.html') { serveFile(res, join(HERE, 'arena-twotab.html')); return; }
  const file = join(WEB_DIST, p);
  if (!file.startsWith(WEB_DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  serveFile(res, file);
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

const openTab = async (cdpPort, url) => {
  const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const tab = await attach(created.webSocketDebuggerUrl);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url });
  return tab;
};

const main = async () => {
  if (typeof WebSocket !== 'function') { console.error('needs a global WebSocket — run with Bun or Node >= 22.'); process.exit(1); }
  if (!CHROME) { console.error('no Chrome/Chromium binary found — set CHROME_PATH (or CHROME).'); process.exit(1); }

  // 0. a fresh web-dist (the REAL deployable tree, not raw source).
  if (process.env.SKIP_WEB_BUILD !== '1') {
    console.log('[arena] building web-dist (package:web)…');
    execFileSync('bun', [join(REPO, 'packaging', 'package-web.ts')], { cwd: REPO, stdio: 'inherit' });
  }
  if (!existsSync(join(WEB_DIST, 'web', 'arena.js'))) {
    console.error('[arena] web-dist/ is missing or stale — run `bun run package:web`.');
    process.exit(1);
  }

  // 1. local signaling node on an ephemeral port (same seam as twopeer).
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
  console.log(`[arena] signaling node up at ${rendezvous}`);

  // 2. static server for web-dist/ + the harness page.
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const httpPort = server.address().port;

  // 3. one headless Chrome (mdns flag: see twopeer — loopback ICE in a sandbox).
  profile = mkdtempSync(join(tmpdir(), 'peerd-arena-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  const cdpPort = await waitForCdpPort();

  // 4. host + guest in an isolated harness lobby. The page auto-plays by role.
  const lobby = `peerd/harness/arena-${Math.random().toString(36).slice(2, 8)}`;
  const pageUrl = (name, role) => `http://localhost:${httpPort}/harness/arena-twotab.html`
    + `?name=${name}&role=${role}&url=${encodeURIComponent(rendezvous)}&lobby=${encodeURIComponent(lobby)}`;
  const host = await openTab(cdpPort, pageUrl('host', 'host'));
  const guest = await openTab(cdpPort, pageUrl('guest', 'guest'));
  console.log(`[arena] host + guest joining lobby "${lobby}"`);

  // 5. poll until BOTH contexts hold the same finished, co-signed match.
  const reportExpr = 'window.__ARENA__?.ready ? window.__ARENA__.report() : ""';
  let h = null; let g = null;
  const deadline = Date.now() + RESULT_BUDGET_MS;
  const doneMatch = (r) => r?.matches?.find((m) => m.phase === 'done');
  while (Date.now() < deadline) {
    const [jh, jg] = await Promise.all([host.evaluate(reportExpr), guest.evaluate(reportExpr)]);
    h = jh ? JSON.parse(jh) : h;
    g = jg ? JSON.parse(jg) : g;
    if (h?.error || g?.error) break;
    const mh = doneMatch(h); const mg = doneMatch(g);
    if (mh && mg) {
      const agreed = mh.matchId === mg.matchId
        && JSON.stringify(mh.outcome) === JSON.stringify(mg.outcome)
        && mh.resultString && mh.resultString === mg.resultString;
      const coSigned = mh.coSigned && mg.coSigned;
      const played = ['win', 'draw'].includes(mh.outcome?.kind);
      const installed = g.games?.some((x) => !x.mine && x.installed);
      // per-game boards: the played game's board must have both players on it
      const boardRows = (r) => r.scores?.[0]?.rows?.length ?? 0;
      const tallied = boardRows(h) >= 2 && boardRows(g) >= 2;
      if (agreed && coSigned && played && installed && tallied) {
        console.log(`[arena] ✅ PASS — ${mh.matchId}: ${mh.outcome.kind}${mh.outcome.winner ? ` (winner ${mh.outcome.winner.slice(-8)})` : ''} (${mh.outcome.reason})`
          + ' · guest installed the shared dwapp (hash-verified) · result co-signed on both sides · leaderboards tallied');
        cleanup();
        process.exit(0);
      }
      console.error('[arena] ✗ FAIL — match finished but the pass conditions do not hold:',
        JSON.stringify({ agreed, coSigned, played, installed, tallied, hostOutcome: mh.outcome, guestOutcome: mg.outcome }));
      cleanup();
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error('[arena] ✗ FAIL — no co-signed finished match on both contexts within the budget');
  console.error('  host: ', JSON.stringify(h)?.slice(0, 1200));
  console.error('  guest:', JSON.stringify(g)?.slice(0, 1200));
  for (const [who, tab] of [['host', host], ['guest', guest]]) {
    if (tab.events.length) console.error(`  ${who} page errors:\n   ` + tab.events.slice(0, 8).join('\n   '));
  }
  cleanup();
  process.exit(1);
};

main().catch((e) => { console.error('[arena] FATAL', e); cleanup(); process.exit(1); });
