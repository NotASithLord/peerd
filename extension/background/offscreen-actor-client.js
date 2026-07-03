// @ts-check
// background/offscreen-actor-client.js — the SW-side client for EVERY offscreen
// agent loop (the heap split): ephemeral reasoning subagents (spawn.js) AND bound
// actors (the actor turn). One client, one set of routes (model-call + tool-dispatch
// + loop-event); a reasoning child grants no tools, so it only ever exercises
// model-call.
//
// The security-critical route is 'actor/tool-dispatch': the worker's loop asks to run
// a tool; THIS builds the actor's instance-PINNED, gated tool context and dispatches
// there — the pin, the gate, the engine clients, the tabs, and the audit are ALL
// SW-side. It NEVER trusts the worker's call args (they may derive from injected
// instance/page output): it re-pins the bound instance and runs the full gate,
// exactly as the in-SW actor turn does.
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
 * @param {(actorSessionId: string) => (number | undefined)} [deps.ownedTabFor]  a
 *   tab-backed WEB actor's currently-owned tab id (phase 3) — read per dispatch so a
 *   mid-turn navigate that adopts a tab (0→1) is seen by the NEXT tool call. undefined
 *   for engine/API actors (no tab) and the 0-tab web state.
 * @param {string} deps.EXPOSURE_ACTOR
 * @param {() => number} [deps.now]
 */
export const makeOffscreenActorClient = ({
  ensureOffscreen, sendMessage, callModel, getSecret, safeFetch,
  sessions, buildToolContext, dispatchToolCall, pinActorCall, ownedTabFor, EXPOSURE_ACTOR, now = Date.now,
}) => {
  let seq = 0;
  /** @type {Map<string, Set<AbortController>>} runId → in-flight model-call controllers */
  const inflight = new Map();
  /** @type {Set<string>} runIds a Stop/cancel already fired for. why: the actor card
   * (turn/actor-start) appears BEFORE the worker's first model-call reaches the route,
   * so a Stop can fire while `inflight` is still empty — aborting nothing, and the
   * later model-call would run uncancelled. This set closes that race: a model-call for
   * an already-aborted run is refused, and one already streaming is failed post-hoc even
   * if its stream fulfilled anyway (a fake / a provider that flushed before cancel). */
  const abortedRuns = new Set();
  /** @type {Map<string, (ev: object) => void>} runId → onEvent */
  const runOnEvent = new Map();

  /**
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindow?: number, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabUrl?: string, origin?: string }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   */
  const run = async (job, { signal, onEvent } = {}) => {
    await ensureOffscreen();
    const runId = `aw-${now().toString(36)}-${++seq}`;
    if (onEvent) runOnEvent.set(runId, onEvent);
    const abortRun = () => {
      abortedRuns.add(runId);   // cover a model-call that hasn't reached the route yet
      for (const ac of inflight.get(runId) ?? []) { try { ac.abort(); } catch { /* already */ } }
      sendMessage({ type: 'actor/abort', runId }).catch(() => {});
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', abortRun, { once: true });
    else if (signal?.aborted) abortRun();
    try {
      const result = await sendMessage({ type: 'actor/run', job: { ...job, runId } });
      // Stop / cancel cascade: `signal.aborted` HERE is the authoritative proof a Stop
      // hit THIS run — and the one place it's reliably observable. The worker unwinds an
      // abort several ways (a rejected relay, a model-error from the SW route, or the
      // 'abort' message) and can even finish CLEANLY (no error event, empty reply) that
      // looks like a natural end at the result shape. So stamp `aborted` whenever the
      // signal fired and the turn produced NO reply — the caller then renders the actor
      // card 'cancelled' (not a blank 'ok'/'failed') and spawn.js records stopReason
      // 'aborted'. A run that produced text just before Stop (raced) keeps its result.
      if (signal?.aborted && result && !result.finalText) result.aborted = true;
      return result;
    } finally {
      // Drop the abort listener a completed-without-Stop run left attached (a no-op if
      // it already fired under {once:true}); keeps nothing dangling on the turn signal.
      signal?.removeEventListener('abort', abortRun);
      runOnEvent.delete(runId);
      inflight.delete(runId);
      abortedRuns.delete(runId);
    }
  };

  const routes = {
    /** @param {{ runId?: string, args?: object }} [msg] - the model call: key+egress added HERE. */
    'actor/model-call': async ({ runId, args } = {}) => {
      const key = runId ?? '';
      // Race guard 1: a Stop that fired BEFORE this call reached the route (the card
      // appears first) → refuse without ever making the key-bearing request.
      if (abortedRuns.has(key)) return { ok: false, error: 'aborted' };
      const ac = new AbortController();
      const set = inflight.get(key) ?? new Set();
      set.add(ac); inflight.set(key, set);
      /** @type {any[]} */
      const events = [];
      try {
        for await (const ev of callModel({ ...(args ?? {}), getSecret, safeFetch, signal: ac.signal })) events.push(ev);
        // Race guard 2: a Stop that fired DURING the call → honor it even if the stream
        // still fulfilled (a fake responder, or a provider that flushed before cancel),
        // so a mid-call abort never delivers a completed turn.
        if (ac.signal.aborted || abortedRuns.has(key)) return { ok: false, error: 'aborted' };
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
        // Phase 3: a WEB actor (kind 'web', backing tab) OWNS one tab; its DOM tools
        // must target THAT tab and the origin/denylist gate must see its origin.
        // Resolve the owned tab id HERE, per dispatch (never trust the worker), so a
        // mid-turn navigate that adopts a tab is seen by the next call. buildToolContext
        // FAILS CLOSED if the id is stale (leaves activeTab unset — never the user's
        // foreground). An API actor (backing 'api') has no tab → activeTabId stays
        // undefined; an engine actor acts on its instance → also undefined.
        const activeTabId = (rec.actorType === 'web' && rec.backing !== 'api' && ownedTabFor)
          ? ownedTabFor(/** @type {string} */ (actorSessionId))
          : undefined;
        const ctx = await buildToolContext({
          exposure: EXPOSURE_ACTOR, sessionId: actorSessionId, activeTabId,
          actorInstanceId: rec.instanceId, actorType: rec.actorType, actorBacking: rec.backing,
        });
        // Re-pin to the BOUND instance — the worker's call args are never trusted.
        // (A no-op for web DOM tools, whose numeric-tab pin the GATE enforces via
        // ctx.activeTab; still runs so engine/edit_file calls normalize.)
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
