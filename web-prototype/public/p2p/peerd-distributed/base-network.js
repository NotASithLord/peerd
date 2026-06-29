// peerd-distributed/base-network.js — the always-on base network (S2).
//
// ONE peer-node joined to a well-known LOBBY (the base topic). Its job is the
// universal layer: keep a healthy mesh, carry the base announcements, and let
// apps plug in as SUB-PROTOCOLS — namespaced overlays on the SHARED mesh links,
// so many dwapps ride one network instead of each spinning up its own. A "room"
// is just a sub-protocol generalized.
//
// Hosted in the offscreen document in production (so it outlives any tab); the
// mesh is injected, so the SAME logic runs over WebRTC, memoryPair, or the
// simulator. Verbose by design (dlog) — every join/announce/sub-protocol step
// is logged so a real-network bug is visible in the console immediately.

import { createPeerNode } from './peer-node.js';
import { createPresence } from './gossip/presence.js';
import { mutableKey, signProvider } from './dht/records.js';
import { decodeDidKey } from './identity/did.js';
import { buildManifest, manifestHash } from './content/manifest.js';
import { packBundle } from './content/bundle.js';
import { chunkBytes } from './content/chunk.js';
import { swarmFetch } from './content/swarm.js';
import { formatPeerdUri, parsePeerdUri } from './content/uri.js';
import { utf8, toHex } from '/shared/bundle/bytes.js';
import { createLibrary } from './apps/library.js';
import { createDiscovery } from './apps/discovery.js';
import { buildMeta, dwappId, verifyMeta } from './apps/meta.js';
import { dlog } from './log.js';

const sha256hex = async (s) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))));
// The DHT key a content address provides under — H(peerd://…). All providers of
// the same bytes announce under this one key; the k-closest nodes hold the set.
const contentKey = (contentAddr) => sha256hex(String(contentAddr));

export const BASE_TOPIC = 'peerd/base/1';
const T_ON = `${BASE_TOPIC}/on`;          // PEER_ON_DWAPP — "I'm running dwapp X"
const subMsgTopic = (id) => `dwapp/${id}/msg`;            // a sub-protocol's gossip topic

/**
 * @param {{ identity: any, mesh: any, meta?: () => any, dial?: any, audit?: any, now?: () => number }} opts
 */
