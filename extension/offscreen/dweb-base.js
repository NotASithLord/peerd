// @ts-check
// offscreen/dweb-base.js — the always-on base network, hosted offscreen (S1b).
//
// The lobby connection (mesh, gossip, DHT, presence) lives HERE, in the
// offscreen document, not in a tab — so the network outlives any single tab,
// which is the whole point of S1 (GLOBAL-NETWORK.md). The SW forwards
// `dweb/base-host/*` messages here (after ensureOffscreen); we answer.
//
// VERBOSE by design: every step logs with an [offscreen/dweb] tag so a
// real-network bug is visible in the offscreen DevTools immediately. This path
// can't run under bun (WebRTC + the offscreen lifecycle), so logging IS the
// verification surface — per the owner's "be verbose with errors".
//
// Store-build safety: gated on DWEB_ENABLED (false there) and reaches the dweb
// module only via loadDweb() (the stub there) — this file names no dweb module
// path, so the boundary check + store artifact verifier stay clean (the verifier
// greps the SHIPPED bytes for that path; even a mention in a comment trips it).
// Inert on store.

import browser from '/vendor/browser-polyfill.js';
import { DWEB_ENABLED } from '/shared/channel-config.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { makeStartStopBarrier } from '/offscreen/start-stop-barrier.js';

/** @param {...any} a */
const log = (...a) => console.log('[offscreen/dweb]', ...a);
/** @param {...any} a */
const warn = (...a) => console.warn('[offscreen/dweb]', ...a);

// why any: the LIVE (preview-channel) dweb module exposes a much richer surface
// than the stub DwebClient interface in shared/dweb-interface.js (joinBaseNetwork,
// BASE_TOPIC, base.snapshot/mesh/discovery, …). Core code never sees these — only
// this offscreen host does — so the handle/client are typed any at this boundary
// rather than widening the shared stub (the dweb boundary stays intact).
/** @type {any} */
let handle = null;    // { base, room, close } once the lobby is joined
/** @type {ReturnType<typeof setInterval> | null} */
let resubTimer = null; // periodic re-subscribe — self-heals a missed onPeer SUB

// A publisher-chosen, stable app slug from the app name (the dwapp_id is
// H(publisher‖slug), so the slug only needs to be stable + ≤64 chars).
/** @param {unknown} name */
const slugify = (name) => (String(name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'app');
// A Library row (or a resolved card) → the Discover list shape the tools expect.
// Carries the VERSION identity (version_id + seq + slug) so the UI can tell a
// freshly-announced update from the copy already installed (same dwapp_id, newer
// version_id at a higher seq → "update available").
/** @param {any} row */
const toDiscoverApp = (row) => ({
  dwapp_id: row.dwapp_id,
  slug: row.slug ?? null,
  name: row.name,
  uri: row.head?.content_addr ?? null,
  version_id: row.head?.version_id ?? null,
  seq: row.seq ?? 0,
  publisher: row.publisher ?? null,
});

// dwapp ROOMS hosted here — each is base.openRoom(id) ONCE, ref-counted across
// the app-tabs that join it. The room's connectivity IS the base mesh (no second
// rendezvous): a dwapp is a sub-protocol, not tied to a signaler.
/** @type {Map<string, { room: any, refs: number, name: string, topicSubs: Map<string, () => void>, offs: (() => void)[] }>} */
const rooms = new Map();        // roomId -> { room, refs, name, topicSubs:Map, offs:[] }

/** @param {string} type @param {object} [payload] @returns {Promise<any>} */
const swCall = (type, payload = {}) => browser.runtime.sendMessage({ type, ...payload });

// The permanent identity seed and backup passphrase never ride swCall. This
// dedicated channel is accepted only after the service worker verifies the
// browser-owned offscreen sender metadata.
const CUSTODY_PORT_NAME = 'dweb-custody';
const CUSTODY_RECONNECT_MS = 500;
const CUSTODY_TIMEOUT_MS = 60_000;
/** @type {import('webextension-polyfill').Runtime.Port | null} */
let custodyPort = null;
/** @type {Set<{ resolve: (port: import('webextension-polyfill').Runtime.Port) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> }>} */
const custodyWaiters = new Set();
/** @type {Map<string, { resolve: (value: any) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> }>} */
const custodySecretPending = new Map();

const rejectCustodySecretPending = () => {
  for (const entry of custodySecretPending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('identity custody port disconnected'));
  }
  custodySecretPending.clear();
};

