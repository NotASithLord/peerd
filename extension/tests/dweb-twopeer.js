// @ts-check
// extension/tests/dweb-twopeer.js — ONE real dweb peer, for the headless
// two-peer integration harness (scripts/cdp/run-dweb-twopeer.mjs).
//
// why this exists: everything BELOW the WebRTC line is already automated — pure
// logic in `bun test`, emergent N-node behaviour in the in-memory sim, and
// cross-process nodes in the netproc cluster. The one tier left manual was real
// WebRTC bytes between real browser contexts (docs/distributed/TESTING.md §B–F):
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
// The PRODUCTION a2a ask/reply correlation core — driven here over the REAL mesh
// direct channel so the live two-peer round-trip exercises the same code the
// dweb actor's a2a_run uses (envelope tag + request/reply, the did-bound resolve).
// why the DEEP import (not /peerd-runtime/index.js): the barrel transitively pulls
// in browser-polyfill, which throws off an extension origin — this harness page
// runs on plain http. a2a-dispatch.js is a pure, import-free module, so it loads
// cleanly here. (tests/ is exempt from the no-deep-import rule.)
import { makeMeshDispatch } from '/peerd-runtime/actor/a2a-dispatch.js';
import { createConversationRegistry } from '/peerd-runtime/actor/conversation-registry.js';

const params = new URLSearchParams(location.search);
const roomId = params.get('room') ?? 'harness';
const url = params.get('url') ?? 'ws://localhost:8799/rendezvous';
const name = params.get('name') ?? 'peer';
const a2aOn = params.get('a2a') === '1';   // add the live ask/reply beat on top of gossip

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
// a2a live round-trip state (only when a2aOn): did we send an ask and get the
// peer's reply back, over the real mesh, via the production correlation core?
let askReplied = false;
/** @type {any} */ let askReply = null;

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

    // The a2a live round-trip: wire the production makeMeshDispatch to THIS peer's
    // real direct channel. Each peer auto-replies PONG to any inbound ask, and —
    // once it sees a linked peer — sends exactly one ask and records the reply.
    // A green run proves the envelope protocol + the did-bound reply correlation
    // survive real WebRTC between two browser contexts, not just the unit fakes.
    let askBeat = null;
    if (a2aOn) {
      // conv=1 additionally proves a STANDING conversation: converse opens a
      // thread, the peer's reply threads a convId back, and say continues it —
      // the convId surviving real WebRTC end to end.
      const convOn = params.get('conv') === '1';
      const conversations = convOn ? createConversationRegistry() : null;
      const dispatch = makeMeshDispatch({
        sendDm: async (/** @type {string} */ to, /** @type {any} */ env) => {
          try { const r = await base.node.direct.send(to, env); return { ok: true, id: r?.id }; }
          catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
        },
        listPeers: async () => (base.snapshot().peers ?? []).map((/** @type {any} */ p) => ({ did: p.did, name: p.name })),
        fetchCard: async () => null,
        publishCard: async () => ({ ok: false, error: 'not in the two-peer harness' }),
        conversations,
      });
      // Inbound directs → the dispatch. An inbound ask is auto-answered; when it
      // carries a convId, the reply threads it back so the opener's thread grows.
      base.node.direct.onMessage((/** @type {{ from: string, data: any }} */ { from, data }) => {
        const routed = dispatch.handleInbound(from, data);
        if (routed?.deliver?.kind === 'ask') {
          const cid = routed.deliver.convId;
          dispatch.reply(from, routed.deliver.reqId, `PONG:${routed.deliver.message}`, cid).catch(() => {});
        }
      });
      let asked = false;
      askBeat = setInterval(async () => {
        if (asked) return;
        const peer = (base.snapshot().peers ?? []).find((/** @type {any} */ p) => p.did && p.did !== myDid && p.linked);
        if (!peer) return;
        asked = true;
        try {
          if (convOn) {
            // Open a standing conversation, then continue it — two turns on one convId.
            const c = await dispatch.dispatch('converse', { did: peer.did, message: `HELLO-${name}`, timeoutMs: 8000 }, { signs: true, allowed: () => true });
            if (c?.ok && c.convId && c.reply != null && !c.timedOut) {
              const c2 = await dispatch.dispatch('say', { convId: c.convId, message: `FOLLOWUP-${name}`, timeoutMs: 8000 }, { signs: true, allowed: () => true });
              if (c2?.ok && c2.reply != null && !c2.timedOut && c2.convId === c.convId) {
                askReplied = true; askReply = `${c.reply} | ${c2.reply}`;
              }
            }
          } else {
            // 8s ask timeout keeps the round-trip well inside the harness budget.
            const r = await dispatch.dispatch('ask', { did: peer.did, message: `PING-${name}`, timeoutMs: 8000 }, { signs: true, allowed: () => true });
            if (r?.ok && r.reply != null && !r.timedOut) { askReplied = true; askReply = r.reply; }
          }
        } catch { /* leave askReplied false — the harness fails on the timeout */ }
        render();
      }, 800);
    }

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
          askReplied,
          askReply,
          peers: snap.peers.map((/** @type {any} */ p) => ({ did: p.did, name: p.name, linked: p.linked, path: p.path })),
          error,
        };
      },
      stop: () => { clearInterval(beat); if (askBeat) clearInterval(askBeat); base.close(); room.leave(); },
    };
  } catch (e) {
    error = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    render();
    /** @type {any} */ (window).__DWEB__ = { ready: true, did: myDid, report: () => ({ did: myDid, error, linked: 0, present: 0, heard: 0, peers: [] }) };
  }
};

boot();
