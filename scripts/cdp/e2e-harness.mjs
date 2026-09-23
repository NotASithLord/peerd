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
  if (document.getElementById(${JSON.stringify(STABLE_STYLE_ID)})) return;
  const s = document.createElement('style');
  s.id = ${JSON.stringify(STABLE_STYLE_ID)};
  s.textContent = ${JSON.stringify(VISUAL_STABLE_CSS)};
  (document.head || document.documentElement).appendChild(s);
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
const foregroundedPages = new WeakSet();
export async function capturePage(page, { bringToFront = true } = {}) {
  // why: Repeating bringToFront can stall the next headless screenshot.
  if (bringToFront && !foregroundedPages.has(page)) {
    await page.send('Page.bringToFront').catch(() => {});
    foregroundedPages.add(page);
  }
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
  const disconnect = page.close;
  page.close = () => {
    disconnect();
    return fetch(`http://127.0.0.1:${ctx.port}/json/close/${created.id}`).catch(() => {});
  };
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', metrics);
  await setEmulatedTheme(page, 'light');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stableStyleSource });
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
  if (!mounted) { try { page.close(); } catch { /* */ } throw new Error(`wide page never mounted: ${path}`); }
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

// peerd's MV3 SW target — matched by service-worker.js so we never grab a
// Chrome component extension. Returns { id, wsUrl }.
async function findPeerdSw(port) {
  const targets = await cdpList(port);
  const sw = targets.find((t) => t.type === 'service_worker' && /\/background\/service-worker\.js/.test(String(t.url)));
  if (!sw) return null;
  const id = String(sw.url).match(/chrome-extension:\/\/([a-p]{32})\//)?.[1];
  return id ? { id, targetId: sw.id, wsUrl: sw.webSocketDebuggerUrl } : null;
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
 */
export async function launchPeerd({
  modelResponder, tagsModel = 'qwen3:8b', extensionDir = EXT,
  interceptModel = true,
} = {}) {
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
    '--host-resolver-rules=MAP orders.peerd.test 127.0.0.1, MAP acme.peerd.test 127.0.0.1, MAP acct.peerd.test 127.0.0.1, MAP guard.peerd.test 127.0.0.1',
    // Product-boundary security tests must not pass because Chrome's separate
    // Local Network Access feature stopped the request first.
    '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,LocalNetworkAccessForWorkers',
    '--disable-web-security',
    '--ip-address-space-overrides=127.0.0.0/8=public',
    `--unsafely-treat-insecure-origin-as-secure=http://orders.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT},http://acct.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT}`,
    '--disable-gpu', '--no-sandbox',
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
    throw new Error(`${error?.message ?? error}${diagnostics ? `\nChrome stderr:\n${diagnostics}` : ''}`);
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
  log('extension id:', sw.id);

  // 2) attach to the SW and intercept the Ollama model call over CDP Fetch.
  // currentResponder is SWAPPABLE (ctx.setModelResponder) so a single Chrome can
  // host many states back-to-back, each with its own model behaviour — the
  // single-Chrome speed path for the verify loop.
  let currentResponder = modelResponder || (() => ({ sse: sseText('e2e-smoke-ok') }));
  let modelCalls = 0;
  let remoteModuleRequests = 0;
  const attachServiceWorker = async (target) => {
    if (!browserConn) throw new Error('browser CDP connection unavailable');
    const { sessionId } = await browserConn.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const connection = {
      send: (method, params = {}) => browserConn.send(method, params, sessionId),
      close: () => {
        browserConn.off(onWorkerEvent);
        browserConn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      },
    };
    const onWorkerEvent = async (method, params, message) => {
      if (message.sessionId !== sessionId) return;
      if (method !== 'Fetch.requestPaused') return;
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
      } catch { /* the worker or request may have been physically torn down */ }
    };
    browserConn.on(onWorkerEvent);
    await connection.send('Runtime.runIfWaitingForDebugger');
    await connection.send('Fetch.enable', { patterns: [
      { urlPattern: '*11434*' },
      { urlPattern: 'https://remote-module.test/*' },
    ] });
    return connection;
  };
  let swConn = interceptModel ? await attachServiceWorker(sw) : null;
  if (interceptModel) log('Fetch interception armed on the service worker');

  // 3) open the side panel as a normal tab (chrome.sidePanel.open is not
  //    drivable over CDP; the same Mithril app + SW port load fine in a tab).
  const panelUrl = `chrome-extension://${sw.id}/sidepanel/sidepanel.html`;
  // Create at about:blank FIRST, configure, THEN navigate — the deterministic
  // capture must be armed before the panel document boots (armDeterministic-
  // Capture explains why). Same shape openExtPage uses.
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await attach(created.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await armDeterministicCapture(page);
  await page.send('Page.navigate', { url: panelUrl });

  const mounted = await waitFor(
    () => evalIn(page, `document.readyState === 'complete' && !!document.querySelector('#app, body > *')`),
    { budgetMs: READY_BUDGET_MS },
  );
  if (!mounted) { cleanup(); throw new Error('side panel never mounted'); }
  log('side panel mounted');

  const screenshot = () => capturePage(page);

  const context = {
    sw, swConn, page, port, profile, screenshot,
    close: () => {
      try { page.close(); } catch { /* */ }
      try { swConn?.close(); } catch { /* */ }
      try { browserConn?.close(); } catch { /* */ }
      cleanup();
    },
    modelCallCount: () => modelCalls,
    remoteModuleRequestCount: () => remoteModuleRequests,
    // Swap the model behaviour + reset the per-state call counter — lets one
    // Chrome run many states back-to-back (the single-Chrome verify path).
    setModelResponder: (fn) => { currentResponder = fn || (() => ({ sse: sseText('e2e-smoke-ok') })); modelCalls = 0; },
    // Physically close the MV3 service-worker target. This is not a reload or
    // an in-process lifecycle simulation. The old target must disappear before
    // the method returns, so a caller cannot mistake a rejected close for a
    // recovery test.
    terminateServiceWorker: async () => {
      const oldTargetId = context.sw.targetId;
      if (!browserConn) throw new Error('browser CDP connection unavailable');
      const closed = await browserConn.send('Target.closeTarget', { targetId: oldTargetId });
      if (closed?.success !== true) throw new Error('CDP refused service-worker close');
      const gone = await waitFor(async () => {
        const current = await findPeerdSw(port);
        return !current || current.targetId !== oldTargetId;
      }, { budgetMs: 8_000, pollMs: 50 });
      if (!gone) throw new Error('MV3 service-worker target did not terminate');
      try { swConn?.close(); } catch { /* target already closed */ }
      return oldTargetId;
    },
    // Wake the extension through the surviving panel, attach to the fresh
    // target, and restore wire-only model interception before returning.
    restartServiceWorker: async (oldTargetId) => {
      evalIn(page, `chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null)`, false)
        .catch(() => {});
      const next = await waitFor(async () => {
        const candidate = await findPeerdSw(port);
        return candidate && candidate.targetId !== oldTargetId ? candidate : null;
      }, { budgetMs: READY_BUDGET_MS, pollMs: 50 });
      if (!next) throw new Error('MV3 service worker did not restart after wake');
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
  const disconnect = page.close;
  page.close = () => {
    disconnect();
    return fetch(`http://127.0.0.1:${ctx.port}/json/close/${created.id}`).catch(() => {});
  };
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
