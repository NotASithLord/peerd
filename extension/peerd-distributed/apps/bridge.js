// @ts-check
// peerd-distributed/apps/bridge.js — the dwapp API (bridge v0).
//
// THE new privilege boundary (NORTH-STAR §4, MIGRATION §3): a sandboxed,
// opaque-origin dwapp talks to the dweb ONLY through this postMessage RPC,
// hosted by the trusted app-tab parent page. The surface is deliberately
// small and FROZEN for Phase 1 — growing it is a security event, not a
// convenience.
//
// CONNECTIVITY = THE ALWAYS-ON BASE NETWORK. A dwapp is a SUB-PROTOCOL, not a
// thing tied to a signaler: "join a room" opens a NAMESPACED overlay on the one
// shared base mesh in the offscreen document (base-network.js openRoom), so the
// app rides connections that already exist — no per-app rendezvous, no per-app
// mesh, no rendezvous prompt. The bridge relays each op to that offscreen host
// over the SW (swCall 'dweb/base/room'); the host pushes feed/dm/presence events
// back as 'dweb/base-room/event' runtime messages (onHostEvent), filtered to the
// room we joined. The identity is the user's vault did, held by the offscreen
// base node — the bridge never mints or sees key material.
//
// v0 surface (one room per app):
//   hello                          → { available, app, launch, did, joined }
//   join { roomId, name? }         → CONSENT-GATED (confirm + remembered
//                                    per-app grant; every outcome audited)
//   leave · status · presence · history { topic } · retain { topic }
//   publish { topic, data, retain? } · subscribe { topic } · mute { did }
//   dm-send { to, data }           → a DIRECT 1:1 message (ch=3, PROTOCOL
//                                    §6.1): point-to-point over one mesh
//                                    link, never flooded or relayed. This is
//                                    a NARROWER send than publish (one peer,
//                                    not the whole room), so it adds no reach
//                                    a flooding app didn't already have.
//   announce { meta }
//   publish-app                    → this app's own files, signed + served
//   install-app { uri, name? }     → CONSENT-GATED EVERY TIME (never
//                                    remembered): fetch from base peers,
//                                    verify, install as an engine App
// Events pushed to the app: message · direct · presence-join · presence-leave ·
//   peer · peer-gone · status
//
// What v0 deliberately does NOT expose:
//   - raw sign(): nothing in the demo needs it — post/doc attribution is
//     the platform envelope's `from`. When an app-visible sign() lands it
//     MUST be domain-separated per D-8; until then the capability simply
//     doesn't exist, which is safer than scoping it.
//   - content put/get: attachments are a Phase 2 surface.
//   - cross-room/multi-room: one room per app keeps consent legible.
//   - a custom signaler: the base network IS the connectivity (above).
//
// Trust notes:
//   - Replies go ONLY to the app frame (e.source identity check in the
//     transport), and the identity key never crosses the boundary — the app
//     sees its did string, never material.
//   - Inbound host events are filtered to OUR room id before reaching the
//     app, so a second dwapp's traffic can't leak across the shared push.
//   - Payloads stay opaque end-to-end (D-7): `data` passes through
//     structured-clone untouched.

const GRANTS_KEY = 'dweb.grants.v1';

// The default transport for the app-tab host: post events into the dwapp's
// iframe and receive its ops (identity-checked by e.source). createDwebBridge
// is otherwise transport-agnostic — the SAME bridge logic runs in the app-tab
// page today and, with an SW-relay transport, in the offscreen document.
/** @param {HTMLIFrameElement} frame */
export const iframeTransport = (frame) => ({
  /** @param {any} msg */
  send: (msg) => frame.contentWindow?.postMessage(msg, '*'),
  /** @param {(msg: any) => void} handler */
  onMessage: (handler) => {
    /** @param {MessageEvent} e */
    const fn = (e) => { if (e.source === frame.contentWindow) handler(e.data); };
    window.addEventListener('message', fn);
    return () => window.removeEventListener('message', fn);
  },
});

/**
 * @param {{
 *   appId: string,
 *   appName: string,
 *   appDweb: any,
 *   entryFile: string,
 *   transport: { send: (msg: any) => void, onMessage: (handler: (msg: any) => void) => () => void },
 *   swCall: (type: string, payload?: any) => Promise<any>,
 *   storage: { get: (k: any) => Promise<any>, set: (o: any) => Promise<void> },
 *   confirmAction: (info: { kind: 'join' | 'install', appName: string, detail: string }) => Promise<boolean>,
 *   readAppFiles: () => Promise<Record<string, string>>,
 *   onHostEvent?: (handler: (m: any) => void) => () => void,
 *   launch?: { room?: string, url?: string },
 * }} opts
 */
