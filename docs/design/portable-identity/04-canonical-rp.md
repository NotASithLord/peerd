# Canonical relying party

Status: proposal; blocked on an owner decision and work in the separate site
repository.

The extension-origin vault passkey cannot be a portable website credential:
WebAuthn binds it to the extension origin, and an extension cannot claim
`peerd.ai` as its relying-party ID.

A future portable passkey therefore needs a stable HTTPS relying party, such as
`id.peerd.ai`, with a small auditable ceremony page. Choosing that RP is
effectively permanent because changing it orphans credentials. Hosting,
deployment integrity, recovery-record storage, challenge binding, and the
extension-to-page transport all require their own threat model and live tests.

None of that surface is part of the manual backup implementation.
