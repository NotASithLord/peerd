// @ts-check
// peerd-runtime errors.
//
// Holds the session-store error plus the agent-loop wiring guard. The
// tool dispatcher deliberately does NOT throw typed errors: a blocked
// or failed call returns `{ ok: false, error: '<code>:<detail>' }`
// string-coded results ('unknown_tool: …', 'gate_blocked:<gate>:…',
// 'hook_blocked:pre-tool-use:…') so the model sees the failure as a
// tool_result instead of the turn aborting — see tools/dispatcher.js.

import { TypedError } from '/shared/errors.js';

/** Session id does not exist in the store. */
export class SessionNotFoundError extends TypedError {
  static errorName = 'SessionNotFoundError';

  /** @param {string} sessionId */
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

/**
 * The agent loop was started without a fully wired runtime context.
 * Better to fail loudly than to invoke `undefined()` later. The error
 * names the missing dependency to speed up SW-wiring debugging.
 */
export class RuntimeContextIncompleteError extends TypedError {
  static errorName = 'RuntimeContextIncompleteError';

  /** @param {string} missing */
  constructor(missing) {
    super(`Runtime context is missing: ${missing}`);
    this.missing = missing;
  }
}

/**
 * An actor loop tried to use a live provider capability directly instead of
 * crossing the service-worker-owned model boundary.
 */
export class ActorCredentialBoundaryError extends TypedError {
  static errorName = 'ActorCredentialBoundaryError';

  /** @param {'secret'|'provider-network'} capability */
  constructor(capability) {
    super(`Actor provider boundary refused direct ${capability} access`);
    this.capability = capability;
  }
}

export const ACTOR_CREDENTIAL_BOUNDARY_FAILURE = 'actor-provider-boundary-blocked: '
  + 'The actor model request was not run because its provider boundary blocked direct access. '
  + 'Do not retry automatically. Ask the user to reload peerd before another actor attempt.';

export const ACTOR_CREDENTIAL_BOUNDARY_USER_FAILURE = 'The actor model request was not run because '
  + 'its provider boundary blocked direct access. Reload peerd, then try again. '
  + '(actor-provider-boundary-blocked)';
