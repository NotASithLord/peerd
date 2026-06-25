// web/notebook-host.js — page-side host for peerd's Notebook substrate.
//
// This is the WEB analogue of extension/notebook-tab/notebook-tab.js: it spawns
// the SAME sealed worker (notebook-tab/worker-source.js, vendored unmodified)
// and serves its postMessage bridges — but in a plain web page instead of an
// extension tab. The substrate is real; only the host differs. Extension-only
// bridges (subagent → SW orchestrator, fetch → SW webFetch, dweb info) are
// stubbed for this slice; OPFS is real (the standard navigator.storage API).
//
// Contract (see docs/specs/PEERD-WEB-SURFACE.md): user code is baked into the
// worker source and runs on spawn; the worker posts log/display/done plus
// bridge requests; we render via the real output-render.js and reply to bridges.

import { buildWorkerSource, NOTEBOOK_BUILTINS } from '/notebook-tab/worker-source.js';
import { buildModule } from '/peerd-engine/index.js';
import { renderReturnValue } from '/notebook-tab/output-render.js';
import { opfsHelpers } from '/peerd-engine/opfs.js';

/**
 * Run one notebook in a fresh sealed worker.
 * @param {string} code
 * @param {{ outputEl: HTMLElement, logEl?: HTMLElement, notebookId?: string, timeoutMs?: number }} opts
 */
export async function runNotebook(code, { outputEl, logEl, notebookId, timeoutMs = 30000 }) {
  notebookId = notebookId || ('nb-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));
  const opfs = opfsHelpers(['peerd-lite', notebookId]);

  const log = (cls, text) => {
    if (!logEl) return;
    const d = document.createElement('div');
    d.className = 'nbline ' + cls;
    d.textContent = text;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };

  // resolverDeps the substrate needs to resolve imports. builtins maps
  // `peerd:std` → the vendored notebook-std.js (same map the entry uses), so
  // dynamically-composed modules resolve it identically.
  const resolverDeps = {
    readFile: (path) => opfs.read(path),
    makeBlobUrl: (src) => URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
    builtins: NOTEBOOK_BUILTINS,
    log: (e) => {
      if (e.type === 'resolved') log('log-info', `[import] ./${e.path} resolved`);
      else if (e.type === 'resolve-failed') log('log-error', `[import] ${e.path}: ${e.error}`);
    },
  };

  let built;
  try {
    built = await buildWorkerSource(code, { notebookId, resolverDeps });
    if (built.cache.size > 0) log('log-info', `[import] ${built.cache.size} module(s) resolved`);
  } catch (e) {
    log('log-error', 'import resolution failed: ' + (e?.message || String(e)));
    return { error: 'import resolution failed' };
  }

  const url = URL.createObjectURL(new Blob([built.source], { type: 'application/javascript' }));
  let worker;
  try { worker = new Worker(url, { type: 'module' }); }
  catch (e) { URL.revokeObjectURL(url); log('log-error', 'worker spawn failed: ' + (e?.message || String(e))); return { error: 'spawn failed' }; }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch {}
      log('log-error', `eval timed out after ${timeoutMs}ms`);
      resolve({ error: 'timeout' });
    }, timeoutMs);

    worker.addEventListener('message', async (ev) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;

      if (m.type === 'log') { log('log-' + m.level, m.text); return; }

      if (m.type === 'display') { renderReturnValue(outputEl, m.value); return; }

      if (m.type === 'opfs-request') {
        try {
          let result;
          if (m.op === 'read') result = await opfs.read(m.args.path);
          else if (m.op === 'write') { await opfs.write(m.args.path, m.args.content); result = null; }
          else if (m.op === 'list') result = await opfs.list();
          else if (m.op === 'compose-module') {
            const sub = await buildModule(m.args.path, resolverDeps, built.cache);
            result = sub.source;
          } else throw new Error('unknown opfs op: ' + m.op);
          worker.postMessage({ type: 'opfs-response', rid: m.rid, result });
        } catch (e) {
          worker.postMessage({ type: 'opfs-response', rid: m.rid, error: e?.message || String(e) });
        }
        return;
      }

      // --- bridges deferred to later slices (stubbed, fail-closed) ---
      if (m.type === 'fetch-request') {
        worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, statusText: '', headers: null, bodyB64: null, error: 'network egress is not wired in this prototype slice' });
        log('log-warn', '[egress] peerd.egress.fetch blocked — network lands in a later slice');
        return;
      }
      if (m.type === 'subagent-request') {
        worker.postMessage({ type: 'subagent-response', rid: m.rid, error: 'peerd.runtime.runAgent lands in the agent slice' });
        return;
      }
      if (m.type === 'distributed-request') {
        worker.postMessage({ type: 'distributed-response', rid: m.rid, result: { ok: false, error: 'dweb lands in a later slice' } });
        return;
      }

      if (m.type === 'done') {
        clearTimeout(timer);
        try { worker.terminate(); } catch {}
        URL.revokeObjectURL(url);
        if (m.value !== undefined && !m.error) renderReturnValue(outputEl, m.value);
        if (m.error) log('log-error', m.error);
        else log('log-eval', `✓ done in ${m.durationMs}ms`);
        resolve({ value: m.value, error: m.error || null, durationMs: m.durationMs });
        return;
      }
    });

    worker.addEventListener('error', (e) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch {}
      URL.revokeObjectURL(url);
      const detail = e.message || (e.error && (e.error.stack || e.error.message)) || 'worker crashed';
      log('log-error', '[worker crashed] ' + detail);
      resolve({ error: 'worker crashed' });
    });
  });
}
