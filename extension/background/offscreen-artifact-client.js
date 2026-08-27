// @ts-check
// Demand-only .peerd artifact codec client. Chrome transfers the bounded
// operation over one exact ServiceWorker -> offscreen WindowClient channel;
// Firefox can import the same pure codec directly in its event page.

import {
  ARTIFACT_CHANNEL_CANCEL,
  ARTIFACT_CHANNEL_OFFER,
  ARTIFACT_CHANNEL_OPERATIONS,
  ARTIFACT_CHANNEL_PROTOCOL,
  artifactChannelOperationAllowed,
  artifactChannelRequestAllowed,
  artifactChannelResultAllowed,
  artifactOperationPolicy,
  parseArtifactChannelOffer,
} from '/shared/artifact-channel.js';
import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';

export {
  ARTIFACT_CHANNEL_OFFER,
  ARTIFACT_CHANNEL_OPERATIONS,
  ARTIFACT_CHANNEL_PROTOCOL,
  artifactChannelOperationAllowed,
  parseArtifactChannelOffer,
} from '/shared/artifact-channel.js';

/** @param {unknown} value */
const asError = (value) => {
  const record = value && typeof value === 'object' ? /** @type {any} */ (value) : {};
  const error = new Error(typeof record.message === 'string'
    ? record.message : 'artifact host failed');
  if (typeof record.name === 'string') error.name = record.name;
  for (const key of ['size', 'limit', 'reason', 'code', 'outcomeKnown', 'retryable']) {
    if (record[key] !== undefined) Object.defineProperty(error, key, {
      value: record[key], enumerable: true,
    });
  }
  return error;
};

