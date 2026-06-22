// @ts-check
// Egress-fetch errors.
//
// EgressDeniedError lives here (not in /shared/) because it's owned by
// the egress module. Other modules that catch it match on `.name`, not
// on `instanceof` — the structured-clone roundtrip across the SW/port
// boundary drops the prototype chain.

import { TypedError } from '/shared/errors.js';

/**
 * Thrown by `safeFetch` when the request target is not on the egress
 * allowlist. The audit-log entry has already been recorded by the time
 * this is thrown — callers should surface the error without re-logging.
 */
export class EgressDeniedError extends TypedError {
  /**
   * @param {string} origin
   * @param {string} [reason]  machine code, e.g. 'redirect_blocked', so a
   *   caller can give the model an actionable message. Survives the
   *   structured-clone roundtrip (own enumerable field).
   */
  constructor(origin, reason) {
    super(`Egress denied: ${origin}${reason ? ` (${reason})` : ' is not on the provider allowlist.'}`);
    this.origin = origin;
    this.reason = reason ?? null;
  }
}
