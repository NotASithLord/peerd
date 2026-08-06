# Portable identity

The implemented feature is deliberately small: a preview user can include the
existing `did:key` identity in a password-protected peerd backup and restore it
on another preview install. The random Ed25519 seed stays the identity root; it
is encrypted in a capsule rather than derived from a password or passkey.

The code is the specification:

- Capsule and credential wrappers: `extension/peerd-distributed/identity/`
- Chrome/Firefox crypto hosting and vault custody: `extension/background/dweb-transfer.js`
- Backup shaping and import staging: `extension/peerd-runtime/transfer/transfer.js`
- User flow: `extension/options/sections/transfer.js`

## What is implemented

- AES-GCM capsule encryption under a random key.
- One fixed Argon2id policy for new credential boxes and identity wrappers,
  with legacy PBKDF2 credential boxes accepted only on import.
- A bounded, versioned recovery record that binds the decrypted seed and public
  key to its advertised did.
- Manual backup/restore in preview builds. Chrome runs record crypto in the
  offscreen host; Firefox runs the same dweb client in its background context.
- Fail-loud export, targeted custody RPC, authenticated same-did import,
  serialized custody reads and changes, and a two-step keep/replace decision
  when the local did differs or its stored material is unreadable.
- An exact-options backup Port, guarded transfer routes, and a static
  single-receiver check keep backup passwords off broadcast messaging.
- Structural exclusion of raw identity and device-key secrets from the generic
  encrypted-secrets section.

## What is not implemented

- Passkey wrappers, enrollment, or recovery ceremonies.
- Device subkeys. The permanent root remains the routine mesh signer.
- QR transfer, hosted recovery records, or automatic synchronization.
- A canonical `peerd.ai` relying party or a website-facing identity protocol.
- A checked-in live Chrome-to-Firefox end-to-end proof. Both host paths have
  automated boundary coverage; a real two-browser ceremony remains release
  validation work.

## Invariants

1. The did is derived from the recovered public key and must match the record.
2. The recovered seed must sign a proof verifiable by the supplied public key.
3. The raw custody secret never travels through the generic secrets map.
4. A wrong password, malformed record, or identity conflict found during
   preflight causes no ordinary writes. A final identity-commit failure reports
   the exact ordinary sections already restored and never claims atomicity.
5. Replacing a different local identity requires a separate explicit action.
6. Replacement is refused while local shared apps remain identity-bound.
7. Store packages stay dweb-free.

The remaining documents separate the landed mechanisms from later proposals.
