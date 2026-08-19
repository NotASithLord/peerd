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
  stripMetaRefresh,
  createEditor,
  isBinaryAppFile,
  isBinaryAssetPath,
  opfsHelpers,
} from '/peerd-engine/index.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';
import { isServiceWorkerSender } from '/shared/messaging.js';

const appId = location.hash.slice(1).split(/[?&]/)[0];
const hashParams = new URLSearchParams(location.hash.slice(1).split('?')[1] ?? '');
// Launch params ride the hash past the appId (`#<id>?room=…&url=…`) —
// the dweb bridge hands them to the app at hello (deep-link into a room).
const launchParams = {
  room: hashParams.get('room') ?? undefined,
  url: hashParams.get('url') ?? undefined,
};
// Actor ownership is host metadata and is never delivered to App code.
const ownerSessionId = hashParams.get('owner') ?? undefined;
// why the cast: these IDs are static in index.html and present at load; a single
// non-null cast at the boundary keeps the call sites clean.
/** @param {string} id @returns {HTMLElement} */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const boot    = byId('boot');
const bootMsg = byId('boot-msg');
const actorRetry = /** @type {HTMLButtonElement} */ (byId('actor-retry'));
const frame   = /** @type {HTMLIFrameElement} */ (byId('app-frame'));
const editorPanel = byId('editor-panel');
const editorMount = byId('editor-mount');
const toggleBtn = byId('mode-toggle');
const exportBtn = /** @type {HTMLButtonElement} */ (byId('export-btn'));
const noticeStack = byId('app-notice-stack');
const saveStatus = byId('app-save-status');
const saveMessage = byId('app-save-message');
const saveRetry = /** @type {HTMLButtonElement} */ (byId('app-save-retry'));
const actorChatToggle = /** @type {HTMLButtonElement} */ (byId('actor-chat-toggle'));
const actorChatDrawer = byId('actor-chat-drawer');
const actorChatClose = /** @type {HTMLButtonElement} */ (byId('actor-chat-close'));
const actorChatName = byId('actor-chat-name');
const actorChatMessages = byId('actor-chat-messages');
const actorChatInput = /** @type {HTMLTextAreaElement} */ (byId('actor-chat-input'));
const actorChatSend = /** @type {HTMLButtonElement} */ (byId('actor-chat-send'));
const actorChatStatus = byId('actor-chat-status');

/** @param {string} msg @param {{retryActor?:boolean}} [options] */
const fail = (msg, { retryActor = false } = {}) => {
  boot.classList.remove('is-hidden');
  boot.classList.add('is-failed');
  bootMsg.textContent = `Failed: ${msg}`;
  actorRetry.hidden = !retryActor;
  actorRetry.disabled = false;
};

/** @type {HTMLElement | null} */
let noticeReturnFocus = null;

/** @param {string} text @param {{ persistent?: boolean }} [options] */
const showNotice = (text, { persistent = false } = {}) => {
  let notice = document.getElementById('app-security-notice');
  const noticeHadFocus = Boolean(notice?.contains(document.activeElement));
  if (!noticeHadFocus && document.activeElement instanceof HTMLElement) {
    noticeReturnFocus = document.activeElement;
  }
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'app-security-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'padding:9px 12px', 'border:1px solid #444', 'border-radius:6px',
      'background:#111', 'color:#eee', 'font:12px/1.4 -apple-system,system-ui,sans-serif',
    ].join(';');
    noticeStack.prepend(notice);
  }
  notice.replaceChildren();
  const message = document.createElement('span');
  message.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';
  message.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.style.cssText = 'border:1px solid #555;background:#111;color:#eee;border-radius:4px;padding:3px 7px;cursor:pointer';
  /** @param {boolean} restoreFocus */
  const dismiss = (restoreFocus) => {
    notice?.remove();
    if (restoreFocus && noticeReturnFocus?.isConnected) noticeReturnFocus.focus({ preventScroll: true });
  };
  close.addEventListener('click', () => dismiss(true));
  notice.append(message, close);
  if (noticeHadFocus) close.focus({ preventScroll: true });
  notice.onkeydown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss(true);
  };
  clearTimeout(Number(notice.dataset.timer || 0));
  const scheduleDismiss = () => {
    notice.dataset.timer = String(setTimeout(() => {
      if (notice?.contains(document.activeElement)) { scheduleDismiss(); return; }
      dismiss(false);
    }, 6000));
  };
  notice.dataset.timer = '';
  if (!persistent) scheduleDismiss();
};

