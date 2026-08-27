// @ts-check
// Contributor Metrics: the closed, local-only contribution core.
//
// This is deliberately NOT an analytics/event API. Callers may fold only the
// two reviewed v1 facts below: one settled web-actor turn, or one settled page
// action. The core owns every key, enum, histogram bucket, and cap; arbitrary
// names/property bags never cross this boundary.
//
// IO is absent. Consent, persistence, human-sender checks, and the later upload
// lifecycle belong to the background shell. That split keeps the exact bytes
// shown in Settings independently testable and makes it impossible for a
// storage/debug convenience to widen the contribution envelope.

import { FAILURE_KINDS, classifyFailure } from './failure-classify.js';
import { WEB_ACTOR_CODE_CLIENT_TOOL_NAMES } from '../actor/capability-manifest.js';
import {
  CONTRIBUTOR_ACTION_KINDS, CONTRIBUTOR_BROWSERS, CONTRIBUTOR_CHANNELS,
  CONTRIBUTOR_FAILURES, CONTRIBUTOR_FALLBACKS, CONTRIBUTOR_FEATURES, CONTRIBUTOR_FEEDBACK,
  CONTRIBUTOR_CLASSIFICATION_CODE_MAX, CONTRIBUTOR_OUTCOMES, CONTRIBUTOR_SURFACES,
} from '/shared/contributor-channel.js';

export {
  CONTRIBUTOR_ACTION_KINDS, CONTRIBUTOR_BROWSERS, CONTRIBUTOR_CHANNELS,
  CONTRIBUTOR_FAILURES, CONTRIBUTOR_FALLBACKS, CONTRIBUTOR_FEATURES, CONTRIBUTOR_FEEDBACK,
  CONTRIBUTOR_OUTCOMES, CONTRIBUTOR_SURFACES,
} from '/shared/contributor-channel.js';

export const CONTRIBUTOR_PROVIDERS = Object.freeze([
  'anthropic', 'openrouter', 'openai', 'glm', 'ollama', 'local-webgpu', 'custom',
]);
export const CONTRIBUTOR_MODEL_FAMILIES = Object.freeze([
  'claude-opus', 'claude-sonnet', 'claude-haiku', 'gpt', 'openai-o', 'glm',
  'gemini', 'qwen', 'llama', 'deepseek', 'mistral', 'grok', 'command',
  'hermes', 'kimi', 'minimax', 'gemma', 'muse-glimmer', 'custom',
]);

export const CONTRIBUTOR_SCHEMA_VERSION = 1;
export const CONTRIBUTOR_DISCLOSURE_VERSION = 1;
export const CONTRIBUTOR_LOCAL_VERSION = 1;
export const CONTRIBUTOR_MAX_ROWS = 256;
export const CONTRIBUTOR_MAX_COUNTER = 1_000_000_000;
export const CONTRIBUTOR_MAX_LOCAL_DEDUPE = 512;
export const CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT = 128;

export const CONTRIBUTOR_DURATION_BUCKETS = Object.freeze([
  'under_1s', '1s_to_5s', '5s_to_15s', '15s_to_60s', '60s_or_more',
]);
export const CONTRIBUTOR_TOKEN_BUCKETS = Object.freeze([
  'none', '1_to_1k', '1k_to_4k', '4k_to_16k', '16k_to_64k', '64k_or_more',
]);

