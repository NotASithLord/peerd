// @ts-check
// One semantic request over the fixed private controller protocol.

import { CONTROLLER_BUILD_DIGEST } from '../shared/build-config.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

const PROTOCOL = 2;
const OFFER = 'peerd/controller-channel';
const CAPABILITY = 'semantic.dispatch';
const MAX_BYTES = 256 * 1024;
const OPERATION = /^[a-z][a-z0-9./-]{0,127}$/;

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

/** @param {string} kind @param {boolean} outcomeKnown */
const stopped = (kind, outcomeKnown) => ({
  ok: false, code: `semantic-demand-${kind}`, outcomeKnown,
  phase: outcomeKnown ? 'startup' : 'run',
});

/**
 * @param {{target:any,identity:import('../shared/kernel-identity.js').KernelIdentity,
 * payload:unknown,authority:any,
 * kernelCall:(operation:string,payload:unknown,context:any)=>Promise<any>|any,
 * timeoutMs:number,signal?:AbortSignal}} input
 */
export const callSemanticDemandOnce = ({
  target, identity: injectedIdentity, payload, authority, kernelCall, timeoutMs, signal,
}) => {
  const identity = parseKernelIdentity(injectedIdentity);
  if (!identity || !identity.buildId.endsWith(`:${CONTROLLER_BUILD_DIGEST}`)
      || !target || typeof target.postMessage !== 'function'
      || typeof kernelCall !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1
      || !fits(payload) || authority?.ownerId !== 'peerd-authority-kernel'
      || authority?.target?.startsWith('semantic:') !== true
      || !['A', 'E'].includes(authority?.replayClass)) {
    return Promise.resolve(stopped('startup-failed', true));
  }
  if (signal?.aborted) return Promise.resolve(stopped('aborted', true));
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
    const fail = (/** @type {string} */ kind) => finish(stopped(kind, known()));
    const cancel = () => {
      try { post({ type: 'kernel/cancel', requestId, grantId }); } catch { /* retired */ }
    };
    const abort = () => { cancel(); fail('aborted'); };
    const timer = setTimeout(() => { cancel(); fail('timeout'); }, Math.max(1, timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    port1.onmessage = (event) => {
      const message = /** @type {any} */ (event.data);
      if (settled || !binding(message) || message.sequence !== received + 1) {
        fail('channel-lost'); return;
      }
      received = message.sequence;
      if (phase === 'handshake') {
        if (message.type !== 'controller/ready'
            || typeof message.hostEpoch !== 'string' || message.hostEpoch.length < 8
            || !Array.isArray(message.capabilities) || message.capabilities.length !== 1
            || message.capabilities[0] !== CAPABILITY) {
          fail('startup-failed'); return;
        }
        hostEpoch = message.hostEpoch;
        phase = 'opened';
        try { post({ type: 'kernel/open', requestId, grantId, deadlineAt,
          capability: CAPABILITY, authority, payload }); }
        catch { fail('channel-lost'); }
        return;
      }
      if (message.requestId !== requestId || message.grantId !== grantId) {
        fail('channel-lost'); return;
      }
      if (message.type === 'controller/rejected' && phase === 'opened') {
        finish({ ...(message.result ?? stopped('rejected', true)),
          outcomeKnown: true, phase: 'startup' }); return;
      }
      if (message.type === 'controller/accepted' && phase === 'opened') {
        phase = 'accepted';
        if (signal?.aborted) { abort(); return; }
        phase = 'committing';
        try { post({ type: 'kernel/commit', requestId, grantId }); }
        catch { fail('channel-lost'); }
        return;
      }
      if (message.type === 'controller/committed' && phase === 'committing') {
        phase = 'committed'; return;
      }
      if (message.type === 'controller/kernel-call'
          && (phase === 'committing' || phase === 'committed')) {
        const rpcId = message.rpcId;
        if (typeof rpcId !== 'string' || rpcId.length < 1 || rpcId.length > 512
            || reverse.has(rpcId) || reverse.size >= 3
            || !OPERATION.test(message.operation)) {
          fail('channel-lost'); return;
        }
        const reply = (/** @type {any} */ result) => {
          reverse.delete(rpcId);
          const bounded = fits(result) ? result : {
            ok: false, code: 'kernel-operation-result-too-large', outcomeKnown: false,
          };
          if (bounded?.outcomeKnown !== true) nestedUnknown = true;
          try { post({ type: 'kernel/kernel-result', requestId, grantId, rpcId, result: bounded }); }
          catch { fail('channel-lost'); }
        };
        if (!message.operation.startsWith('semantic.') || !fits(message.payload)) {
          reply({ ok: false, code: !message.operation.startsWith('semantic.')
            ? 'kernel-operation-denied' : 'kernel-operation-payload-too-large',
          outcomeKnown: true });
          return;
        }
        reverse.add(rpcId);
        Promise.resolve(kernelCall(message.operation, message.payload, {
          capability: CAPABILITY, authority, signal, deadlineAt,
        })).then(reply, () => reply({
          ok: false, code: 'kernel-operation-failed', outcomeKnown: false,
        }));
        return;
      }
      if (message.type === 'controller/settled'
          && (phase === 'committing' || phase === 'committed') && reverse.size === 0) {
        const result = message.result ?? stopped('empty-result', false);
        const value = result?.ok === true && Object.hasOwn(result, 'semanticResult')
          ? result.semanticResult : result;
        finish({ ...value, outcomeKnown: !nestedUnknown && result.outcomeKnown === true
          && value?.outcomeKnown !== false, phase: 'settled' }); return;
      }
      fail('channel-lost');
    };
    port1.onmessageerror = () => fail('channel-lost');
    port1.addEventListener?.('close', () => fail('channel-lost'), { once: true });
    port1.start();
    try {
      target.postMessage({
        type: OFFER, protocol: PROTOCOL, channelId,
        buildDigest: CONTROLLER_BUILD_DIGEST, kernelEpoch: identity.kernelEpoch,
        kernelIdentity: identity, capabilities: [CAPABILITY],
      }, [port2]);
    } catch { fail('startup-failed'); }
  });
};
