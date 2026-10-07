# Native sparse-network acceptance

Run `bun scripts/cdp/run-dweb-scale.mjs --peers=16 --mode=paced` in browser CI.
The explicit larger experiments accept `--peers=32` or `--peers=64`;
`--peers=64 --browsers=4` distributes those identities over four independent
Chrome browser processes, while the default `--browsers=1` retains the original
single-browser experiment. No mode switches or retries after failure.
Artifact paths and provenance include the browser count.
`--mode=stress` removes the paced spacing between network starts. No mode
raises production degree, admission, message, bandwidth, or membership limits.
A failed attempt remains a failed gate; do not retry it unchanged.

Each identity owns an isolated browser context running the production public
room, sparse profile, room admission, HELLO proof, mesh, gossip, and content
stack. Carriers are native RTCPeerConnection with iceServers set to an empty
array. The local Bun signaling factory uses its unchanged production budgets.
The extension loaded by the existing launcher stays locked. Fixture identities
do not activate the user's network or change stored consent.

All browser contexts and static modules are prepared before any network start.
A native-resource and signaling barrier verifies that preparation opened no
peer connections or sockets. Network joins then follow the selected cadence;
the whole-run deadline includes both phases. This measures preloaded clients
joining a native network, not cold page creation under an already active mesh.
Earlier failures of that combined workload remain unresolved evidence; this
phase separation does not establish their cause or claim to repair them.

Acceptance requires every requested identity and a reciprocal connected graph,
without raising the default active degree. The driver selects an existing
non-neighbor pair in a connected graph. Only a complete reciprocal graph needs
an edge removed, and the remaining graph must still be connected before publish.
The source may differ from the content provider. The report retains the chosen
topology and the neighbor set at the first accepted native gossip send, and requires
the target's authenticated incoming route to differ from the signed origin.
Every other identity must receive the message. A small signed App is fetched
by a distinct directly linked receiver; verification checks the exact manifest
hash, publisher signature, transport commitments, and known decoded file bytes.
This content check does not claim multi-hop provider dialing.

The run then isolates a peer, observes production maintenance repair, stops
signaling, proves gossip during the outage, restores the same signaling address,
and checks membership, gossip, and verified content again.

Timing and cadence are selected before execution in `SCALE_BUDGETS` in
`scripts/cdp/run-dweb-scale.mjs`; the report records the exact values used.
`SCALE_ACCEPTANCE` declares the independently chosen native ownership ceilings.
Production-exported outgoing and bootstrap limits remain authoritative where
available. Per-realm observations occur periodically and at peer construction.
Observed peaks are samples, not a claim that every internal mutation was sampled;
deterministic admission and queue tests prove those separate invariants.

The bounded JSON artifact records checks, recent snapshots, actual governor
counters, native peer counts, signaling counters, errors, and production cleanup
receipts. An overloaded run that cannot reach its requested membership fails;
it is not promoted as scale acceptance merely because overload was refused
correctly. Production teardown must release native peers, channels, sockets,
and queues before context or process fallback. A cleanup timeout fails the run.

These are explicit single-browser or four-browser workloads on one host with
localhost networking. Earlier single-browser admission and cold-page failures
remain unresolved; a four-browser success would not establish their cause or
claim to repair them. Every workload uses one unchanged signaling endpoint. It does not
establish independent-device capacity, public bootstrap capacity, WAN loss or
cross-NAT behavior, or justify raising the default active degree. It uses only the
existing small-bundle contract. Native execution is CI-only in the current
restricted development environment.
