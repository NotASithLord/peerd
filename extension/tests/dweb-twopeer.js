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
// restore=1 mode: run the full persistent-identity lifecycle before joining.
// Deep imports are fine here (tests/ is exempt from the no-deep-import rule,
// same as the a2a-dispatch import below).
import { loadIdentityMaterial, identityFromMaterial } from '/peerd-distributed/identity/keypair.js';
import { buildIdentityRecord, adoptIdentityRecord } from '/peerd-distributed/identity/recovery-record.js';
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
// restore=1: this peer joins the mesh AS A RESTORED IDENTITY. It simulates the
// whole portable-identity lifecycle in-page (install A mints and exports a
// recovery record; a fresh install B adopts it and loads the identity exactly
// the way the offscreen mesh host does), then joins the live mesh with the
// result. The driver asserts the joined did equals the pre-backup did: the
// proof that a restored identity keeps its PLACE IN THE NETWORK, not just its
// key material.
const restoreOn = params.get('restore') === '1';

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
// restore mode: the did minted on "install A" before backup. A green run
// requires the joined did to equal it.
/** @type {string | null} */
let restoredFromDid = null;
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

// The vault-secret shape both the transfer helper and the mesh host program
// against, reduced to a Map for the in-page lifecycle simulation.
const fakeSecretStore = () => {
  /** @type {Map<string, string>} */
  const secrets = new Map();
  return {
    getSecret: async (/** @type {string} */ secretName) => secrets.get(secretName) ?? null,
    setSecret: async (/** @type {string} */ secretName, /** @type {string} */ value) => { secrets.set(secretName, value); },
  };
};
const IDENTITY_SECRET = 'distributed/identity/v1';
const RESTORE_PASSPHRASE = 'twopeer-harness-restore-passphrase';

// The persistent-identity lifecycle, end to end, yielding the identity the
// mesh will join with: install A mints via the production first-run path and
// exports a recovery record; install B (a fresh empty store) adopts it,
// persists the material under the identity secret, and loads it back through
// loadIdentityMaterial + identityFromMaterial, byte-for-byte the composition
// offscreen/dweb-base.js runs at mesh start.
const restoreIdentity = async () => {
  const installA = fakeSecretStore();
  const original = await loadIdentityMaterial(installA);
  restoredFromDid = original.did;
  const record = await buildIdentityRecord({
    material: { seed: original.seed, pub: original.pub },
    wrappers: [{ kind: 'passphrase', passphrase: RESTORE_PASSPHRASE }],
  });
  const outcome = await adoptIdentityRecord({
    record, passphrase: RESTORE_PASSPHRASE, existingMaterial: null,
  });
  if (!outcome.adopted || typeof outcome.material !== 'string') {
    throw new Error(`restore failed before join: ${outcome.reason}`);
  }
  const installB = fakeSecretStore();
  await installB.setSecret(IDENTITY_SECRET, outcome.material);
  return identityFromMaterial(await loadIdentityMaterial(installB));
};

const boot = async () => {
  try {
    const identity = restoreOn ? await restoreIdentity() : await generateIdentity();
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
          // restore mode: true only when the mesh identity IS the pre-backup
          // did. The driver requires it for the restore-mode pass gate.
          restored: restoreOn ? (restoredFromDid !== null && myDid === restoredFromDid) : null,
          restoredFrom: restoredFromDid,
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
