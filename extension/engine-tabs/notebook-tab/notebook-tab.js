// @ts-check
// notebook-tab — host page for one Notebook.
//
// Most of the heavy lifting lives in peerd-engine:
//   - createEditor()  — CodeMirror + file tree + OPFS, mounted into
//                       #editor-host
//   - buildEntry()    - static import/re-export resolver
//
// This file is the per-page glue: spawn a worker per eval, route
// shimmed fetch + OPFS calls back through the host, mirror agent
// js_notebook into the editor's notebook.js, post the result back to the SW.

import browser from '/shared/browser-api.js';
import {
  createEditor, isRemoteSpecifier, makeFetchRemote,
  moduleImportPolicyMessage, MODULE_SYNTAX_ERROR_CODE,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  remoteModuleCapabilityBlockedMessage,
  UnsupportedNativeModuleImportError,
} from '/peerd-engine/index.js';
import { renderReturnValue } from './output-render.js';
// The sealed worker source (realm seal + peerd.* surface + bridges) is shared
// with the headless offscreen job runner so the security surface can't diverge.
import {
  buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS, SEAL_MODULE_URL,
} from './worker-source.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';
import { isServiceWorkerSender } from '/shared/messaging.js';
import {
  NOTEBOOK_MODULE_LOADER, REMOTE_MODULE_IMPORTS_ENABLED,
} from '/shared/channel-config.js';

const notebookId = location.hash.slice(1).split(/[?&]/)[0];
if (!notebookId) {
  document.body.innerHTML = '<p style="padding:40px;color:#c43030;font-family:sans-serif">No notebookId in URL hash.</p>';
  throw new Error('No notebookId in URL hash');
}

const NOTEBOOK_PATH = 'notebook.js';
const BEFORE_AGENT_PATH = 'notebook.before-agent.js';
const HIDDEN_FILES = new Set([BEFORE_AGENT_PATH]);

// A peerd-owned tab carries the trigger to pull the side panel in — so you can
// keep chatting from this Notebook without a round-trip back to home. Mounted
// at load so it's present during boot and on any init failure.
mountPullInPeerd();

// ---------------------------------------------------------------------------
// DOM glue
// ---------------------------------------------------------------------------

// why the cast: getElementById is `Element | null`, but these IDs are static in
// index.html and present at load. A single non-null cast at the boundary keeps
// the call sites clean; a missing element would throw on first use either way.
/** @param {string} id @returns {HTMLElement} */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const els = {
  boot:       byId('notebook-boot'),
  app:        byId('notebook-app'),
  output:     byId('console-output'),
  outputPane: byId('output-pane'),
  runBtn:     /** @type {HTMLButtonElement} */ (byId('run-btn')),
  exportBtn:  /** @type {HTMLButtonElement} */ (byId('export-btn')),
  idChip:     byId('notebook-id-chip'),
  saveStatus: byId('save-status'),
  runStatus:  byId('run-status'),
  workerHost: /** @type {HTMLIFrameElement} */ (byId('worker-host')),
};

els.idChip.textContent = notebookId;
document.title = `peerd · notebook ${notebookId} — booting…`;
/** @param {string} status */
const setTitleStatus = (status) =>
  document.title = status
    ? `peerd · notebook ${notebookId} — ${status}`
    : `peerd · notebook ${notebookId}`;

/** @param {string} cls @param {string} text */
const appendLine = (cls, text) => {
  const line = document.createElement('span');
  line.className = `log-line ${cls}`;
  line.textContent = `${text}\n`;
  els.output.appendChild(line);
  els.outputPane.scrollTop = els.outputPane.scrollHeight;
};

const showApp = () => { els.boot.hidden = true; els.app.hidden = false; };

// The OPFS schema posture is owned by the service worker. Check it at the
// host mutation boundary so editor actions, tab RPCs, and sealed-worker
// relays all share one live decision. Reads never call this route.
const assertOpfsWritable = async () => {
  const response = /** @type {any} */ (await browser.runtime.sendMessage({
    type: 'lifecycle/assert-opfs-writable',
  }));
  if (response?.ok === true) return;
  throw new Error(response?.error
    ?? 'Notebook files are read-only because their storage format cannot be updated safely. No data was changed.');
};

/** @param {string} text @param {boolean} busy */
const setRunStatus = (text, busy) => {
  els.outputPane.setAttribute('aria-busy', String(busy));
  els.runStatus.textContent = text;
};

/** @param {'dirty' | 'saving' | 'saved'} state */
const setSaveStatus = (state) => {
  if (!els.saveStatus) return;
  if (state === 'dirty') {
    els.saveStatus.textContent = 'unsaved…';
    els.saveStatus.classList.add('is-dirty');
  } else if (state === 'saving') {
    els.saveStatus.textContent = 'saving…';
    els.saveStatus.classList.remove('is-dirty');
  } else {
    els.saveStatus.textContent = 'saved';
    els.saveStatus.classList.remove('is-dirty');
  }
};

