// @ts-check

import {
  controllerPayloadBytes,
  parseControllerAuthority,
} from './structured-clone-size.js';

const KIB = 1024;

export const RUNTIME_DISPATCH_CAPABILITY = 'runtime.dispatch';
export const RUNTIME_DISPATCH_MANIFEST = Object.freeze({
  'runtime.bootstrap': Object.freeze({
    inputBytes: KIB,
    inputKeys: Object.freeze([]),
    resultBytes: 256 * KIB,
    concurrent: 1,
    maxDurationMs: 15_000,
    effects: Object.freeze({
      'runtime.bootstrap.read': Object.freeze({
        inputBytes: KIB,
        inputKeys: Object.freeze([]),
        resultBytes: 256 * KIB,
        calls: 1,
        concurrent: 1,
      }),
    }),
    authority: Object.freeze({
      ownerId: 'peerd-authority-kernel',
      target: 'kernel-runtime',
      replayClass: 'A',
    }),
  }),
  'runtime.probe': Object.freeze({
    inputBytes: KIB,
    inputKeys: Object.freeze([]),
    resultBytes: 4 * KIB,
    concurrent: 1,
    maxDurationMs: 10_000,
    effects: Object.freeze({}),
    authority: Object.freeze({
      ownerId: 'peerd-authority-kernel',
      target: 'kernel-runtime',
      replayClass: 'A',
    }),
  }),
  'runtime.rich.relay': Object.freeze({
    inputBytes: 512 * KIB,
    inputKeys: Object.freeze(['route', 'message']),
    resultBytes: 512 * KIB,
    concurrent: 16,
    maxDurationMs: 300_000,
    effects: Object.freeze({
      'rich.script.admit': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze([
          'ownerSessionId', 'runId', 'maxTokens', 'requestedModel',
        ]),
        resultBytes: 128 * KIB,
        calls: 1,
        concurrent: 1,
      }),
      'rich.model.call': Object.freeze({
        inputBytes: 512 * KIB,
        inputKeys: Object.freeze([
          'token', 'ownerSessionId', 'runId', 'provider', 'model', 'system',
          'messages', 'maxTokens', 'ollamaHost', 'pricingOverrides', 'localProvider',
        ]),
        resultBytes: 512 * KIB,
        calls: 1,
        concurrent: 1,
      }),
    }),
    authority: Object.freeze({
      ownerId: 'peerd-authority-kernel',
      target: 'kernel-runtime-rich-relay',
      replayClass: 'E',
    }),
  }),
  'runtime.rich.abort': Object.freeze({
    inputBytes: 4 * KIB,
    inputKeys: Object.freeze(['route', 'message']),
    resultBytes: 4 * KIB,
    concurrent: 64,
    maxDurationMs: 5_000,
    effects: Object.freeze({
      'rich.script.abort': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze(['ownerSessionId', 'runId']),
        resultBytes: 4 * KIB,
        calls: 1,
        concurrent: 1,
      }),
    }),
    authority: Object.freeze({
      ownerId: 'peerd-authority-kernel',
      target: 'kernel-runtime-rich-abort',
      replayClass: 'E',
    }),
  }),
});