export const createDwebBridge = ({
  appId,
  appName,
  appDweb,
  entryFile,
  transport,
  swCall,
  storage,
  confirmAction,
  readAppFiles,
  onHostEvent,
  launch = {},
}) => {
  // Grants key on the app's content identity when it has one (stable
  // across reinstalls of the same bundle), else the seed key / local id.
  const appKey = appDweb?.hash || (appDweb?.seed ? `seed:${appDweb.seed}` : appId);

  /** @type {string | null} */
  let roomId = null;        // the room we're in (one per app, v0)
  /** @type {string | null} */
  let did = null;           // our base-network did (the offscreen's vault identity)
  let displayName = '';
  /** @type {Set<string>} */
  const subbedTopics = new Set();
  /** @type {Array<() => void>} */
  const disposers = [];

  /** @param {string} type @param {any} [details] */
  const audit = (type, details) => {
    swCall('dweb/audit', { type: `dweb_${type}`, details }).catch(() => {});
  };

  /** @param {any} msg */
  const post = (msg) => transport.send(msg);
  /** @param {string} event @param {any} data */
  const emit = (event, data) => post({ peerd: 'dweb:event', event, data });

  // One room op, relayed to the offscreen base host (which serves the room as a
  // namespaced sub-protocol on the shared mesh). roomId rides every op.
  /** @param {string} op @param {Record<string, any>} [args] */
  const room = (op, args = {}) => swCall('dweb/base/room', { op, roomId, ...args });

  // Grants are keyed by ROOM id, not just per-app: the consent dialog names a
  // specific room, so a remembered grant must authorize only THAT room — else
  // one approval would let the app silently join any room name it likes later.
  const grantStore = {
    /** @param {string} rid */
    async has(rid) {
      const got = await storage.get(GRANTS_KEY);
      return !!got?.[GRANTS_KEY]?.[appKey]?.rooms?.[rid];
    },
    /** @param {string} rid */
    async grant(rid) {
      const got = await storage.get(GRANTS_KEY);
      const all = got?.[GRANTS_KEY] ?? {};
      const rooms = { ...(all[appKey]?.rooms ?? {}), [rid]: true };
      all[appKey] = { ...(all[appKey] ?? {}), rooms };
      await storage.set({ [GRANTS_KEY]: all });
    },
  };

  // Events pushed from the offscreen base host. Filter to OUR room (the shared
  // runtime push reaches every app-tab) and, for feed messages, to topics this
  // app actually subscribed — so another dwapp in the same room can't bleed in.
  const offHostEvent = onHostEvent?.((/** @type {any} */ m) => {
    if (!roomId || m?.roomId !== roomId) return;
    if (m.event === 'message' && !subbedTopics.has(m.data?.topic)) return;
    emit(m.event, m.data);
  }) ?? (() => {});
  disposers.push(offHostEvent);

  // The consent gate every join runs. A remembered grant skips the dialog,
  // never the audit. No rendezvous in the copy: connectivity is the base network.
  /** @param {string} rid */
  const consent = async (rid) => {
    if (await grantStore.has(rid)) return true;
    const okd = await confirmAction({
      kind: 'join',
      appName,
      detail: `join the dweb room “${rid}” — peers in the room will see your peer `
        + 'identity and the messages you publish',
    });
    if (!okd) { audit('bridge_join_denied', { appId, appKey, roomId: rid }); return false; }
    await grantStore.grant(rid);
    audit('bridge_join_granted', { appId, appKey, roomId: rid });
    return true;
  };

  const ops = {
    hello: async () => ({ available: true, app: appName, launch, did, joined: roomId }),

    /** @param {{ roomId?: string, name?: string }} [args] */
    join: async ({ roomId: rid, name = '' } = {}) => {
      if (roomId) {
        if (roomId === rid) return { did, joined: roomId };
        throw new Error('already in a room — leave first (one room per app)');
      }
      if (typeof rid !== 'string' || !rid.trim()) throw new Error('roomId required');
      const id = rid.trim();
      if (id.length > 64) throw new Error('room name too long (max 64 chars)');
      if (!(await consent(id))) throw new Error('denied');
      displayName = String(name ?? '').slice(0, 40);
      roomId = id; // set before the op so room() carries it; cleared on failure
      const r = await room('join', { name: displayName });
      if (!r?.ok) { roomId = null; throw new Error(r?.error ?? 'join failed'); }
      did = r.did;
      audit('room_joined', { roomId, did });
      return { did, joined: roomId, present: r.present };
    },

    leave: async () => {
      if (!roomId) return { left: false };
      const was = roomId;
      await room('leave');
      roomId = null;
      subbedTopics.clear();
      audit('room_left', { roomId: was });
      return { left: true };
    },

    status: async () => (roomId ? { joined: roomId, did, ...(await room('status')) } : { joined: null }),

    presence: async () => (roomId ? ((await room('presence')).present ?? []) : []),

    /** @param {{ meta?: { name?: string } }} [args] */
    announce: async ({ meta } = {}) => {
      if (!roomId) throw new Error('not in a room');
      if (meta && typeof meta.name === 'string') displayName = meta.name.slice(0, 40);
      await room('announce', { name: displayName });
      return { ok: true };
    },

    /** @param {{ topic?: any }} [args] */
    retain: async ({ topic } = {}) => {
      if (!roomId) throw new Error('not in a room');
      await room('retain', { topic: String(topic) });
      return { ok: true };
    },

    /** @param {{ topic?: any, data?: any, retain?: boolean }} [args] */
    publish: async ({ topic, data, retain = false } = {}) => {
      if (!roomId) throw new Error('not in a room');
      const r = await room('publish', { topic: String(topic), data, retain: !!retain });
      return { id: r.id, ts: r.ts };
    },

    /** @param {{ topic?: any }} [args] */
    subscribe: async ({ topic } = {}) => {
      if (!roomId) throw new Error('not in a room');
      const t = String(topic);
      if (!subbedTopics.has(t)) { await room('subscribe', { topic: t }); subbedTopics.add(t); }
      return { ok: true };
    },

    // A direct 1:1 message to one peer (ch=3) — not flooded, not relayed.
    // Inbound directs arrive on the 'direct' event (pushed from the host).
    /** @param {{ to?: any, data?: any }} [args] */
    'dm-send': async ({ to, data } = {}) => {
      if (!roomId) throw new Error('not in a room');
      if (typeof to !== 'string' || !to) throw new Error('a recipient did is required');
      const r = await room('dm', { to, data });
      return { id: r.id, ts: r.ts };
    },

    /** @param {{ topic?: any }} [args] */
    history: async ({ topic } = {}) => {
      if (!roomId) throw new Error('not in a room');
      return (await room('history', { topic: String(topic) })).items ?? [];
    },

    /** @param {{ did?: any }} [args] */
    mute: async ({ did: muted } = {}) => {
      if (!roomId) throw new Error('not in a room');
      await room('mute', { did: String(muted) });
      audit('peer_muted_by_app', { did: muted });
      return { ok: true };
    },

    // Publish THIS app's own files into the room as a signed bundle — the share
    // beat. The app never reads its own source; the trusted parent does (OPFS),
    // so a compromised app can't publish arbitrary other apps either.
    'publish-app': async () => {
      if (!roomId) throw new Error('not in a room');
      const files = await readAppFiles();
      const r = await room('publish-app', { name: appName, entry: entryFile, files });
      audit('app_shared', { uri: r.uri });
      return { uri: r.uri, hash: r.hash, room: roomId };
    },

    // Install an app shared in the room: fetch + verify on the host, CONFIRM —
    // every single time, an install is never a remembered grant — then store.
    /** @param {{ uri?: any, name?: string }} [args] */
    'install-app': async ({ uri, name } = {}) => {
      if (!roomId) throw new Error('not in a room');
      if (typeof uri !== 'string' || !uri.startsWith('peerd://')) throw new Error('peerd:// uri required');
      const meta = await room('fetch-app', { uri });
      const publisher = meta?.publisher ?? 'unsigned';
      const okd = await confirmAction({
        kind: 'install',
        appName,
        detail: `install the app at ${uri.slice(0, 64)}… published by ${publisher.slice(0, 32)}…? `
          + 'It runs sandboxed, with no extension access.',
      });
      if (!okd) { audit('app_install_denied', { uri }); throw new Error('denied'); }
      const r = await room('install-app', { uri, name });
      if (!r?.ok) throw new Error(r?.error ?? 'install failed');
      return { appId: r.appId, name: r.name };
    },
  };

  // Inbound ops from the dwapp. The transport delivers already-parsed,
  // already-identity-checked messages (the iframe-source check lives in the
  // transport), so this logic is window-free and host-location-agnostic.
  // why any m: an opaque, already-identity-checked wire message validated by the
  // guard below before any field is trusted.
  /** @param {any} m */
  const handleOp = async (m) => {
    if (!m || m.peerd !== 'dweb' || typeof m.op !== 'string') return;
    const op = /** @type {Record<string, (args?: any) => Promise<any>>} */ (ops)[m.op];
    /** @param {boolean} ok @param {any} valueOrError */
    const reply = (ok, valueOrError) => post({
      peerd: 'dweb:result',
      id: m.id,
      ok,
      ...(ok ? { value: valueOrError } : { error: String(valueOrError?.message ?? valueOrError) }),
    });
    if (!op) return reply(false, `unknown op: ${m.op}`);
    try {
      reply(true, await op(m.args ?? {}));
    } catch (err) {
      reply(false, err);
    }
  };

  const offTransport = transport.onMessage(handleOp);

  return {
    dispose() {
      offTransport();
      for (const off of disposers.splice(0)) off();
      ops.leave().catch(() => {});
    },
  };
};
