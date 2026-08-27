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
export const NETWORK_GUARD_CONTROLLER_PORT = 18_763;
export const READY_BUDGET_MS = 30_000; // extension load + SW boot + page mount
const VAULT_READY_BUDGET_MS = 120_000; // production Argon2 under loaded CI/browser hosts
export const POLL_MS = 250;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log('[e2e]', ...a);
// Cross-process performance evidence must stay in one clock domain. Page
// performance.now() values are useful diagnostics, but cannot be subtracted
// from host launch or CDP milestone timestamps.
export const hostMonotonicMs = () => Number(process.hrtime.bigint()) / 1_000_000;

// Acceptance-only HTTPS routing seam. It is intentionally not a generic
// browser-argument escape hatch: only an ephemeral numeric loopback HTTP proxy
// and one certificate SPKI pin are accepted.
export const normalizeAcceptanceProxyServer = (proxyServer) => {
  if (proxyServer == null) return null;
  if (!proxyServer || typeof proxyServer !== 'object'
      || Object.keys(proxyServer).length !== 2
      || typeof proxyServer.url !== 'string'
      || typeof proxyServer.certificateSpkiSha256 !== 'string') {
    throw new Error('acceptance proxy must contain only url and certificateSpkiSha256');
  }
  let url;
  try { url = new URL(proxyServer.url); }
  catch { throw new Error('acceptance proxy URL is invalid'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || !Number.isInteger(port)
      || port < 1024 || port > 65_535) {
    throw new Error('acceptance proxy must be an uncredentialed numeric 127.0.0.1 port');
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(proxyServer.certificateSpkiSha256)) {
    throw new Error('acceptance proxy certificate SPKI pin is invalid');
  }
  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    certificateSpkiSha256: proxyServer.certificateSpkiSha256,
  });
};

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
// why unique ids: real providers mint a fresh id per tool call, and the
// lifecycle replay guard keys on (session, id) — a fixed id would make two
// UNRELATED scripted calls in one session read as a replay of each other,
// which no real wire ever produces.
let sseToolCallSeq = 0;
export const sseToolCall = (name, args, { text = '' } = {}) => {
  sseToolCallSeq += 1;
  // Built as plain statements (no keyword-named keys inside template
  // expressions) — the CodeQL extractor rejected the denser one-liner shape
  // twice; runtime behavior is identical.
  const toolCall = {
    index: 0,
    id: `call_e2e_${sseToolCallSeq}`,
    type: 'function',
    'function': { name, 'arguments': JSON.stringify(args) },
  };
  const openDelta = JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] });
  const callDelta = JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] });
  const finishDelta = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  return [
    `data: ${openDelta}`, `data: ${callDelta}`, `data: ${finishDelta}`,
    'data: [DONE]', '',
  ].join('\n\n') + '\n\n';
};

// A model can fan out several actor_create calls in one response; keep that
// wire shape available to rendered E2E states instead of serially fabricating
// calls that the async actor contract intentionally ends the turn after.
export const sseToolCalls = (calls, { text = '' } = {}) => {
  const toolCalls = calls.map(({ name, args }, index) => {
    sseToolCallSeq += 1;
    return {
      index,
      id: `call_e2e_${sseToolCallSeq}`,
      type: 'function',
      'function': { name, 'arguments': JSON.stringify(args) },
    };
  });
  const openDelta = JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] });
  const callDelta = JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] });
  const finishDelta = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  return [
    `data: ${openDelta}`, `data: ${callDelta}`, `data: ${finishDelta}`,
    'data: [DONE]', '',
  ].join('\n\n') + '\n\n';
};