const waitForCustodyPort = async () => {
  if (custodyPort) return custodyPort;
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        custodyWaiters.delete(waiter);
        reject(new Error('identity custody port timed out'));
      }, CUSTODY_TIMEOUT_MS),
    };
    custodyWaiters.add(waiter);
  });
};

/** @param {'get'|'set'} operation @param {any} [args] */
const callIdentitySecret = async (operation, args = {}) => {
  const port = await waitForCustodyPort();
  if (custodyPort !== port) throw new Error('identity custody port disconnected');
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      custodySecretPending.delete(requestId);
      reject(new Error(`identity custody ${operation} timed out`));
    }, CUSTODY_TIMEOUT_MS);
    custodySecretPending.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({
        type: 'custody/secret-request', requestId, operation, args,
      });
    } catch (cause) {
      custodySecretPending.delete(requestId);
      clearTimeout(timer);
      reject(cause);
    }
  });
};

// peerd notifications: emit a runtime 'dweb/notify' for genuinely-NEW peers and
// apps so the UI surfaces them (the bell + an in-chat banner), each linking to
// the Network / Discover view. Deduped; the initial sync burst (peers/apps that
// were already there when we joined) is recorded-but-suppressed via a short
// arming delay, so the user only gets pinged about things that arrive live.
let notifyArmed = false;
const seenPeers = new Set();
const seenApps = new Set();
/** @param {{ kind: string, key: string, title: string, body: string, link: string }} n */
const emitNotify = (n) => browser.runtime.sendMessage({
  type: 'dweb/notify',
  notification: { id: `${n.kind}-${n.key}-${Date.now().toString(36)}`, ts: Date.now(), ...n },
}).catch(() => {});
/** @param {any} h */
const startNotifications = (h) => {
  setTimeout(() => { notifyArmed = true; }, 8000);
  h.base.onDwappAnnounce((/** @type {any} */ card) => {
    if (!card?.dwapp_id || card.publisher === h.base.did || seenApps.has(card.dwapp_id)) return;
    seenApps.add(card.dwapp_id);
    if (notifyArmed) emitNotify({ kind: 'app', key: card.dwapp_id, title: 'New app to install', body: card.value?.name || 'an app', link: 'discover' });
  });
  h.base.mesh?.onPeer?.((/** @type {{ did: string }} */ { did }) => {
    if (!did || seenPeers.has(did)) return;
    seenPeers.add(did);
    if (!notifyArmed) return;
    let name = null;
    try { name = h.base.snapshot().peers.find((/** @type {any} */ p) => p.did === did)?.name ?? null; } catch { /* best-effort name */ }
    emitNotify({ kind: 'peer', key: did, title: 'New peer connected', body: name || `peer …${did.slice(-8)}`, link: 'network' });
  });
};