let actorChatBusy = false;
/** @param {boolean} open */
const setActorChatOpen = (open) => {
  actorChatDrawer.hidden = !open;
  actorChatToggle.setAttribute('aria-expanded', String(open));
  if (open) actorChatInput.focus({ preventScroll: true });
};

/** @param {'user'|'actor'|'status'} role @param {string} text */
const appendActorChatMessage = (role, text) => {
  const message = document.createElement('div');
  message.className = 'actor-chat-message';
  message.dataset.role = role;
  // Actor output is data, never trusted markup from either the model or App.
  message.textContent = text;
  actorChatMessages.append(message);
  actorChatMessages.scrollTop = actorChatMessages.scrollHeight;
};

const sendActorChatMessage = async () => {
  const prompt = actorChatInput.value.trim();
  if (!prompt || actorChatBusy) return;
  actorChatBusy = true;
  actorChatSend.disabled = true;
  actorChatInput.disabled = true;
  actorChatStatus.textContent = 'Actor is working…';
  appendActorChatMessage('user', prompt);
  actorChatInput.value = '';
  try {
    const reply = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'app/actor-chat', appId, message: prompt,
    }));
    if (reply?.ok === true && typeof reply.content === 'string') {
      appendActorChatMessage('actor', reply.content);
    } else {
      appendActorChatMessage('status', String(reply?.error || 'The App actor did not reply.'));
    }
  } catch {
    appendActorChatMessage('status', 'The App actor connection was interrupted. Inspect the App before retrying an action.');
  } finally {
    actorChatBusy = false;
    actorChatSend.disabled = false;
    actorChatInput.disabled = false;
    actorChatStatus.textContent = 'Enter to send · Shift+Enter for a new line';
    actorChatInput.focus({ preventScroll: true });
  }
};

actorChatToggle.addEventListener('click', () => setActorChatOpen(Boolean(actorChatDrawer.hidden)));
actorChatClose.addEventListener('click', () => setActorChatOpen(false));
actorChatSend.addEventListener('click', sendActorChatMessage);
actorChatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendActorChatMessage();
});

if (!appId) {
  fail('No appId in URL hash.');
  throw new Error('No appId in URL hash');
}

const opfs = opfsHelpers(['peerd-apps', appId]);
/** @type {{ name: string, entryFile: string, fileKinds: Record<string, 'text' | 'binary'>, dweb: any, agent: { kind: string, name?: string, instructions?: string, runtime?: string[] } } | null} */
let appMeta = null;        // { name, entryFile }
/** @type {Awaited<ReturnType<typeof createEditor>> | null} */
let editorApi = null;
let mode = 'render';
const binaryFilePaths = new Set();

