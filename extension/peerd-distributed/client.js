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
// PACKAGING.md §"Adding dweb-only code". Chrome hosts this client in an
// offscreen page because its service worker cannot dynamic-import; Firefox
// has no offscreen API and loads it in its MV3 background. The background
// still owns vault custody, audit, app registry, and tabs:
//   identityMaterial / identityFromMaterial — mint/rehydrate the Ed25519
//     identity page-side, vault IO injected as scoped SW round-trips;
//   loadSeedApp — read the commons seed files for first-run install;
//   installAppBundle — verified bundle → engine App; createAppBridge —
//     the dwapp postMessage bridge.

import { generateIdentity, loadIdentityMaterial, identityFromMaterial } from './identity/keypair.js';
import { buildIdentityRecord, adoptIdentityRecord } from './identity/recovery-record.js';
import { joinRoom } from './transport/rooms.js';
import { createBaseNetwork, BASE_TOPIC } from './base-network.js';
import { fetchImmutableApp, immutableAppSummary } from './apps/immutable-address.js';
import { installAppBundle } from './apps/loader.js';
import { createDwebBridge, iframeTransport } from './apps/bridge.js';
import { loadSeedApp, COMMONS_SEED } from './apps/seed.js';
import { DEFAULT_SIGNALING } from './transport/signaling-client.js';
import { makeDhtDialer } from './transport/dht-dialer.js';
import { createSelfDeviceCoordinator } from './self/coordinator.js';
import { createSelfDeviceMesh } from './self/mesh.js';
import { createSyncSource, createSyncReceiver } from './self/host.js';
import { loadCoordinatorInputs } from './self/custody.js';

// Protocol phase. Phase 1 = rooms & live collaboration: N-peer rooms,
// topic gossip + sync, the dwapp bridge, the commons. Research-grade; may
// change without notice (that's what "preview" means).
export const PHASE = 1;

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

    // Self-device runtime. These must be properties of the client returned
    // by loadDweb(), not merely exports of the module index: the offscreen
    // host deliberately reaches the live module only through this boundary.
    createSelfDeviceCoordinator,
    createSelfDeviceMesh,
    createSyncSource,
    createSyncReceiver,
    loadCoordinatorInputs,

    // --- portable identity -----------------------------------------------
    // Record build/open runs in the channel's dweb crypto host (Chrome
    // offscreen page; Firefox background). The background owns the vault
    // reads/writes on either side and passes material through the one
    // extension-internal boundary keypair.js already documents.
    /** @param {{ material: { seed: string, pub: string }, passphrase: string }} args */
    identityRecordExport: async ({ material, passphrase }) =>
      buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase }] }),
    /** @param {{ record: any, passphrase?: string, existingMaterial?: string | null, replaceExisting?: boolean }} args */
    identityRecordAdopt: async ({ record, passphrase, existingMaterial, replaceExisting }) =>
      adoptIdentityRecord({ record, passphrase, existingMaterial, replaceExisting }),
    installAppBundle, fetchImmutableApp, immutableAppSummary,
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
    /** @param {{ identity: import('./transport/mesh.js').Identity, url?: string, audit?: import('./transport/mesh.js').AuditFn,
     *   onMesh?: ((mesh:any)=>()=>void)|null, discoveryEnabled?: ()=>boolean, isBlocked?: (did:string)=>boolean, admitPeer?: ((did:string)=>Promise<boolean>)|null,
     *   admitDwappMeta?: ((candidate: { dwappId: string, publisher: string, seq: number, versionId: string }) => Promise<boolean>) | null }} opts */
    joinBaseNetwork: async ({ identity, url = DEFAULT_SIGNALING[0], audit = null, admitDwappMeta = null, isBlocked = () => false, admitPeer = null, onMesh = null, discoveryEnabled = () => true } = /** @type {any} */ ({})) => {
      // The base host is a local runtime with a separately observable
      // rendezvous state. Do not make identity recovery, unlock, or MV3 startup
      // wait on an external bootstrap node: assemble immediately, then let the
      // room's existing backoff loop establish discovery in the background.
      const room = await joinRoom({
        roomId: BASE_TOPIC, identity, url, audit, awaitInitialRendezvous: false, isBlocked, admitPeer, onMesh,
      });
      // why kind: the lobby presence beacon carries `kind:'extension'` so other
      // members (e.g. an ephemeral peer the peerd.ai landing page joins) can tell
      // a real extension apart from a website visitor in the live network view.
      let base;
      try { base = await createBaseNetwork({
        identity, mesh: room.mesh, meta: () => ({ kind: 'extension' }),
        dial: makeDhtDialer(room), audit, admitDwappMeta, userBlocked: isBlocked, discoveryEnabled,
      }); } catch (error) { room.leave(); throw error; }
      return { base, room, url, close: () => { base.close(); room.leave(); } };
    },
    loadSeedApp,
    seedAppKey: COMMONS_SEED.key,
    defaultSignaling: DEFAULT_SIGNALING,
  });
};
