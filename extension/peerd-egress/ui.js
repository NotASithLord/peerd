// @ts-check
// Cold-safe vault UI surface. No storage authority, secret access, credentialed
// fetch, audit store, or confirmation coordinator belongs in this page barrel.

export {
  enrollWithPrf, getPrfOutput, isWebAuthnAvailable,
  probeWebAuthnCapabilities, PrfCancelledError, PrfNotSupportedError,
  PrfUnsupportedByAuthenticatorError,
} from './vault/webauthn.js';
export { planEnrollment, platformAuthenticatorLabel } from './vault/enroll-options.js';
export { findDenylistMatch } from './denylist/denylist.js';