// ---------------------------------------------------------------------------
// Editor (peerd-engine/editor) — mounted at boot, held here so the
// js/eval handler can mirror agent code into notebook.js and refresh
// the tree after each run.
// ---------------------------------------------------------------------------

// why typed non-null (initialized via a cast): the editor is created in the
// kickoff IIFE before any handler that touches it can run, so every use site
// sees a live editor. Typing it `| null` would force a guard on dozens of
// guaranteed-present accesses with no runtime benefit.
/** @type {Awaited<ReturnType<typeof createEditor>>} */
let editor = /** @type {any} */ (null);

// ---------------------------------------------------------------------------
// Module resolver glue — uses editor.opfs.read for OPFS access; emits
// resolve events to the transcript.
// ---------------------------------------------------------------------------

/** @type {Map<string, { blobUrl: string, source: string }>} */
let entryCache = new Map();

const clearModuleCache = () => {
  for (const entry of entryCache.values()) {
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
  entryCache = new Map();
};

/** @param {AbortSignal | undefined} signal */
const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  const deadline = signal.reason === 'deadline';
  const error = new Error(deadline ? 'Notebook run timed out' : 'Notebook run stopped');
  error.name = deadline ? 'TimeoutError' : 'AbortError';
  throw error;
};

/** @param {() => void} [onRemoteFetch] @param {AbortSignal} [signal] @param {number} [deadlineAt] */
const makeResolverDeps = (onRemoteFetch, signal, deadlineAt) => ({
  /** @param {string} path */
  readFile: async (path) => {
    throwIfAborted(signal);
    const source = await editor.opfs.read(path);
    throwIfAborted(signal);
    return source;
  },
  /** @param {string} source */
  makeBlobUrl: (source) => URL.createObjectURL(
    new Blob([source], { type: 'application/javascript' }),
  ),
  // Package policy and egress are separate grants. Store never receives the
  // fetch function, and the resolver also checks the false policy literal
  // before requesting module source on the static graph path.
  remoteModulesEnabled: REMOTE_MODULE_IMPORTS_ENABLED,
  ...(REMOTE_MODULE_IMPORTS_ENABLED ? {
    fetchRemote: makeFetchRemote(
      async (req) => {
        throwIfAborted(signal);
        onRemoteFetch?.();
        const abortToken = crypto.randomUUID();
        const onAbort = () => browser.runtime.sendMessage({
          type: 'sw/web-fetch-abort', abortToken, notebookId,
        }).catch(() => {});
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const response = await browser.runtime.sendMessage({
            type: 'sw/web-fetch', ...req, abortToken, notebookId, deadlineAt,
          });
          throwIfAborted(signal);
          return /** @type {any} */ (response);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      }),
  } : {}),
  /** @param {{ type: string, path: string, blobUrl?: string, error?: string, errorCode?: string }} entry */
  log: (entry) => {
    if (signal?.aborted) return;
    const label = isRemoteSpecifier(entry.path) ? entry.path : `./${entry.path}`;
    if (entry.type === 'resolved') {
      appendLine('log-info', `[import] ${label}`);
    } else if (entry.type === 'resolve-failed'
      && !moduleImportPolicyMessage(entry.errorCode)) {
      appendLine('log-error', `[import] FAILED ${label}: ${entry.error}`);
    }
  },
  // peerd:std for entry and nested static imports.
  builtins: NOTEBOOK_BUILTINS,
});

// ---------------------------------------------------------------------------
// Per-eval worker spawn. buildWorkerSource (the sealed realm + peerd.* surface)
// lives in worker-source.js, shared with the headless offscreen job runner.
//
// why FRESH worker per run (DO NOT CHANGE — DECISIONS #24): every run spawns a
// new sealed worker and terminates it. There is NO persistent/"warm" kernel and
// no state carried between runs — by design. That makes a run's output a pure
// function of the code + the files on disk, so a Notebook is REPRODUCIBLE by
// construction (no hidden kernel state, no out-of-order-execution gremlins —
// Jupyter's classic failure mode). If durable state is needed across runs it
// goes in OPFS (peerd.self.writeFile/readFile), never a module global. Resist
// "add a kernel for speed": the answer is to persist the expensive result to a
// file, not to keep RAM warm.
// ---------------------------------------------------------------------------

// Dim everything already in the output pane when a NEW run starts: the pane is
// a transcript, so the previous run's output stays visible (a loop feel even
// though every realm is fresh) while the current run's output reads bright.
const dimPreviousOutput = () => {
  for (const child of els.output.children) child.classList.add('nb-prev');
};

let hostedWorkerSequence = 0;
const workerHostPort = new Promise((resolve, reject) => {
  const channel = new MessageChannel();
  const timer = setTimeout(() => reject(new Error('Notebook worker host did not start')), 10_000);
  channel.port1.addEventListener('message', (event) => {
    if (event.data?.type !== 'notebook-worker-host-ready') return;
    clearTimeout(timer);
    resolve(channel.port1);
  });
  channel.port1.start();
  els.workerHost.addEventListener('load', () => {
    els.workerHost.contentWindow?.postMessage(
      { type: 'notebook-worker-host-init' }, '*', [channel.port2],
    );
  }, { once: true });
  els.workerHost.src = 'worker-host.html';
});

