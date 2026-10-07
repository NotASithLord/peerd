# Physical Mac P2P validation

`bun run test:cluster /absolute/private-config.json` runs production dweb modules
in independent Chrome processes on separate Macs. It exercises authenticated
mesh links, gossip, standing A2A conversations, discovery and provider records,
concurrent signed bundle transfers, corruption rejection, unsharing, reseeding,
room isolation, reconnection and survival after rendezvous shutdown.

This is a transport and protocol integration lane. The modules run on a
loopback-served browser fixture, not inside the extension service worker; the
extension lifecycle lane remains `test:e2e:dweb-lifecycle`.

Stage the same `extension/` tree and `scripts/cdp/dweb-cluster-{node.mjs,page.js}`
on each machine. Supply Bun and the same Chrome for Testing binary on every host.
The coordinator uses the repository's signaling server over authenticated SSH
reverse forwards; HTTP and debugging endpoints bind only to loopback. WebRTC
uses native UDP between hosts, with no STUN/TURN service. mDNS remains enabled
unless the private config explicitly sets `mdns: false` for diagnostics.

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

SSH aliases may select jump hosts and existing authenticated control sockets.
`sshOptions` accepts an argument array for an existing socket; `signalingPort`
can select a free remote loopback port. No SSH master is stopped. Run only on
available machines: the runner does not reserve shared infrastructure, install
software, alter network settings or terminate unrelated browsers.

Each run writes `scripts/cdp/artifacts/cluster-result.json` (override with
`output`). Evidence includes hashed hardware identities, source fingerprints,
browser versions, per-check outcomes, content hashes, selected candidate pairs
and byte counters. It fails on duplicate hardware, mixed source/browser versions,
missing peers, loopback/relay candidates or absent bidirectional traffic. Reports
contain private network addresses: keep them local or redact before sharing.

For a local rehearsal, omit `ssh`, point both entries at the local checkout and
pass `--local`. Such a report is explicitly labeled `local-rehearsal`; it cannot
qualify the physical-Mac lane. The runner removes only its temporary profiles
and forwards. A host watchdog also closes its browser after an abandoned run.
