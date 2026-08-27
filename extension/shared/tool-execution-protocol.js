// @ts-check

import { structuredClonePayloadBytes } from './structured-clone-size.js';

export const TOOL_EXECUTION_CAPABILITY = 'tool.execute';
export const TOOL_EXECUTION_PROTOCOL = 1;

const DEFAULT_ARGUMENT_BYTES = 256 * 1024;
const DEFAULT_PROJECTION_BYTES = 256 * 1024;
const DEFAULT_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_PENDING_EFFECTS = 4;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const AUTHORITY_CLASS = /^[a-z][a-z0-9-]{0,63}$/;
const EFFECT_METHOD = /^[a-z][a-zA-Z0-9]{0,63}$/;
const EFFECT_OPERATION = /^[a-z][a-z0-9.-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const GENERIC_EFFECT_METHODS = new Set(['call', 'execute', 'invoke', 'perform', 'request', 'run']);
export const TOOL_EFFECT_RISK_CLASSES = Object.freeze([
  'read', 'control', 'commit', 'resource',
]);
const TOOL_EFFECT_RISK_CLASS_SET = /** @type {Set<string>} */ (
  new Set(TOOL_EFFECT_RISK_CLASSES)
);
const SCHEMA_TYPES = new Set(['null', 'boolean', 'string', 'number', 'integer', 'array', 'object']);

const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
const plainRecord = (/** @type {unknown} */ value) => {
  const object = record(value);
  if (!object) return null;
  const prototype = Object.getPrototypeOf(object);
  return prototype === Object.prototype || prototype === null ? object : null;
};
const bounded = (/** @type {unknown} */ value, /** @type {number} */ maxBytes) => {
  const bytes = structuredClonePayloadBytes(value, { maxDepth: 32, maxNodes: 250_000 });
  return Number.isFinite(bytes) && bytes <= maxBytes;
};
const positiveInteger = (/** @type {unknown} */ value, /** @type {number} */ fallback) =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
const refusal = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown = true) =>
  Object.freeze({ ok: false, code, outcomeKnown });

/** @template T @param {T} value @returns {T} */
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

/** @typedef {Record<string, any> & {type:string}} ExactSchema */
/** @returns {ExactSchema} */
const compileExactSchema = (/** @type {unknown} */ value, /** @type {number} */ depth = 0) => {
  const schema = plainRecord(value);
  if (!schema || depth > 16 || typeof schema.type !== 'string'
      || !SCHEMA_TYPES.has(schema.type)) throw new TypeError('tool-effect-schema-invalid');
  if (schema.type === 'object') {
    const properties = plainRecord(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : null;
    if (!properties || !required || new Set(required).size !== required.length
        || required.some((key) => typeof key !== 'string'
          || !Object.hasOwn(properties, key))
        || Object.keys(schema).some((key) => !['type', 'properties', 'required'].includes(key))) {
      throw new TypeError('tool-effect-schema-invalid');
    }
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties)
        .map(([key, child]) => [key, compileExactSchema(child, depth + 1)])),
      required: [...required],
    };
  }
  if (schema.type === 'array') {
    if (!Object.hasOwn(schema, 'items')
        || Object.keys(schema).some((key) => !['type', 'items', 'maxItems'].includes(key))
        || (schema.maxItems !== undefined
          && (!Number.isSafeInteger(schema.maxItems) || Number(schema.maxItems) < 0))) {
      throw new TypeError('tool-effect-schema-invalid');
    }
    return {
      type: 'array',
      items: compileExactSchema(schema.items, depth + 1),
      ...(schema.maxItems === undefined ? {} : { maxItems: Number(schema.maxItems) }),
    };
  }
  if (schema.type === 'string') {
    if (Object.keys(schema).some((key) => !['type', 'maxLength'].includes(key))
        || (schema.maxLength !== undefined
          && (!Number.isSafeInteger(schema.maxLength) || Number(schema.maxLength) < 0))) {
      throw new TypeError('tool-effect-schema-invalid');
    }
    return {
      type: 'string',
      ...(schema.maxLength === undefined ? {} : { maxLength: Number(schema.maxLength) }),
    };
  }
  if (Object.keys(schema).some((key) => key !== 'type')) {
    throw new TypeError('tool-effect-schema-invalid');
  }
  return { type: schema.type };
};

