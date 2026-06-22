// @ts-check
// app-tab/app-tab.js — trusted parent shell logic.
//
// Two modes:
//   - render (default): read OPFS files, compose into a single HTML
//                       body, postMessage to the sandboxed runner.
//   - edit: mount the shared peerd-engine/editor module into a panel
//           that overlays the iframe. Same UX as the Notebook.
// The toggle is a small floating button (top-right) that swaps modes
// without leaving the tab.

import browser from '/vendor/browser-polyfill.js';
import {
  composeApp,
  withNewTabLinks,
  stripMetaRefresh,
  createEditor,
  opfsHelpers,
} from '/peerd-engine/index.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';

const appId = location.hash.slice(1).split(/[?&]/)[0];
// Launch params ride the hash past the appId (`#<id>?room=…&url=…`) —
// the dweb bridge hands them to the app at hello (deep-link into a room).
const launchParams = (() => {
  const q = location.hash.slice(1).split('?')[1] ?? '';
  const p = new URLSearchParams(q);
  return { room: p.get('room') ?? undefined, url: p.get('url') ?? undefined };
})();
// why the cast: these IDs are static in index.html and present at load; a single
// non-null cast at the boundary keeps the call sites clean.
/** @param {string} id @returns {HTMLElement} */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const boot    = byId('boot');
const bootMsg = byId('boot-msg');
const frame   = /** @type {HTMLIFrameElement} */ (byId('app-frame'));
const editorPanel = byId('editor-panel');
const editorMount = byId('editor-mount');
const toggleBtn = byId('mode-toggle');
const exportBtn = /** @type {HTMLButtonElement} */ (byId('export-btn'));

/** @param {string} msg */
const fail = (msg) => {
  boot.classList.remove('is-hidden');
  boot.classList.add('is-failed');
  bootMsg.textContent = `Failed: ${msg}`;
};

if (!appId) {
  fail('No appId in URL hash.');
  throw new Error('No appId in URL hash');
}

const opfs = opfsHelpers(['peerd-apps', appId]);
/** @type {{ name: string, entryFile: string, dweb: any } | null} */
let appMeta = null;        // { name, entryFile }
/** @type {Awaited<ReturnType<typeof createEditor>> | null} */
let editorApi = null;
let mode = 'render';

// ---------------------------------------------------------------------------
// Render mode — compose multi-file from OPFS, post to the runner iframe
// ---------------------------------------------------------------------------

const readAllFiles = async () => {
  const entries = await opfs.list();
  /** @type {Record<string, string>} */
  const files = {};
  for (const e of entries) {
    const path = e.path.replace(/^\/+/, '');
    files[path] = await opfs.read(path);
  }
  return files;
};

// Built-in libraries available to every app without a download. Apps run
// in a sandboxed iframe (opaque origin, no ES-module resolution), so we
// hand them classic/global builds: referencing `<script src="./<name>">`
// inlines the vendored source at compose time. Lazily fetched + cached.
/** @type {Record<string, string>} */
const BUILTIN_LIBS = {
  'mithril.js': '/vendor/mithril/mithril.global.js',
};
/** @type {Record<string, string>} */
const builtinCache = {};
/** @param {string} name */
const loadBuiltinLib = async (name) => {
  if (builtinCache[name] != null) return builtinCache[name];
  // why: fetches our OWN bundled asset via a chrome-extension:// URL
  // (runtime.getURL), not a network egress. The egress allowlist
  // intentionally wouldn't admit our own extension origin, so safeFetch
  // isn't the right tool here (same case as peerd-runtime/loop/system-prompt.js).
  // eslint-disable-next-line no-restricted-globals
  const res = await fetch(browser.runtime.getURL(BUILTIN_LIBS[name]));
  if (!res.ok) throw new Error(`builtin ${name}: HTTP ${res.status}`);
  builtinCache[name] = await res.text();
  return builtinCache[name];
};