// Exact shipped/catalog ids only. A prefix matcher would let an attacker turn
// a model id into a covert arbitrary-string channel (for example
// `gpt-5-<encoded-origin>`). Conservative misses become `custom`; they never
// make serialization less safe and can be reviewed into a later schema.
export const CONTRIBUTOR_KNOWN_MODEL_FAMILIES = Object.freeze({
  'claude-opus-4-8': 'claude-opus',
  'claude-opus-4-7': 'claude-opus',
  'claude-opus-4-6': 'claude-opus',
  'claude-sonnet-4-6': 'claude-sonnet',
  'claude-haiku-4-5-20251001': 'claude-haiku',
  'claude-haiku-4-5': 'claude-haiku',
  'anthropic/claude-sonnet-4-6': 'claude-sonnet',
  'anthropic/claude-haiku-4.5': 'claude-haiku',
  'anthropic/claude-3.7-sonnet': 'claude-sonnet',
  'anthropic/claude-3.5-sonnet': 'claude-sonnet',
  'anthropic/claude-3.5-haiku': 'claude-haiku',
  'gpt-5.1': 'gpt',
  'gpt-5.1-mini': 'gpt',
  'gpt-5': 'gpt',
  'gpt-5-mini': 'gpt',
  'gpt-4.1': 'gpt',
  'gpt-4.1-mini': 'gpt',
  'gpt-4o': 'gpt',
  'gpt-4o-mini': 'gpt',
  'openai/gpt-4o': 'gpt',
  'openai/gpt-4o-mini': 'gpt',
  'o4-mini': 'openai-o',
  'openai/o4-mini': 'openai-o',
  'glm-5.2': 'glm',
  'glm-4.6': 'glm',
  'glm-4.5-air': 'glm',
  'z-ai/glm-5.1': 'glm',
  'z-ai/glm-5.2': 'glm',
  'google/gemini-3-flash': 'gemini',
  'google/gemini-2.5-pro': 'gemini',
  'google/gemini-2.5-flash': 'gemini',
  'google/gemini-2.0-flash-001': 'gemini',
  'google/gemini-2.0-flash': 'gemini',
  'qwen/qwen3-coder': 'qwen',
  'qwen/qwen-2.5-72b-instruct': 'qwen',
  'qwen3:32b': 'qwen',
  'qwen3:14b': 'qwen',
  'qwen3:8b': 'qwen',
  'qwen3:4b': 'qwen',
  'meta-llama/llama-3.3-70b-instruct': 'llama',
  'meta-llama/llama-3.1-8b-instruct': 'llama',
  'deepseek/deepseek-chat': 'deepseek',
  'deepseek/deepseek-r1': 'deepseek',
  'mistralai/mistral-large': 'mistral',
  'mistralai/mistral-nemo': 'mistral',
  'x-ai/grok-2': 'grok',
  'x-ai/grok-beta': 'grok',
  'cohere/command-r-plus': 'command',
  'nousresearch/hermes-3-llama-3.1-70b': 'hermes',
  'moonshotai/kimi-k2.6': 'kimi',
  'minimax/minimax-m2': 'minimax',
  'gemma-4-e2b': 'gemma',
  'muse-glimmer-30b': 'muse-glimmer',
});

const ROW_DIMENSION_KEYS = Object.freeze([
  'feature', 'requested', 'resolved', 'fallback', 'browser', 'extensionVersion',
  'channel', 'provider', 'modelFamily',
]);
const COHORT_INPUT_KEYS = Object.freeze([
  'feature', 'requested', 'resolved', 'fallback', 'browser', 'extensionVersion',
  'channel', 'provider', 'model',
]);
const TURN_OBSERVATION_KEYS = Object.freeze([
  ...COHORT_INPUT_KEYS, 'outcome', 'failure', 'durationMs', 'tokens',
]);
const ACTION_OBSERVATION_KEYS = Object.freeze([...COHORT_INPUT_KEYS, 'action']);
const ROW_METRIC_KEYS = Object.freeze([
  'completed', 'cancelled', 'errors', 'actorTurns', 'pageCodeRuns',
  'pageActionCalls', 'duration', 'tokens', 'failures', 'worked', 'didntWork',
]);
const LOCAL_STATE_KEYS = Object.freeze([
  'version', 'rows', 'dedupe', 'contexts', 'contextOrder', 'feedback', 'feedbackOrder',
]);

/**
 * @typedef {Object} ContributorLocalState
 * @property {number} version
 * @property {Record<string, any>} rows
 * @property {string[]} dedupe
 * @property {Record<string, string>} contexts
 * @property {string[]} contextOrder
 * @property {Record<string, { cohortKey: string, verdict: 'worked'|'didnt_work' }>} feedback
 * @property {string[]} feedbackOrder
 */

export class ContributorSchemaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ContributorSchemaError';
  }
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label */
const requireEnum = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ContributorSchemaError(`${label}: invalid enum`);
  }
  return value;
};

/** @param {unknown} value @param {string} label */
const requireCounter = (value, label) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > CONTRIBUTOR_MAX_COUNTER) {
    throw new ContributorSchemaError(`${label}: invalid counter`);
  }
  return Number(value);
};

/** @param {Record<string, unknown>} value @param {readonly string[]} keys @param {string} label */
const requireExactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContributorSchemaError(`${label}: object required`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ContributorSchemaError(`${label}: unknown or missing key`);
  }
};

/** @param {readonly string[]} buckets */
const emptyHistogram = (buckets) => Object.fromEntries(buckets.map((bucket) => [bucket, 0]));

