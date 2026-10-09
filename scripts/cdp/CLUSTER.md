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