// ---- Chrome binary resolution (mirrors run-inbrowser-tests.mjs) -------------
export function resolveChrome() {
  const explicit = process.env.CHROME_PATH || process.env.CHROME;
  if (explicit && existsSync(explicit)) return explicit;
  const cft = `${process.env.HOME}/.cache/peerd-cft`;
  // The PINNED cache first (see ensure-chrome-for-testing.mjs). The unversioned
  // paths stay as trailing fallbacks so an existing dev cache keeps working —
  // safe because only the CI authority gates on pixels; a local run that picks
  // up an older build still renders fine for the LOOK-at-it verify loop.
  const pin = (() => {
    try { return readFileSync(join(__dirname, 'chrome-version.txt'), 'utf8').trim(); } catch { return ''; }
  })();
  const candidates = [
    ...(pin ? [
      `${cft}/${pin}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${cft}/${pin}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${cft}/${pin}/chrome-linux64/chrome`,
    ] : []),
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

// ---- deterministic capture --------------------------------------------------

// why: the visual lane compares PIXELS, so every knob that varies by machine,
// GPU or CPU has to be nailed down. Chrome silently ignores switches it does
// not recognise, so the Linux-only ones are harmless on macOS.
const DETERMINISM_FLAGS = Object.freeze([
  '--hide-scrollbars',            // Linux draws classic scrollbars that steal layout width
  '--force-device-scale-factor=1',
  '--force-color-profile=srgb',
  '--disable-lcd-text',           // subpixel AA is platform + GPU dependent; force grayscale
  '--disable-skia-runtime-opts',  // baseline SIMD, not whatever the runner CPU offers
  '--disable-partial-raster',
  '--disable-checker-imaging',
  '--disable-threaded-animation',
  '--disable-image-animation-resync',
  '--font-render-hinting=none',
  '--lang=en-US',
]);

// A side-panel-shaped frame. why: with no override, headless Chrome captured at
// 756x413 — a landscape letterbox the side panel never has in production. The
// normal 400px capture remains the broad sidebar authority; the explicit
// narrow metrics below exercise the intentional Firefox-width breakpoints.
export const PANEL_METRICS = Object.freeze({ width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
// Firefox's installed sidebar screenshot has a 282px content column. The panel
// viewport is 310px; .body contributes 14px padding on each side. Keep this as
// the single narrow-width authority shared by the visual states.
export const NARROW_PANEL_METRICS = Object.freeze({ width: 310, height: 900, deviceScaleFactor: 1, mobile: false });

const STABLE_STYLE_ID = 'e2e-visual-stable';

// why NOT `animation:none` (what this used to inject): the wordmark blocks
// (wmType / wmColor*) and the home path cards (pathFlickerIn) hold their
// VISIBLE state through a `forwards` / `both` fill. Killing the animation
// deletes the fill and reverts them to their base rules — transparent, and
// opacity:0. The pre-2026-07 baselines therefore photographed a blank
// rectangle where the brand mark belongs, and a home screen with none of its
// six path cards. prefers-reduced-motion is the settled-state AUTHORITY
// instead (styles.css maintains @media blocks for exactly this), emulated over
// CDP before the document boots.
//
// What stays here is only what reduced-motion does NOT settle:
//   - the blinking text caret;
//   - canvas.code-stream, whose glyphs are placed by Math.random() — under
//     reduced motion it paints one random static scatter (measured 0.48% drift
//     at tolerance 8 across launches). It is aria-hidden atmosphere with zero
//     product signal. Deliberate blind spot: if that canvas ever breaks, the
//     visual gate will not see it.
export const VISUAL_STABLE_CSS =
  '*{caret-color:transparent!important}'
  + 'canvas.code-stream{display:none!important}';

const stableStyleSource = `(() => {
  const install = () => {
    if (document.getElementById(${JSON.stringify(STABLE_STYLE_ID)})) return true;
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    const s = document.createElement('style');
    s.id = ${JSON.stringify(STABLE_STYLE_ID)};
    s.textContent = ${JSON.stringify(VISUAL_STABLE_CSS)};
    parent.appendChild(s);
    return true;
  };
  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
})()`;

/**
 * Arm deterministic rendering on a freshly-created (about:blank) target BEFORE
 * it navigates to the page under test.
 *
 * why the ordering matters: sidepanel/components/vault-gate.js reads
 * matchMedia('(prefers-reduced-motion: reduce)').matches ONCE in oncreate.
 * Emulating the media query after mount repaints the CSS but leaves that JS in
 * its animated branch, so the settled state never arrives.
 * @param {{ send: (m: string, p?: object) => Promise<any> }} page
 */
export async function armDeterministicCapture(page) {
  await page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
  await setEmulatedTheme(page, 'light');
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }).catch(() => {});
  await page.send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => {});
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stableStyleSource });
}

// The two themes every visual state is captured in. why both: the design ships
// light AND dark, and the theme is PURE CSS (no sidepanel JS reads
// prefers-color-scheme), so a state's dark variant is a media re-emulation +
// re-shot, no page reload. Baselines are `<name>.light.png` / `<name>.dark.png`.
export const THEMES = Object.freeze(['light', 'dark']);

/**
 * Pin reduced-motion (always) + the color scheme. why pin the scheme: headless
 * Chrome otherwise follows the OS appearance, so a dev machine that auto-switches
 * to dark at night captures dark and every light baseline reads as a ~99% diff.
 * setEmulatedMedia re-evaluates the CSS media queries live, so switching this
 * mid-run restyles the visible surfaces without a reload.
 * @param {{ send: (m: string, p?: object) => Promise<any> }} page
 * @param {'light'|'dark'} theme
 */
export async function setEmulatedTheme(page, theme) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: theme },
    ],
  });
}

