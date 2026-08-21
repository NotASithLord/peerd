// @ts-check
// One-shot private-port semantic demand; route bodies remain lazy.

import { CONTROLLER_BUILD_DIGEST } from '../shared/build-config.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

const PROTOCOL = 2;
const OFFER = 'peerd/controller-channel';
const CAPABILITY = 'semantic.dispatch';
const MAX_BYTES = 256 * 1024;
const ROUTE = /^[a-z][a-z0-9-]*(?:[/.][A-Za-z0-9][A-Za-z0-9-]*){0,7}$/;
const OPERATION = /^[a-z][a-z0-9./-]{0,127}$/;
const REPLAYABLE = new Set([
  'semantic-demand-startup-failed', 'semantic-demand-channel-lost',
  'semantic-demand-timeout', 'controller-channel-closed',
  'controller-firefox-semantic-lifetime-lost',
]);
const stopped = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown) => ({
  ok: false, code, outcomeKnown, phase: outcomeKnown ? 'startup' : 'run',
});
const denied = () => stopped('semantic-demand-admission-denied', true);

const fits = (/** @type {unknown} */ root) => {
  const seen = new Set();
  const encoder = new TextEncoder();
  let bytes = 0;
  let nodes = 0;
  const add = (/** @type {number} */ count) => (bytes += count) <= MAX_BYTES;
  /** @param {unknown} value @param {number} depth @returns {boolean} */
  function walk(value, depth) {
    if (++nodes > 250_000 || depth > 32) return false;
    if (value == null || typeof value === 'boolean') return add(1);
    if (typeof value === 'number' || typeof value === 'bigint') return add(8);
    if (typeof value === 'string') return add(encoder.encode(value).byteLength);
    if (typeof value !== 'object') return false;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return add(value.byteLength);
    if (seen.has(value)) return false;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.every((entry) => walk(entry, depth + 1));
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor) || !add(encoder.encode(key).byteLength)
            || !walk(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally { seen.delete(value); }
  }
  return walk(root, 0);
};

/**
 * @param {{target:any,identity:import('../shared/kernel-identity.js').KernelIdentity,
 * payload:unknown,authority:any,kernelCall:(operation:string,payload:unknown,context:any)=>Promise<any>|any,
 * timeoutMs:number,signal?:AbortSignal}} input
 */
