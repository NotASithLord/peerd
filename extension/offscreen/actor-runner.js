// @ts-check
// offscreen/actor-runner.js — hosts EVERY offscreen agent loop in dedicated Workers
// (the heap split): ephemeral reasoning subagents AND bound actors alike (a reasoning
// child just carries no tools, so its worker never sends a tool-request). Forks one
// Worker per turn, relays its model-call AND tool-dispatch requests to the SW (which
// holds the key, engine clients, instance pin, and gate), forwards its loop events,
// and resolves with the turn result.

const MAX_CONCURRENT = 4;
let active = 0;
let seq = 0;
/** @type {Map<string, Worker>} */
const liveWorkers = new Map();

/** @param {string} runId */
export const abortActor = (runId) => {
  const w = liveWorkers.get(runId);
  if (w) { try { w.postMessage({ type: 'abort' }); } catch { /* gone */ } }
};

/**
 * Run one BOUND-actor turn in a dedicated Worker.
 * @param {{ runId?: string, actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindow?: number, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabUrl?: string, origin?: string }} job
 * @param {{ workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any> }} deps
 * @returns {Promise<{ ok: boolean, started?: boolean, finalText?: string, newMessages?: any[], usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean }>}
 */
export const runActor = async (job, { workerUrl, sendToSW }) => {
  if (active >= MAX_CONCURRENT) return { ok: false, started: false, error: `actor worker rejected: ${MAX_CONCURRENT} already running` };
  active++;
  const runId = job.runId ?? `aw-${++seq}`;
  const budgetMs = Number.isFinite(job.budgetMs) && /** @type {number} */ (job.budgetMs) > 0 ? /** @type {number} */ (job.budgetMs) : 10 * 60_000;
  /** @type {Worker | null} */
  let worker = null;
  try {
    worker = new Worker(workerUrl, { type: 'module' });
    liveWorkers.set(runId, worker);
    const w = worker;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (/** @type {any} */ v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => { try { w.terminate(); } catch { /* gone */ } finish({ ok: false, started: true, aborted: true, error: `actor timed out after ${budgetMs}ms` }); }, budgetMs);

      w.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
        const m = /** @type {any} */ (ev.data);
        if (!m || typeof m !== 'object') return;
        if (m.type === 'model-request') {
          try {
            const resp = await sendToSW('actor/model-call', { runId, args: m.args });
            if (resp?.ok) w.postMessage({ type: 'model-response', rid: m.rid, events: resp.events ?? [] });
            else w.postMessage({ type: 'model-error', rid: m.rid, error: resp?.error ?? 'model call failed' });
          } catch (e) { w.postMessage({ type: 'model-error', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); }
          return;
        }
        if (m.type === 'tool-request') {
          try {
            // The SW pins the bound instance + gates + dispatches (never trusts the
            // worker's call args) and returns the ToolResult. actorSessionId keys
            // the actor ctx it builds.
            const reply = await sendToSW('actor/tool-dispatch', { runId, actorSessionId: job.actorSessionId, call: m.call });
            w.postMessage({ type: 'tool-response', rid: m.rid, reply });
          } catch (e) { w.postMessage({ type: 'tool-response', rid: m.rid, reply: { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) } }); }
          return;
        }
        if (m.type === 'loop-event') { sendToSW('actor/loop-event', { runId, event: m.event }).catch(() => {}); return; }
        if (m.type === 'done') {
          clearTimeout(timer); try { w.terminate(); } catch { /* gone */ }
          const r = m.result ?? {};
          // No `aborted` here: a Stop-cascade is stamped at the SW client (which alone
          // sees signal.aborted AND whether a reply came back). The runner only marks
          // `aborted` for its OWN wall-clock timeout below.
          if (r.error) finish({ ok: false, started: true, error: r.error, finalText: r.finalText ?? '', newMessages: r.newMessages ?? [], usage: r.usage, stopReason: r.stopReason });
          else finish({ ok: true, started: true, finalText: r.finalText ?? '', newMessages: r.newMessages ?? [], usage: r.usage, stopReason: r.stopReason, toolCalls: r.toolCalls ?? 0 });
        }
        if (m.type === 'error') {
          clearTimeout(timer); try { w.terminate(); } catch { /* gone */ }
          finish({ ok: false, started: true, error: m.error ?? 'actor worker error' });
        }
      });
      w.addEventListener('error', (/** @type {any} */ e) => {
        clearTimeout(timer); try { w.terminate(); } catch { /* gone */ }
        finish({ ok: false, started: true, error: `actor worker crashed: ${e?.message ?? 'no detail'}` });
      });
      w.postMessage({
        type: 'run', runId, sessionId: job.actorSessionId, message: job.message, systemPrompt: job.systemPrompt,
        provider: job.provider, model: job.model, depth: job.depth, tools: job.tools ?? [],
        // priorMessages seeds the actor's history — a bound actor is STATEFUL
        // across turns (dropping it made every offscreen turn amnesiac).
        priorMessages: job.priorMessages ?? [],
        maxSteps: job.maxSteps, maxOutputTokens: job.maxOutputTokens, reasoning: job.reasoning, contextWindow: job.contextWindow,
        // Phase 3: oneShot loop mode (parity with the in-SW delegation path) + the
        // web/API actor's self-fence provenance (actorType/backing/tabUrl/origin →
        // the worker rebuilds ctx.fenceActorSummary). Undefined for engine actors.
        oneShot: job.oneShot, actorType: job.actorType, backing: job.backing, tabUrl: job.tabUrl, origin: job.origin,
      });
    });
  } catch (e) {
    return { ok: false, started: false, error: `actor worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  } finally {
    liveWorkers.delete(runId);
    active--;
  }
};
