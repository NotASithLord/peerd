// @ts-check
import { GAME_NET_LIMITS } from '/shared/game-net.js';

export const GAME_NET_BINDING = '__peerdNetRaw';
export const GAME_NET_DELIVERY = '__peerdNetDeliver';

/** @param {string} origin @param {string} token */
export const gameNetPageScript = (origin, token) => `(() => {
  'use strict';
  const raw = globalThis.${GAME_NET_BINDING};
  // why: Chromium can register the binding again on a history restore.
  Object.defineProperty(globalThis, '${GAME_NET_BINDING}', { value: undefined, writable: false, configurable: false });
  if (typeof raw !== 'function' || window !== top || location.origin !== ${JSON.stringify(origin)}) return;
  const token = ${JSON.stringify(token)};
  const limits = ${JSON.stringify(GAME_NET_LIMITS)};
  const doc = crypto.randomUUID();
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const create = Object.create;
  const keys = Object.keys;
  const now = performance.now.bind(performance);
  const min = Math.min;
  const delay = setTimeout.bind(globalThis);
  const cancel = clearTimeout.bind(globalThis);
  const settled = Function.prototype.call.bind(Promise.prototype.then);
  const PromiseType = Promise;
  const TypeErrorType = TypeError;
  const RangeErrorType = RangeError;
  const isArray = Array.isArray;
  const encodeText = TextEncoder.prototype.encode.bind(new TextEncoder());
  const pending = create(null);
  const listeners = create(null);
  let linked = create(null);
  let peers = freeze([]);
  let nextId = 0;
  let wantsRoom = false;
  let joining = null;
  let leaving = null;
  const rate = (rate, max) => {
    let tokens = max;
    let last = now();
    return () => {
      const time = now();
      tokens = min(max, tokens + (time - last) * rate / 1000);
      last = time;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  };
  const canPublish = rate(limits.publishRate, limits.publishBurst);
  const canSend = rate(limits.sendRate, limits.sendBurst);
  const post = (op, id, json) => raw(token + '["' + doc + '","' + op + '",' + id + ',' + json + ']');
  const encode = data => {
    const json = stringify(data);
    if (typeof json !== 'string') throw new TypeErrorType('Game data must be JSON.');
    if (json.length > limits.payloadBytes || encodeText(json).length > limits.payloadBytes) throw new RangeErrorType('Game data exceeds the payload limit.');
    return json;
  };
  const finish = (id, ok, value) => {
    const waiter = pending[id];
    if (!waiter) return;
    delete pending[id];
    cancel(waiter.timer);
    if (leaving?.id === id) leaving = null;
    if (joining?.id === id) {
      if (ok) joining.done = true;
      else { joining = null; wantsRoom = false; }
    }
    if (ok) waiter.resolve(value);
    else waiter.reject(freeze({ code: value }));
  };
  const request = op => {
    const id = ++nextId;
    const promise = new PromiseType((resolve, reject) => {
      const timer = delay(() => {
        if (joining?.id === id) post('cancel', id, 'null');
        finish(id, false, 'bridge-timeout');
      }, 30_000);
      pending[id] = { resolve, reject, timer };
      post(op, id, 'null');
    });
    return { id, promise, done: false };
  };
  const listen = kind => listener => {
    if (listener !== null && typeof listener !== 'function') throw new TypeErrorType('Expected a listener or null.');
    listeners[kind] = listener;
  };
  const emit = (kind, data) => {
    const listener = listeners[kind];
    if (listener) try { listener(data); } catch {}
  };
  const rejectBusy = () => new PromiseType((_, reject) => reject(freeze({ code: 'busy' })));
  const net = freeze({
    join() {
      if (joining) return joining.promise;
      if (keys(pending).length >= 8) return rejectBusy();
      wantsRoom = true;
      leaving = null;
      joining = request('join');
      return joining.promise;
    },
    leave() {
      if (leaving) return leaving.promise;
      if (keys(pending).length >= 8) return rejectBusy();
      wantsRoom = false;
      joining = null;
      leaving = request('leave');
      return leaving.promise;
    },
    publish(data) { if (canPublish()) post('publish', 0, stringify(encode(data))); },
    send(ids, data) {
      if (!isArray(ids) || ids.length > limits.recipients) throw new TypeErrorType('Expected a list of player IDs.');
      const jsonIds = encode(ids);
      const copy = parse(jsonIds);
      if (!isArray(copy) || copy.length > limits.recipients) throw new TypeErrorType('Expected a list of player IDs.');
      const seen = create(null);
      let count = 0, selected = '';
      for (let i = 0; i < copy.length; i += 1) {
        const id = copy[i];
        if (typeof id === 'string' && linked[id] && !seen[id]) {
          seen[id] = true;
          selected += (count ? ',' : '') + stringify(id);
          count += 1;
        }
      }
      if (!count || !canSend()) return 0;
      post('send', 0, '[[' + selected + '],' + stringify(encode(data)) + ']');
      return count;
    },
    peers() { return peers; },
    onMessage: listen('message'),
    onPeer: listen('peer'),
    onStatus: listen('status'),
  });
  const entry = freeze((key, json) => {
    if (key !== token || typeof json !== 'string') return false;
    const batch = parse(json);
    if (batch.doc !== doc) return false;
    for (let i = 0; i < batch.events.length; i += 1) {
      const event = batch.events[i];
      const value = event[1];
      if (event[0] === 'message') emit('message', value);
      else if (event[0] === 'peer') emit('peer', value);
      else if (event[0] === 'status') {
        if (value === 'unavailable' && joining?.done) { wantsRoom = false; joining = null; }
        emit('status', value);
      }
      else if (event[0] === 'peers') {
        const before = create(null);
        const after = create(null);
        for (let j = 0; j < peers.length; j += 1) before[peers[j].id] = peers[j];
        linked = create(null);
        for (let j = 0; j < value.length; j += 1) {
          const peer = freeze(value[j]);
          after[peer.id] = peer;
          if (peer.linked) linked[peer.id] = true;
        }
        const previous = peers;
        peers = freeze(value);
        for (let j = 0; j < previous.length; j += 1) {
          const peer = previous[j];
          if (!after[peer.id]) emit('peer', { id: peer.id, linked: false, state: 'leave' });
        }
        for (let j = 0; j < peers.length; j += 1) {
          const peer = peers[j];
          if (before[peer.id]?.linked !== peer.linked) emit('peer', { id: peer.id, linked: peer.linked, state: 'join' });
        }
      } else if (event[0] === 'reply') finish(value.id, value.ok, value.ok ? value.value : value.error);
    }
    return true;
  });
  Object.defineProperty(globalThis, '${GAME_NET_DELIVERY}', { value: entry, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'peerd', { value: freeze({ net }), writable: false, configurable: false });
  addEventListener('pageshow', event => {
    if (!event.isTrusted || !event.persisted) return;
    // why: the host must bind the restored document before its next request.
    post('hello', 0, 'true');
    const resume = wantsRoom;
    const ids = keys(pending);
    for (let i = 0; i < ids.length; i += 1) {
      finish(Number(ids[i]), false, 'document-restored');
    }
    joining = null;
    leaving = null;
    if (resume) settled(net.join(), undefined, () => {});
  }, { capture: true });
  post('hello', 0, 'false');
})();`;
