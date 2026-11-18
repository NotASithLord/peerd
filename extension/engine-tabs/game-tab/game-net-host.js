// @ts-check
import { DWEB_ENABLED } from '/shared/channel-config.js';
import { GAME_NET_LIMITS, gamePayload, gameRateLimit, gameRecipients } from '/shared/game-net.js';
import { GAME_NET_BINDING, GAME_NET_DELIVERY, gameNetPageScript } from './game-net-page.js';

/** @typedef {[string, unknown]} GameEvent */
/** @typedef {{id:string,context:number}} GameDocument */
/** @typedef {{channel:BroadcastChannel,epoch:string,last:number,ready:boolean,sequence:number}} GameChannel */

/** @param {{tabId:number,origin:string,appId:string,hash:string}} game */
export const createGameNet = ({ tabId, origin, appId, hash }) => {
  const token = crypto.randomUUID() + crypto.randomUUID();
  /** @param {string} method @param {Record<string,unknown>} [params] */
  const command = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  const publish = gameRateLimit(GAME_NET_LIMITS.publishRate, GAME_NET_LIMITS.publishBurst);
  const send = gameRateLimit(GAME_NET_LIMITS.sendRate, GAME_NET_LIMITS.sendBurst);
  const control = gameRateLimit(4, 8);
  /** @type {GameDocument|null} */ let doc = null;
  /** @type {GameChannel|null} */ let connection = null;
  /** @type {string|null} */ let delivery = null;
  /** @type {GameEvent[]} */ const messages = [];
  /** @type {GameEvent[]} */ const controls = [];
  /** @type {number|null} */ let pending = null;
  /** @type {number|null} */ let joinId = null;
  let wanted = false, connecting = false, flushing = false, retries = 0, retryAt = 0, errors = 0;
  let stopped = false, generation = 0;
  /** @type {ReturnType<typeof setInterval>|undefined} */ let heartbeat;

  const flush = async () => {
    if (flushing || !doc || errors >= 5 || !(controls.length || messages.length)) return;
    flushing = true;
    const current = doc;
    const events = [...controls.splice(0), ...messages.splice(0, 64)];
    try {
      if (!delivery) {
        const result = /** @type {{result?:{objectId?:string}}} */ (await command('Runtime.evaluate', {
          expression: `this.${GAME_NET_DELIVERY}`, contextId: current.context,
        }));
        if (doc !== current) return;
        delivery = result.result?.objectId ?? null;
      }
      if (!delivery) throw new Error('Game delivery entry unavailable.');
      const result = /** @type {{result?:{value?:unknown},exceptionDetails?:unknown}} */ (await command(
        'Runtime.callFunctionOn', {
          objectId: delivery,
          functionDeclaration: 'function(key, json) { "use strict"; return this(key, json); }',
          arguments: [{ value: token }, { value: JSON.stringify({ doc: current.id, events }) }],
          returnByValue: true,
        },
      ));
      if (result.exceptionDetails || result.result?.value !== true) throw new Error('Game delivery failed.');
      if (doc === current) errors = 0;
    } catch {
      if (doc === current) {
        controls.unshift(...events.filter(([type]) => type === 'reply'));
        delivery = null;
        errors += 1;
      }
    } finally {
      flushing = false;
      void flush();
    }
  };

  /** @param {string} type @param {unknown} data */
  const enqueue = (type, data) => {
    const queue = type === 'message' ? messages : controls;
    if (type === 'message') {
      if (queue.length === 1024) queue.shift();
    } else if (type !== 'reply') {
      const index = controls.findIndex(([kind]) => kind === type);
      if (index !== -1) controls.splice(index, 1);
    }
    queue.push([type, data]);
    void flush();
  };

  /** @param {number} id @param {unknown} [value] @param {string} [error] */
  const reply = (id, value, error) => enqueue('reply', { id, ok: !error, value, error });
  const closeChannel = () => {
    if (!connection) return;
    const { channel } = connection;
    connection = null;
    channel.postMessage({ op: 'leave' });
    channel.close();
  };
  /** @param {boolean} [newDocument] */
  const reset = (newDocument = false) => {
    generation += 1;
    closeChannel();
    wanted = false;
    joinId = null;
    pending = null;
    retries = 0;
    retryAt = 0;
    if (newDocument) {
      delivery = null;
      errors = 0;
      controls.length = 0;
    } else {
      for (let i = controls.length - 1; i >= 0; i -= 1) {
        if (controls[i][0] !== 'reply') controls.splice(i, 1);
      }
    }
    messages.length = 0;
  };
  const retry = () => {
    closeChannel();
    retryAt = performance.now() + [1, 2, 5, 10][Math.min(retries++, 3)] * 1000;
    enqueue('peers', []);
    enqueue('status', 'degraded');
  };

  const connect = async () => {
    if (connecting || !doc || !wanted || stopped) return;
    connecting = true;
    const current = generation;
    enqueue('status', 'connecting');
    try {
      const result = /** @type {{ok?:boolean,error?:string,channelId?:string,offscreenEpoch?:string}|undefined} */ (
        await chrome.runtime.sendMessage({ type: 'dweb/game/room', appId, hash }));
      if (current !== generation || !wanted || stopped) return;
      if (!result?.ok || !result.channelId || !result.offscreenEpoch) {
        const code = result?.error ?? 'unsupported';
        if (!['peer-network-off', 'locked', 'not-published', 'unsupported', 'no-net', 'already-playing', 'game-owner-mismatch', 'game-release-changed', 'kernel-route-unauthorized'].includes(code)) {
          retry();
          return;
        }
        if (pending !== null) reply(pending, undefined, code);
        pending = null;
        wanted = false;
        enqueue('status', 'unavailable');
        return;
      }
      const channel = new BroadcastChannel(result.channelId);
      const state = { channel, epoch: result.offscreenEpoch, last: performance.now(), ready: false, sequence: 0 };
      connection = state;
      channel.onmessage = ({ data }) => {
        if (state !== connection) return;
        if (data?.epoch !== state.epoch) { retry(); return; }
        if (!Number.isSafeInteger(data.sequence) || data.sequence <= state.sequence) return;
        state.sequence = data.sequence;
        state.last = performance.now();
        state.ready = data.online === true;
        if (state.ready && pending !== null && typeof data.self === 'string') {
          retries = 0;
          reply(pending, { self: data.self, limits: GAME_NET_LIMITS });
          pending = null;
        }
        if (Array.isArray(data.events)) {
          for (const [type, payload] of data.events) enqueue(type, payload);
        }
        if (data.beat === true) channel.postMessage({ op: 'heartbeat' });
      };
      channel.postMessage({ op: 'hello' });
    } catch {
      if (current === generation && wanted && !stopped) retry();
    } finally {
      connecting = false;
    }
  };

  return {
    async start() {
      await command('Runtime.enable');
      // why: the mask must be ready before Chromium can install the binding.
      await command('Page.addScriptToEvaluateOnNewDocument', { source: gameNetPageScript(origin, token) });
      await command('Runtime.addBinding', { name: GAME_NET_BINDING });
      if (stopped) return;
      heartbeat = setInterval(() => {
        if (!wanted) return;
        const now = performance.now();
        if (connection && now - connection.last > 3000) retry();
        if (!connection && now >= retryAt) void connect();
      }, 1000);
    },
    close() {
      stopped = true;
      clearInterval(heartbeat);
      doc = null;
      reset(true);
    },
    /** @param {object|undefined} parameters */
    onBinding(parameters) {
      if (stopped) return;
      const { name, payload, executionContextId } = /** @type {{name?:unknown,payload?:unknown,executionContextId?:number}} */ (parameters ?? {});
      if (name !== GAME_NET_BINDING || typeof executionContextId !== 'number'
          || typeof payload !== 'string' || payload.length > 8192 || !payload.startsWith(token)) return;
      try {
        const call = /** @type {unknown} */ (JSON.parse(payload.slice(token.length)));
        if (!Array.isArray(call) || call.length !== 4) return;
        const [id, op, requestId, body] = call;
        if (op === 'hello') {
          if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || requestId !== 0) return;
          reset(true);
          doc = { id, context: executionContextId };
          return;
        }
        if (!doc || doc.id !== id || doc.context !== executionContextId) return;
        if (op === 'cancel' && requestId === joinId) { reset(); return; }
        if (errors >= 5) return;
        const now = performance.now();
        if (op === 'join' || op === 'leave') {
          if (!Number.isSafeInteger(requestId) || requestId < 1) return;
          if (op === 'leave') {
            const previous = pending;
            reset();
            if (previous !== null) reply(previous, undefined, 'cancelled');
            enqueue('peers', []);
            reply(requestId);
          } else if (!DWEB_ENABLED || !control(now)) {
            reply(requestId, undefined, DWEB_ENABLED ? 'busy' : 'unsupported');
          } else {
            pending = requestId;
            joinId = requestId;
            wanted = true;
            void connect();
          }
          return;
        }
        if (!connection?.ready || requestId !== 0) return;
        if (op === 'publish' && publish(now) && gamePayload(body)) {
          connection.channel.postMessage({ op, data: body });
        } else if (op === 'send' && send(now) && Array.isArray(body) && body.length === 2
            && gameRecipients(body[0]) && gamePayload(body[1])) {
          connection.channel.postMessage({ op, ids: body[0], data: body[1] });
        }
      } catch { /* why: a game message cannot close the game. */ }
    },
  };
};