/** @param {string} source @param {string} markerNonce */
const spawnHostedWorker = async (source, markerNonce) => {
  const port = /** @type {MessagePort} */ (await workerHostPort);
  const runId = `run-${hostedWorkerSequence += 1}`;
  /** @type {Record<'message' | 'error', Array<{ listener: (event: any) => void, once: boolean }>>} */
  const listeners = { message: [], error: [] };
  let active = true;
  /** @param {MessageEvent} event */
  const onHostMessage = (event) => {
    const message = event.data;
    if (!active || message?.type !== 'worker-event' || message.runId !== runId) return;
    const eventType = /** @type {'message' | 'error'} */ (message.eventType);
    const payload = eventType === 'message'
      ? { data: message.data, workerUrl: message.workerUrl }
      : {
          error: null, message: message.message, filename: message.filename,
          lineno: message.lineno, colno: message.colno, workerUrl: message.workerUrl,
        };
    for (const entry of [...listeners[eventType]]) {
      entry.listener(payload);
      if (entry.once) listeners[eventType] = listeners[eventType].filter((item) => item !== entry);
    }
  };
  port.addEventListener('message', onHostMessage);
  port.postMessage({ type: 'run', runId, source, markerNonce });
  return {
    /** @param {'message' | 'error'} type @param {(event: any) => void} listener @param {{ once?: boolean }} [options] */
    addEventListener: (type, listener, options) => {
      listeners[type].push({ listener, once: options?.once === true });
    },
    /** @param {any} data */
    postMessage: (data) => port.postMessage({ type: 'message', runId, data }),
    terminate: () => {
      if (!active) return;
      active = false;
      port.removeEventListener('message', onHostMessage);
      port.postMessage({ type: 'terminate', runId });
    },
  };
};

/**
 * @param {string} source
 * @param {Map<string, { blobUrl: string, source: string }>} cache
 * @param {AbortSignal | undefined} signal
 * @param {number} deadlineAt
 * @param {number} entryBodyLine
 */
const linkWorkerSource = (source, cache, signal, deadlineAt, entryBodyLine) => new Promise((resolve, reject) => {
  const compiler = new Worker(new URL('linker-worker.js', import.meta.url), { type: 'module' });
  let settled = false;
  /** @param {(value: any) => void} callback @param {any} value */
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    compiler.terminate();
    callback(value);
  };
  const onAbort = () => {
    const deadline = signal?.reason === 'deadline';
    const error = new Error(deadline ? 'Notebook module linking timed out' : 'Notebook run stopped');
    error.name = deadline ? 'TimeoutError' : 'AbortError';
    finish(reject, error);
  };
  const remaining = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => finish(
    reject, new Error('Notebook module linking timed out'),
  ), remaining);
  compiler.addEventListener('message', (event) => {
    if (event.data?.type === 'linked') finish(resolve, {
      source: String(event.data.source), markerNonce: String(event.data.markerNonce),
    });
    else if (event.data?.type === 'link-failed') {
      const error = new Error(String(event.data.error || 'Notebook module linking failed'));
      // @ts-ignore stable code is copied from the isolated compiler realm.
      error.code = event.data.errorCode;
      finish(reject, error);
    }
  });
  compiler.addEventListener('error', (event) => finish(
    reject, new Error(event.message || 'Notebook module compiler crashed'),
  ));
  if (signal?.aborted) onAbort();
  else {
    signal?.addEventListener('abort', onAbort, { once: true });
    compiler.postMessage({
      type: 'link', source, cache: [...cache],
      packagedEntryUrls: [SEAL_MODULE_URL, ...Object.values(NOTEBOOK_BUILTINS)],
      entryBodyLine,
    });
  }
});

const stoppedResult = () => ({
  value: undefined, consoleOutput: [], durationMs: 0,
  errorCode: 'notebook_run_stopped', stopped: true, usedRemoteModules: false,
});

/** @param {number} timeoutMs @param {boolean} [usedRemoteModules] */
const timedOutResult = (timeoutMs, usedRemoteModules = false) => ({
  value: undefined, consoleOutput: [], durationMs: 0,
  error: `eval timed out after ${timeoutMs}ms`, errorCode: 'notebook_run_timeout',
  usedRemoteModules,
});

