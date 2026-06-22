#!/usr/bin/env bun
// First real END-TO-END smoke test for peerd: loads the ACTUAL unpacked
// extension and drives the live side panel through one full agent turn.
//
// why this is separate from run-inbrowser-tests.mjs: that harness deliberately
// serves extension/ over http and FAKES chrome.runtime.id, so it never exercises
// the real MV3 chassis (service worker, side-panel port, vault, the agent loop
// end to end). This one launches Chrome with --load-extension and talks to the
// real thing — the seam the unit tiers cannot reach.
//
// What it proves (the smoke):
//   load real extension -> open side panel -> create+unlock vault (passphrase)
//   -> select the keyless Ollama provider -> send one message -> a stubbed
//   assistant turn renders and reaches a terminal (idle) state.
//
// HOW the model is stubbed without a key, a daemon, or any shipped test code:
// the keyless Ollama provider is already registered, so no key is needed; its
// one network call (POST localhost:11434/v1/chat/completions) is intercepted
// over CDP's Fetch domain and fulfilled with a canned OpenAI-format SSE body.
// This exercises the REAL adapter + safeFetch + stream parser + agent loop —
// only the wire bytes are faked. Zero test-only code in any shipped file.
//
// No npm CDP client, no Playwright: raw CDP over Chrome's own WebSocket, the
// same house posture as run-inbrowser-tests.mjs.
//
// REQUIRES Chrome for Testing or Chromium. Branded "Google Chrome" IGNORES
// --load-extension / --disable-extensions-except (a security restriction), so
// the extension never loads under it. Point CHROME_PATH at Chrome for Testing.
//
// Usage:  CHROME_PATH=<chrome-for-testing> bun scripts/cdp/run-e2e-sidepanel.mjs
// Exit:   0 if the smoke turn renders + idles, 1 otherwise.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const EXT = resolve(ROOT, 'extension');

const PASSPHRASE = 'correct-horse-battery-staple';
const FAKE_TEXT = 'e2e-smoke-ok';
const READY_BUDGET_MS = 30_000; // extension load + SW boot + page mount
const TURN_BUDGET_MS = 25_000; // send -> rendered + idle
const POLL_MS = 250;