/** @returns {boolean} */
const exactSchemaAllows = (
  /** @type {unknown} */ value,
  /** @type {ExactSchema} */ schema,
  /** @type {number} */ depth = 0,
) => {
  if (depth > 16) return false;
  switch (schema.type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string'
      && (schema.maxLength === undefined || value.length <= schema.maxLength);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'array': {
      if (!Array.isArray(value)
          || (schema.maxItems !== undefined && value.length > schema.maxItems)) return false;
      const keys = Object.keys(value);
      return keys.length === value.length && keys.every((key, index) =>
        key === String(index) && exactSchemaAllows(value[index], schema.items, depth + 1));
    }
    case 'object': {
      const object = plainRecord(value);
      if (!object || Object.keys(object).some((key) => !Object.hasOwn(schema.properties, key))
          || schema.required.some((/** @type {string} */ key) => !Object.hasOwn(object, key))) {
        return false;
      }
      return Object.entries(object).every(([key, child]) =>
        exactSchemaAllows(child, schema.properties[key], depth + 1));
    }
    default: return false;
  }
};

/**
 * Loss before an effect is always replayable. Read/control effects are also
 * replayable while in flight; commit/resource effects become known only after
 * the kernel has observed their exact reply.
 * @param {unknown} riskClass
 * @param {'before'|'during'|'after'} phase
 */
export const toolEffectLossSemantics = (riskClass, phase) => {
  if (typeof riskClass !== 'string' || !TOOL_EFFECT_RISK_CLASS_SET.has(riskClass)
      || !['before', 'during', 'after'].includes(phase)) {
    throw new TypeError('tool-effect-loss-semantics-invalid');
  }
  const replayable = phase === 'before' || riskClass === 'read' || riskClass === 'control';
  return Object.freeze({
    outcomeKnown: phase !== 'during' || replayable,
    retryable: replayable,
  });
};

/**
 * Validate an outcome explicitly supplied by one exact authority operation.
 * Fulfillment alone is deliberately not evidence that an effect happened.
 * @param {unknown} value
 * @returns {'performed'|'not-performed'|'unknown'}
 */
export const normalizeHostEffectOutcome = (value) =>
  value === 'performed' || value === 'not-performed' ? value : 'unknown';

/**
 * Replace controller/Worker custody claims with the authority host's verdict.
 * Semantic result content remains useful, but only the host can say whether an
 * exact irreversible/resource operation entered or completed.
 * @param {unknown} reported
 * @param {{effectEntered:boolean,performed:boolean,invalidCode?:string,invalidError?:string}} verdict
 */
export const stampHostEffectVerdict = (reported, verdict) => {
  const result = record(reported);
  const base = result ?? {
    ok: false,
    code: verdict.invalidCode ?? 'tool-result-invalid',
    error: verdict.invalidError ?? 'Tool executor returned an invalid result.',
  };
  const {
    effectEntered: _reportedEffectEntered,
    performed: _reportedPerformed,
    outcomeKind: _reportedOutcomeKind,
    ...semantic
  } = base;
  const performed = verdict.performed === true;
  return {
    ...semantic,
    outcomeKnown: true,
    effectEntered: verdict.effectEntered === true,
    performed,
    ...(semantic.ok === false ? {
      ...(performed ? { retryable: false } : {}),
      outcomeKind: performed ? 'effect-completed' : 'pre-effect-failure',
    } : {}),
  };
};

/**
 * Compile the code-owned effect vocabulary. Each implementation receives only
 * the named methods listed for its tool; the generic reverse-RPC transport is
 * never exposed to tool code.
 * @param {unknown} value
 */