/** @param {unknown} provider */
export const normalizeContributorProvider = (provider) =>
  typeof provider === 'string' && CONTRIBUTOR_PROVIDERS.includes(provider)
    ? provider
    : 'custom';

/** @param {unknown} model */
export const normalizeContributorModelFamily = (model) =>
  typeof model === 'string' && Object.hasOwn(CONTRIBUTOR_KNOWN_MODEL_FAMILIES, model)
    ? /** @type {Record<string, string>} */ (CONTRIBUTOR_KNOWN_MODEL_FAMILIES)[model]
    : typeof model === 'string' && CONTRIBUTOR_MODEL_FAMILIES.includes(model)
      ? model
    : 'custom';

/** @param {unknown} provider */
export const contributorProviderCode = (provider) =>
  CONTRIBUTOR_PROVIDERS.indexOf(normalizeContributorProvider(provider));

/** @param {unknown} model */
export const contributorModelFamilyCode = (model) =>
  CONTRIBUTOR_MODEL_FAMILIES.indexOf(normalizeContributorModelFamily(model));

/** @param {unknown} code */
export const contributorProviderFromCode = (code) => Number.isSafeInteger(code)
  && Number(code) >= 0 && Number(code) <= CONTRIBUTOR_CLASSIFICATION_CODE_MAX
  ? CONTRIBUTOR_PROVIDERS[Number(code)] : undefined;

/** @param {unknown} code */
export const contributorModelFamilyFromCode = (code) => Number.isSafeInteger(code)
  && Number(code) >= 0 && Number(code) <= CONTRIBUTOR_CLASSIFICATION_CODE_MAX
  ? CONTRIBUTOR_MODEL_FAMILIES[Number(code)] : undefined;

/** @param {unknown} durationMs */
export const contributorDurationBucket = (durationMs) => {
  const value = typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? Math.max(0, durationMs) : 0;
  if (value < 1_000) return 'under_1s';
  if (value < 5_000) return '1s_to_5s';
  if (value < 15_000) return '5s_to_15s';
  if (value < 60_000) return '15s_to_60s';
  return '60s_or_more';
};

/** @param {unknown} tokens */
export const contributorTokenBucket = (tokens) => {
  const value = Number.isSafeInteger(tokens) && Number(tokens) > 0 ? Number(tokens) : 0;
  if (value === 0) return 'none';
  if (value < 1_000) return '1_to_1k';
  if (value < 4_000) return '1k_to_4k';
  if (value < 16_000) return '4k_to_16k';
  if (value < 64_000) return '16k_to_64k';
  return '64k_or_more';
};

/**
 * Map the runtime's two comparable web surfaces into the closed action enum.
 * The direct-tool side is derived from the page code-client manifest, so a new
 * page method cannot be counted on one arm while silently disappearing from
 * the other.
 * @param {unknown} toolName
 * @returns {'page_code'|'page_action'|null}
 */
export const contributorActionForTool = (toolName) => toolName === 'page_code'
  ? 'page_code'
  : typeof toolName === 'string' && WEB_ACTOR_CODE_CLIENT_TOOL_NAMES.includes(toolName)
    ? 'page_action'
    : null;

/**
 * Reduce a settled actor transcript to the operational result enums. Output
 * truncation/step exhaustion and an incomplete provider stream are failures,
 * never clean completion; the distinction is necessary because this metric is
 * explicitly not a task-success proxy.
 * @param {{ assistantMessages?: unknown, stopped?: unknown, result?: unknown }} input
 * @returns {{ outcome: 'completed'|'cancelled'|'error', failure: string }}
 */
export const contributorTurnResult = ({ assistantMessages, stopped, result }) => {
  const messages = Array.isArray(assistantMessages) ? assistantMessages : [];
  const failed = [...messages].reverse().find((entry) =>
    typeof entry?.error === 'string' && entry.error.length > 0);
  const last = messages.at(-1);
  const stopReason = typeof last?.stopReason === 'string' ? last.stopReason : undefined;
  const aborted = messages.some((entry) => entry?.stopReason === 'aborted')
    || (!failed && stopped === true
      && /stopped before it produced a reply/i.test(typeof result === 'string' ? result : ''));
  if (aborted) return Object.freeze({ outcome: 'cancelled', failure: 'none' });
  if (failed) {
    return Object.freeze({
      outcome: 'error', failure: classifyFailure(failed.error, { stopReason }).kind,
    });
  }
  if (stopReason === 'max_tokens' || stopReason === 'max_steps') {
    return Object.freeze({ outcome: 'error', failure: 'limits' });
  }
  if (stopReason === 'incomplete') {
    return Object.freeze({ outcome: 'error', failure: 'provider' });
  }
  if (stopped === true) {
    return Object.freeze({ outcome: 'error', failure: classifyFailure(result).kind });
  }
  return Object.freeze({ outcome: 'completed', failure: 'none' });
};