// Canned OpenAI-compatible SSE the Ollama adapter's parser (from-openai.js)
// turns into: text-delta(FAKE_TEXT) -> usage -> message-stop(end_turn).
const FAKE_SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: FAKE_TEXT } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}`,
  'data: [DONE]',
  '',
].join('\n\n') + '\n\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

// ---- Chrome binary resolution (mirrors run-inbrowser-tests.mjs) -------------
function resolveChrome() {
  const explicit = process.env.CHROME_PATH || process.env.CHROME;
  if (explicit && existsSync(explicit)) return explicit;
  // The ~/.cache/peerd-cft/* layouts match `bun run e2e:chrome`
  // (scripts/cdp/ensure-chrome-for-testing.mjs) across platforms.
  const cft = `${process.env.HOME}/.cache/peerd-cft`;
  const candidates = [
    `${cft}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${cft}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${cft}/chrome-linux64/chrome`,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('No Chrome binary found. Set CHROME_PATH to Chrome for Testing or Chromium.');
}

// ---- raw CDP attach over Chrome's WebSocket (no npm client) -----------------
async function attach(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      events.push('ERR ' + (m.params.args || []).map((a) => a.value || a.description || a.type).join(' '));
    }
    if (onEvent) onEvent(m.method, m.params);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close(), events };
}

// Runtime.evaluate -> return the value, or throw the page-side error.
async function evalIn(conn, expression, awaitPromise = false) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error('page-eval threw: ' + (ex?.description || ex?.value || r.exceptionDetails.text));
  }
  return r.result?.value;
}

// Post an SW RPC from the page context and await its response.
function rpc(conn, message) {
  const expr = `new Promise((res) => { try { chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => res(r ?? { ok: true, _noResponse: true })); } catch (e) { res({ ok: false, error: String(e) }); } })`;
  return evalIn(conn, expr, true);
}

// ---- CDP HTTP endpoints -----------------------------------------------------
const cdpList = (port) => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());

async function waitForCdpPort(profile) {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    try {
      const port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (port > 0 && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return port;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint never came up');
}

// peerd's MV3 SW target — matched by service-worker.js so we never grab a
// Chrome component extension. Returns { id, wsUrl }.
async function findPeerdSw(port) {
  const targets = await cdpList(port);
  const sw = targets.find((t) => t.type === 'service_worker' && /\/background\/service-worker\.js/.test(String(t.url)));
  if (!sw) return null;
  const id = String(sw.url).match(/chrome-extension:\/\/([a-p]{32})\//)?.[1];
  return id ? { id, wsUrl: sw.webSocketDebuggerUrl } : null;
}

// ---- lifecycle --------------------------------------------------------------
let chrome;
let profile;
function cleanup() {
  try { chrome?.kill('SIGKILL'); } catch { /* */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function main() {
  if (!existsSync(join(EXT, 'manifest.json'))) {
    throw new Error(`extension/manifest.json missing — run \`bun run gen:dev\` first (${EXT})`);
  }
  const CHROME = resolveChrome();
  log('chrome:', CHROME);
  profile = mkdtempSync(join(tmpdir(), 'peerd-e2e-'));

  chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });

  const port = await waitForCdpPort(profile);
  log('cdp port:', port);

  // 1) discover peerd's id from its SW target (proves the extension loaded)
  let sw = null;
  const swDeadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < swDeadline) {
    sw = await findPeerdSw(port);
    if (sw) break;
    await sleep(POLL_MS);
  }
  if (!sw) {
    if (/--disable-extensions-except is not allowed|--load-extension/i.test(chromeErr)) {
      throw new Error('Extension did not load — this Chrome ignores --load-extension. Use Chrome for Testing / Chromium (set CHROME_PATH).');
    }
    throw new Error('peerd service-worker target never appeared (extension failed to load).');
  }
  log('extension id:', sw.id);

  // 2) attach to the SW and intercept the Ollama model call over CDP Fetch.
  //    Set up BEFORE sending so the turn's network call is fulfilled canned.
  let intercepted = false;
  const swConn = await attach(sw.wsUrl, async (method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request } = params;
    const url = String(request.url);
    const fulfill = (contentType, bodyStr) => swConn.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: contentType }],
      body: Buffer.from(bodyStr).toString('base64'),
    });
    try {
      if (url.includes('/v1/chat/completions')) { intercepted = true; await fulfill('text/event-stream', FAKE_SSE); }
      else if (url.includes('/api/tags')) await fulfill('application/json', JSON.stringify({ models: [{ name: 'qwen3:8b', size: 1 }] }));
      else if (url.includes('11434')) await fulfill('application/json', '{}');
      else await swConn.send('Fetch.continueRequest', { requestId });
    } catch { /* request may have been torn down; ignore */ }
  });
  await swConn.send('Fetch.enable', { patterns: [{ urlPattern: '*11434*' }] });
  log('Fetch interception armed on the service worker');

  // 3) open the side panel as a normal tab (chrome.sidePanel.open is not
  //    drivable over CDP; the same Mithril app + SW port load fine in a tab)
  const panelUrl = `chrome-extension://${sw.id}/sidepanel/sidepanel.html`;
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${panelUrl}`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const mountDeadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < mountDeadline) {
    const ready = await evalIn(page, `document.readyState === 'complete' && !!document.querySelector('#app, body > *')`);
    if (ready) break;
    await sleep(POLL_MS);
  }
  log('side panel mounted');

  // 4) create + unlock the vault (one RPC; passphrase path, no WebAuthn).
  //    vault/initialize also fires ensureOffscreen() to keep the SW alive.
  const vault = await rpc(page, { type: 'vault/initialize', passphrase: PASSPHRASE });
  if (!vault?.ok) throw new Error('vault/initialize failed: ' + JSON.stringify(vault));
  log('vault initialized + unlocked');

  // 5) lift the first-run onboarding gate (facts:null writes no memory)
  await rpc(page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });

  // 6) select the keyless Ollama provider (hasKey:true, no vault key needed)
  const upd = await rpc(page, { type: 'settings/update', patch: { providerName: 'ollama', providerModel: 'qwen3:8b' } });
  if (!upd?.ok) throw new Error('settings/update failed: ' + JSON.stringify(upd));
  log('provider set to ollama (keyless)');

  // 7) send one message (fire-and-forget; the turn streams back over the port)
  const sent = await rpc(page, { type: 'agent/send', text: 'ping from e2e' });
  if (!sent?.ok) throw new Error('agent/send failed: ' + JSON.stringify(sent));
  log('message sent; awaiting assistant turn...');

  // 8) await the turn's terminal state, then assert the outcome facets.
  //    One probe returns the transcript shape; the harness asserts each facet
  //    as a named check (extensible — tool-use / multi-turn / error flows are
  //    natural follow-ups that reuse this scaffolding).
  const probe = `(() => {
    const u = document.querySelector('.message-user');
    const b = document.querySelector('.message-assistant .bubble');
    const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
    return { userText: u ? u.textContent.trim() : null, assistantText: b ? b.textContent.trim() : null, busy };
  })()`;
  const turnDeadline = Date.now() + TURN_BUDGET_MS;
  let out = {};
  while (Date.now() < turnDeadline) {
    out = (await evalIn(page, probe)) || {};
    if (out.assistantText && !out.busy) break; // terminal: text rendered + not streaming
    await sleep(POLL_MS);
  }

  const checks = [];
  const check = (name, pass, detail = '') => {
    checks.push({ name, pass });
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  check('model call intercepted (no real network egress)', intercepted);
  check('user message round-trips into the transcript', !!out.userText && out.userText.includes('ping from e2e'), JSON.stringify(out.userText));
  check('assistant turn renders the streamed text', out.assistantText === FAKE_TEXT, JSON.stringify(out.assistantText));
  check('turn reaches a terminal/idle state', out.busy === false);

  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    const snapshot = await evalIn(page, `(document.querySelector('.message-list')?.innerText || document.body.innerText || '').slice(0, 600)`);
    console.error('[e2e] page errors:\n  ' + (page.events.concat(swConn.events).slice(0, 12).join('\n  ') || '(none)'));
    console.error('[e2e] transcript snapshot:\n' + snapshot);
    page.close(); swConn.close();
    throw new Error(`${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join('; ')}`);
  }
  log(`ALL ${checks.length} CHECKS PASSED`);
  page.close(); swConn.close();
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => {
  console.error('[e2e]', e.message || e);
  cleanup();
  process.exit(1);
});
