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
import { buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS } from '/notebook-tab/worker-source.js';

let jobSeq = 0;

// Live jobs by the SW-minted runId, so a Stop can TERMINATE the worker instead
// of letting an abandoned script run to its wall-clock. Registered only for
// runs that carry a runId (the actors-enabled script path mints one).
/** @type {Map<string, () => void>} */
const liveJobs = new Map();

/** Terminate a live job by runId (Stop plumbing). No-op when already done. @param {string} runId */
export const abortJob = (runId) => {
  const kill = liveJobs.get(runId);
  if (kill) kill();
};

// Cap concurrent headless workers so a loop (or many parallel script calls /
// sub-agents) can't fork-bomb the offscreen renderer. Each job is its own thread
// + ephemeral OPFS; a handful at once is plenty. (The capability surface's own
// rule: engine.spawn* → resource exhaustion → hard caps.)
const MAX_CONCURRENT_JOBS = 4;
let activeJobs = 0;

/**
 * Run one headless job. Resolves with the same shape js_notebook returns. Rejects
 * (as a result, not a throw) when too many jobs are already in flight.
 *
 * @param {{ code: string, timeoutMs?: number, a2a?: boolean, actors?: boolean, ownerSessionId?: string, ownerToolUseId?: string, runId?: string }} job
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any> }} deps
 * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null, usedEgress?: boolean, usedActors?: boolean, actorsTrace?: Array<object> }>}
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
 * @param {{ code: string, timeoutMs?: number, a2a?: boolean, actors?: boolean, ownerSessionId?: string, ownerToolUseId?: string, runId?: string }} job
 *   a2a: expose the `mesh` client (agent-to-agent); actors: expose the `actors`
 *   delegation client (the orchestrator's script surface). ownerSessionId /
 *   ownerToolUseId / runId are attached to every relay from TRUSTED job params,
 *   never from the worker message (the worker can't spoof who it acts as).
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any> }} deps
 *   sendToSW relays a worker bridge message to the SW route of that name.
 */
