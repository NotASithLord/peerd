// @ts-check
// Lightweight supervisor for the pure .peerd codec. The multi-MiB codec graph
// runs in a per-operation module Worker so compression or integrity checking
// cannot stall controller, dweb, media, or feature-lease heartbeats.

import {
  ARTIFACT_CHANNEL_MAX_BYTES,
  ARTIFACT_CHANNEL_PROTOCOL,
  ARTIFACT_WORKER_RUN,
  artifactChannelPayloadBytes,
  artifactChannelOperationAllowed,
  artifactChannelRequestAllowed,
  artifactChannelResultAllowed,
  collectArtifactTransferables,
  isArtifactChannelCancel,
  parseArtifactChannelOffer,
  serializeArtifactError,
} from '/shared/artifact-channel.js';

/** @param {MessagePort} port @param {unknown} value @param {Transferable[]} [transfer] */
const post = (port, value, transfer = []) => {
  try { port.postMessage(value, transfer); return true; }
  catch { return false; }
};

/** @param {{channelId:string,operation:string,args:any[]}} offer */
const createWorkerRun = (offer) => {
  const worker = new Worker(new URL('./artifact-worker.js', import.meta.url), {
    type: 'module',
    name: 'peerd-artifact-codec',
  });
  let settled = false;
  /** @type {(cause?:unknown)=>void} */
  let rejectRun = () => {};
  const promise = new Promise((resolve, reject) => {
    rejectRun = reject;
    worker.onmessage = (event) => {
      const reply = event.data;
      if (reply?.protocol !== ARTIFACT_CHANNEL_PROTOCOL
          || reply?.channelId !== offer.channelId
          || typeof reply?.ok !== 'boolean') return;
      settled = true;
      if (reply.ok) resolve(reply.value);
      else reject(reply.error ?? new Error('artifact codec failed'));
    };
    worker.onerror = (event) => {
      settled = true;
      reject(new Error(event.message || 'artifact codec worker failed'));
    };
    worker.onmessageerror = () => {
      settled = true;
      reject(new Error('artifact codec worker reply was invalid'));
    };
    try {
      worker.postMessage({
        type: ARTIFACT_WORKER_RUN,
        protocol: ARTIFACT_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        operation: offer.operation,
        args: offer.args,
      }, collectArtifactTransferables(offer.args));
    } catch (cause) {
      settled = true;
      reject(cause);
    }
  }).finally(() => { try { worker.terminate(); } catch { /* already stopped */ } });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch { /* already stopped */ }
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean}} */ (
        new Error('artifact codec operation was cancelled')
      );
      error.name = 'ArtifactOperationCancelledError';
      error.code = 'artifact-operation-cancelled';
      error.outcomeKnown = true;
      rejectRun(error);
    },
  };
};

/**
 * Stateful replay and resource fence for already-proven service-worker offers.
 * Sender and feature-lease provenance are checked by the tiny offscreen
 * supervisor before this lazy module is loaded.
 * @param {number | {
 *   replayMax?:number,
 *   maxConcurrent?:number,
 *   maxActiveBytes?:number,
 *   createRun?:((offer:{channelId:string,operation:string,args:any[]})=>{promise:Promise<unknown>,cancel:()=>void}),
 * }} [options]
 */
export const createArtifactOfferAcceptor = (options = {}) => {
  const config = typeof options === 'number' ? { replayMax: options } : options;
  const replayMax = config.replayMax ?? 1024;
  const maxConcurrent = config.maxConcurrent ?? 2;
  const maxActiveBytes = config.maxActiveBytes ?? ARTIFACT_CHANNEL_MAX_BYTES;
  const createRun = config.createRun;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const order = [];
  let activeCount = 0;
  let activeBytes = 0;
  const remember = (/** @type {string} */ channelId) => {
    if (seen.has(channelId)) return false;
    seen.add(channelId);
    order.push(channelId);
    if (order.length > replayMax) {
      const expiredChannelId = order.shift();
      if (expiredChannelId !== undefined) seen.delete(expiredChannelId);
    }
    return true;
  };
  /** @param {MessageEvent} event */
  return (event) => {
    const offer = parseArtifactChannelOffer(event.data);
    const ports = event.ports;
    const port = ports?.length === 1 ? ports[0] : null;
    if (!port || !offer) {
      for (const candidate of ports ?? []) {
        try { candidate.close(); } catch { /* invalid/closed */ }
      }
      return false;
    }
    if (!remember(offer.channelId)) {
      post(port, {
        protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
        ok: false, error: {
          name: 'ArtifactChannelReplayError',
          message: 'artifact channel was already used',
          outcomeKnown: true,
        },
      });
      port.close();
      return true;
    }
    if (!artifactChannelOperationAllowed(offer.operation)) {
      post(port, {
        protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
        ok: false, error: {
          name: 'ArtifactOperationDeniedError',
          message: 'artifact operation denied', outcomeKnown: true,
        },
      });
      port.close();
      return true;
    }
    if (!artifactChannelRequestAllowed(offer.operation, offer.args)) {
      post(port, {
        protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
        ok: false, error: {
          name: 'ArtifactPayloadTooLargeError',
          message: 'artifact operation payload exceeded its fixed limit',
          code: 'artifact-request-too-large', outcomeKnown: true, retryable: false,
        },
      });
      port.close();
      return true;
    }
    const requestBytes = artifactChannelPayloadBytes(offer.args);
    if (activeCount >= maxConcurrent || activeBytes + requestBytes > maxActiveBytes) {
      post(port, {
        protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
        ok: false, error: {
          name: 'ArtifactHostBusyError',
          message: 'artifact codec capacity is busy; retry this operation',
          code: 'artifact-host-busy', outcomeKnown: true, retryable: true,
        },
      });
      port.close();
      return true;
    }
    activeCount += 1;
    activeBytes += requestBytes;
    let cancelled = false;
    /** @type {{promise:Promise<unknown>,cancel:()=>void} | null} */
    let runner = null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      runner?.cancel();
    };
    port.onmessage = (message) => {
      if (isArtifactChannelCancel(message.data, offer.channelId)) cancel();
    };
    port.addEventListener?.('close', cancel, { once: true });
    port.start();
    try {
      runner = createRun
        ? createRun(/** @type {any} */ (offer))
        : createWorkerRun(/** @type {any} */ (offer));
    } catch (cause) {
      runner = { promise: Promise.reject(cause), cancel: () => {} };
    }
    runner.promise.then(
      (value) => {
        if (cancelled) return;
        if (!artifactChannelResultAllowed(offer.operation, value)) {
          post(port, {
            protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
            ok: false, error: {
              name: 'ArtifactPayloadTooLargeError',
              message: 'artifact codec result exceeded its fixed limit',
              code: 'artifact-result-too-large', outcomeKnown: true, retryable: false,
            },
          });
          return;
        }
        post(port, {
          protocol: ARTIFACT_CHANNEL_PROTOCOL,
          channelId: offer.channelId,
          ok: true,
          value,
        }, collectArtifactTransferables(value));
      },
      (cause) => {
        if (cancelled) return;
        post(port, {
          protocol: ARTIFACT_CHANNEL_PROTOCOL, channelId: offer.channelId,
          ok: false, error: serializeArtifactError(cause),
        });
      },
    ).finally(() => {
      activeCount -= 1;
      activeBytes -= requestBytes;
      try { port.close(); } catch { /* already closed */ }
    });
    return true;
  };
};

export const acceptArtifactOffer = createArtifactOfferAcceptor();
