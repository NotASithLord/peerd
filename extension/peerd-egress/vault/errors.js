// @ts-check
// Vault-specific errors. Owned by peerd-egress.
//
// Module-local errors inherit from the shared TypedError base so
// `.name` survives structured-clone across the SW/port boundary.

import { TypedError } from '/shared/errors.js';

/**
 * No vault has been initialized yet — UI should show first-run flow.
 */
export class VaultNotInitializedError extends TypedError {
  constructor() { super('Vault has not been initialized.'); }
}

/**
 * A vault already exists and the caller asked to initialize a new one.
 * Initialization is a destructive operation, so we refuse rather than
 * silently overwrite.
 */
export class VaultAlreadyInitializedError extends TypedError {
  constructor() { super('Vault is already initialized.'); }
}

/**
 * The vault is locked — caller asked to read/write a secret without
 * unlocking first. UI should prompt for passphrase.
 */
export class VaultLockedError extends TypedError {
  constructor() { super('Vault is locked.'); }
}

/**
 * Unwrap failed — almost certainly a wrong passphrase. We deliberately
 * conflate "wrong passphrase" and "stored ciphertext corrupted" into
 * one error so the side-channel doesn't leak which it was.
 */
export class WrongPassphraseError extends TypedError {
  constructor() { super('Wrong passphrase.'); }
}

/**
 * The vault has no PRF enrollment — caller tried to unlock via Touch ID
 * but no platform authenticator has been bound to this vault. UI should
 * fall back to the passphrase prompt.
 */
export class PrfNotEnrolledError extends TypedError {
  constructor() { super('No platform authenticator is enrolled for this vault.'); }
}

/**
 * PRF unwrap failed — same shape as WrongPassphraseError but distinct so
 * the UI can give the user a coherent message ("Touch ID didn't unlock
 * — try your passphrase") instead of conflating it with a typo'd
 * passphrase. We still conflate "wrong PRF" and "tampered ciphertext"
 * into this single error to avoid a side-channel.
 */
export class PrfUnlockFailedError extends TypedError {
  constructor() { super('Touch ID unlock failed.'); }
}

/**
 * The blob's passphrase wrap carries a KDF descriptor this build can't
 * honor — either an unknown/out-of-bounds descriptor (tampered storage,
 * or a blob written by a newer peerd) or a valid Argon2id descriptor
 * with no Argon2 implementation wired. Distinct from
 * WrongPassphraseError because no passphrase can ever succeed here; the
 * UI should not invite retries.
 */
export class KdfUnavailableError extends TypedError {
  constructor() { super('This vault uses a key-derivation scheme this build cannot run.'); }
}

/**
 * Passphrase unlock was attempted on a passkey-only vault that has no
 * recovery passphrase set. Distinct from WrongPassphraseError so the UI
 * can say "no recovery passphrase has been set — unlock with your
 * passkey" instead of implying the user typed it wrong.
 */
export class RecoveryPassphraseNotSetError extends TypedError {
  constructor() { super('No recovery passphrase has been set for this vault.'); }
}
