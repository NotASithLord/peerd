// @ts-check
import { envelopeBytes } from '../transport/envelope.js';
import { MAX_GOSSIP_ENVELOPE_BYTES } from './topic.js';
import { MAX_SYNC_RESPONSE, syncResponsePages } from './sync-response.js';

// These ch=4 types are used only after authenticated HELLO negotiated
// topic-sync-window-v1. Legacy REQ/RESP stay single-frame; old peers cannot
// acknowledge processing, so an oversized legacy history fails visibly.
// ACK means the page was processed under current mute/retention policy, not
// that every entry was stored durably. There is no automatic retry or cursor.
export const WINDOW = Object.freeze({ REQ: 4, PAGE: 5, ACK: 6 });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXCHANGES = 16;
const PER_CHANNEL = 2;
const IDLE_MS = 30_000;
const LIFETIME_MS = 5 * 60_000;
const MAX_BYTES = MAX_SYNC_RESPONSE * MAX_GOSSIP_ENVELOPE_BYTES;
/** @param {any} body @param {string[]} keys */
const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));

/**
 * @param {{ work: ReturnType<import('./sync-work.js').createSyncWork>,
 * peer: (did: string) => any, supports: (did: string) => boolean,
 * retained: (topic: string) => boolean, history: (topic: string) => any[],
 * validHaves: (haves: any) => boolean, validInner: (inner: any, topic: string) => boolean,
 * accept: (envs: any[], topic: string, via: string, current: () => boolean) => Promise<boolean>,
 * sign: (typ: number, body: any) => Promise<any>,
 * send: (did: string, env: any, signal: AbortSignal) => Promise<boolean>,
 * audit?: ((type: string, detail?: any) => void) | null, timers?: any }} options
 */