/** @param {string} code @param {number} [timeoutMs] @param {string} [entryPath] @param {AbortSignal} [signal] */
const runEvalInternal = async (code, timeoutMs = 30000, entryPath = NOTEBOOK_PATH, signal) => {
  dimPreviousOutput();
  setRunStatus('Running notebook.', true);
  const deadlineAt = Date.now() + timeoutMs;
  let source;
  let bodyLine = 1;
  let usedRemoteModules = false;
  let markerNonce = '';
  /** @type {ReturnType<typeof buildWorkerSource> | undefined} */
  let pendingBuild;
  try {
    // The run deadline covers RESOLUTION too — a remote import graph hits the
    // network (fetchRemote), so a tarpit CDN must not hang the eval forever
    // (the worker timer below only starts after the build).
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let buildTimer;
    /** @type {(() => void) | undefined} */
    let onBuildAbort;
    const abortBuild = new Promise((_resolve, reject) => {
      if (!signal) return;
      onBuildAbort = () => {
        const deadline = signal?.reason === 'deadline';
        const error = new Error(deadline ? 'Notebook import resolution timed out' : 'Notebook run stopped');
        error.name = deadline ? 'TimeoutError' : 'AbortError';
        reject(error);
      };
      if (signal.aborted) onBuildAbort();
      else signal.addEventListener('abort', onBuildAbort, { once: true });
    });
    setRunStatus('Resolving notebook imports.', true);
    pendingBuild = buildWorkerSource(code, {
        entryPath, notebookId,
        resolverDeps: makeResolverDeps(
          () => { usedRemoteModules = true; }, signal, deadlineAt,
        ),
      });
    const built = await Promise.race([
      pendingBuild,
      /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
        buildTimer = setTimeout(
          () => reject(new Error(`import resolution timed out after ${timeoutMs}ms`)),
          Math.max(0, deadlineAt - Date.now()));
      })),
      abortBuild,
    ]).finally(() => {
      clearTimeout(buildTimer);
      if (onBuildAbort) signal?.removeEventListener('abort', onBuildAbort);
    });
    source = built.source;
    bodyLine = built.bodyLine;
    entryCache = built.cache;
    usedRemoteModules ||= built.usedRemoteModules;
    if (/** @type {string} */ (NOTEBOOK_MODULE_LOADER) === 'single-bundle') {
      setRunStatus('Linking notebook imports.', true);
      const linked = /** @type {{ source: string, markerNonce: string }} */ (await linkWorkerSource(
        source, entryCache, signal, deadlineAt, bodyLine,
      ));
      source = linked.source;
      markerNonce = linked.markerNonce;
    }
    if (usedRemoteModules) {
      setRunStatus('Running remote code with restricted access.', true);
      appendLine('log-info', `[security] ${REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE}`);
    }
    if (entryCache.size > 0) appendLine('log-info', `[import] ${entryCache.size} module(s) resolved`);
  } catch (e) {
    pendingBuild?.then((built) => {
      for (const entry of built.cache.values()) URL.revokeObjectURL(entry.blobUrl);
    }).catch(() => {});
    if (/** @type {{ name?: string }} */ (e)?.name === 'AbortError') {
      clearModuleCache();
      setRunStatus('Notebook run stopped.', false);
      return stoppedResult();
    }
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    const errorCode = /** @type {{ name?: string, code?: string }} */ (e)?.name === 'TimeoutError'
      ? 'notebook_run_timeout'
      : /** @type {{ code?: string }} */ (e)?.code;
    const phase = errorCode === MODULE_SYNTAX_ERROR_CODE ? 'syntax check' : 'import resolution';
    appendLine('log-error', `${phase} failed: ${msg}`);
    const policyMessage = moduleImportPolicyMessage(errorCode);
    if (usedRemoteModules) appendLine('log-info', `[security] ${REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE}`);
    setRunStatus(errorCode === 'notebook_run_timeout'
      ? 'Notebook run timed out.'
      : policyMessage ?? (usedRemoteModules ? 'Restricted remote code failed.' : 'Notebook run failed.'), false);
    return {
      value: undefined, consoleOutput: [], durationMs: 0,
      error: `${phase} failed: ${msg}`,
      errorCode,
      usedRemoteModules,
    };
  }
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  let worker;
  try {
    worker = /** @type {string} */ (NOTEBOOK_MODULE_LOADER) === 'single-bundle'
      ? await spawnHostedWorker(source, markerNonce)
      : new Worker(url, { type: 'module' });
  }
  catch (e) {
    URL.revokeObjectURL(url);
    clearModuleCache();
    setRunStatus(usedRemoteModules ? 'Restricted remote code failed.' : 'Notebook run failed.', false);
    return {
      value: undefined, consoleOutput: [], durationMs: 0,
      error: `worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
      usedRemoteModules,
    };
  }

  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  appendLine('log-eval', `> ${oneLineCode.replace(/\n/g, '\n  ')}`);

  try {
    /** @type {(() => void) | undefined} */
    let workerAbortListener;
    return await new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        try { worker.terminate(); } catch {}
        resolve(signal?.reason === 'deadline'
          ? timedOutResult(timeoutMs, usedRemoteModules)
          : stoppedResult());
      };
      workerAbortListener = onAbort;
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch {}
        resolve(timedOutResult(timeoutMs, usedRemoteModules));
      }, Math.max(0, deadlineAt - Date.now()));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      worker.addEventListener('message', async (ev) => {
        // why any: a worker postMessage payload is type-erased across the
        // boundary; the type is established by the `m.type` discriminator below.
        /** @type {any} */
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'seal-failed') {
          clearTimeout(timer);
          try { worker.terminate(); } catch {}
          appendLine('log-error', `[realm seal failed] ${m.error}`);
          resolve({
            value: undefined, consoleOutput: [], durationMs: 0,
            error: `realm seal failed: ${m.error}`, errorCode: undefined,
            usedRemoteModules,
          });
          return;
        }
        if (m.type === 'log') { appendLine(`log-${m.level}`, m.text); return; }
        if (m.type === 'display') {
          // peerd.self.display(value) — render rich output mid-run (same path as
          // the return value: descriptors → table/chart, rows → table, else JSON).
          renderReturnValue(els.output, m.value);
          els.outputPane.scrollTop = els.outputPane.scrollHeight;
          return;
        }
        if (m.type === 'actor-request') {
          if (usedRemoteModules) {
            worker.postMessage({
              type: 'actor-response', rid: m.rid,
              error: remoteModuleCapabilityBlockedMessage('subagents'),
            });
            return;
          }
          // Forward to the SW orchestrator. The SW resolves the parent
          // (current chat session) + depth itself; we only pass the
          // task + tool subset + caps the Notebook code requested.
          const a = m.args ?? {};
          appendLine('log-info', `[actor] ${String(a.task ?? '').slice(0, 80)}`);
          try {
            // why any: cross-context sendMessage replies are type-erased (the SW
            // returns a JSON-shaped object the polyfill types as unknown).
            const resp = /** @type {any} */ (await browser.runtime.sendMessage({
              type: 'actor/spawn',
              task: a.task,
              tools: a.tools,
              maxSteps: a.maxSteps,
              maxDepth: a.maxDepth,
              allowRecursion: a.allowRecursion,
            }));
            if (!resp?.ok) {
              worker.postMessage({ type: 'actor-response', rid: m.rid, error: resp?.error ?? 'actor failed' });
            } else {
              const r = resp.result;
              appendLine('log-info', `[actor] ← ${r?.toolCalls ?? 0} tool call(s), ${r?.durationMs ?? 0}ms`);
              worker.postMessage({ type: 'actor-response', rid: m.rid, result: r });
            }
          } catch (e) {
            worker.postMessage({ type: 'actor-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'fetch-request') {
          if (usedRemoteModules) {
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: false, status: 0, bodyB64: null,
              error: remoteModuleCapabilityBlockedMessage('network access'),
            });
            return;
          }
          try {
            // Design 2a: `extract` rides to the SW route (which owns the
            // extraction step — the tab never grows its own copy); `extracted`
            // rides back for the bridge's fake Response marker.
            const resp = /** @type {any} */ (await browser.runtime.sendMessage({
              type: 'sw/web-fetch', url: m.url, method: m.method, headers: m.headers, body: m.body,
              ...(typeof m.extract === 'string' ? { extract: m.extract } : {}),
            }));
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: resp?.ok ?? false, status: resp?.status ?? 0,
              statusText: resp?.statusText ?? '', headers: resp?.headers ?? null,
              bodyB64: resp?.bodyB64 ?? null, error: resp?.error ?? null,
              ...(typeof resp?.extracted === 'boolean' ? { extracted: resp.extracted } : {}),
            });
          } catch (e) {
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: false, status: 0, bodyB64: null, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e),
            });
          }
          return;
        }
        if (m.type === 'opfs-request') {
          if (usedRemoteModules) {
            worker.postMessage({
              type: 'opfs-response', rid: m.rid,
              error: remoteModuleCapabilityBlockedMessage('Notebook files'),
            });
            return;
          }
          if (m.op === 'compose-module') {
            // Dynamic import is unsupported, so this host-owned event ends the
            // run. User code cannot catch it and replace it with an unrelated
            // failure that inherits the policy code.
            const error = new UnsupportedNativeModuleImportError();
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            appendLine('log-error', `import resolution failed: ${error.message}`);
            resolve({
              value: undefined, consoleOutput: [], durationMs: 0,
              error: `import resolution failed: ${error.message}`,
              errorCode: error.code,
              usedRemoteModules,
            });
            return;
          }
          try {
            let result;
            if (m.op === 'read') result = await editor.opfs.read(m.args.path);
            else if (m.op === 'write') { await editor.opfs.write(m.args.path, m.args.content); result = null; }
            else if (m.op === 'delete') { await editor.opfs.delete(m.args.path); result = null; }
            else if (m.op === 'list') result = await editor.opfs.list();
            else throw new Error(`unknown opfs op: ${m.op}`);
            worker.postMessage({ type: 'opfs-response', rid: m.rid, result });
          } catch (e) {
            const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
            appendLine('log-error', `[file] FAILED ${m.op}: ${msg}`);
            worker.postMessage({ type: 'opfs-response', rid: m.rid, error: msg });
          }
          return;
        }
        if (m.type === 'distributed-request') {
          if (usedRemoteModules) {
            worker.postMessage({
              type: 'distributed-response', rid: m.rid,
              error: remoteModuleCapabilityBlockedMessage('dweb reads'),
            });
            return;
          }
          // peerd.distributed.{whoami,status,peers,presence} — the READ window
          // onto the always-on base network. One SW round-trip (dweb/distributed/
          // info) returns the rosters; the worker slices per method. dweb-off /
          // store answers { ok:false, error:'dweb-disabled' }, which the worker
          // surface renders as inert (available:false, empty rosters).
          try {
            const resp = await browser.runtime.sendMessage({ type: 'dweb/distributed/info' });
            worker.postMessage({ type: 'distributed-response', rid: m.rid, result: resp });
          } catch (e) {
            worker.postMessage({ type: 'distributed-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'done') {
          clearTimeout(timer);
          try { worker.terminate(); } catch {}
          if (m.value !== undefined && !m.error) {
            renderReturnValue(els.output, m.value);
            els.outputPane.scrollTop = els.outputPane.scrollHeight;
          }
          // Map stack frames in the entry blob back to notebook.js:<line> so
          // the pane (and the agent's tool result) point at the user's code.
          const workerUrl = ev.workerUrl ?? url;
          const error = m.error
            ? mapWorkerError(m.error, workerUrl, bodyLine, entryPath, entryCache)
            : null;
          if (error) appendLine('log-error', error);
          resolve({
            value: m.value, consoleOutput: m.consoleOutput,
            durationMs: m.durationMs, error,
            errorCode: undefined,
            usedRemoteModules,
          });
          return;
        }
      });

      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        try { worker.terminate(); } catch {}
        const err = e.error;
        let detail = err?.stack || err?.message || e.message || '';
        if (!detail) detail = 'worker crashed (no detail available)';
        const workerUrl = e.workerUrl ?? url;
        detail = /** @type {string} */ (
          mapWorkerError(detail, workerUrl, bodyLine, entryPath, entryCache));
        // A SYNTAX error never reaches the entry's catch — it surfaces here
        // with the blob filename + line. Map it to the user's file too.
        const rawLocation = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '';
        const mappedLocation = rawLocation
          ? mapWorkerError(rawLocation, workerUrl, bodyLine, entryPath, entryCache)
          : '';
        const loc = mappedLocation ? ` (${mappedLocation})` : '';
        appendLine('log-error', `[worker crashed] ${detail}${loc}`);
        resolve({
          value: undefined, consoleOutput: [], durationMs: 0,
          error: `worker error: ${detail}${loc}`, errorCode: undefined,
          usedRemoteModules,
        });
      });
    }).finally(() => {
      if (workerAbortListener) signal?.removeEventListener('abort', workerAbortListener);
    }).then((result) => {
      setRunStatus(
        result.stopped
          ? 'Notebook run stopped.'
          : result.errorCode === 'notebook_run_timeout'
            ? 'Notebook run timed out.'
          : moduleImportPolicyMessage(result.errorCode)
          ?? (usedRemoteModules
            ? (result.error ? 'Restricted remote code failed.' : 'Remote code ran with restricted access.')
            : (result.error ? 'Notebook run failed.' : 'Notebook run complete.')),
        false,
      );
      return result;
    });
  } finally {
    URL.revokeObjectURL(url);
    clearModuleCache();
  }
};

/** @type {{ runId: string, controller: AbortController } | null} */
let activeEval = null;

/** @param {boolean} running */
const setRunControl = (running) => {
  els.runBtn.disabled = false;
  els.runBtn.textContent = running ? 'Stop notebook run ■' : 'Run notebook.js ▶';
  els.runBtn.title = running
    ? 'Stop the current Notebook run'
    : 'Runs notebook.js (Cmd-Enter / Ctrl-Enter)';
  els.runBtn.setAttribute('aria-label', running ? 'Stop notebook run' : 'Run notebook.js');
};

/** @param {string} runId */
const reserveRun = (runId) => {
  if (activeEval) return null;
  const controller = new AbortController();
  activeEval = { runId, controller };
  setRunControl(true);
  return controller;
};

const busyResult = () => ({
  value: undefined, consoleOutput: [], durationMs: 0,
  error: 'Notebook already has a run in progress', errorCode: 'notebook_run_busy',
  usedRemoteModules: false,
});

/** @param {string} code @param {number} timeoutMs @param {string} entryPath @param {string} runId @param {AbortController} controller */
const executeReservedRun = async (code, timeoutMs, entryPath, runId, controller) => {
  const deadlineTimer = setTimeout(() => controller.abort('deadline'), timeoutMs);
  try { return await runEvalInternal(code, timeoutMs, entryPath, controller.signal); }
  finally {
    clearTimeout(deadlineTimer);
    if (activeEval?.runId === runId) activeEval = null;
    setRunControl(false);
  }
};

/** @param {string} code @param {number} timeoutMs @param {string} entryPath @param {string} runId */
const executeRun = async (code, timeoutMs, entryPath, runId) => {
  const controller = reserveRun(runId);
  return controller
    ? executeReservedRun(code, timeoutMs, entryPath, runId, controller)
    : busyResult();
};

// ---------------------------------------------------------------------------
// Run from editor (Cmd-Enter or button) — always targets notebook.js
// regardless of which tab is active. See git log for the rationale.
// ---------------------------------------------------------------------------

const runFromEditor = async () => {
  if (activeEval) {
    setRunStatus('Stopping notebook run.', true);
    activeEval.controller.abort();
    return;
  }
  await editor.flushSave();
  let code;
  try { code = await editor.opfs.read(NOTEBOOK_PATH); }
  catch { code = ''; }
  if (!code.trim()) {
    appendLine('log-info',
      '[notebook.js is empty — nothing to run. Switch to the notebook.js tab to write an entry.]');
    return;
  }
  try {
    await executeRun(code, 30000, NOTEBOOK_PATH, crypto.randomUUID());
    await editor.refreshTree();
  } catch (e) {
    appendLine('log-error', `run failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  }
};