// Repository replacement must first drain the editor's debounced write. The
// SW requests this before taking the repository coordinator; taking the lock
// first would deadlock because flushSave itself writes through that lane.
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ message,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  if (!isServiceWorkerSender(sender)
      || message?.type !== 'app/quiesce'
      || message.appId !== appId) return false;
  if (message.action === 'release') {
    document.body.inert = false;
    sendResponse({ ok: true });
    return false;
  }
  if (message.action !== 'acquire') {
    sendResponse({ ok: false, error: 'invalid App quiesce action' });
    return false;
  }
  document.body.inert = true;
  Promise.resolve(editorApi?.flushSave?.()).then(
    () => sendResponse({ ok: true }),
    (error) => {
      document.body.inert = false;
      sendResponse({ ok: false, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
    },
  );
  return true;
}));
/** @type {HTMLElement | null} */
let saveReturnFocus = null;
/** @param {string} path */
const showSaveFailure = (path) => {
  if (saveStatus.hidden && document.activeElement instanceof HTMLElement) {
    saveReturnFocus = document.activeElement;
  }
  saveMessage.textContent = `Could not save ${path}. Your edits are still open. Reduce the file or free browser storage, then retry.`;
  saveStatus.hidden = false;
  saveRetry.disabled = false;
};
const clearSaveFailure = () => {
  const restoreFocus = saveStatus.contains(document.activeElement);
  saveStatus.hidden = true;
  saveRetry.disabled = false;
  if (restoreFocus) {
    if (saveReturnFocus?.isConnected) saveReturnFocus.focus({ preventScroll: true });
    else editorApi?.focus?.();
  }
  saveReturnFocus = null;
};
saveRetry.addEventListener('click', async () => {
  if (!editorApi) return;
  saveRetry.disabled = true;
  try {
    await editorApi.flushSave();
    if (!editorApi.hasUnsavedChanges()) clearSaveFailure();
  } catch { saveRetry.disabled = false; }
});
window.addEventListener('beforeunload', (event) => {
  if (!editorApi?.hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});
/** @param {unknown} value */
const copyFileKinds = (value) => Object.assign(
  Object.create(null),
  value && typeof value === 'object' ? value : {},
);

// ---------------------------------------------------------------------------
// Render mode — compose multi-file from OPFS, post to the runner iframe
// ---------------------------------------------------------------------------

const readForRender = async () => {
  const entries = await opfs.list();
  /** @type {Record<string, string>} */
  const textFiles = Object.create(null);
  /** @type {Record<string, ArrayBuffer>} */
  const binaryAssets = Object.create(null);
  binaryFilePaths.clear();
  for (const e of entries) {
    const path = e.path.replace(/^\/+/, '');
    const bytes = await opfs.readBytes(path);
    if (isBinaryAppFile(path, bytes, appMeta?.fileKinds?.[path])) {
      binaryFilePaths.add(path);
      binaryAssets[path] = bytes.buffer;
    } else {
      textFiles[path] = new TextDecoder().decode(bytes);
    }
  }
  return { textFiles, binaryAssets };
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

/** @type {'idle' | 'awaiting-ready' | 'ready' | 'delivered' | 'suspended' | 'poisoned'} */
let runnerPhase = 'idle';
// Watchdog timer for the runner-ready handshake — so a runner iframe that
// throws / never loads doesn't strand the app on the boot screen forever.
/** @type {ReturnType<typeof setTimeout> | null} */
let runnerWatchdog = null;
/** @type {string | null} */
let pendingBody = null;
/** @type {Record<string, ArrayBuffer>} */
let pendingAssets = {};
/** @type {MessagePort | null} */
let runnerPort = null;
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
let linkPromptOpen = false;
let runnerGeneration = 0;
let agentCallSequence = 0;
/** @type {Map<string, { resolve: (value: unknown) => void, timer: ReturnType<typeof setTimeout>, op: 'observe'|'act' }>} */
const agentCallPending = new Map();
const APP_AGENT_RESULT_MAX_CHARS = 100_000;

/** @param {string} reason */
const rejectAgentCalls = (reason) => {
  for (const pending of agentCallPending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: reason, outcomeKnown: false, outcomeKind: 'transport-lost' });
  }
  agentCallPending.clear();
};

