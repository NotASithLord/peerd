// @ts-check
// Durable single-batch lifecycle for the preview-only contribution sink.
// Network IO, canonical validation, alarms, and storage are injected; this
// state machine owns byte freezing, crash-safe admission, and revocation races.

import {
  CONTRIBUTION_MAX_BODY_BYTES, CONTRIBUTION_SCHEMA_VERSION,
  validateContributionBatchBytes,
} from './client.js';

export const CONTRIBUTION_UPLOAD_STATE_VERSION = 1;
export const CONTRIBUTION_UPLOAD_STATE_KEY = 'contributor_upload.sealed.v1';
export const CONTRIBUTION_MAX_SEALED_BATCHES = 1;
export const CONTRIBUTION_MAX_RETRY_ATTEMPTS = 10;
export const CONTRIBUTION_RETRY_BASE_MS = 60_000;
export const CONTRIBUTION_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
// Must stay below the collector's minimum dedupe-token horizon. A client must
// never retry an old token after the sink may have forgotten it.
export const CONTRIBUTION_SEALED_RETENTION_MS = 5 * 24 * 60 * 60 * 1_000;
export const CONTRIBUTION_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const STATE_KEYS = Object.freeze(['version', 'sealed']);
const SEALED_KEYS = Object.freeze([
  'batchId', 'bytes', 'rowCount', 'sealedAt', 'attempts', 'admittedAt',
  'dispatchStage', 'nextAttemptAt',
]);
const DISPATCH_STAGES = Object.freeze(['idle', 'admitted', 'dispatched']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * @typedef {Object} SealedBatch
 * @property {string} batchId
 * @property {string} bytes
 * @property {number} rowCount
 * @property {number} sealedAt
 * @property {number} attempts
 * @property {number|null} admittedAt
 * @property {'idle'|'admitted'|'dispatched'} dispatchStage
 * @property {number|null} nextAttemptAt
 */

/** @typedef {{ version: number, sealed: SealedBatch }} UploadState */
/**
 * @typedef {Object} SendOutcome
 * @property {boolean} sent
 * @property {boolean} accepted
 * @property {string|null} reason
 * @property {number|null} [nextAttemptAt]
 * @property {string|null} [diagnostic]
 */
/** @typedef {{ ok: false, outcome: SendOutcome } | { ok: true, sealed: SealedBatch }} Admission */

export class ContributionUploadStateError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'ContributionUploadStateError';
    this.code = code;
  }
}

export class ContributionUploadReadOnlyError extends ContributionUploadStateError {
  /** @param {number} version */
  constructor(version) {
    super('contribution-upload-state-newer-read-only');
    this.name = 'ContributionUploadReadOnlyError';
    this.version = version;
  }
}

/** @param {unknown} value @param {readonly string[]} expected */
const requireExactKeys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
};

/**
 * Storage is attacker/corruption-controlled input. Re-enter the complete #345
 * canonical validator on every load; the batch wrapper's own exact-key check
 * is necessary but not sufficient to reject an arbitrary URL/content row.
 * @param {unknown} stored
 * @param {(bytes: string) => { schemaVersion: number, rows: readonly unknown[] }} validateCanonicalBytes
 * @param {number} at
 * @returns {UploadState|null}
 */
