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
export const makeKernelAppRuntimeRoutes = (deps) => {
  if (typeof deps.isRelay !== 'function') {
    throw new TypeError('kernel-app-runtime-provenance-required');
  }
  const load = makeKernelLazyOwner(deps, (live) => live);
  const admit = async (/** @type {any} */ message, /** @type {any} */ sender) => {
    if (!deps.isRelay(sender)) {
      return { refusal: { ok: false, error: 'app_runtime_unauthorized_relay' } };
    }
    const live = await load();
    if (live.vault.isLocked()) return { refusal: { ok: false, error: 'locked' } };
    const ownerSessionId = message.ownerSessionId;
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
      return { refusal: { ok: false, error: 'app_runtime_no_owner' } };
    }
    const runId = message.runId;
    if (typeof runId !== 'string' || live.scriptRuns.ownerFor(runId) !== ownerSessionId
        || live.scriptRuns.allows(runId, 'app') !== true
        || live.scriptRuns.admitOp(runId, 'app') !== true) {
      return {
        refusal: { ok: false, error: 'app_runtime_unknown_finished_foreign_or_over_limit_run' },
      };
    }
    const signal = live.scriptRuns.signalFor(runId);
    if (signal?.aborted) return { refusal: { ok: false, error: 'app_runtime_aborted' } };
    const owner = await live.sessions.get(ownerSessionId).catch(() => null);
    if (signal?.aborted) return { refusal: { ok: false, error: 'app_runtime_aborted' } };
    if (!owner || owner.kind !== 'actor' || owner.actorType !== 'app'
        || owner.actorSurface !== 'code' || typeof owner.instanceId !== 'string'
        || !owner.instanceId) {
      return { refusal: { ok: false, error: 'app_runtime_not_bound_app_actor' } };
    }
    if (owner.archivedAt || !await live.validateGeneration(owner)) {
      await live.retireStale(ownerSessionId);
      return { refusal: {
        ok: false, error: 'app_runtime_stale_actor_generation', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      } };
    }
    if (signal?.aborted) return { refusal: {
      ok: false, error: 'app_runtime_aborted', outcomeKnown: true,
      outcomeKind: 'pre-effect-failure',
    } };
    return { live, ownerSessionId, appId: owner.instanceId, signal: signal ?? undefined };
  };
  return Object.freeze({
    'app-code/observe': async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => {
      const admitted = await admit(message, sender);
      if ('refusal' in admitted) return admitted.refusal;
      try {
        return await admitted.live.observeAppRuntime({
          sessionId: admitted.ownerSessionId, appId: admitted.appId,
          signal: admitted.signal,
        });
      } catch { return kernelUnknownOutcome('app-observe-outcome-unknown'); }
    },
    'app-code/act': async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => {
      const admitted = await admit(message, sender);
      if ('refusal' in admitted) return admitted.refusal;
      const action = message.action;
      const params = message.params ?? {};
      if (typeof action !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(action)
          || !params || typeof params !== 'object' || Array.isArray(params)) {
        return {
          ok: false, error: 'app_runtime_action_invalid', outcomeKnown: true,
          outcomeKind: 'pre-effect-failure',
        };
      }
      let encoded;
      try { encoded = JSON.stringify(params); }
      catch { encoded = ''; }
      if (!encoded || encoded.length > 20_000) return {
        ok: false, error: 'app_runtime_action_params_invalid', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      try {
        return await admitted.live.actAppRuntime({
          sessionId: admitted.ownerSessionId, appId: admitted.appId,
          action, params, signal: admitted.signal,
        });
      } catch { return kernelUnknownOutcome('app-act-outcome-unknown'); }
    },
  });
};
