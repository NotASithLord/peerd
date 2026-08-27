// @ts-check
// Exact run-bound actor custody for the sealed script worker.

import { createIntrospectionToolAuthority } from '../introspection-tool-authority.js';
import {
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
  settleActorCodeCall,
  validateActorCodeCall,
} from '../../shared/actor-code-authority.js';

/** @param {Record<string, any>} deps */
export const makeActorsRoutes = (deps) => {
  const {
    sessions, uiPorts, buildToolContext, actorMessaging, scriptRuns,
    resolveManifestAllow, isOffscreenSender,
  } = deps;

  const ownerAllow = (/** @type {Record<string, any>} */ owner) => owner.kind === 'spawned'
    ? new Set(Array.isArray(owner.grantedTools) ? owner.grantedTools : [])
    : resolveManifestAllow(owner.toolManifest);

  /**
   * Admit one exact actor-code capability. The route selects the required tool;
   * the worker never sends an operation selector to this authority check.
   * @param {any} msg @param {any} sender @param {string} requiredTool @param {string} label
   */
  const admit = async (msg, sender, requiredTool, label) => {
    if (!isOffscreenSender(sender)) {
      return { refusal: { ok: false, error: 'actors: unauthorized relay' } };
    }
    if (typeof msg.runId !== 'string'
        || scriptRuns.ownerFor(msg.runId) !== msg.ownerSessionId
        || scriptRuns.allows?.(msg.runId, 'actors') !== true) {
      return { refusal: { ok: false, error: 'actors: unknown, finished, or foreign script run' } };
    }
    const runSignal = scriptRuns.signalFor(msg.runId);
    if (!runSignal || runSignal.aborted) {
      return { refusal: { ok: false, error: 'actors: unknown, finished, or foreign script run' } };
    }
    const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
    if (runSignal.aborted) return { refusal: {
      ok: false, cancelled: true,
      error: `actors.${label}: aborted (Stop) before delegation dispatch`,
    } };
    if (!owner || owner.kind === 'actor') {
      return { refusal: {
        ok: false,
        error: 'actors: only a chat session or a granted spawned actor holds the script delegation surface',
      } };
    }
    const allow = ownerAllow(owner);
    if (allow instanceof Set && !allow.has(requiredTool)) {
      return { refusal: {
        ok: false, error: `actors.${label}: '${requiredTool}' is not granted to this session`,
      } };
    }
    if (scriptRuns.admitActorOp?.(msg.runId) !== true) {
      return { refusal: {
        ok: false, error: 'actors: this script run reached its delegation-operation limit',
      } };
    }
    return { owner, runSignal };
  };

  return {
    /** @param {{ runId?: string, ownerSessionId?: string }} msg @param {any} sender */
    'script-run/abort': (msg = {}, sender = undefined) => {
      if (!isOffscreenSender(sender)) {
        return { ok: false, error: 'script_run_abort_unauthorized_relay' };
      }
      if (typeof msg.runId !== 'string' || !msg.runId
        || typeof msg.ownerSessionId !== 'string' || !msg.ownerSessionId
        || scriptRuns.ownerFor(msg.runId) !== msg.ownerSessionId) {
        return { ok: false, error: 'script_run_abort_unknown_finished_or_foreign_run' };
      }
      scriptRuns.abort(msg.runId);
      return { ok: true };
    },

    'actors/list': async (/** @type {any} */ msg = {}, sender = undefined) => {
      try {
        const admitted = await admit(msg, sender, 'actor_list', 'list');
        if (admitted.refusal) return admitted.refusal;
        const context = {
          ...await buildToolContext({
            exposure: 'main', sessionId: msg.ownerSessionId,
            abortSignal: admitted.runSignal,
          }),
          abortSignal: admitted.runSignal,
        };
        if (admitted.runSignal.aborted) return {
          ok: false, cancelled: true,
          error: 'actors.list: aborted (Stop) before roster dispatch',
        };
        const authority = createIntrospectionToolAuthority({
          call: { name: 'actor_list', args: {} }, ctx: context,
        });
        const roster = await authority.readActorRoster();
        void context.audit?.({
          type: 'tool_executed',
          details: { tool: 'actor_list', primitive: 'state', dispatch: 'read' },
        }).catch(() => {});
        return { ok: true, roster };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    'actors/call': async (/** @type {any} */ msg = {}, sender = undefined) => {
      let operationSent = false;
      let operationStartedAt = 0;
      /** @type {AbortSignal|null} */
      let operationSignal = null;
      /** @type {((record: Record<string, unknown>) => void)|null} */
      let settleOperation = null;
      const pushOp = (/** @type {string} */ phase, /** @type {object} */ extra = {}) => {
        try {
          uiPorts.broadcast({
            type: 'script/op', sessionId: msg.ownerSessionId,
            toolUseId: msg.ownerToolUseId ?? null, seq: msg.seq ?? 0,
            method: 'call', phase, ...extra,
          });
        } catch { /* panel closed — the result trace remains authoritative */ }
      };

      try {
        const admitted = await admit(msg, sender, 'message_actor', 'call');
        if (admitted.refusal) return admitted.refusal;
        const target = validateActorCodeCall(msg.args);
        const { runSignal } = admitted;
        const goalHead = target.goal.slice(0, 61).replace(/\s+/g, ' ').trim();
        const goalPreview = target.goal.length > 60 || goalHead.length > 60
          ? `${goalHead.slice(0, 59)}…` : goalHead;
        const traceTarget = target.to.slice(0, ACTORS_TRACE_TARGET_MAX_CHARS);
        const mirrorBase = {
          seq: msg.seq ?? 0, method: 'call', to: traceTarget, goal: goalPreview,
        };
        const mirror = (/** @type {Record<string, unknown>} */ record) => {
          const { error, ...rest } = record;
          scriptRuns.recordOp(msg.runId, {
            ...mirrorBase, ...rest,
            ...(error === undefined ? {} : {
              error: String(error).slice(0, ACTORS_TRACE_ERROR_MAX_CHARS),
            }),
          });
        };
        mirror({ ok: false, ms: 0, settled: false });
        operationSent = true;
        operationStartedAt = Date.now();
        operationSignal = runSignal;
        settleOperation = mirror;
        pushOp('sent', { to: traceTarget, goalPreview });

        const askTimeoutMs = target.timeoutMs ?? ACTORS_ASK_DEFAULT_TIMEOUT_MS;
        const askController = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; askController.abort(); }, askTimeoutMs);
        const onRunAbort = () => askController.abort();
        if (runSignal.aborted) askController.abort();
        else runSignal.addEventListener('abort', onRunAbort, { once: true });
        try {
          const startedAt = Date.now();
          const result = await actorMessaging.messageActor({
            to: target.to, message: target.goal, senderSessionId: msg.ownerSessionId,
            toolUseId: msg.ownerToolUseId, oneShot: target.oneShot === true,
            via: 'script', awaitReply: true, awaitSignal: askController.signal,
          });
          const actorDeliveryId = typeof result?.actorDeliveryId === 'string'
            ? result.actorDeliveryId : undefined;
          const ms = Date.now() - startedAt;
          const outcome = settleActorCodeCall(result, {
            timedOut, aborted: !timedOut && askController.signal.aborted,
            timeoutMs: askTimeoutMs, to: target.to,
          });
          if (!outcome.ok) {
            const cancelled = !timedOut && askController.signal.aborted;
            pushOp(cancelled ? 'cancelled' : 'failed', {
              ms, ...(cancelled ? { cancelled: true } : {}),
              error: timedOut ? 'timeout' : cancelled ? 'aborted' : 'refused',
            });
            mirror({
              ok: false, ms, settled: true, error: outcome.error,
              ...(actorDeliveryId ? { actorDeliveryId } : {}),
              ...(cancelled ? { cancelled: true } : {}),
            });
            return {
              ok: false, error: outcome.error,
              ...(actorDeliveryId ? { actorDeliveryId } : {}),
              ...(cancelled ? { cancelled: true } : {}),
            };
          }
          pushOp('replied', { ms, ...(outcome.failed ? { failed: true } : {}) });
          mirror({
            ok: true, ms, settled: true,
            ...(actorDeliveryId ? { actorDeliveryId } : {}),
            ...(outcome.failed ? { actorFailed: true } : {}),
          });
          return {
            ok: true, reply: outcome.reply, failed: outcome.failed,
            ...(actorDeliveryId ? { actorDeliveryId } : {}),
          };
        } finally {
          clearTimeout(timer);
          runSignal.removeEventListener?.('abort', onRunAbort);
        }
      } catch (cause) {
        const cancelled = operationSent && operationSignal?.aborted === true;
        if (operationSent) {
          const ms = operationStartedAt ? Date.now() - operationStartedAt : 0;
          const detail = cause instanceof Error ? cause.message : String(cause);
          pushOp(cancelled ? 'cancelled' : 'failed', {
            ms, ...(cancelled ? { cancelled: true } : {}),
            error: cancelled ? 'aborted' : 'error',
          });
          settleOperation?.({
            ok: false, ms, settled: true, error: detail,
            ...(cancelled ? { cancelled: true } : {}),
          });
        }
        return {
          ok: false, error: cause instanceof Error ? cause.message : String(cause),
          ...(cancelled ? { cancelled: true } : {}),
        };
      }
    },
  };
};
