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
//   - TypedError: a base class that sets `.name` from the subclass
//     constructor so error.name survives structured clone across the
//     SW/port boundary (instanceof does not).

export class TypedError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
