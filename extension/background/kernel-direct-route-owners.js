// @ts-check
import { makeAppActorChatHandler } from './app-actor-chat.js';
import { makeKernelLazyOwner } from './kernel-lazy-owner.js';
import { kernelUnknownOutcome } from './kernel-route-effect.js';

/** @param {Record<string,any>} deps */
export const makeKernelAppActorChatRoutes = (deps) => {
  if (typeof deps.isAllowed !== 'function') {
    throw new TypeError('kernel-app-actor-chat-provenance-required');
  }
  const load = makeKernelLazyOwner(deps, (live) => typeof live.appActorChat === 'function'
    ? live.appActorChat : makeAppActorChatHandler(live));
  return Object.freeze({
    'app/actor-chat': async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => deps.isAllowed(sender, message)
      ? (await load())(message, sender)
      : { ok: false, error: 'app_actor_chat_unauthorized', outcomeKnown: true },
  });
};

/** @param {Record<string,any>} deps */
export const makeKernelAppCallRoutes = (deps) => {
  if (typeof deps.isRelay !== 'function') {
    throw new TypeError('kernel-app-call-provenance-required');
  }
  const load = makeKernelLazyOwner(deps, (live) => live);
  return Object.freeze({
    'app/call': async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => {
      if (!deps.isRelay(sender)) return { ok: false, error: 'app_call_unauthorized_relay' };
      const live = await load();
      if (live.vault.isLocked()) return { ok: false, error: 'locked' };
      const ownerSessionId = message.ownerSessionId;
      if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
        return { ok: false, error: 'app_call_no_owner' };
      }
      const runId = message.runId;
      if (typeof runId !== 'string' || live.scriptRuns.ownerFor(runId) !== ownerSessionId
          || live.scriptRuns.allows(runId, 'app') !== true
          || live.scriptRuns.admitOp(runId, 'app') !== true) {
        return { ok: false, error: 'app_call_unknown_finished_foreign_or_over_limit_run' };
      }
      const signal = live.scriptRuns.signalFor(runId);
      if (signal?.aborted) return { ok: false, error: 'app_call_aborted' };
      const owner = await live.sessions.get(ownerSessionId).catch(() => null);
      if (signal?.aborted) return { ok: false, error: 'app_call_aborted' };
      if (!owner || owner.kind !== 'actor' || owner.actorType !== 'app'
          || owner.actorSurface !== 'code' || typeof owner.instanceId !== 'string'
          || !owner.instanceId) {
        return { ok: false, error: 'app_call_not_bound_app_actor' };
      }
      if (owner.archivedAt || !await live.validateGeneration(owner)) {
        await live.retireStale(ownerSessionId);
        return {
          ok: false, error: 'app_call_stale_actor_generation', outcomeKnown: true,
          outcomeKind: 'pre-effect-failure',
        };
      }
      if (signal?.aborted) return {
        ok: false, error: 'app_call_aborted', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      try {
        return await live.callApp({
          method: message.method,
          args: message.args,
          sessionId: ownerSessionId,
          appId: owner.instanceId,
          rid: message.rid,
          signal: signal ?? undefined,
        });
      } catch {
        return kernelUnknownOutcome('app-call-outcome-unknown');
      }
    },
  });
};
