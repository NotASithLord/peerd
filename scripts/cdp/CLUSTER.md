# Physical Mac P2P validation

`bun run test:cluster /absolute/private-config.json` runs production dweb modules
in independent Chrome processes on separate Macs. It exercises authenticated
mesh links, gossip, standing A2A conversations, discovery and provider records,
concurrent signed bundle transfers, corruption rejection, unsharing, reseeding,
room isolation, reconnection and survival after rendezvous shutdown.

This is a transport and protocol integration lane. The modules run on a
loopback-served browser fixture, not inside the extension service worker; the
extension lifecycle lane remains `test:e2e:dweb-lifecycle`.

Stage the same `extension/` tree and `scripts/cdp/dweb-cluster-{node.mjs,page.js,rpc.mjs,source.mjs}`
on each machine. Supply Bun and the same Chrome for Testing binary on every host.
The coordinator uses the repository's signaling server over authenticated SSH
reverse forwards; HTTP and debugging endpoints bind only to loopback. WebRTC
uses native UDP between hosts, with no STUN/TURN service. mDNS remains enabled
unless the private config explicitly sets `mdns: false` for diagnostics.
For a secondary LAN interface, `allInterfaces: true` grants microphone permission
only to the temporary fixture origin so Chrome can enumerate interfaces. The
browser uses fake media devices and the fixture never captures media. Both
options are recorded in host evidence; neither changes a user's browser profile.

Example private configuration (keep addresses, sockets and credentials outside Git):

```json
{
  "hosts": [
    {
      "name": "studio",
      "ssh": "studio-test",
      "directory": "/absolute/peerd-test-checkout",
      "bun": "/absolute/bun",
      "chrome": "/absolute/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    },
    {
      "name": "mini",
      "ssh": "mini-test",
      "directory": "/absolute/peerd-test-checkout",
      "bun": "/absolute/bun",
      "chrome": "/absolute/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    }
  ]
}
```

SSH aliases may select jump hosts and existing key or agent authentication.
The runner uses dedicated connections and does not reuse or mutate shared control
sockets. `sshOptions` accepts ordinary SSH arguments; control-socket options are
rejected. `signalingPort` can select a free remote loopback port. No SSH master is stopped. Run only on
available machines: the runner does not reserve shared infrastructure, install
software, alter network settings or terminate unrelated browsers.

Each run writes `scripts/cdp/artifacts/cluster-result.json` (override with
`output`). Evidence includes hashed hardware identities, source fingerprints,
browser and Bun versions, separate coordinator/host Git revisions and dirty
status (unknown for staged snapshots), per-check outcomes, content hashes,
selected candidate pairs and byte counters. It fails on duplicate hardware,
source bytes differing from the coordinator, mixed browser or Bun versions,
missing peers, loopback/relay candidates or absent bidirectional traffic. Reports
contain private network addresses: keep them local or redact before sharing.

For a local rehearsal, omit `ssh`, point both entries at the local checkout and
pass `--local`. Such a report is explicitly labeled `local-rehearsal`; it cannot
qualify the physical-Mac lane. The runner removes only its temporary profiles
and forwards. A host watchdog also closes its browser after an abandoned run.

The default `topology` is `"all-pairs"`. Use `"connected"` to qualify a
multi-hop physical graph when some host pairs have no direct route; every host
must still belong to one symmetric connected component, fresh signed gossip
must traverse the whole graph, and every actual link must expose a selected
direct, non-relay UDP pair. Chrome may report the remote side as peer-reflexive
with a redacted address; the reciprocal host report still has to pass. An optional integer `budget` passes the production
per-peer link cap into each room for fixed-degree experiments. Neither setting
changes a production profile or browser default.

`roomId` and `profile` may be supplied together to exercise a negotiated
rendezvous profile, such as the production sparse public room, without changing
the server or extension defaults. Keep private runs on an isolated signaling
server as shown above.

Offline link repair is a separate coverage check. The runner drops an edge only
when both endpoints retain a common connected relay broker. Without that
triangle, it records the repair check in `skipped`, with its reason, and still
checks signaling-outage survival and recovery. An otherwise successful report
with this skip does not qualify offline link repair; use a topology containing
a triangle to cover that scenario.