// The service worker reaches the App's opt-in playtest API only through this
// exact tab. The sandbox remains opaque and offline: this relay grants no
// browser primitive, just request/reply with code already inside the App.
browser.runtime.onMessage.addListener((/** @type {any} */ message, /** @type {any} */ sender) => {
  if (!isServiceWorkerSender(sender)
      || message?.type !== 'app/agent-call'
      || message.appId !== appId) return false;
  if (mode !== 'render' || runnerPhase !== 'delivered' || !frame.contentWindow) {
    return Promise.resolve({ ok: false, error: 'app_runtime_not_ready', outcomeKnown: true, outcomeKind: 'pre-effect-failure' });
  }
  const op = message.op;
  if ((op !== 'observe' && op !== 'act')
      || (op === 'observe' && appMeta?.agent?.runtime?.includes('observe') !== true)
      || (op === 'act' && appMeta?.agent?.runtime?.includes('act') !== true)) {
    return Promise.resolve({ ok: false, error: 'app_runtime_operation_not_declared', outcomeKnown: true, outcomeKind: 'pre-effect-failure' });
  }
  const id = `${runnerGeneration}:${++agentCallSequence}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      agentCallPending.delete(id);
      recoverPoisonedRunner();
      resolve({ ok: false, error: 'app_runtime_call_timed_out_outcome_unknown', outcomeKnown: false, outcomeKind: 'transport-lost' });
    }, 12_000);
    agentCallPending.set(id, { resolve, timer, op });
    frame.contentWindow?.postMessage({
      peerd: 'app:agent:request', id, op, args: message.args ?? {},
    }, '*');
  });
});

const tryDeliver = () => {
  if (runnerPhase !== 'ready' || pendingBody == null) return;
  expectingBodyLoad = true;
  // why: sandbox flags are fixed for the active document. Removing script
  // permission here leaves the already-loaded trusted runner able to execute
  // the App, while every later data:, blob:, or URL navigation enters a realm
  // where scripts cannot run. startRunner restores the token only for a fresh
  // trusted runner load.
  frame.sandbox.remove('allow-scripts');
  runnerPort?.postMessage(
    {
      type: 'app-body',
      html: pendingBody,
      assets: pendingAssets,
      entry: appMeta?.entryFile,
      agentRuntime: {
        observe: appMeta?.agent?.runtime?.includes('observe') === true,
        act: appMeta?.agent?.runtime?.includes('act') === true,
      },
    },
    Object.values(pendingAssets),
  );
  // Transfer detaches these parent-side buffers. Clear the queue immediately;
  // every later delivery re-reads OPFS and gets fresh ownership.
  pendingBody = null;
  pendingAssets = {};
  runnerPhase = 'delivered';
  if (appMeta?.name) document.title = `peerd · ${appMeta.name}`;
  boot.classList.add('is-hidden');
};

const startRunner = () => {
  rejectAgentCalls('app_runtime_restarted');
  runnerPort?.close();
  runnerPort = null;
  runnerPhase = 'awaiting-ready';
  expectingRunnerLoad = true;
  runnerStarted = true;
  runnerGeneration += 1;
  frame.sandbox.add('allow-scripts');
  frame.src = `/engine-tabs/app-tab/runner.html#${runnerGeneration}`;
  if (runnerWatchdog) clearTimeout(runnerWatchdog);
  runnerWatchdog = setTimeout(() => {
    if (runnerPhase === 'awaiting-ready') {
      fail('the app runner did not start. Try reopening the app or reload this tab.');
    }
  }, 8000);
};

/** Stop the current App document before the editor becomes interactive. */
const suspendRunnerForEdit = () => {
  rejectAgentCalls('app_runtime_suspended_for_editing');
  if (runnerWatchdog) { clearTimeout(runnerWatchdog); runnerWatchdog = null; }
  runnerPort?.close();
  runnerPort = null;
  pendingBody = null;
  pendingAssets = {};
  runnerPhase = 'suspended';
  runnerStarted = false;
  expectingRunnerLoad = false;
  expectingBodyLoad = false;
  if (dwebBridge) { dwebBridge.dispose(); dwebBridge = null; }
  // Replacing the document is the only way to stop a late async handler from
  // the prior generation; hiding the iframe would leave it running.
  frame.src = 'about:blank';
};

let poisonRecoveryScheduled = false;
const recoverPoisonedRunner = () => {
  if (poisonRecoveryScheduled) return;
  poisonRecoveryScheduled = true;
  runnerPhase = 'poisoned';
  rejectAgentCalls('app_runtime_generation_poisoned');
  setTimeout(() => {
    poisonRecoveryScheduled = false;
    if (mode !== 'render') return;
    appMeta = null;
    runnerPhase = 'idle';
    renderMode().catch((error) => fail(
      /** @type {{message?:string}} */ (error)?.message ?? String(error),
    ));
  }, 0);
};

const initializeRunnerChannel = () => {
  const channel = new MessageChannel();
  runnerPort = channel.port1;
  runnerPort.addEventListener('message', (event) => {
    if (runnerPhase !== 'awaiting-ready') return;
    if (event.data?.type === 'runner-failed') {
      fail('The browser could not enforce the App sandbox.');
      return;
    }
    if (event.data?.type !== 'runner-ready') return;
    runnerPhase = 'ready';
    if (runnerWatchdog) { clearTimeout(runnerWatchdog); runnerWatchdog = null; }
    tryDeliver();
    attachDwebBridge();
  });
  runnerPort.start();
  frame.contentWindow?.postMessage({ type: 'runner-init' }, '*', [channel.port2]);
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

  // Always refetch on entry. Edit mode can change peerd.json and a dweb update
  // can replace the package while this tab remains alive.
  const meta = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'app/get-meta', appId }));
  if (!meta?.ok) { fail(meta?.error ?? 'unknown error'); return; }
  appMeta = {
    name: meta.name,
    entryFile: meta.entryFile,
    fileKinds: copyFileKinds(meta.fileKinds),
    dweb: meta.dweb ?? null,
    agent: meta.agent ?? { kind: 'bound-app' },
  };
  actorChatName.textContent = appMeta.agent?.name || `${appMeta.name || 'App'} actor`;
  attachDwebBridge(); // no-op unless this app is a dwapp on a dweb build

  let textFiles, binaryAssets;
  try { ({ textFiles, binaryAssets } = await readForRender()); }
  catch (e) { fail(`couldn't read app files: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); return; }

  if (!(appMeta.entryFile in textFiles)) {
    fail(`entry file ${appMeta.entryFile} not found in OPFS`);
    return;
  }

  // Make built-in libs (Mithril) available before composing.
  await withBuiltinLibs(textFiles);

  let composed;
  try { composed = stripMetaRefresh(composeApp(textFiles, appMeta.entryFile)); }
  catch (e) { fail(`compose failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); return; }

  // Ensure the iframe is in the DOM (re-create on mode switch).
  if (!frame.isConnected) document.querySelector('.frame-host')?.appendChild(frame);
  frame.hidden = false;
  pendingBody = composed;
  pendingAssets = binaryAssets;

  if (runnerPhase === 'ready') {
    tryDeliver();
  } else if (runnerPhase !== 'awaiting-ready') startRunner();
};

