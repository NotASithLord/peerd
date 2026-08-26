// @ts-check

import { limitExceeded, normalizeTally, providerQuotaError } from '/peerd-runtime/kernel-custody.js';

const RESERVATION_TTL_MS = 120_000;
const MAX_USAGE_TOKENS = 1_000_000_000;
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exact = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const denied = (/** @type {string} */ code, /** @type {string} */ error = code,
  /** @type {boolean} */ outcomeKnown = true) => ({ ok: false, code, error, outcomeKnown });
const known = (/** @type {unknown} */ value) => ({ ok: true, outcomeKnown: true, value });

/** @param {AbortSignal[]} signals */
const combinedSignal = (signals) => {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
};

const boundedUsage = (/** @type {unknown} */ value) => {
  const usage = record(value);
  if (!usage || !exact(usage, [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  ])) return null;
  for (const amount of Object.values(usage)) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_USAGE_TOKENS) return null;
  }
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
};

/** @param {Record<string,any>} deps */
export const createKernelRichEffectAuthority = (deps) => {
  if (!deps.scriptRuns || !deps.sessions || !deps.settingsStore || !deps.auditLog
      || typeof deps.providerEgress?.openInference !== 'function'
      || typeof deps.providerEgress?.readInferenceChunk !== 'function'
      || typeof deps.providerEgress?.cancelInference !== 'function'
      || typeof deps.providerEgress?.openLocalGeneration !== 'function'
      || typeof deps.providerEgress?.readLocalGeneration !== 'function'
      || typeof deps.providerEgress?.cancelLocalGeneration !== 'function'
      || typeof deps.providerEgress?.closeOwner !== 'function'
      || typeof deps.costOf !== 'function' || typeof deps.hasPricing !== 'function') {
    throw new TypeError('kernel-rich-effect-authority-config-invalid');
  }
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  /** @type {Map<string,{ownerSessionId:string,runId:string,maxTokens:number,
   * provider:string,model:string,pricingOverrides:Record<string,any>,expiresAt:number,
   * signal:AbortSignal,onAbort:()=>void,egressOwner:object}>} */
  const reservations = new Map();
  /** @type {Map<string,Promise<void>>} */
  const costChains = new Map();
  const releaseReservation = (/** @type {string} */ token) => {
    const reservation = reservations.get(token);
    if (!reservation) return null;
    reservations.delete(token);
    reservation.signal.removeEventListener('abort', reservation.onAbort);
    deps.scriptRuns.cancelProviderCall(reservation.runId, reservation.maxTokens);
    void deps.providerEgress.closeOwner(reservation.egressOwner);
    return reservation;
  };
  const expire = () => {
    for (const [token, reservation] of reservations) {
      if (reservation.expiresAt <= now()) releaseReservation(token);
    }
  };
  const foldCost = (/** @type {string} */ sessionId, /** @type {any} */ usage,
    /** @type {number} */ amount) => {
    const prior = costChains.get(sessionId) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(async () => {
      const session = await deps.sessions.getMetadata(sessionId);
      const tally = normalizeTally(session?.cost);
      await deps.sessions.updateMetadata(sessionId, {
        cost: {
          inputTokens: tally.inputTokens + usage.inputTokens,
          outputTokens: tally.outputTokens + usage.outputTokens,
          cacheReadTokens: tally.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: tally.cacheWriteTokens + usage.cacheWriteTokens,
          cost: tally.cost + amount,
          turns: tally.turns,
        },
      });
    });
    costChains.set(sessionId, operation);
    void operation.finally(() => {
      if (costChains.get(sessionId) === operation) costChains.delete(sessionId);
    }).catch(() => {});
    return operation;
  };
  const liveReservation = async (/** @type {Record<string,any>} */ input,
    /** @type {any} */ context, /** @type {boolean} */ withStream = false) => {
    const keys = ['token', 'ownerSessionId', 'runId', ...(withStream ? ['streamId'] : [])];
    if (!exact(input, keys) || typeof input.token !== 'string'
        || typeof input.ownerSessionId !== 'string' || typeof input.runId !== 'string'
        || (withStream && (typeof input.streamId !== 'string' || !input.streamId))) return null;
    expire();
    const reservation = reservations.get(input.token);
    if (!reservation || reservation.ownerSessionId !== input.ownerSessionId
        || reservation.runId !== input.runId) {
      if (reservation) releaseReservation(input.token);
      return null;
    }
    const owner = await deps.sessions.getMetadata(reservation.ownerSessionId);
    const runSignal = deps.scriptRuns.signalFor(reservation.runId);
    if (!owner || !runSignal || runSignal.aborted || context?.signal?.aborted
        || deps.scriptRuns.ownerFor(reservation.runId) !== reservation.ownerSessionId
        || deps.scriptRuns.allows(reservation.runId, 'provider') !== true
        || owner.provider !== reservation.provider) {
      releaseReservation(input.token);
      return null;
    }
    return Object.freeze({ reservation, signal: combinedSignal([runSignal, context.signal]) });
  };
  const admit = async (/** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    if (!input || !exact(input, [
      'ownerSessionId', 'runId', 'maxTokens', 'requestedModel',
    ]) || typeof input.ownerSessionId !== 'string' || !input.ownerSessionId
      || typeof input.runId !== 'string' || !input.runId
      || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1
      || !(input.requestedModel === null
        || (typeof input.requestedModel === 'string' && input.requestedModel))) {
      return denied('rich-script-admission-invalid');
    }
    expire();
    const owner = await deps.sessions.getMetadata(input.ownerSessionId);
    if (!owner || owner.kind === 'actor' || owner.kind === 'spawned'
        || deps.scriptRuns.ownerFor(input.runId) !== input.ownerSessionId
        || deps.scriptRuns.allows(input.runId, 'provider') !== true) {
      return denied('rich-script-run-invalid', 'provider: unknown or finished run');
    }
    const quota = providerQuotaError(deps.scriptRuns.providerUsageFor(input.runId));
    if (quota) return denied('rich-script-quota-exhausted', quota.message);
    const settings = deps.settingsStore.get();
    const tally = normalizeTally(owner.cost);
    if (limitExceeded(tally.cost, settings.spendLimitUsd)) {
      return denied(
        'rich-script-spend-limit',
        `provider quota exceeded: the session spend limit ($${settings.spendLimitUsd}) is reached`,
      );
    }
    const pricingOverrides = record(settings.pricingOverrides) ?? {};
    if (input.requestedModel && input.requestedModel !== owner.model
        && !deps.hasPricing(input.requestedModel, pricingOverrides, {
          providerId: owner.provider,
        })) {
      return denied('rich-script-model-invalid', 'provider.call: unknown model');
    }
    if (!context?.signal || context.signal.aborted) return denied('rich-script-admission-invalid');
    const token = randomId();
    const model = input.requestedModel || owner.model;
    deps.scriptRuns.recordProviderCall(input.runId, input.maxTokens);
    const onAbort = () => { releaseReservation(token); };
    reservations.set(token, {
      ownerSessionId: input.ownerSessionId,
      runId: input.runId,
      maxTokens: input.maxTokens,
      provider: owner.provider,
      model,
      pricingOverrides,
      expiresAt: now() + RESERVATION_TTL_MS,
      signal: context.signal,
      onAbort,
      egressOwner: Object.freeze({}),
    });
    context.signal.addEventListener('abort', onAbort, { once: true });
    return known({ token, providerId: owner.provider, modelId: model });
  };
  const openInference = async (/** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    if (!input || !exact(input, [
      'token', 'ownerSessionId', 'runId', 'providerId', 'modelId', 'nativeBody',
    ]) || typeof input.providerId !== 'string' || typeof input.modelId !== 'string'
      || !record(input.nativeBody)) return denied('rich-model-open-invalid');
    const live = await liveReservation({
      token: input.token, ownerSessionId: input.ownerSessionId, runId: input.runId,
    }, context);
    if (!live || live.reservation.provider !== input.providerId
        || live.reservation.model !== input.modelId) {
      if (live) releaseReservation(input.token);
      return denied('rich-model-reservation-invalid');
    }
    try {
      return await deps.providerEgress.openInference({
        providerId: input.providerId,
        modelId: input.modelId,
        nativeBody: input.nativeBody,
      }, {
        owner: live.reservation.egressOwner,
        signal: live.signal,
        maxOutputTokens: live.reservation.maxTokens,
        permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
          providerId === live.reservation.provider && modelId === live.reservation.model,
      });
    } catch (cause) {
      return denied('rich-model-open-failed', cause instanceof Error ? cause.message : String(cause), false);
    }
  };
  const streamEffect = async (/** @type {'read'|'cancel'} */ kind,
    /** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    if (!input) return denied(`rich-model-${kind}-invalid`);
    const live = await liveReservation(input, context, true);
    if (!live) return denied('rich-model-reservation-invalid');
    try {
      const request = { streamId: input.streamId };
      const grant = { owner: live.reservation.egressOwner, signal: live.signal };
      return kind === 'read'
        ? await deps.providerEgress.readInferenceChunk(request, grant)
        : await deps.providerEgress.cancelInference(request, grant);
    } catch (cause) {
      return denied(`rich-model-${kind}-failed`,
        cause instanceof Error ? cause.message : String(cause), false);
    }
  };
  const openLocal = async (/** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    if (!input || !exact(input, [
      'token', 'ownerSessionId', 'runId', 'providerId', 'modelId',
      'messages', 'system', 'tools', 'maxTokens',
    ]) || input.providerId !== 'local-webgpu' || typeof input.modelId !== 'string'
      || !Array.isArray(input.messages) || typeof input.system !== 'string'
      || !Array.isArray(input.tools) || !Number.isSafeInteger(input.maxTokens)) {
      return denied('rich-model-local-open-invalid');
    }
    const live = await liveReservation({
      token: input.token, ownerSessionId: input.ownerSessionId, runId: input.runId,
    }, context);
    if (!live || live.reservation.provider !== input.providerId
        || live.reservation.model !== input.modelId
        || live.reservation.maxTokens !== input.maxTokens) {
      if (live) releaseReservation(input.token);
      return denied('rich-model-reservation-invalid');
    }
    return deps.providerEgress.openLocalGeneration({
      providerId: input.providerId,
      modelId: input.modelId,
      messages: input.messages,
      system: input.system,
      tools: input.tools,
      maxTokens: input.maxTokens,
    }, {
      owner: live.reservation.egressOwner,
      signal: live.signal,
      maxOutputTokens: live.reservation.maxTokens,
      permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
        providerId === live.reservation.provider && modelId === live.reservation.model,
    });
  };
  const localStreamEffect = async (/** @type {'read'|'cancel'} */ kind,
    /** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    if (!input) return denied(`rich-model-local-${kind}-invalid`);
    const live = await liveReservation(input, context, true);
    if (!live) return denied('rich-model-reservation-invalid');
    const request = { streamId: input.streamId };
    const grant = { owner: live.reservation.egressOwner };
    return kind === 'read'
      ? deps.providerEgress.readLocalGeneration(request, grant)
      : deps.providerEgress.cancelLocalGeneration(request, grant);
  };
  const observeUsage = async (/** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    const usage = boundedUsage(input?.usage);
    if (!input || !usage || !exact(input, [
      'token', 'ownerSessionId', 'runId', 'providerId', 'modelId', 'usage',
    ])) return denied('rich-model-usage-invalid');
    const live = await liveReservation({
      token: input.token, ownerSessionId: input.ownerSessionId, runId: input.runId,
    }, context);
    if (!live || live.reservation.provider !== input.providerId
        || live.reservation.model !== input.modelId
        || usage.outputTokens > live.reservation.maxTokens) {
      if (live) releaseReservation(input.token);
      return denied('rich-model-reservation-invalid');
    }
    const reservation = live.reservation;
    reservations.delete(input.token);
    reservation.signal.removeEventListener('abort', reservation.onAbort);
    try {
      await deps.providerEgress.closeOwner(reservation.egressOwner);
      const amount = Number(deps.costOf(
        reservation.model, usage, reservation.pricingOverrides,
        { providerId: reservation.provider },
      )?.cost ?? 0);
      if (!Number.isFinite(amount) || amount < 0) throw new TypeError('invalid provider cost');
      await foldCost(reservation.ownerSessionId, usage, amount);
      await deps.auditLog.append({
        type: 'provider_sub_call',
        sessionId: reservation.ownerSessionId,
        details: {
          runId: reservation.runId,
          provider: reservation.provider,
          model: reservation.model,
          outputTokens: usage.outputTokens,
          cost: amount,
        },
      }).catch(() => {});
      return { ok: true, outcomeKnown: true };
    } catch (cause) {
      return denied('rich-model-usage-observation-failed',
        cause instanceof Error ? cause.message : String(cause), false);
    } finally {
      deps.scriptRuns.settleProviderCall(
        reservation.runId, reservation.maxTokens, usage.outputTokens,
      );
    }
  };
  const abort = (/** @type {unknown} */ value) => {
    const input = record(value);
    if (!input || !exact(input, ['ownerSessionId', 'runId'])
        || typeof input.ownerSessionId !== 'string' || typeof input.runId !== 'string'
        || deps.scriptRuns.ownerFor(input.runId) !== input.ownerSessionId) {
      return denied('rich-script-abort-invalid');
    }
    deps.scriptRuns.abort(input.runId);
    return { ok: true, outcomeKnown: true };
  };
  const richOperations = new Set([
    'rich.script.admit', 'rich.model.open-inference', 'rich.model.read-inference',
    'rich.model.cancel-inference', 'rich.model.open-local', 'rich.model.read-local',
    'rich.model.cancel-local', 'rich.model.observe-usage',
  ]);
  return Object.freeze({
    handle: async (/** @type {string} */ operation, /** @type {unknown} */ payload,
      /** @type {any} */ context) => {
      if (context?.capability !== 'runtime.dispatch'
          || !((context?.authority?.target === 'kernel-runtime-rich-relay'
              && richOperations.has(operation))
            || (context?.authority?.target === 'kernel-runtime-rich-abort'
              && operation === 'rich.script.abort'))
          || context.authority.replayClass !== 'E') {
        return denied('kernel-operation-denied');
      }
      if (operation === 'rich.script.admit') return admit(payload, context);
      if (operation === 'rich.model.open-inference') return openInference(payload, context);
      if (operation === 'rich.model.read-inference') return streamEffect('read', payload, context);
      if (operation === 'rich.model.cancel-inference') return streamEffect('cancel', payload, context);
      if (operation === 'rich.model.open-local') return openLocal(payload, context);
      if (operation === 'rich.model.read-local') return localStreamEffect('read', payload, context);
      if (operation === 'rich.model.cancel-local') return localStreamEffect('cancel', payload, context);
      if (operation === 'rich.model.observe-usage') return observeUsage(payload, context);
      if (operation === 'rich.script.abort') return abort(payload);
      return denied('kernel-operation-denied');
    },
  });
};
