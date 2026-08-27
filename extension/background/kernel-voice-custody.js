// @ts-check
// Exact voice authority: human-UI admission is owned by route provenance;
// this owner holds the media-host lifetime and addresses one physical host.

import { withDeadline } from '/shared/cold-util.js';
import {
  VOICE_CHANNEL_OFFER, VOICE_CHANNEL_PROTOCOL, VOICE_CHANNEL_RESULT, VOICE_COMMANDS,
  parseVoiceChannelOffer,
} from '/shared/voice-channel.js';

const STARTS_MEDIA = new Set(['voice/init', 'voice/listen']);

/** @param {any} result */
const featureLeaseFailure = (result) => Object.assign(
  new Error(result?.code ?? 'voice-host-unavailable'),
  { code: result?.code ?? 'voice-host-unavailable', outcomeKnown: result?.outcomeKnown === true },
);

/**
 * @param {Object} deps
 * @param {any} deps.featureHost
 * @param {string} deps.offscreenUrl
 * @param {boolean} deps.firefox
 * @param {(event:any)=>void} deps.emit
 * @param {()=>Promise<any[]>} [deps.listWindowClients]
 * @param {()=>any} [deps.getFirefoxLifetime]
 * @param {((emit:(event:any)=>any)=>any)|undefined} [deps.createFirefoxHost]
 * @param {()=>MessageChannel} [deps.createChannel]
 * @param {()=>string} [deps.newId]
 * @param {number} [deps.timeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createKernelVoiceCustody = ({
  featureHost,
  offscreenUrl,
  firefox,
  emit,
  listWindowClients = async () => {
    const clientApi = /** @type {any} */ (globalThis).clients;
    return typeof clientApi?.matchAll === 'function'
      ? clientApi.matchAll({ type: 'window', includeUncontrolled: true }) : [];
  },
  getFirefoxLifetime = () => null,
  createFirefoxHost,
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  timeoutMs = 15_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!featureHost?.runtime || typeof offscreenUrl !== 'string'
      || typeof firefox !== 'boolean' || typeof emit !== 'function'
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('kernel-voice-custody-config-invalid');
  }
  /** @type {any|null} */
  let firefoxHost = null;
  /** @type {any|null} */
  let firefoxLifetimeHandle = null;
  let firefoxActive = false;
  let tail = Promise.resolve();
  const queue = (/** @type {()=>Promise<any>} */ operation) => {
    const pending = tail.then(operation, operation);
    tail = pending.then(() => {}, () => {});
    return pending;
  };
  const directFirefoxHost = async () => {
    if (!firefoxHost) {
      if (typeof createFirefoxHost !== 'function') {
        throw new Error('voice-firefox-host-unavailable');
      }
      firefoxHost = createFirefoxHost(emit);
    }
    return firefoxHost;
  };
  const releaseFirefox = async (/** @type {boolean} */ teardownHost = true) => {
    try { if (teardownHost) await firefoxHost?.teardown?.(); }
    finally {
      firefoxActive = false;
      const handle = firefoxLifetimeHandle;
      firefoxLifetimeHandle = null;
      await handle?.stop?.();
    }
  };
  const callFirefox = async (/** @type {any} */ command) => {
    try {
      if (STARTS_MEDIA.has(command.type) && !firefoxActive) {
        const lifetime = getFirefoxLifetime();
        if (!lifetime?.createHandle) throw new Error('voice-firefox-lifetime-unavailable');
        firefoxLifetimeHandle = lifetime.createHandle();
        await firefoxLifetimeHandle.start();
        firefoxActive = true;
      } else if (!firefoxActive) return { ok: true, inactive: true };
      const result = await withDeadline(
        () => directFirefoxHost().then((host) => host.handle(command)),
        timeoutMs,
        () => new Error('voice-host-timeout'),
        setTimeoutFn,
        clearTimeoutFn,
      );
      if (STARTS_MEDIA.has(command.type) && result?.ok !== true) await releaseFirefox();
      if (command.type === 'voice/teardown') await releaseFirefox(false);
      return result;
    } catch (cause) {
      await releaseFirefox().catch(() => {});
      throw cause;
    }
  };
  const acquireChrome = async (/** @type {boolean} */ starts) => {
    const state = featureHost.runtime.snapshot().leases['media-host'];
    if (!starts && state?.status !== 'active') return null;
    const result = await featureHost.runtime.acquire('media-host', { reason: 'feature-demand' });
    if (!result?.ok || !result.lease) throw featureLeaseFailure(result);
    return result.lease;
  };
  const callChrome = async (/** @type {any} */ command) => {
    const lease = await acquireChrome(STARTS_MEDIA.has(command.type));
    if (!lease) return { ok: true, inactive: true };
    try {
      const clients = (await listWindowClients()).filter(
        (/** @type {any} */ client) => client?.url === offscreenUrl,
      );
      if (clients.length !== 1) throw new Error('voice-host-unavailable');
      const requestId = newId();
      const offer = {
        type: VOICE_CHANNEL_OFFER,
        protocol: VOICE_CHANNEL_PROTOCOL,
        requestId,
        command,
        lease,
      };
      if (!parseVoiceChannelOffer(offer)) throw new Error('voice-channel-offer-invalid');
      const { port1, port2 } = createChannel();
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        /** @type {{timer:ReturnType<typeof setTimeout>|undefined}} */
        const deadline = { timer: undefined };
        const finish = (/** @type {any} */ value, /** @type {boolean} */ ok) => {
          if (settled) return;
          settled = true;
          if (deadline.timer !== undefined) clearTimeoutFn(deadline.timer);
          try { port1.close(); } catch {}
          if (ok) resolve(value); else reject(value);
        };
        deadline.timer = setTimeoutFn(
          () => finish(new Error('voice-host-timeout'), false), timeoutMs,
        );
        port1.onmessage = (event) => {
          const reply = event.data;
          if (reply?.type !== VOICE_CHANNEL_RESULT
              || reply.protocol !== VOICE_CHANNEL_PROTOCOL
              || reply.requestId !== requestId) return;
          finish(reply.result, true);
        };
        port1.onmessageerror = () => finish(new Error('voice-channel-invalid'), false);
        port1.addEventListener?.(
          'close', () => finish(new Error('voice-channel-closed'), false), { once: true },
        );
        port1.start();
        try { clients[0].postMessage(offer, [port2]); }
        catch (cause) { finish(cause, false); }
      });
      if (STARTS_MEDIA.has(command.type) && result?.ok !== true) {
        await featureHost.runtime.revoke('media-host', 'feature-disabled');
      }
      if (command.type === 'voice/teardown') {
        await featureHost.runtime.revoke('media-host', 'feature-disabled');
      }
      return result;
    } catch (cause) {
      await featureHost.runtime.revoke('media-host', 'feature-disabled').catch(() => {});
      throw cause;
    }
  };
  const dispatch = (/** @type {any} */ command) => queue(
    () => firefox ? callFirefox(command) : callChrome(command),
  );
  const shapeCommand = (/** @type {string} */ type, /** @type {any} */ message) => {
    if (type === 'voice/init') return { type, variant: message.variant, engine: message.engine };
    if (type === 'voice/listen') return { type, targetId: message.targetId };
    if (type === 'voice/silence') return { type, ms: message.ms };
    return { type };
  };
  const routes = Object.freeze(Object.fromEntries(VOICE_COMMANDS.map((type) => [
    type,
    (/** @type {any} */ message = {}) => dispatch(shapeCommand(type, message)),
  ])));
  const teardown = () => queue(async () => {
    if (firefox) {
      if (!firefoxActive) return { ok: true, inactive: true };
      return callFirefox({ type: 'voice/teardown' });
    }
    return callChrome({ type: 'voice/teardown' });
  });
  return Object.freeze({ routes, teardown, active: () => firefox
    ? firefoxActive
    : featureHost.runtime.snapshot().leases['media-host']?.status === 'active' });
};
