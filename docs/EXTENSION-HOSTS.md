# Extension host placement

Peerd treats the MV3 service worker as an authority kernel, not a general
application server. Chrome links every static worker import before listeners are
ready and does not support runtime module imports in a service worker, so a
feature placed there taxes every cold boot whether it is used or not.

Place new work in the narrowest host that owns its lifetime:

| Host | Put here | Keep out |
|---|---|---|
| Sandboxed App iframe | App rendering and App-defined semantic `observe`/`act` handlers | extension APIs, credentials, actor invocation |
| Trusted owning document | UI workflows and instance-local adapters such as `peerd.data` | provider secrets and authority decisions |
| Offscreen host | heavyweight or DOM/Worker-dependent background engines, loaded on first use | user-facing UI and unrestricted authority |
| Service worker | sender/instance checks, vault access, grants, leases, audit, browser lifecycle, and small privileged verbs | feature UI, semantic controllers, parsers, editors, and heavyweight engines |

An owning document or offscreen feature composes small service-worker verbs. It
does not duplicate their policy. The worker revalidates the sender, exact target,
current grant, cancellation state, and operation outcome at every privileged
boundary. Binary or cancellation-sensitive offscreen work should use a pinned
`MessageChannel`; extension-wide JSON messaging is not a substitute for custody.

## Current App and Git split

`peerd.data` is implemented in the trusted App parent. Reads use that tab's
exact OPFS root and writes reuse the existing repository-coordinated App file
verbs. There are no `app/data/*` controllers in the service worker.

Library owns Git-import input, progress, and open-after-import behavior. The
worker exposes one vault-gated repository bootstrap command because the current
repository engine also owns the shared mutation queue, storage write guard,
credentialed transport, and immutable snapshots there. Do not move one Git
operation into a second host and create two unsynchronized repository owners.
When Git moves out of the worker, move the repository engine as one unit behind
a pinned, binary-safe, abort-aware host channel.

## Ratchets

The cold-graph test follows every static import from `vault-kernel.js`, caps
both module count and authored bytes, and rejects known UI/heavy modules. Adding
a feature does not justify raising that budget. First move its controller to an
owning document or offscreen host and leave only the smallest reusable authority
verb in the worker.