// The full-tab (large in-browser) viewport. why 1280×900: the full-tab surfaces
// (home SPA, options) lay out a nav rail + a max-880px content column, so a
// laptop-width frame renders them the way a real tab does — not the 400px panel.
export const WIDE_METRICS = Object.freeze({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

/**
 * Capture ANY attached page as a PNG buffer. Two headless-Chrome gotchas:
 * (1) bringToFront — headless composites only the foregrounded target, so the
 *     capture needs it active; (2) the nudge pump — a frozen (reduced-motion)
 *     page idles the compositor and captureScreenshot then waits forever, so a
 *     sub-pixel translateZ toggle on the root (invisible in 2D, verified 0.00000
 *     diff) keeps frames flowing until the capture resolves.
 * @param {{ send: (m: string, p?: object) => Promise<any> }} page
 * @param {{ bringToFront?: boolean }} [options]
 * @returns {Promise<Buffer>}
 */
export async function capturePage(page, { bringToFront = true } = {}) {
  if (bringToFront) await page.send('Page.bringToFront').catch(() => {});
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
}

/**
 * Open an extension page at a WIDE viewport with the deterministic capture armed
 * BEFORE it boots (device metrics + light theme + the stable stylesheet), then
 * wait for its Mithril mount. Returns the page handle; the caller screenshots
 * it (both themes) and closes it. Used for the full-tab / large-view baselines.
 * @param {object} ctx  from launchPeerd
 * @param {string} path  extension-relative, e.g. 'home/home.html'
 * @param {{ metrics?: object }} [opts]
 */
export async function openWidePage(ctx, path, { metrics = WIDE_METRICS, ready } = {}) {
  const url = `chrome-extension://${ctx.sw.id}/${String(path).replace(/^\//, '')}`;
  const created = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', metrics);
  await setEmulatedTheme(page, 'light');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stableStyleSource });
  await page.send('Page.bringToFront');
  await page.send('Page.navigate', { url });
  // why `ready` is overridable: the default probe waits for a Mithril mount at
  // `#app`, which is right for the SPA pages and WRONG for every standalone tab
  // page — the engine tabs render into their own ids (and their hard-fail cards
  // replace <body> outright), so they would time out here forever despite having
  // painted. Those pages are exactly the ones with no visual coverage, so the
  // probe has to be the caller's to choose.
  const probe = ready
    ? `document.readyState !== 'loading' && !!document.querySelector(${JSON.stringify(ready)})`
    : `document.readyState === 'complete' && !!document.querySelector('#app > *')`;
  const mounted = await waitFor(() => evalIn(page, probe), { budgetMs: READY_BUDGET_MS });
  if (!mounted) {
    const state = await evalIn(page, `({
      href: location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      title: document.title,
      body: document.body?.innerText?.slice(0, 500) ?? null,
      app: document.querySelector('#app')?.innerHTML?.slice(0, 500) ?? null,
    })`).catch((error) => ({ error: String(error) }));
    try { page.close(); } catch { /* */ }
    throw new Error(`wide page never mounted: ${path} ${JSON.stringify({ state, events: page.events })}`);
  }
  return page;
}

// ---- raw CDP attach over Chrome's WebSocket (no npm client) -----------------
export async function attach(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const eventListeners = new Set(onEvent ? [onEvent] : []);
  const events = [];
  const reqUrl = new Map();   // requestId → url; loadingFailed carries no url of its own
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      events.push('ERR ' + (m.params.args || []).map((a) => a.value || a.description || a.type).join(' '));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'warning') {
      events.push('WARN ' + (m.params.args || []).map((a) => a.value || a.description || a.type).join(' '));
    }
    // Failed / 4xx-5xx subresource loads. Only populated when Network.enable was
    // sent on this connection (openExtPage does, for the packaged-page boot check).
    // why: Chrome emits NO console error for a failed subresource (CSS/font/wasm/
    // img/dynamic-import), so this is the ONLY signal that a packaged build is
    // missing a file it references — the silent half of the black-screen class.
    if (m.method === 'Network.requestWillBeSent') {
      reqUrl.set(m.params?.requestId, m.params?.request?.url);
    }
    if (m.method === 'Network.responseReceived' && (m.params?.response?.status ?? 0) >= 400) {
      events.push(`NETFAIL ${m.params.response.status} ${m.params.response.url}`);
    }
    if (m.method === 'Network.loadingFailed' && !m.params?.canceled) {
      events.push(`NETFAIL ${m.params?.errorText || 'failed'} ${reqUrl.get(m.params?.requestId) || '(unknown url)'}`);
    }
    for (const listener of eventListeners) listener(m.method, m.params, m);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    close: () => ws.close(),
    events,
    on: (listener) => eventListeners.add(listener),
    off: (listener) => eventListeners.delete(listener),
  };
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
export function rpc(conn, message, { timeoutMs = READY_BUDGET_MS } = {}) {
  const expr = `new Promise((res) => {
    const timer = setTimeout(() => res({ ok: false, error: 'message-timeout' }), ${Number(timeoutMs)});
    try {
      chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => {
        clearTimeout(timer);
        const runtimeError = chrome.runtime.lastError?.message;
        res(runtimeError ? { ok: false, error: runtimeError } : (r ?? { ok: true, _noResponse: true }));
      });
    } catch (e) {
      clearTimeout(timer);
      res({ ok: false, error: String(e) });
    }
  })`;
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

export const PEERD_BACKGROUND_ENTRIES = Object.freeze([
  'background/vault-kernel-chrome.js',
  'background/vault-kernel-preview.js',
]);

export const identifyPeerdBackgroundTarget = (target) => {
  if (target?.type !== 'service_worker') return null;
  const url = String(target?.url ?? '');
  const extensionId = url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1];
  const entry = PEERD_BACKGROUND_ENTRIES.find((candidate) => url.endsWith(`/${candidate}`));
  if (!extensionId || !entry || !target?.id || !target?.webSocketDebuggerUrl) return null;
  return {
    id: extensionId,
    targetId: target.id,
    wsUrl: target.webSocketDebuggerUrl,
    url,
    entry,
  };
};

