// @ts-check
// offscreen/job-runner.js — runs a HEADLESS JS job in a sealed Worker.
//
// The headless sibling of the Notebook tab's runEval (DECISIONS #25, "runJob"):
// the SAME sealed worker (worker-source.js — realm seal first, peerd.* surface,
// the fetch/opfs/subagent bridges), but hosted in the offscreen document with NO
// UI, an EPHEMERAL OPFS scratch that is nuked when the job ends, and output
// ACCUMULATED into the return value. Egress + subagent relay through the SAME
// audited SW routes the tab uses (sw/web-fetch, subagent/spawn), so
// denylist + SSRF + audit are enforced centrally regardless of host.
//
// SECURITY — defense-in-depth is WEAKER here than the tab, by one layer, and
// that is deliberate + bounded:
//   • The Notebook tab page has TWO fences: the realm seal AND a page CSP of
//     `connect-src 'none'`. The offscreen document's CSP allows `https:` (it
//     MUST, to download the Moonshine voice model), and a blob worker inherits
//     its owner document's CSP — so a headless worker has NO `connect-src 'none'`
//     backstop. It relies on the realm seal ALONE.
//   • That is acceptable because runJob runs the agent's OWN semi-trusted code,
//     and the seal is the PRIMARY fence: it deletes fetch/XHR/WS/etc. and pins a
//     postMessage-bridged fetch (the seal tests prove it can't be unseated from
//     inside the realm). The CSP only ever mattered as a seal-ESCAPE backstop.
//   • Do NOT run UNTRUSTED code here — that needs a real origin boundary (the
//     opaque-origin iframe / "App without UI", DESIGN.md §8.5), not a Worker.
//   • Hardening path if the backstop is wanted: spawn the worker from a
//     same-origin iframe carrying its own `connect-src 'none'` meta-CSP.

import { opfsHelpers, buildModule } from '/peerd-engine/index.js';
import { buildWorkerSource, NOTEBOOK_BUILTINS } from '/notebook-tab/worker-source.js';

let jobSeq = 0;

// Cap concurrent headless workers so a loop (or many parallel js_run calls /
// sub-agents) can't fork-bomb the offscreen renderer. Each job is its own thread
// + ephemeral OPFS; a handful at once is plenty. (The capability surface's own
// rule: engine.spawn* → resource exhaustion → hard caps.)
const MAX_CONCURRENT_JOBS = 4;
let activeJobs = 0;

/**
 * Run one headless job. Resolves with the same shape js_notebook returns. Rejects
 * (as a result, not a throw) when too many jobs are already in flight.
 *
 * @param {{ code: string, timeoutMs?: number }} job
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any> }} deps
 * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null }>}
 */
export const runJob = async (job, deps) => {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `headless job rejected: ${MAX_CONCURRENT_JOBS} jobs already running` };
  }
  activeJobs++;
  try { return await _runJob(job, deps); }
  finally { activeJobs--; }
};

/**
 * @param {{ code: string, timeoutMs?: number }} job
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any> }} deps
 *   sendToSW relays a worker bridge message to the SW route of that name.
 */
const _runJob = async ({ code, timeoutMs = 30000 }, { sendToSW }) => {
  const jobId = `job-${Date.now().toString(36)}-${++jobSeq}`;
  // Per-job EPHEMERAL OPFS subtree — peerd.self.* + relative imports work within
  // the run, then it's nuked. Durable state belongs in a Notebook, not here.
  const opfs = opfsHelpers(['peerd-jobs', jobId]);
  const resolverDeps = {
    /** @param {string} path */
    readFile: (path) => opfs.read(path),
    /** @param {string} src */
    makeBlobUrl: (src) => URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
    log: () => {},
    builtins: NOTEBOOK_BUILTINS,
  };

  let built;
  try {
    built = await buildWorkerSource(code, { entryPath: 'job.js', notebookId: jobId, resolverDeps });
  } catch (e) {
    await opfs.nuke().catch(() => {});
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `import resolution failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  const { source, cache } = built;
  const revokeCache = () => { for (const entry of cache.values()) if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl); };

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  let worker;
  try { worker = new Worker(blobUrl, { type: 'module' }); }
  catch (e) {
    URL.revokeObjectURL(blobUrl);
    revokeCache();
    await opfs.nuke().catch(() => {});
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch {}
        resolve({ value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `job timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      worker.addEventListener('message', async (ev) => {
        // why any: worker postMessage payload, discriminated by m.type below.
        /** @type {any} */
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        // Headless: no UI. console accumulates in the worker and rides 'done';
        // display() has no surface here (the agent should RETURN its result).
        if (m.type === 'log' || m.type === 'display') return;

        if (m.type === 'subagent-request') {
          const a = m.args ?? {};
          try {
            const resp = await sendToSW('subagent/spawn', {
              task: a.task, tools: a.tools, maxSteps: a.maxSteps, maxDepth: a.maxDepth, allowRecursion: a.allowRecursion,
            });
            if (!resp?.ok) worker.postMessage({ type: 'subagent-response', rid: m.rid, error: resp?.error ?? 'subagent failed' });
            else worker.postMessage({ type: 'subagent-response', rid: m.rid, result: resp.result });
          } catch (e) {
            worker.postMessage({ type: 'subagent-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'fetch-request') {
          try {
            const resp = await sendToSW('sw/web-fetch', { url: m.url, method: m.method, headers: m.headers, body: m.body });
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: resp?.ok ?? false, status: resp?.status ?? 0,
              statusText: resp?.statusText ?? '', headers: resp?.headers ?? null,
              bodyB64: resp?.bodyB64 ?? null, error: resp?.error ?? null,
            });
          } catch (e) {
            worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, bodyB64: null, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
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
            worker.postMessage({ type: 'opfs-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'done') {
          clearTimeout(timer);
          try { worker.terminate(); } catch {}
          resolve({ value: m.value, consoleOutput: m.consoleOutput, durationMs: m.durationMs, error: m.error ?? null });
        }
      });

      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        try { worker.terminate(); } catch {}
        const detail = e.error?.stack || e.error?.message || e.message || 'worker crashed (no detail)';
        resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: `worker error: ${detail}` });
      });
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
    revokeCache();
    await opfs.nuke().catch(() => {});
  }
};
