# Website identity capabilities

Status: proposal.

A website-facing identity API must issue narrow, origin-bound capabilities; it
must never return seeds, capsule keys, PRF outputs, the vault key, or an
unsupervised signing oracle.

Any future protocol needs transport-derived origins, explicit user consent,
short expiry, revocation, and signature-domain separation so site-requested
bytes cannot verify as peerd envelopes, certificates, or manifests. Its first
useful subset would be identity disclosure and namespaced message signing.

This depends on the canonical relying party and a real person/device key split.
It is intentionally not scaffolded by the manual backup change.
