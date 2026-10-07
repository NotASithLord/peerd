# Bun bootstrap admission

`bun bun-server.mjs` starts the same signaling reducer as the Worker, with
additional **process-local Bun quotas**. This does not configure Cloudflare,
provide Worker hibernation parity, or activate the sparse browser profile.

The Bun API requires nonempty, bounded UTF-8 room keys without C0/DEL
characters. Keys are not normalized. Ordinary public and private room keys
and legacy signaling messages remain compatible. The authoritative key
restriction and injectable room/process limits live in
[admission-budget.js](admission-budget.js); individual socket limits and
native buffering policy live in [bun-server.mjs](bun-server.mjs).

Room accounting entries and live socket reservations are bounded. Inactive
entries retain spent credit until window expiry; disconnecting or changing
keys cannot mint fresh process credit. Room-map refusals consume process
join credit. These are fixed-window budgets, so adjacent windows can each
admit a burst.

Ingress byte/message admission precedes JSON parsing and message reduction.
The reducer does not perform signaling cryptography. Whole outbound batches
reserve credit before reducer state commits or any recipient receives a
frame. Control traffic has reserved allowance within the outbound budget;
failed writes never refund credit. Native per-socket buffering is separately
bounded. Departures always remove membership even when no outbound notice
credit remains. Cleanup runs iteratively and releases socket custody despite
failed writes or notice accounting.

Aggregate overload rejects an upgrade with HTTP 503 and `Retry-After`, or
retires an existing socket with WebSocket 1013. Existing individual rate/size
failures retain their prior semantics. Overload is not evidence of a malicious
DID and creates no peer ban. These limits do not provide per-person fairness,
Sybil resistance, cross-process/account quotas, or HTTP front-door/WAF limits.
Deployment ownership and account-wide admission remain separate work.

The [real Bun budget regression](../tests/peerd-distributed/signaling-bun-budget.test.ts)
exercises compatibility, aggregate refusal and recovery, and a bounded opaque
negotiation burst. The
[policy tests](../tests/peerd-distributed/signaling-budget.test.ts) and
[cleanup tests](../tests/peerd-distributed/signaling-bun-cleanup.test.ts)
cover accounting and failure paths. These prove shell behavior, not native
WebRTC capacity or WAN performance. Benchmark paced admission separately
from simultaneous negotiation storms, and report honest overload rather
than raising quotas to hide it. Native browser scale acceptance remains
separate CI work.

## Worker room persistence

[worker.js](worker.js) uses [durable-room-budget.js](durable-room-budget.js)
to debit a versioned room record independently of socket attachments. Defaults
come from the same policy source as the Bun shell. Storage transactions retain
their default input/output gates; room credit is committed before parsing or
outbound effects. Corrupt or unavailable storage refuses work rather than
resetting the room's allowance. Disconnects do not delete spent credit, and
backward wall-clock movement cannot create a fresh window.

The shell caps all runtime-attached sockets, independently of admitted
membership, so stalled closes cannot accumulate through successive windows.
Whole operations have bounded application custody while storage is pending;
this does not bound Cloudflare's runtime ingress buffers. Edge automatic
ping/pong responses bypass handler quotas. Private keys map to distinct Durable
Objects, so neither this record nor Bun's process budget supplies account-wide
protection. Deployment, WAF policy and native runtime hibernation acceptance
remain separate gates. The
[Worker shell regressions](../tests/peerd-distributed/signaling-worker.test.ts)
and [durable policy regressions](../tests/peerd-distributed/durable-room-budget.test.ts)
use a fake storage/runtime boundary and do not prove actual runtime eviction
or persistence behavior.

If both attachment serialization and native close fail, the current Worker
instance refuses further work; residual sockets still count against its
physical custody ceiling. This is a platform custody failure, not a proven
cross-wake retirement. Native runtime acceptance must establish that boundary
before activation; the fake tests deliberately make no stronger claim.
