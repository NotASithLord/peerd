// @ts-check
// background/offscreen-actor-client.js — the SW-side client for EVERY offscreen
// agent loop (the heap split): ephemeral spawned reasoners (spawn.js) AND bound
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
 * @param {(ctx: any, allowedNames: Set<string>) => any} [deps.restrictCtxCapabilities]  phase 4:
 *   strip an actor ctx down to the capabilities its GRANTED tools need (capability-by-need),
 *   the analog of the actor's kind-scoped strip. Required to run tool-bearing spawned offscreen.
 * @param {(actorSessionId: string) => (number | undefined)} [deps.ownedTabFor]  a
 *   tab-backed WEB actor's currently-owned tab id (phase 3) — read per dispatch so a
 *   mid-turn navigate that adopts a tab (0→1) is seen by the NEXT tool call. undefined
 *   for engine/API actors (no tab) and the 0-tab web state.
 * @param {string} deps.EXPOSURE_ACTOR
 * @param {string} [deps.EXPOSURE_REVIEW]  issue 160 - the review-exemption marker. A review
 *   child's session record carries `review:true` (persisted SW-side at spawn); the
 *   tool-dispatch route re-stamps ctx.exposure from it so the tier gate admits the
 *   three instance reads on the offscreen path too, not just the in-SW fallback.
 *   Optional and fail-closed: not injected → nothing is ever stamped.
 * @param {() => number} [deps.now]
 * @param {(call: Record<string, any>) => void} [deps.recordModelCall]  the context
 *   inspector's capture hook — fed every delegated model call with the runMeta-derived
 *   identity (never the worker's own claim). Optional; defaults to a no-op.
 * @param {(msg: Record<string, any>) => void} [deps.broadcastOp]  announce each settled
 *   ACTOR tool dispatch on the UI ports ('actor/op' — name/args/ok, observability only).
 *   The offscreen heap emits no turn/tool-use, so this is how the eval harness's OM2W
 *   recorder (and any activity view) sees what an actor did. Optional; defaults to a no-op.
 * @param {(sender: unknown) => boolean} [deps.isOffscreenSender]  is this message from the
 *   OFFSCREEN DOCUMENT? The three relay routes below refuse anything else. REQUIRED in
 *   production and fail-CLOSED by omission (an unwired client refuses every relay), because
 *   this is the boundary, not a hint — see the grants-map note for why the token alone is
 *   not sufficient.
 * @param {() => string} [deps.mintRelayToken]  mints the per-run relay grant (below).
 *   Injected so the grant is testable without a browser; defaults to crypto.randomUUID.
 * @param {(sessionId: string) => Promise<string | null>} [deps.spendRefusalFor]  spend-limit
 *   preflight for a relayed model call: resolves a refusal MESSAGE when the run's owning
 *   chat session is past the user's hard cap, or null to proceed. Optional and
 *   fail-OPEN by omission (an unwired client behaves as before) — the cap is a coarse
 *   safety lever, and refusing every actor call because a dep is missing would break
 *   the lane outright.
 */
export const makeOffscreenActorClient = ({
  ensureOffscreen, sendMessage, callModel, getSecret, safeFetch,
  sessions, buildToolContext, dispatchToolCall, pinActorCall, restrictCtxCapabilities, ownedTabFor, EXPOSURE_ACTOR, EXPOSURE_REVIEW, now = Date.now,
  recordModelCall = () => {},
  broadcastOp = (/** @type {any} */ _msg) => {},
  mintRelayToken = () => globalThis.crypto.randomUUID(),
  spendRefusalFor = undefined,
  isOffscreenSender = () => false,
}) => {
  let seq = 0;
  /**
   * @type {Map<string, { runId: string, actorSessionId: string }>} relay grants:
   * token → the identity of the run it was minted for.
   *
   * why a grant and not the message's own `actorSessionId`/`runId`: these three routes
   * ride the ONE runtime.onMessage surface, whose only guard is `isFirstPartySender` —
   * "some extension context of ours", which is every engine tab page and the side panel,
   * not "the offscreen doc running this actor". Trusting the payload's identity therefore
   * let ANY first-party page dispatch a tool as an arbitrary actor session (inheriting
   * that actor's instance pin and granted tools) or spend the user's key on a dead run.
   *
   * The token is minted SW-side per run, travels in the job to the offscreen runner, and
   * comes back on every relay call; identity is DERIVED from it, so the payload's claim
   * buys nothing. It is deleted when the run settles, which makes it a liveness check
   * too — a late or replayed relay from a finished run is refused, the same posture
   * script/model-call gets from its owner check.
   *
   * The Worker never receives the token (the runner holds it and stamps it on outbound
   * relays), so it stays a host-side binding, not a secret the untrusted heap can leak.
   *
   * The token is NOT a secret from other extension pages, though, and must not be treated
   * as one: `runtime.sendMessage` has no way to address a single extension context, so the
   * `actor/run` job — token included — is broadcast to every listener in the extension,
   * including the engine tab pages named above. That is why every route ALSO requires
   * `isOffscreenSender`. The sender check is the boundary; the token adds run identity and
   * liveness on top of it. Either alone is insufficient: the sender check cannot say WHICH
   * run is speaking, and the token cannot say who is holding it.
   */
  const grants = new Map();
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
  /** @type {Map<string, { sessionId: string, label: string }>} runId → identity for the
   * context inspector: the model-call route only carries runId + body args, so the
   * session (and a human label for WHOSE call this is) is stashed at run() time. */
  const runMeta = new Map();
  /** @type {Map<string, AbortSignal>} sessionId → the in-flight run's abort signal.
   * Phase 4: an actor's BLOCKING tool (message_actor awaitReply) runs SW-side via the
   * relay and races the reply against the child's cancel; the child's signal is only
   * visible at run() time, so stash it here for the tool-dispatch route to read. One run
   * per session at a time (turn slots serialize), so a plain Map is enough. */
  const signalBySession = new Map();

  /**
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindow?: number, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabUrl?: string, origin?: string }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   */
  const run = async (job, { signal, onEvent } = {}) => {
    await ensureOffscreen();
    const runId = `aw-${now().toString(36)}-${++seq}`;
    const relayToken = mintRelayToken();
    grants.set(relayToken, { runId, actorSessionId: job.actorSessionId });
    if (onEvent) runOnEvent.set(runId, onEvent);
    runMeta.set(runId, {
      sessionId: job.actorSessionId,
      label: job.actorType ? `actor:${job.actorType}` : `actor d${job.depth ?? 1}`,
    });
    const abortRun = () => {
      abortedRuns.add(runId);   // cover a model-call that hasn't reached the route yet
      for (const ac of inflight.get(runId) ?? []) { try { ac.abort(); } catch { /* already */ } }
      sendMessage({ type: 'actor/abort', runId }).catch(() => {});
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', abortRun, { once: true });
    else if (signal?.aborted) abortRun();
    if (signal) signalBySession.set(job.actorSessionId, signal);   // phase 4: blocking-tool cancel race
    try {
      const result = await sendMessage({ type: 'actor/run', job: { ...job, runId, relayToken } });
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
      // Retiring the grant is what makes it a liveness check: every relay for
      // this run is refused from here on, so a late/replayed one can't dispatch.
      grants.delete(relayToken);
      runOnEvent.delete(runId);
      runMeta.delete(runId);
      inflight.delete(runId);
      abortedRuns.delete(runId);
      if (signal && signalBySession.get(job.actorSessionId) === signal) signalBySession.delete(job.actorSessionId);
    }
  };

  /**
   * Resolve a relay's identity: the sender must be the offscreen document AND the
   * message must carry a live grant token. Returns null for anything else — a
   * non-offscreen page, a missing/unknown/retired token — and every route treats
   * that as a hard refusal, so an unauthorized caller learns nothing beyond "no".
   * @param {{ relayToken?: unknown }} [msg]
   * @param {unknown} [sender]  the second argument makeDispatcher hands a handler
   * @returns {{ runId: string, actorSessionId: string } | null}
   */
  const grantFor = (msg, sender) => {
    if (!isOffscreenSender(sender)) return null;
    const token = msg?.relayToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return grants.get(token) ?? null;
  };

  const routes = {
    /**
     * @param {{ relayToken?: string, args?: object }} [msg] - the model call: key+egress added HERE.
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/model-call': async (msg = {}, sender = undefined) => {
      // Identity from the offscreen sender + the grant, never from the message:
      // this route adds the user's key to whatever it forwards, so an
      // unauthorized caller must not be able to name a run at all.
      const grant = grantFor(msg, sender);
      if (!grant) return { ok: false, error: 'actor/model-call: unauthorized relay' };
      const { runId } = grant;
      const args = msg.args;
      const key = runId;
      // Race guard 1: a Stop that fired BEFORE this call reached the route (the card
      // appears first) → refuse without ever making the key-bearing request.
      if (abortedRuns.has(key)) return { ok: false, error: 'aborted' };
      // Spend-limit preflight, script/model-call's posture applied to the actor lane:
      // an actor's model calls spend the user's money on the OWNING chat session, so a
      // session past the hard cap must not be pushed further by its own actors. Without
      // this the cap bounded the orchestrator's turns only, and any actor fan-out
      // walked straight past it.
      if (spendRefusalFor) {
        const refusal = await spendRefusalFor(grant.actorSessionId).catch(() => null);
        if (refusal) return { ok: false, error: refusal };
      }
      const ac = new AbortController();
      const set = inflight.get(key) ?? new Set();
      set.add(ac); inflight.set(key, set);
      // The context inspector sees every DELEGATED model call here — the one
      // relay every actor and actor heap uses. Identity comes from the
      // runMeta stash, never the worker's args (a worker must not be able to
      // relabel whose context this was).
      const meta = runMeta.get(key);
      if (meta) recordModelCall({ ...(args ?? {}), sessionId: meta.sessionId, label: meta.label });
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
    /**
     * @param {{ relayToken?: string, call?: any }} [msg] - SW-side ctx build + gate + dispatch.
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/tool-dispatch': async (msg = {}, sender = undefined) => {
      try {
        // The session comes from the offscreen-pinned GRANT, not the message. This is
        // the route that builds an instance-pinned, tool-granting context, so a caller
        // that could name its own session would inherit any actor's pin and toolset.
        const grant = grantFor(msg, sender);
        if (!grant) return { ok: false, error: 'actor/tool-dispatch: unauthorized relay' };
        const { actorSessionId } = grant;
        const call = msg.call;
        const rec = await sessions.get(actorSessionId);
        if (!rec) return { ok: false, error: 'actor/tool-dispatch: unknown session' };

        // Phase 4 — a spawned child is a tool-bearing EPHEMERAL actor. Its toolset is the
        // NARROWED-GENERAL set persisted at spawn (rec.grantedTools), not an instance
        // pin. Rebuild its restricted ctx SW-side EXACTLY as the in-SW spawn path does
        // (buildToolContext → audit-tag → abortSignal → restrictCtxCapabilities over the
        // granted set) and re-check the relayed call against grantedTools first — the
        // worker's call args (shaped by tool output it read) are never trusted, the same
        // defense-in-depth as the actor pin.
        if (rec.kind === 'spawned') {
          if (!restrictCtxCapabilities) return { ok: false, error: 'actor/tool-dispatch: actor offscreen not wired' };
          const granted = new Set(Array.isArray(rec.grantedTools) ? rec.grantedTools : []);
          if (typeof call?.name !== 'string' || !granted.has(call.name)) return { ok: false, error: `tool_not_available_to_actor: ${call?.name}` };
          const base = await buildToolContext({ sessionId: actorSessionId });
          const sig = signalBySession.get(/** @type {string} */ (actorSessionId));
          // Stamp the child lineage on every audit its tools emit (parity with spawn.js's taggedAudit).
          const audit = (/** @type {any} */ entry) => /** @type {any} */ (base).audit?.({ ...entry, details: { ...(entry?.details ?? {}), parentSessionId: rec.parentSessionId, actorSessionId, depth: rec.depth } });
          // #160: re-stamp the review-exemption marker from the PERSISTED record
          // (spawn.js writes rec.review SW-side at create; no worker or model arg
          // can reach it). why here: this route rebuilds ctx from the record alone,
          // so without the stamp the tier gate saw exposure undefined and refused
          // the three instance reads — the exemption only worked on the in-SW
          // fallback path. Fail-closed: rec.review !== true, or no injected
          // EXPOSURE_REVIEW, stamps nothing.
          const ctx = restrictCtxCapabilities({
            ...base, audit, ...(sig ? { abortSignal: sig } : {}),
            ...(rec.review === true && EXPOSURE_REVIEW ? { exposure: EXPOSURE_REVIEW } : {}),
          }, granted);
          const result = await dispatchToolCall(call, ctx);
          return { ok: true, result };
        }

        if (rec.kind !== 'actor') return { ok: false, error: 'actor/tool-dispatch: not an actor or actor session' };
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
        // Announce the settled dispatch — pure observability, zero authority
        // (the gated dispatch already ran; consumers see name/args/ok only).
        // why: an OFFSCREEN actor turn emits no turn/tool-use broadcast (that
        // path is turn-driver's, in-SW only) — without this the eval harness's
        // OM2W recorder can't see the actor's page actions. Best-effort.
        try {
          broadcastOp({
            type: 'actor/op', sessionId: actorSessionId,
            name: call?.name, args: call?.args ?? {}, ok: result?.ok !== false,
          });
        } catch { /* display-only */ }
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    /**
     * @param {{ relayToken?: string, event?: object }} [msg]
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/loop-event': (msg = {}, sender = undefined) => {
      // Lowest-authority of the three (it only feeds the actor card + cost meter),
      // but bound the same way: an unauthorized sender could otherwise inject
      // fabricated progress/cost events into another run's UI.
      const grant = grantFor(msg, sender);
      if (!grant) return { ok: false, error: 'actor/loop-event: unauthorized relay' };
      try { if (msg.event) runOnEvent.get(grant.runId)?.(msg.event); } catch { /* never break the relay */ }
      return { ok: true };
    },
  };

  return { run, routes };
};
