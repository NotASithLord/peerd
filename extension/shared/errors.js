// @ts-check
// Cross-module shared error infrastructure.
//
// Module-specific errors (EgressDeniedError, VaultLockedError,
// ProviderError, ToolBlockedError, ...) live INSIDE their owning module
// — they're imported via the module's public surface, not from here.
// See peerd-egress/fetch/errors.js, peerd-egress/vault/errors.js,
// peerd-provider/errors.js, peerd-runtime/errors.js.
//
// What lives here:
//   - TypedError: a base class that sets `.name` from an explicit stable
//     subclass tag so minification and structured clone cannot change it.

export class TypedError extends Error {
  static errorName = 'TypedError';

  /** @param {string} [message] */
  constructor(message) {
    super(message);
    if (!Object.hasOwn(new.target, 'errorName')) {
      throw new TypeError('TypedError subclasses require a stable errorName.');
    }
    this.name = new.target.errorName;
  }
}