const normalizeState = (stored, validateCanonicalBytes, at) => {
  if (stored == null) return null;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
      || !Number.isSafeInteger(/** @type {any} */ (stored).version)) {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
  const candidate = /** @type {Record<string, any>} */ (stored);
  if (candidate.version > CONTRIBUTION_UPLOAD_STATE_VERSION) {
    throw new ContributionUploadReadOnlyError(candidate.version);
  }
  if (candidate.version !== CONTRIBUTION_UPLOAD_STATE_VERSION) {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
  requireExactKeys(candidate, STATE_KEYS);
  requireExactKeys(candidate.sealed, SEALED_KEYS);
  const sealed = /** @type {Record<string, any>} */ (candidate.sealed);
  const admittedAtValid = sealed.admittedAt === null
    || (Number.isSafeInteger(sealed.admittedAt) && sealed.admittedAt >= sealed.sealedAt
      && sealed.admittedAt <= at + CONTRIBUTION_MAX_CLOCK_SKEW_MS);
  const nextAttemptAtValid = sealed.nextAttemptAt === null
    || (Number.isSafeInteger(sealed.nextAttemptAt) && sealed.nextAttemptAt >= sealed.sealedAt
      && sealed.nextAttemptAt <= at + CONTRIBUTION_RETRY_MAX_MS + CONTRIBUTION_MAX_CLOCK_SKEW_MS
      && sealed.nextAttemptAt <= sealed.sealedAt + CONTRIBUTION_SEALED_RETENTION_MS
        + CONTRIBUTION_RETRY_MAX_MS + CONTRIBUTION_MAX_CLOCK_SKEW_MS);
  if (typeof sealed.batchId !== 'string' || !UUID_V4.test(sealed.batchId)
      || typeof sealed.bytes !== 'string'
      || !Number.isSafeInteger(sealed.rowCount) || sealed.rowCount < 1
      || !Number.isSafeInteger(sealed.sealedAt) || sealed.sealedAt < 0
      || sealed.sealedAt > at + CONTRIBUTION_MAX_CLOCK_SKEW_MS
      || !Number.isSafeInteger(sealed.attempts) || sealed.attempts < 0
      || sealed.attempts > CONTRIBUTION_MAX_RETRY_ATTEMPTS
      || !DISPATCH_STAGES.includes(sealed.dispatchStage)
      || !admittedAtValid || !nextAttemptAtValid
      || (sealed.dispatchStage === 'idle' && sealed.admittedAt !== null)
      || (sealed.dispatchStage !== 'idle' && sealed.admittedAt === null)
      || (sealed.attempts === 0
        && (sealed.admittedAt !== null || sealed.dispatchStage !== 'idle'))) {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
  try {
    const validated = validateContributionBatchBytes(sealed.bytes);
    const canonical = validateCanonicalBytes(validated.canonicalBytes);
    if (validated.bodyBytes > CONTRIBUTION_MAX_BODY_BYTES
        || validated.rowCount !== sealed.rowCount
        || validated.batchId !== sealed.batchId
        || canonical.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION
        || canonical.rows.length !== sealed.rowCount
        || JSON.stringify(canonical) !== validated.canonicalBytes) {
      throw new ContributionUploadStateError('contribution-upload-state-invalid');
    }
  } catch {
    throw new ContributionUploadStateError('contribution-upload-state-invalid');
  }
  return Object.freeze({
    version: CONTRIBUTION_UPLOAD_STATE_VERSION,
    sealed: Object.freeze(/** @type {SealedBatch} */ ({ ...sealed })),
  });
};

/** @param {number} attempt @param {number} jitterUnit */
export const contributionRetryDelayMs = (attempt, jitterUnit) => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ContributionUploadStateError('contribution-retry-attempt-invalid');
  }
  const unit = Number.isFinite(jitterUnit) ? Math.min(1, Math.max(0, jitterUnit)) : 0.5;
  const exponent = Math.min(attempt - 1, 30);
  const uncapped = CONTRIBUTION_RETRY_BASE_MS * (2 ** exponent);
  const base = Math.min(CONTRIBUTION_RETRY_MAX_MS, uncapped);
  return Math.min(CONTRIBUTION_RETRY_MAX_MS, Math.round(base * (0.75 + (unit * 0.5))));
};

