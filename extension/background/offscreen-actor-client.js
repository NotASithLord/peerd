// @ts-check
// background/offscreen-actor-client.js — SW-side client for BOUND-actor loops
// running in an offscreen Worker (heap-split phase 2). Self-contained routes
// (its own model-call + loop-event + tool-dispatch, separate from the reasoning
// client's, so the two never tangle registries).
//
// The security-critical route is 'actor/tool-dispatch': the worker's loop
// asks to run a tool; THIS builds the actor's instance-PINNED, gated tool
// context and dispatches there — the pin, the gate, the engine clients, the
// tabs, and the audit are ALL SW-side. It NEVER trusts the worker's call args
// (they may derive from injected instance output): it re-pins the bound
// instance and runs the full gate, exactly as the in-SW actor turn does.
//
// Pure shell — every IO injected — so it is unit-testable without a browser.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {(msg: object) => Promise<any>} deps.sendMessage
 * @param {(args: object) => AsyncIterable<any>} deps.callModel
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.safeFetch
 * @param {{ get: (id: string) => Promise<any> }} deps.sessions
 * @param {(opts: object) => Promise<object>} deps.buildToolContext
 * @param {(call: object, ctx: object) => Promise<any>} deps.dispatchToolCall
 * @param {(call: any, actorType: string|undefined, instanceId: string|undefined) => void} deps.pinActorCall
 * @param {string} deps.EXPOSURE_ACTOR
 * @param {() => number} [deps.now]
 */
export const makeOffscreenActorClient = ({
  ensureOffscreen, sendMessage, callModel, getSecret, safeFetch,
  sessions, buildToolContext, dispatchToolCall, pinActorCall, EXPOSURE_ACTOR, now = Date.now,
}) => {
  let seq = 0;
  /** @type {Map<string, Set<AbortController>>} runId → in-flight model-call controllers */
  const inflight = new Map();
  /** @type {Map<string, (ev: object) => void>} runId → onEvent */
  const runOnEvent = new Map();

  /**
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindow?: number, budgetMs?: number }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   */
  const run = async (job, { signal, onEvent } = {}) => {
    await ensureOffscreen();
    const runId = `aw-${now().toString(36)}-${++seq}`;
    if (onEvent) runOnEvent.set(runId, onEvent);
    const abortRun = () => {
      for (const ac of inflight.get(runId) ?? []) { try { ac.abort(); } catch { /* already */ } }
      sendMessage({ type: 'actor/abort', runId }).catch(() => {});
    };
    if (signal) { if (signal.aborted) abortRun(); else signal.addEventListener('abort', abortRun, { once: true }); }
    try {
      return await sendMessage({ type: 'actor/run', job: { ...job, runId } });
    } finally {
      runOnEvent.delete(runId);
      inflight.delete(runId);
    }
  };

  const routes = {
    /** @param {{ runId?: string, args?: object }} [msg] - the model call: key+egress added HERE. */
    'actor/model-call': async ({ runId, args } = {}) => {
      const ac = new AbortController();
      const key = runId ?? '';
      const set = inflight.get(key) ?? new Set();
      set.add(ac); inflight.set(key, set);
      /** @type {any[]} */
      const events = [];
      try {
        for await (const ev of callModel({ ...(args ?? {}), getSecret, safeFetch, signal: ac.signal })) events.push(ev);
        return { ok: true, events };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      } finally {
        set.delete(ac); if (set.size === 0) inflight.delete(key);
      }
    },
    /** @param {{ actorSessionId?: string, call?: any }} [msg] - SW-side pin + gate + dispatch. */
    'actor/tool-dispatch': async ({ actorSessionId, call } = {}) => {
      try {
        const rec = actorSessionId ? await sessions.get(actorSessionId) : null;
        if (!rec || rec.kind !== 'actor') return { ok: false, error: 'actor/tool-dispatch: not an actor session' };
        // Phase 2 is engine kinds (vm/notebook/app); a web actor (needs a tab) is phase 3.
        if (rec.actorType === 'web') return { ok: false, error: 'actor/tool-dispatch: web actor not supported offscreen yet' };
        const ctx = await buildToolContext({
          exposure: EXPOSURE_ACTOR, sessionId: actorSessionId,
          actorInstanceId: rec.instanceId, actorType: rec.actorType, actorBacking: rec.backing,
        });
        // Re-pin to the BOUND instance — the worker's call args are never trusted.
        pinActorCall(call, rec.actorType, rec.instanceId);
        const result = await dispatchToolCall(call, ctx);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    /** @param {{ runId?: string, event?: object }} [msg] */
    'actor/loop-event': ({ runId, event } = {}) => {
      try { if (event) runOnEvent.get(runId ?? '')?.(event); } catch { /* never break the relay */ }
      return { ok: true };
    },
  };

  return { run, routes };
};
