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
  /** @param {string} sessionId */
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

/** Profile id does not exist in the store (profiles/store.js). */
export class ProfileNotFoundError extends TypedError {
  /** @param {string} profileId */
  constructor(profileId) {
    super(`Profile not found: ${profileId}`);
    this.profileId = profileId;
  }
}

/**
 * The agent loop was started without a fully wired runtime context.
 * Better to fail loudly than to invoke `undefined()` later. The error
 * names the missing dependency to speed up SW-wiring debugging.
 */
export class RuntimeContextIncompleteError extends TypedError {
  /** @param {string} missing */
  constructor(missing) {
    super(`Runtime context is missing: ${missing}`);
    this.missing = missing;
  }
}