export const createBaseNetwork = async ({ identity, mesh, meta = () => ({}), dial = null, audit = null, now = Date.now }) => {
  dlog('base', `assembling base network for ${(identity.did || '').slice(-8)} on lobby "${BASE_TOPIC}"`);
  const node = await createPeerNode({ identity, mesh, meta, dial, audit, now });

  // --- discovery: the metadata plane ----------------------------------------
  // Sovereign + event-driven: no node receives a card it didn't subscribe for.
  // The Library is the bounded discovery cache; the discovery plane runs the
  // SUBSCRIBE/SNAPSHOT/stream/UNSUBSCRIBE/ban protocol over the shared mesh. This
  // RETIRES the old gossip-flood DWAPP_ANNOUNCE + the on-connect push-greet: a
  // late joiner now ASKS (default-subscribe on connect) and is answered.
  const blocklist = new Set();
  const isBlocked = (did) => blocklist.has(did);
  const block = (did, reason) => { blocklist.add(did); audit?.('dwapp_publisher_blocked', { did, reason }); };
  const dwappCbs = new Set();
  const library = createLibrary({ isBlocked, now });
  const discovery = createDiscovery({
    mesh: node.mesh, identity, library, isBlocked, block, audit, now,
    onCard: (card) => { dlog('base', `card ingested: ${card.value?.name} (${card.dwapp_id.slice(0, 8)}…)`); for (const cb of dwappCbs) cb(card); },
  });

  // --- sub-protocols: one direct router, many namespaced gossip overlays ----
  const subs = new Map(); // protoId -> { onMsg:Set, onDirect:Set, peers:Map<did,ts> }
  // The lobby's single direct channel carries every sub-protocol's 1:1 traffic,
  // tagged with `proto`; route each frame to the right sub-protocol's handlers.
  node.direct.onMessage(({ from, data }) => {
    const s = data?.proto && subs.get(data.proto);
    if (s) for (const cb of s.onDirect) cb({ from, data: data.payload });
  });
  // PEER_ON_DWAPP keeps each sub-protocol's membership view fresh.
  node.gossip.subscribe(T_ON, ({ from, data }) => {
    const s = data?.dwapp_id && subs.get(data.dwapp_id);
    if (s && from !== identity.did) {
      const isNew = !s.peers.has(from);
      s.peers.set(from, now());
      if (isNew) for (const cb of s.onPeerCbs) cb({ did: from });
    }
  });

  const joinSubProtocol = (id) => {
    dlog('base', `dwapp "${id}" joining as a sub-protocol`);
    let s = subs.get(id);
    if (!s) { s = { onMsg: new Set(), onDirect: new Set(), onPeerCbs: new Set(), peers: new Map() }; subs.set(id, s); }
    const offGossip = node.gossip.subscribe(subMsgTopic(id), ({ from, data }) => {
      if (from !== identity.did) for (const cb of s.onMsg) cb({ from, data });
    });
    const announceOn = () => node.gossip.publish(T_ON, { dwapp_id: id }).catch(() => {});
    announceOn(); // tell the room I'm on this dwapp now
    return Object.freeze({
      id,
      self: identity.did,
      peers: () => [...s.peers.keys()],
      broadcast: (data) => node.gossip.publish(subMsgTopic(id), data),
      send: (toDid, payload) => node.direct.send(toDid, { proto: id, payload }),
      onMessage: (cb) => { s.onMsg.add(cb); return () => s.onMsg.delete(cb); },
      onDirect: (cb) => { s.onDirect.add(cb); return () => s.onDirect.delete(cb); },
      onPeer: (cb) => { s.onPeerCbs.add(cb); return () => s.onPeerCbs.delete(cb); },
      leave: () => { offGossip(); subs.delete(id); },
    });
  };

  // --- content helpers (shared by the base handle AND every room) -----------
  // why locals: a room serves/fetches app bundles over the SAME shared mesh, so
  // it reuses these exactly — no second content store, no second transport.
  // Announce that WE serve the bytes at `contentAddr` (Plane 2 provider set):
  // sign a provider record + ADD_PROVIDER to the k-closest DHT nodes. Idempotent
  // (re-PUT refreshes the TTL — self-healing). Best-effort: a cold DHT just stores
  // locally, which is enough for a linked peer to find us via the mesh fallback.
  const announceProvider = async (contentAddr) => {
    const key = await contentKey(contentAddr);
    const entry = await signProvider({ key, ts: now() }, identity);
    try { return await node.dht.announceProvider(key, entry); }
    catch (e) { dlog('base', `announceProvider ${key.slice(0, 8)}… failed: ${e?.message ?? e}`); return { key, stored: 0 }; }
  };
  const findProviders = async (contentAddr) => {
    const key = await contentKey(contentAddr);
    try { return await node.dht.findProviders(key); }
    catch { return []; }
  };

  const publishApp = async ({ name, entry, files }) => {
    const bytes = {};
    for (const [path, text] of Object.entries(files)) bytes[path] = utf8(text);
    const payload = packBundle({ entry, files: bytes });
    const { manifest, hash, chunks } = await buildManifest({ payload, type: 'app', entry, identity });
    node.content.publish({ manifest, hash, chunks });
    const uri = formatPeerdUri({ did: identity.did, hash });
    // why NOT awaited: we already serve the bytes (content.publish), so the DHT
    // provider record is pure durability for cold lookups. With the per-hop dialer
    // unwired, that lookup can stall on unreachable contacts — awaiting it made
    // share take MINUTES and delayed the discovery announce behind it. Background.
    announceProvider(uri).catch(() => {}); // the publisher is the first provider
    dlog('base', `published app "${name}" → ${uri}`);
    return { uri, hash };
  };

  // Re-seed bytes we fetched so WE become a provider too (install → seeder). The
  // payload re-chunks deterministically into the SAME hashes the original signed
  // manifest commits to, so we serve the publisher's bundle unchanged (no
  // re-attribution). Then announce ourselves as a provider.
  const seedApp = async ({ manifest, payload }) => {
    const hash = await manifestHash(manifest);
    const chunks = chunkBytes(payload);
    node.content.publish({ manifest, hash, chunks });
    announceProvider(formatPeerdUri({ did: manifest.publisher ?? identity.did, hash })).catch(() => {}); // background durability
    return hash;
  };

  // Un-share / un-seed an app. STOP being a provider for its bytes (unannounce
  // from the content store → the liability firewall now REFUSES every chunk we
  // used to serve, so no peer can pull it from us anymore) and drop OUR card for
  // it from the discovery Library (it vanishes from our own Discover; other peers'
  // caches age it out once nobody seeds it — popularity = availability, there is
  // no flooded retraction to send). Resolves the dwapp_id from (publisher, slug):
  // for an app WE published, publisher is us and the bundle hash lives on our own
  // card's head; an INSTALLED app passes its hash explicitly (its card is the
  // ORIGINAL publisher's, so we can't author a fresh version). Best-effort +
  // idempotent: an app we never shared unshares to a clean no-op.
  /** @param {{ slug?: string | null, publisher?: string, hash?: string | null }} [opts] */
  const unshareApp = async ({ slug = null, publisher = identity.did, hash = null } = {}) => {
    const id = slug ? await dwappId(publisher, slug) : null;
    // Prefer the caller's hash (installed apps carry it on their record); else read
    // it off our own card (a self-published app — version_id IS the bundle hash).
    let h = hash;
    if (!h && id) { const card = library.get(id); h = card?.value?.head?.version_id ?? null; }
    const unserved = h ? node.content.unannounce(h) : false;
    // tombstone (not a bare remove): also blocks a peer's cached copy from
    // re-infecting our Library on the next snapshot. Lifted if we re-share.
    if (id) discovery.tombstone(id);
    dlog('base', `unshare ${id ? `${id.slice(0, 8)}…` : '?'} — unserved:${unserved} tombstoned:${!!id}`);
    return { unserved, removed: !!id, dwapp_id: id, hash: h };
  };

  // Fetch a bundle. The uri NAMES its publisher (peerd://<publisher>/<hash>), who
  // is the canonical server — so try THEM ALONE first. why: swarming across every
  // linked peer made a simple install crawl — in a roomful of base-network peers,
  // the manifest/chunk requests detour through neighbours that don't have the
  // bundle (or are slow to answer) before reaching the publisher. The direct path
  // (you're linked to the author) is then one fast round-trip. Only if the
  // publisher can't serve do we widen to other linked seeders, then the bounded DHT.
  const fetchApp = async (uri, { timeoutMs = 15_000, onProgress } = {}) => {
    const channelFor = (did) => node.mesh.contentChannel(did);
    let publisher = null;
    try { ({ did: publisher } = parsePeerdUri(uri)); } catch { /* malformed uri → skip the fast path */ }
    const linked = node.mesh.peers().map((p) => p.did);

    // 1. Fast path: the named publisher, if we're linked to them.
    if (publisher && channelFor(publisher)) {
      try { return await swarmFetch({ uri, providers: [publisher], channelFor, timeoutMs, onProgress }); }
      catch (e) { dlog('base', `publisher fetch failed (${e?.message ?? e}); widening to other seeders`); }
    }
    // 2. Other linked seeders (parallel swarm).
    const others = linked.filter((d) => d !== publisher);
    if (others.length) {
      try { return await swarmFetch({ uri, providers: others, channelFor, timeoutMs, onProgress }); }
      catch (e) { dlog('base', `seeder fetch failed (${e?.message ?? e}); trying DHT providers (bounded)`); }
    }
    // 3. Bounded DHT provider lookup: with the per-hop dialer unwired it can't reach
    // unlinked providers anyway, and an unbounded walk would STALL — cap it so a
    // genuine "nobody is serving this" fails FAST and the user can retry.
    let dhtTimer;
    const provided = await Promise.race([
      findProviders(uri).catch(() => []),
      new Promise((res) => { dhtTimer = setTimeout(() => res([]), 5_000); }),
    ]);
    clearTimeout(dhtTimer);
    const providers = [...new Set([...provided, ...linked])];
    if (!providers.length) throw new Error(`no peer is serving ${uri} right now — the peer may have dropped; try again`);
    return swarmFetch({ uri, providers, channelFor, timeoutMs, onProgress });
  };

  // --- a ROOM: the full feed / presence / dm / content surface a dwapp expects,
  // composed over the SHARED base mesh by NAMESPACING every topic to dwapp/<id>/.
  // This is room-host.js's composition WITHOUT a second rendezvous + mesh: the
  // base network already supplies connectivity, so "join a room" is just "open a
  // namespaced overlay" (a room is a sub-protocol generalized).
  // Many rooms ride one mesh; a dwapp is a sub-protocol id, never tied to a signaler.
  const openRoom = (roomId, { meta: roomMeta = () => ({}) } = {}) => {
    const id = String(roomId);
    const ns = (topic) => `dwapp/${id}/${topic}`;
    const sub = joinSubProtocol(id);   // proto-tagged direct router + T_ON membership announce
    // Per-room presence on a namespaced topic: who's in THIS room, with names
    // (the lobby's global presence is a different, broader set). The anti-flap
    // suppression in presence.js applies here too.
    const presence = createPresence({ gossip: node.gossip, selfDid: identity.did, meta: roomMeta, topic: ns('~presence') });
    presence.start();                  // beacon our membership (carries the display name)
    dlog('base', `room "${id}" opened over the base mesh (namespaced overlay)`);
    return Object.freeze({
      did: identity.did,
      roomId: id,
      // room membership, with display names + onJoin/onLeave — the only liveness
      // a room needs (the shared mesh's own link events aren't room-scoped).
      presence,
      // multi-topic feed over the shared gossip, namespaced to this room
      gossip: {
        publish: (topic, data) => node.gossip.publish(ns(topic), data),
        subscribe: (topic, cb) => node.gossip.subscribe(ns(topic), cb),
        mute: (did) => node.gossip.mute(did),
      },
      // retained-topic backfill (late-join history), namespaced
      sync: {
        retain: (topic) => node.sync.retain(ns(topic)),
        publish: (topic, data) => node.sync.publish(ns(topic), data),
        history: (topic) => node.sync.history(ns(topic)),
      },
      // 1:1 direct, proto-tagged so a message never crosses into another room
      direct: { send: sub.send, onMessage: sub.onDirect },
      status: () => ({ joined: id, did: identity.did, present: presence.list().length }),
      leave: () => { presence.close(); sub.leave(); dlog('base', `room "${id}" left`); },
    });
  };

  return Object.freeze({
    did: identity.did,
    node,
    mesh,
    presence: node.presence, // global presence (the lobby's "who's here")
    dht: node.dht,
    peers: () => node.mesh.peers().map((p) => ({ did: p.did, info: p.info })),

    // The discovery plane handle (subscribe/ban/setEnabled) + the Library.
    discovery,
    // Build + publish one of OUR apps' metadata card (the metadata plane). Floods
    // to our subscribers via discovery AND drops a durable DHT copy keyed by our
    // (publisher, slug) — so a peer that knows the publisher can resolve it cold
    // (the DHT durability layer the RFC keeps; the content-keyed mirror is the
    // deferred scaling step). Returns { dwapp_id, card }.
    async publishMeta({ slug, name, description = '', seq = now(), head, icon = null }) {
      const card = await buildMeta({ slug, name, description, seq, head, icon }, identity);
      // discovery.announce forwards the card to our SUBSCRIBERS — this is what makes
      // peers SEE it, and it's fast (point-to-point sends). The DHT put is the
      // durable cold-lookup copy; awaiting it (with the dialer unwired) is what made
      // share take minutes AND delayed this announce. Background, best-effort.
      const { dwapp_id } = await discovery.announce(card);
      dlog('base', `published dwapp meta "${name}" → ${dwapp_id.slice(0, 12)}…`);
      node.dht.put(card) // card IS a signed DHT item (records.js shape)
        .then(({ stored }) => dlog('base', `DHT put ${dwapp_id.slice(0, 8)}…: stored to ${stored} peer(s)`))
        .catch((e) => dlog('base', `DHT put for ${dwapp_id.slice(0, 8)}… failed: ${e?.message ?? e}`));
      return { dwapp_id, card };
    },
    onDwappAnnounce: (cb) => { dwappCbs.add(cb); return () => dwappCbs.delete(cb); },
    // The discovery view the Library UI lists — the bounded, no-downgrade cache.
    heardDwapps: () => library.rows(),
    // Resolve a card by id: the Library first (already subscribed), else the DHT
    // by (publisher, slug) — the durable late-join path that survives a card we
    // never had streamed to us. A DHT hit is verified + cached into the Library.
    async findDwapp(id, publisherDid = '', slug = '') {
      const local = library.get(id);
      if (local) return local;
      if (publisherDid && slug) {
        try {
          const hit = await node.dht.get(await mutableKey(decodeDidKey(publisherDid), slug));
          if (hit?.value && await verifyMeta(hit)) {
            const derived = await dwappId(hit.publisher, hit.salt);
            if (derived === id) { library.put(id, hit); return hit; }
          }
        } catch { /* not found */ }
      }
      return null;
    },
    // Ban a publisher/peer: drop their feed, blocklist, purge, cut the link.
    ban: (did, reason) => discovery.ban(did, reason),
    // Lift a ban: un-blocklist and re-subscribe so their cards can flow again.
    unblock: (did) => { blocklist.delete(did); discovery.subscribeTo(did).catch(() => {}); audit?.('dwapp_publisher_unblocked', { did }); },
    isBlocked,
    // The sovereign discovery switch + a read of the discovery state (for the
    // agent's dweb_peers tool and the Network view).
    setDiscovery: (on) => discovery.setEnabled(on),
    discoveryState: () => ({ enabled: discovery.enabled(), subscribers: discovery.subscriberCount(), library: library.size(), blocked: [...blocklist] }),

    // --- app store: publish a dwapp's files as a signed bundle the base mesh
    // serves, and fetch one from whoever's serving it. SAME content modules as a
    // room — the base mesh already serves content (createPeerNode does
    // mesh.serveContent), so this just rides ch=2 over the always-on lobby.
    publishApp,
    fetchApp,
    // Stop sharing/seeding a deleted app: unannounce its bytes + drop our card.
    unshareApp,
    // Plane 2: the content provider set + "install → seeder" re-seed.
    announceProvider,
    findProviders,
    seedApp,

    joinSubProtocol,
    // A room is a sub-protocol with the full dwapp surface (feed/presence/dm/
    // content) — the connectivity comes from the base mesh, no signaler needed.
    openRoom,

    // A read-only snapshot of the live mesh for a status/visualization surface
    // (the home-page Network view). The UNION of two honest layers:
    //   - mesh links  = peers we hold a direct authenticated channel to, each
    //     carrying its real ICE path (direct-ipv6 / direct-ipv4-srflx / relay).
    //   - gossip presence = peers we've HEARD (a beacon) but may not link to;
    //     these carry the display name (meta.name) and may be link-less.
    // `linked` distinguishes them so the UI can draw a solid edge (direct) vs a
    // faint one (heard-via-gossip). Side-effect-free; tolerant of a cold node.
    snapshot: () => {
      const links = node.mesh.peers();              // [{ did, lastSeen, info, channel }]
      const linkByDid = new Map(links.map((l) => [l.did, l]));
      const present = node.presence.list().filter((p) => p.did !== identity.did);
      const nameByDid = new Map(present.map((p) => [p.did, p.meta?.name ?? null]));
      const seenByDid = new Map(present.map((p) => [p.did, p.lastSeen ?? null]));
      const dids = new Set([...linkByDid.keys(), ...nameByDid.keys()]);
      const peers = [...dids].map((did) => {
        const l = linkByDid.get(did);
        return {
          did,
          name: nameByDid.get(did) ?? null,
          linked: !!l,
          path: l?.info?.path ?? null,                // null until ICE stats settle / link-less
          via: l?.info?.via ?? null,                  // who introduced us: 'rendezvous' | a peer did
          lastSeen: l?.lastSeen ?? seenByDid.get(did) ?? null,
        };
      });
      return {
        lobby: BASE_TOPIC,
        peers,
        peerCount: peers.length,
        linkedCount: links.length,
        presentCount: present.length,
        dhtSize: node.dht?.routingTable?.size?.() ?? 0,
      };
    },

    start: () => {
      dlog('base', 'base network ONLINE (presence + liveness started)');
      node.start();
      node.presence.announce();
      // Reconcile against peers we're ALREADY linked to: the base mesh is usually
      // up long before discovery starts, and onPeer only covers FUTURE links — so
      // subscribe to current peers too, or a late starter's Library stays empty.
      discovery.subscribeAll();
    },
    close: () => { dlog('base', 'base network closing'); discovery.close(); node.close(); },
  });
};
