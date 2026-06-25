// A WEB host adapter for peerd's sealed Notebook worker substrate — the page-side
// equivalent of the extension's offscreen/job-runner.js + notebook-tab.js host.
//
// This is the PoC for the central claim of docs/specs/PEERD-WEB-SURFACE.md: the
// substrate ships VERBATIM. Everything the worker runs — the realm seal, the
// peerd.* surface, the module resolver, peerd:std — is imported UNMODIFIED from
// the extension tree (/notebook-tab/worker-source.js, /peerd-engine/index.js).
// Only this host adapter changes vs the extension, and only in three places:
//   1. OPFS is DURABLE (a stable per-notebook subtree), like a Notebook tab —
//      not the headless ephemeral scratch job-runner nukes per call. OPFS is a
//      web-platform API, so opfsHelpers works in a plain page unchanged.
//   2. The fetch bridge is an IN-PAGE fetch (denylist-gated by the caller's
//      fetchImpl), NOT the extension SW's sw/web-fetch route — a page has no SW
//      to relay to. This is the one network seam the spec calls out.
//   3. No subagent relay. Subagents are the extension's surface (they drive the
//      user's tabs); an origin-confined page declines them — which is the funnel.
//
// The worker message protocol mirrored here is exactly job-runner.js's:
// log / display / subagent-request / fetch-request / opfs-request / done.

import { opfsHelpers, buildModule } from '/peerd-engine/index.js';
import { buildWorkerSource, NOTEBOOK_BUILTINS } from '/notebook-tab/worker-source.js';

/** Base64 a binary body in chunks (avoids the fromCharCode spread arg-count cap). */
const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

/**
 * Create a Notebook host bound to one durable OPFS subtree. `run(code)` spawns a
 * fresh sealed worker for the cell (a new worker every run — the OPFS files
 * persist across runs, which is what makes this a Notebook, not a scratch job).
 *
 * @param {{
 *   notebookId?: string,
 *   onLog?: (m: { level: string, text: string }) => void,
 *   onDisplay?: (m: { value: unknown }) => void,
 *   fetchImpl?: typeof fetch,
 * }} [opts]
 */
export const createNotebookHost = ({ notebookId = 'web-notebook', onLog, onDisplay, fetchImpl = fetch } = {}) => {
  // why durable: the page-hosted Notebook keeps its files across runs, exactly
  // like the extension Notebook tab (['peerd-notebooks', id]).
  const opfs = opfsHelpers(['peerd-notebooks', notebookId]);

  const resolverDeps = {
    /** @param {string} path */
    readFile: (path) => opfs.read(path),
    /** @param {string} src */
    makeBlobUrl: (src) => URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
    log: () => {},
    builtins: NOTEBOOK_BUILTINS,
  };

  /**
   * @param {string} code
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null }>}
   */
  const run = async (code, { timeoutMs = 30000 } = {}) => {
    let built;
    try {
      built = await buildWorkerSource(code, { entryPath: 'cell.js', notebookId, resolverDeps });
    } catch (e) {
      return { value: undefined, consoleOutput: [], durationMs: 0, error: `import resolution failed: ${e?.message ?? String(e)}` };
    }
    const { source, cache } = built;
    const revokeCache = () => { for (const entry of cache.values()) if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl); };

    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    let worker;
    try {
      worker = new Worker(blobUrl, { type: 'module' });
    } catch (e) {
      URL.revokeObjectURL(blobUrl);
      revokeCache();
      return { value: undefined, consoleOutput: [], durationMs: 0, error: `worker spawn failed: ${e?.message ?? String(e)}` };
    }

    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { worker.terminate(); } catch { /* */ }
          resolve({ value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        worker.addEventListener('message', async (ev) => {
          const m = ev.data;
          if (!m || typeof m !== 'object') return;

          if (m.type === 'log') { onLog?.(m); return; }
          if (m.type === 'display') { onDisplay?.(m); return; }

          // (3) origin-confined: no subagents in the page.
          if (m.type === 'subagent-request') {
            worker.postMessage({ type: 'subagent-response', rid: m.rid, error: 'subagents are an extension capability (origin-confined page declines them)' });
            return;
          }

          // (2) the in-page fetch swap — the seal-pinned bridge resolves to a
          // real fetch here, not the extension SW route.
          if (m.type === 'fetch-request') {
            try {
              const r = await fetchImpl(m.url, { method: m.method, headers: m.headers, body: m.body });
              const bodyB64 = toBase64(await r.arrayBuffer());
              worker.postMessage({
                type: 'fetch-response', rid: m.rid,
                ok: r.ok, status: r.status, statusText: r.statusText,
                headers: Object.fromEntries(r.headers.entries()), bodyB64, error: null,
              });
            } catch (e) {
              worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, bodyB64: null, error: e?.message ?? String(e) });
            }
            return;
          }

          // (1) durable OPFS — the SAME opfsHelpers + module resolver the
          // extension uses; OPFS is a web-platform API, so this is unchanged.
          if (m.type === 'opfs-request') {
            try {
              let result;
              if (m.op === 'read') result = await opfs.read(m.args.path);
              else if (m.op === 'write') { await opfs.write(m.args.path, m.args.content); result = null; }
              else if (m.op === 'list') result = await opfs.list();
              else if (m.op === 'compose-module') result = (await buildModule(m.args.path, resolverDeps, cache)).source;
              else throw new Error(`unknown opfs op: ${m.op}`);
              worker.postMessage({ type: 'opfs-response', rid: m.rid, result });
            } catch (e) {
              worker.postMessage({ type: 'opfs-response', rid: m.rid, error: e?.message ?? String(e) });
            }
            return;
          }

          if (m.type === 'done') {
            clearTimeout(timer);
            try { worker.terminate(); } catch { /* */ }
            resolve({ value: m.value, consoleOutput: m.consoleOutput, durationMs: m.durationMs, error: m.error ?? null });
          }
        });

        worker.addEventListener('error', (e) => {
          clearTimeout(timer);
          try { worker.terminate(); } catch { /* */ }
          const detail = e.error?.stack || e.error?.message || e.message || 'worker crashed (no detail)';
          resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: `worker error: ${detail}` });
        });
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
      revokeCache();
    }
  };

  return { run, opfs };
};