// Join the lobby once. Identity comes from the vault via the SW (the offscreen
// doc has no vault access) — so this only succeeds once the vault is unlocked.
// The barrier makes stop a real lifecycle fence even while this async setup is
// between reading the old identity and publishing its eventual handle.
const baseLifecycle = makeStartStopBarrier({
  getActive: () => handle,
  create: async () => {
    log('starting base network…');
    // why any: the live dweb module's surface exceeds the stub interface (see top).
    const client = /** @type {any} */ (await loadDweb());
    if (!client.available || !client.joinBaseNetwork) { warn('dweb module unavailable here — inert'); return null; }
    let identity;
    try {
      const material = await client.identityMaterial({
        getSecret: async () => {
          const r = await callIdentitySecret('get');
          if (!r?.ok) throw new Error(r?.error === 'vault-locked' ? 'vault is locked — unlock peerd first' : (r?.error ?? 'identity unavailable'));
          return r.value;
        },
        setSecret: async (/** @type {string} */ _n, /** @type {string} */ value) => {
          const r = await callIdentitySecret('set', { value });
          if (!r?.ok) throw new Error(r?.error ?? 'identity store failed');
        },
      });
      identity = await client.identityFromMaterial(material);
    } catch (e) {
      warn('identity step failed:', /** @type {{ message?: string }} */ (e)?.message ?? e);
      throw e;
    }
    log(`joining lobby "${client.BASE_TOPIC}" as …${identity.did.slice(-8)}`);
    return client.joinBaseNetwork({ identity });
  },
  activate: (candidate) => {
    candidate.base.start();
    handle = candidate;
    startNotifications(candidate);
    // Late joiners discover through the sovereign subscription plane.
    candidate.base.onDwappAnnounce((/** @type {any} */ a) => log('discovery card:', a?.dwapp_id?.slice(0, 12), `from …${String(a?.publisher).slice(-8)}`));
    // Self-heal discovery if the initial subscription races WebRTC readiness.
    if (!resubTimer) {
      resubTimer = setInterval(() => { try { handle?.base?.discovery?.subscribeAll(); } catch { /* best-effort */ } }, 12_000);
    }
    log('✅ base network ONLINE — lobby joined, presence beaconing');
  },
  close: (candidate) => {
    candidate.close();
    if (handle !== candidate) return;
    // Once close succeeds the identity is no longer live. Listener cleanup is
    // best-effort so a stale unsubscribe cannot turn a successful stop into a
    // false failure that blocks identity recovery.
    for (const entry of rooms.values()) {
      for (const off of entry.offs) { try { off(); } catch { /* already closed */ } }
      for (const off of entry.topicSubs.values()) { try { off(); } catch { /* already closed */ } }
    }
    rooms.clear();
    if (resubTimer) { clearInterval(resubTimer); resubTimer = null; }
    handle = null;
    log('base network stopped');
  },
});

const start = () => baseLifecycle.start();

/** @param {'export'|'adopt'|'suspend'|'resume'|'reset'} operation @param {any} args */
const runCustodyOperation = async (operation, args) => {
  if (operation === 'suspend') {
    if (typeof args?.leaseId !== 'string' || args.leaseId.length === 0) {
      throw new Error('lease-required');
    }
    await baseLifecycle.stop({ suspensionOwner: args.leaseId });
    return { suspended: true };
  }
  if (operation === 'resume') {
    if (typeof args?.leaseId !== 'string' || args.leaseId.length === 0) {
      throw new Error('lease-required');
    }
    return { resumed: baseLifecycle.resume(args.leaseId) };
  }
  if (operation === 'reset') {
    baseLifecycle.resetSuspension();
    return { reset: true };
  }
  const client = await loadDweb();
  if (operation === 'export') {
    if (!client.identityRecordExport) throw new Error('portable identity export is unsupported');
    return client.identityRecordExport(args);
  }
  if (operation === 'adopt') {
    if (!client.identityRecordAdopt) throw new Error('portable identity restore is unsupported');
    return client.identityRecordAdopt(args);
  }
  throw new Error('unknown identity custody operation');
};

const connectCustodyPort = () => {
  if (!DWEB_ENABLED) return;
  try {
    const port = browser.runtime.connect({ name: CUSTODY_PORT_NAME });
    custodyPort = port;
    for (const waiter of custodyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(port);
    }
    custodyWaiters.clear();
    /** @param {any} response */
    const respond = (response) => {
      try { port.postMessage(response); } catch { /* disconnect rejects the SW-side request */ }
    };
    port.onMessage.addListener((/** @type {any} */ message) => {
      if (message?.type === 'custody/secret-response'
          && typeof message.requestId === 'string') {
        const entry = custodySecretPending.get(message.requestId);
        if (!entry) return;
        custodySecretPending.delete(message.requestId);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error ?? 'identity secret operation failed'));
        return;
      }
      if (message?.type !== 'custody/request'
          || typeof message.requestId !== 'string'
          || !['export', 'adopt', 'suspend', 'resume', 'reset'].includes(message.operation)) return;
      Promise.resolve(runCustodyOperation(message.operation, message.args ?? {}))
        .then((result) => respond({
          type: 'custody/response', requestId: message.requestId, ok: true, result,
        }))
        .catch((cause) => respond({
          type: 'custody/response', requestId: message.requestId, ok: false,
          error: /** @type {{ code?: string, message?: string }} */ (cause)?.code
            ?? /** @type {{ message?: string }} */ (cause)?.message ?? 'host-failed',
        }));
    });
    port.onDisconnect.addListener(() => {
      if (custodyPort === port) {
        custodyPort = null;
        rejectCustodySecretPending();
      }
      setTimeout(connectCustodyPort, CUSTODY_RECONNECT_MS);
    });
  } catch {
    setTimeout(connectCustodyPort, CUSTODY_RECONNECT_MS);
  }
};
connectCustodyPort();

