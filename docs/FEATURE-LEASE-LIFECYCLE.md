# Post-vault feature leases

`feature-lease-coordinator.js` is the browser-neutral authority core.
`feature-lease-runtime.js` adapts that core to the production service worker,
and `offscreen/feature-lease-host.js` owns exact host receipts. The offscreen
entry has no generic keepalive: it opens a lease heartbeat Port only while at
least one controller, dweb, DOM, media, or model lease is active.

## Legacy effect mapping

| Lease scope | Existing post-vault effect | When desired | Revocation owner |
| --- | --- | --- | --- |
| `controller` | Semantic controller, actor channel, and repository host | exact semantic/repository/actor operation | vault lock, cancellation, or last operation release |
| `dweb` | Base mesh, discovery, seeding, rooms, and the dweb custody host | successful initialize/unlock/resume when dweb is enabled | vault lock or dweb master OFF |
| `goal` | `resumeGoalRuns()`; must precede current-chat recovery | successful initialize/unlock/resume | vault lock/Stop |
| `recovery` | `maybeAutoResumeAfterRecovery(currentSessionId)` behind passive mailbox recovery | after the goal lease settles | vault lock/Stop/session replacement |
| `schedule` | `resumeSchedules()` catch-up and due-routine drain | successful initialize/unlock/resume | vault lock or scheduler disable |
| `dom-host` | Offscreen DOM/document/PDF/web extraction and sealed-job services | first exact DOM/document operation, not merely vault unlock | vault lock or last DOM operation release |
| `media-host` | Offscreen voice/local-media services | while the explicitly enabled voice feature is initialized/listening | vault lock, voice OFF/teardown, or failed initialization |
| `model-host` | Local WebGPU model weights, initialization, and generation | bounded generation/probe work, or an explicit durable resident-model hold | vault lock, model OFF/teardown, host loss, or last bounded operation release |

The locked first-install screen creates no offscreen lease. After a successful
initialize, unlock, or resume, the runtime requests the enabled durable dweb
scope and preserves goal → recovery → schedule ordering explicitly. Store has
no dweb scope, so its post-initialize logical owners remain offscreen-cold.
Controller and DOM operations use shared reference-counted bounded
leases. A resident local model or enabled voice host may retain its named lease
for its actual feature lifetime; dweb alone is restored as a durable background
lease on every unlocked, enabled boot.

## Contract

Every lease is bound to one injected kernel identity
`{schema, buildId, bootId, kernelEpoch}` plus
`{scope, leaseId, generation, hostEpoch}`. A host receipt must echo the exact
identity and lease values. Duplicate requests for the
same scope and host epoch share one pending start; a live scope refuses a
different host until revocation. An invalid or lost post-dispatch receipt poisons
that host epoch, so a retry requires a fresh host generation.

Host adapters are two-phase. `prepare()` is required to be effect-free. The
coordinator checks cancellation after preparation, then crosses one explicit
boundary into `dispatch()`. Cancellation or failure before that boundary is
known-safe after the desired intent is removed. Any loss after it is outcome
unknown. Lock and feature disable synchronously invalidate the in-memory lease
generation before storage or host stop IO, so a late start result cannot restore
authority.

Storage contains only a schema, build ID, owner kernel epoch, scope, desired bit,
and fixed reason code. It never stores a passphrase, PRF output, provider secret,
attachment, operation payload, host epoch, or host receipt. On restart a new
kernel claims the document and resolves a fresh host epoch before reconciliation.
A different build discards stale intent and relies on authoritative settings and
vault state to mint new intent.

Bounded controller/DOM/model operations never write a desired intent. If a worker dies
mid-operation, a successor stops the unclaimed orphan instead of promoting a
one-shot call into a background lease. A durable feature may explicitly promote
an already-active bounded scope; that promotion is persisted before it can be
treated as restartable, and the reference-counted bounded caller cannot revoke it.

## Dweb continuity and teardown

Closing the side panel or an App tab does not release dweb. When Chrome retires
the service worker, the feature heartbeat Port disconnects. The offscreen host
marks controller and dweb leases orphaned but keeps their live processes; it
immediately stops bounded DOM/media/model work. A successor kernel reads the same host
epoch and atomically adopts controller/dweb under its new kernel epoch without a
second mesh start. Lock or dweb disable can also stop an unadopted orphan by its
exact retained token, then closes the offscreen document when no leases remain.

An offscreen renderer loss is a different boundary. The service worker accepts
the keepalive Port only after an exact lease heartbeat binds its build, kernel,
host epoch, lease ID, and generation. Disconnect then synchronously retires only
that host epoch, waits for the dead document to disappear, and recreates durable
scopes on one fresh host. The replacement dweb host announces its new epoch to
App tabs from the exact offscreen sender. Each App bridge rejoins with a stable
per-tab member token and restores its topic subscriptions/retention declarations;
duplicate and delayed old-generation announcements are inert. The ordinary base
start completion also replays the publication journal, authored App seeding, and
the optional inbound agent room after renderer-local caches are lost.

On resume, persisted settings hydrate before lease reconciliation. A stored
`dwebEnabled: false` disables and removes stale intent while the coordinator is
still locked, so a prior orphan is stopped without being adopted. Hydration
failure stays locked and tears orphaned custody down.

The dweb module itself is import-inert. Its custody Port and base network begin
only in `startDwebFeatureLease`; stop closes rooms/self-device coordination, the
base mesh, pending secret calls, reconnect timers, and the custody Port. A host
replacement has a new random host epoch, so delayed packets from the previous
renderer cannot affect it.

Firefox has no Chrome offscreen-document equivalent in the current release and
the Firefox build does not ship the dweb host. The browser-neutral logical lease
core is reusable there, but this document does not claim background Charon/dweb
continuity on Firefox until a separately user-authorized durable host exists.

## Packaged acceptance

The release oracle is `scripts/cdp/feature-lease-dweb-lifecycle.mjs`. Run it
against an isolated artifact root, never a shared staging directory:

```sh
PEERD_ACCEPTANCE_ARTIFACT_ROOT="$(mktemp -d)" \
  bun scripts/cdp/feature-lease-dweb-lifecycle.mjs
```

It accepts only the packaged Preview-Chrome tree with the production
`background/vault-kernel.js` entry. The report binds the archive, staged tree,
manifest, pinned browser, harness graph, lockfile, and packaging toolchain before
launch and requires identical archive/tree digests afterward. A passing run has
one offscreen document, one dweb lease, and mesh generation 1; closes the UI;
physically stops an exact Chrome service-worker version; observes an exact
`stopped` state and a fresh kernel; then proves the same host epoch, DID, mesh
generation, retained room history, discovery card, and byte-exact served App.
It then physically closes the offscreen renderer and requires a fresh host epoch
under the same kernel, one restarted mesh with the same DID, usable exact-token
room operations, re-seeded discovery, and byte-exact App installation. Dweb OFF
and vault lock must each return to zero offscreen contexts, with the lock also
confirmed through authoritative state. The bridge's automatic room/subscription
rejoin is covered separately by its deterministic transport test; the packaged
oracle exercises the same host-generation and exact room-token boundary without
depending on a consent modal.

`run-dweb-twopeer.mjs` remains useful transport coverage, but it serves raw
modules and cannot satisfy this installed-artifact lifecycle oracle. Store and
Firefox correctly prune dweb and likewise cannot substitute for Preview-Chrome.
