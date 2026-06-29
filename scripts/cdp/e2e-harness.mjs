#!/usr/bin/env bun
// Reusable scaffolding for peerd's end-to-end side-panel tests. The states live
// in states.mjs and run against ONE Chrome via run-e2e-verify.mjs (the verify
// loop); this module is the shared CDP plumbing they build on.
//
// What a scenario gets:
//   launchPeerd({ modelResponder }) — load the REAL unpacked extension in
//     headless Chrome for Testing, discover its MV3 service worker, arm CDP
//     Fetch interception of the keyless-Ollama model call (so NO real network
//     egress and ZERO test-only code in any shipped file), open the side panel
//     as a tab, and wait for the Mithril app to mount. Returns the SW + page
//     CDP connections and a clean close().
//   unlockAndReady(page) — create+unlock the vault (passphrase), lift the
//     first-run onboarding gate, and select the keyless Ollama provider.
//   rpc / evalIn / waitFor / makeChecks / sseText / sseToolCall — the verbs.
//
// The model is faked at the WIRE ONLY: the scenario's modelResponder decides,
// per POST /v1/chat/completions, what comes back — assistant text, a tool call,
// an error status, or a delayed/aborted response. Everything above the socket
// (the real adapter, safeFetch, the stream parser, the agent loop, the goal
// runner) runs for real. That's the seam the unit tiers can't reach.
//
// REQUIRES Chrome for Testing or Chromium — branded "Google Chrome" ignores
// --load-extension (a security restriction), so the extension never loads under
// it. Point CHROME_PATH at Chrome for Testing (bun run e2e:chrome).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline, UPDATE_BASELINES } from './visual.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const EXT = resolve(ROOT, 'extension');

export const PASSPHRASE = 'correct-horse-battery-staple';
export const READY_BUDGET_MS = 30_000; // extension load + SW boot + page mount
export const POLL_MS = 250;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log('[e2e]', ...a);

// ---- OpenAI-compatible SSE builders (the Ollama adapter's from-openai.js) ----

// A plain assistant text turn: role → content → finish 'stop' + usage → [DONE].
export const sseText = (text) => [
  `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}`,
  'data: [DONE]', '',
].join('\n\n') + '\n\n';

// A turn that calls ONE tool: role(+optional text) → a tool_calls delta →
// finish 'tool_calls' + usage → [DONE]. Drives the dispatcher for real.
export const sseToolCall = (name, args, { text = '' } = {}) => [
  `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}`,
  'data: [DONE]', '',
].join('\n\n') + '\n\n';

// ---- Chrome binary resolution (mirrors run-inbrowser-tests.mjs) -------------
export function resolveChrome() {
  const explicit = process.env.CHROME_PATH || process.env.CHROME;
  if (explicit && existsSync(explicit)) return explicit;
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

// Runtime.evaluate → return the value, or throw the page-side error.
export async function evalIn(conn, expression, awaitPromise = false) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error('page-eval threw: ' + (ex?.description || ex?.value || r.exceptionDetails.text));
  }
  return r.result?.value;
}

// Post an SW RPC from the page context and await its response.
export function rpc(conn, message) {
  const expr = `new Promise((res) => { try { chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => res(r ?? { ok: true, _noResponse: true })); } catch (e) { res({ ok: false, error: String(e) }); } })`;
  return evalIn(conn, expr, true);
}