const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
const exactKeys = (/** @type {Record<string, any>} */ value, /** @type {string[]} */ keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const bounded = (/** @type {unknown} */ value, /** @type {number} */ maxBytes) => {
  const bytes = controllerPayloadBytes(value, { maxDepth: 32, maxNodes: 25_000 });
  return Number.isFinite(bytes) && bytes <= maxBytes;
};

/** @param {unknown} value */
export const parseRuntimeBootstrapProjection = (value) => {
  const projection = record(value);
  if (!projection || !exactKeys(projection, ['schema', 'target', 'dwebEnabled'])
      || projection.schema !== 1
      || (projection.target !== 'chrome' && projection.target !== 'firefox')
      || typeof projection.dwebEnabled !== 'boolean') return null;
  return Object.freeze({
    schema: 1,
    target: projection.target,
    dwebEnabled: projection.dwebEnabled,
  });
};

/** @param {unknown} value */
export const parseRuntimeRichAdmitProjection = (value) => {
  const projection = record(value);
  const owner = record(projection?.owner);
  const settings = record(projection?.settings);
  if (!projection || !owner || !settings
      || !exactKeys(projection, ['token', 'owner', 'settings'])
      || typeof projection.token !== 'string' || projection.token.length < 16
      || !exactKeys(owner, ['provider', 'model', 'cost'])
      || typeof owner.provider !== 'string' || !owner.provider
      || typeof owner.model !== 'string' || !owner.model
      || !record(owner.cost)
      || !exactKeys(settings, [
        'spendLimitUsd', 'pricingOverrides', 'ollamaHost',
      ])
      || !(settings.spendLimitUsd === null
        || (Number.isFinite(settings.spendLimitUsd) && settings.spendLimitUsd >= 0))
      || !record(settings.pricingOverrides)
      || typeof settings.ollamaHost !== 'string') return null;
  return Object.freeze({
    token: projection.token,
    owner: Object.freeze({
      provider: owner.provider, model: owner.model, cost: owner.cost,
    }),
    settings: Object.freeze({
      spendLimitUsd: settings.spendLimitUsd,
      pricingOverrides: settings.pricingOverrides,
      ollamaHost: settings.ollamaHost,
    }),
  });
};

/** @param {unknown} value */
export const parseRuntimeRichModelValue = (value) => {
  const result = record(value);
  const allowed = new Set(['text', 'stopReason', 'usage', 'cost', 'error']);
  if (!result || !['text', 'usage', 'cost'].every((key) => Object.hasOwn(result, key))
      || Object.keys(result).some((key) => !allowed.has(key))
      || typeof result.text !== 'string'
      || (result.stopReason !== undefined && typeof result.stopReason !== 'string')
      || (result.error !== undefined && typeof result.error !== 'string')
      || !Number.isFinite(result.cost) || result.cost < 0) return null;
  const usage = result.usage === null ? null : record(result.usage);
  if (usage && (!exactKeys(usage, ['inputTokens', 'outputTokens'])
      || !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0
      || !Number.isFinite(usage.outputTokens) || usage.outputTokens < 0)) return null;
  if (result.usage !== null && !usage) return null;
  return Object.freeze({
    text: result.text,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    ...(result.error === undefined ? {} : { error: result.error }),
    usage: usage ? Object.freeze({
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    }) : null,
    cost: result.cost,
  });
};

/** @param {unknown} value */
export const parseRuntimeDispatch = (value) => {
  const input = record(value);
  if (!input || !exactKeys(input, ['operation', 'input'])
      || typeof input.operation !== 'string') return null;
  const policy = RUNTIME_DISPATCH_MANIFEST[
    /** @type {keyof typeof RUNTIME_DISPATCH_MANIFEST} */ (input.operation)
  ];
  const operationInput = record(input.input);
  if (!policy || !operationInput || !exactKeys(operationInput, [...policy.inputKeys])
      || !bounded(operationInput, policy.inputBytes)) return null;
  return Object.freeze({ operation: input.operation, input: input.input, policy });
};

/** @param {unknown} value */
export const runtimeDispatchPayloadAllowed = (value) => parseRuntimeDispatch(value) !== null;

/** @param {unknown} value @param {number} [now] */
export const runtimeDispatchTimeoutMs = (value, now = Date.now()) => {
  const request = parseRuntimeDispatch(value);
  if (!request) return null;
  if (request.operation !== 'runtime.rich.relay') return request.policy.maxDurationMs;
  const relay = record(request.input);
  const relayMessage = record(relay?.message);
  const runDeadline = relayMessage?.deadlineAt;
  if (!Number.isSafeInteger(runDeadline)) return request.policy.maxDurationMs;
  return Math.max(0, Math.min(request.policy.maxDurationMs, Number(runDeadline) - now));
};

/** @param {unknown} request @param {unknown} value */
export const runtimeDispatchAuthorityAllowed = (request, value) => {
  const parsed = parseRuntimeDispatch(request);
  const authority = parseControllerAuthority(value);
  if (!parsed || !authority) return false;
  return authority.ownerId === parsed.policy.authority.ownerId
    && authority.sessionId === null
    && authority.instanceId === null
    && authority.origin === null
    && authority.target === parsed.policy.authority.target
    && authority.replayClass === parsed.policy.authority.replayClass;
};

/** @param {unknown} request @param {unknown} result */
export const runtimeDispatchResultAllowed = (request, result) => {
  const parsed = parseRuntimeDispatch(request);
  const reply = record(result);
  if (!parsed || !reply || typeof reply.ok !== 'boolean'
      || typeof reply.outcomeKnown !== 'boolean'
      || !bounded(reply, parsed.policy.resultBytes)) return false;
  if (reply.ok === true) {
    return reply.outcomeKnown === true
      && exactKeys(reply, Object.hasOwn(reply, 'value')
        ? ['ok', 'outcomeKnown', 'value'] : ['ok', 'outcomeKnown']);
  }
  const allowed = new Set(['ok', 'outcomeKnown', 'code', 'error', 'retryable', 'phase']);
  return typeof reply.code === 'string' && reply.code.length > 0 && reply.code.length <= 128
    && Object.keys(reply).every((key) => allowed.has(key))
    && (!Object.hasOwn(reply, 'error') || typeof reply.error === 'string')
    && (!Object.hasOwn(reply, 'retryable') || typeof reply.retryable === 'boolean')
    && (!Object.hasOwn(reply, 'phase') || reply.phase === 'startup' || reply.phase === 'run');
};

const refused = (/** @type {string} */ code, /** @type {boolean} */ known = true) =>
  Object.freeze({ ok: false, code, outcomeKnown: known });

/** @param {unknown} request */
export const createRuntimeEffectQuota = (request) => {
  const parsed = parseRuntimeDispatch(request);
  const effects = /** @type {Record<string, {
   * inputBytes:number,inputKeys:readonly string[],resultBytes:number,
   * calls:number,concurrent:number,
   * }>} */ (parsed?.policy.effects ?? Object.freeze({}));
  /** @type {Map<string, number>} */
  const calls = new Map();
  /** @type {Map<string, number>} */
  const pending = new Map();
  const pendingCap = Object.values(effects).reduce(
    (total, effect) => total + Number(effect.concurrent), 0,
  );
  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const effect = effects[/** @type {keyof typeof effects} */ (operation)];
    const input = record(payload);
    if (!effect || !input || !exactKeys(input, [...effect.inputKeys])) {
      return refused('runtime-effect-denied');
    }
    if (!bounded(input, effect.inputBytes)) return refused('runtime-effect-payload-too-large');
    const used = calls.get(operation) ?? 0;
    if (used >= effect.calls) return refused('runtime-effect-budget-exhausted');
    const active = pending.get(operation) ?? 0;
    if (active >= effect.concurrent) return refused('runtime-effect-concurrency-exhausted');
    calls.set(operation, used + 1);
    pending.set(operation, active + 1);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  const observe = (
    /** @type {string} */ operation,
    /** @type {unknown} */ _payload,
    /** @type {unknown} */ result,
  ) => {
    const effect = effects[/** @type {keyof typeof effects} */ (operation)];
    if (!effect) return refused('runtime-effect-denied');
    const active = pending.get(operation) ?? 0;
    if (active > 1) pending.set(operation, active - 1);
    else pending.delete(operation);
    const reply = record(result);
    if (!reply || typeof reply.ok !== 'boolean' || typeof reply.outcomeKnown !== 'boolean'
        || !bounded(reply, effect.resultBytes)) {
      return refused('runtime-effect-result-invalid', false);
    }
    if (operation === 'runtime.bootstrap.read' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeBootstrapProjection(reply.value))) {
      return refused('runtime-effect-result-invalid', false);
    }
    if (operation === 'rich.script.admit' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichAdmitProjection(reply.value))) {
      return refused('runtime-effect-result-invalid', false);
    }
    if (operation === 'rich.model.call' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichModelValue(reply.value))) {
      return refused('runtime-effect-result-invalid', false);
    }
    if (operation === 'rich.script.abort' && reply.ok === true
        && (reply.outcomeKnown !== true || !exactKeys(reply, ['ok', 'outcomeKnown']))) {
      return refused('runtime-effect-result-invalid', false);
    }
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  return Object.freeze({ admit, observe, pendingCap });
};

export const RUNTIME_DISPATCH_OUTER_BYTES = Math.max(
  ...Object.values(RUNTIME_DISPATCH_MANIFEST).map((policy) => policy.inputBytes),
) + KIB;