// peerd's MV3 background target, never an arbitrary Chrome component
// extension. Returns the exact loaded script entry as part of the identity.
export async function findPeerdSw(port) {
  const targets = await cdpList(port);
  const matches = targets.map(identifyPeerdBackgroundTarget).filter(Boolean);
  // A fresh-profile harness must never silently pick one of two matching
  // background entries. Ambiguity is a hard failure at the caller's timeout,
  // not permission to time or control an unrelated extension.
  return matches.length === 1 ? matches[0] : null;
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
 * @param {boolean} [opts.interceptModel] attach Fetch interception to the
 *   service worker; false for physical lifecycle tests that must not pin it.
 * @param {boolean} [opts.captureBootTimeline] prove and timestamp the visible
 *   inline shell before accepting the evaluated module marker.
 * @param {(page: object) => Promise<void>} [opts.beforePanelNavigate] install
 *   target-scoped physical fixtures before page capability probes execute.
 * @param {string} [opts.panelPath] extension page hosting the vault shell.
 * @param {string} [opts.expectedBackgroundEntry] exact shipped worker entry.
 *   Production-cutover evidence must set this to the exact target entry;
 *   omitting it is intentionally only migration/dev compatibility.
 * @param {{url:string,certificateSpkiSha256:string}} [opts.proxyServer]
 *   acceptance-only loopback CONNECT proxy and exact fixture TLS identity.
 * @param {boolean} [opts.webRtcLoopbackAcceptance] expose numeric loopback ICE
 *   candidates for a physical same-host multi-profile WebRTC acceptance lane.
 */
export async function launchPeerd({
  modelResponder, tagsModel = 'qwen3:8b', extensionDir = EXT,
  interceptModel = true, captureBootTimeline = false, beforePanelNavigate,
  panelPath = 'sidepanel/sidepanel.html', expectedBackgroundEntry, proxyServer,
  webRtcLoopbackAcceptance = false,
} = {}) {
  const launchStartedAt = hostMonotonicMs();
  const acceptanceProxy = normalizeAcceptanceProxyServer(proxyServer);
  // extensionDir defaults to the raw source (the dev/e2e tree); pass a packaged
  // STAGING dir to load a PRUNED build instead (check-packaged-pages.ts) — the
  // only way to observe packaged-build-only breakage like the v0.2.0 home blank.
  if (!existsSync(join(extensionDir, 'manifest.json'))) {
    throw new Error(`manifest.json missing in ${extensionDir} — run \`bun run gen:dev\` (or package first)`);
  }
  const CHROME = resolveChrome();
  log('chrome:', CHROME);
  const profile = mkdtempSync(join(tmpdir(), 'peerd-e2e-'));
  // why: a live task can trigger a file download; without redirection Chrome
  // dumps it into the REAL ~/Downloads. Send them to a temp dir cleaned on exit.
  const downloadDir = mkdtempSync(join(tmpdir(), 'peerd-dl-'));

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    // Browser-policy fixtures need public-looking names while their local HTTP
    // servers stay deterministic and offline. Reserved .test names preserve the
    // documented DNS-resolution residual without weakening localhost coverage.
    '--host-resolver-rules=MAP orders.peerd.test 127.0.0.1, MAP acme.peerd.test 127.0.0.1, MAP acct.peerd.test 127.0.0.1, MAP guard.peerd.test 127.0.0.1, MAP chase.com 127.0.0.1',
    // Product-boundary security tests must not pass because Chrome's separate
    // Local Network Access feature stopped the request first.
    `--disable-features=${[
      'LocalNetworkAccessChecks',
      'LocalNetworkAccessChecksWebSockets',
      'LocalNetworkAccessForWorkers',
      ...(webRtcLoopbackAcceptance ? ['WebRtcHideLocalIpsWithMdns'] : []),
    ].join(',')}`,
    '--disable-web-security',
    '--ip-address-space-overrides=127.0.0.0/8=public',
    `--unsafely-treat-insecure-origin-as-secure=http://orders.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT},http://acct.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT}`,
    '--disable-gpu', '--no-sandbox',
    '--enable-unsafe-extension-debugging',
    ...(acceptanceProxy ? [
      `--proxy-server=${acceptanceProxy.url}`,
      `--ignore-certificate-errors-spki-list=${acceptanceProxy.certificateSpkiSha256}`,
    ] : []),
    ...DETERMINISM_FLAGS,
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });

  let closed = false;
  const cleanup = () => {
    if (closed) return; closed = true;
    try { chrome?.kill('SIGKILL'); } catch { /* */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(downloadDir, { recursive: true, force: true }); } catch { /* */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let port;
  try {
    port = await waitForCdpPort(profile);
  } catch (error) {
    cleanup();
    const diagnostics = chromeErr.trim();
    const exit = chrome.signalCode
      ? `Chrome exited by signal ${chrome.signalCode}`
      : chrome.exitCode !== null ? `Chrome exited with code ${chrome.exitCode}` : '';
    throw new Error([
      error?.message ?? error,
      exit,
      diagnostics ? `Chrome stderr:\n${diagnostics}` : '',
    ].filter(Boolean).join('\n'));
  }
  log('cdp port:', port);

  // Redirect downloads browser-wide to the temp dir (headless honors this CDP
  // call where profile Preferences often don't). Best-effort: attach to the
  // browser target and leave the conn open so the setting persists for the run.
  let browserConn = null;
  try {
    const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    browserConn = await attach(ver.webSocketDebuggerUrl);
    await browserConn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  } catch { /* download redirect is best-effort; never block the run on it */ }

  // 1) discover peerd's id from its SW target (proves the extension loaded)
  const sw = await waitFor(() => findPeerdSw(port), { budgetMs: READY_BUDGET_MS });
  if (!sw) {
    cleanup();
    if (/--disable-extensions-except is not allowed|--load-extension/i.test(chromeErr)) {
      throw new Error('Extension did not load — this Chrome ignores --load-extension. Use Chrome for Testing / Chromium (set CHROME_PATH).');
    }
    throw new Error('peerd service-worker target never appeared (extension failed to load).');
  }
  if (expectedBackgroundEntry && sw.entry !== expectedBackgroundEntry) {
    cleanup();
    throw new Error(
      `production worker cutover mismatch: expected ${expectedBackgroundEntry}, loaded ${sw.entry}`,
    );
  }
  log('extension id:', sw.id);
  log('background entry:', sw.entry);

  // 2) attach to the SW and intercept the Ollama model call over CDP Fetch.
  // currentResponder is SWAPPABLE (ctx.setModelResponder) so a single Chrome can
  // host many states back-to-back, each with its own model behaviour — the
  // single-Chrome speed path for the verify loop.
  let currentResponder = modelResponder || (() => ({ sse: sseText('e2e-smoke-ok') }));
  let modelCalls = 0;
  let remoteModuleRequests = 0;
  const handlePausedRequest = async (connection, params) => {
    const { requestId, request } = params;
    const url = String(request.url);
    const fulfill = (contentType, bodyStr, status = 200) => connection.send('Fetch.fulfillRequest', {
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
      } else if (url === 'https://remote-module.test/store-policy-canary.js') {
        remoteModuleRequests += 1;
        await fulfill('application/javascript', "export const value = 'remote-canary-executed';");
      } else if (url.includes('11434')) {
        await fulfill('application/json', '{}');
      } else {
        await connection.send('Fetch.continueRequest', { requestId });
      }
    } catch { /* the worker, controller, or request may have been physically torn down */ }
  };
  const attachFetchTarget = async (targetId) => {
    if (!browserConn) throw new Error('browser CDP connection unavailable');
    const { sessionId } = await browserConn.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const events = [];
    const onTargetEvent = (method, params, message) => {
      if (message.sessionId !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        events.push('EXC ' + (params?.exceptionDetails?.exception?.description
          || params?.exceptionDetails?.text));
      }
      if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
        events.push('ERR ' + (params.args || [])
          .map((arg) => arg.value || arg.description || arg.type).join(' '));
      }
      if (method === 'Fetch.requestPaused') void handlePausedRequest(connection, params);
    };
    const connection = {
      send: (method, params = {}) => browserConn.send(method, params, sessionId),
      events,
      close: () => {
        browserConn.off(onTargetEvent);
        browserConn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      },
    };
    browserConn.on(onTargetEvent);
    await connection.send('Runtime.runIfWaitingForDebugger');
    await connection.send('Runtime.enable').catch(() => {});
    await connection.send('Fetch.enable', { patterns: [
      { urlPattern: '*11434*' },
      { urlPattern: 'https://remote-module.test/*' },
    ] });
    return connection;
  };
  const attachServiceWorker = (target) => attachFetchTarget(target.targetId);
  let swConn = interceptModel ? await attachServiceWorker(sw) : null;
  const auxiliaryFetchConnections = new Map();
  const retiredTargetEvents = [];
  const auxiliaryFetchPending = new Set();
  const extensionTarget = (targetInfo) => {
    const url = String(targetInfo?.url ?? '');
    return targetInfo?.targetId !== sw.targetId
      && targetInfo?.type !== 'service_worker'
      && (url.startsWith(`chrome-extension://${sw.id}/`)
        || url.startsWith(`blob:chrome-extension://${sw.id}/`));
  };
  const armAuxiliaryFetch = async (targetInfo) => {
    const targetId = targetInfo?.targetId;
    if (!interceptModel || !targetId || !extensionTarget(targetInfo)
        || auxiliaryFetchConnections.has(targetId) || auxiliaryFetchPending.has(targetId)) return;
    auxiliaryFetchPending.add(targetId);
    try {
      const connection = await attachFetchTarget(targetId);
      auxiliaryFetchConnections.set(targetId, connection);
    } catch { /* the short-lived target may retire before attachment */ }
    finally { auxiliaryFetchPending.delete(targetId); }
  };
  const onAuxiliaryTarget = (method, params) => {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      void armAuxiliaryFetch(params?.targetInfo);
    } else if (method === 'Target.targetDestroyed') {
      const connection = auxiliaryFetchConnections.get(params?.targetId);
      if (connection?.events?.length) {
        retiredTargetEvents.push({ targetId: params?.targetId, events: [...connection.events] });
      }
      try { connection?.close(); } catch { /* target already retired */ }
      auxiliaryFetchConnections.delete(params?.targetId);
    }
  };
  if (interceptModel) {
    browserConn.on(onAuxiliaryTarget);
    await browserConn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos = [] } = await browserConn.send('Target.getTargets');
    await Promise.all(targetInfos.map(armAuxiliaryFetch));
    log('Fetch interception armed across extension worker/controller targets');
  }

  const panelUrl = `chrome-extension://${sw.id}/${String(panelPath).replace(/^\//, '')}`;
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const activationPage = await attach(created.webSocketDebuggerUrl);
  await activationPage.send('Runtime.enable');
  await activationPage.send('Page.enable');
  await activationPage.send('Page.bringToFront');
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const nativePanel = String(manifest.side_panel?.default_path ?? '').replace(/^\//, '')
    === String(panelPath).replace(/^\//, '');
  let page;
  if (nativePanel) {
    if (!browserConn) throw new Error('browser CDP connection unavailable');
    const { targetInfos: actionTargets = [] } = await browserConn.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }, { exclude: false }],
    });
    const actionTabs = actionTargets.filter(
      (entry) => entry.type === 'tab' && entry.url === 'about:blank',
    );
    if (actionTabs.length === 0) {
      throw new Error(`Chrome did not expose an action tab target: ${JSON.stringify(actionTargets)}`);
    }
    /** @type {any} */ let target = null;
    for (const actionTarget of actionTabs) {
      await browserConn.send('Extensions.triggerAction', {
        id: sw.id, targetId: actionTarget.targetId,
      });
      target = await waitFor(async () => {
        const { targetInfos = [] } = await browserConn.send('Target.getTargets');
        return targetInfos.find(
          (entry) => entry.targetId !== created.id && entry.url === panelUrl,
        ) ?? null;
      }, { budgetMs: Math.min(2_000, READY_BUDGET_MS), pollMs: 25 });
      if (target) break;
    }
    if (!target) {
      activationPage.close();
      cleanup();
      throw new Error('browser-owned side panel target never appeared');
    }
    const { sessionId } = await browserConn.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const listeners = new Set();
    const events = [];
    const onTargetEvent = (method, params, message) => {
      if (message.sessionId !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        events.push('EXC ' + (params?.exceptionDetails?.exception?.description
          || params?.exceptionDetails?.text));
      }
      if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
        events.push('ERR ' + (params.args || [])
          .map((arg) => arg.value || arg.description || arg.type).join(' '));
      }
      for (const listener of listeners) listener(method, params, message);
    };
    browserConn.on(onTargetEvent);
    activationPage.close();
    page = {
      send: (method, params = {}) => browserConn.send(method, params, sessionId),
      close: () => {
        browserConn.off(onTargetEvent);
        browserConn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      },
      events,
      on: (listener) => listeners.add(listener),
      off: (listener) => listeners.delete(listener),
    };
  } else {
    page = activationPage;
  }
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await armDeterministicCapture(page);
  // A background target may throttle requestAnimationFrame indefinitely. The
  // product shell's paint proof intentionally waits two frames, so foreground
  // this side-panel-shaped tab before navigation just as a user-opened panel is
  // foregrounded by Chrome.
  await page.send('Page.bringToFront');
  if (beforePanelNavigate) await beforePanelNavigate(page);
  if (nativePanel) await page.send('Page.reload');
  else await page.send('Page.navigate', { url: panelUrl });

  let staticShellPaintedAt = null;
  if (captureBootTimeline) {
    const shellPainted = await waitFor(
      () => evalIn(page, `(() => {
        const root = document.querySelector('#app');
        const rect = root?.getBoundingClientRect();
        const style = root ? getComputedStyle(root) : null;
        // The source sets this marker only after the static shell itself has a
        // visible box. startVaultShell then synchronously replaces that node,
        // so requiring the old node to survive until a host poll is a race.
        return document.documentElement?.dataset.peerdStaticShellPainted === 'true'
          && !!root && !!rect && rect.width > 0 && rect.height > 0
          && style?.visibility !== 'hidden' && style?.display !== 'none';
      })()`),
      { budgetMs: READY_BUDGET_MS, pollMs: 25 },
    );
    if (!shellPainted) {
      const snapshot = await evalIn(page, `(() => {
        const node = document.querySelector('#app > .boot-shell');
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        return {
          url: location.href,
          readyState: document.readyState,
          dataset: { ...document.documentElement.dataset },
          shell: node ? {
            text: node.innerText,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            display: style?.display,
            visibility: style?.visibility,
          } : null,
        };
      })()`).catch((cause) => ({ diagnosticError: String(cause) }));
      const events = page.events.slice(-12);
      cleanup();
      throw new Error(
        `visible static vault shell never painted\n${JSON.stringify({ snapshot, events }, null, 2)}`,
      );
    }
    staticShellPaintedAt = hostMonotonicMs();
  }

  const mounted = await waitFor(
    () => evalIn(page, `document.readyState === 'complete'
      && document.documentElement?.dataset.peerdBootModule === 'evaluated'
      && !!document.documentElement?.dataset.peerdBootStage`),
    { budgetMs: READY_BUDGET_MS },
  );
  if (!mounted) { cleanup(); throw new Error('side panel never mounted'); }
  const bootModuleEvaluatedAt = hostMonotonicMs();
  log('side panel mounted');

  const screenshot = () => capturePage(page);
  const serviceWorkerVersions = new Map();
  let serviceWorkerTrackingEnabled = false;
  const onServiceWorkerVersion = (method, { versions = [] } = {}) => {
    if (method !== 'ServiceWorker.workerVersionUpdated') return;
    for (const row of versions) {
      if (typeof row?.versionId === 'string') serviceWorkerVersions.set(row.versionId, row);
    }
  };
  const enableServiceWorkerTracking = async () => {
    if (serviceWorkerTrackingEnabled) return;
    serviceWorkerTrackingEnabled = true;
    page.on(onServiceWorkerVersion);
    await page.send('ServiceWorker.enable');
  };

  const context = {
    sw, swConn, page, port, profile, screenshot,
    bootTimeline: Object.freeze({
      clock: 'host-monotonic-ms',
      launchStartedAt,
      staticShellPaintedAt,
      bootModuleEvaluatedAt,
      staticShellReadyMs: staticShellPaintedAt === null
        ? null : staticShellPaintedAt - launchStartedAt,
      bootModuleReadyMs: bootModuleEvaluatedAt - launchStartedAt,
    }),
    close: async () => {
      const exited = chrome.exitCode !== null || chrome.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => chrome.once('exit', resolve));
      try { page.off(onServiceWorkerVersion); } catch { /* */ }
      try { page.close(); } catch { /* */ }
      try { swConn?.close(); } catch { /* */ }
      try { browserConn?.off(onAuxiliaryTarget); } catch { /* */ }
      for (const connection of auxiliaryFetchConnections.values()) {
        try { connection.close(); } catch { /* target already retired */ }
      }
      auxiliaryFetchConnections.clear();
      try { browserConn?.close(); } catch { /* */ }
      cleanup();
      // Fresh-profile performance samples must not overlap a prior Chrome
      // process that is still unwinding after SIGKILL. Overlap can starve the
      // next MV3 worker and turns host contention into a false cold-tail claim.
      await Promise.race([exited, sleep(5_000)]);
    },
    modelCallCount: () => modelCalls,
    remoteModuleRequestCount: () => remoteModuleRequests,
    extensionTargetEvents: () => [
      ...[...auxiliaryFetchConnections.entries()].map(
        ([targetId, connection]) => ({ targetId, events: [...connection.events] }),
      ),
      ...retiredTargetEvents.map((entry) => ({ ...entry, retired: true })),
    ],
    // Swap the model behaviour + reset the per-state call counter — lets one
    // Chrome run many states back-to-back (the single-Chrome verify path).
    setModelResponder: (fn) => { currentResponder = fn || (() => ({ sse: sseText('e2e-smoke-ok') })); modelCalls = 0; },
    // Authoritative MV3 retirement. Target.closeTarget is not sufficient
    // evidence: it can close a debugger target without proving Chrome stopped
    // the registered worker version. This uses the ServiceWorker domain,
    // observes an exact running script URL, then requires the target to vanish.
    stopServiceWorker: async () => {
      const old = { ...context.sw };
      await enableServiceWorkerTracking();
      const currentVersion = await waitFor(() => [...serviceWorkerVersions.values()].find((row) =>
        row.runningStatus === 'running' && String(row.scriptURL) === old.url),
      { budgetMs: 5_000, pollMs: 25 });
      if (!currentVersion) {
        throw new Error(`ServiceWorker domain did not expose running ${old.entry}`);
      }
      // A surviving extension page can immediately wake the worker while it is
      // being stopped. Navigate it away first; restartServiceWorker performs a
      // fresh physical navigation through the same user-visible page target.
      await page.send('Page.navigate', { url: 'about:blank' });
      const away = await waitFor(() => evalIn(page, `location.href === 'about:blank'`), {
        budgetMs: 5_000, pollMs: 10,
      });
      if (!away) throw new Error('panel page did not release the service worker');
      try { swConn?.close(); } catch { /* */ }
      swConn = null;
      context.swConn = null;
      await page.send('ServiceWorker.stopWorker', { versionId: currentVersion.versionId });
      const stoppedVersion = await waitFor(() => {
        const row = serviceWorkerVersions.get(currentVersion.versionId);
        return row?.runningStatus === 'stopped' ? row : null;
      }, { budgetMs: 8_000, pollMs: 25 });
      if (!stoppedVersion) {
        throw new Error(`ServiceWorker version ${currentVersion.versionId} remained running`);
      }
      const gone = await waitFor(async () => {
        const current = await findPeerdSw(port);
        return !current || current.targetId !== old.targetId;
      }, { budgetMs: 8_000, pollMs: 50 });
      if (!gone) throw new Error('MV3 service-worker target did not terminate');
      return {
        ...old,
        versionId: currentVersion.versionId,
        stoppedRunningStatus: stoppedVersion.runningStatus,
      };
    },
    // Backward-compatible name, now backed by authoritative stopWorker rather
    // than Target.closeTarget. New production acceptance should call the
    // explicit stopServiceWorker method and retain the full old identity.
    terminateServiceWorker: async () => (await context.stopServiceWorker()).targetId,
    // Wake the extension through a fresh panel navigation, attach to the fresh
    // target, and restore wire-only model interception before returning.
    restartServiceWorker: async (oldWorker) => {
      const oldTargetId = typeof oldWorker === 'string' ? oldWorker : oldWorker?.targetId;
      if (!oldTargetId) throw new Error('old service-worker identity is required');
      const navigation = await page.send('Page.navigate', { url: panelUrl });
      if (navigation?.errorText) throw new Error(`panel wake navigation failed: ${navigation.errorText}`);
      const next = await waitFor(async () => {
        const candidate = await findPeerdSw(port);
        return candidate && candidate.targetId !== oldTargetId ? candidate : null;
      }, { budgetMs: READY_BUDGET_MS, pollMs: 50 });
      if (!next) throw new Error('MV3 service worker did not restart after wake');
      if (expectedBackgroundEntry && next.entry !== expectedBackgroundEntry) {
        throw new Error(
          `restarted worker cutover mismatch: expected ${expectedBackgroundEntry}, loaded ${next.entry}`,
        );
      }
      const pageReady = await waitFor(
        () => evalIn(page, `document.readyState === 'complete'
          && document.documentElement?.dataset.peerdBootModule === 'evaluated'
          && !!document.documentElement?.dataset.peerdBootStage`),
        { budgetMs: READY_BUDGET_MS, pollMs: 25 },
      );
      if (!pageReady) throw new Error('side panel did not remount after worker wake');
      swConn = interceptModel ? await attachServiceWorker(next) : null;
      context.sw = next;
      context.swConn = swConn;
      return next;
    },
  };
  return context;
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
 * Settle the render so screenshots are identical run-to-run.
 *
 * The heavy lifting happens in armDeterministicCapture BEFORE the document
 * boots (emulated prefers-reduced-motion is the settled-state authority — see
 * VISUAL_STABLE_CSS for why an `animation:none` sledgehammer was wrong). This
 * is the idempotent top-up for pages already mounted; the <style> rides in
 * <head>, which Mithril's #app re-renders don't touch.
 * @param {object} ctx
 */