export const callSemanticDemandOnce = ({
  target, identity: injectedIdentity, payload, authority, kernelCall, timeoutMs,
  signal,
}) => {
  const identity = parseKernelIdentity(injectedIdentity);
  if (!identity || !identity.buildId.endsWith(`:${CONTROLLER_BUILD_DIGEST}`)
      || !target || typeof target.postMessage !== 'function'
      || typeof kernelCall !== 'function' || !fits(payload)) {
    return Promise.resolve(stopped('semantic-demand-startup-failed', true));
  }
  if (signal?.aborted) return Promise.resolve(stopped('semantic-demand-aborted', true));
  const [channelId, requestId, grantId] = Array.from({ length: 3 }, () => crypto.randomUUID());
  const { port1, port2 } = new MessageChannel();
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  let phase = 'handshake';
  let hostEpoch = /** @type {string|null} */ (null);
  let sent = 0;
  let received = 0;
  let nestedUnknown = false;
  let settled = false;
  /** @type {Set<string>} */ const reverse = new Set();
  const binding = (/** @type {any} */ message) => message?.protocol === PROTOCOL
    && message.channelId === channelId && message.buildDigest === CONTROLLER_BUILD_DIGEST
    && message.kernelEpoch === identity.kernelEpoch
    && (hostEpoch === null || message.hostEpoch === hostEpoch)
    && Number.isSafeInteger(message.sequence) && message.sequence > 0
    && typeof message.type === 'string';
  const post = (/** @type {Record<string,unknown>} */ message) => port1.postMessage({
    protocol: PROTOCOL, channelId, buildDigest: CONTROLLER_BUILD_DIGEST,
    kernelEpoch: identity.kernelEpoch, hostEpoch, sequence: ++sent, ...message,
  });
  return new Promise((resolve) => {
    const finish = (/** @type {any} */ result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reverse.clear();
      try { port1.close(); } catch { /* retired */ }
      resolve(result);
    };
    const known = () => phase === 'handshake' || phase === 'opened' || phase === 'accepted';
    const fail = (/** @type {string} */ code) => finish(stopped(code, known()));
    const abort = () => {
      try { post({ type: 'kernel/cancel', requestId, grantId }); } catch { /* retired */ }
      fail('semantic-demand-aborted');
    };
    const timer = setTimeout(() => {
      try { post({ type: 'kernel/cancel', requestId, grantId }); } catch { /* retired */ }
      fail('semantic-demand-timeout');
    }, Math.max(1, timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    port1.onmessage = (event) => {
      const message = /** @type {any} */ (event.data);
      if (settled || !binding(message) || message.sequence !== received + 1) {
        fail('semantic-demand-channel-lost'); return;
      }
      received = message.sequence;
      if (phase === 'handshake') {
        if (message.type !== 'controller/ready'
            || typeof message.hostEpoch !== 'string' || message.hostEpoch.length < 8
            || !Array.isArray(message.capabilities) || message.capabilities.length !== 1
            || message.capabilities[0] !== CAPABILITY) {
          fail('semantic-demand-startup-failed'); return;
        }
        hostEpoch = message.hostEpoch;
        phase = 'opened';
        try { post({ type: 'kernel/open', requestId, grantId, deadlineAt,
          capability: CAPABILITY, authority, payload }); }
        catch { fail('semantic-demand-channel-lost'); }
        return;
      }
      if (message.requestId !== requestId || message.grantId !== grantId) {
        fail('semantic-demand-channel-lost'); return;
      }
      if (message.type === 'controller/rejected' && phase === 'opened') {
        finish({ ...(message.result ?? stopped('semantic-demand-rejected', true)),
          outcomeKnown: true, phase: 'startup' }); return;
      }
      if (message.type === 'controller/accepted' && phase === 'opened') {
        phase = 'accepted';
        if (signal?.aborted) { abort(); return; }
        phase = 'committing';
        try { post({ type: 'kernel/commit', requestId, grantId }); }
        catch { fail('semantic-demand-channel-lost'); }
        return;
      }
      if (message.type === 'controller/committed' && phase === 'committing') {
        phase = 'committed'; return;
      }
      if (message.type === 'controller/kernel-call'
          && (phase === 'committing' || phase === 'committed')) {
        const rpcId = message.rpcId;
        if (typeof rpcId !== 'string' || rpcId.length > 512 || reverse.has(rpcId)
            || !OPERATION.test(message.operation) || reverse.size >= 3 || !fits(message.payload)) {
          fail('semantic-demand-channel-lost'); return;
        }
        reverse.add(rpcId);
        const reply = (/** @type {any} */ result) => {
          reverse.delete(rpcId);
          const bounded = fits(result) ? result : {
            ok: false, code: 'kernel-operation-result-too-large', outcomeKnown: false,
          };
          if (bounded?.outcomeKnown !== true) nestedUnknown = true;
          try { post({ type: 'kernel/kernel-result', requestId, grantId, rpcId, result: bounded }); }
          catch { fail('semantic-demand-channel-lost'); }
        };
        Promise.resolve(kernelCall(message.operation, message.payload, {
          capability: CAPABILITY, authority, signal, deadlineAt,
        })).then(reply, () => reply({
          ok: false, code: 'kernel-operation-failed', outcomeKnown: false,
        }));
        return;
      }
      if (message.type === 'controller/settled'
          && (phase === 'committing' || phase === 'committed')) {
        const result = message.result ?? stopped('semantic-demand-empty-result', false);
        const value = result?.ok === true && Object.hasOwn(result, 'semanticResult')
          ? result.semanticResult : result;
        finish({ ...value, outcomeKnown: !nestedUnknown && result.outcomeKnown === true
          && value?.outcomeKnown !== false,
          phase: 'settled' }); return;
      }
      fail('semantic-demand-channel-lost');
    };
    port1.onmessageerror = () => fail('semantic-demand-channel-lost');
    port1.addEventListener?.('close', () => fail('semantic-demand-channel-lost'), { once: true });
    port1.start();
    try {
      target.postMessage({
        type: OFFER, protocol: PROTOCOL, channelId,
        buildDigest: CONTROLLER_BUILD_DIGEST, kernelEpoch: identity.kernelEpoch,
        kernelIdentity: identity, capabilities: [CAPABILITY],
      }, [port2]);
    } catch { fail('semantic-demand-startup-failed'); }
  });
};

/**
 * @param {{routes:Record<string,{senderClass:string,replayClass:'A'|'E',
 * acceptsSender:(sender:unknown)=>boolean}>,clientOptions:Record<string,any>,
 * timeoutMs?:number,now?:()=>number}} deps
 */
export const createKernelSemanticDemand = ({
  routes, clientOptions, timeoutMs = 15_000, now = Date.now,
}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || typeof now !== 'function') {
    throw new TypeError('semantic-demand-deadline-invalid');
  }
  const table = new Map();
  for (const [route, descriptor] of Object.entries(routes ?? {})) {
    if (!ROUTE.test(route) || !descriptor || !/^[a-z][a-z0-9-]{0,31}$/.test(descriptor.senderClass)
        || !['A', 'E'].includes(descriptor.replayClass)
        || typeof descriptor.acceptsSender !== 'function') {
      throw new TypeError(`semantic-demand-route-invalid:${route}`);
    }
    table.set(route, Object.freeze({ ...descriptor }));
  }
  /** @type {Map<string,(operation:string,payload:unknown,context:any)=>Promise<any>|any>} */
  const handlers = new Map();
  let started = false;
  const kernelCall = async (/** @type {string} */ operation,
    /** @type {unknown} */ payload, /** @type {any} */ context) => {
    for (const handler of handlers.values()) {
      const result = await handler(operation, payload, context);
      if (result !== null) return result;
    }
    return { ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true };
  };
  const call = async (/** @type {unknown} */ payload, /** @type {any} */ authority,
    /** @type {number} */ remaining) => {
    if (typeof clientOptions.callDemand === 'function') {
      return clientOptions.callDemand(payload, { authority, kernelCall, timeoutMs: remaining });
    }
    if (clientOptions.firefoxDirect) {
      if (typeof clientOptions.callDirect !== 'function') {
        return stopped('semantic-demand-startup-failed', true);
      }
      return clientOptions.callDirect(payload, {
        authority, kernelCall, timeoutMs: remaining,
      });
    }
    let entered = false;
    const result = await clientOptions.withControllerLease(async () => {
      entered = true;
      const exact = (await clientOptions.listWindowClients())
        .filter((/** @type {any} */ candidate) => candidate?.url === clientOptions.offscreenUrl);
      if (exact.length !== 1) return stopped('semantic-demand-startup-failed', true);
      return callSemanticDemandOnce({
        target: exact[0], identity: clientOptions.kernelIdentity, payload, authority,
        kernelCall, timeoutMs: remaining,
      });
    });
    return entered ? result : stopped('semantic-demand-startup-failed', true);
  };
  const dispatch = async (/** @type {string} */ route,
    /** @type {unknown} */ message, /** @type {unknown} */ sender) => {
    const descriptor = table.get(route);
    if (!descriptor || !message || typeof message !== 'object'
        || /** @type {any} */ (message).type !== route
        || !descriptor.acceptsSender(sender)) return denied();
    started = true;
    const deadlineAt = now() + timeoutMs;
    const attempt = () => {
      const remaining = Math.max(0, deadlineAt - now());
      if (remaining < 1) return Promise.resolve(stopped('semantic-demand-timeout', true));
      const payload = Object.freeze({ protocol: 1, route, message });
      const authority = Object.freeze({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: `semantic:${route}:${descriptor.senderClass}`,
        replayClass: descriptor.replayClass,
      });
      return call(payload, authority, remaining);
    };
    const first = await attempt();
    return descriptor.replayClass === 'A' && first?.ok === false
      && REPLAYABLE.has(first?.code) && now() < deadlineAt ? attempt() : first;
  };
  const registerKernelHandler = (/** @type {string} */ name,
    /** @type {(operation:string,payload:unknown,context:any)=>Promise<any>|any} */ handler) => {
    if (started) throw new Error('semantic-kernel-registration-closed');
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name) || typeof handler !== 'function'
        || handlers.has(name)) throw new TypeError('semantic-kernel-handler-invalid');
    handlers.set(name, handler);
  };
  return Object.freeze({
    dispatch, registerKernelHandler, routes: Object.freeze([...table.keys()]),
  });
};
