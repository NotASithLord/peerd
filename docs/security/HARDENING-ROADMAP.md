# Security hardening index

This file is an index, not a status page. Open work, priority, and ownership
live in GitHub issues. The threat model and code define the current boundary.

## Release gates

- `packaging/preflight.ts` defines the local release checks.
- `.github/workflows/security.yml` runs dependency and code security checks.
- `packaging/check-invariants.ts` pins privileged surfaces that must not grow
  without review.
- `packaging/check-vendor.ts` verifies vendored runtime bytes.
- `tests/red-team/` exercises named security invariants with hostile inputs.
- `docs/security/THREAT-MODEL.md` records trust boundaries and residual risk.

## Hardening areas

### Actor isolation and relay authority

Keep untrusted actor reasoning outside privileged service-worker heaps. Bind
relay authority to a live run and its sender. Firefox and interruption paths
must fail closed when the required isolation host is unavailable.

Current source: `extension/peerd-runtime/actor/`,
`extension/background/offscreen-actor-client.js`, and
`extension/offscreen/`.

### Browser authority

Bind each browser actor to the origin and tab it was authorized to use. Recheck
the live destination, liveness, deadline, and policy after waits or redirects.
Treat credential detection and authenticated writes as security decisions, not
prompt guidance.

Current source: `extension/peerd-runtime/actor/`, browser tool gates, and
service-worker routes.

### Credential custody

Prefer browser-held sessions and non-extractable proof-of-possession keys over
bearer secrets. Bind any stored credential to one HTTPS origin and inject it
only at the egress boundary.

Current source: `extension/peerd-egress/`, vault routes, DPoP, and origin
credential handling.

### Sandbox and remote code boundaries

Keep Notebook, App, WebVM, and headless execution isolated from extension
storage, browser authority, and ambient network access. Verify remote runtime
assets and vendored code before use.

Current source: `extension/peerd-engine/`, `extension/engine-tabs/`,
`extension/offscreen/`, and `extension/vendor/`.

### Durable operations and recovery

Record enough state to recover safely after service-worker or execution-host
loss. Retry only idempotent work. Surface uncertain writes instead of silently
repeating them.

Current source: `extension/peerd-runtime/lifecycle/` and background operation
registries.

### Dweb isolation

Treat all peers, cards, bundles, apps, and inbound agent messages as untrusted.
Separate peer conversations mechanically and require explicit sharing and
signing authority. Prompt text is not a data-access control.

Current source: `extension/peerd-distributed/`, the dweb actor routes, and
sealed job runners.

## Update rule

Do not copy test counts, tool counts, tunable limits, release matrices, or issue
status into this file. Link to the source or issue that owns the live value.