export async function freezeAnimations(ctx) {
  await evalIn(ctx.page, stableStyleSource);
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
  if (v.unchanged) {
    // A reseed that changed nothing should SAY so — otherwise "baseline updated"
    // on 24 files implies 24 real changes to look at.
    checks.check(`visual: ${name} — unchanged, not rewritten`, true);
  } else if (v.wrote) {
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
  // Vault initialization intentionally uses the production Argon2 parameters.
  // Its budget is separate from ordinary extension boot/RPC readiness: loaded
  // CI runners can spend well over 30 seconds in the browser worker without
  // indicating a hung message channel.
  const vault = await rpc(page, { type: 'vault/initialize', passphrase: PASSPHRASE }, {
    timeoutMs: VAULT_READY_BUDGET_MS,
  });
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
  // Create the tab at about:blank FIRST, enable Network, THEN navigate. why: if we
  // open straight at the page URL, the document and its synchronous HEAD resources
  // (the page's primary <link> stylesheet, <script src>) have already committed by
  // the time we attach + Network.enable — so a pruned HEAD asset would emit no
  // captured loadingFailed and slip the packaged-page boot check. Enabling Network
  // before navigation captures the FULL load. (Same pattern as run-inbrowser-tests.)
  const created = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  // The packaged-page boot check needs failed subresource loads (a pruned CSS/font/
  // wasm/dynamic-import 404), which surface only as Network events, never console.
  await page.send('Network.enable');
  await page.send('Page.navigate', { url });
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