// The trusted embedding page owns frame-src, so it sees blocked attempts to
// replace the runner. Keep the notice URL-free: App input must not reach a
// trusted UI surface without normalization.
window.addEventListener('securitypolicyviolation', (event) => {
  if (!String(event.effectiveDirective).startsWith('frame-src')) return;
  showNotice('Blocked navigation: Apps stay inside their offline sandbox.');
});

window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
  if (e.source !== frame.contentWindow) return;
  if (e.data?.peerd === 'app:agent:open' && runnerPhase === 'delivered') {
    setActorChatOpen(true);
    return;
  }
  if (e.data?.peerd === 'app:agent:result') {
    const pending = agentCallPending.get(e.data.id);
    if (!pending) return;
    agentCallPending.delete(e.data.id);
    clearTimeout(pending.timer);
    if (e.data.ok !== true) {
      // Only this trusted host's checks above can prove an act was refused
      // before dispatch. Once posted into the App document, a handler may
      // mutate and then throw (or forge an unclassified failure), so every
      // rejected act has unknown outcome and retires this document generation.
      const postDispatchActFailure = pending.op === 'act';
      const outcomeUnknown = postDispatchActFailure
        || e.data.outcomeKnown === false
        || e.data.poisoned === true;
      pending.resolve({
        ok: false,
        error: String(e.data.error || 'app_runtime_operation_failed').slice(0, 1_000),
        ...(outcomeUnknown
          ? { outcomeKnown: false, outcomeKind: 'transport-lost' }
          : { outcomeKnown: true, outcomeKind: 'pre-effect-failure' }),
      });
      if (outcomeUnknown) recoverPoisonedRunner();
      return;
    }
    try {
      const value = e.data.value ?? null;
      const encoded = JSON.stringify(value);
      if (typeof encoded !== 'string' || encoded.length > APP_AGENT_RESULT_MAX_CHARS) {
        pending.resolve({
          ok: false,
          error: 'app_runtime_result_too_large',
          ...(pending.op === 'act'
            ? { outcomeKnown: false, outcomeKind: 'transport-lost' }
            : { outcomeKnown: true, outcomeKind: 'pre-effect-failure' }),
        });
        if (pending.op === 'act') recoverPoisonedRunner();
      } else pending.resolve({ ok: true, value });
    } catch {
      pending.resolve({
        ok: false,
        error: 'app_runtime_result_not_serializable',
        ...(pending.op === 'act'
          ? { outcomeKnown: false, outcomeKind: 'transport-lost' }
          : { outcomeKnown: true, outcomeKind: 'pre-effect-failure' }),
      });
      if (pending.op === 'act') recoverPoisonedRunner();
    }
    return;
  }
  if (e.data?.type === 'app-policy-blocked' && runnerPhase === 'delivered') {
    const directive = typeof e.data.directive === 'string'
      ? e.data.directive.replace(/[^a-z-]/gi, '').slice(0, 40)
      : 'resource';
    showNotice(`Blocked ${directive || 'resource'}: Apps are offline. Bundle dependencies and assets.`);
    return;
  }
  if (e.data?.type === 'app-link' && runnerPhase === 'delivered') {
    if (linkPromptOpen) { showNotice('Finish the open-link prompt first.'); return; }
    let target;
    try { target = new URL(String(e.data.href)); }
    catch { showNotice('That link is unavailable inside this offline App.'); return; }
    if (!['http:', 'https:'].includes(target.protocol)) {
      showNotice('Only confirmed HTTP(S) links can leave an App.');
      return;
    }
    const safeTarget = new URL(target.href);
    safeTarget.username = '';
    safeTarget.password = '';
    const remainder = `${safeTarget.pathname}${safeTarget.search}${safeTarget.hash}`;
    const shownRemainder = remainder.length > 120 ? `${remainder.slice(0, 117)}…` : remainder;
    const shown = `${safeTarget.origin}${shownRemainder}`;
    linkPromptOpen = true;
    confirmAction({ appName: appMeta?.name ?? 'This App', detail: `open this external link: ${shown}`, approveLabel: 'Open link' })
      .then((allowed) => {
        if (allowed) return browser.tabs.create({ url: safeTarget.href });
        return undefined;
      })
      .catch(() => showNotice('The external link could not be opened.'))
      .finally(() => { linkPromptOpen = false; });
  }
});

