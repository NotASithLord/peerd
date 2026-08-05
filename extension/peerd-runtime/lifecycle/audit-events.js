// @ts-check
// Lifecycle audit vocabulary + the sanitizer for lifecycle entries.
//
// The audit log records lifecycle events with enough correlation to
// reconstruct session → actor → operation → attempt → result, and NOTHING
// sensitive: no secrets, DPoP proofs, raw headers, cookies, request
// bodies, or untrusted page content (contract §13). The sanitizer here is
// the single chokepoint every lifecycle entry passes through before the
// egress audit appender sees it.
//
// Pure shaping; the shell appends via peerd-egress's audit chain.

export const LIFECYCLE_EVENTS = Object.freeze({
  OPERATION_STARTED: /** @type {const} */ ('lifecycle.operation.started'),
  OPERATION_COMPLETED: /** @type {const} */ ('lifecycle.operation.completed'),
  OPERATION_INTERRUPTED: /** @type {const} */ ('lifecycle.operation.interrupted'),
  OUTCOME_UNKNOWN: /** @type {const} */ ('lifecycle.operation.outcome_unknown'),
  RETRY_ATTEMPTED: /** @type {const} */ ('lifecycle.retry.attempted'),
  RETRY_REFUSED: /** @type {const} */ ('lifecycle.retry.refused'),
  SW_GENERATION_CHANGED: /** @type {const} */ ('lifecycle.generation.sw-changed'),
  ACTOR_GENERATION_CHANGED: /** @type {const} */ ('lifecycle.generation.actor-changed'),
  STALE_GRANT_REFUSED: /** @type {const} */ ('lifecycle.grant.stale-refused'),
  STALE_CONFIRMATION_REFUSED: /** @type {const} */ ('lifecycle.confirmation.stale-refused'),
  VAULT_RESUME_ACCEPTED: /** @type {const} */ ('lifecycle.vault.resume-accepted'),
  VAULT_RESUME_REFUSED: /** @type {const} */ ('lifecycle.vault.resume-refused'),
  MIGRATION_STARTED: /** @type {const} */ ('lifecycle.migration.started'),
  MIGRATION_COMPLETED: /** @type {const} */ ('lifecycle.migration.completed'),
  MIGRATION_FAILED: /** @type {const} */ ('lifecycle.migration.failed'),
  ORPHAN_REAPED: /** @type {const} */ ('lifecycle.engine.orphan-reaped'),
});

// Keys that must never appear in a lifecycle audit entry's detail, at any
// depth. Substring match on the lowercased key — 'authorization',
// 'x-api-key', 'setCookie' and friends all trip it.
const FORBIDDEN_KEY_FRAGMENTS = Object.freeze([
  'secret', 'token', 'password', 'passphrase', 'credential', 'apikey',
  'api_key', 'authorization', 'cookie', 'dpop', 'proof', 'header', 'body',
  'pagecontent', 'page_content',
]);

/** @param {string} key */
const keyForbidden = (key) => {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

const MAX_DETAIL_DEPTH = 4;
const MAX_STRING_CHARS = 512;

/**
 * Deep-scrub a detail object: forbidden keys dropped, strings truncated
 * (audit is correlation, not content), depth bounded so an adversarial
 * record can't smuggle bulk. Arrays and plain objects only; anything
 * exotic serializes to its type name.
 *
 * @param {unknown} value @param {number} [depth]
 * @returns {unknown}
 */
export const sanitizeDetail = (value, depth = 0) => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  }
  if (depth >= MAX_DETAIL_DEPTH) return '[depth-capped]';
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => sanitizeDetail(v, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */ const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (keyForbidden(key)) continue;
      out[key] = sanitizeDetail(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
};

/**
 * Shape one lifecycle audit entry. Correlation fields are first-class so
 * the chain session → actor → operation → attempt → result reconstructs
 * from entries alone; everything else rides in sanitized `detail`.
 *
 * @param {{ event: string, sessionId?: string, actorId?: string,
 *   operationId?: string, attempt?: number, result?: string,
 *   generationId?: string, detail?: unknown }} input
 */
export const lifecycleAuditEntry = ({
  event, sessionId, actorId, operationId, attempt, result, generationId, detail,
}) => {
  if (!Object.values(LIFECYCLE_EVENTS).includes(/** @type {any} */ (event))) {
    throw new TypeError(`lifecycleAuditEntry: unknown lifecycle event ${String(event)}`);
  }
  return {
    event,
    ...(sessionId ? { sessionId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(typeof attempt === 'number' ? { attempt } : {}),
    ...(result ? { result } : {}),
    ...(generationId ? { generationId } : {}),
    ...(detail !== undefined ? { detail: sanitizeDetail(detail) } : {}),
  };
};
