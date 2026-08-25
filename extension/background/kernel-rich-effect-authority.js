// @ts-check

import {
  callModel,
  costOf,
  hasPricing,
  listProviders,
} from '/peerd-provider/background.js';
import {
  foldProviderEvents,
  limitExceeded,
  normalizeTally,
  providerQuotaError,
  validateProviderCallArgs,
} from '/peerd-runtime/background.js';
import { HARDCODED_ALLOWLIST, makeSafeFetch } from '/peerd-egress/background.js';

const RESERVATION_TTL_MS = 120_000;
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exact = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const same = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};
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

/** @param {Record<string,any>} deps */
export const createKernelRichEffectAuthority = (deps) => {
  if (!deps.scriptRuns || !deps.sessions || !deps.settingsStore || !deps.vault
      || !deps.auditLog || !deps.kv || typeof deps.contextSnapshots?.record !== 'function'
      || typeof deps.fetchFn !== 'function') {
    throw new TypeError('kernel-rich-effect-authority-config-invalid');
  }
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const callProvider = deps.callModel ?? callModel;
  const priceProvider = deps.costOf ?? costOf;
  const providers = deps.listProviders ?? listProviders;
  const priced = deps.hasPricing ?? hasPricing;
  const foldEvents = deps.foldProviderEvents ?? foldProviderEvents;
  /** @type {Set<string>} */
  const endpoints = new Set();
  const endpointsReady = deps.safeFetch ? Promise.resolve() : deps.kv.get(
    'provider_endpoints.v1',
  ).then((/** @type {any} */ stored) => {
    for (const endpoint of Array.isArray(stored?.endpoints) ? stored.endpoints : []) {
      if (typeof endpoint?.url === 'string') endpoints.add(endpoint.url);
    }
  });
  const safeFetch = deps.safeFetch ?? makeSafeFetch({
    getAllowlist: () => [...HARDCODED_ALLOWLIST, ...endpoints],
    audit: deps.auditLog.append,
    fetchFn: deps.fetchFn,
  });
  /** @type {Map<string,{ownerSessionId:string,runId:string,maxTokens:number,
   * provider:string,model:string,expiresAt:number,signal:AbortSignal,onAbort:()=>void}>} */
  const reservations = new Map();
  /** @type {Map<string,Promise<void>>} */
  const costChains = new Map();
  const releaseReservation = (/** @type {string} */ token) => {
    const reservation = reservations.get(token);
    if (!reservation) return null;
    reservations.delete(token);
    reservation.signal.removeEventListener('abort', reservation.onAbort);
    deps.scriptRuns.cancelProviderCall(reservation.runId, reservation.maxTokens);
    return reservation;
  };
  const expire = () => {
    for (const [token, reservation] of reservations) {
      if (reservation.expiresAt > now()) continue;
      releaseReservation(token);
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
          inputTokens: tally.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: tally.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: tally.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: tally.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
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
    const provider = providers().find((/** @type {any} */ entry) => entry.name === owner.provider);
    if (!provider) {
      return denied(
        'rich-script-provider-missing',
        `provider: session provider not registered: ${owner.provider}`,
      );
    }
    const pricingOverrides = record(settings.pricingOverrides) ?? {};
    if (input.requestedModel && input.requestedModel !== owner.model
        && provider.keyless !== true && !priced(input.requestedModel, pricingOverrides)) {
      return denied('rich-script-model-invalid', 'provider.call: unknown model');
    }
    const model = input.requestedModel || owner.model;
    if (!context?.signal || context.signal.aborted) {
      return denied('rich-script-admission-invalid');
    }
    const token = randomId();
    deps.scriptRuns.recordProviderCall(input.runId, input.maxTokens);
    const onAbort = () => { releaseReservation(token); };
    reservations.set(token, {
      ownerSessionId: input.ownerSessionId,
      runId: input.runId,
      maxTokens: input.maxTokens,
      provider: owner.provider,
      model,
      expiresAt: now() + RESERVATION_TTL_MS,
      signal: context.signal,
      onAbort,
    });
    context.signal.addEventListener('abort', onAbort, { once: true });
    return known({
      token,
      owner: { provider: owner.provider, model: owner.model, cost: tally },
      settings: {
        spendLimitUsd: Number.isFinite(settings.spendLimitUsd)
          ? settings.spendLimitUsd : null,
        pricingOverrides,
        ollamaHost: typeof settings.ollamaHost === 'string' ? settings.ollamaHost : '',
      },
    });
  };
  const modelCall = async (/** @type {unknown} */ value, /** @type {any} */ context) => {
    const input = record(value);
    const keys = [
      'token', 'ownerSessionId', 'runId', 'provider', 'model', 'system', 'messages',
      'maxTokens', 'ollamaHost', 'pricingOverrides', 'localProvider',
    ];
    if (!input || !exact(input, keys) || typeof input.token !== 'string') {
      return denied('rich-model-call-invalid');
    }
    let normalized;
    try {
      normalized = validateProviderCallArgs({
        system: input.system,
        messages: input.messages,
        model: input.model,
        maxTokens: input.maxTokens,
      });
    } catch { return denied('rich-model-call-invalid'); }
    if ((normalized.system ?? '') !== input.system
        || normalized.model !== input.model
        || normalized.maxTokens !== input.maxTokens
        || !same(normalized.messages, input.messages)
        || typeof input.provider !== 'string'
        || typeof input.ollamaHost !== 'string'
        || !record(input.pricingOverrides)
        || typeof input.localProvider !== 'boolean') {
      return denied('rich-model-call-invalid');
    }
    expire();
    const reservation = reservations.get(input.token);
    if (!reservation
        || reservation.ownerSessionId !== input.ownerSessionId
        || reservation.runId !== input.runId
        || reservation.provider !== input.provider
        || reservation.model !== input.model
        || reservation.maxTokens !== input.maxTokens) {
      if (reservation) releaseReservation(input.token);
      return denied('rich-model-reservation-invalid');
    }
    reservations.delete(input.token);
    reservation.signal.removeEventListener('abort', reservation.onAbort);
    let actualOutputTokens = 0;
    try {
      const owner = await deps.sessions.getMetadata(reservation.ownerSessionId);
      const settings = deps.settingsStore.get();
      const provider = providers().find(
        (/** @type {any} */ entry) => entry.name === reservation.provider,
      );
      const runSignal = deps.scriptRuns.signalFor(reservation.runId);
      if (!owner || !provider || !runSignal || runSignal.aborted || context?.signal?.aborted
          || deps.scriptRuns.ownerFor(reservation.runId) !== reservation.ownerSessionId
          || deps.scriptRuns.allows(reservation.runId, 'provider') !== true
          || owner.provider !== reservation.provider
          || (provider.keyless === true) !== input.localProvider
          || (settings.ollamaHost ?? '') !== input.ollamaHost
          || !same(record(settings.pricingOverrides) ?? {}, input.pricingOverrides)) {
        return denied('rich-model-authority-invalid');
      }
      await endpointsReady;
      try {
        deps.contextSnapshots.record({
          provider: reservation.provider,
          model: reservation.model,
          system: input.system,
          messages: input.messages,
          maxTokens: reservation.maxTokens,
          sessionId: reservation.ownerSessionId,
          label: 'script:sub-call',
        });
      } catch (cause) {
        return denied(
          'rich-model-snapshot-failed',
          /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
        );
      }
      const events = [];
      const signal = combinedSignal([runSignal, context.signal]);
      try {
        for await (const event of callProvider(/** @type {any} */ ({
          provider: reservation.provider,
          model: reservation.model,
          system: typeof input.system === 'string' ? input.system : '',
          messages: input.messages,
          maxTokens: reservation.maxTokens,
          signal,
          getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
          safeFetch,
          ollamaHost: input.ollamaHost,
        }))) events.push(event);
      } catch (cause) {
        return denied(
          'rich-model-call-failed',
          signal.aborted ? 'aborted'
            : (/** @type {{message?:string}} */ (cause)?.message ?? String(cause)),
          false,
        );
      }
      const folded = foldEvents(events);
      const rawUsage = folded.usage;
      const usage = rawUsage ? {
        inputTokens: rawUsage.inputTokens,
        outputTokens: rawUsage.outputTokens,
      } : null;
      actualOutputTokens = usage?.outputTokens ?? 0;
      let amount = 0;
      try {
        amount = rawUsage ? priceProvider(
          reservation.model,
          rawUsage,
          input.pricingOverrides,
          { localProvider: input.localProvider },
        )?.cost ?? 0 : 0;
      } catch { amount = 0; }
      if (rawUsage) await foldCost(reservation.ownerSessionId, rawUsage, amount);
      await deps.auditLog.append({
        type: 'provider_sub_call',
        sessionId: reservation.ownerSessionId,
        details: {
          runId: reservation.runId,
          provider: reservation.provider,
          model: reservation.model,
          outputTokens: actualOutputTokens,
          cost: amount,
        },
      }).catch(() => {});
      return known({
        text: folded.text ?? '',
        ...(folded.stopReason === undefined ? {} : { stopReason: folded.stopReason }),
        usage,
        cost: amount,
        ...(folded.error ? { error: folded.error } : {}),
      });
    } finally {
      deps.scriptRuns.settleProviderCall(
        reservation.runId, reservation.maxTokens, actualOutputTokens,
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
  return Object.freeze({
    handle: async (/** @type {string} */ operation, /** @type {unknown} */ payload,
      /** @type {any} */ context) => {
      if (context?.capability !== 'runtime.dispatch'
          || !((context?.authority?.target === 'kernel-runtime-rich-relay'
              && (operation === 'rich.script.admit' || operation === 'rich.model.call'))
            || (context?.authority?.target === 'kernel-runtime-rich-abort'
              && operation === 'rich.script.abort'))
          || context.authority.replayClass !== 'E') {
        return denied('kernel-operation-denied');
      }
      if (operation === 'rich.script.admit') return admit(payload, context);
      if (operation === 'rich.model.call') return modelCall(payload, context);
      if (operation === 'rich.script.abort') return abort(payload);
      return denied('kernel-operation-denied');
    },
  });
};