// ---------------------------------------------------------------------------
// Export — download this Notebook as a .peerd file (DESIGN-10). The SW
// owns the format; this is just flush → fetch envelope → Blob+anchor.
// ---------------------------------------------------------------------------

const exportNotebook = async () => {
  els.exportBtn.disabled = true;
  try {
    // Flush first so the export reflects the buffer, not the last save.
    await editor?.flushSave?.();
    const reply = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'export/artifact', kind: 'notebook', id: notebookId,
    }));
    if (!reply?.ok) throw new Error(reply?.error ?? 'export failed');
    const blob = new Blob([JSON.stringify(reply.envelope)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reply.filename;
    a.click();
    URL.revokeObjectURL(url);
    appendLine('log-info', `[exported ${reply.filename}]`);
  } catch (e) {
    appendLine('log-error', `export failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  } finally {
    els.exportBtn.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// SW → tab dispatch.
// ---------------------------------------------------------------------------

const JS_ROUTES = new Set(['js/eval', 'js/abort', 'js/write-file', 'js/read-file', 'js/list-files', 'js/quiesce']);

// why the cast: the polyfill's OnMessageListenerCallback types the return as the
// literal `true` (keep the channel open), so it can't model the legitimate
// "return false to decline this message" early-exits below. Typing the handler
// for real and casting at the boundary keeps the body checked.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 * @returns {boolean}
 */
const onNotebookMessage = (msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !isServiceWorkerSender(sender)) return false;
  if (!JS_ROUTES.has(msg.type)) return false;
  if (msg.notebookId && msg.notebookId !== notebookId) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'js/quiesce':
          if (msg.notebookId !== notebookId) return;
          if (msg.action === 'release') {
            document.body.inert = false;
            sendResponse({ ok: true });
            return;
          }
          if (msg.action !== 'acquire') {
            sendResponse({ ok: false, error: 'invalid Notebook quiesce action' });
            return;
          }
          document.body.inert = true;
          try {
            await editor.flushSave();
            sendResponse({ ok: true });
          } catch (error) {
            document.body.inert = false;
            throw error;
          }
          return;
        case 'js/eval': {
          const runId = typeof msg.runId === 'string' ? msg.runId : crypto.randomUUID();
          const controller = reserveRun(runId);
          if (!controller) {
            sendResponse({ ok: true, result: busyResult() });
            return;
          }
          // Mirror the agent's code into notebook.js with a one-shot
          // backup of whatever the user had there.
          let result;
          const deadlineTimer = setTimeout(
            () => controller.abort('deadline'), msg.timeoutMs ?? 30000,
          );
          try {
            throwIfAborted(controller.signal);
            if (editor.getActiveFile() !== NOTEBOOK_PATH) {
              await editor.switchToFile(NOTEBOOK_PATH);
              throwIfAborted(controller.signal);
            }
            await editor.replaceActiveWith(msg.code, { backupTo: BEFORE_AGENT_PATH });
            throwIfAborted(controller.signal);
            result = await runEvalInternal(
              msg.code, msg.timeoutMs ?? 30000, NOTEBOOK_PATH, controller.signal,
            );
          } catch (error) {
            const name = /** @type {{ name?: string }} */ (error)?.name;
            if (name !== 'AbortError' && name !== 'TimeoutError') throw error;
            const timedOut = name === 'TimeoutError';
            setRunStatus(timedOut ? 'Notebook run timed out.' : 'Notebook run stopped.', false);
            result = timedOut
              ? timedOutResult(msg.timeoutMs ?? 30000)
              : stoppedResult();
          } finally {
            clearTimeout(deadlineTimer);
            if (activeEval?.runId === runId) activeEval = null;
            setRunControl(false);
          }
          await editor.refreshTree();
          sendResponse({ ok: true, result });
          return;
        }
        case 'js/abort':
          if (activeEval && (!msg.runId || activeEval.runId === msg.runId)) {
            activeEval.controller.abort();
            sendResponse({ ok: true, stopped: true });
          } else sendResponse({ ok: true, stopped: false });
          return;
        case 'js/write-file':
          await editor.opfs.write(msg.path, msg.content);
          await editor.refreshTree();
          sendResponse({ ok: true });
          return;
        case 'js/read-file':
          sendResponse({ ok: true, content: await editor.opfs.read(msg.path) });
          return;
        case 'js/list-files':
          sendResponse({ ok: true, files: await editor.opfs.list() });
          return;
      }
    } catch (e) {
      const err = /** @type {{ message?: string, name?: string }} */ (e);
      // why: carry the OPFS not-found NAME across the tab RPC. getFileHandle
      // throws a DOMException named 'NotFoundError' for a missing entry; the
      // flattened message alone loses the name, and edit_file (3a) would then
      // read an absent notebook file as a read_failed — breaking whole-file
      // create. Tag it with a code the client re-inflates into a NotFoundError.
      sendResponse({
        ok: false,
        error: err?.message ?? String(e),
        ...(err?.name === 'NotFoundError' ? { code: 'not_found' } : {}),
      });
    }
  })();
  return true;
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onNotebookMessage));

// ---------------------------------------------------------------------------
// Editor/output splitter — drag the boundary to resize the two panes. The
// editor fraction (0.15..0.85) persists per Notebook in localStorage; flexGrow
// on the two panes IS the split ratio (defaults 6:4 from CSS).
// ---------------------------------------------------------------------------

const LS_SPLIT = `peerd:nb:${notebookId}:split`;

const setupResizer = () => {
  const editorMount = document.getElementById('editor-mount');
  const resizer = document.getElementById('pane-resizer');
  const outputPane = els.outputPane;
  if (!editorMount || !resizer || !outputPane) return;

  /** @param {number} frac */
  const applyFraction = (frac) => {
    const f = Math.min(0.85, Math.max(0.15, frac));
    editorMount.style.flexGrow = String(f);
    outputPane.style.flexGrow = String(1 - f);
    return f;
  };
  /** @param {number} f */
  const save = (f) => { try { localStorage.setItem(LS_SPLIT, String(Math.round(f * 1000) / 1000)); } catch {} };

  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(LS_SPLIT) ?? ''); } catch {}
  if (Number.isFinite(saved)) applyFraction(saved);

  let dragging = false;
  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    resizer.classList.add('is-dragging');
    try { resizer.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const top = editorMount.getBoundingClientRect().top;
    const total = editorMount.offsetHeight + resizer.offsetHeight + outputPane.offsetHeight;
    if (total > 0) applyFraction((e.clientY - top) / total);
  });
  /** @param {PointerEvent} e */
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('is-dragging');
    try { resizer.releasePointerCapture(e.pointerId); } catch {}
    save(parseFloat(editorMount.style.flexGrow) || 0.6);
  };
  resizer.addEventListener('pointerup', end);
  resizer.addEventListener('pointercancel', end);
  // Keyboard a11y: arrows nudge the boundary when the handle is focused.
  resizer.addEventListener('keydown', (e) => {
    const cur = parseFloat(editorMount.style.flexGrow) || 0.6;
    if (e.key === 'ArrowUp') { save(applyFraction(cur - 0.04)); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { save(applyFraction(cur + 0.04)); e.preventDefault(); }
  });
};

// ---------------------------------------------------------------------------
// Kickoff — mount the editor, wire the Run button, announce ready.
// ---------------------------------------------------------------------------

(async () => {
  // Make sure notebook.js exists so the pinned entry has something
  // (empty is fine). The editor's initial-load tolerates missing files.
  editor = await createEditor({
    mountEl: byId('editor-mount'),
    opfsBase: ['peerd-notebooks', notebookId],
    pinnedFile: NOTEBOOK_PATH,
    hiddenFiles: HIDDEN_FILES,
    beforeOpfsMutation: assertOpfsWritable,
    onRun: runFromEditor,
    onSaved: () => setSaveStatus('saved'),
    onSaveError: (_path, error) => {
      setSaveStatus('dirty');
      appendLine('log-error', `[file] save failed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`);
    },
    onMutationError: (action, path, error) => {
      appendLine('log-error', `[file] ${action} failed for ${path}: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`);
    },
  });
  setSaveStatus('saved');
  setTitleStatus('');
  els.runBtn.addEventListener('click', runFromEditor);
  els.exportBtn.addEventListener('click', exportNotebook);
  showApp();
  setupResizer();
  appendLine('log-info',
    `[notebook ${notebookId} ready — Cmd-Enter to run · state lives in OPFS]`);
  browser.runtime.sendMessage({ type: 'js/tab-ready', notebookId }).catch(() => {});
})();
