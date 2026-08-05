// @ts-check
// Confirmation binding — one approval, one action, once.
//
// A user confirmation is a narrow, single-use proof: it authorizes exactly
// one named action against one normalized target for one operation under
// one capability generation, inside a bounded time window. Anything else —
// a retry that recreated the operation, a SW restart that changed the
// generation, a redirect that changed the target — must re-ask. The user
// must never approve one operation and have that approval silently
// consumed by another (contract §8.3).
//
// Pure: clock injected, no IO.

// Default approval window. why 5 minutes: long enough for the user to read
// a confirm card and act, short enough that a forgotten prompt can't be
// harvested by a much later retry.
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * Normalize a confirmation target so cosmetic URL differences don't defeat
 * (or fake) a match: lowercase scheme+host, drop default ports and the
 * fragment, keep path + query verbatim (they select the resource). A
 * non-URL target (a vault key name, an actor handle) normalizes to its
 * trimmed self.
 *
 * @param {unknown} target @returns {string}
 */
export const normalizeConfirmationTarget = (target) => {
  const raw = typeof target === 'string' ? target.trim() : '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    // URL already lowercases scheme/host and strips default ports.
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
};

/**
 * @typedef {Object} ConfirmationProof
 * @property {string} operationId
 * @property {string} action        the tool/action name approved
 * @property {string} target        normalized (normalizeConfirmationTarget)
 * @property {string} generationId  capability generation at approval time
 * @property {number} grantedAt     epoch ms
 * @property {number} expiresAt     epoch ms
 * @property {boolean} consumed     single-use latch
 */

/**
 * Bind a fresh confirmation proof. The shell records this the moment the
 * user approves, BEFORE dispatch (§8.1).
 *
 * @param {{ operationId: string, action: string, target: unknown,
 *   generationId: string, now: number, ttlMs?: number }} input
 * @returns {ConfirmationProof}
 */
export const bindConfirmation = ({ operationId, action, target, generationId, now, ttlMs }) => {
  if (!operationId || !action || !generationId) {
    throw new TypeError('bindConfirmation: operationId, action and generationId are required');
  }
  // A target that does not normalize to a non-empty string must REFUSE, not
  // bind: a proof with target '' would match any other empty-normalizing
  // request — a wildcard approval, the exact opposite of "bound to one
  // normalized target". (A URL object passed where a string was meant is an
  // ordinary call-site mistake; it must fail loudly here, not silently
  // widen the approval.)
  const normalizedTarget = normalizeConfirmationTarget(target);
  if (!normalizedTarget) {
    throw new TypeError('bindConfirmation: target must normalize to a non-empty string');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('bindConfirmation: now must be a finite epoch-ms number');
  }
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : CONFIRMATION_TTL_MS;
  return {
    operationId,
    action,
    target: normalizedTarget,
    generationId,
    grantedAt: now,
    expiresAt: now + ttl,
    consumed: false,
  };
};

/**
 * Does this proof authorize this dispatch? Every binding must match and
 * the window must be open and the proof unconsumed — one mismatch, one
 * refusal, with the first failing binding named so the UI can say WHY the
 * user is being asked again.
 *
 * @param {ConfirmationProof | null | undefined} proof
 * @param {{ operationId: string, action: string, target: unknown,
 *   generationId: string, now: number }} request
 * @returns {{ valid: boolean, reason: string }}
 */
export const confirmationSatisfies = (proof, request) => {
  if (!proof) return { valid: false, reason: 'no confirmation on record' };
  if (proof.consumed) {
    return { valid: false, reason: 'confirmation already consumed; one approval covers one dispatch' };
  }
  if (proof.operationId !== request.operationId) {
    return { valid: false, reason: 'confirmation bound to a different operation' };
  }
  if (proof.action !== request.action) {
    return { valid: false, reason: 'confirmation bound to a different action' };
  }
  // Empty targets refuse on BOTH sides: a legacy/crafted proof with target
  // '' must never act as a wildcard, and a request whose target normalizes
  // to '' has nothing to match against.
  const requestTarget = normalizeConfirmationTarget(request.target);
  if (typeof proof.target !== 'string' || !proof.target || !requestTarget) {
    return { valid: false, reason: 'confirmation target missing or unnormalizable; re-confirm required' };
  }
  if (proof.target !== requestTarget) {
    return { valid: false, reason: 'confirmation bound to a different target' };
  }
  if (proof.generationId !== request.generationId) {
    return {
      valid: false,
      reason: 'capability generation changed since approval; re-confirm required',
    };
  }
  // The window fails CLOSED on a malformed deadline: a proof whose
  // expiresAt is missing or non-numeric (legacy schema, crafted storage)
  // would otherwise pass every NaN comparison and become an eternal
  // standing approval.
  if (typeof proof.expiresAt !== 'number' || !Number.isFinite(proof.expiresAt)) {
    return { valid: false, reason: 'confirmation window malformed; re-confirm required' };
  }
  if (request.now >= proof.expiresAt) {
    return { valid: false, reason: 'confirmation window expired' };
  }
  return { valid: true, reason: 'confirmation matches action, target, operation, generation and window' };
};

/**
 * Consume a proof at dispatch. Returns a new consumed copy — the caller
 * persists it BEFORE dispatching, so an eviction between persist and
 * dispatch errs toward re-asking, never toward double-spending one
 * approval.
 *
 * @param {ConfirmationProof} proof
 * @returns {ConfirmationProof}
 */
export const consumeConfirmation = (proof) => ({ ...proof, consumed: true });