/**
 * @param {Object} deps
 * @param {boolean} deps.offscreen
 * @param {string} deps.offscreenUrl
 * @param {<T>(operation:(lease?:unknown)=>Promise<T>)=>Promise<T>} deps.withHost
 * @param {(reason:string)=>Promise<any>} [deps.retireHost]
 * @param {() => Promise<any[]>} [deps.listWindowClients]
 * @param {() => Promise<any>} [deps.importLocal]
 * @param {<T>(operation:()=>Promise<T>,options?:{outcomeKnownOnLoss?:boolean,code?:string})=>Promise<T>} [deps.withLocalLifetime]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.localLoadTimeoutMs]
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const makeArtifactEngineClient = ({
  offscreen,
  offscreenUrl,
  withHost,
  retireHost = async () => {},
  listWindowClients = async () => {
    const clientApi = /** @type {any} */ (globalThis).clients;
    if (typeof clientApi?.matchAll !== 'function') return [];
    return clientApi.matchAll({ type: 'window', includeUncontrolled: true });
  },
  importLocal,
  withLocalLifetime = (operation) => operation(),
  newId = () => crypto.randomUUID(),
  timeoutMs,
  localLoadTimeoutMs = 10_000,
  createChannel = () => new MessageChannel(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!offscreen && typeof importLocal !== 'function') {
    throw new TypeError('artifact-local-loader-invalid');
  }
  const loadLocal = typeof importLocal === 'function' ? makeBoundedModuleLoader(importLocal, {
    timeoutMs: localLoadTimeoutMs,
    loadCode: 'artifact-local-load-failed',
    timeoutCode: 'artifact-local-load-timeout',
  }) : null;
  /** @type {Set<string>} */
  const issuedChannelIds = new Set();
  /** @type {string[]} */
  const issuedOrder = [];
  const rememberChannelId = (/** @type {string} */ channelId) => {
    if (issuedChannelIds.has(channelId)) return false;
    issuedChannelIds.add(channelId);
    issuedOrder.push(channelId);
    if (issuedOrder.length > 1024) {
      const expiredChannelId = issuedOrder.shift();
      if (expiredChannelId !== undefined) issuedChannelIds.delete(expiredChannelId);
    }
    return true;
  };
  const callLocal = async (/** @type {string} */ operation, /** @type {any[]} */ args) =>
    withLocalLifetime(async () => {
      const module = await loadLocal?.();
      const fn = module?.[operation];
      if (typeof fn !== 'function') throw new Error('artifact operation unavailable');
      return fn(...args);
    }, {
      outcomeKnownOnLoss: true,
      code: 'artifact-firefox-background-lost',
    });
  const callOffscreen = async (/** @type {string} */ operation, /** @type {any[]} */ args) => {
    try {
      return await withHost(async (lease) => {
      const matches = (await listWindowClients()).filter((client) => client?.url === offscreenUrl);
      if (matches.length !== 1) throw new Error('artifact host unavailable or ambiguous');
      const channelId = newId();
      if (!parseArtifactChannelOffer({
        type: ARTIFACT_CHANNEL_OFFER,
        protocol: ARTIFACT_CHANNEL_PROTOCOL,
        channelId,
        operation,
        args,
        lease,
      }) || !rememberChannelId(channelId)) {
        throw new Error('artifact channel identity invalid or reused');
      }
      const { port1, port2 } = createChannel();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (/** @type {any} */ value, /** @type {boolean} */ ok) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          try { port1.close(); } catch { /* already closed */ }
          if (ok) resolve(value); else reject(asError(value));
        };
        const operationTimeoutMs = timeoutMs ?? artifactOperationPolicy(operation)?.timeoutMs ?? 120_000;
        const timer = setTimeoutFn(() => {
          try {
            port1.postMessage({
              type: ARTIFACT_CHANNEL_CANCEL,
              protocol: ARTIFACT_CHANNEL_PROTOCOL,
              channelId,
            });
          } catch { /* already closed */ }
          finish({
            name: 'ArtifactHostTimeoutError',
            message: 'artifact codec timed out and was cancelled',
            code: 'artifact-host-timeout',
            outcomeKnown: true,
            retryable: true,
          }, false);
        }, operationTimeoutMs);
        port1.onmessage = (event) => {
          const reply = event.data;
          if (reply?.protocol !== ARTIFACT_CHANNEL_PROTOCOL
              || reply?.channelId !== channelId) return;
          if (reply.ok === true && !artifactChannelResultAllowed(operation, reply.value)) {
            finish({
              name: 'ArtifactPayloadTooLargeError',
              message: 'artifact host result exceeded its operation limit',
              code: 'artifact-result-too-large',
              outcomeKnown: true,
              retryable: false,
            }, false);
            return;
          }
          finish(reply.value ?? reply.error, reply.ok === true);
        };
        port1.onmessageerror = () => finish({
          name: 'ArtifactHostTransportError', message: 'artifact host reply was invalid',
        }, false);
        port1.addEventListener?.('close', () => finish({
          name: 'ArtifactHostTransportError', message: 'artifact host channel closed',
        }, false), { once: true });
        port1.start();
        try {
          matches[0].postMessage({
            type: ARTIFACT_CHANNEL_OFFER,
            protocol: ARTIFACT_CHANNEL_PROTOCOL,
            channelId,
            operation,
            args,
            lease,
          }, [port2]);
        } catch (cause) {
          finish({
            name: 'ArtifactHostTransportError',
            message: cause instanceof Error ? cause.message : String(cause),
          }, false);
        }
      });
      });
    } catch (cause) {
      if (/** @type {{name?:string}} */ (cause)?.name === 'ArtifactHostLoadError') {
        await retireHost('artifact-host-module-load-failed');
      }
      throw cause;
    }
  };
  const call = (/** @type {string} */ operation, /** @type {any[]} */ args) => {
    if (!artifactChannelOperationAllowed(operation)) {
      return Promise.reject(new Error('artifact operation denied'));
    }
    if (!artifactChannelRequestAllowed(operation, args)) {
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (
        new Error('artifact operation payload exceeds its fixed limit')
      );
      error.name = 'ArtifactPayloadTooLargeError';
      error.code = 'artifact-request-too-large';
      error.outcomeKnown = true;
      error.retryable = false;
      return Promise.reject(error);
    }
    return offscreen ? callOffscreen(operation, args) : callLocal(operation, args);
  };
  return Object.freeze(Object.fromEntries(ARTIFACT_CHANNEL_OPERATIONS.map((operation) => [
    operation, (/** @type {any[]} */ ...args) => call(operation, args),
  ])));
};