export const compileToolEffectManifest = (value) => {
  const input = record(value);
  const tools = record(input?.tools);
  if (!input || input.protocol !== TOOL_EXECUTION_PROTOCOL
      || typeof input.digest !== 'string' || !DIGEST.test(input.digest)
      || !tools || Object.keys(input).some((key) => !['protocol', 'digest', 'tools'].includes(key))) {
    throw new TypeError('tool-effect-manifest-invalid');
  }
  /** @type {Record<string, any>} */
  const compiledTools = {};
  for (const [toolName, rawTool] of Object.entries(tools)) {
    const tool = record(rawTool);
    const rawEffects = Array.isArray(tool?.effects) ? tool.effects : null;
    const projectionKeys = Array.isArray(tool?.projectionKeys)
      && tool.projectionKeys.every((key) => typeof key === 'string'
        && /^[a-z][a-zA-Z0-9]{0,63}$/.test(key))
      && new Set(tool.projectionKeys).size === tool.projectionKeys.length
      ? [...tool.projectionKeys] : null;
    if (!TOOL_NAME.test(toolName) || !tool || !rawEffects
        || !projectionKeys
        || Object.keys(tool).some((key) => ![
          'effects', 'projectionKeys', 'argumentBytes', 'projectionBytes',
          'resultBytes', 'pendingEffects',
        ].includes(key))) {
      throw new TypeError(`tool-effect-manifest-tool-invalid:${toolName}`);
    }
    const methods = new Set();
    const operations = new Set();
    const effects = rawEffects.map((rawEffect) => {
      const effect = record(rawEffect);
      if (!effect || !EFFECT_METHOD.test(effect.method)
          || GENERIC_EFFECT_METHODS.has(effect.method)
          || !EFFECT_OPERATION.test(effect.operation)
          || methods.has(effect.method) || operations.has(effect.operation)
          || !TOOL_EFFECT_RISK_CLASS_SET.has(effect.riskClass)
          || Object.keys(effect).some((key) => ![
            'method', 'operation', 'riskClass', 'requestSchema', 'resultSchema',
            'maxCalls', 'requestBytes', 'resultBytes',
          ].includes(key))) {
        throw new TypeError(`tool-effect-manifest-effect-invalid:${toolName}`);
      }
      methods.add(effect.method);
      operations.add(effect.operation);
      return {
        method: effect.method,
        operation: effect.operation,
        riskClass: effect.riskClass,
        requestSchema: compileExactSchema(effect.requestSchema),
        resultSchema: compileExactSchema(effect.resultSchema),
        maxCalls: positiveInteger(effect.maxCalls, 1),
        requestBytes: positiveInteger(effect.requestBytes, DEFAULT_ARGUMENT_BYTES),
        resultBytes: positiveInteger(effect.resultBytes, DEFAULT_RESULT_BYTES),
      };
    });
    compiledTools[toolName] = {
      effects,
      projectionKeys,
      argumentBytes: positiveInteger(tool.argumentBytes, DEFAULT_ARGUMENT_BYTES),
      projectionBytes: positiveInteger(tool.projectionBytes, DEFAULT_PROJECTION_BYTES),
      resultBytes: positiveInteger(tool.resultBytes, DEFAULT_RESULT_BYTES),
      pendingEffects: positiveInteger(tool.pendingEffects, DEFAULT_PENDING_EFFECTS),
    };
  }
  return deepFreeze({
    protocol: TOOL_EXECUTION_PROTOCOL,
    digest: input.digest,
    tools: compiledTools,
  });
};

/**
 * @param {unknown} value
 * @param {ReturnType<typeof compileToolEffectManifest>} manifest
 */
export const parseToolExecutionRequest = (value, manifest) => {
  const input = record(value);
  if (!input || input.protocol !== TOOL_EXECUTION_PROTOCOL
      || typeof input.executionId !== 'string' || !IDENTIFIER.test(input.executionId)
      || typeof input.runId !== 'string' || !IDENTIFIER.test(input.runId)
      || typeof input.callId !== 'string' || !IDENTIFIER.test(input.callId)
      || typeof input.sessionId !== 'string' || !IDENTIFIER.test(input.sessionId)
      || !Number.isSafeInteger(input.turnGeneration) || Number(input.turnGeneration) < 0
      || !Number.isSafeInteger(input.attempt) || Number(input.attempt) < 0
      || typeof input.toolName !== 'string' || !TOOL_NAME.test(input.toolName)
      || typeof input.authorityClass !== 'string'
      || !AUTHORITY_CLASS.test(input.authorityClass)
      || typeof input.argsDigest !== 'string' || !DIGEST.test(input.argsDigest)
      || input.manifestDigest !== manifest.digest
      || Object.keys(input).some((key) => ![
        'protocol', 'executionId', 'runId', 'callId', 'sessionId',
        'turnGeneration', 'attempt', 'toolName', 'authorityClass',
        'argsDigest', 'manifestDigest',
        'args', 'projection',
      ].includes(key))) return null;
  const policy = manifest.tools[input.authorityClass];
  const projection = record(input.projection);
  if (!policy || !bounded(input.args, policy.argumentBytes)
      || !projection || Object.keys(projection).some((key) => !policy.projectionKeys.includes(key))
      || !bounded(projection, policy.projectionBytes)) return null;
  return Object.freeze({
    protocol: TOOL_EXECUTION_PROTOCOL,
    executionId: input.executionId,
    runId: input.runId,
    callId: input.callId,
    sessionId: input.sessionId,
    turnGeneration: input.turnGeneration,
    attempt: input.attempt,
    toolName: input.toolName,
    authorityClass: input.authorityClass,
    argsDigest: input.argsDigest,
    manifestDigest: input.manifestDigest,
    args: input.args,
    projection,
    policy,
  });
};

/**
 * Stateful mirror for the controller transport and the kernel authority. The
 * kernel must instantiate its own copy so neither side can widen a grant.
 * @param {ReturnType<typeof compileToolEffectManifest>['tools'][string]} policy
 */
