// @ts-check
// Firefox event-page adapter for the shared lazy-controller protocol.
//
// Chrome reaches bindControllerChannel through one exact offscreen WindowClient.
// Firefox already runs in a document-backed event page, so it creates the same
// private channel in-process and owns the sealed Dedicated Worker directly. No
// request, capability, epoch, or bearer authority is registered on
// runtime.onMessage.

import { connectOffscreenController } from './offscreen-controller-client.js';
import {
  bindControllerChannel,
} from '../offscreen/controller-shell.js';
import { isSealedControllerRealm } from '../shared/structured-clone-size.js';

const workerStopped = (/** @type {string} */ code, /** @type {string} */ error,
  /** @type {boolean} */ outcomeKnown = false) => ({
  ok: false,
  code,
  error,
  outcomeKnown,
  phase: outcomeKnown ? 'startup' : 'run',
  retryable: outcomeKnown,
});

/**
 * Lazy sealed-Worker facade used by the shared host-side controller binding.
 * The facade object is stable, but its Worker generation is discarded after an
 * idle interval and recreated on the next committed call. A Firefox event-page
 * recycle destroys this whole closure and therefore cannot reuse the old port.
 *
 * The worker entry is the same fixed, packaged controller-worker.js used by the
 * Chrome offscreen shell. It seals ambient network/storage before importing the
 * rich controller runtime.
 *
 * @param {Object} deps
 * @param {string} deps.workerUrl
 * @param {(url: string, options: WorkerOptions) => Worker} [deps.createWorker]
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.readyTimeoutMs]
 * @param {number} [deps.idleMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const makeIdleDirectControllerLoader = ({
  workerUrl,
  createWorker = (url, options) => new Worker(url, options),
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  readyTimeoutMs = 10_000,
  idleMs = 30_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  /** @type {Promise<ReturnType<typeof createGeneration>> | null} */
  let loading = null;
  /** @type {ReturnType<typeof createGeneration> | null} */
  let generation = null;
  let disposed = false;

  const createGeneration = () => {
    const worker = createWorker(workerUrl, { type: 'module', name: 'peerd-controller' });
    const { port1, port2 } = createChannel();
    /** @type {Map<string, {
     *   resolve: (value: any) => void,
     *   signal: AbortSignal,
     *   onAbort: () => void,
     *   kernelCall?: (operation:string, payload:unknown)=>Promise<any>,
     * }>} */
    const calls = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let idleTimer = null;
    let closed = false;
    let ready = false;
    let settleReady = (/** @type {boolean} */ _value) => {};
    const readyPromise = new Promise((resolve) => { settleReady = resolve; });

    const cancelIdle = () => {
      if (idleTimer !== null) clearTimeoutFn(idleTimer);
      idleTimer = null;
    };
    const finishCall = (/** @type {string} */ requestId, /** @type {any} */ result) => {
      const call = calls.get(requestId);
      if (!call) return;
      calls.delete(requestId);
      call.signal.removeEventListener('abort', call.onAbort);
      call.resolve(result);
      if (calls.size === 0 && !closed) {
        cancelIdle();
        idleTimer = setTimeoutFn(() => instance.close('controller-worker-idle'), Math.max(1, idleMs));
      }
    };
    const failCalls = (/** @type {string} */ code, /** @type {string} */ error) => {
      for (const requestId of [...calls.keys()]) finishCall(requestId, workerStopped(code, error));
    };
    const close = (reason = 'controller-worker-closed') => {
      if (closed) return;
      closed = true;
      cancelIdle();
      if (!ready) settleReady(false);
      failCalls(reason, 'sealed controller worker closed before settlement');
      try { port1.close(); } catch { /* already closed */ }
      try { worker.terminate(); } catch { /* already gone */ }
      if (generation === instance) generation = null;
    };
    const call = (
      /** @type {string} */ capability,
      /** @type {unknown} */ payload,
      /** @type {{ signal: AbortSignal, authority?: unknown, deadlineAt?: number,
       * kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} */ {
        signal, authority, deadlineAt, kernelCall,
      },
    ) => {
      if (closed) return Promise.resolve(workerStopped(
        'controller-worker-closed', 'sealed controller worker is closed',
      ));
      if (signal.aborted) return Promise.resolve(workerStopped(
        'controller-call-aborted', 'controller call was cancelled after commit',
      ));
      cancelIdle();
      const requestId = newId();
      return new Promise((resolve) => {
        const onAbort = () => {
          try { port1.postMessage({ type: 'controller-worker/cancel', requestId }); }
          catch { /* close/failure settles the call */ }
        };
        calls.set(requestId, { resolve, signal, onAbort, kernelCall });
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          port1.postMessage({
            type: 'controller-worker/call', requestId, capability, payload,
            authority, deadlineAt,
          });
        } catch {
          finishCall(requestId, workerStopped(
            'controller-worker-send-failed', 'controller call could not reach the sealed worker',
          ));
        }
      });
    };
    const instance = Object.freeze({ call, close, ready: readyPromise });

    const readyTimer = setTimeoutFn(() => close('controller-worker-ready-timeout'), readyTimeoutMs);
    port1.onmessage = (event) => {
      const message = /** @type {any} */ (event.data);
      if (message?.type === 'controller-worker/ready' && !ready && !closed) {
        if (!isSealedControllerRealm(message.realm)) {
          clearTimeoutFn(readyTimer);
          close('controller-worker-realm-unsealed');
          return;
        }
        ready = true;
        clearTimeoutFn(readyTimer);
        settleReady(true);
        return;
      }
      if (message?.type === 'controller-worker/error' && !ready) {
        clearTimeoutFn(readyTimer);
        close('controller-worker-startup-failed');
        return;
      }
      if (message?.type === 'controller-worker/kernel-call'
          && typeof message.requestId === 'string'
          && typeof message.rpcId === 'string'
          && typeof message.operation === 'string') {
        const activeCall = calls.get(message.requestId);
        const reply = (/** @type {any} */ result) => {
          try {
            port1.postMessage({
              type: 'controller-worker/kernel-result', requestId: message.requestId,
              rpcId: message.rpcId, result,
            });
          } catch { /* worker loss settles the outer operation */ }
        };
        if (!activeCall?.kernelCall) {
          reply({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
          return;
        }
        Promise.resolve(activeCall.kernelCall(message.operation, message.payload)).then(
          reply,
          (cause) => reply({
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
            outcomeKnown: false,
          }),
        );
        return;
      }
      if (message?.type !== 'controller-worker/result'
          || typeof message.requestId !== 'string') return;
      finishCall(message.requestId, message.result ?? workerStopped(
        'controller-worker-empty-result', 'controller worker returned no result',
      ));
    };
    port1.onmessageerror = () => close('controller-worker-message-error');
    port1.addEventListener('close', () => close('controller-worker-channel-closed'), { once: true });
    worker.addEventListener?.('error', () => close('controller-worker-crashed'), { once: true });
    worker.addEventListener?.(
      'messageerror', () => close('controller-worker-message-error'), { once: true },
    );
    port1.start();
    try { worker.postMessage({ type: 'controller-worker/bootstrap' }, [port2]); }
    catch { close('controller-worker-bootstrap-failed'); }
    return instance;
  };

  const ensureGeneration = async () => {
    if (disposed) throw new Error('direct controller loader is disposed');
    if (generation) return generation;
    loading ??= Promise.resolve().then(createGeneration).then(async (candidate) => {
      const ready = await candidate.ready;
      if (!ready) throw new Error('sealed controller worker did not become ready');
      if (disposed) {
        candidate.close('controller-worker-disposed');
        throw new Error('direct controller loader was disposed during startup');
      }
      generation = candidate;
      return candidate;
    }).finally(() => { loading = null; });
    return loading;
  };

  const controller = Object.freeze({
    call: async (
      /** @type {string} */ capability,
      /** @type {unknown} */ payload,
      /** @type {{ signal: AbortSignal }} */ options,
    ) => {
      try { return await (await ensureGeneration()).call(capability, payload, options); }
      catch (cause) {
        return workerStopped(
          'controller-worker-unavailable',
          cause instanceof Error ? cause.message : String(cause),
          true,
        );
      }
    },
  });
  return Object.freeze({
    load: async () => controller,
    dispose: () => {
      disposed = true;
      generation?.close('controller-worker-disposed');
      generation = null;
    },
  });
};

