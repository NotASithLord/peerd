// @ts-check
// extension/tests/dweb-twopeer.js — ONE real dweb peer, for the headless
// two-peer integration harness (scripts/cdp/run-dweb-twopeer.mjs).
//
// why this exists: everything BELOW the WebRTC line is already automated — pure
// logic in `bun test`, emergent N-node behaviour in the in-memory sim, and
// cross-process nodes in the netproc cluster. The one tier left manual was real
// WebRTC bytes between real browser contexts:
// two Chrome profiles, by hand, every release. This page is that flow made
// scriptable. It runs the SAME runtime composition production does —
// `joinRoom` (rendezvous + WebRTC mesh) feeding `createBaseNetwork` (the
// offscreen always-on host) — so a refactor that breaks the live path fails CI
// instead of a manual checklist.
//
// The driver opens two of these pointed at the same room + local signaling
// node, then polls window.__DWEB__.report() until both peers link and each has
// heard the other's gossip. State on a global; no UI.

import { generateIdentity, joinRoom } from '/peerd-distributed/index.js';
import { createBaseNetwork } from '/peerd-distributed/base-network.js';

const params = new URLSearchParams(location.search);
const roomId = params.get('room') ?? 'harness';
const url = params.get('url') ?? 'ws://localhost:8799/rendezvous';
const name = params.get('name') ?? 'peer';

// The gossip topic the two peers exchange a hello on — proves the application
// layer (gossip flood + dedup) works over the live mesh, not just that a data
// channel opened. Presence (snapshot.present) rides gossip too, so a green run
// proves both the mesh AND the pub/sub that sits on it.
const CHAT_TOPIC = 'peerd-harness/hello';

const out = document.getElementById('out');
/** @type {Set<string>} */
const heardFrom = new Set();            // dids we've received a CHAT_TOPIC msg from
// why any: base/identity come from the dweb runtime (joinRoom/createBaseNetwork),
// whose shapes aren't exported as types to this harness page; this is a manual-
// test driver, not production code, so the global/runtime boundary is `any`.
/** @type {any} */
let base = null;
/** @type {any} */
let myDid = null;
/** @type {any} */
let error = null;

const render = () => {
  const snap = base?.snapshot?.() ?? { linkedCount: 0, presentCount: 0 };
  if (!out) return;
  out.textContent = [
    `name:    ${name}`,
    `did:     ${myDid ?? '(pending)'}`,
    `linked:  ${snap.linkedCount}`,
    `present: ${snap.presentCount}`,
    `heard:   ${heardFrom.size}`,
    error ? `ERROR:   ${error}` : '',
  ].filter(Boolean).join('\n');
};

const boot = async () => {
  try {
    const identity = await generateIdentity();
    myDid = identity.did;
    render();

    // iceServers: [] — on the loopback the host candidates connect directly; a
    // STUN round-trip is both unnecessary and (in a sealed CI runner) a hang
    // waiting for an outbound packet that never leaves. The driver also disables
    // mDNS candidate obfuscation so these host candidates carry real loopback
    // IPs Chrome can actually pair.
    const room = await joinRoom({ roomId, identity, url, iceServers: [] });
    base = await createBaseNetwork({ identity, mesh: room.mesh, meta: () => ({ name }) });

    // Subscribe BEFORE we start beaconing — gossip is fire-and-flood, so a
    // handler that goes up after a peer publishes would miss that round (the
    // ordering lesson the netproc 5-node run taught us, same shape here).
    base.node.gossip.subscribe(CHAT_TOPIC, (/** @type {{ from?: string }} */ { from }) => {
      if (from && from !== myDid) { heardFrom.add(from); render(); }
    });

    base.start();
    render();

    // Re-publish on an interval rather than once: the second peer may still be
    // mid-ICE when the first beacons, and a single fire-and-forget gossip would
    // be lost. The driver's overall budget stops this; an idempotent re-send is
    // the cheap way to be robust to join-order timing.
    const beat = setInterval(() => {
      base.node.gossip.publish(CHAT_TOPIC, { from: name }).catch(() => {});
      render();
    }, 1000);

    // why any cast: __DWEB__ is a harness-only global the CDP driver polls; it's
    // not part of the typed Window surface, so the boundary is `any` here.
    /** @type {any} */ (window).__DWEB__ = {
      ready: true,
      did: myDid,
      // The single source of truth the driver polls.
      report: () => {
        const snap = base.snapshot();
        return {
          did: myDid,
          linked: snap.linkedCount,
          present: snap.presentCount,
          heard: heardFrom.size,
          peers: snap.peers.map((/** @type {any} */ p) => ({ did: p.did, name: p.name, linked: p.linked, path: p.path })),
          error,
        };
      },
      stop: () => { clearInterval(beat); base.close(); room.leave(); },
    };
  } catch (e) {
    error = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    render();
    /** @type {any} */ (window).__DWEB__ = { ready: true, did: myDid, report: () => ({ did: myDid, error, linked: 0, present: 0, heard: 0, peers: [] }) };
  }
};

boot();
