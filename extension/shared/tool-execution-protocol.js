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
const EFFECT_METHOD = /^[a-z][a-zA-Z0-9]{0,63}$/;
const EFFECT_OPERATION = /^[a-z][a-z0-9.-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GENERIC_EFFECT_METHODS = new Set(['call', 'execute', 'invoke', 'perform', 'request', 'run']);

const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
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
          || Object.keys(effect).some((key) => ![
            'method', 'operation', 'maxCalls', 'requestBytes', 'resultBytes',
          ].includes(key))) {
        throw new TypeError(`tool-effect-manifest-effect-invalid:${toolName}`);
      }
      methods.add(effect.method);
      operations.add(effect.operation);
      return {
        method: effect.method,
        operation: effect.operation,
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
      || typeof input.argsDigest !== 'string' || !DIGEST.test(input.argsDigest)
      || input.manifestDigest !== manifest.digest
      || Object.keys(input).some((key) => ![
        'protocol', 'executionId', 'runId', 'callId', 'sessionId',
        'turnGeneration', 'attempt', 'toolName', 'argsDigest', 'manifestDigest',
        'args', 'projection',
      ].includes(key))) return null;
  const policy = manifest.tools[input.toolName];
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
    if (!reply || typeof reply.ok !== 'boolean' || typeof reply.outcomeKnown !== 'boolean'
        || !bounded(result, effect.resultBytes)) {
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
      || Object.keys(envelope).some((key) => ![
        'protocol', 'executionId', 'argsDigest', 'ok', 'outcomeKnown',
        'effectEntered', 'value', 'error', 'code', 'retryable', 'phase',
      ].includes(key))
      || (envelope.ok === true && !Object.hasOwn(envelope, 'value'))
      || (envelope.ok === false && typeof envelope.code !== 'string')
      || !bounded(result, maxBytes)) return false;
  return true;
};