/** @param {Record<string, string>} dimensions */
export const emptyContributorRow = (dimensions) => ({
  ...dimensions,
  completed: 0,
  cancelled: 0,
  errors: 0,
  actorTurns: 0,
  pageCodeRuns: 0,
  pageActionCalls: 0,
  duration: emptyHistogram(CONTRIBUTOR_DURATION_BUCKETS),
  tokens: emptyHistogram(CONTRIBUTOR_TOKEN_BUCKETS),
  failures: emptyHistogram(CONTRIBUTOR_FAILURES),
  worked: 0,
  didntWork: 0,
});

/** @returns {ContributorLocalState} */
export const emptyContributorLocalState = () => ({
  version: CONTRIBUTOR_LOCAL_VERSION,
  rows: {},
  dedupe: [],
  contexts: {},
  contextOrder: [],
  feedback: {},
  feedbackOrder: [],
});

/**
 * Normalize raw runtime facts into the ONLY cohort dimensions the accumulator
 * accepts. The returned object contains no caller-controlled string.
 * @param {Record<string, unknown>} input
 */
export const normalizeContributorCohort = (input) => ({
  feature: requireEnum(input.feature ?? 'web_actor_surface', CONTRIBUTOR_FEATURES, 'feature'),
  requested: requireEnum(input.requested, CONTRIBUTOR_SURFACES, 'requested'),
  resolved: requireEnum(input.resolved, CONTRIBUTOR_SURFACES, 'resolved'),
  fallback: requireEnum(input.fallback, CONTRIBUTOR_FALLBACKS, 'fallback'),
  browser: requireEnum(input.browser, CONTRIBUTOR_BROWSERS, 'browser'),
  extensionVersion: normalizeExtensionVersion(input.extensionVersion),
  channel: requireEnum(input.channel, CONTRIBUTOR_CHANNELS, 'channel'),
  provider: normalizeContributorProvider(input.provider),
  modelFamily: normalizeContributorModelFamily(input.model),
});

/** @param {unknown} version */
export const normalizeExtensionVersion = (version) => {
  // Manifest-generated semver only. No prerelease/build suffix: those strings
  // could carry opaque caller bytes and are not produced by peerd packaging.
  if (typeof version !== 'string' || !/^0\.[0-9]{1,4}\.[0-9]{1,4}$/.test(version)) {
    throw new ContributorSchemaError('extensionVersion: invalid generated version');
  }
  return version;
};

/** @param {Record<string, unknown>} dimensions */
export const contributorCohortKey = (dimensions) =>
  ROW_DIMENSION_KEYS.map((key) => String(dimensions[key])).join('\u001f');

/** @param {number} value @param {number} increment */
const addCounter = (value, increment = 1) => {
  const next = value + increment;
  if (!Number.isSafeInteger(next) || next > CONTRIBUTOR_MAX_COUNTER) {
    throw new ContributorSchemaError('counter cap exceeded');
  }
  return next;
};

/** @param {ReturnType<typeof emptyContributorLocalState>} state @param {Record<string, string>} cohort */
const rowFor = (state, cohort) => {
  const key = contributorCohortKey(cohort);
  const existing = state.rows[key];
  if (existing) return { key, row: existing };
  if (Object.keys(state.rows).length >= CONTRIBUTOR_MAX_ROWS) {
    throw new ContributorSchemaError('row cap exceeded');
  }
  return { key, row: emptyContributorRow(cohort) };
};

/**
 * Fold one settled web-actor turn. `operationKey` is deliberately NOT part of
 * this pure operation: the storage shell performs local-only idempotency before
 * calling it, so no identifier can accidentally join the row shape.
 * @param {ContributorLocalState} state
 * @param {Record<string, unknown>} observation
 */
