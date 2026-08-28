// @ts-check

import { controllerPayloadBytes } from './structured-clone-size.js';
import {
  COMPOSER_COMMAND_BODY_BYTES,
  COMPOSER_COMMAND_DESCRIPTION_BYTES,
  COMPOSER_COMMAND_LIMIT,
  COMPOSER_COMMAND_NAME_BYTES,
  COMPOSER_EFFECT_BYTES,
  COMPOSER_EFFECT_ERROR_BYTES,
  COMPOSER_FILE_CONTENT_BYTES,
  COMPOSER_INPUT_OUTER_BYTES,
  COMPOSER_INPUT_TEXT_BYTES,
  COMPOSER_OUTPUT_OUTER_BYTES,
  COMPOSER_OUTPUT_TEXT_BYTES,
  COMPOSER_REFERENCE_ERROR_BYTES,
  COMPOSER_REFERENCE_LIMIT,
  COMPOSER_REFERENCE_PATH_BYTES,
  COMPOSER_REFERENCE_RAW_BYTES,
  COMPOSER_RESULT_CODE_BYTES,
  COMPOSER_TAB_METADATA_BYTES,
  COMPOSER_TAB_TEXT_BYTES,
  composerUtf8Fits,
} from './composer-reference-policy.js';

const OWNER_ID = 'peerd-authority-kernel';

export const TURN_COMPOSE_CAPABILITY = 'turn.compose';
export const TURN_PHASE_CAPABILITIES = Object.freeze([TURN_COMPOSE_CAPABILITY]);

const isRecord = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (/** @type {Record<string,unknown>} */ value,
  /** @type {readonly string[]} */ keys) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const bounded = (/** @type {unknown} */ value, /** @type {number} */ maxBytes) => {
  const bytes = controllerPayloadBytes(value, { maxDepth: 24, maxNodes: 50_000 });
  return Number.isFinite(bytes) && bytes <= maxBytes;
};

const EFFECTS = Object.freeze({
  'turn.compose.list-commands': Object.freeze({ calls: 1, keys: Object.freeze([]) }),
  'turn.compose.capture-tab': Object.freeze({
    calls: COMPOSER_REFERENCE_LIMIT, keys: Object.freeze(['tabId']),
  }),
  'turn.compose.read-file': Object.freeze({
    calls: COMPOSER_REFERENCE_LIMIT, keys: Object.freeze(['path']),
  }),
});

export const turnPhaseOuterPayloadCap = (/** @type {string} */ capability) =>
  capability === TURN_COMPOSE_CAPABILITY ? COMPOSER_INPUT_OUTER_BYTES : 0;

export const turnPhasePayloadAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => {
  if (capability !== TURN_COMPOSE_CAPABILITY || !isRecord(payload)) return false;
  const input = /** @type {Record<string,unknown>} */ (payload);
  return exactKeys(input, ['text']) && typeof input.text === 'string'
    && input.text.length > 0 && composerUtf8Fits(input.text, COMPOSER_INPUT_TEXT_BYTES)
    && bounded(input, COMPOSER_INPUT_OUTER_BYTES);
};

export const turnPhaseAuthorityFor = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => turnPhasePayloadAllowed(capability, payload)
  ? Object.freeze({
    ownerId: OWNER_ID, sessionId: null, instanceId: null, origin: null,
    target: 'turn-compose', replayClass: 'A',
  }) : null;

export const turnPhaseAuthorityAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ payload, /** @type {unknown} */ authority) => {
  if (!turnPhasePayloadAllowed(capability, payload) || !isRecord(authority)) return false;
  const value = /** @type {Record<string,unknown>} */ (authority);
  return value.ownerId === OWNER_ID && value.sessionId === null
    && value.instanceId === null && value.origin === null
    && value.target === 'turn-compose' && value.replayClass === 'A';
};

const validEffectPayload = (/** @type {string} */ operation,
  /** @type {unknown} */ payload) => {
  const policy = EFFECTS[/** @type {keyof typeof EFFECTS} */ (operation)];
  if (!policy || !isRecord(payload)) return false;
  const input = /** @type {Record<string,unknown>} */ (payload);
  if (!exactKeys(input, policy.keys) || !bounded(input, COMPOSER_EFFECT_BYTES)) return false;
  if (operation === 'turn.compose.capture-tab') {
    return input.tabId === null
      || Number.isSafeInteger(input.tabId) && Number(input.tabId) > 0;
  }
  if (operation === 'turn.compose.read-file') {
    return typeof input.path === 'string' && input.path.length > 0
      && composerUtf8Fits(input.path, COMPOSER_REFERENCE_PATH_BYTES);
  }
  return true;
};

const boundedString = (/** @type {unknown} */ value, /** @type {number} */ limit) =>
  composerUtf8Fits(value, limit);