// A frame load WE didn't initiate means the app navigated its own (sandboxed)
// frame elsewhere. The dweb bridge posts room events (other peers' messages and
// dids) to frame.contentWindow with targetOrigin '*' for the opaque sandbox, so
// rather than rely on origin matching we CUT delivery: stop the bridge so those
// events can't reach whatever now occupies the frame.
frame.addEventListener('load', () => {
  if (!runnerStarted) return;                 // the empty iframe's initial about:blank load — not an app navigation
  if (expectingRunnerLoad) {
    expectingRunnerLoad = false;
    initializeRunnerChannel();
    return;
  }
  if (expectingBodyLoad) { expectingBodyLoad = false; return; }  // the runner's document.write delivery — not a navigation
  runnerPhase = 'idle';
  if (dwebBridge) { dwebBridge.dispose(); dwebBridge = null; }
  console.warn('[app-tab] app frame navigated unexpectedly; restarting the trusted runner');
  startRunner();
  renderMode().catch((e) => fail(/** @type {{ message?: string }} */ (e)?.message ?? String(e)));
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

// A minimal monochrome consent bar follows the project color rule.
let confirmationTail = Promise.resolve();

/** @param {{ appName: string, detail: string, kind?: string, approveLabel?: string }} arg @returns {Promise<boolean>} */
const showConfirmation = ({ appName, detail, kind, approveLabel }) => new Promise((resolve) => {
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alertdialog');
  bar.setAttribute('aria-modal', 'true');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:50',
    'display:flex', 'gap:12px', 'align-items:center', 'justify-content:center',
    'padding:10px 16px', 'background:#111', 'color:#eee',
    'font:13px/1.4 -apple-system, system-ui, sans-serif',
    'border-bottom:1px solid #333',
  ].join(';');
  const text = document.createElement('span');
  text.id = `app-confirm-${Date.now()}`;
  bar.setAttribute('aria-labelledby', text.id);
  text.textContent = `“${appName}” wants to ${detail}.`;
  /** @param {string} label @param {boolean} val @param {boolean} solid */
  const mkBtn = (label, val, solid) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `min-height:44px;padding:8px 16px;border:1px solid #555;border-radius:4px;cursor:pointer;background:${solid ? '#eee' : 'transparent'};color:${solid ? '#111' : '#eee'};font:inherit`;
    b.addEventListener('click', () => { bar.remove(); priorFocus?.focus(); resolve(val); });
    return b;
  };
  const actionLabel = approveLabel ?? (kind === 'join' ? 'Join room' : kind === 'install' ? 'Install app' : 'Allow');
  const allow = mkBtn(actionLabel, true, true);
  const deny = mkBtn('Deny', false, false);
  bar.append(text, allow, deny);
  document.body.appendChild(bar);
  deny.focus();
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); deny.click(); return; }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === allow) { event.preventDefault(); deny.focus(); }
    else if (!event.shiftKey && document.activeElement === deny) { event.preventDefault(); allow.focus(); }
  });
});