/**
 * Connect Firefox's event-page authority kernel to the exact same controller
 * state machine and call surface as Chrome. The only target-specific seam is
 * how the initial private MessagePort reaches bindControllerChannel.
 *
 * @param {Object} deps
 * @param {string[]} deps.capabilities
 * @param {string[]} deps.supportedCapabilities
 * @param {string} deps.buildDigest
 * @param {import('../shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 * @param {(capability: string, payload: unknown) => unknown} deps.authorizeCall
 * @param {(operation: string, payload: unknown, context: any) => Promise<any>|any} [deps.handleKernelCall]
 * @param {string} [deps.workerUrl]
 * @param {() => Promise<{ call: (capability: string, payload: unknown, options: { signal: AbortSignal }) => Promise<any> }>} [deps.loadController]
 * @param {() => void} [deps.disposeController]
 * @param {ReturnType<typeof makeIdleDirectControllerLoader>} [deps.loader]
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.handshakeTimeoutMs]
 * @param {number} [deps.callTimeoutMs]
 */
export const connectDirectController = async ({
  capabilities,
  supportedCapabilities,
  buildDigest,
  kernelIdentity,
  authorizeCall,
  handleKernelCall,
  workerUrl,
  loadController,
  disposeController = () => {},
  loader,
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  handshakeTimeoutMs,
  callTimeoutMs,
}) => {
  if (!loadController && !loader && typeof workerUrl !== 'string') {
    throw new Error('direct controller requires a fixed packaged workerUrl');
  }
  const ownedLoader = loader ?? (loadController ? null : makeIdleDirectControllerLoader({
    workerUrl: /** @type {string} */ (workerUrl), createChannel, newId,
  }));
  const load = loadController ?? /** @type {NonNullable<typeof ownedLoader>} */ (ownedLoader).load;
  /** @type {ReturnType<typeof bindControllerChannel> | null} */
  let host = null;
  const controller = await connectOffscreenController({
    ensureOffscreen: async () => {},
    capabilities,
    buildDigest,
    ...(kernelIdentity ? { kernelIdentity } : {}),
    authorizeCall,
    handleKernelCall,
    createChannel,
    newId,
    ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
    findHost: async () => ({
      postMessage: (/** @type {any} */ offer, /** @type {Transferable[]} */ transfer) => {
        if (host) throw new Error('direct controller host already connected');
        host = bindControllerChannel({
          port: /** @type {MessagePort} */ (transfer[0]),
          channelId: offer.channelId,
          buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch,
          ...(offer.kernelIdentity ? { kernelIdentity: offer.kernelIdentity } : {}),
          hostEpoch: newId(),
          offeredCaps: offer.capabilities,
          supportedCaps: supportedCapabilities,
          loadController: load,
        });
      },
    }),
  });
  return Object.freeze({
    ...controller,
    close: () => {
      controller.close();
      host?.close();
      ownedLoader?.dispose();
      disposeController();
    },
  });
};
