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
- A targeted Chrome MessageChannel, an exact-sender Firefox backup Port,
  guarded transfer routes, and a static receiver check keep backup passwords
  off broadcast messaging.
- Structural exclusion of raw identity and device-key secrets from the generic
  encrypted-secrets section.

Since then, same-user device enrollment and P2P state sync landed, device
subkeys and certificates, passkey enrollment authority, private rotating
rendezvous, mutual self-device authentication, and direct device-to-device
state transfer. That arc has its own document: `06-device-enrollment.md`
(architecture, trust model, sequence diagrams, portability matrix, red-team
results, limitations). Documents 03–05 below record the design intent that
preceded it and are superseded where they conflict.

## What is not implemented

- QR transfer, hosted recovery records, or continuous background
  synchronization. State transfer is initial migration by snapshot.
- The routine-signing switchover. Device certificates exist and verify, but
  mesh envelopes, Agent Cards, manifests, DHT items, and A2A still sign with
  the permanent root; the wire verifier must accept certificate-backed
  identity across all of them first.
- A deployed `id.peerd.ai` or a website-facing identity capability protocol.
  The ceremony page is written (`web-identity/`); hosting belongs to the site
  repository.
- The rendered "Create new / Use my existing Peerd" fork on the vault gate.
  The flow, its branches, and its copy are implemented and tested; the render
  awaits the visual verify loop.
- A checked-in live Chrome-to-Firefox end-to-end proof. Both host paths have
  automated boundary coverage; a real two-browser ceremony remains release
  validation work, and Firefox additionally has no mesh host (issue #376).

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