/** Serialize every trusted-parent consent surface so App prompts cannot overlap.
 * @param {{ appName: string, detail: string, kind?: string, approveLabel?: string }} args */
const confirmAction = (args) => {
  const result = confirmationTail.then(() => showConfirmation(args));
  confirmationTail = result.then(() => undefined, () => undefined);
  return result;
};

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
  suspendRunnerForEdit();
  document.body.classList.remove('mode-render');
  document.body.classList.add('mode-edit');
  toggleBtn.textContent = 'View ▶';
  frame.hidden = true;

  if (!appMeta) {
    const meta = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'app/get-meta', appId }));
    if (!meta?.ok) { fail(meta?.error ?? 'unknown error'); return; }
    appMeta = {
      name: meta.name,
      entryFile: meta.entryFile,
      fileKinds: copyFileKinds(meta.fileKinds),
      dweb: meta.dweb ?? null,
      agent: meta.agent ?? { kind: 'bound-app' },
    };
    actorChatName.textContent = appMeta.agent?.name || `${appMeta.name || 'App'} actor`;
    attachDwebBridge();
  }

  if (!editorApi) {
    // Refresh classification from bytes before the editor renders its tree.
    // Unknown suffixes are safe because the read boundary, not the name,
    // decides whether CodeMirror may open them.
    await readForRender();
    editorApi = await createEditor({
      mountEl: editorMount,
      opfsBase: ['peerd-apps', appId],
      pinnedFile: appMeta.entryFile,
      isReadOnlyFile: (path) => binaryFilePaths.has(path) || isBinaryAssetPath(path),
      onReadOnlyFile: (path) => showNotice(
        `${path} is a binary file and cannot be edited here. Ask peerd to replace it, or import another App package.`,
        { persistent: true },
      ),
      writeFile: async (path, content) => {
        const reply = /** @type {any} */ (await browser.runtime.sendMessage({
          type: 'app/editor-write', appId, path, content,
        }));
        if (!reply?.ok) throw new Error(reply?.error ?? 'write failed');
        binaryFilePaths.delete(path);
        if (appMeta) appMeta.fileKinds[path] = 'text';
      },
      deleteFile: async (path) => {
        const reply = /** @type {any} */ (await browser.runtime.sendMessage({
          type: 'app/editor-delete', appId, path,
        }));
        if (!reply?.ok) throw new Error(reply?.error ?? 'delete failed');
        binaryFilePaths.delete(path);
        if (appMeta) delete appMeta.fileKinds[path];
      },
      onSaveError: showSaveFailure,
      onDirtyChange: (dirty) => { if (!dirty) clearSaveFailure(); },
      onSaved: () => {
        if (!editorApi?.hasUnsavedChanges()) clearSaveFailure();
      },
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
const flushEditorBeforeSuspension = () => {
  editorApi?.flushSave?.().catch((error) => {
    console.warn('[app-tab] final editor save failed:', error);
  });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushEditorBeforeSuspension();
});
window.addEventListener('pagehide', () => {
  flushEditorBeforeSuspension();
  rejectAgentCalls('app_runtime_closed');
  runnerPort?.close();
  dwebBridge?.dispose();
});

// ---------------------------------------------------------------------------
// Boot + toggle
// ---------------------------------------------------------------------------

/** @param {'app/tab-ready'|'app/actor-retry'} type */
const attachRequiredActor = async (type) => /** @type {Promise<any>} */ (
  browser.runtime.sendMessage({ type, appId, ownerSessionId })
    .catch(() => ({
      ok: false,
      error: type === 'app/tab-ready'
        ? 'The App isolation check did not respond.'
        : 'The actor retry did not respond.',
      actorRequired: type === 'app/actor-retry',
      retryable: type === 'app/actor-retry',
    }))
);

toggleBtn.addEventListener('click', async () => {
  try {
    if (mode === 'render') {
      await editMode();
    } else {
      // When leaving edit mode, flush save + force a fresh render.
      if (editorApi) await editorApi.flushSave?.();
      const attachment = await attachRequiredActor('app/actor-retry');
      if (!attachment?.ok) {
        fail(attachment?.error ?? 'The required App actor is unavailable.', { retryActor: true });
        return;
      }
      appMeta = null;
      runnerPhase = 'idle';          // force the runner to re-emit ready
      await renderMode();
    }
  } catch (error) {
    console.warn('[app-tab] mode switch failed:', error);
  }
});

// Arm the network floor, announce ready, then start in render mode. Live-reload after agent
// edits flows via chrome.tabs.reload (in app-client.reloadTab); this
// page re-runs, refetches OPFS + recomposes. No extra message
// channel needed.
const isolation = /** @type {{ ok?: boolean, error?: string, actorRequired?: boolean, retryable?: boolean }} */ (
  await attachRequiredActor('app/tab-ready')
);

// A peerd-owned tab carries the trigger to pull the side panel in — so you can
// keep chatting from this App without a round-trip back to home.
mountPullInPeerd();

if (!isolation?.ok) {
  fail(isolation?.error ?? 'This browser cannot enforce App isolation.', {
    retryActor: isolation?.actorRequired === true && isolation?.retryable === true,
  });
} else {
  renderMode();
}

actorRetry.addEventListener('click', async () => {
  actorRetry.disabled = true;
  boot.classList.remove('is-failed');
  bootMsg.textContent = 'Attaching the required App actor…';
  const reply = await attachRequiredActor('app/actor-retry');
  if (!reply?.ok) {
    fail(reply?.error ?? 'The required App actor is unavailable.', { retryActor: true });
    return;
  }
  actorRetry.hidden = true;
  boot.classList.remove('is-failed');
  renderMode().catch((error) => fail(
    /** @type {{message?:string}} */ (error)?.message ?? String(error),
    { retryActor: true },
  ));
});
