// @ts-check
// background/routes/actors.js — the `script` tool's actors-in-code relay.
//
// A sealed headless worker can choreograph local actors with actors.list/call.
// This route translates each call back into the EXISTING actor machinery; it does
// not create a second authority path. The live run, owner, narrowed tool grant,
// sender lineage, rate caps, dedupe, audit, and Stop signal are all re-checked
// SW-side on every operation.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: unknown) => Promise<any>>}
 */
export const makeActorsRoutes = (deps) => {
  const {
    sessions, uiPorts, buildToolContext, dispatchToolCall, actorMessaging,
    scriptRuns, actorsCallToOp, shapeActorsResult, askOutcome,
    ACTORS_ASK_DEFAULT_TIMEOUT_MS, resolveManifestAllow, isOffscreenSender,
  } = deps;

  /**
   * The code bridge must never widen the caller's model-facing tool surface.
   * A spawned actor's persisted grant is already the manifest-intersected,
   * narrowed source of truth; a chat session resolves its manifest directly.
   * null means the chat has no manifest and keeps the historical full surface.
   * @param {Record<string, any>} owner
   * @returns {Set<string> | null}
   */
  const ownerAllow = (owner) => owner.kind === 'spawned'
    ? new Set(Array.isArray(owner.grantedTools) ? owner.grantedTools : [])
    : resolveManifestAllow(owner.toolManifest);

  return {
    'actors/call': async (msg = {}, sender = undefined) => {
      const pushOp = (/** @type {string} */ phase, /** @type {object} */ extra = {}) => {
        try {
          uiPorts.broadcast({
            type: 'script/op',
            sessionId: msg.ownerSessionId, toolUseId: msg.ownerToolUseId ?? null,
            seq: msg.seq ?? 0, method: msg.method ?? '?', phase, ...extra,
          });
        } catch { /* panel closed — the trace in the result still records it */ }
      };

      try {
        // why exact provenance, not merely makeDispatcher's first-party wall:
        // runtime.sendMessage broadcasts the SW-minted job params to every
        // extension page. This route carries the owning session's actor
        // authority, so only the offscreen job host may redeem a live run.
        if (!isOffscreenSender(sender)) {
          return { ok: false, error: 'actors: unauthorized relay' };
        }
        // Reject a dead, foreign, non-actors, or already-Stopped run before an
        // IDB session read. A worker past its operation limit cannot turn this
        // route into an unbounded storage-read relay either.
        if (typeof msg.runId !== 'string'
          || scriptRuns.ownerFor(msg.runId) !== msg.ownerSessionId
          || scriptRuns.allows?.(msg.runId, 'actors') !== true) {
          return { ok: false, error: 'actors: unknown, finished, or foreign script run' };
        }
        const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
        // Bound environment actors remain intentionally non-delegating: their
        // authority is one pinned environment. A spawned actor is different —
        // trusted-lineage message_actor already admits it, so code gets parity
        // only when that exact tool survived its narrowed persisted grant.
        if (!owner || owner.kind === 'actor') {
          return { ok: false, error: 'actors: only a chat session or a granted spawned actor holds the script delegation surface' };
        }
        const { op, args } = actorsCallToOp({ method: msg.method, args: msg.args });
        const requiredTool = op === 'list' ? 'actor_list' : 'message_actor';
        const allow = ownerAllow(owner);
        if (allow instanceof Set && !allow.has(requiredTool)) {
          return { ok: false, error: `actors.${op}: '${requiredTool}' is not granted to this session` };
        }
        if (scriptRuns.admitActorOp?.(msg.runId) !== true) {
          return { ok: false, error: 'actors: this script run reached its delegation-operation limit' };
        }

        if (op === 'list') {
          // The roster still runs through the normal dispatcher/gates. The
          // explicit allow check above is the spawned-grant wall that a generic
          // buildToolContext does not reconstruct on its own.
          const listCtx = await buildToolContext({ exposure: 'main', sessionId: msg.ownerSessionId });
          const result = await dispatchToolCall({
            id: `${msg.runId}-list-${msg.seq ?? 0}`, name: 'actor_list', args: {},
          }, listCtx);
          return result?.ok
            ? { ok: true, value: shapeActorsResult('list', {
              ok: true, refs: Array.isArray(result.structured?.refs) ? result.structured.refs : [],
            }) }
            : { ok: false, error: result?.error ?? 'actor_list failed' };
        }

        const target = /** @type {{ to: string, goal: string, timeoutMs?: number, oneShot?: boolean }} */ (args);
        // A chained goal can carry actor/web-derived bytes. The UI renders plain
        // text, but keep the live preview one-line + capped so it cannot shape UI.
        const goalPreview = target.goal.replace(/\s+/g, ' ').slice(0, 60);
        pushOp('sent', { to: target.to, goalPreview });
        const mirror = (/** @type {Record<string, unknown>} */ opRecord) => {
          scriptRuns.recordOp(msg.runId, {
            seq: msg.seq ?? 0, method: msg.method, to: target.to, ...opRecord,
          });
        };

        // call — awaitReply, raced against the per-call timeout AND the run's Stop
        // signal. The same signal cancels the underlying actor turn.
        const askTimeoutMs = target.timeoutMs ?? ACTORS_ASK_DEFAULT_TIMEOUT_MS;
        const runSignal = scriptRuns.signalFor(msg.runId);
        const askController = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; askController.abort(); }, askTimeoutMs);
        const onRunAbort = () => askController.abort();
        if (runSignal) {
          if (runSignal.aborted) askController.abort();
          else runSignal.addEventListener('abort', onRunAbort, { once: true });
        }
        try {
          const startedAt = Date.now();
          const result = await actorMessaging.messageActor({
            to: target.to, message: target.goal, senderSessionId: msg.ownerSessionId,
            toolUseId: msg.ownerToolUseId, oneShot: target.oneShot === true, via: 'script',
            // Keep the reply's untrusted-content envelope intact when it
            // resolves into code and code feeds
            // it into another actor. Fencing only the final script result would
            // let page/instance text become an authoritative chained goal.
            awaitReply: true, awaitSignal: askController.signal,
          });
          const ms = Date.now() - startedAt;
          const outcome = askOutcome(result, {
            timedOut, aborted: !timedOut && askController.signal.aborted,
            timeoutMs: askTimeoutMs, to: target.to,
          });
          if (!outcome.ok) {
            pushOp('failed', { ms, error: timedOut ? 'timeout' : 'refused' });
            mirror({ ok: false, ms, error: outcome.error });
            return { ok: false, error: outcome.error };
          }
          pushOp('replied', { ms, ...(outcome.failed ? { failed: true } : {}) });
          mirror({ ok: true, ms, ...(outcome.failed ? { actorFailed: true } : {}) });
          return {
            ok: true,
            value: shapeActorsResult(msg.method === 'ask' ? 'ask' : 'call', {
              ok: true, reply: outcome.reply, failed: outcome.failed,
            }),
          };
        } finally {
          clearTimeout(timer);
          if (runSignal) {
            try { runSignal.removeEventListener?.('abort', onRunAbort); } catch { /* stub */ }
          }
        }
      } catch (e) {
        // A throw after the sent phase must settle the live line instead of
        // leaving it pulsing forever.
        pushOp('failed', { error: 'error' });
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
  };
};