const _runJob = async ({ code, timeoutMs = 30000, a2a = false, actors = false, ownerSessionId, ownerToolUseId, runId }, { sendToSW }) => {
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
    built = await buildWorkerSource(code, { entryPath: 'job.js', notebookId: jobId, resolverDeps, a2a, actors });
  } catch (e) {
    await opfs.nuke().catch(() => {});
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `import resolution failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  const { source, cache, bodyLine } = built;
  // Did this run reach the web? The fetch bridge below is the ONLY egress a
  // sealed worker has, so one flag here is authoritative. script fences the
  // run's output for the model when it's set (fetched bytes are untrusted).
  let usedEgress = false;
  // The DELEGATIONS trace — one entry per actors op this run made. This is the
  // observability spine of the script surface: the orchestrator reads it back
  // (which op, to whom, outcome, how long) even when the script itself failed
  // mid-way, and the ops keep flowing into it right up to a termination.
  /** @type {Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }>} */
  const actorsTrace = [];
  let actorsSeq = 0;
  let usedActors = false;
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
        resolve({ value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `job timed out after ${timeoutMs}ms`, usedEgress, usedActors, actorsTrace });
      }, timeoutMs);
      // Stop plumbing: a runId-carrying job can be terminated from the SW
      // (script tool abort). The trace survives — partial work stays visible.
      if (runId) {
        liveJobs.set(runId, () => {
          clearTimeout(timer);
          try { worker.terminate(); } catch {}
          resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: 'job aborted (Stop)', usedEgress, usedActors, actorsTrace });
        });
      }

      worker.addEventListener('message', async (ev) => {
        // why any: worker postMessage payload, discriminated by m.type below.
        /** @type {any} */
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        // Headless: no UI. console accumulates in the worker and rides 'done';
        // display() has no surface here (the agent should RETURN its result).
        if (m.type === 'log' || m.type === 'display') return;

        if (m.type === 'subagent-request') {
          // An a2a run is the dweb actor's MESH-ONLY surface. Its tool allow-set
          // grants no delegation (no spawn_subagent), so the worker's
          // peerd.runtime.runAgent must not re-grant it — refuse at the host, the
          // authoritative choke point (the worker surface can't be trusted).
          if (a2a) {
            worker.postMessage({ type: 'subagent-response', rid: m.rid, error: 'subagent spawn is disabled for a2a runs (the dweb actor does not delegate)' });
            return;
          }
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
        if (m.type === 'actors-request') {
          // Relay a delegation call to the SW actors/call route. The owner ids
          // ride from TRUSTED job params; the SW re-gates every op (sender gate,
          // rate caps, oneShot sandbox-only) — the worker's word buys nothing.
          if (!actors || typeof ownerSessionId !== 'string' || !ownerSessionId) {
            worker.postMessage({ type: 'actors-response', rid: m.rid, error: 'actors capability is disabled for this run' });
            return;
          }
          usedActors = true;   // actor replies are untrusted content → fence the run's output
          const seq = ++actorsSeq;
          const goalRaw = m?.args?.goal;
          /** @type {{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }} */
          const entry = {
            seq,
            method: typeof m.method === 'string' ? m.method : String(m.method),
            ...(typeof m?.args?.to === 'string' ? { to: m.args.to } : {}),
            ...(typeof goalRaw === 'string' ? { goal: goalRaw.slice(0, 200) } : {}),
            ok: false, ms: 0,
          };
          actorsTrace.push(entry);
          const t0 = performance.now();
          try {
            const resp = await sendToSW('actors/call', { method: m.method, args: m.args, ownerSessionId, ownerToolUseId, runId, seq });
            entry.ms = Math.round(performance.now() - t0);
            if (resp?.ok) {
              entry.ok = true;
              worker.postMessage({ type: 'actors-response', rid: m.rid, result: resp.value });
            } else {
              entry.error = resp?.error ?? 'actors call failed';
              worker.postMessage({ type: 'actors-response', rid: m.rid, error: entry.error });
            }
          } catch (e) {
            entry.ms = Math.round(performance.now() - t0);
            entry.error = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
            worker.postMessage({ type: 'actors-response', rid: m.rid, error: entry.error });
          }
          return;
        }
        if (m.type === 'a2a-request') {
          // Relay the mesh call to the SW a2a/call route. Refuse if the cap is
          // off or no trusted owner — the OWNER is attached from the job params
          // (ownerSessionId), NEVER from the worker message (which is untrusted).
          if (!a2a || typeof ownerSessionId !== 'string' || !ownerSessionId) {
            worker.postMessage({ type: 'a2a-response', rid: m.rid, error: 'mesh capability is disabled for this run' });
            return;
          }
          try {
            const resp = await sendToSW('a2a/call', { method: m.method, args: m.args, ownerSessionId });
            if (resp?.ok) worker.postMessage({ type: 'a2a-response', rid: m.rid, result: resp.value });
            else worker.postMessage({ type: 'a2a-response', rid: m.rid, error: resp?.error ?? 'mesh call failed' });
          } catch (e) {
            worker.postMessage({ type: 'a2a-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'fetch-request') {
          // Same envoy posture: the dweb actor has no egress (no fetch_url in its
          // allow-set). The a2a worker still carries the seal's bridged fetch +
          // peerd.egress.fetch, so the host is where we deny it — the mesh is the
          // ONLY outward edge an a2a run gets.
          if (a2a) {
            worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, bodyB64: null, error: 'egress is disabled for a2a runs (the dweb actor talks only to the mesh)' });
            return;
          }
          usedEgress = true;   // the run touched the web → its output carries untrusted bytes
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
          // Map blob-URL stack frames back to job.js:<line> — the model reads
          // this error; a user-code line number is actionable, a blob one isn't.
          const error = m.error ? mapWorkerError(m.error, blobUrl, bodyLine, 'job.js') : null;
          resolve({ value: m.value, consoleOutput: m.consoleOutput, durationMs: m.durationMs, error, usedEgress, usedActors, actorsTrace });
        }
      });

      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        try { worker.terminate(); } catch {}
        const detail = mapWorkerError(
          e.error?.stack || e.error?.message || e.message || 'worker crashed (no detail)',
          blobUrl, bodyLine, 'job.js');
        resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: `worker error: ${detail}`, usedEgress, usedActors, actorsTrace });
      });
    });
  } finally {
    if (runId) liveJobs.delete(runId);
    URL.revokeObjectURL(blobUrl);
    revokeCache();
    await opfs.nuke().catch(() => {});
  }
};