export const recordContributorWebTurn = (state, observation) => {
  requireExactKeys(observation, TURN_OBSERVATION_KEYS, 'web turn observation');
  const cohort = normalizeContributorCohort(observation);
  const outcome = requireEnum(observation.outcome, CONTRIBUTOR_OUTCOMES, 'outcome');
  const failure = outcome === 'error'
    ? requireEnum(observation.failure, FAILURE_KINDS, 'failure')
    : 'none';
  const durationBucket = contributorDurationBucket(observation.durationMs);
  const tokenBucket = contributorTokenBucket(observation.tokens);
  const { key, row } = rowFor(state, cohort);
  const nextRow = {
    ...row,
    completed: addCounter(row.completed, outcome === 'completed' ? 1 : 0),
    cancelled: addCounter(row.cancelled, outcome === 'cancelled' ? 1 : 0),
    errors: addCounter(row.errors, outcome === 'error' ? 1 : 0),
    actorTurns: addCounter(row.actorTurns),
    duration: { ...row.duration, [durationBucket]: addCounter(row.duration[durationBucket]) },
    tokens: { ...row.tokens, [tokenBucket]: addCounter(row.tokens[tokenBucket]) },
    failures: { ...row.failures, [failure]: addCounter(row.failures[failure]) },
  };
  return { ...state, rows: { ...state.rows, [key]: nextRow } };
};

/**
 * Fold one settled web-page control call. The kind is an enum, never a tool
 * name: adding a future action requires a reviewed schema edit here.
 * @param {ContributorLocalState} state
 * @param {Record<string, unknown>} observation
 */
export const recordContributorWebAction = (state, observation) => {
  requireExactKeys(observation, ACTION_OBSERVATION_KEYS, 'web action observation');
  const cohort = normalizeContributorCohort(observation);
  const action = requireEnum(observation.action, CONTRIBUTOR_ACTION_KINDS, 'action');
  const { key, row } = rowFor(state, cohort);
  const nextRow = {
    ...row,
    pageCodeRuns: addCounter(row.pageCodeRuns, action === 'page_code' ? 1 : 0),
    pageActionCalls: addCounter(row.pageActionCalls, action === 'page_action' ? 1 : 0),
  };
  return { ...state, rows: { ...state.rows, [key]: nextRow } };
};

/**
 * Apply or change binary feedback for one locally resolved cohort. The caller
 * owns the bounded message association; only the previous enum and cohort key
 * reach this reducer, and neither is serialized.
 * @param {ContributorLocalState} state
 * @param {{ cohortKey: string, verdict: unknown, previous?: unknown }} input
 */
export const adjustContributorFeedback = (state, { cohortKey, verdict, previous }) => {
  const nextVerdict = requireEnum(verdict, CONTRIBUTOR_FEEDBACK, 'feedback');
  const prior = previous == null ? null : requireEnum(previous, CONTRIBUTOR_FEEDBACK, 'previous feedback');
  const row = state.rows[cohortKey];
  if (!row) throw new ContributorSchemaError('feedback cohort missing');
  if (prior === nextVerdict) return state;
  const worked = row.worked - (prior === 'worked' ? 1 : 0) + (nextVerdict === 'worked' ? 1 : 0);
  const didntWork = row.didntWork - (prior === 'didnt_work' ? 1 : 0) + (nextVerdict === 'didnt_work' ? 1 : 0);
  return {
    ...state,
    rows: {
      ...state.rows,
      [cohortKey]: {
        ...row,
        worked: requireCounter(worked, 'worked'),
        didntWork: requireCounter(didntWork, 'didntWork'),
      },
    },
  };
};