// Inject built-in libs the app didn't ship itself, so `<script
// src="./mithril.js">` resolves. composeApp only inlines REFERENCED
// files, so unused injections cost nothing in the rendered output.
/** @param {Record<string, string>} files */
const withBuiltinLibs = async (files) => {
  for (const name of Object.keys(BUILTIN_LIBS)) {
    if (name in files) continue;  // app shipped its own — respect it
    try { files[name] = await loadBuiltinLib(name); }
    catch (e) { console.warn('[app-tab] builtin lib inject failed:', name, e); }
  }
  return files;
};

let runnerReady = false;
// Watchdog timer for the runner-ready handshake — so a runner iframe that
// throws / never loads doesn't strand the app on the boot screen forever.
/** @type {ReturnType<typeof setTimeout> | null} */
let runnerWatchdog = null;
/** @type {string | null} */
let pendingBody = null;
// Set true right before WE point the frame at the runner, so the frame's load
// event can tell our own (re)load apart from a navigation the app initiated.
let expectingRunnerLoad = false;
// The frame starts with NO src, so the browser fires one `load` for its initial
// about:blank — before we've ever pointed it at the runner. That isn't an app
// navigation; flip this true once we DO start the runner so the load handler
// ignores that first empty load (it would otherwise log a spurious "navigated
// unexpectedly" on every open).
let runnerStarted = false;
// The runner renders the app body with document.open()/write()/close() — and
// closing a written document fires a FRESH `load` on the iframe. That load is
// OUR delivery, not the app navigating away; flip this true right before we
// post the body so the load handler consumes it instead of mistaking it for an
// app navigation (which would log a spurious warning AND tear down the dweb
// bridge we just attached on runner-ready). One-shot per delivery.
let expectingBodyLoad = false;

const tryDeliver = () => {
  if (!runnerReady || !pendingBody) return;
  expectingBodyLoad = true;
  frame.contentWindow?.postMessage(
    { type: 'app-body', html: pendingBody },
    '*',
  );
  if (appMeta?.name) document.title = `peerd · ${appMeta.name}`;
  boot.classList.add('is-hidden');
};

const renderMode = async () => {
  mode = 'render';
  document.body.classList.remove('mode-edit');
  document.body.classList.add('mode-render');
  toggleBtn.textContent = 'Edit ✎';
  // why: the editor panel (z-index 20) is shown/hidden ONLY by its
  // `hidden` attribute. editMode() unhides it; without re-hiding here it
  // stays painted over the freshly-rendered iframe, so toggling View
  // looked like a no-op even though the render happened underneath.
  editorPanel.hidden = true;

  if (!appMeta) {
    const meta = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'app/get-meta', appId }));
    if (!meta?.ok) { fail(meta?.error ?? 'unknown error'); return; }
    appMeta = { name: meta.name, entryFile: meta.entryFile, dweb: meta.dweb ?? null };
    attachDwebBridge(); // no-op unless this app is a dwapp on a dweb build
  }

  let files;
  try { files = await readAllFiles(); }
  catch (e) { fail(`couldn't read app files: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); return; }

  if (!(appMeta.entryFile in files)) {
    fail(`entry file ${appMeta.entryFile} not found in OPFS`);
    return;
  }

  // Make built-in libs (Mithril) available before composing.
  await withBuiltinLibs(files);

  let composed;
  try { composed = withNewTabLinks(stripMetaRefresh(composeApp(files, appMeta.entryFile))); }
  catch (e) { fail(`compose failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); return; }

  // Ensure the iframe is in the DOM (re-create on mode switch).
  if (!frame.isConnected) document.querySelector('.frame-host')?.appendChild(frame);
  frame.hidden = false;
  pendingBody = composed;

  if (runnerReady) {
    tryDeliver();
  } else {
    // Reload the runner so the runner-ready handshake fires fresh.
    runnerReady = false;
    expectingRunnerLoad = true;
    runnerStarted = true;
    frame.src = '/app-tab/runner.html';
    // Watchdog: if the runner never announces ready (threw / failed to load),
    // surface an error instead of sitting on the boot screen forever.
    if (runnerWatchdog) clearTimeout(runnerWatchdog);
    runnerWatchdog = setTimeout(() => {
      if (!runnerReady) fail('the app runner did not start — try reopening the app, or reload this tab.');
    }, 8000);
  }
};

