// @ts-check
// Contributor Metrics local shell: one atomic consent+aggregate record and
// bounded local-only idempotency/correlation. Network IO intentionally absent.

import {
  CONTRIBUTOR_DISCLOSURE_VERSION, CONTRIBUTOR_LOCAL_VERSION,
  CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT, CONTRIBUTOR_MAX_LOCAL_DEDUPE,
  CONTRIBUTOR_SCHEMA_VERSION,
  ContributorSchemaError, adjustContributorFeedback, contributorCohortKey,
  emptyContributorLocalState, normalizeContributorCohort,
  recordContributorWebAction, recordContributorWebTurn,
  serializeContributorEnvelope,
} from './contributor-metrics.js';
import {
  opaqueContributorToken, validContributorToken,
} from '/shared/contributor-channel.js';

export const CONTRIBUTOR_LOCAL_KEY = 'contributor_metrics.aggregate.v1';

const RECORD_KEYS = Object.freeze(['version', 'consent', 'aggregate']);
const CONSENT_KEYS = Object.freeze([
  'enabled', 'schemaVersion', 'disclosureVersion', 'generation',
]);

export class ContributorReadOnlyError extends Error {
  /** @param {number} version */
  constructor(version) {
    super(`contributor state v${version} is newer than supported v${CONTRIBUTOR_LOCAL_VERSION}`);
    this.name = 'ContributorReadOnlyError';
    this.code = 'contributor-state-newer-read-only';
  }
}

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

/** @returns {string} */
const randomGeneration = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

/** @param {unknown} value */
const localKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200
  ? value
  : null;

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, delete: (key: string) => Promise<void> }} deps.kv
 * @param {() => string} [deps.makeGeneration]
 * @param {(kind: string, generation: string, value: string) => Promise<string>} [deps.tokenizeLocalKey]
 */