/** @param {unknown} value @returns {value is { accepted: boolean, status: number }} */
const isExactSendResult = (value) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'accepted,status'
  && typeof /** @type {any} */ (value).accepted === 'boolean'
  && Number.isInteger(/** @type {any} */ (value).status)
  && /** @type {any} */ (value).status >= 0
  && /** @type {any} */ (value).status <= 599,
);

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, delete: (key: string) => Promise<void> }} deps.kv
 * @param {(bytes: string) => { schemaVersion: number, rows: readonly unknown[] }} deps.validateCanonicalBytes
 * @param {() => string} [deps.makeBatchId]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.jitter]
 * @param {(when: number) => Promise<unknown>} [deps.scheduleRetry]
 * @param {() => Promise<unknown>} [deps.cancelSchedule]
 */
export const makeContributionUploadLifecycle = ({
  kv, validateCanonicalBytes,
  makeBatchId = () => globalThis.crypto.randomUUID(),
  now = Date.now, jitter = Math.random,
  scheduleRetry = async () => {}, cancelSchedule = async () => {},
}) => {
  if (!kv || typeof validateCanonicalBytes !== 'function') {
    throw new TypeError('contribution lifecycle requires kv and validateCanonicalBytes');
  }
  let mutationTail = Promise.resolve();
  /** @type {Promise<SendOutcome>|null} */
  let sendInFlight = null;
  /** @type {AbortController|null} */
  let activeController = null;
  // Revocation advances before its first await. Every already-running
  // continuation compares its captured epoch before IO, settlement, or alarm
  // writes, so a slow promise can never resurrect state after disable.
  let revocationEpoch = 0;
  // The epoch invalidates work that was admitted BEFORE revoke. This latch is
  // the inverse-order wall: work first requested AFTER revoke starts must not
  // capture the new epoch and mistake it for authority. Re-enablement creates
  // a fresh lifecycle instance after consent is re-established.
  let disabled = false;

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  const mutate = (operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const readNow = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContributionUploadStateError('contribution-clock-invalid');
    }
    return value;
  };
  const load = async () => normalizeState(
    await kv.get(CONTRIBUTION_UPLOAD_STATE_KEY), validateCanonicalBytes, readNow(),
  );
  /** @param {SealedBatch} sealed @param {number} at */
  const isExpired = (sealed, at) => at - sealed.sealedAt >= CONTRIBUTION_SEALED_RETENTION_MS;
  const cancelAlarm = async () => {
    try { await cancelSchedule(); return true; }
    catch { return false; }
  };

  /** @param {string|null} [diagnostic] */
  const emptyStatus = (diagnostic = null) => Object.freeze({
    sealed: false, bytes: null, rowCount: 0, attempts: 0,
    nextAttemptAt: null, diagnostic,
  });
  /** @param {SealedBatch} sealed */
  const sealedStatus = (sealed) => Object.freeze({
    sealed: true, bytes: sealed.bytes, rowCount: sealed.rowCount,
    attempts: sealed.attempts, nextAttemptAt: sealed.nextAttemptAt,
    diagnostic: sealed.attempts >= CONTRIBUTION_MAX_RETRY_ATTEMPTS
      && sealed.dispatchStage !== 'admitted'
      ? 'contribution-retry-exhausted'
      : sealed.attempts > 0 && sealed.admittedAt === null && sealed.nextAttemptAt === null
        ? 'contribution-retry-unscheduled' : null,
  });

  const status = () => mutate(async () => {
    try {
      const state = await load();
      if (!state) return emptyStatus();
      if (isExpired(state.sealed, readNow())) {
        const cancelled = await cancelAlarm();
        await kv.delete(CONTRIBUTION_UPLOAD_STATE_KEY);
        return emptyStatus(cancelled
          ? 'contribution-sealed-batch-expired'
          : 'contribution-expired-alarm-cancel-failed');
      }
      return sealedStatus(state.sealed);
    } catch (error) {
      return emptyStatus(error instanceof ContributionUploadStateError
        ? error.code : 'contribution-upload-state-invalid');
    }
  });

  /** @param {string} canonicalBytes */
  const seal = (canonicalBytes) => {
    if (disabled) {
      return Promise.resolve(Object.freeze({ sealed: false, reason: 'contribution-revoked' }));
    }
    const epoch = revocationEpoch;
    return mutate(async () => {
      if (epoch !== revocationEpoch) {
        return Object.freeze({ sealed: false, reason: 'contribution-revoked' });
      }
      let existing = await load();
      const sealedAt = readNow();
      if (existing && isExpired(existing.sealed, sealedAt)) {
        await cancelAlarm();
        await kv.delete(CONTRIBUTION_UPLOAD_STATE_KEY);
        existing = null;
      }
      if (existing) return Object.freeze({ sealed: false, reason: 'contribution-backlog-full' });
      const envelope = validateCanonicalBytes(canonicalBytes);
      if (!envelope || envelope.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION
          || !Array.isArray(envelope.rows) || envelope.rows.length === 0
          || JSON.stringify(envelope) !== canonicalBytes) {
        throw new ContributionUploadStateError('contribution-canonical-envelope-invalid');
      }
      const batchId = makeBatchId();
      if (typeof batchId !== 'string' || !UUID_V4.test(batchId)) {
        throw new ContributionUploadStateError('contribution-batch-id-invalid');
      }
      const bytes = JSON.stringify({
        schemaVersion: CONTRIBUTION_SCHEMA_VERSION,
        batchId,
        rows: envelope.rows,
      });
      const validated = validateContributionBatchBytes(bytes);
      /** @type {SealedBatch} */
      const sealed = Object.freeze({
        batchId, bytes, rowCount: validated.rowCount, sealedAt,
        attempts: 0, admittedAt: null, dispatchStage: 'idle', nextAttemptAt: sealedAt,
      });
      if (epoch !== revocationEpoch) {
        return Object.freeze({ sealed: false, reason: 'contribution-revoked' });
      }
      await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
        version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
      });
      return Object.freeze({ sealed: true, bytes, rowCount: validated.rowCount });
    });
  };

  /**
   * @param {(input: { body: string, signal: AbortSignal }) => Promise<{ accepted: boolean, status: number }>} sendBatch
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<SendOutcome>}
   */
  const send = (sendBatch, { force = false } = {}) => {
    if (disabled) {
      return Promise.resolve(Object.freeze({
        sent: false, accepted: false, reason: 'contribution-revoked',
      }));
    }
    if (sendInFlight) return sendInFlight;
    const epoch = revocationEpoch;
    const operation = (async () => {
      /** @type {Admission} */
      const admission = await mutate(async () => {
        /** @returns {Admission} */
        const refused = (/** @type {string} */ reason) => ({
          ok: false, outcome: Object.freeze({ sent: false, accepted: false, reason }),
        });
        if (epoch !== revocationEpoch) return refused('contribution-revoked');
        const state = await load();
        if (!state) return refused('contribution-no-sealed-batch');
        const at = readNow();
        if (isExpired(state.sealed, at)) {
          await cancelAlarm();
          await kv.delete(CONTRIBUTION_UPLOAD_STATE_KEY);
          return refused('contribution-sealed-batch-expired');
        }
        if (force && !await cancelAlarm()) {
          return refused('contribution-alarm-cancel-failed');
        }
        if (epoch !== revocationEpoch) return refused('contribution-revoked');

        // `admitted` is the exact pre-fetch crash seam. Resume that SAME
        // attempt regardless of whether its safety alarm was already armed.
        // `dispatched` is never resumed as the same attempt: the durable wall
        // cannot know whether fetch reached the sink before eviction.
        if (state.sealed.dispatchStage === 'admitted') {
          return /** @type {Admission} */ ({ ok: true, sealed: state.sealed });
        }
        // Force means "send before due", never "ignore expiry/exhaustion".
        if (state.sealed.attempts >= CONTRIBUTION_MAX_RETRY_ATTEMPTS) {
          return refused('contribution-retry-exhausted');
        }
        if (!force && state.sealed.attempts > 0
            && state.sealed.admittedAt === null && state.sealed.nextAttemptAt === null) {
          return refused('contribution-retry-unscheduled');
        }
        if (!force && state.sealed.nextAttemptAt !== null && at < state.sealed.nextAttemptAt) {
          return refused('contribution-retry-not-due');
        }
        /** @type {SealedBatch} */
        const sealed = Object.freeze({
          ...state.sealed,
          attempts: state.sealed.attempts + 1,
          admittedAt: at,
          dispatchStage: 'admitted',
          nextAttemptAt: null,
        });
        // This commit PRECEDES alarm/network IO. Eviction after here preserves
        // the consumed admission and the exact bytes/token to resume.
        await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
          version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
        });
        return /** @type {Admission} */ ({ ok: true, sealed });
      });
      if (!admission.ok) return admission.outcome;
      let admitted = admission.sealed;
      if (epoch !== revocationEpoch) {
        return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
      }

      // Arm the safety retry before network IO. If scheduling fails, retain no
      // nextAttemptAt claim; manual recovery remains possible and bounded.
      if (admitted.attempts < CONTRIBUTION_MAX_RETRY_ATTEMPTS) {
        const retryAt = Math.max(
          readNow(),
          /** @type {number} */ (admitted.admittedAt)
            + contributionRetryDelayMs(admitted.attempts, jitter()),
        );
        try {
          if (epoch !== revocationEpoch) throw new ContributionUploadStateError('contribution-revoked');
          await scheduleRetry(retryAt);
          if (epoch !== revocationEpoch) {
            await cancelAlarm();
            return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
          }
          const armed = await mutate(async () => {
            if (epoch !== revocationEpoch) return null;
            const current = await load();
            if (!current || current.sealed.batchId !== admitted.batchId
                || current.sealed.bytes !== admitted.bytes
                || current.sealed.attempts !== admitted.attempts
                || current.sealed.admittedAt !== admitted.admittedAt
                || current.sealed.dispatchStage !== 'admitted') return null;
            if (epoch !== revocationEpoch) return null;
            /** @type {SealedBatch} */
            const sealed = Object.freeze({ ...current.sealed, nextAttemptAt: retryAt });
            await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
              version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
            });
            return sealed;
          });
          if (!armed) {
            await cancelAlarm();
            return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
          }
          admitted = armed;
        } catch (error) {
          await cancelAlarm();
          await mutate(async () => {
            if (epoch !== revocationEpoch) return;
            const current = await load();
            if (!current || current.sealed.batchId !== admitted.batchId
                || current.sealed.attempts !== admitted.attempts
                || current.sealed.dispatchStage !== 'admitted') return;
            if (epoch !== revocationEpoch) return;
            /** @type {SealedBatch} */
            const sealed = Object.freeze({
              ...current.sealed,
              admittedAt: null, dispatchStage: 'idle', nextAttemptAt: null,
            });
            await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
              version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
            });
          });
          const revoked = epoch !== revocationEpoch
            || (error instanceof ContributionUploadStateError
              && error.code === 'contribution-revoked');
          return Object.freeze({
            sent: false, accepted: false,
            reason: revoked ? 'contribution-revoked' : 'contribution-schedule-failed',
          });
        }
      }

      if (epoch !== revocationEpoch) {
        await cancelAlarm();
        return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
      }
      const dispatched = await mutate(async () => {
        if (epoch !== revocationEpoch) return null;
        const current = await load();
        if (!current || current.sealed.batchId !== admitted.batchId
            || current.sealed.bytes !== admitted.bytes
            || current.sealed.attempts !== admitted.attempts
            || current.sealed.admittedAt !== admitted.admittedAt
            || current.sealed.dispatchStage !== 'admitted') return null;
        /** @type {SealedBatch} */
        const sealed = Object.freeze({ ...current.sealed, dispatchStage: 'dispatched' });
        await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
          version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
        });
        return sealed;
      });
      if (!dispatched || epoch !== revocationEpoch) {
        await cancelAlarm();
        return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
      }
      admitted = dispatched;
      const controller = new AbortController();
      activeController = controller;
      let result;
      try {
        if (epoch !== revocationEpoch) {
          controller.abort(new DOMException('Contribution disabled', 'AbortError'));
          return Object.freeze({ sent: false, accepted: false, reason: 'contribution-revoked' });
        }
        result = await sendBatch({ body: admitted.bytes, signal: controller.signal });
      } catch {
        result = null;
      } finally {
        if (activeController === controller) activeController = null;
      }
      let validResult = false;
      let accepted = false;
      if (isExactSendResult(result)) {
        validResult = (result.accepted === true && result.status === 202)
          || (result.accepted === false && result.status >= 400);
        accepted = validResult && result.accepted === true;
      }
      return await mutate(async () => {
        if (epoch !== revocationEpoch) {
          return Object.freeze({ sent: true, accepted: false, reason: 'contribution-revoked' });
        }
        const current = await load();
        if (!current || current.sealed.batchId !== admitted.batchId
            || current.sealed.bytes !== admitted.bytes
            || current.sealed.attempts !== admitted.attempts
            || current.sealed.admittedAt !== admitted.admittedAt
            || current.sealed.dispatchStage !== 'dispatched') {
          return Object.freeze({ sent: true, accepted: false, reason: 'contribution-state-changed' });
        }
        if (epoch !== revocationEpoch) {
          return Object.freeze({ sent: true, accepted: false, reason: 'contribution-revoked' });
        }
        if (accepted) {
          const cancelled = await cancelAlarm();
          await kv.delete(CONTRIBUTION_UPLOAD_STATE_KEY);
          if (epoch !== revocationEpoch) {
            return Object.freeze({ sent: true, accepted: false, reason: 'contribution-revoked' });
          }
          return Object.freeze({
            sent: true, accepted: true, reason: null,
            ...(cancelled ? {} : { diagnostic: 'contribution-alarm-cancel-failed' }),
          });
        }
        /** @type {SealedBatch} */
        const sealed = Object.freeze({
          ...current.sealed, admittedAt: null, dispatchStage: 'idle',
        });
        await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, {
          version: CONTRIBUTION_UPLOAD_STATE_VERSION, sealed,
        });
        return Object.freeze({
          sent: true, accepted: false,
          reason: validResult ? 'contribution-rejected' : 'contribution-send-failed',
          nextAttemptAt: sealed.nextAttemptAt,
        });
      });
    })();
    sendInFlight = operation.finally(() => { sendInFlight = null; });
    return sendInFlight;
  };

  const revoke = async () => {
    disabled = true;
    revocationEpoch += 1;
    activeController?.abort(new DOMException('Contribution disabled', 'AbortError'));
    // Durable clear precedes the first awaited alarm operation. An MV3 worker
    // can be evicted while cancellation is pending; a replacement worker must
    // already observe no batch, making any stale alarm a harmless no-op.
    let clearFailed = false;
    try {
      await mutate(async () => { await kv.delete(CONTRIBUTION_UPLOAD_STATE_KEY); });
    } catch { clearFailed = true; }
    const cancelled = await cancelAlarm();
    // A failed delete means consent revocation is NOT durable. Reject instead
    // of returning an empty status that a caller could mistake for success;
    // after restart, the retained batch remains visible until clearing works.
    if (clearFailed) {
      throw new ContributionUploadStateError(cancelled
        ? 'contribution-revoke-clear-failed'
        : 'contribution-revoke-clear-and-alarm-cancel-failed');
    }
    return emptyStatus(cancelled ? null : 'contribution-schedule-cancel-failed');
  };

  return Object.freeze({ status, seal, send, revoke });
};