export const createToolEffectQuota = (policy) => {
  const effects = new Map(policy.effects.map((/** @type {any} */ effect) => [effect.operation, effect]));
  const counts = new Map();
  const pending = new Map();
  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const effect = effects.get(operation);
    if (!effect) return refusal('tool-effect-denied');
    if (!exactSchemaAllows(payload, effect.requestSchema)) {
      return refusal('tool-effect-request-invalid');
    }
    if (!bounded(payload, effect.requestBytes)) return refusal('tool-effect-payload-too-large');
    const used = counts.get(operation) ?? 0;
    if (used >= effect.maxCalls) return refusal('tool-effect-budget-exhausted');
    counts.set(operation, used + 1);
    pending.set(operation, (pending.get(operation) ?? 0) + 1);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  const observe = (/** @type {string} */ operation, /** @type {unknown} */ result) => {
    const effect = effects.get(operation);
    const inFlight = pending.get(operation) ?? 0;
    if (!effect || inFlight < 1) return refusal('tool-effect-reply-unmatched', false);
    if (inFlight === 1) pending.delete(operation);
    else pending.set(operation, inFlight - 1);
    const reply = record(result);
    const allowedKeys = reply?.ok === true
      ? ['ok', 'outcomeKnown', 'value']
      : ['ok', 'code', 'outcomeKnown', 'error', 'retryable'];
    const success = reply?.ok === true && reply.outcomeKnown === true
      && Object.hasOwn(reply, 'value') && exactSchemaAllows(reply.value, effect.resultSchema);
    const failure = reply?.ok === false && typeof reply.code === 'string'
      && ERROR_CODE.test(reply.code) && typeof reply.outcomeKnown === 'boolean'
      && (reply.error === undefined
        || (typeof reply.error === 'string' && reply.error.length <= 4_096))
      && (reply.retryable === undefined || typeof reply.retryable === 'boolean')
      && !(reply.outcomeKnown === false && reply.retryable === true);
    if (!reply || Object.keys(reply).some((key) => !allowedKeys.includes(key))
        || (!success && !failure) || !bounded(result, effect.resultBytes)) {
      return refusal('tool-effect-result-invalid', false);
    }
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  return Object.freeze({ admit, observe, pendingCap: policy.pendingEffects });
};

/** @param {unknown} result @param {number} maxBytes */
export const toolExecutionResultAllowed = (result, maxBytes) => {
  const envelope = record(result);
  if (!envelope || envelope.protocol !== TOOL_EXECUTION_PROTOCOL
      || typeof envelope.ok !== 'boolean' || typeof envelope.outcomeKnown !== 'boolean'
      || typeof envelope.effectEntered !== 'boolean'
      || typeof envelope.executionId !== 'string' || !IDENTIFIER.test(envelope.executionId)
      || typeof envelope.argsDigest !== 'string' || !DIGEST.test(envelope.argsDigest)
      || (envelope.ok === true && (envelope.outcomeKnown !== true
        || !Object.hasOwn(envelope, 'value')
        || Object.keys(envelope).some((key) => ![
          'protocol', 'executionId', 'argsDigest', 'ok', 'outcomeKnown',
          'effectEntered', 'value',
        ].includes(key))))
      || (envelope.ok === false && (typeof envelope.code !== 'string'
        || !ERROR_CODE.test(envelope.code)
        || (envelope.error !== undefined
          && (typeof envelope.error !== 'string' || envelope.error.length > 4_096))
        || (envelope.retryable !== undefined && typeof envelope.retryable !== 'boolean')
        || (envelope.phase !== undefined && !['startup', 'run'].includes(envelope.phase))
        || (envelope.outcomeKnown === false && envelope.retryable === true)
        || Object.keys(envelope).some((key) => ![
          'protocol', 'executionId', 'argsDigest', 'ok', 'outcomeKnown',
          'effectEntered', 'error', 'code', 'retryable', 'phase',
        ].includes(key))))
      || !bounded(result, maxBytes)) return false;
  return true;
};

/**
 * Validate the same execution envelope after the authority host has added its
 * effect verdict. Controller-authored envelopes never enter through this lane.
 * @param {unknown} result
 * @param {number} maxBytes
 */
export const hostToolExecutionResultAllowed = (result, maxBytes) => {
  const envelope = record(result);
  if (!envelope) return false;
  const hasVerdict = Object.hasOwn(envelope, 'performed')
    || Object.hasOwn(envelope, 'outcomeKind');
  if (!hasVerdict) return toolExecutionResultAllowed(result, maxBytes);
  if (typeof envelope.performed !== 'boolean'
      || envelope.outcomeKnown !== true
      || (envelope.ok === false
        && envelope.outcomeKind !== (envelope.performed
          ? 'effect-completed' : 'pre-effect-failure'))
      || (envelope.ok === true && envelope.outcomeKind !== undefined)) return false;
  const {
    performed: _performed,
    outcomeKind: _outcomeKind,
    ...controllerEnvelope
  } = envelope;
  return toolExecutionResultAllowed(controllerEnvelope, maxBytes)
    && bounded(result, maxBytes);
};