window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
  if (e.source !== frame.contentWindow) return;
  if (e.data && e.data.type === 'runner-ready') {
    runnerReady = true;
    if (runnerWatchdog) { clearTimeout(runnerWatchdog); runnerWatchdog = null; }
    tryDeliver();
    // Re-attach the dweb bridge if it was torn down by an app-initiated frame
    // reload (e.g. a <form> submit). Safe: only OUR trusted runner posts
    // runner-ready, so a navigation to a foreign page never reaches here — the
    // bridge stays dead there. Idempotent (no-op when already attached / not a
    // dwapp). why: a dwapp that reloads itself shouldn't permanently lose the
    // network (the multiplayer game would just die mid-session).
    attachDwebBridge();
  }
});

// A frame load WE didn't initiate means the app navigated its own (sandboxed)
// frame elsewhere. The dweb bridge posts room events (other peers' messages and
// dids) to frame.contentWindow with targetOrigin '*' for the opaque sandbox, so
// rather than rely on origin matching we CUT delivery: stop the bridge so those
// events can't reach whatever now occupies the frame.
frame.addEventListener('load', () => {
  if (!runnerStarted) return;                 // the empty iframe's initial about:blank load — not an app navigation
  if (expectingRunnerLoad) { expectingRunnerLoad = false; return; }
  if (expectingBodyLoad) { expectingBodyLoad = false; return; }  // the runner's document.write delivery — not a navigation
  runnerReady = false;
  if (dwebBridge) { dwebBridge.dispose(); dwebBridge = null; }
  console.warn('[app-tab] app frame navigated unexpectedly — dweb bridge stopped');
});

// ---------------------------------------------------------------------------
// Dweb bridge — only for dwapps (apps carrying dweb metadata), only when
// the build has the module (loadDweb → stub elsewhere). The bridge itself
// lives behind the dweb boundary; this is just the hosting glue: the
// confirm bar (consent UI) + OPFS/SW accessors it needs injected.
// ---------------------------------------------------------------------------

// why any: the dweb bridge is created by the live (preview-only) dweb module,
// whose shape exceeds the stub interface — typed any at this hosting boundary.
/** @type {any} */
let dwebBridge = null;

// A minimal monochrome consent bar (no new accent colors — CLAUDE.md).
/** @param {{ appName: string, detail: string }} arg @returns {Promise<boolean>} */
const confirmAction = ({ appName, detail }) => new Promise((resolve) => {
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:50',
    'display:flex', 'gap:12px', 'align-items:center', 'justify-content:center',
    'padding:10px 16px', 'background:#111', 'color:#eee',
    'font:13px/1.4 -apple-system, system-ui, sans-serif',
    'border-bottom:1px solid #333',
  ].join(';');
  const text = document.createElement('span');
  text.textContent = `“${appName}” wants to ${detail}.`;
  /** @param {string} label @param {boolean} val @param {boolean} solid */
  const mkBtn = (label, val, solid) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:4px 14px;border:1px solid #555;border-radius:4px;cursor:pointer;background:${solid ? '#eee' : 'transparent'};color:${solid ? '#111' : '#eee'};font:inherit`;
    b.addEventListener('click', () => { bar.remove(); resolve(val); });
    return b;
  };
  bar.append(text, mkBtn('Allow', true, true), mkBtn('Deny', false, false));
  document.body.appendChild(bar);
});

