// @ts-check
import { GAME_NET_LIMITS, GAME_ROOM_PREFIX, gamePayload, gamePlayer, gameRateLimit, gameRecipients } from '/shared/game-net.js';

/** @typedef {{did:string,linked:boolean}} LinkedMember */
/** @typedef {{from:string,data:unknown,ts:number}} PeerMessage */
/** @typedef {{did:string,linkedMembers:()=>LinkedMember[],leave:()=>void,
 * presence:{onJoin:(listener:()=>void)=>()=>void,announce:()=>Promise<unknown>},
 * gossip:{subscribe:(topic:string,listener:(message:PeerMessage)=>void)=>()=>void,publish:(topic:string,data:string)=>Promise<unknown>},
 * direct:{onMessage:(listener:(message:PeerMessage)=>void)=>()=>void,
 * sendMany:(recipients:string[],data:string,signal:AbortSignal)=>Promise<number>}}} Room */

/** @type {Map<string,{owner:string,close:()=>void}>} */
const games = new Map();

export const closeGameRooms = () => {
  for (const game of games.values()) game.close();
};

/** @param {{world:unknown,roomId:unknown,owner:unknown,epoch:string,openRoom:(id:string)=>Room,isOnline:()=>boolean}} options */
export const openGameRoom = async ({ world, roomId, owner, epoch, openRoom, isOnline }) => {
  if (typeof world !== 'string' || !/^[a-f0-9]{64}$/.test(world)
      || roomId !== GAME_ROOM_PREFIX + world.slice(0, 40)
      || typeof owner !== 'string' || !owner || owner.length > 160) return { ok: false, error: 'game-room-invalid' };
  const current = games.get(roomId);
  if (current && current.owner !== owner) return { ok: false, error: 'already-playing' };
  current?.close();
  const room = openRoom(roomId);
  const channelId = crypto.randomUUID() + crypto.randomUUID();
  const channel = new BroadcastChannel(channelId);
  const abort = new AbortController();
  /** @type {Map<string,{id:string,linked:boolean}>} */ let peers = new Map();
  /** @type {[string,unknown][]} */ const messages = [];
  let sequence = 0, lastSeen = performance.now(), lastBeat = 0;
  let connected = false, refreshing = false, roster = '', sending = false, publishing = false;
  /** @type {boolean|undefined} */ let ready;
  let self = '';
  const send = gameRateLimit(GAME_NET_LIMITS.sendRate, GAME_NET_LIMITS.sendBurst);
  const publish = gameRateLimit(GAME_NET_LIMITS.publishRate, GAME_NET_LIMITS.publishBurst);

  /** @param {string} kind @param {PeerMessage} message */
  const accept = (kind, { from, data, ts }) => {
    const peer = peers.get(from);
    if (!connected || !peer || !Number.isFinite(ts) || !gamePayload(data)) return;
    if (messages.length >= 1024) messages.shift();
    messages.push(['message', { from: peer.id, data: JSON.parse(data), ts, kind }]);
  };
  const off = [
    room.gossip.subscribe('state', message => accept('publish', message)),
    room.direct.onMessage(message => accept('send', message)),
    room.presence.onJoin(() => { void room.presence.announce().catch(() => {}); }),
  ];
  /** @param {[string,unknown][]} events @param {boolean} beat */
  const post = (events, beat) => channel.postMessage({
    epoch, sequence: ++sequence, online: isOnline(), self,
    events, beat,
  });
  const close = () => {
    abort.abort();
    clearInterval(timer);
    channel.close();
    for (const remove of off) remove();
    room.leave();
    games.delete(roomId);
  };
  const update = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const members = room.linkedMembers().slice(0, GAME_NET_LIMITS.recipients);
      const next = new Map(await Promise.all(members.map(async ({ did, linked }) => /** @type {[string,{id:string,linked:boolean}]} */ ([
        did, { id: peers.get(did)?.id ?? await gamePlayer(world, did), linked },
      ]))));
      if (abort.signal.aborted) return;
      peers = next;
      const list = [...peers.values()];
      const encoded = JSON.stringify(list);
      /** @type {[string,unknown][]} */ const events = [];
      if (encoded !== roster) { roster = encoded; events.push(['peers', list]); }
      const online = isOnline();
      if (online !== ready) { ready = online; events.push(['status', ready ? 'up' : 'degraded']); }
      post(events, true);
    } finally { refreshing = false; }
  };
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - lastSeen > 5000) { close(); return; }
    if (!connected) return;
    if (now - lastBeat >= 1000) {
      lastBeat = now;
      void update().catch(() => {});
    }
    if (messages.length) post(messages.splice(0, 64), false);
  }, 50);
  games.set(roomId, { owner, close });
  try { self = await gamePlayer(world, room.did); }
  catch (error) { if (!abort.signal.aborted) close(); throw error; }
  if (abort.signal.aborted) return { ok: false, error: 'game-room-closed' };
  channel.onmessage = ({ data }) => {
    const now = performance.now();
    switch (data?.op) {
      case 'hello':
      case 'heartbeat':
        lastSeen = now;
        connected = true;
        return;
      case 'leave':
        close();
        return;
      case 'publish':
        if (!connected || publishing || !publish(now) || !gamePayload(data.data)) return;
        publishing = true;
        void room.gossip.publish('state', data.data).catch(() => {}).finally(() => { publishing = false; });
        return;
      case 'send': {
        if (!connected || sending || !send(now) || !gameRecipients(data.ids) || !gamePayload(data.data)) return;
        const ids = new Set(data.ids);
        const recipients = [...peers].filter(([, peer]) => peer.linked && ids.has(peer.id)).map(([did]) => did);
        sending = true;
        void room.direct.sendMany(recipients, data.data, abort.signal).finally(() => { sending = false; });
      }
    }
  };
  return { ok: true, channelId, offscreenEpoch: epoch };
};
