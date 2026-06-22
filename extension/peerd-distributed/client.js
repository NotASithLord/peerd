// @ts-check
// peerd-distributed/client.js — the live DwebClient.
//
// This is the dweb side of the core↔dweb boundary: core
// programs against the DwebClient typedef in
// /shared/dweb-interface.js and obtains THIS implementation via
// loadDweb() (preview packages only — the store package ships the stub
// and prunes this whole module).
//
// Keep the surface minimal. Growing it is a deliberate act — see
// PACKAGING.md §"Adding dweb-only code". PHASE 1 grows it with exactly
// what the hosting PAGES need — never the SW, which cannot import this
// module (a ServiceWorker can't dynamic-import, and must not reference the
// module path). All of these run in a page (options / app-tab via
// loadDweb); the SW only owns the vault + audit + app registry + tabs:
//   identityMaterial / identityFromMaterial — mint/rehydrate the Ed25519
//     identity page-side, vault IO injected as scoped SW round-trips;
//   loadSeedApp — read the commons seed files for first-run install;
//   installAppBundle — verified bundle → engine App; createAppBridge —
//     the dwapp postMessage bridge.

import { generateIdentity, loadIdentityMaterial, identityFromMaterial } from './identity/keypair.js';
import { joinRoom } from './transport/rooms.js';
import { createBaseNetwork, BASE_TOPIC } from './base-network.js';
import { installAppBundle } from './apps/loader.js';
import { createDwebBridge, iframeTransport } from './apps/bridge.js';
import { loadSeedApp, COMMONS_SEED } from './apps/seed.js';
import { DEFAULT_SIGNALING } from './transport/signaling-client.js';
import { dlog } from './log.js';

// Protocol phase. Phase 1 = rooms & live collaboration: N-peer rooms,
// topic gossip + sync, the dwapp bridge, the commons. Research-grade; may
// change without notice (that's what "preview" means).
export const PHASE = 1;

// The DHT per-hop dialer (peer-node.js's `dial`). Kademlia's lookup walks toward
// a key by querying nodes closer to it — nodes we may not link. To query one we
// don't link, relay-dial it through the peer who vouched for it (the lookup tags
// each contact with hints.broker = the responder that returned it; since that
// responder answered us, it's directly linked, so the one-hop relay rule holds).
// No broker we link → no path this hop: return false and the lookup drops the
// contact and moves on. (For a small full-mesh lobby every contact is already
// linked, so this never fires — it's the scale-out path beyond the mesh budget.)
/** @typedef {Awaited<ReturnType<typeof joinRoom>>} Room */
/** @param {Room} room */
const makeDhtDialer = (room) => /** @param {{ did: string, hints?: { broker?: string } }} contact */ async (contact) => {
  if (room.mesh.hasLink(contact.did)) return true;
  const broker = contact?.hints?.broker;
  if (!broker || !room.mesh.hasLink(broker)) return false;
  try { await room.dialVia(broker, contact.did); }
  catch (e) { dlog('dht', `relay-dial of ${contact.did.slice(-8)} via ${broker.slice(-8)} failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); return false; }
  return room.mesh.hasLink(contact.did);
};

/** @typedef {import('/shared/dweb-interface.js').DwebClient} DwebClient */

/** @returns {DwebClient} */
export const createDwebClient = () => {
  // Ephemeral identity for status display in contexts without vault
  // access. The REAL (persistent, vault-stored) identity flows through
  // identityMaterial below — SW-side, vault IO injected.
  /** @type {Promise<import('./identity/keypair.js').Identity> | null} */
  let identityPromise = null;

  const ensureIdentity = async () => {
    identityPromise ??= generateIdentity();
    const { did } = await identityPromise;
    return { did };
  };

  return Object.freeze({
    available: true,
    phase: PHASE,
    getStatus: async () => ({
      available: true,
      phase: PHASE,
      did: identityPromise ? (await identityPromise).did : null,
    }),
    ensureIdentity,

    // --- Phase 1 ---------------------------------------------------------
    identityMaterial: loadIdentityMaterial,
    identityFromMaterial,
    installAppBundle,
    // Host a dwapp's bridge. The app-tab passes `frame` (the iframe) and gets
    // the default iframe transport; an offscreen host can pass `transport`
    // directly (an SW relay) to run the same bridge there (S1).
    createAppBridge: ({ frame, transport, ...rest }) =>
      createDwebBridge({ transport: transport ?? iframeTransport(frame), ...rest }),

    // Join the always-on base network: connect to the lobby and assemble the
    // base host on its mesh. Returns { base, room, close } — the offscreen doc
    // holds this for the life of the extension session so the net outlives any
    // tab (S1b). close() leaves the lobby + tears down the mesh.
    BASE_TOPIC,
    /** @param {{ identity: import('./transport/mesh.js').Identity, url?: string, audit?: import('./transport/mesh.js').AuditFn }} opts */
    joinBaseNetwork: async ({ identity, url = DEFAULT_SIGNALING[0], audit = null } = /** @type {any} */ ({})) => {
      const room = await joinRoom({ roomId: BASE_TOPIC, identity, url, audit });
      // why kind: the lobby presence beacon carries `kind:'extension'` so other
      // members (e.g. an ephemeral peer the peerd.ai landing page joins) can tell
      // a real extension apart from a website visitor in the live network view.
      const base = await createBaseNetwork({ identity, mesh: room.mesh, meta: () => ({ kind: 'extension' }), dial: makeDhtDialer(room), audit });
      return { base, room, url, close: () => { base.close(); room.leave(); } };
    },
    loadSeedApp,
    seedAppKey: COMMONS_SEED.key,
    defaultSignaling: DEFAULT_SIGNALING,
  });
};
