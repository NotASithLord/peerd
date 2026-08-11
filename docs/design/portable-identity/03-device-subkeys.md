# Device subkeys

Status: proposal; no device-key or certificate code is shipped by this change.

Portable roots increase the cost of using the permanent identity key for daily
traffic. A later design may let the person root certify short-lived,
per-install Ed25519 device keys while peers continue to key trust, blocks, and
rate limits by the person did.

That cannot land as isolated certificate helpers. The wire verifier must first
accept both root-signed and certificate-backed forms across handshakes, Agent
Cards, envelopes, manifests, and A2A. Only after that compatibility path is
tested can routine signing switch to a device key.

Until then, the root remains the routine signer and documentation must say so.
