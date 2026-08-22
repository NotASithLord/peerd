# Vault authority kernel cutover ledger

Status: test-only vertical slice. The live Chrome and Firefox manifests still
load `background/service-worker.js`. `scripts/cdp/vault-kernel-artifact.mjs`
creates separately named local floor artifacts and cannot enter the release
artifact matrix.

## Proven vault boundary

`vault-kernel-core.js` selects the legacy `makeVaultRoutes` handlers instead of
copying route bodies. Differential tests execute the legacy and kernel lanes
against independent real vaults and compare results, status and audit records
for passphrase and passkey first install, unlock, resume, manual and idle lock,
recovery enrollment, PRF enroll/disable, and failed-enrollment purge. Storage
posture settles before settings, session-key resume or any route; a blocked or
incompatible store therefore cannot be mutated through the kernel.

The kernel owns only these human-provenance routes:

- `vault/initialize`, `vault/initializeWithPasskey`
- `vault/unlock`, `vault/unlockPrf`, `vault/lock`
- `vault/prfStatus`, `vault/enrollPrf`, `vault/disablePrf`
- `vault/setRecoveryPassphrase`

It also answers first-party `bootstrap/ready` and the deliberately minimal
`state/get`, and accepts exact side-panel and Home state ports. The VaultGate
projection is compared field-for-field with the locked legacy state. It exposes
no credential ID, PRF output/salt, wrapped key, provider key or other ceremony
material. An unlocked vault remains non-actionable until a semantic controller
has committed; this slice does not pretend to be the rich application state.

The browser shell now resolves the native promise-returning WebExtension API
through `shared/browser-api.js`. Persistent and session storage use the same
injected `StorageArea` adapters in Chrome's service worker and Firefox's module
event page, preserving the exact object-envelope and session-mirror semantics.

Vault cryptography and Argon2id are no longer static kernel dependencies. A
fixed sealed vault-authority Worker is demand-loaded over one transferred
private channel: Chrome uses the tiny offscreen supervisor and Firefox creates
the Worker directly. The Worker owns the vault data key and plaintext secret
cache only while unlocked; the kernel owns exact storage calls, posture, audit,
sender provenance, and lease lifecycle. Argon2 is a fixed second-level import,
so passkey-only users never compile the vendored implementation.

The latest native Chrome source graph is 73 modules / 445,542 authored bytes
and excludes the vault implementation, keys, Argon2 adapter, and vendored
Argon2 source. Its release transform is one 183,385-byte Store Chrome module;
Preview Chrome is one 191,281-byte module. The Chrome passphrase lane observed zero offscreen contexts
before demand, exactly one authority host while unlocked, zero after lock, then
one fresh host after unlock. Initialize completed in 581.5 ms and the
post-lock unlock in 408.9 ms on pinned Chrome 151.0.7922.47. A packaged passkey
sample reached its actionable CTA 6,304.3 ms after browser launch and durable
initialized/unlocked/PRF state at 6,998.2 ms. These are vertical-slice samples,
not yet a full-product p95 claim.

The only non-vault route is exact-human `settings/update`, restricted to a
single-key `{ vaultAutoLockMs }` patch. It calls the leaf normalizer also used by
the legacy settings route, preserves every stored semantic setting, persists
before changing the live timer, and rejects semantic or mixed patches. It never
returns provider or controller settings.

Every test-kernel realm now claims a browser-neutral generation record in
`storage.session`. Its immutable identity is `{ schema, build, bootId,
kernelEpoch }`, where `build` binds the packaged extension version to the
stamped controller content digest. `bootstrap/ready`, `state/get`, the state
projection itself, and state-port envelopes carry that exact identity. The
generation seam also fences future controller grants and settlements: a bad
schema/build/boot/epoch cannot consume a pending grant, duplicate settlements
are rejected, and a successor claim invalidates rather than adopts the prior
realm's pending grants. The session record persists only identity metadata and
a count; grant IDs, bearer authority and controller payloads stay in memory.

## Still missing before live cutover

The following are explicit blockers, not optional optimizations:

