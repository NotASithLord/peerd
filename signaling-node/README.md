# Bun bootstrap admission

`bun bun-server.mjs` starts the same signaling reducer as the Worker, with
additional **process-local Bun quotas**. This does not configure Cloudflare,
provide Worker hibernation parity, or activate the sparse browser profile.

Existing socket limits remain 120 messages per 10 seconds and 64 KiB per
message. The Bun API now requires nonempty room keys of at most 256 UTF-8
bytes, with no C0/DEL characters. Keys are not normalized. Ordinary public
and private room keys and legacy signaling messages remain compatible.

`admission-budget.js` is the single owner of injectable shell limits:

| Resource per fixed 10-second window | Room | Bun process |
| --- | ---: | ---: |
| Join attempts | 128 | 256 |
| Accepted ingress messages | 1,024 | 4,096 |
| Accepted ingress bytes | 8 MiB | 32 MiB |
| Outbound frames | 4,096 | 16,384 |
| Outbound bytes | 16 MiB | 64 MiB |
| Reserved control frames within outbound total | 128 | 512 |
| Reserved control bytes within outbound total | 128 KiB | 512 KiB |

The process also owns at most 128 room accounting entries and 2,048 live
socket reservations. Inactive entries retain spent credit until window
expiry; disconnecting or changing keys cannot mint fresh process credit.
Room-map refusals consume process join credit. These are fixed-window
budgets, so two adjacent windows can each admit a burst.

Ingress byte/message admission precedes JSON parsing and message reduction.
The existing reducer does not perform signaling cryptography. Whole outbound
batches reserve credit before reducer state commits or any recipient receives
a frame. Failed writes never refund credit. Native per-socket buffering is
separately capped at 256 KiB. Departures always remove membership even when
no outbound notice credit remains. Cleanup runs iteratively and releases
socket custody despite failed writes or notice accounting.

Aggregate overload rejects an upgrade with HTTP 503 and `Retry-After`, or
retires an existing socket with WebSocket 1013. Existing individual rate/size
failures retain their prior semantics. Overload is not evidence of a malicious
DID and creates no peer ban. These limits do not provide per-person fairness,
Sybil resistance, cross-process/account quotas, or HTTP front-door/WAF limits.
Deployment ownership and durable Worker admission remain separate work.

The real Bun regression retains the existing 40-member compatibility flow and
adds 40 peers sending 960 opaque, roughly 1-KiB negotiation messages in one
window (four neighbors, six messages each). It proves bounded shell delivery,
not native WebRTC capacity or WAN performance. A simultaneous 64-peer or
16-neighbor-per-peer negotiation storm can exceed 1,024 messages; benchmark
paced admission separately and report honest overload rather than raising
quotas to hide it. Native 16/32/64-browser acceptance is separate CI work.
