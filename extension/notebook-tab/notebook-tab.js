// @ts-check
// notebook-tab — host page for one Notebook.
//
// Most of the heavy lifting lives in peerd-engine:
//   - createEditor()  — CodeMirror + file tree + OPFS, mounted into
//                       #editor-host
//   - buildEntry()    — static/re-export/dynamic import resolver
//
// This file is the per-page glue: spawn a worker per eval, route
// shimmed fetch + OPFS calls back through the host, mirror agent
// js_notebook into the editor's notebook.js, post the result back to the SW.

import browser from '/vendor/browser-polyfill.js';
import { buildModule, createEditor } from '/peerd-engine/index.js';
import { renderReturnValue } from './output-render.js';
// The sealed worker source (realm seal + peerd.* surface + bridges) is shared
// with the headless offscreen job runner so the security surface can't diverge.
import { buildWorkerSource, NOTEBOOK_BUILTINS } from './worker-source.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';

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

/** @param {string} [url] */
const shortenBlob = (url) => {
  if (!url) return '<no url>';
  const m = url.match(/[^/]+$/);
  return m ? `blob:…${m[0].slice(-8)}` : url;
};

const makeResolverDeps = () => ({
  /** @param {string} path */
  readFile: (path) => editor.opfs.read(path),
  /** @param {string} source */
  makeBlobUrl: (source) => URL.createObjectURL(
    new Blob([source], { type: 'application/javascript' }),
  ),
  /** @param {{ type: string, path: string, blobUrl?: string, error?: string }} entry */
  log: (entry) => {
    if (entry.type === 'resolved') {
      appendLine('log-info', `[import] ./${entry.path} → ${shortenBlob(entry.blobUrl)}`);
    } else if (entry.type === 'resolve-failed') {
      appendLine('log-error', `[import] FAILED ./${entry.path}: ${entry.error}`);
    }
  },
  // peerd:std for nested/dynamic imports too (compose-module path below).
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

/** @param {string} code @param {number} [timeoutMs] @param {string} [entryPath] */
const runEval = async (code, timeoutMs = 30000, entryPath = NOTEBOOK_PATH) => {
  let source;
  try {
    const built = await buildWorkerSource(code, { entryPath, notebookId, resolverDeps: makeResolverDeps() });
    source = built.source;
    entryCache = built.cache;
    if (entryCache.size > 0) appendLine('log-info', `[import] ${entryCache.size} module(s) resolved`);
  } catch (e) {
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    appendLine('log-error', `import resolution failed — ${msg}`);
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `import resolution failed: ${msg}` };
  }
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  let worker;
  try { worker = new Worker(url, { type: 'module' }); }
  catch (e) {
    URL.revokeObjectURL(url);
    clearModuleCache();
    throw new Error(`worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  }

  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  appendLine('log-eval', `> ${oneLineCode.replace(/\n/g, '\n  ')}`);

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch {}
        resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: `eval timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      worker.addEventListener('message', async (ev) => {
        // why any: a worker postMessage payload is type-erased across the
        // boundary; the type is established by the `m.type` discriminator below.
        /** @type {any} */
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'log') { appendLine(`log-${m.level}`, m.text); return; }
        if (m.type === 'display') {
          // peerd.self.display(value) — render rich output mid-run (same path as
          // the return value: descriptors → table/chart, rows → table, else JSON).
          renderReturnValue(els.output, m.value);
          els.outputPane.scrollTop = els.outputPane.scrollHeight;
          return;
        }
        if (m.type === 'subagent-request') {
          // Forward to the SW orchestrator. The SW resolves the parent
          // (current chat session) + depth itself; we only pass the
          // task + tool subset + caps the Notebook code requested.
          const a = m.args ?? {};
          appendLine('log-info', `[subagent] ${String(a.task ?? '').slice(0, 80)}`);
          try {
            // why any: cross-context sendMessage replies are type-erased (the SW
            // returns a JSON-shaped object the polyfill types as unknown).
            const resp = /** @type {any} */ (await browser.runtime.sendMessage({
              type: 'subagent/spawn',
              task: a.task,
              tools: a.tools,
              maxSteps: a.maxSteps,
              maxDepth: a.maxDepth,
              allowRecursion: a.allowRecursion,
            }));
            if (!resp?.ok) {
              worker.postMessage({ type: 'subagent-response', rid: m.rid, error: resp?.error ?? 'subagent failed' });
            } else {
              const r = resp.result;
              appendLine('log-info', `[subagent] ← ${r?.toolCalls ?? 0} tool call(s), ${r?.durationMs ?? 0}ms`);
              worker.postMessage({ type: 'subagent-response', rid: m.rid, result: r });
            }
          } catch (e) {
            worker.postMessage({ type: 'subagent-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'fetch-request') {
          try {
            const resp = /** @type {any} */ (await browser.runtime.sendMessage({
              type: 'sw/web-fetch', url: m.url, method: m.method, headers: m.headers, body: m.body,
            }));
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: resp?.ok ?? false, status: resp?.status ?? 0,
              statusText: resp?.statusText ?? '', headers: resp?.headers ?? null,
              bodyB64: resp?.bodyB64 ?? null, error: resp?.error ?? null,
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
          try {
            let result;
            if (m.op === 'read') result = await editor.opfs.read(m.args.path);
            else if (m.op === 'write') { await editor.opfs.write(m.args.path, m.args.content); result = null; }
            else if (m.op === 'list') result = await editor.opfs.list();
            else if (m.op === 'compose-module') {
              // Runtime dynamic-import request. Recursively transforms
              // the module's source (nested static → host blob URLs,
              // nested dynamic → __peerd_dynamic_import calls) and
              // returns the source. The worker re-blobs in its own
              // realm and import()s.
              const sub = await buildModule(m.args.path, makeResolverDeps(), entryCache);
              appendLine('log-info', `[import] dynamic ${m.args.path} → composed (${sub.source.length}B)`);
              result = sub.source;
            }
            else throw new Error(`unknown opfs op: ${m.op}`);
            worker.postMessage({ type: 'opfs-response', rid: m.rid, result });
          } catch (e) {
            const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
            appendLine('log-error', `[import] FAILED dynamic ${m.args?.path}: ${msg}`);
            worker.postMessage({ type: 'opfs-response', rid: m.rid, error: msg });
          }
          return;
        }
        if (m.type === 'distributed-request') {
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
          if (m.error) appendLine('log-error', m.error);
          resolve({
            value: m.value, consoleOutput: m.consoleOutput,
            durationMs: m.durationMs, error: m.error ?? null,
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
        const loc = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
        appendLine('log-error', `[worker crashed] ${detail}${loc}`);
        resolve({
          value: undefined, consoleOutput: [], durationMs: 0,
          error: `worker error: ${detail}${loc}`,
        });
      });
    });
  } finally {
    URL.revokeObjectURL(url);
    clearModuleCache();
  }
};

// ---------------------------------------------------------------------------
// Run from editor (Cmd-Enter or button) — always targets notebook.js
// regardless of which tab is active. See git log for the rationale.
// ---------------------------------------------------------------------------

const runFromEditor = async () => {
  await editor.flushSave();
  let code;
  try { code = await editor.opfs.read(NOTEBOOK_PATH); }
  catch { code = ''; }
  if (!code.trim()) {
    appendLine('log-info',
      '[notebook.js is empty — nothing to run. Switch to the notebook.js tab to write an entry.]');
    return;
  }
  els.runBtn.disabled = true;
  try {
    await runEval(code, 30000, NOTEBOOK_PATH);
    await editor.refreshTree();
  } catch (e) {
    appendLine('log-error', `run failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  } finally {
    els.runBtn.disabled = false;
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

const JS_ROUTES = new Set(['js/eval', 'js/write-file', 'js/read-file', 'js/list-files']);

// why the cast: the polyfill's OnMessageListenerCallback types the return as the
// literal `true` (keep the channel open), so it can't model the legitimate
// "return false to decline this message" early-exits below. Typing the handler
// for real and casting at the boundary keeps the body checked.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} _sender
 * @param {(response: any) => void} sendResponse
 * @returns {boolean}
 */
const onNotebookMessage = (msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (!JS_ROUTES.has(msg.type)) return false;
  if (msg.notebookId && msg.notebookId !== notebookId) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'js/eval': {
          // Mirror the agent's code into notebook.js with a one-shot
          // backup of whatever the user had there.
          if (editor.getActiveFile() !== NOTEBOOK_PATH) {
            await editor.switchToFile(NOTEBOOK_PATH);
          }
          await editor.replaceActiveWith(msg.code, { backupTo: BEFORE_AGENT_PATH });
          const result = await runEval(msg.code, msg.timeoutMs ?? 30000, NOTEBOOK_PATH);
          await editor.refreshTree();
          sendResponse({ ok: true, result });
          return;
        }
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
      sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
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
    onRun: runFromEditor,
    onSaved: () => setSaveStatus('saved'),
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
