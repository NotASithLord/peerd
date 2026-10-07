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
Deployment ownership and durable Worker admission remain separate work.

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
