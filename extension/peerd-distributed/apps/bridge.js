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
const ROOM_COMPENSATION_PREFIX = 'dweb.room-compensation.v1';

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
 *   confirmAction: (info: { kind: 'join' | 'install' | 'share', appName: string, detail: string, approveLabel?: string }) => Promise<boolean>,
 *   onHostEvent?: (handler: (m: any) => void) => () => void,
 *   launch?: { room?: string, url?: string },
 *   newId?: () => string,
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
  onHostEvent,
  launch = {},
  newId = () => crypto.randomUUID(),
}) => {
  // Grants key on the app's content identity when it has one (stable
  // across reinstalls of the same bundle), else the seed key / local id.
  const appKey = appDweb?.hash || (appDweb?.seed ? `seed:${appDweb.seed}` : appId);

  /** @type {string | null} */
  let roomId = null;        // the room we're in (one per app, v0)
  /** @type {string | null} */
  let did = null;           // our base-network did (the offscreen's vault identity)
  let displayName = '';
  /** @type {string | null} */
  let hostEpoch = null;
  /** @type {string | null} */
  let announcedHostEpoch = null;
  /** @type {Set<string>} */
  const retiredHostEpochs = new Set();
  const stableRoomClientId = `room-client-${newId()}`;
  if (stableRoomClientId.length < 8 || stableRoomClientId.length > 160) {
    throw new Error('room client identity invalid');
  }
  /** @type {string | null} */
  let roomClientId = null;
  /** @type {string | null} */
  let roomAdmissionToken = null;
  /** @type {string | null} */
  let activeClientId = null;
  // Once an iframe epoch has been replaced or disposed it can never become
  // active again. Otherwise a late ordinary RPC from A can replace B, reclaim
  // roomClientId, and make A's later dispose tear down B's adopted room.
  // Refuse new epochs after a generous per-tab ceiling instead of evicting
  // tombstones and making very old epochs replayable again.
  const MAX_CLIENT_EPOCHS = 128;
  /** @type {Set<string>} */
  const retiredClientIds = new Set();
  let admittedClientEpochs = 0;
  let disposed = false;
  let transitionTail = Promise.resolve();
  /** @type {Map<string,{clientId:string,id:string,cancelled:boolean}>} */
  const pending = new Map();
  /** @type {Set<string>} */
  const subbedTopics = new Set();
  /** @type {Set<string>} */
  const retainedTopics = new Set();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const recoveryTimers = new Set();
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

  const irreversibleRoomOps = new Set([
    'publish', 'dm', 'dm-send', 'publish-app', 'install-app',
  ]);
  /** @param {unknown} cause @param {string} op */
  const roomFailure = (cause, op) => {
    const detail = /** @type {any} */ (cause);
    const explicit = detail?.outcomeKnown === false
      || typeof detail?.performed === 'boolean'
      || ['pre-effect-failure', 'effect-completed', 'host-lost', 'transport-lost']
        .includes(detail?.outcomeKind);
    return Object.assign(
      new Error(detail?.error ?? detail?.message ?? `room ${op} failed`),
      explicit ? {
        ...(typeof detail?.performed === 'boolean' ? { performed: detail.performed } : {}),
        ...(typeof detail?.outcomeKnown === 'boolean'
          ? { outcomeKnown: detail.outcomeKnown } : {}),
        ...(typeof detail?.retryable === 'boolean' ? { retryable: detail.retryable } : {}),
        ...(['pre-effect-failure', 'effect-completed', 'host-lost', 'transport-lost']
          .includes(detail?.outcomeKind) ? { outcomeKind: detail.outcomeKind } : {}),
      } : irreversibleRoomOps.has(op) ? {
        performed: true, outcomeKnown: false,
        outcomeKind: 'transport-lost', retryable: false,
      } : {},
    );
  };

  // One room op, relayed to the offscreen base host (which serves the room as a
  // namespaced sub-protocol on the shared mesh). roomId rides every op.
  /** @param {string} op @param {Record<string, any>} [args] @param {string|null} [exactRoomId] @param {string|null} [exactHostEpoch] @param {string} [exactClientId] @param {string|null} [exactAdmissionToken] */
  const room = async (op, args = {}, exactRoomId = roomId, exactHostEpoch = hostEpoch,
    exactClientId = stableRoomClientId, exactAdmissionToken = roomAdmissionToken) => {
    let result;
    try {
      result = await swCall('dweb/base/room', {
        op,
        appId,
        roomId: exactRoomId,
        roomClientId: exactClientId,
        ...(exactHostEpoch ? { expectedHostEpoch: exactHostEpoch } : {}),
        ...args,
        ...(exactAdmissionToken ? { roomAdmissionToken: exactAdmissionToken } : {}),
      });
    } catch (cause) { throw roomFailure(cause, op); }
    if (result?.ok !== true) throw roomFailure(result, op);
    return result;
  };

  /** @template T @param {()=>Promise<T>} operation */
  const serializeTransition = (operation) => {
    const current = transitionTail.catch(() => {}).then(operation);
    transitionTail = current.then(() => undefined, () => undefined);
    return current;
  };

  const compensationKey = `${ROOM_COMPENSATION_PREFIX}:${appId}`;
  /** @param {any} value */
  const parseCompensation = (value) => value?.schema === 1
    && value.appId === appId
    && typeof value.roomId === 'string' && value.roomId.length > 0 && value.roomId.length <= 64
    && typeof value.clientId === 'string' && value.clientId.length >= 8 && value.clientId.length <= 160
    && typeof value.admissionToken === 'string'
    && value.admissionToken.length >= 16 && value.admissionToken.length <= 192
    && (value.hostEpoch === null || typeof value.hostEpoch === 'string')
    ? Object.freeze({ ...value }) : null;
  const readCompensation = async () => parseCompensation(
    (await storage.get(compensationKey))?.[compensationKey],
  );
  /** @param {any} record */
  const persistCompensation = (record) => storage.set({ [compensationKey]: record });
  /** @param {string} admissionToken */
  const clearCompensation = async (admissionToken) => {
    const current = await readCompensation();
    if (current && current.admissionToken !== admissionToken) return false;
    await storage.set({ [compensationKey]: null });
    return true;
  };
  /** @param {any} record */
  const compensateJoin = async (record) => {
    try {
      await room(
        'leave', {}, record.roomId, record.hostEpoch, record.clientId, record.admissionToken,
      );
    } catch (cause) {
      const failure = /** @type {any} */ (cause);
      const alreadyAbsent = [
        'not-in-room', 'dweb-host-generation-changed', 'app-room-admission-mismatch',
      ].includes(failure?.message)
        && failure?.outcomeKnown !== false
        && failure?.performed !== true
        && !['effect-completed', 'host-lost', 'transport-lost'].includes(failure?.outcomeKind);
      if (!alreadyAbsent) throw cause;
    }
    await clearCompensation(record.admissionToken);
    return true;
  };
  /** @param {any} record @param {number} [attempt] */
  const queueCompensation = (record, attempt = 0) => {
    if (disposed) return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(timer);
      void compensateJoin(record).catch(() => {
        if (attempt < 5) queueCompensation(record, attempt + 1);
      });
    }, Math.min(2_000, 100 * (2 ** attempt)));
    recoveryTimers.add(timer);
  };
  const reconcileCompensation = async () => {
    const record = await readCompensation();
    if (!record) return true;
    try { return await compensateJoin(record); }
    catch (cause) { queueCompensation(record); throw cause; }
  };
  // A prior App document may have died after the host committed membership but
  // before the SW delivered its receipt. Reopen starts by replaying the exact
  // token-bound compensating leave; a different/later admission is untouched.
  void reconcileCompensation().catch(() => {});

  /** @param {{clientId:string,cancelled:boolean}} request */
  const isCancelled = (request) => disposed || request.cancelled || activeClientId !== request.clientId;

  /** @param {string} clientId */
  const cancelClient = (clientId) => {
    for (const request of pending.values()) {
      if (request.clientId === clientId) request.cancelled = true;
    }
  };

  /** @param {string} clientId */
  const retireClient = (clientId) => {
    cancelClient(clientId);
    retiredClientIds.add(clientId);
    if (activeClientId === clientId) activeClientId = null;
  };

  // Grants are keyed by ROOM id, not just per-app: the consent dialog names a
  // specific room, so a remembered grant must authorize only THAT room — else
  // one approval would let the app silently join any room name it likes later.
  const grantStore = {
    /** @param {string} rid */
    async has(rid) {
      const got = await storage.get(GRANTS_KEY);
      const rooms = got?.[GRANTS_KEY]?.[appKey]?.rooms;
      return !!rooms && Object.hasOwn(rooms, rid) && rooms[rid] === true;
    },
    /** @param {string} rid */
    async grant(rid) {
      const got = await storage.get(GRANTS_KEY);
      const stored = got?.[GRANTS_KEY];
      const all = Object.assign(Object.create(null), stored && typeof stored === 'object' ? stored : {});
      const rooms = Object.assign(Object.create(null), all[appKey]?.rooms ?? {});
      rooms[rid] = true;
      all[appKey] = { ...(all[appKey] ?? {}), rooms };
      await storage.set({ [GRANTS_KEY]: all });
    },
  };

  /** @param {any} message */
  const recoverHost = async (message) => {
    const nextHostEpoch = message?.hostEpoch;
    if (disposed || typeof nextHostEpoch !== 'string'
        || nextHostEpoch.length < 8 || announcedHostEpoch !== nextHostEpoch) return;
    if (!roomId) {
      if (hostEpoch && hostEpoch !== nextHostEpoch) retiredHostEpochs.add(hostEpoch);
      hostEpoch = nextHostEpoch;
      if (typeof message.did === 'string') did = message.did;
      return;
    }
    if (hostEpoch === nextHostEpoch) return;
    const recoveringRoomId = roomId;
    const joined = await room(
      'join', { name: displayName }, recoveringRoomId, nextHostEpoch,
    );
    if (!joined?.ok) throw new Error(joined?.error ?? 'room recovery join failed');
    if (joined.admissionToken !== roomAdmissionToken) {
      throw new Error('room recovery admission mismatch');
    }
    const acknowledged = await room(
      'join-ack', {}, recoveringRoomId, nextHostEpoch,
    );
    if (!acknowledged?.ok || acknowledged.admissionToken !== roomAdmissionToken) {
      throw new Error(acknowledged?.error ?? 'room recovery acknowledgement failed');
    }
    if (disposed || roomId !== recoveringRoomId || announcedHostEpoch !== nextHostEpoch) {
      await room('leave', {}, recoveringRoomId, nextHostEpoch).catch(() => {});
      return;
    }
    for (const topic of retainedTopics) {
      const retained = await room('retain', { topic }, recoveringRoomId, nextHostEpoch);
      if (!retained?.ok) throw new Error(retained?.error ?? 'room retain recovery failed');
    }
    for (const topic of subbedTopics) {
      const subscribed = await room('subscribe', { topic }, recoveringRoomId, nextHostEpoch);
      if (!subscribed?.ok) throw new Error(subscribed?.error ?? 'room subscription recovery failed');
    }
    if (disposed || roomId !== recoveringRoomId || announcedHostEpoch !== nextHostEpoch) {
      await room('leave', {}, recoveringRoomId, nextHostEpoch).catch(() => {});
      return;
    }
    if (hostEpoch && hostEpoch !== nextHostEpoch) retiredHostEpochs.add(hostEpoch);
    hostEpoch = nextHostEpoch;
    did = joined.did ?? message.did ?? did;
    emit('host-recovered', {
      roomId: recoveringRoomId,
      did,
      hostEpoch,
      meshGeneration: message.meshGeneration ?? null,
    });
    audit('room_host_recovered', { roomId: recoveringRoomId, hostEpoch });
  };

  /** @param {any} message @param {number} [attempt] */
  const queueHostRecovery = (message, attempt = 0) => {
    void serializeTransition(() => recoverHost(message)).catch((error) => {
      if (disposed || announcedHostEpoch !== message?.hostEpoch) return;
      audit('room_host_recovery_failed', {
        roomId,
        hostEpoch: message?.hostEpoch,
        attempt,
        error: error?.message ?? String(error),
      });
      if (attempt >= 4) {
        emit('host-recovery-failed', { roomId, error: error?.message ?? String(error) });
        return;
      }
      const timer = setTimeout(() => {
        recoveryTimers.delete(timer);
        queueHostRecovery(message, attempt + 1);
      }, Math.min(2_000, 100 * (2 ** attempt)));
      recoveryTimers.add(timer);
    });
  };

  // Events pushed from the offscreen base host. Filter to OUR room (the shared
  // runtime push reaches every app-tab) and, for feed messages, to topics this
  // app actually subscribed — so another dwapp in the same room can't bleed in.
  const offHostEvent = onHostEvent?.((/** @type {any} */ m) => {
    if (m?.type === 'dweb/base-host/generation') {
      if (typeof m.hostEpoch !== 'string' || m.hostEpoch.length < 8) return;
      if (m.hostEpoch === hostEpoch || retiredHostEpochs.has(m.hostEpoch)) return;
      announcedHostEpoch = m.hostEpoch;
      queueHostRecovery(m);
      return;
    }
    if (!roomId || m?.roomId !== roomId) return;
    if (m.event === 'message' && !subbedTopics.has(m.data?.topic)) return;
    emit(m.event, m.data);
  }) ?? (() => {});
  disposers.push(offHostEvent);

  // The consent gate every join runs. A remembered grant skips the dialog,
  // never the audit. No rendezvous in the copy: connectivity is the base network.
  /** @param {string} rid @param {{clientId:string,cancelled:boolean}} request */
  const consent = async (rid, request) => {
    if (isCancelled(request)) throw new Error('cancelled');
    if (await grantStore.has(rid)) return true;
    if (isCancelled(request)) throw new Error('cancelled');
    const okd = await confirmAction({
      kind: 'join',
      appName,
      detail: `join the dweb room “${rid}” — peers in the room will see your peer `
        + 'identity and the messages you publish',
    });
    if (isCancelled(request)) throw new Error('cancelled');
    if (!okd) { audit('bridge_join_denied', { appId, appKey, roomId: rid }); return false; }
    await grantStore.grant(rid);
    if (isCancelled(request)) throw new Error('cancelled');
    audit('bridge_join_granted', { appId, appKey, roomId: rid });
    return true;
  };

  const ops = {
    hello: async () => ({ available: true, app: appName, launch, did, joined: roomId }),

    /** @param {{ roomId?: string, name?: string }} [args] @param {{clientId:string,cancelled:boolean}} [request] */
    join: async ({ roomId: rid, name = '' } = {}, request = { clientId: '', cancelled: true }) => {
      if (roomId) {
        if (roomId === rid) return { did, joined: roomId };
        throw new Error('already in a room — leave first (one room per app)');
      }
      if (typeof rid !== 'string' || !rid.trim()) throw new Error('roomId required');
      const id = rid.trim();
      if (id.length > 64) throw new Error('room name too long (max 64 chars)');
      if (id === '__proto__' || id === 'constructor' || id === 'toString') throw new Error('reserved room name');
      await reconcileCompensation();
      if (!(await consent(id, request))) throw new Error('denied');
      if (isCancelled(request)) throw new Error('cancelled');
      const nextDisplayName = String(name ?? '').slice(0, 40);
      const admissionToken = `room-admission-${newId()}`;
      if (admissionToken.length < 16 || admissionToken.length > 192) {
        throw new Error('room admission identity invalid');
      }
      const compensation = Object.freeze({
        schema: 1,
        appId,
        roomId: id,
        clientId: stableRoomClientId,
        admissionToken,
        hostEpoch: hostEpoch ?? null,
      });
      // Persist before dispatch: every crash cut after this point can replay an
      // exact leave, including host commit -> SW relay death -> App reopen.
      await persistCompensation(compensation);
      let committedHostEpoch = hostEpoch;
      try {
        // Do not publish shared state until the host proves the exact room join
        // and finalizes the nonce-bound provisional membership.
        const r = await room(
          'join', { name: nextDisplayName }, id, hostEpoch,
          stableRoomClientId, admissionToken,
        );
        if (!r?.ok || r.admissionToken !== admissionToken) {
          throw new Error(r?.error ?? 'join admission mismatch');
        }
        committedHostEpoch = typeof r.hostEpoch === 'string' ? r.hostEpoch : hostEpoch;
        if (isCancelled(request)) throw new Error('cancelled');
        const acknowledged = await room(
          'join-ack', {}, id, committedHostEpoch,
          stableRoomClientId, admissionToken,
        );
        if (!acknowledged?.ok || acknowledged.admissionToken !== admissionToken) {
          throw new Error(acknowledged?.error ?? 'join acknowledgement failed');
        }
        if (isCancelled(request)) throw new Error('cancelled');
        await clearCompensation(admissionToken);
        displayName = nextDisplayName;
        roomId = id;
        roomClientId = request.clientId;
        roomAdmissionToken = admissionToken;
        did = r.did;
        if (typeof r.hostEpoch === 'string') {
          if (hostEpoch && hostEpoch !== r.hostEpoch) retiredHostEpochs.add(hostEpoch);
          hostEpoch = r.hostEpoch;
          announcedHostEpoch = r.hostEpoch;
        }
        audit('room_joined', { roomId, did });
        return { did, joined: roomId, present: r.present };
      } catch (cause) {
        const exactCompensation = { ...compensation, hostEpoch: committedHostEpoch ?? null };
        try { await compensateJoin(exactCompensation); }
        catch { queueCompensation(exactCompensation); }
        throw cause;
      }
    },

    leave: async () => {
      if (!roomId) return { left: false };
      const was = roomId;
      await room('leave', {}, was);
      roomId = null;
      roomClientId = null;
      roomAdmissionToken = null;
      subbedTopics.clear();
      retainedTopics.clear();
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
      const retained = String(topic);
      await room('retain', { topic: retained });
      retainedTopics.add(retained);
      return { ok: true };
    },

    /** @param {{ topic?: any, data?: any, retain?: boolean }} [args] */
    publish: async ({ topic, data, retain = false } = {}) => {
      if (!roomId) throw new Error('not in a room');
      const publishedTopic = String(topic);
      const r = await room('publish', { topic: publishedTopic, data, retain: !!retain });
      if (retain) retainedTopics.add(publishedTopic);
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
      const approved = await confirmAction({
        kind: 'share',
        appName,
        detail: `share this App's current source and binary assets with peers in room “${roomId}”? `
          + 'Anyone with the address can fetch this version.',
        approveLabel: 'Share app',
      });
      if (!approved) {
        audit('app_share_denied', { appId, appKey, roomId });
        throw new Error('denied');
      }
      const r = await room('publish-app', { appId, name: appName, entry: entryFile });
      audit('app_shared', { uri: r.uri });
      return { uri: r.uri, hash: r.hash, room: roomId };
    },

    // Install an app shared in the room: fetch + verify on the host, CONFIRM —
    // every single time, an install is never a remembered grant — then store.
    /** @param {{ uri?: any, name?: string }} [args] */
    'install-app': async ({ uri, name } = {}) => {
      if (!roomId) throw new Error('not in a room');
      if (typeof uri !== 'string' || !uri.startsWith('peerd://')) throw new Error('peerd:// uri required');
      const publisher = uri.slice('peerd://'.length).split('/')[0] || 'unknown';
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
  let installInFlight = false;
  /** @param {any} m */
  const handleOp = async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.peerd === 'dweb:cancel') {
      if (typeof m.clientId !== 'string' || typeof m.id !== 'string') return;
      const request = pending.get(`${m.clientId}\0${m.id}`);
      if (request) request.cancelled = true;
      return;
    }
    if (m.peerd === 'dweb:dispose') {
      if (typeof m.clientId !== 'string' || m.clientId.length < 8 || m.clientId.length > 128) return;
      if (retiredClientIds.has(m.clientId)) return;
      // An epoch that was never active owns no lifecycle state. Ignoring it
      // also prevents hostile dispose spam from growing the retired set.
      if (activeClientId !== m.clientId) return;
      retireClient(m.clientId);
      if (roomId && roomClientId === m.clientId) {
        void serializeTransition(async () => {
          if (!roomId || roomClientId !== m.clientId) return;
          const was = roomId;
          await room('leave', {}, was).catch(() => {});
          roomId = null;
          roomClientId = null;
          roomAdmissionToken = null;
          did = null;
          subbedTopics.clear();
          audit('room_left', { roomId: was, reason: 'client-disposed' });
        });
      }
      return;
    }
    if (m.peerd !== 'dweb' || typeof m.op !== 'string') return;
    if (typeof m.clientId !== 'string' || m.clientId.length < 8 || m.clientId.length > 128
      || typeof m.id !== 'string' || m.id.length < 8 || m.id.length > 128) {
      return;
    }
    if (disposed) return;
    if (retiredClientIds.has(m.clientId)) {
      post({
        peerd: 'dweb:result', id: m.id, clientId: m.clientId, ok: false,
        error: 'retired client epoch',
      });
      return;
    }
    if (activeClientId !== m.clientId && admittedClientEpochs >= MAX_CLIENT_EPOCHS) {
      post({
        peerd: 'dweb:result', id: m.id, clientId: m.clientId, ok: false,
        error: 'client epoch limit reached',
      });
      return;
    }
    if (activeClientId && activeClientId !== m.clientId) {
      const priorClientId = activeClientId;
      retireClient(priorClientId);
      // A completed membership belongs to the bridge/App tab, not a dead
      // iframe epoch. The replacement adopts it; late dispose from the old
      // epoch can no longer tear down the replacement's room.
      if (roomId && roomClientId === priorClientId) roomClientId = m.clientId;
    }
    if (activeClientId !== m.clientId) {
      activeClientId = m.clientId;
      admittedClientEpochs += 1;
    }
    const op = /** @type {Record<string, (args?: any) => Promise<any>>} */ (/** @type {unknown} */ (ops))[m.op];
    /** @param {boolean} ok @param {any} valueOrError */
    const reply = (ok, valueOrError) => post({
      peerd: 'dweb:result',
      id: m.id,
      clientId: m.clientId,
      ok,
      ...(ok ? { value: valueOrError } : {
        error: String(valueOrError?.message ?? valueOrError),
        ...(typeof valueOrError?.performed === 'boolean'
          ? { performed: valueOrError.performed } : {}),
        ...(typeof valueOrError?.outcomeKnown === 'boolean'
          ? { outcomeKnown: valueOrError.outcomeKnown } : {}),
        ...(typeof valueOrError?.retryable === 'boolean'
          ? { retryable: valueOrError.retryable } : {}),
        ...(['pre-effect-failure', 'effect-completed', 'host-lost', 'transport-lost']
          .includes(valueOrError?.outcomeKind)
          ? { outcomeKind: valueOrError.outcomeKind } : {}),
      }),
    });
    if (!op) return reply(false, `unknown op: ${m.op}`);
    if (m.op === 'install-app' && installInFlight) return reply(false, 'an install request is already in progress');
    const request = { clientId: m.clientId, id: m.id, cancelled: false };
    const pendingKey = `${m.clientId}\0${m.id}`;
    if (pending.has(pendingKey)) return reply(false, 'duplicate request id');
    pending.set(pendingKey, request);
    try {
      if (m.op === 'install-app') installInFlight = true;
      const value = m.op === 'join'
        ? await serializeTransition(() => ops.join(m.args ?? {}, request))
        : m.op === 'leave'
          ? await serializeTransition(() => ops.leave())
          : m.op === 'hello'
            ? await op(m.args ?? {})
            : await transitionTail.then(() => {
              if (isCancelled(request)) throw new Error('cancelled');
              return op(m.args ?? {});
            });
      if (!isCancelled(request)) reply(true, value);
      else if (activeClientId === request.clientId) {
        // why: cancellation cannot erase a fulfilled irreversible host receipt;
        // returning the result prevents a blind retry from duplicating the effect.
        if (irreversibleRoomOps.has(m.op)) reply(true, value);
        else reply(false, 'cancelled');
      }
    } catch (err) {
      // A stale epoch receives no late result into a replacement client. Same-
      // epoch cancellation gets a terminal rejection so its pending promise can
      // settle if the frame is still alive.
      if (activeClientId === request.clientId) reply(false, err);
    } finally {
      pending.delete(pendingKey);
      if (m.op === 'install-app') installInFlight = false;
    }
  };

  const offTransport = transport.onMessage(handleOp);

  return {
    dispose() {
      disposed = true;
      if (activeClientId) cancelClient(activeClientId);
      offTransport();
      for (const off of disposers.splice(0)) off();
      for (const timer of recoveryTimers) clearTimeout(timer);
      recoveryTimers.clear();
      void serializeTransition(async () => {
        if (!roomId) return;
        const was = roomId;
        await room('leave', {}, was).catch(() => {});
        roomId = null;
        roomClientId = null;
        roomAdmissionToken = null;
        did = null;
        subbedTopics.clear();
        retainedTopics.clear();
      });
    },
  };
};