const status = () => (handle
  ? { running: true, did: handle.base.did, peers: handle.base.peers().length, present: handle.base.presence.list().length }
  : { running: false });

// The read surface behind peerd.distributed.* AND the home-page Network view.
// A DISTINCT shape from status() above (ops/debug counts): it carries the live
// rosters with per-peer ICE path + the rendezvous state, for visualization.
// Side-effect-free: it reports the CURRENT state and never starts the lobby
// (reading status must not join a network — maybeStartBaseNetwork on unlock
// does that). Tolerates a cold node: every field has a running:false default.
const info = () => {
  if (!handle) return { running: false, did: null, rendezvous: 'none', bootstrapUrl: null, lobby: null, peers: [], peerCount: 0, linkedCount: 0, presentCount: 0, dhtSize: 0 };
  const snap = handle.base.snapshot();
  return { running: true, did: handle.base.did, rendezvous: handle.room?.rendezvous?.() ?? 'none', bootstrapUrl: handle.url ?? null, ...snap };
};

// --- dwapp room hosting (sub-protocols on the shared base mesh) ---------------
// Events (feed message / direct / presence / status) are PUSHED to the dwapp's
// app-tab as a `dweb/base-room/event` runtime message it filters by roomId. Every
// extension context receives a runtime.sendMessage, so the app-tab gets it
// directly — no SW forwarding bus. (The SW + offscreen ignore it: wrong prefix.)
/** @param {string} roomId @param {string} event @param {any} data */
const pushRoomEvent = (roomId, event, data) =>
  browser.runtime.sendMessage({ type: 'dweb/base-room/event', roomId, event, data }).catch(() => {});

/** @param {string} roomId @param {string} [name] */
const ensureRoom = async (roomId, name) => {
  const h = await start();
  let entry = rooms.get(roomId);
  if (!entry) {
    /** @type {{ room: any, refs: number, name: string, topicSubs: Map<string, () => void>, offs: (() => void)[] }} */
    const e = { room: null, refs: 0, name: name ?? '', topicSubs: new Map(), offs: [] };
    entry = e;
    const room = h.base.openRoom(roomId, { meta: () => ({ name: e.name }) }); // meta reads the latest name
    entry.room = room;
    rooms.set(roomId, entry);
    // presence-join/leave carry did + names and are the room's only liveness;
    // direct delivers 1:1 messages. (No separate peer/status pushes — they all
    // derived from this same presence event.)
    entry.offs.push(room.presence.onJoin((/** @type {any} */ j) => pushRoomEvent(roomId, 'presence-join', j)));
    entry.offs.push(room.presence.onLeave((/** @type {any} */ l) => pushRoomEvent(roomId, 'presence-leave', l)));
    entry.offs.push(room.direct.onMessage((/** @type {any} */ { from, data, ts, id }) => pushRoomEvent(roomId, 'direct', { from, data, ts, id })));
    log(`room "${roomId}" opened on the base mesh`);
  }
  if (name) entry.name = name;     // latest joiner's name wins (one identity per browser)
  entry.refs += 1;
  return entry;
};

/** @param {{ refs: number, room: any, offs: (() => void)[], topicSubs: Map<string, () => void> }} entry @param {string} roomId */
const closeRoom = (entry, roomId) => {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  for (const off of entry.offs) off();
  for (const off of entry.topicSubs.values()) off();
  entry.room.leave();
  rooms.delete(roomId);
  log(`room "${roomId}" closed (no app-tabs left)`);
};

