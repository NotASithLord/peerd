# Identity capsule

Status: implemented for manual backup and restore.

The identity remains a random Ed25519 seed stored under the local vault. For
portability, the seed and public key are encrypted with AES-GCM under a fresh
capsule key. A credential-derived AES-KW key wraps that capsule key.

This extra layer matters: credentials can be added or removed by rewrapping a
small random key without changing the root identity or re-encrypting its
contents.

The landed backup flow creates one Argon2id password wrapper. No passkey wrapper
or hosted-record locator ships before its product ceremony and relying-party
boundary are designed end to end.

The local runtime still loads the vault-protected seed directly. This change
does not claim that the root is non-extractable or that routine signing has
moved to a device key.

Security checks live with the implementation: record, wrapper, base64, and KDF
inputs are bounded; temporary key bytes are cleared where JavaScript permits;
and capsule authentication failures use typed errors.