/** @param {Record<string, unknown>} row */
const validateAndFreezeRow = (row) => {
  requireExactKeys(row, [...ROW_DIMENSION_KEYS, ...ROW_METRIC_KEYS], 'row');
  const dimensions = {
    feature: requireEnum(row.feature, CONTRIBUTOR_FEATURES, 'feature'),
    requested: requireEnum(row.requested, CONTRIBUTOR_SURFACES, 'requested'),
    resolved: requireEnum(row.resolved, CONTRIBUTOR_SURFACES, 'resolved'),
    fallback: requireEnum(row.fallback, CONTRIBUTOR_FALLBACKS, 'fallback'),
    browser: requireEnum(row.browser, CONTRIBUTOR_BROWSERS, 'browser'),
    extensionVersion: normalizeExtensionVersion(row.extensionVersion),
    channel: requireEnum(row.channel, CONTRIBUTOR_CHANNELS, 'channel'),
    provider: requireEnum(row.provider, CONTRIBUTOR_PROVIDERS, 'provider'),
    modelFamily: requireEnum(row.modelFamily, CONTRIBUTOR_MODEL_FAMILIES, 'modelFamily'),
  };
  /** @param {unknown} value @param {readonly string[]} buckets @param {string} label */
  const histogram = (value, buckets, label) => {
    requireExactKeys(/** @type {Record<string, unknown>} */ (value), buckets, label);
    return Object.freeze(Object.fromEntries(buckets.map((bucket) => [
      bucket,
      requireCounter(/** @type {Record<string, unknown>} */ (value)[bucket], `${label}.${bucket}`),
    ])));
  };
  const actorTurns = requireCounter(row.actorTurns, 'actorTurns');
  const completed = requireCounter(row.completed, 'completed');
  const cancelled = requireCounter(row.cancelled, 'cancelled');
  const errors = requireCounter(row.errors, 'errors');
  if (completed + cancelled + errors !== actorTurns) {
    throw new ContributorSchemaError('operational counters do not equal actorTurns');
  }
  const duration = histogram(row.duration, CONTRIBUTOR_DURATION_BUCKETS, 'duration');
  const tokens = histogram(row.tokens, CONTRIBUTOR_TOKEN_BUCKETS, 'tokens');
  const failures = histogram(row.failures, CONTRIBUTOR_FAILURES, 'failures');
  /** @param {Record<string, number>} value */
  const sum = (value) => Object.values(value).reduce((total, count) => total + count, 0);
  if (sum(duration) !== actorTurns || sum(tokens) !== actorTurns || sum(failures) !== actorTurns) {
    throw new ContributorSchemaError('histogram total does not equal actorTurns');
  }
  if (failures.none !== completed + cancelled || sum(failures) - failures.none !== errors) {
    throw new ContributorSchemaError('failure histogram does not match outcomes');
  }
  const pageCodeRuns = requireCounter(row.pageCodeRuns, 'pageCodeRuns');
  const pageActionCalls = requireCounter(row.pageActionCalls, 'pageActionCalls');
  if (pageCodeRuns + pageActionCalls > actorTurns * CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT) {
    throw new ContributorSchemaError('action counters exceed per-turn cap');
  }
  return Object.freeze({
    ...dimensions,
    completed,
    cancelled,
    errors,
    actorTurns,
    pageCodeRuns,
    pageActionCalls,
    duration,
    tokens,
    failures,
    worked: requireCounter(row.worked, 'worked'),
    didntWork: requireCounter(row.didntWork, 'didntWork'),
  });
};

/**
 * Produce the exact canonical envelope and bytes a later uploader must seal.
 * Local state and rows are both exact-key validated before rebuilding the
 * envelope field-by-field; unknown/newer local versions fail closed.
 * @param {ContributorLocalState} state
 */
export const serializeContributorEnvelope = (state) => {
  if (!state || state.version !== CONTRIBUTOR_LOCAL_VERSION) {
    throw new ContributorSchemaError('unsupported local contributor version');
  }
  requireExactKeys(/** @type {Record<string, unknown>} */ (state), LOCAL_STATE_KEYS, 'local state');
  if (!state.rows || typeof state.rows !== 'object' || Array.isArray(state.rows)) {
    throw new ContributorSchemaError('rows: object required');
  }
  const entries = Object.entries(state.rows ?? {});
  if (entries.length > CONTRIBUTOR_MAX_ROWS) throw new ContributorSchemaError('row cap exceeded');
  const cohortKeys = new Set();
  const frozenRows = entries.map(([storedKey, row]) => {
    const frozen = validateAndFreezeRow(/** @type {Record<string, unknown>} */ (row));
    const canonicalKey = contributorCohortKey(frozen);
    if (storedKey !== canonicalKey || cohortKeys.has(canonicalKey)) {
      throw new ContributorSchemaError('row cohort index is noncanonical or duplicated');
    }
    cohortKeys.add(canonicalKey);
    if (frozen.worked + frozen.didntWork > frozen.actorTurns) {
      throw new ContributorSchemaError('feedback total exceeds actorTurns');
    }
    return frozen;
  }).sort((left, right) => contributorCohortKey(left).localeCompare(contributorCohortKey(right)));
  const envelope = Object.freeze({
    schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
    rows: Object.freeze(frozenRows),
  });
  return Object.freeze({ envelope, bytes: JSON.stringify(envelope) });
};