An optional `soak` object requests sustained transport checks, for example
`"soak": { "durationMs": 14400000, "intervalMs": 30000 }`. The coordinator
rechecks authenticated membership, fresh gossip, verified content and direct
UDP paths throughout the requested duration. Limits are enforced by
`dweb-cluster-soak.mjs`. A failed cycle fails the run; it is not retried into a
passing receipt. The result is checkpointed as incomplete while running, with
bounded recent timing samples and a total completed-cycle count. Successful
control requests renew the host's idle watchdog; abandoned or hung work still
expires. Run only while those physical hosts remain reserved for the test.

This soak measures sustained transport and content availability. It does not
qualify extension worker retirement, system sleep/wake, WAN/NAT diversity or
capacity beyond the recorded host allocation. Keep those acceptance lanes
separate; a local rehearsal is never physical-cluster evidence.

For an explicitly shared-host capacity preflight, pass `--capacity` instead of
`--local`. On the isolated coordinator, explicitly request the production sparse
room and profile (see the rendezvous-profile module); a capped legacy room does
not negotiate sparse maintenance and is rejected. Use `topology: "connected"`, zero temporary reserve, and more browser
entries than the configured degree budget. Each entry launches an independent
browser process and temporary profile. Repeated SSH hosts need different free
`signalingPort` values; entry names remain unique. At least two physical Macs
must participate. The existing distinct-Mac lane continues rejecting repeated
hardware identities.

The capacity preflight records hardware count, browser-process count, logical
membership, achieved degrees, and same-host versus cross-host edges separately.
Cross-host paths retain the physical lane's direct UDP requirements. Same-host
paths cannot stand in for remote links. A successful preflight only qualifies
this placement and workload: the report explicitly leaves full capacity
qualification incomplete until paired degree comparisons, whole-browser
resource metrics, adverse workloads, and sustained/overnight runs are collected.
It does not change production degree or establish a supported network size.

Set `resourceMetrics: true` to collect owned browser-process observations. The
coordinator writes an exclusive companion JSONL file beside the result; use a
fresh output path for each run. It samples the browser process tree and the
controlled renderer heap at fixture readiness, periodically during the workload,
and before cleanup. Missing observations fail the run. The result identifies
the companion file and sample count; retain both with the source fingerprint.

With resource collection enabled, an optional `idleBaseline` object uses the
same duration/interval shape as `soak` to observe the loaded fixtures before
any peer starts. Its tighter bounds are enforced by `idleBaselineOptions` in
`dweb-cluster-soak.mjs`. Samples carry an `idle-before-peer-start` phase, and
the result retains an incomplete checkpoint until a final observation succeeds
after the requested interval. A missing observation fails the run. Compare
these samples with the active workload on the same hosts; they include the
collector's overhead and are not a blank-browser or connected-but-idle baseline.

The collector in `dweb-process-evidence.mjs` records numeric process identities,
RSS, cumulative CPU time and numeric open-file-descriptor counts, without command
lines, file paths or socket endpoints. Descriptor counts exclude mapped-file
pseudo-descriptors. Process and descriptor snapshots are not atomic; an exited
or inaccessible process fails the observation instead of contributing zero. Summed RSS can double-count
shared pages; CPU observations omit processes that exited between samples; the
renderer heap is not the whole browser heap. These observations do not establish
an idle baseline unless requested, or qualify queue or bandwidth budgets. The report keeps those
missing measurements explicit.

Resource observation also enables a 100ms timer in the controlled renderer.
`dweb-event-loop-evidence.mjs` retains cumulative timer lateness in a fixed
16-bucket histogram, with total and maximum delay; the final bucket includes
delays above 16384ms. A delayed callback contributes once, without catch-up
bursts. This measures renderer scheduling delay, including OS throttling, rather
than network latency or every browser process. Sampling itself adds ten timer
callbacks per second, so retain uninstrumented comparison runs. The timer is
disabled unless resource observation is requested and retires with the page.
These samples do not establish whole-browser event-loop or responsiveness
budgets.
