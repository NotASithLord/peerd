# Canonical relying party

Status: RP decided and frozen; ceremony page + handoff protocol landed
in-repo; production deployment and the extension UI flow are the
remaining work.

The extension-origin vault passkey cannot be a portable website credential:
WebAuthn binds it to the extension origin, and an extension cannot claim
`peerd.ai` as its relying-party ID.

## Decided (owner, 2026-08 - the pre-1.0 orphaning surface)

Everything a portable passkey binds to permanently is now fixed and
locked by CI:

- **RP ID: `peerd.ai`** - the anchor every identity passkey is minted
  against. Changing it after the first production mint orphans every
  credential. The ceremony origin (`IDENTITY_RP_ORIGIN`, working value
  `https://id.peerd.ai`) may still move between `peerd.ai` subdomains
  until that first mint; the RP ID may not.
- **The PRF input and KEK derivation** - constants in
  `identity/handoff.js` + `identity/credential-wrapper.js`, frozen by
  known-answer vectors (`tests/peerd-distributed/identity-prf-vectors.test.ts`).
  A failing vector means the change orphans credentials: revert the
  derivation, never update the vector.

## Architecture (narrower than this doc's original sketch)

The ceremony page (`web-identity/`) is a **pure PRF oracle**. It parses
the extension's request off a URL fragment, takes one explicit user
gesture, runs the WebAuthn ceremony with the frozen PRF input, and
returns the 32-byte PRF output sealed to the request's ephemeral ECDH
key - via a fragment redirect the extension watches on the tab. It
never sees a seed, capsule, recovery record, or capsule key; all
capsule crypto stays in the extension (`credential-wrapper.js`). So the
page compromise blast radius is one credential's PRF output as
ciphertext bound to one live request - not the identity root, and not a
passphrase oracle.

why fragments + AEAD instead of postMessage: fragments never reach a
server, the ciphertext left in tab history is useless without the
extension-held ephemeral key, and nothing depends on cross-scheme
postMessage targetOrigin semantics (identical on Chrome and Firefox).

The protocol is single-sourced in `identity/handoff.js` (deliberately
import-free); the page runs a byte-identical copy and CI fails on
drift.

## Remaining before this is usable end to end

1. Deploy `web-identity/` at the canonical origin (site repo vendors
   the directory; hosting requirements in `web-identity/README.md`).
2. The extension flow: backup/restore UI grows "protect with a passkey"
   (register) and "unlock with passkey" (get) - open the ceremony tab,
   watch for the return fragment, open the sealed response, then
   wrap/unwrap CapK locally. The module surface for this is exported
   from the dweb index (`createHandoffRequest` … `openHandoffResponse`).
3. Live cross-browser ceremony tests against the deployed origin, and a
   first REAL mint - after which the origin, too, is effectively frozen.

Hosted recovery-record storage remains out of scope (README decision
D-B): the record still travels only in the explicit backup file.