export const makeContributorStore = ({
  kv, makeGeneration = randomGeneration, tokenizeLocalKey = opaqueContributorToken,
}) => {
  let mutationTail = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  const mutate = (operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  /** @param {unknown} stored */
  const normalizeRecord = (stored) => {
    if (stored == null) return null;
    if (typeof stored !== 'object' || Array.isArray(stored)) {
      throw new ContributorSchemaError('local contributor state is malformed');
    }
    const candidate = /** @type {Record<string, any>} */ (stored);
    if (!Number.isSafeInteger(candidate.version)) {
      throw new ContributorSchemaError('local contributor state is malformed');
    }
    if (candidate.version > CONTRIBUTOR_LOCAL_VERSION) {
      throw new ContributorReadOnlyError(candidate.version);
    }
    if (candidate.version !== CONTRIBUTOR_LOCAL_VERSION) {
      throw new ContributorSchemaError('unsupported older local contributor version');
    }
    requireExactKeys(candidate, RECORD_KEYS, 'local contributor record');
    requireExactKeys(candidate.consent, CONSENT_KEYS, 'local contributor consent');
    if (candidate.consent.enabled !== true
        || !Number.isSafeInteger(candidate.consent.schemaVersion)
        || !Number.isSafeInteger(candidate.consent.disclosureVersion)
        || !localKey(candidate.consent.generation)) {
      throw new ContributorSchemaError('local contributor consent is malformed');
    }
    // Round-trip validation happens before any mutation. Rebuild local-only
    // maps from their bounded order lists, avoiding an unbounded Object.entries
    // walk if browser storage was corrupted outside this module.
    serializeContributorEnvelope(candidate.aggregate);
    const aggregate = /** @type {ReturnType<typeof emptyContributorLocalState>} */ (candidate.aggregate);
    const dedupe = Array.isArray(aggregate.dedupe)
      ? aggregate.dedupe.filter((/** @type {unknown} */ key) => localKey(key)).slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE)
      : [];
    const contextOrder = Array.isArray(aggregate.contextOrder)
      ? aggregate.contextOrder.filter((/** @type {unknown} */ key) => localKey(key)).slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE)
      : [];
    const feedbackOrder = Array.isArray(aggregate.feedbackOrder)
      ? aggregate.feedbackOrder.filter((/** @type {unknown} */ key) => localKey(key)).slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE)
      : [];
    return {
      version: CONTRIBUTOR_LOCAL_VERSION,
      consent: { ...candidate.consent },
      aggregate: {
        ...aggregate,
        dedupe,
        contexts: Object.fromEntries(contextOrder.flatMap((/** @type {string} */ key) =>
          typeof aggregate.contexts?.[key] === 'string' ? [[key, aggregate.contexts[key]]] : [])),
        contextOrder,
        feedback: Object.fromEntries(feedbackOrder.flatMap((/** @type {string} */ key) => {
          const record = aggregate.feedback?.[key];
          return record && typeof record.cohortKey === 'string'
            && (record.verdict === 'worked' || record.verdict === 'didnt_work')
            ? [[key, { cohortKey: record.cohortKey, verdict: record.verdict }]] : [];
        })),
        feedbackOrder,
      },
    };
  };

  const loadRecord = async () => normalizeRecord(await kv.get(CONTRIBUTOR_LOCAL_KEY));
  const currentConsent = (/** @type {any} */ record) => record != null
    && record.consent.schemaVersion === CONTRIBUTOR_SCHEMA_VERSION
    && record.consent.disclosureVersion === CONTRIBUTOR_DISCLOSURE_VERSION;

  // A turn arms once at its start. Settlement presents this generation again;
  // the store also rechecks the current record, so disable and disable→enable
  // both win over already-running work.
  const arm = async () => {
    try {
      const record = await loadRecord();
      return currentConsent(record)
        ? Object.freeze({ enabled: true, generation: record?.consent.generation })
        : Object.freeze({ enabled: false, generation: null });
    } catch {
      return Object.freeze({ enabled: false, generation: null });
    }
  };

  const status = async () => {
    try {
      const record = await loadRecord();
      if (!record) {
        return Object.freeze({
          enabled: false, schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
          disclosureVersion: CONTRIBUTOR_DISCLOSURE_VERSION,
          bytes: null, rowCount: 0, diagnostic: null,
        });
      }
      if (!currentConsent(record)) {
        return Object.freeze({
          enabled: false, schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
          disclosureVersion: CONTRIBUTOR_DISCLOSURE_VERSION,
          bytes: null, rowCount: 0, diagnostic: 'contributor-reconsent-required',
        });
      }
      const serialized = serializeContributorEnvelope(record.aggregate);
      return Object.freeze({
        enabled: true, schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
        disclosureVersion: CONTRIBUTOR_DISCLOSURE_VERSION,
        bytes: serialized.bytes, rowCount: serialized.envelope.rows.length,
        diagnostic: null,
      });
    } catch (error) {
      const diagnostic = error instanceof ContributorReadOnlyError
        ? error.code
        : 'contributor-state-invalid';
      return Object.freeze({
        enabled: false, schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
        disclosureVersion: CONTRIBUTOR_DISCLOSURE_VERSION,
        bytes: null, rowCount: 0, diagnostic,
      });
    }
  };

  const enable = () => mutate(async () => {
    const stored = await kv.get(CONTRIBUTOR_LOCAL_KEY);
    if (stored?.version > CONTRIBUTOR_LOCAL_VERSION) {
      throw new ContributorReadOnlyError(stored.version);
    }
    const existing = stored == null ? null : normalizeRecord(stored);
    if (currentConsent(existing)) return status();
    await kv.set(CONTRIBUTOR_LOCAL_KEY, {
      version: CONTRIBUTOR_LOCAL_VERSION,
      consent: {
        enabled: true,
        schemaVersion: CONTRIBUTOR_SCHEMA_VERSION,
        disclosureVersion: CONTRIBUTOR_DISCLOSURE_VERSION,
        generation: makeGeneration(),
      },
      aggregate: emptyContributorLocalState(),
    });
    return status();
  });

  const disableAndClear = () => mutate(async () => {
    // why: deleting consent is the revocation commit. The authority owner hides
    // every outbox receipt without this exact generation and resumes physical
    // outbox cleanup independently after a partial storage failure.
    await kv.delete(CONTRIBUTOR_LOCAL_KEY);
    return status();
  });

  /** @param {ReturnType<typeof emptyContributorLocalState>} state @param {string} key */
  const rememberDedupe = (state, key) => ({
    ...state,
    dedupe: [...state.dedupe.filter((candidate) => candidate !== key), key]
      .slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE),
  });

  /** @param {ReturnType<typeof emptyContributorLocalState>} state @param {string} key @param {string} cohortKey */
  const rememberContext = (state, key, cohortKey) => {
    const order = [...state.contextOrder.filter((candidate) => candidate !== key), key]
      .slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE);
    const keep = new Set(order);
    return {
      ...state,
      contexts: Object.fromEntries([
        ...Object.entries(state.contexts).filter(([candidate]) => keep.has(candidate)),
        [key, cohortKey],
      ]),
      contextOrder: order,
    };
  };

  /**
   * One durable actor delivery becomes one aggregate transaction. The mailbox's
   * correlation id is the local-only operation key; replay after an MV3 restart
   * either commits the complete turn once or observes the same dedupe row.
   * @param {{ consentGeneration?: unknown, operationToken?: unknown, feedbackContextToken?: unknown, turn?: unknown, actions?: unknown }} input
   */
  const recordWebSettlement = (input) => mutate(async () => {
    requireExactKeys(input, [
      'consentGeneration', 'operationToken', 'feedbackContextToken', 'turn', 'actions',
    ], 'web settlement');
    const generation = localKey(input.consentGeneration);
    const operationToken = validContributorToken(input.operationToken, 'operation')
      ? /** @type {string} */ (input.operationToken) : null;
    if (!generation || !operationToken || !Array.isArray(input.actions)
        || input.actions.length > CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT) return false;
    const record = await loadRecord();
    if (!record || !currentConsent(record) || record.consent.generation !== generation) return false;
    let next = record.aggregate;
    if (next.dedupe.includes(operationToken)) return false;
    for (const action of input.actions) {
      next = recordContributorWebAction(next, /** @type {Record<string, unknown>} */ (action));
    }
    next = recordContributorWebTurn(next, /** @type {Record<string, unknown>} */ (input.turn));
    next = rememberDedupe(next, operationToken);
    const feedbackContextToken = input.feedbackContextToken == null ? null
      : validContributorToken(input.feedbackContextToken, 'context')
        ? /** @type {string} */ (input.feedbackContextToken) : undefined;
    if (feedbackContextToken === undefined) return false;
    if (feedbackContextToken) {
      const cohortKey = contributorCohortKey(normalizeContributorCohort(
        /** @type {Record<string, unknown>} */ (input.turn),
      ));
      next = rememberContext(next, feedbackContextToken, cohortKey);
    }
    await kv.set(CONTRIBUTOR_LOCAL_KEY, { ...record, aggregate: next });
    return true;
  });

  /**
   * Candidate keys and the selection key are derived from a host-validated
   * human turn. They remain only in the bounded local association maps.
   * @param {{ selectionKey?: unknown, verdict?: unknown, candidateContextKeys?: unknown }} input
   */
  const recordFeedback = (input) => mutate(async () => {
    requireExactKeys(input, ['selectionKey', 'verdict', 'candidateContextKeys'], 'feedback selection');
    const record = await loadRecord();
    if (!record || !currentConsent(record)) return { recorded: false, reason: 'disabled' };
    const state = record.aggregate;
    const rawSelectionKey = localKey(input.selectionKey);
    const rawCandidates = Array.isArray(input.candidateContextKeys)
      ? input.candidateContextKeys.map(localKey).filter((candidate) => typeof candidate === 'string')
      : [];
    if (!rawSelectionKey || rawCandidates.length === 0) return { recorded: false, reason: 'no-cohort' };
    const selectionKey = localKey(await tokenizeLocalKey(
      'selection', record.consent.generation, rawSelectionKey,
    ));
    const candidates = (await Promise.all(rawCandidates.map((candidate) => tokenizeLocalKey(
      'context', record.consent.generation, candidate,
    )))).map(localKey).filter((candidate) => typeof candidate === 'string');
    if (!selectionKey || candidates.length === 0) return { recorded: false, reason: 'no-cohort' };
    const contextKey = [...candidates].reverse().find((key) => state.contexts[key]);
    if (!contextKey) return { recorded: false, reason: 'no-cohort' };
    const previousRecord = state.feedback[selectionKey];
    const cohortKey = previousRecord?.cohortKey && state.rows[previousRecord.cohortKey]
      ? previousRecord.cohortKey
      : state.contexts[contextKey];
    const previous = previousRecord?.cohortKey === cohortKey ? previousRecord.verdict : null;
    const verdict = /** @type {'worked'|'didnt_work'} */ (input.verdict);
    let next = adjustContributorFeedback(state, { cohortKey, verdict, previous });
    const feedbackOrder = [...next.feedbackOrder.filter((key) => key !== selectionKey), selectionKey]
      .slice(-CONTRIBUTOR_MAX_LOCAL_DEDUPE);
    const keep = new Set(feedbackOrder);
    next = {
      ...next,
      feedback: Object.fromEntries([
        ...Object.entries(next.feedback).filter(([key]) => keep.has(key)),
        [selectionKey, { cohortKey, verdict }],
      ]),
      feedbackOrder,
    };
    await kv.set(CONTRIBUTOR_LOCAL_KEY, { ...record, aggregate: next });
    return { recorded: previous !== verdict, reason: null };
  });

  return Object.freeze({ arm, status, enable, disableAndClear, recordWebSettlement, recordFeedback });
};