const attachDwebBridge = async () => {
  if (dwebBridge || !appMeta?.dweb) return;
  try {
    const client = /** @type {any} */ (await loadDweb());
    if (!client.available || !client.createAppBridge) return;
    dwebBridge = client.createAppBridge({
      appId,
      appName: appMeta.name,
      appDweb: appMeta.dweb,
      entryFile: appMeta.entryFile,
      frame,
      client,
      swCall: (/** @type {string} */ type, /** @type {object} */ payload = {}) => browser.runtime.sendMessage({ type, ...payload }),
      storage: browser.storage.local,
      confirmAction,
      readAppFiles: readAllFiles,
      // The offscreen base host pushes room events (feed/dm/presence) as
      // `dweb/base-room/event` runtime messages — every extension context gets
      // them, so the bridge listens here and filters to the room it joined.
      onHostEvent: (/** @type {(msg: any) => void} */ handler) => {
        const fn = (/** @type {any} */ msg) => { if (msg?.type === 'dweb/base-room/event') handler(msg); };
        browser.runtime.onMessage.addListener(fn);
        return () => browser.runtime.onMessage.removeListener(fn);
      },
      launch: launchParams,
    });
  } catch (e) {
    console.warn('[app-tab] dweb bridge unavailable:', e);
  }
};

// ---------------------------------------------------------------------------
// Edit mode — mount the shared editor over the iframe
// ---------------------------------------------------------------------------

const editMode = async () => {
  mode = 'edit';
  document.body.classList.remove('mode-render');
  document.body.classList.add('mode-edit');
  toggleBtn.textContent = 'View ▶';
  frame.hidden = true;

  if (!appMeta) {
    const meta = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'app/get-meta', appId }));
    if (!meta?.ok) { fail(meta?.error ?? 'unknown error'); return; }
    appMeta = { name: meta.name, entryFile: meta.entryFile, dweb: meta.dweb ?? null };
    attachDwebBridge();
  }

  if (!editorApi) {
    editorApi = await createEditor({
      mountEl: editorMount,
      opfsBase: ['peerd-apps', appId],
      pinnedFile: appMeta.entryFile,
      onSaved: () => { /* swap back to render manually via toggle */ },
    });
  }
  editorPanel.hidden = false;
  editorApi.focus?.();
  boot.classList.add('is-hidden');
};

// ---------------------------------------------------------------------------
// Export — download this app as a .peerd file (DESIGN-10). The SW owns
// the format; this is flush (if editing) → fetch envelope → Blob+anchor.
// why button-text feedback: this page has no log surface in render
// mode, and the boot overlay is too heavy for a failed download.
// ---------------------------------------------------------------------------

const exportApp = async () => {
  exportBtn.disabled = true;
  try {
    if (editorApi) await editorApi.flushSave?.();
    const reply = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'export/artifact', kind: 'app', id: appId,
    }));
    if (!reply?.ok) throw new Error(reply?.error ?? 'export failed');
    const blob = new Blob([JSON.stringify(reply.envelope)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reply.filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[app-tab] export failed:', e);
    const prior = exportBtn.textContent;
    exportBtn.textContent = 'Export failed';
    setTimeout(() => { exportBtn.textContent = prior; }, 2500);
  } finally {
    exportBtn.disabled = false;
  }
};

exportBtn.addEventListener('click', exportApp);

// Closing the tab (or navigating away) must LEAVE the dwapp's room — otherwise
// the offscreen room ref never decrements and the base node keeps beaconing our
// presence as a ghost in a room whose tab is gone. pagehide fires on tab close
// and navigation; dispose() runs the bridge's leave op (a fire-and-forget swCall
// that still flushes to the SW before teardown).
window.addEventListener('pagehide', () => { dwebBridge?.dispose(); });

// ---------------------------------------------------------------------------
// Boot + toggle
// ---------------------------------------------------------------------------

toggleBtn.addEventListener('click', async () => {
  if (mode === 'render') {
    await editMode();
  } else {
    // When leaving edit mode, flush save + force a fresh render.
    if (editorApi) await editorApi.flushSave?.();
    runnerReady = false;          // force the runner to re-emit ready
    await renderMode();
  }
});

// Announce ready + start in render mode. Live-reload after agent
// edits flows via chrome.tabs.reload (in app-client.reloadTab); this
// page re-runs, refetches OPFS + recomposes. No extra message
// channel needed.
browser.runtime.sendMessage({ type: 'app/tab-ready', appId }).catch(() => {});

// A peerd-owned tab carries the trigger to pull the side panel in — so you can
// keep chatting from this App without a round-trip back to home.
mountPullInPeerd();

renderMode();