const exactFailure = (/** @type {unknown} */ result) => {
  if (!isRecord(result)) return false;
  const value = /** @type {Record<string,unknown>} */ (result);
  const keys = value.outcomeKnown === false
    ? ['ok', 'outcomeKnown', 'error', 'retryable'] : ['ok', 'outcomeKnown', 'error'];
  return exactKeys(value, keys)
    && value.ok === false
    && (value.outcomeKnown === true
      || value.outcomeKnown === false && value.retryable === false)
    && boundedString(value.error, COMPOSER_EFFECT_ERROR_BYTES);
};
const validEffectResult = (/** @type {string} */ operation,
  /** @type {unknown} */ result) => {
  if (exactFailure(result)) return true;
  if (!isRecord(result)) return false;
  const reply = /** @type {Record<string,unknown>} */ (result);
  if (!exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
      || reply.ok !== true || reply.outcomeKnown !== true) return false;
  if (operation === 'turn.compose.list-commands') {
    if (!Array.isArray(reply.value) || reply.value.length > COMPOSER_COMMAND_LIMIT) return false;
    return reply.value.every((candidate) => isRecord(candidate)
      && exactKeys(candidate, ['name', 'body', 'description'])
      && boundedString(candidate.name, COMPOSER_COMMAND_NAME_BYTES)
      && candidate.name.length > 0
      && boundedString(candidate.body, COMPOSER_COMMAND_BODY_BYTES)
      && boundedString(candidate.description, COMPOSER_COMMAND_DESCRIPTION_BYTES));
  }
  if (!isRecord(reply.value)) return false;
  const value = /** @type {Record<string,unknown>} */ (reply.value);
  if (operation === 'turn.compose.capture-tab') {
    if (!exactKeys(value, ['origin', 'snapshot'])
        || !boundedString(value.origin, COMPOSER_TAB_METADATA_BYTES)
        || !isRecord(value.snapshot)) return false;
    const snapshot = /** @type {Record<string,unknown>} */ (value.snapshot);
    return exactKeys(snapshot, ['title', 'url', 'text'])
      && boundedString(snapshot.title, COMPOSER_TAB_METADATA_BYTES)
      && boundedString(snapshot.url, COMPOSER_TAB_METADATA_BYTES)
      && boundedString(snapshot.text, COMPOSER_TAB_TEXT_BYTES);
  }
  return operation === 'turn.compose.read-file'
    && exactKeys(value, ['content'])
    && boundedString(value.content, COMPOSER_FILE_CONTENT_BYTES);
};

export const createTurnPhaseQuota = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => {
  const valid = turnPhasePayloadAllowed(capability, payload);
  const counts = new Map();
  let referenceCalls = 0;
  const refused = (code = 'kernel-operation-denied') => Object.freeze({
    ok: false, code, outcomeKnown: true,
  });
  return Object.freeze({
    admit: (/** @type {string} */ operation, /** @type {unknown} */ effectPayload) => {
      const policy = EFFECTS[/** @type {keyof typeof EFFECTS} */ (operation)];
      if (!valid || !policy || !validEffectPayload(operation, effectPayload)) return refused();
      const used = counts.get(operation) ?? 0;
      if (used >= policy.calls) return refused('kernel-operation-budget-exhausted');
      if ((operation === 'turn.compose.capture-tab' || operation === 'turn.compose.read-file')
          && referenceCalls >= COMPOSER_REFERENCE_LIMIT) {
        return refused('kernel-operation-budget-exhausted');
      }
      counts.set(operation, used + 1);
      if (operation === 'turn.compose.capture-tab' || operation === 'turn.compose.read-file') {
        referenceCalls += 1;
      }
      return Object.freeze({ ok: true, outcomeKnown: true });
    },
    observe: (/** @type {string} */ operation, /** @type {unknown} */ _effectPayload,
      /** @type {unknown} */ result) => EFFECTS[/** @type {keyof typeof EFFECTS} */ (operation)]
      && bounded(result, COMPOSER_EFFECT_BYTES) && validEffectResult(operation, result)
      ? Object.freeze({ ok: true, outcomeKnown: true })
      : Object.freeze({
        ok: false, code: 'kernel-operation-result-invalid',
        outcomeKnown: false, retryable: false,
      }),
    pendingCap: 8,
    pendingLoss: () => Object.freeze({ outcomeKnown: true, retryable: true }),
    custody: () => Object.freeze({ outcomeKnown: true, retryable: true }),
  });
};

export const turnPhaseResultAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ result) => {
  if (capability !== TURN_COMPOSE_CAPABILITY || !isRecord(result)
      || !bounded(result, COMPOSER_OUTPUT_OUTER_BYTES)) return false;
  const reply = /** @type {Record<string,unknown>} */ (result);
  if (exactKeys(reply, ['ok', 'code', 'outcomeKnown'])) {
    return reply.ok === false && reply.outcomeKnown === true
      && boundedString(reply.code, COMPOSER_RESULT_CODE_BYTES);
  }
  if (!exactKeys(reply, ['ok', 'outcomeKnown', 'value'])
      || reply.ok !== true || reply.outcomeKnown !== true || !isRecord(reply.value)) return false;
  const value = /** @type {Record<string,unknown>} */ (reply.value);
  if (!exactKeys(value, ['text', 'command', 'commandFound', 'refs'])
      || !boundedString(value.text, COMPOSER_OUTPUT_TEXT_BYTES)
      || !(value.command === null
        || boundedString(value.command, COMPOSER_COMMAND_NAME_BYTES))
      || typeof value.commandFound !== 'boolean'
      || !Array.isArray(value.refs) || value.refs.length > COMPOSER_REFERENCE_LIMIT) return false;
  return value.refs.every((ref) => {
    if (!isRecord(ref)) return false;
    if (ref.ok === true) {
      return exactKeys(ref, ['raw', 'ok'])
        && boundedString(ref.raw, COMPOSER_REFERENCE_RAW_BYTES);
    }
    return ref.ok === false && exactKeys(ref, ['raw', 'ok', 'error'])
      && boundedString(ref.raw, COMPOSER_REFERENCE_RAW_BYTES)
      && boundedString(ref.error, COMPOSER_REFERENCE_ERROR_BYTES);
  });
};
