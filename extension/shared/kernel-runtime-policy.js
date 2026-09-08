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
      'rich.model.open-inference': Object.freeze({
        inputBytes: 32 * 1024 * KIB,
        inputKeys: Object.freeze([
          'token', 'ownerSessionId', 'runId', 'providerId', 'modelId', 'nativeBody',
        ]),
        resultBytes: 16 * KIB,
        calls: 16,
        concurrent: 1,
      }),
      'rich.model.read-inference': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze(['token', 'ownerSessionId', 'runId', 'streamId']),
        resultBytes: 128 * KIB,
        calls: 256,
        concurrent: 1,
      }),
      'rich.model.cancel-inference': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze(['token', 'ownerSessionId', 'runId', 'streamId']),
        resultBytes: 4 * KIB,
        calls: 16,
        concurrent: 1,
      }),
      'rich.model.open-local': Object.freeze({
        inputBytes: 2 * 1024 * KIB,
        inputKeys: Object.freeze([
          'token', 'ownerSessionId', 'runId', 'providerId', 'modelId',
          'messages', 'system', 'tools', 'maxTokens',
        ]),
        resultBytes: 4 * KIB,
        calls: 16,
        concurrent: 1,
      }),
      'rich.model.read-local': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze(['token', 'ownerSessionId', 'runId', 'streamId']),
        resultBytes: 128 * KIB,
        calls: 256,
        concurrent: 1,
      }),
      'rich.model.cancel-local': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze(['token', 'ownerSessionId', 'runId', 'streamId']),
        resultBytes: 4 * KIB,
        calls: 16,
        concurrent: 1,
      }),
      'rich.model.observe-usage': Object.freeze({
        inputBytes: 4 * KIB,
        inputKeys: Object.freeze([
          'token', 'ownerSessionId', 'runId', 'providerId', 'modelId', 'usage',
        ]),
        resultBytes: 4 * KIB,
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
  if (!projection || !exactKeys(projection, ['token', 'providerId', 'modelId'])
      || typeof projection.token !== 'string' || projection.token.length < 16
      || typeof projection.providerId !== 'string' || !projection.providerId
      || typeof projection.modelId !== 'string' || !projection.modelId) return null;
  return Object.freeze({
    token: projection.token,
    providerId: projection.providerId,
    modelId: projection.modelId,
  });
};

/** @param {unknown} value */
export const parseRuntimeRichOpenInferenceValue = (value) => {
  const result = record(value);
  const headers = record(result?.headers);
  if (!result || !headers || !exactKeys(result, [
    'streamId', 'status', 'statusText', 'headers', 'hasBody',
  ]) || typeof result.streamId !== 'string' || result.streamId.length < 1
      || result.streamId.length > 256
      || !Number.isSafeInteger(result.status) || result.status < 100 || result.status > 599
      || typeof result.statusText !== 'string' || result.statusText.length > 256
      || typeof result.hasBody !== 'boolean'
      || Object.keys(headers).length > 16
      || Object.entries(headers).some(([name, headerValue]) => name.length > 128
        || typeof headerValue !== 'string' || headerValue.length > 2048)) return null;
  return Object.freeze({
    streamId: result.streamId,
    status: result.status,
    statusText: result.statusText,
    headers: Object.freeze({ ...headers }),
    hasBody: result.hasBody,
  });
};

/** @param {unknown} value */
export const parseRuntimeRichReadInferenceValue = (value) => {
  const result = record(value);
  if (!result || typeof result.done !== 'boolean') return null;
  if (result.done === true) {
    return exactKeys(result, ['done']) ? Object.freeze({ done: true }) : null;
  }
  return exactKeys(result, ['done', 'chunk']) && result.chunk instanceof Uint8Array
    && result.chunk.byteLength <= 64 * KIB
    ? Object.freeze({ done: false, chunk: result.chunk }) : null;
};

/** @param {unknown} value */
export const parseRuntimeRichOpenLocalValue = (value) => {
  const result = record(value);
  return result && exactKeys(result, ['streamId'])
    && typeof result.streamId === 'string' && result.streamId.length >= 8
    && result.streamId.length <= 256
    ? Object.freeze({ streamId: result.streamId }) : null;
};

/** @param {unknown} value */
export const parseRuntimeRichReadLocalValue = (value) => {
  const result = record(value);
  if (!result || typeof result.done !== 'boolean') return null;
  if (result.done) return exactKeys(result, ['done']) ? Object.freeze({ done: true }) : null;
  return exactKeys(result, ['done', 'token'])
    && typeof result.token === 'string' && result.token.length <= 64 * KIB
    ? Object.freeze({ done: false, token: result.token }) : null;
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
  let pendingIrreversible = 0;
  let settledIrreversible = false;
  let unknownIrreversible = false;
  const irreversible = (/** @type {string} */ operation) => operation.startsWith('rich.model.');
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
    if (irreversible(operation)) pendingIrreversible += 1;
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
    const validEnvelope = !!reply && typeof reply.ok === 'boolean'
      && typeof reply.outcomeKnown === 'boolean' && bounded(reply, effect.resultBytes);
    const settleCustody = (/** @type {boolean} */ accepted) => {
      if (!irreversible(operation)) return;
      pendingIrreversible = Math.max(0, pendingIrreversible - 1);
      if (!accepted || reply?.outcomeKnown !== true) unknownIrreversible = true;
      else if (reply.ok === true || reply.retryable !== true) settledIrreversible = true;
    };
    const invalid = () => {
      settleCustody(false);
      return refused('runtime-effect-result-invalid', false);
    };
    if (!validEnvelope) return invalid();
    if (operation === 'runtime.bootstrap.read' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeBootstrapProjection(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.script.admit' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichAdmitProjection(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.model.open-inference' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichOpenInferenceValue(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.model.read-inference' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichReadInferenceValue(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.model.cancel-inference' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || reply.value !== null)) {
      return invalid();
    }
    if (operation === 'rich.model.open-local' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichOpenLocalValue(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.model.read-local' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || !parseRuntimeRichReadLocalValue(reply.value))) {
      return invalid();
    }
    if (operation === 'rich.model.cancel-local' && reply.ok === true
        && (reply.outcomeKnown !== true
          || !exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
          || reply.value !== null)) {
      return invalid();
    }
    if (operation === 'rich.model.observe-usage' && reply.ok === true
        && (reply.outcomeKnown !== true || !exactKeys(reply, ['ok', 'outcomeKnown']))) {
      return invalid();
    }
    if (operation === 'rich.script.abort' && reply.ok === true
        && (reply.outcomeKnown !== true || !exactKeys(reply, ['ok', 'outcomeKnown']))) {
      return invalid();
    }
    settleCustody(true);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  const custody = () => pendingIrreversible > 0 || unknownIrreversible
    ? Object.freeze({ outcomeKnown: false, retryable: false })
    : Object.freeze({ outcomeKnown: true, retryable: !settledIrreversible });
  return Object.freeze({
    admit,
    observe,
    pendingCap,
    pendingLoss: (/** @type {string} */ operation) => irreversible(operation)
      ? Object.freeze({ outcomeKnown: false, retryable: false })
      : Object.freeze({ outcomeKnown: true, retryable: true }),
    custody,
  });
};

export const RUNTIME_DISPATCH_OUTER_BYTES = Math.max(
  ...Object.values(RUNTIME_DISPATCH_MANIFEST).map((policy) => policy.inputBytes),
) + KIB;