| Missing cold owner | Legacy responsibility that would otherwise be lost | Required cutover work |
| --- | --- | --- |
| Rich `state/get` and UI projection | sessions/messages, provider/model readiness, composer reason, actor/goal/task state, pending confirmations, streaming and runtime capabilities | Join a versioned controller snapshot to the kernel-owned vault projection; preserve locked and unavailable states during host loss. |
| Unlock/initialize effects | `ensureOffscreen`, base-network start, goal/chat recovery and due-schedule resume | Rehome each effect behind an authenticated feature lease and prove idempotence/recovery. The test kernel intentionally replaces them with no-ops. |
| Remaining settings authority | provider, model, voice, tools, dweb, update and other semantic policy | Keep these behind the semantic controller/full settings host. The kernel owns only provenance-bound `vaultAutoLockMs`; mixed patches fail closed. |
| Resume lifecycle effects | legacy boot audit/push and post-resume network, goal, chat and schedule recovery | Define a durable resume transition with exactly-once/at-least-once semantics and differential audit coverage. |
| Full runtime message dispatcher | provider, session, actor, tool, repository, dweb, local-model, transfer, feedback and confirmation routes | Route privileged verbs in the kernel and keyless semantics over the sealed controller protocol. Unknown or unavailable hosts must fail closed. |
| Full port dispatcher | `private-transfer`, `eval`, `sw-keepalive`, `dweb-custody`, plus rich sidepanel/Home streams | Preserve exact sender/port provenance, disconnect behavior and bounded startup holding. Secret-bearing ports cannot queue or replay. |
| Browser wake listeners | startup, alarms, tab/window/navigation events, and Firefox blocking request guard | Preview Chrome update custody, install, action/commands, focus, and Firefox session-lifetime ownership are native. Complete the remaining inventory synchronously and prove replay/coalescing rules before switching the manifest. |
| Custody and egress authority | Stop/lock, confirmations, write guard, browser verbs, redirect-safe fetch, credential injection, DPoP/device keys and audit | Keep these in the authority kernel; do not delegate raw keys or broad browser APIs to the controller. |
| Live generation cutover | reject stale rich-controller replies and pending grants in the production dispatcher | The test kernel provides schema/build/boot/epoch fencing and successor reconciliation. The native floor now proves three exact Chrome `ServiceWorker.stopWorker` transitions with six unique identities, but the incomplete live dispatcher/Port/route ledger still blocks the manifest flip. Thread identity through every remaining privileged channel before switching it. |
| Dweb continuity | discovery, inbound actor work, lobby/seeding and leases with panels closed | Add explicit bounded leases or persisted rejoin/reseed recovery; ordinary feature-Worker lifetime is not durable. |

The complete listener/message/port inventory is executable in
`extension/background/cold-kernel-inventory.js`; this ledger names the semantic
work needed to make those listener stubs production-safe.

## Browser evidence boundary

The Chrome floor is a packaged, installed extension with a virtual PRF
authenticator. It measures host-monotonic shell, actionable CTA, click,
authenticator return and durable initialized/unlocked/PRF state. It does not
wait for rich-app readiness and does not use target closure as a worker recycle
oracle.

Firefox shares the pure route, state, storage-posture, native browser adapter,
local/session storage and provenance tests, and the test-only XPI is checked
with AMO's `web-ext lint`. `scripts/firefox/vault-kernel-physical.mjs` builds in
a throwaway temp tree and passes the installed route/state/passphrase floor on
Firefox 153.0.3 with geckodriver 0.37.1: initial state, mixed semantic-policy
refusal, normalized auto-lock persistence, initialize, manual lock and unlock.
The extended installed sample closes its only extension UI for 45 seconds and
requires the wake to have a different `bootId` and `kernelEpoch` while resuming
the same initialized/unlocked vault through the bounded session mirror. The
current pinned installed-addon run passed that discard condition after the
vault authority split: the successor had a fresh `bootId` and `kernelEpoch`, while the
initialized/unlocked vault and bounded session mirror remained correct.
Deterministic Chrome/Firefox adapter tests also cover successor claims, stale
replies and pending-grant invalidation.
No Firefox PRF claim is made until a pinned browser driver can automate and
verify the real ceremony.