// One relayed op from the dwapp bridge (app-tab -> SW -> here). Returns the reply.
/** @param {any} msg */
const handleRoomOp = async (msg) => {
  const { op, roomId } = msg;
  if (op === 'join') {
    const entry = await ensureRoom(roomId, msg.name);
    return { ok: true, did: entry.room.did, joined: roomId, ...entry.room.status() };
  }
  // Content ops don't need a joined room (an app shares/installs another app).
  // fetch-app returns just the publisher for the consent dialog; install re-fetches
  // (the fetch is idempotent + install is rare/user-gated — no cache to leak on a
  // declined install).
  if (op === 'fetch-app') {
    const h = await start();
    const { manifest } = await h.base.fetchApp(msg.uri);
    return { ok: true, publisher: manifest?.publisher ?? null };
  }
  if (op === 'install-app') {
    const h = await start();
    const { manifest, payload } = await h.base.fetchApp(msg.uri);
    const client = /** @type {any} */ (await loadDweb());
    const app = await client.installAppBundle({
      uri: msg.uri, manifest, payload, name: msg.name,
      install: async (/** @type {any} */ a) => { const r = await swCall('dweb/app-install', a); if (!r?.ok) throw new Error(r?.error ?? 'install failed'); return r.app; },
    });
    h.base.seedApp({ manifest, payload }).catch(() => {}); // install → we seed it (background; don't block the install)
    return { ok: true, appId: app?.id, name: app?.name };
  }
  const entry = rooms.get(roomId);
  if (!entry) return { ok: false, error: 'not-in-room' };
  const { room } = entry;
  switch (op) {
    case 'leave': closeRoom(entry, roomId); return { ok: true, left: true };
    case 'status': return { ok: true, ...room.status() };
    case 'presence': return { ok: true, present: room.presence.list() };
    case 'announce': { if (typeof msg.name === 'string') entry.name = msg.name.slice(0, 40); await room.presence.announce(); return { ok: true }; }
    case 'publish': { const env = msg.retain ? await room.sync.publish(msg.topic, msg.data) : await room.gossip.publish(msg.topic, msg.data); return { ok: true, id: env.id, ts: env.ts }; }
    case 'subscribe': {
      if (!entry.topicSubs.has(msg.topic)) {
        entry.topicSubs.set(msg.topic, room.gossip.subscribe(msg.topic,
          (/** @type {any} */ { from, data, ts, id }) => pushRoomEvent(roomId, 'message', { topic: msg.topic, from, data, ts, id })));
      }
      return { ok: true };
    }
    case 'retain': room.sync.retain(msg.topic); return { ok: true };
    case 'history': return {
      ok: true,
      items: room.sync.history(msg.topic).map((/** @type {any} */ env) => ({ topic: msg.topic, from: env.from, data: env.body.data, ts: env.ts, id: env.id })),
    };
    case 'dm': { const { id, ts } = await room.direct.send(msg.to, msg.data); return { ok: true, id, ts }; }
    // A2A Agent Card advertise/fetch over a retained '~card' topic: card-set
    // publishes MY signed card (retained so late joiners backfill), card-get
    // reads a peer's latest card from the retained history by its did.
    case 'card-set': {
      // Validate + clamp MY card before it hits the mesh: strips arbitrary extra
      // fields and REJECTS an oversized one (the agent-card caps — MAX_CARD_BYTES
      // etc.), so a retained '~card' envelope we emit can't amplify to late-joiners.
      const client = /** @type {any} */ (await loadDweb());
      let clean;
      try { clean = client.validateCard(msg.card).card; }
      catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'agent card rejected' }; }
      const card = { ...clean, did: room.did };
      room.sync.retain('~card');
      const env = await room.sync.publish('~card', card);
      return { ok: true, did: room.did, id: env.id };
    }
    case 'card-get': {
      room.sync.retain('~card');
      // why max-by-ts, not last-inserted: the retained store is a Map keyed by
      // sig, so history() yields SIG-INSERTION order — a late-join backfill can
      // append an OLDER card version after the newer one was seen live. Pick the
      // newest by envelope ts so a re-advertised card always supersedes.
      const mine = room.sync.history('~card').filter((/** @type {any} */ e) => e.from === msg.did);
      const latest = mine.reduce((/** @type {any} */ best, /** @type {any} */ e) => (!best || (e.ts ?? 0) >= (best.ts ?? 0) ? e : best), null);
      // Clamp the UNTRUSTED peer card (parsePeerCard: coerce + cap, null if it
      // blows the ceiling) before it reaches the actor's a2a_run worker — the caps
      // exist precisely to bound a malicious multi-MB / unbounded-fields card.
      const client = /** @type {any} */ (await loadDweb());
      return { ok: true, card: latest ? client.parsePeerCard(latest.body.data) : null };
    }
    case 'mute': room.gossip.mute(msg.did); return { ok: true };
    case 'publish-app': { const h = await start(); const { uri, hash } = await h.base.publishApp({ name: msg.name, entry: msg.entry, files: msg.files }); return { ok: true, uri, hash }; }
    default: return { ok: false, error: `unknown room op: ${op}` };
  }
};