// Poll `fn` (sync or async, returns truthy) until it holds or the budget runs out.
export async function waitFor(fn, { budgetMs = READY_BUDGET_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(pollMs);
  }
  return null;
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

// ---- the high-level launch --------------------------------------------------

/**
 * Launch the real extension and return live CDP handles + a clean close().
 *
 * @param {object} [opts]
 * @param {(callIndex:number, request:object) => (object|Promise<object>)} [opts.modelResponder]
 *   Called per POST /v1/chat/completions. Return one of:
 *     { sse }                              → fulfill 200 text/event-stream
 *     { status, body?, contentType? }      → fulfill with that status (errors)
 *     { delayMs, ...spec }                 → wait delayMs, then apply spec
 *   Default: a single assistant text turn ('e2e-smoke-ok').
 * @param {string} [opts.tagsModel]  model name returned by GET /api/tags.
 */
export async function launchPeerd({ modelResponder, tagsModel = 'qwen3:8b' } = {}) {
  if (!existsSync(join(EXT, 'manifest.json'))) {
    throw new Error(`extension/manifest.json missing — run \`bun run gen:dev\` first (${EXT})`);
  }
  const CHROME = resolveChrome();
  log('chrome:', CHROME);
  const profile = mkdtempSync(join(tmpdir(), 'peerd-e2e-'));

  const chrome = spawn(CHROME, [
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

  let closed = false;
  const cleanup = () => {
    if (closed) return; closed = true;
    try { chrome?.kill('SIGKILL'); } catch { /* */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const port = await waitForCdpPort(profile);
  log('cdp port:', port);

  // 1) discover peerd's id from its SW target (proves the extension loaded)
  const sw = await waitFor(() => findPeerdSw(port), { budgetMs: READY_BUDGET_MS });
  if (!sw) {
    cleanup();
    if (/--disable-extensions-except is not allowed|--load-extension/i.test(chromeErr)) {
      throw new Error('Extension did not load — this Chrome ignores --load-extension. Use Chrome for Testing / Chromium (set CHROME_PATH).');
    }
    throw new Error('peerd service-worker target never appeared (extension failed to load).');
  }
  log('extension id:', sw.id);

  // 2) attach to the SW and intercept the Ollama model call over CDP Fetch.
  // currentResponder is SWAPPABLE (ctx.setModelResponder) so a single Chrome can
  // host many states back-to-back, each with its own model behaviour — the
  // single-Chrome speed path for the verify loop.
  let currentResponder = modelResponder || (() => ({ sse: sseText('e2e-smoke-ok') }));
  let modelCalls = 0;
  const swConn = await attach(sw.wsUrl, async (method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request } = params;
    const url = String(request.url);
    const fulfill = (contentType, bodyStr, status = 200) => swConn.send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: [{ name: 'content-type', value: contentType }],
      body: Buffer.from(bodyStr).toString('base64'),
    });
    try {
      if (url.includes('/v1/chat/completions')) {
        const spec = await currentResponder(modelCalls++, request);
        if (spec?.delayMs) await sleep(spec.delayMs);
        if (spec?.sse != null) await fulfill('text/event-stream', spec.sse, spec.status ?? 200);
        else if (spec?.status) await fulfill(spec.contentType ?? 'application/json', spec.body ?? '{}', spec.status);
        else await fulfill('text/event-stream', sseText('e2e-smoke-ok'));
      } else if (url.includes('/api/tags')) {
        await fulfill('application/json', JSON.stringify({ models: [{ name: tagsModel, size: 1 }] }));
      } else if (url.includes('11434')) {
        await fulfill('application/json', '{}');
      } else {
        await swConn.send('Fetch.continueRequest', { requestId });
      }
    } catch { /* request may have been torn down (e.g. an aborted turn); ignore */ }
  });
  await swConn.send('Fetch.enable', { patterns: [{ urlPattern: '*11434*' }] });
  log('Fetch interception armed on the service worker');

  // 3) open the side panel as a normal tab (chrome.sidePanel.open is not
  //    drivable over CDP; the same Mithril app + SW port load fine in a tab).
  const panelUrl = `chrome-extension://${sw.id}/sidepanel/sidepanel.html`;
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${panelUrl}`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const mounted = await waitFor(
    () => evalIn(page, `document.readyState === 'complete' && !!document.querySelector('#app, body > *')`),
    { budgetMs: READY_BUDGET_MS },
  );
  if (!mounted) { cleanup(); throw new Error('side panel never mounted'); }
  log('side panel mounted');

  // Capture the panel as a PNG buffer. Two headless-Chrome gotchas handled:
  // (1) bringToFront ONCE (lazily) — headless composites only the foregrounded
  //     target, so the first capture needs it active; calling it before EVERY
  //     capture hangs the next captureScreenshot. Activate once.
  // (2) the nudge pump — visualCheck freezes animations for a deterministic
  //     shot, but a frozen page idles the compositor and captureScreenshot then
  //     waits forever for a frame. Toggling a sub-pixel translateZ on the root
  //     (invisible in 2D, so the pixels are unaffected — verified 0.00000 diff)
  //     forces the compositor to keep producing frames until the capture
  //     resolves. Without this, capturing a perpetual-spinner screen deadlocks.
  let broughtToFront = false;
  const screenshot = async () => {
    if (!broughtToFront) { await page.send('Page.bringToFront'); broughtToFront = true; }
    let pumping = true;
    let toggle = false;
    const pump = (async () => {
      while (pumping) {
        toggle = !toggle;
        await page.send('Runtime.evaluate', {
          expression: `(() => { const e = document.documentElement; if (e) e.style.transform = 'translateZ(${toggle ? '0.0001px' : '0px'})'; })()`,
        }).catch(() => {});
        await sleep(50);
      }
    })();
    try {
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    } finally { pumping = false; await pump; }
  };

  return {
    sw, swConn, page, port, profile, screenshot,
    close: () => { try { page.close(); } catch { /* */ } try { swConn.close(); } catch { /* */ } cleanup(); },
    modelCallCount: () => modelCalls,
    // Swap the model behaviour + reset the per-state call counter — lets one
    // Chrome run many states back-to-back (the single-Chrome verify path).
    setModelResponder: (fn) => { currentResponder = fn || (() => ({ sse: sseText('e2e-smoke-ok') })); modelCalls = 0; },
  };
}

/**
 * Start a clean chat (new session) between states so transcripts don't bleed.
 * AWAITS the view actually clearing — session/reset clears the SW session, but
 * the panel re-renders the empty transcript on the SW's async state push, so a
 * capture/assert right after the RPC could still see the PREVIOUS state's
 * messages (it did: an idle-snapshot caught the prior turn's transcript).
 * @param {object} ctx
 */
export async function resetSession(ctx) {
  await rpc(ctx.page, { type: 'session/reset' });
  await waitFor(
    () => evalIn(ctx.page, `!document.querySelector('.message-user, .message-assistant')`),
    { budgetMs: 5_000 },
  );
}

/**
 * Freeze animations/transitions and hide the blinking caret so screenshots are
 * identical run-to-run (the brand has spinners + a wordmark typing intro).
 * Idempotent — the <style> rides in <head>, which Mithril's #app re-renders
 * don't touch, so one injection covers every state. Call once before capturing.
 * @param {object} ctx
 */
export async function freezeAnimations(ctx) {
  await evalIn(ctx.page, `(() => {
    if (document.getElementById('e2e-no-anim')) return;
    const s = document.createElement('style');
    s.id = 'e2e-no-anim';
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(s);
  })()`);
}

/**
 * Capture the panel and fold a visual-regression verdict into the scenario's
 * checks: compare the screenshot against baselines/<name>.png (or write it when
 * missing / UPDATE_BASELINES=1). A small diff-ratio threshold absorbs rendering
 * noise so only real UI changes fail.
 * @param {object} ctx     the launchPeerd ctx
 * @param {object} checks  a makeChecks() collector
 * @param {string} name    baseline key
 * @param {{ threshold?: number, tolerance?: number }} [opts]
 */
export async function visualCheck(ctx, checks, name, opts = {}) {
  await freezeAnimations(ctx);
  const png = await ctx.screenshot();
  const v = compareToBaseline(name, png, { update: UPDATE_BASELINES, ...opts });
  if (v.wrote) {
    checks.check(`visual: ${name} — baseline ${v.missing ? 'created' : 'updated'} (skipped compare)`, true);
  } else if (!v.dimsMatch) {
    checks.check(`visual: ${name} — dimensions match the baseline`, false);
  } else {
    checks.check(`visual: ${name} — diff ${(v.ratio * 100).toFixed(2)}% ≤ ${(v.threshold * 100).toFixed(0)}%`, v.pass);
  }
  return v;
}

/**
 * Bring a freshly-mounted panel to a ready, sendable state: create+unlock the
 * vault, lift the onboarding gate, and select the keyless Ollama provider.
 * @param {object} page  the page CDP connection from launchPeerd
 */
export async function unlockAndReady(page, { provider = 'ollama', model = 'qwen3:8b' } = {}) {
  const vault = await rpc(page, { type: 'vault/initialize', passphrase: PASSPHRASE });
  if (!vault?.ok) throw new Error('vault/initialize failed: ' + JSON.stringify(vault));
  log('vault initialized + unlocked');
  await rpc(page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });
  const upd = await rpc(page, { type: 'settings/update', patch: { providerName: provider, providerModel: model } });
  if (!upd?.ok) throw new Error('settings/update failed: ' + JSON.stringify(upd));
  log(`provider set to ${provider} (keyless)`);
}

/**
 * Open an arbitrary extension page (e.g. the eval harness) as a new tab and
 * return an attached page CDP connection — same `/json/new` + attach +
 * Runtime/Page.enable dance launchPeerd uses for the side panel, so any
 * in-extension page can be driven, not just the panel.
 * @param {object} ctx   the launchPeerd ctx (uses ctx.sw.id + ctx.port)
 * @param {string} path  extension-relative path, e.g. 'eval/runner.html'
 */
export async function openExtPage(ctx, path) {
  const url = `chrome-extension://${ctx.sw.id}/${String(path).replace(/^\//, '')}`;
  const created = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return page;
}

// ---- check reporting --------------------------------------------------------

/** A small named-check collector; finish(ctx) reports + throws on any failure. */
export function makeChecks() {
  const checks = [];
  const check = (name, pass, detail = '') => {
    checks.push({ name, pass });
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const finish = async (ctx) => {
    const failed = checks.filter((c) => !c.pass);
    if (failed.length) {
      const snapshot = await evalIn(ctx.page, `(document.querySelector('.message-list')?.innerText || document.body.innerText || '').slice(0, 800)`).catch(() => '(snapshot unavailable)');
      console.error('[e2e] page errors:\n  ' + (ctx.page.events.concat(ctx.swConn.events).slice(0, 12).join('\n  ') || '(none)'));
      console.error('[e2e] transcript snapshot:\n' + snapshot);
      throw new Error(`${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join('; ')}`);
    }
    log(`ALL ${checks.length} CHECKS PASSED`);
  };
  return { check, finish };
}

/**
 * Run a scenario `fn(ctx, checks)` end-to-end: launch, run, report, exit 0/1.
 * `fn` receives the launchPeerd ctx and a checks collector; the harness handles
 * unlock-free launch (the scenario decides when to unlock), cleanup, and codes.
 * @param {string} name
 * @param {(ctx:object, checks:object) => Promise<void>} fn
 * @param {object} [launchOpts]  passed to launchPeerd (e.g. modelResponder)
 */
export async function runScenario(name, fn, launchOpts = {}) {
  let ctx = null;
  try {
    ctx = await launchPeerd(launchOpts);
    const checks = makeChecks();
    await fn(ctx, checks);
    await checks.finish(ctx);
    ctx.close();
    process.exit(0);
  } catch (e) {
    console.error('[e2e]', e?.message || e);
    try { ctx?.close(); } catch { /* */ }
    process.exit(1);
  }
}