export const createSyncWindow = ({ work, peer, supports, retained, history, validHaves, validInner,
  accept, sign, send, audit = null, timers = globalThis }) => {
  /** @typedef {{ id: string, did: string, topic: string, channel: any, direction: 'send'|'receive',
   * controller: AbortController, seq: number, awaiting: number, acknowledged: boolean,
   * final: boolean, running: boolean, count: number, bytes: number,
   * pages?: AsyncGenerator<any, void, unknown>, pending?: { did: string, env: any }, idle?: any, lifetime?: any }} Exchange */
  /** @type {Set<Exchange>} */
  const exchanges = new Set();
  let closed = false;
  /** @param {Exchange} state */
  const current = (state) => !closed && exchanges.has(state) && peer(state.did)?.channel === state.channel;
  /** @param {Exchange} state @param {string} [reason] */
  const retire = (state, reason) => {
    if (!exchanges.delete(state)) return;
    timers.clearTimeout(state.idle); timers.clearTimeout(state.lifetime);
    state.controller.abort();
    state.pending = undefined;
    work.retire();
    // Returning a generator releases its retained page references. If next()
    // is signing, its current() fence prevents the pending result from sending.
    state.pages?.return().catch(() => {});
    if (reason) audit?.('sync_window_stopped', { did: state.did, reason });
  };
  /** @param {Exchange} state */
  const progress = (state) => {
    timers.clearTimeout(state.idle);
    state.idle = timers.setTimeout(() => retire(state, 'progress-timeout'), IDLE_MS);
  };
  /** @param {'send'|'receive'} direction @param {string} did @param {string} topic @param {string} id */
  const reserve = (direction, did, topic, id) => {
    const channel = peer(did)?.channel;
    if (closed || !channel || !supports(did)) return null;
    const sameDirection = [...exchanges].filter((state) => state.direction === direction);
    if (sameDirection.length >= EXCHANGES || sameDirection.filter((state) => state.channel === channel).length >= PER_CHANNEL
      || sameDirection.some((state) => state.channel === channel && (state.id === id || state.topic === topic))) {
      audit?.('sync_window_overloaded', { did }); return null;
    }
    /** @type {Exchange} */
    const state = { direction, did, topic, id, channel, controller: new AbortController(), seq: 0,
      awaiting: -1, acknowledged: false, final: false, running: false, count: 0, bytes: 0 };
    exchanges.add(state);
    state.lifetime = timers.setTimeout(() => retire(state, 'lifetime-timeout'), LIFETIME_MS);
    progress(state);
    return state;
  };
  /** @param {Exchange} state @param {() => Promise<void>} task @param {() => void} [after] */
  const schedule = (state, task, after = () => {}) => {
    state.running = true;
    const done = work.run(state.channel, () => current(state), async () => {
      try { await task(); }
      catch { retire(state, 'processing-failed'); }
    });
    if (!done) { state.running = false; retire(state, 'work-overloaded'); return; }
    done.then(() => {
      state.running = false;
      if (current(state)) after();
      if (current(state) && !state.running && state.pending) {
        const pending = state.pending; state.pending = undefined;
        receive(pending.did, pending.env);
      }
    });
  };
  /** @param {Exchange} state */
  const advance = (state) => {
    if (!current(state) || state.running || (state.awaiting >= 0 && !state.acknowledged)) return;
    if (state.final && state.acknowledged) { retire(state); return; }
    schedule(state, async () => {
      const next = await state.pages?.next();
      if (!current(state)) return;
      if (!next || next.done) { retire(state); return; }
      const frame = next.value;
      state.awaiting = frame.body.seq;
      state.final = frame.body.done;
      state.acknowledged = false;
      // Set the expected ACK before send: an in-process carrier can deliver an
      // ACK before local send completion. after() joins both completions.
      if (!await send(state.did, frame, state.controller.signal)) { retire(state, 'send-failed'); return; }
      if (current(state)) progress(state);
    }, () => { if (state.acknowledged) advance(state); });
  };
  /** @param {string} did @param {string} topic @param {string[]} haves */
  const request = (did, topic, haves) => {
    if (!validHaves(haves) || !retained(topic)) return;
    const state = reserve('receive', did, topic, crypto.randomUUID());
    if (!state) return;
    schedule(state, async () => {
      const env = await sign(WINDOW.REQ, { id: state.id, topic, haves });
      if (current(state) && !await send(did, env, state.controller.signal)) retire(state, 'request-failed');
    });
  };
  /** @param {string} did @param {any} env */
  const receive = (did, env) => {
    if (closed || !supports(did)) return;
    const body = env.body;
    if (!body || typeof body.topic !== 'string' || !retained(body.topic) || typeof body.id !== 'string' || !ID.test(body.id)) return;
    const channel = peer(did)?.channel;
    if (!channel) return;
    if (env.typ === WINDOW.REQ) {
      if (!exact(body, ['id', 'topic', 'haves']) || !validHaves(body.haves)) return;
      const state = reserve('send', did, body.topic, body.id);
      if (!state) return;
      schedule(state, async () => {
        const known = new Set(body.haves);
        const entries = history(body.topic).filter((inner) => validInner(inner, body.topic) && !known.has(inner.sig)).slice(0, MAX_SYNC_RESPONSE);
        // Fixed entry/byte limits cover the whole exchange, not each page.
        let total = 0;
        for (const inner of entries) {
          const bytes = envelopeBytes(inner);
          if (bytes > MAX_GOSSIP_ENVELOPE_BYTES || (total += bytes) > MAX_BYTES) throw new Error('sync history exceeds budget');
        }
        state.pages = syncResponsePages({ topic: body.topic, envs: entries, current: () => current(state),
          maxFrameBytes: () => channel.maxFrameBytes?.() ?? Infinity,
          sign: (page, seq, done) => sign(WINDOW.PAGE, { ...page, id: state.id, seq, done }) });
      }, () => advance(state));
      return;
    }
    if (!Number.isInteger(body.seq) || body.seq < 0 || body.seq >= MAX_SYNC_RESPONSE) return;
    if (env.typ === WINDOW.ACK) {
      if (!exact(body, ['id', 'topic', 'seq'])) return;
      const state = [...exchanges].find((entry) => entry.direction === 'send' && entry.channel === channel
        && entry.id === body.id && entry.topic === body.topic);
      // ACKs take no worker slot. They can only release one already-issued page
      // belonging to this authenticated carrier, never create or extend work.
      if (!state || state.awaiting !== body.seq || state.acknowledged) return;
      state.acknowledged = true; progress(state); advance(state);
      return;
    }
    if (env.typ !== WINDOW.PAGE || !exact(body, ['id', 'topic', 'envs', 'seq', 'done'])
      || typeof body.done !== 'boolean' || !Array.isArray(body.envs) || body.envs.length > MAX_SYNC_RESPONSE) return;
    const state = [...exchanges].find((entry) => entry.direction === 'receive' && entry.channel === channel
      && entry.id === body.id && entry.topic === body.topic);
    if (!state || body.seq !== state.seq) return;
    if (state.running) {
      // One page can race local request/ACK send settlement. Retain only that
      // exact expected page, never a stream, and process it after slot release.
      state.pending ??= { did, env };
      return;
    }
    // Empty pages cannot keep an exchange alive; only an empty final first page
    // represents an empty history. Stop-and-wait needs no duplicate replay cache.
    if ((!body.envs.length && !(body.done && body.seq === 0))
      || body.envs.some((/** @type {any} */ inner) => !validInner(inner, body.topic))) { retire(state, 'invalid-page'); return; }
    const sizes = body.envs.map(envelopeBytes);
    const bytes = sizes.reduce((/** @type {number} */ sum, /** @type {number} */ size) => sum + size, 0);
    if (sizes.some((/** @type {number} */ size) => size > MAX_GOSSIP_ENVELOPE_BYTES)
      || state.count + body.envs.length > MAX_SYNC_RESPONSE || state.bytes + bytes > MAX_BYTES
      || (!body.done && body.seq + 1 >= MAX_SYNC_RESPONSE)) { retire(state, 'page-budget'); return; }
    state.count += body.envs.length; state.bytes += bytes;
    schedule(state, async () => {
      if (!await accept(body.envs, body.topic, did, () => current(state))) { retire(state, 'page-rejected'); return; }
      if (!current(state)) return;
      const ack = await sign(WINDOW.ACK, { id: state.id, topic: state.topic, seq: body.seq });
      if (!current(state)) return;
      // Advance before sending the ACK, but retain processing ownership until
      // send settles. Native RTC delivery is asynchronous; see pending-page seam.
      state.seq++;
      if (!await send(did, ack, state.controller.signal)) { retire(state, 'ack-failed'); return; }
      if (body.done) retire(state);
      else if (current(state)) progress(state);
    });
  };
  return {
    request, receive,
    retire() { for (const state of exchanges) if (!current(state)) retire(state, 'carrier-retired'); },
    stats: () => ({ send: [...exchanges].filter((state) => state.direction === 'send').length,
      receive: [...exchanges].filter((state) => state.direction === 'receive').length }),
    close() { closed = true; for (const state of [...exchanges]) retire(state); },
  };
};
