// @ts-check
// offscreen/reasoning-runner.js — hosts PURE-REASONING subagent loops in
// dedicated Workers (heap-split phase 1), the reasoning sibling of job-runner.
//
// It forks ONE Worker per reasoning child (its own heap + thread), relays the
// worker's model-call requests to the SW (which alone holds the key and makes
// the real streaming call — accumulated and handed back), and resolves with the
// child's final result. Same relay shape job-runner uses for fetch/subagent, so
// the security posture is the same: the worker has no key, no chrome.*, and its
// only path outward is the model-call the SW gates.
//
// why a per-run worker (not a pool): a reasoning child is short and fire-once;
// a fresh Worker gives a clean heap and terminates on done/abort/timeout. Capped
// so a fan-out (or a runaway) can't fork-bomb the offscreen renderer.

const MAX_CONCURRENT = 4;
let active = 0;
let seq = 0;
// runId → live worker, so the SW can abort a specific in-flight run (Stop /
// subagent_cancel) by id, not just rely on the wall-clock timeout.
/** @type {Map<string, Worker>} */
const liveWorkers = new Map();

/** @param {string} runId */
export const abortReasoning = (runId) => {
  const w = liveWorkers.get(runId);
  if (w) { try { w.postMessage({ type: 'abort' }); } catch { /* already gone */ } }
};

/**
 * Run one pure-reasoning subagent in a dedicated Worker.
 * @param {{ runId?: string, sessionId: string, task: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps: number, maxOutputTokens?: number, reasoning?: object, contextWindow?: number, budgetMs?: number }} job
 * @param {{ workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any> }} deps
 *   sendToSW relays a worker bridge message to the SW route of that name (the
 *   'reasoning/model-call' route runs the real callModel with the SW's key).
 * @returns {Promise<{ ok: boolean, started?: boolean, finalText?: string, usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean }>}
 *   started:false ONLY when the worker never began (concurrency cap / spawn
 *   throw) → the caller may fall back to the in-SW loop. Every other outcome
 *   (done, error, timeout) is started:true — it may have billed model calls, so
 *   re-running in-SW would double-run.
 */
export const runReasoning = async (job, { workerUrl, sendToSW }) => {
  if (active >= MAX_CONCURRENT) {
    // NOT started → the caller may safely fall back to the in-SW loop (nothing ran).
    return { ok: false, started: false, error: `reasoning worker rejected: ${MAX_CONCURRENT} already running` };
  }
  active++;
  const runId = job.runId ?? `rw-${++seq}`;
  const budgetMs = Number.isFinite(job.budgetMs) && /** @type {number} */ (job.budgetMs) > 0
    ? /** @type {number} */ (job.budgetMs) : 10 * 60_000;
  /** @type {Worker | null} */
  let worker = null;
  try {
    worker = new Worker(workerUrl, { type: 'module' });
    liveWorkers.set(runId, worker);
    const w = worker;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (/** @type {any} */ v) => { if (!settled) { settled = true; resolve(v); } };
      // The wall-clock backstop: terminate a run that overruns its budget (the
      // same budget spawn.js arms in the SW — belt and suspenders across the
      // boundary) and report it aborted so the parent sees a partial.
      const timer = setTimeout(() => { try { w.terminate(); } catch { /* gone */ } finish({ ok: false, started: true, aborted: true, error: `reasoning timed out after ${budgetMs}ms` }); }, budgetMs);

      w.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
        const m = /** @type {any} */ (ev.data);
        if (!m || typeof m !== 'object') return;
        if (m.type === 'model-request') {
          try {
            // Thread runId so the SW route can correlate + abort THIS run's
            // in-flight (key-bearing) provider call when the child is stopped.
            const resp = await sendToSW('reasoning/model-call', { runId, args: m.args });
            if (resp?.ok) w.postMessage({ type: 'model-response', rid: m.rid, events: resp.events ?? [] });
            else w.postMessage({ type: 'model-error', rid: m.rid, error: resp?.error ?? 'model call failed' });
          } catch (e) {
            w.postMessage({ type: 'model-error', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'loop-event') {
          // Fire-and-forget: re-emit the child's loop event to the SW so it reaches
          // the subagent card + cost meter. Never awaited — it must not block the run.
          sendToSW('reasoning/loop-event', { runId, event: m.event }).catch(() => {});
          return;
        }
        if (m.type === 'done') {
          clearTimeout(timer);
          try { w.terminate(); } catch { /* gone */ }
          const r = m.result ?? {};
          // A completed-but-errored run (the loop yielded an error and no text) is
          // NOT a start failure — it ran, and may have billed model calls — so it
          // must NOT fall back to the in-SW loop (that would double-run). started:true.
          if (r.error) finish({ ok: false, started: true, error: r.error, finalText: r.finalText ?? '', usage: r.usage, stopReason: r.stopReason });
          else finish({ ok: true, started: true, finalText: r.finalText ?? '', usage: r.usage, stopReason: r.stopReason, toolCalls: r.toolCalls ?? 0 });
        }
        if (m.type === 'error') {
          clearTimeout(timer);
          try { w.terminate(); } catch { /* gone */ }
          // The worker threw AFTER starting — surface it, don't fall back.
          finish({ ok: false, started: true, error: m.error ?? 'reasoning worker error' });
        }
      });
      w.addEventListener('error', (/** @type {any} */ e) => {
        clearTimeout(timer);
        try { w.terminate(); } catch { /* gone */ }
        // Crashed after fork → started:true (don't re-run; may have billed).
        finish({ ok: false, started: true, error: `reasoning worker crashed: ${e?.message ?? 'no detail'}` });
      });
      // Kick the run.
      w.postMessage({
        type: 'run', runId, sessionId: job.sessionId, task: job.task, systemPrompt: job.systemPrompt,
        provider: job.provider, model: job.model, depth: job.depth,
        maxSteps: job.maxSteps, maxOutputTokens: job.maxOutputTokens,
        reasoning: job.reasoning, contextWindow: job.contextWindow,
      });
    });
  } catch (e) {
    // The worker never started (spawn threw) → safe to fall back to the in-SW loop.
    return { ok: false, started: false, error: `reasoning worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  } finally {
    liveWorkers.delete(runId);
    active--;
  }
};
