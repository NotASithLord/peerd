// @ts-check
// peerd-distributed — public surface.
//
// The decentralized web (dweb) between separate peerd instances:
// identity, transport, content addressing, discovery, messaging.
//
// Every import from outside this module goes through this file (ESLint
// no-restricted-imports forbids deep cross-module paths). Within the
// module, files reach for siblings via relative paths.
//
// PHASE 0 (the V1-launch wedge): two peers exchange a signed dwapp bundle
// over WebRTC with manual paste-code pairing — no DHT, no async
// messaging, no discovery. The surface grows per ROADMAP phase. Sub-areas
// not yet built (identity subkeys, DHT, messaging, curation) land in
// later phases.

// --- identity (Ed25519, did:key) ----------------------------------------
export { generateIdentity, createPersistentIdentity, importIdentity, verifySignature } from './identity/keypair.js';
export { encodeDidKey, decodeDidKey } from './identity/did.js';

// --- content addressing (peerd://, signed manifests, chunked bundles) ----
export { parsePeerdUri, formatPeerdUri } from './content/uri.js';
export { buildManifest, verifyManifest, manifestHash } from './content/manifest.js';
export { chunkBytes, sha256hex, CHUNK_SIZE } from './content/chunk.js';
export { packBundle, unpackBundle, unpackBundleText } from './content/bundle.js';
export { createContentStore } from './content/store.js';
export { createContentResponder, fetchBundle } from './content/transfer.js';

// --- transport: connection (locality-blind) -----------------------------
// connect(peer) → uniform Channel, regardless of where the peer is. The
// transports are interchangeable rungs tried cheapest-first; callers never
// branch on locality.
export { createConnector } from './transport/connect.js';
export { createInprocTransport } from './transport/transports/inproc.js';
export { createBroadcastTransport } from './transport/transports/broadcast.js';
export { createWebrtcTransport } from './transport/transports/webrtc.js';

// --- transport: lower-level pieces --------------------------------------
// Signed frames, the authenticated handshake, and the raw WebRTC peer. Most
// callers use connect() above; these are the building blocks transports and
// adapters are made from.
export { signEnvelope, verifyEnvelope, buildEnvelope } from './transport/envelope.js';
export { createSession } from './transport/session.js';
export { createPeer, localDescriptionComplete, DEFAULT_ICE_SERVERS } from './transport/peer.js';

// --- transport: cold-start rendezvous (signaling) -----------------------
// The pure signaling reducer (shared by the browser client and the server
// shells — Bun host, CF Worker) and the client adapter that turns a room
// code into a Channel over the WebRTC transport.
export { signalingStep, initialSignalingState, ROOM_CAP, WEBSITE_CAP } from './transport/signaling.js';
export { connectViaSignaling, openRendezvous, DEFAULT_SIGNALING } from './transport/signaling-client.js';

// --- rooms & the mesh (Phase 1) ------------------------------------------
// joinRoom() is the way into a room (rendezvous + mesh-assisted signaling);
// the mesh is the room's authenticated peer set. ICE diagnostics carry the
// D-5 honesty: path reporting + DirectPathUnavailableError.
export { joinRoom } from './transport/rooms.js';
export { createRoomMesh, CTRL } from './transport/mesh.js';
export { summarizeCandidates, connectionPath, DirectPathUnavailableError } from './transport/ice.js';

// --- gossip: room-scoped topics (Phase 1) ---------------------------------
// The deliberately dumb flooder (opaque payloads, D-7), presence beacons,
// and late-join backfill for retained topics.
export { createGossip } from './gossip/topic.js';
export { createPresence, PRESENCE_TOPIC } from './gossip/presence.js';
export { createTopicSync, createMemoryTopicStore, SYNC } from './gossip/sync.js';

// --- the dwapp surface (Phase 1): app loader + the dwapp bridge -----------
// A dwapp's room is a sub-protocol on the base mesh (base-network.js openRoom);
// the old per-app room host (room-host.js) is gone.
export { installAppBundle, BundleRejectedError } from './apps/loader.js';
export { createDwebBridge } from './apps/bridge.js';
export { loadSeedApp, COMMONS_SEED } from './apps/seed.js';

// --- the core-facing client (shared/dweb-interface.js shape) -------
// The ONLY entry point core code reaches (via shared/dweb-loader.js,
// preview packages only). PHASE lives in client.js next to the client.
export { createDwebClient, PHASE } from './client.js';
