// @ts-check
// Voice-subsystem errors. Each is a named subclass of TypedError so
// `.name` survives the side-panel ↔ SW ↔ offscreen messaging boundary.

import { TypedError } from '/shared/errors.js';

/**
 * Voice is not enabled — caller invoked listen/stop without the model
 * downloaded and the offscreen transcriber initialized.
 */
export class VoiceNotEnabledError extends TypedError {
  constructor() { super('Voice is not enabled. Enable it in settings first.'); }
}

/**
 * The vendored Moonshine library is missing. The runtime placeholder
 * throws this when any voice path actually tries to instantiate the
 * transcriber. Surfaces as a clear "run scripts/vendor-moonshine.sh"
 * error in the UI.
 */
export class VoiceUnsupportedError extends TypedError {
  constructor(msg = 'Voice is not supported in this build (moonshine-js not vendored).') {
    super(msg);
  }
}

/**
 * Browser refused mic access. User can grant it from the browser's
 * site permissions UI; we surface a clear actionable error.
 */
export class MicPermissionDeniedError extends TypedError {
  constructor() {
    super('Microphone permission was denied. Allow it from the browser site settings to enable voice.');
  }
}

/**
 * Model download HTTP failure. Carries the response status when
 * available so the UI can render a retryable error vs a permanent one.
 */
export class ModelDownloadError extends TypedError {
  /**
   * @param {string} message
   * @param {{ status?: number }} [opts]
   */
  constructor(message, { status } = {}) {
    super(message);
    this.status = status;
  }
}

/**
 * SRI hash mismatch — the downloaded bytes don't match the baked-in
 * expected SHA-384. We deliberately throw on this even after retry: a
 * mismatch means either the CDN is compromised or our pinned hash is
 * wrong; both are blocking. The bytes are NOT cached.
 */
export class SriMismatchError extends TypedError {
  /** @param {{ url: string, expected: string, actual: string }} parts */
  constructor({ url, expected, actual }) {
    super(`Model integrity check failed for ${url}: expected ${expected}, got ${actual}.`);
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}