/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} _sender
 * @param {(response: any) => void} sendResponse
 */
const onBaseHostMessage = (msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith?.('dweb/base-host/')) return undefined;
  if (!DWEB_ENABLED) { sendResponse({ ok: false, error: 'dweb-disabled' }); return true; }
  (async () => {
    try {
      switch (msg.type) {
        case 'dweb/base-host/start': { await start(); sendResponse({ ok: true, ...status() }); return; }
        case 'dweb/base-host/status': { sendResponse({ ok: true, ...status() }); return; }
        case 'dweb/base-host/info': { sendResponse({ ok: true, ...info() }); return; }
        case 'dweb/base-host/find': {
          const h = await start();
          const card = await h.base.findDwapp(msg.dwappId, msg.publisherDid, msg.slug);
          sendResponse({ ok: true, record: card ? toDiscoverApp({ dwapp_id: msg.dwappId, publisher: card.publisher, ...card.value }) : null });
          return;
        }
        case 'dweb/base-host/ban': { const h = await start(); h.base.ban(msg.did, msg.reason); sendResponse({ ok: true }); return; }
        case 'dweb/base-host/unblock': { const h = await start(); h.base.unblock(msg.did); sendResponse({ ok: true }); return; }
        case 'dweb/base-host/set-discovery': { const h = await start(); h.base.setDiscovery(!!msg.enabled); sendResponse({ ok: true, enabled: !!msg.enabled }); return; }
        // The agent's peer/discovery read window: who we're linked to + the
        // sovereign discovery state (on/off, subscribers, blocked dids).
        case 'dweb/base-host/peers': {
          if (!handle) { sendResponse({ ok: true, peers: [], discovery: { enabled: false, subscribers: 0, library: 0, blocked: [] }, running: false }); return; }
          const snap = handle.base.snapshot();
          sendResponse({ ok: true, running: true, did: handle.base.did, peers: snap.peers, discovery: handle.base.discoveryState() });
          return;
        }
        // --- app store ---------------------------------------------------------
        // Share: publish the app's files as a signed bundle the base mesh serves,
        // then announce it (gossip + DHT). dwapp_id = content hash.
        case 'dweb/base-host/share-app': {
          const h = await start();
          const { uri, hash } = await h.base.publishApp({ name: msg.name, entry: msg.entry, files: msg.files });
          const size = Object.values(msg.files || {}).reduce((n, t) => n + (typeof t === 'string' ? t.length : 0), 0);
          // The UI passes an edited namespace on FIRST share (and the stored slug on
          // reshare); fall back to the name. A RESHARE reuses the same slug → same
          // dwapp_id → publishMeta amends the existing card (higher seq) instead of
          // forking a new app — that's the whole versioning story.
          const slug = slugify(msg.slug || msg.name);
          const { dwapp_id, card } = await h.base.publishMeta({
            slug, name: msg.name, description: msg.description ?? '',
            head: { version_id: hash, content_addr: uri, size },
            // A normal share omits seq (publishMeta defaults to Date.now() — a
            // natural monotonic bump). A RE-SEED on restart passes the STORED seq
            // so it re-announces the SAME version (same bytes → same version_id),
            // repopulating our wiped in-memory Library without a spurious bump.
            ...(Number.isInteger(msg.seq) ? { seq: msg.seq } : {}),
          });
          log(`shared app "${msg.name}" (${slug}) → ${dwapp_id.slice(0, 12)}… seq ${card.seq}`);
          sendResponse({ ok: true, uri, hash, dwapp_id, slug, seq: card.seq, publisher: h.base.did });
          return;
        }
        // Un-share: the user deleted an app — stop announcing + serving it. The host
        // resolves the dwapp_id from its own identity + the app's slug (a self-
        // published app) or unannounces an explicit hash (an installed app we were
        // seeding). Idempotent: if the base network never started, there's nothing
        // to unshare — answer ok so delete still succeeds.
        case 'dweb/base-host/unshare-app': {
          if (!handle) { sendResponse({ ok: true, unserved: false, removed: false }); return; }
          const r = await handle.base.unshareApp({ slug: slugify(msg.slug || msg.name), publisher: msg.publisher || handle.base.did, hash: msg.hash || null });
          log(`unshared app "${msg.name}" — unserved:${r.unserved} removed:${r.removed}`);
          sendResponse({ ok: true, ...r });
          return;
        }
        // Discover: the bounded discovery Library (filled by the subscription plane).
        case 'dweb/base-host/heard': { sendResponse({ ok: true, apps: handle ? handle.base.heardDwapps().map(toDiscoverApp) : [] }); return; }
        // A dwapp room op (join/leave/publish/subscribe/dm/presence/…) — the
        // bridge's room surface, served over the shared base mesh.
        case 'dweb/base-host/room': { sendResponse(await handleRoomOp(msg)); return; }
        // Install: fetch the signed bundle over the base mesh, verify, install +
        // persist as an engine App (via the SW). Returns the new app record.
        case 'dweb/base-host/install-app': {
          const h = await start();
          const { manifest, payload } = await h.base.fetchApp(msg.uri);
          const client = /** @type {any} */ (await loadDweb());
          const app = await client.installAppBundle({
            uri: msg.uri, manifest, payload, name: msg.name,
            // The version identity from the card the user installed from — lets the
            // Library later detect a newer announce for this same dwapp_id.
            dwappId: msg.dwappId ?? null, slug: msg.slug ?? null, seq: Number.isInteger(msg.seq) ? msg.seq : null,
            install: async (/** @type {any} */ a) => {
              const r = await swCall('dweb/app-install', a);
              if (!r?.ok) throw new Error(r?.error ?? 'install failed');
              return r.app;
            },
          });
          h.base.seedApp({ manifest, payload }).catch(() => {}); // install → we seed it (background; don't block the install)
          log(`installed app "${app?.name ?? msg.name}" from the dweb`);
          sendResponse({ ok: true, app });
          return;
        }
        // Update an INSTALLED app in place to a newer announced version. Same fetch+
        // verify path as install, but the install callback overwrites the existing
        // app (dweb/app-update) instead of creating a new one — the user keeps one
        // copy that just updates (the old version's bytes stay announced on whoever
        // still seeds them, the substrate for a future revert/changelog).
        case 'dweb/base-host/update-app': {
          const h = await start();
          const { manifest, payload } = await h.base.fetchApp(msg.uri);
          const client = /** @type {any} */ (await loadDweb());
          const app = await client.installAppBundle({
            uri: msg.uri, manifest, payload, name: msg.name,
            dwappId: msg.dwappId ?? null, slug: msg.slug ?? null, seq: Number.isInteger(msg.seq) ? msg.seq : null,
            install: async (/** @type {any} */ a) => {
              const r = await swCall('dweb/app-update', { appId: msg.appId, ...a });
              if (!r?.ok) throw new Error(r?.error ?? 'update failed');
              return r.app;
            },
          });
          h.base.seedApp({ manifest, payload }).catch(() => {}); // seed the NEW version too
          log(`updated app "${app?.name ?? msg.name}" to a newer dweb version`);
          sendResponse({ ok: true, app });
          return;
        }
        case 'dweb/base-host/stop': {
          await baseLifecycle.stop();
          sendResponse({ ok: true });
          return;
        }
        default: sendResponse({ ok: false, error: `unknown:${msg.type}` }); return;
      }
    } catch (e) {
      warn('handler threw', msg.type, '—', /** @type {{ message?: string }} */ (e)?.message ?? e);
      sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  })();
  return true; // async sendResponse
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onBaseHostMessage));

log('handler registered', DWEB_ENABLED ? '(dweb enabled)' : '(dweb disabled — inert)');
