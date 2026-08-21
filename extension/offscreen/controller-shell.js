// @ts-check
// Minimal offscreen supervisor for a controller hosted in a sealed Worker.

import {
  CONTROLLER_CHANNEL_OFFER,
  CONTROLLER_CHANNEL_PROTOCOL,
  isControllerBuildDigest,
  isControllerChannelMessage,
  isSealedControllerRealm,
  parseControllerAuthority,
  parseControllerCaps,
  controllerPayloadBytes,
  payloadFitsControllerCap,
} from '/shared/structured-clone-size.js';
import {
  controllerOuterPayloadCap,
  controllerRenewalIdleCap,
  createControllerKernelQuota,
} from '/shared/controller-kernel-quota.js';
import {
  kernelIdentityIsSuccessor,
  parseKernelIdentity,
} from '/shared/kernel-identity.js';

/**
 * Create the lazy loader used by bindControllerChannel. The offscreen document
 * remains a tiny transport supervisor; rich controller code evaluates only in
 * controller-worker.js after that Worker seals ambient network and storage.
 * @param {Object} deps
 * @param {string} deps.workerUrl
 * @param {(url: string, options: WorkerOptions) => Worker} [deps.createWorker]
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.readyTimeoutMs]
 */
export const makeSealedControllerLoader = ({
  workerUrl,
  createWorker = (url, options) => new Worker(url, options),
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  readyTimeoutMs = 10_000,
}) => {
  /** @type {Promise<{
 *   call: (capability: string, payload: unknown, options: {
 *     signal: AbortSignal, authority?: unknown, deadlineAt?: number,
 *     kernelCall?: (operation: string, payload: unknown) => Promise<any>,
 *   }) => Promise<any>,
   *   close: () => void,
   * }> | null} */
  let loading = null;
  /** @type {{ close: () => void } | null} */
  let active = null;
  const load = () => {
    if (loading) return loading;
    const attempt = new Promise((resolve, reject) => {
      const worker = createWorker(workerUrl, { type: 'module', name: 'peerd-controller' });
      const { port1, port2 } = createChannel();
      /** @type {Map<string, {
       *   resolve: (value: any) => void,
       *   signal: AbortSignal,
       *   onAbort: () => void,
       *   kernelCall?: (operation: string, payload: unknown) => Promise<any>,
       * }>} */
      const calls = new Map();
      let ready = false;
      let closed = false;
      const finishUnknown = () => {
        for (const call of calls.values()) {
          call.signal.removeEventListener('abort', call.onAbort);
          call.resolve({ ok: false, code: 'controller-worker-lost', outcomeKnown: false });
        }
        calls.clear();
      };
      const closeWorker = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        finishUnknown();
        try { port1.close(); } catch { /* already closed */ }
        try { worker.terminate(); } catch { /* already gone */ }
        if (active?.close === closeWorker) active = null;
        // A live generation can fail after its startup promise resolved. Do
        // not leave that settled promise cached: the next committed request
        // must create a fresh sealed Worker instead of calling a dead facade.
        loading = null;
      };
      const fail = (/** @type {string} */ message) => {
        const wasReady = ready;
        closeWorker();
        if (!wasReady) reject(new Error(message));
      };
      const timer = setTimeout(() => {
        fail('sealed controller worker did not become ready');
      }, readyTimeoutMs);
      port1.onmessage = (event) => {
        const message = /** @type {any} */ (event.data);
        if (message?.type === 'controller-worker/ready') {
          if (!isSealedControllerRealm(message.realm)) {
            fail('controller worker realm seal was not proven');
            return;
          }
          clearTimeout(timer);
          ready = true;
          const controller = {
            call: (
              /** @type {string} */ capability,
              /** @type {unknown} */ payload,
              /** @type {{ signal: AbortSignal, authority?: unknown, deadlineAt?: number,
               * kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} */ {
                signal, authority, deadlineAt, kernelCall,
              },
            ) => {
              if (closed) {
                return Promise.resolve({
                  ok: false, code: 'controller-worker-lost', outcomeKnown: false,
                });
              }
              if (signal.aborted) {
                return Promise.resolve({ ok: false, aborted: true, outcomeKnown: false });
              }
              const requestId = newId();
              return new Promise((resolveCall) => {
                const onAbort = () => {
                  try { port1.postMessage({ type: 'controller-worker/cancel', requestId }); }
                  catch { /* worker loss is post-commit unknown */ }
                };
                calls.set(requestId, { resolve: resolveCall, signal, onAbort, kernelCall });
                signal.addEventListener('abort', onAbort, { once: true });
                port1.postMessage({
                  type: 'controller-worker/call', requestId, capability, payload,
                  authority, deadlineAt,
                });
              });
            },
            close: closeWorker,
          };
          active = controller;
          resolve(controller);
          return;
        }
        if (message?.type === 'controller-worker/error') {
          fail(String(message.error ?? 'sealed controller worker startup failed'));
          return;
        }
        if (message?.type === 'controller-worker/kernel-call'
            && typeof message.requestId === 'string'
            && typeof message.rpcId === 'string'
            && typeof message.operation === 'string') {
          const call = calls.get(message.requestId);
          const reply = (/** @type {any} */ result) => {
            try {
              port1.postMessage({
                type: 'controller-worker/kernel-result', requestId: message.requestId,
                rpcId: message.rpcId, result,
              });
            } catch { /* worker loss settles the outer operation unknown */ }
          };
          if (!call?.kernelCall) {
            reply({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
            return;
          }
          Promise.resolve(call.kernelCall(message.operation, message.payload)).then(
            reply,
            (cause) => reply({
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
              outcomeKnown: false,
            }),
          );
          return;
        }
        if (message?.type !== 'controller-worker/result' || typeof message.requestId !== 'string') {
          return;
        }
        const call = calls.get(message.requestId);
        if (!call) return;
        calls.delete(message.requestId);
        call.signal.removeEventListener('abort', call.onAbort);
        call.resolve(message.result ?? { ok: false, outcomeKnown: false });
      };
      port1.onmessageerror = () => {
        fail('sealed controller worker channel failed');
      };
      worker.addEventListener?.('error', () => fail('sealed controller worker crashed'), { once: true });
      worker.addEventListener?.('messageerror', () => fail('sealed controller worker message failed'), { once: true });
      port1.start();
      worker.postMessage({ type: 'controller-worker/bootstrap' }, [port2]);
    });
    loading = attempt.catch((error) => {
      // A failed startup is not a permanent poison. A later committed request
      // receives a fresh sealed Worker generation.
      loading = null;
      throw error;
    });
    return loading;
  };
  load.close = () => {
    active?.close();
    active = null;
    loading = null;
  };
  return load;
};

/**
 * Bind one exact kernel epoch to the lazy controller loader.
 * @param {Object} deps
 * @param {MessagePort} deps.port
 * @param {string} deps.channelId
 * @param {string} deps.buildDigest
 * @param {string} deps.kernelEpoch
 * @param {import('/shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 * @param {string} deps.hostEpoch
 * @param {string[]} deps.offeredCaps
 * @param {string[]} deps.supportedCaps
 * @param {(() => Promise<{ call: (capability: string, payload: unknown, options: {
 *   signal: AbortSignal, authority?: unknown, deadlineAt?: number,
 *   kernelCall?: (operation: string, payload: unknown) => Promise<any>,
 * }) => Promise<any> }>) & { close?: () => void }} deps.loadController
 * @param {number} [deps.maxPayloadBytes]
 * @param {number} [deps.maxPending]
 * @param {number} [deps.maxPendingBytes]
 * @param {number} [deps.maxConcurrent]
 * @param {() => void} [deps.onClose]
 * @param {() => void} [deps.closeController]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 */
export const bindControllerChannel = ({
  port,
  channelId,
  buildDigest,
  kernelEpoch,
  kernelIdentity: injectedIdentity,
  hostEpoch,
  offeredCaps,
  supportedCaps,
  loadController,
  maxPayloadBytes = 256 * 1024,
  maxPending = 32,
  maxPendingBytes = 4 * 1024 * 1024,
  maxConcurrent = 4,
  onClose = () => {},
  closeController = () => loadController.close?.(),
  now = Date.now,
  newId = () => crypto.randomUUID(),
}) => {
  const capabilities = offeredCaps.filter((cap) => supportedCaps.includes(cap));
  const kernelIdentity = injectedIdentity ? parseKernelIdentity(injectedIdentity) : null;
  if (!isControllerBuildDigest(buildDigest)
      || typeof kernelEpoch !== 'string'
      || typeof hostEpoch !== 'string'
      || (injectedIdentity && (!kernelIdentity || kernelIdentity.kernelEpoch !== kernelEpoch))) {
    throw new Error('invalid controller channel binding');
  }
  const binding = { channelId, buildDigest, kernelEpoch, hostEpoch };
  /** @type {Map<string, {
   *   capability: string,
   *   payload: unknown,
   *   payloadBytes: number,
   *   grantId: string,
   *   deadlineAt: number,
   *   authority: NonNullable<ReturnType<typeof parseControllerAuthority>>,
   *   phase: 'accepted'|'committed',
   *   abort?: AbortController,
   *   deadlineTimer?: ReturnType<typeof setTimeout>,
   *   kernelCalls: Map<string, { resolve: (value:any) => void, operation:string, payload:unknown }>,
   *   quota: ReturnType<typeof createControllerKernelQuota>,
   * }>} */
  const operations = new Map();
  let concurrent = 0;
  let pendingBytes = 0;
  let closed = false;
  let sentSequence = 0;
  let receivedSequence = 0;

  const post = (/** @type {Record<string, unknown>} */ message) => port.postMessage({
    protocol: CONTROLLER_CHANNEL_PROTOCOL,
    channelId,
    buildDigest,
    kernelEpoch,
    hostEpoch,
    sequence: ++sentSequence,
    ...message,
  });
  const settle = (/** @type {string} */ requestId, /** @type {any} */ result) => {
    const operation = operations.get(requestId);
    if (!operation) return;
    if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
    for (const pending of operation.kernelCalls.values()) {
      pending.resolve({ ok: false, code: 'kernel-channel-lost', outcomeKnown: false });
    }
    operation.kernelCalls.clear();
    operations.delete(requestId);
    pendingBytes = Math.max(0, pendingBytes - operation.payloadBytes);
    if (operation.phase === 'committed') concurrent = Math.max(0, concurrent - 1);
    try { post({
      type: 'controller/settled', requestId, grantId: operation.grantId, result,
    }); }
    catch { /* retired kernel epoch */ }
  };
  const reject = (
    /** @type {string} */ requestId,
    /** @type {string} */ grantId,
    /** @type {string} */ code,
  ) => {
    post({
      type: 'controller/rejected',
      requestId,
      grantId,
      result: { ok: false, code, phase: 'startup', outcomeKnown: true },
    });
  };
  const armDeadline = (/** @type {string} */ requestId, /** @type {any} */ operation) => {
    if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
    operation.deadlineTimer = setTimeout(() => {
      operation.abort?.abort();
      settle(requestId, {
        ok: false, code: 'controller-deadline-expired', outcomeKnown: false,
      });
    }, Math.max(1, operation.deadlineAt - now()));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const operation of operations.values()) operation.abort?.abort();
    for (const operation of operations.values()) {
      if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
    }
    for (const operation of operations.values()) {
      for (const pending of operation.kernelCalls.values()) {
        pending.resolve({ ok: false, code: 'kernel-channel-lost', outcomeKnown: false });
      }
      operation.kernelCalls.clear();
    }
    operations.clear();
    pendingBytes = 0;
    concurrent = 0;
    closeController();
    try { port.close(); } catch { /* already closed */ }
    onClose();
  };

  port.onmessage = (event) => {
    if (!isControllerChannelMessage(event.data, binding) || closed) return;
    const message = /** @type {any} */ (event.data);
    if (message.sequence !== receivedSequence + 1) { close(); return; }
    receivedSequence = message.sequence;
    if (message.type === 'kernel/kernel-result') {
      if (typeof message.requestId !== 'string' || typeof message.rpcId !== 'string') {
        close(); return;
      }
      const operation = operations.get(message.requestId);
      const pending = operation?.kernelCalls.get(message.rpcId);
      if (!operation || !pending || message.grantId !== operation.grantId) {
        close(); return;
      }
      operation.kernelCalls.delete(message.rpcId);
      const observed = operation.quota.observe(
        pending.operation, pending.payload, message.result,
      );
      if (observed?.ok !== true) {
        pending.resolve(observed);
        settle(message.requestId, { ...observed, outcomeKnown: false });
        close();
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'kernel/open') {
      if (typeof message.requestId !== 'string' || operations.has(message.requestId)) return;
      const grantId = typeof message.grantId === 'string' ? message.grantId : '';
      const authority = parseControllerAuthority(message.authority);
      if (!grantId || grantId.length > 512 || !authority
          || !Number.isSafeInteger(message.deadlineAt)
          || message.deadlineAt <= now()) {
        if (typeof message.requestId === 'string') reject(
          message.requestId, grantId, 'grant-invalid',
        );
        return;
      }
      if (typeof message.capability !== 'string' || !capabilities.includes(message.capability)) {
        if (typeof message.requestId === 'string') reject(message.requestId, grantId, 'capability-denied');
        return;
      }
      if (operations.size >= maxPending) { reject(message.requestId, grantId, 'host-capacity'); return; }
      const outerCap = controllerOuterPayloadCap(message.capability);
      if (outerCap <= 0 || !payloadFitsControllerCap(message.payload, outerCap)) {
        reject(message.requestId, grantId, 'payload-too-large');
        return;
      }
      const payloadBytes = controllerPayloadBytes(message.payload);
      if (!Number.isFinite(payloadBytes) || pendingBytes + payloadBytes > maxPendingBytes) {
        reject(message.requestId, grantId, 'host-byte-capacity');
        return;
      }
      operations.set(message.requestId, {
        capability: message.capability,
        payload: message.payload,
        payloadBytes,
        grantId,
        deadlineAt: message.deadlineAt,
        authority,
        phase: 'accepted',
        kernelCalls: new Map(),
        quota: createControllerKernelQuota(message.capability, message.payload),
      });
      pendingBytes += payloadBytes;
      post({ type: 'controller/accepted', requestId: message.requestId, grantId });
      return;
    }
    if (typeof message.requestId !== 'string') return;
    const operation = operations.get(message.requestId);
    if (!operation) return;
    if (message.grantId !== operation.grantId) { close(); return; }
    if (message.type === 'kernel/renew') {
      const idleCap = controllerRenewalIdleCap(operation.capability);
      if (operation.phase !== 'committed' || idleCap <= 0
          || !Number.isSafeInteger(message.deadlineAt)
          || message.deadlineAt < operation.deadlineAt
          || message.deadlineAt > now() + idleCap + 1_000) {
        close();
        return;
      }
      operation.deadlineAt = message.deadlineAt;
      armDeadline(message.requestId, operation);
      return;
    }
    if (message.type === 'kernel/cancel') {
      if (operation.phase === 'accepted') {
        settle(message.requestId, {
          ok: false, code: 'controller-call-aborted', outcomeKnown: true,
        });
      } else {
        operation.abort?.abort();
      }
      return;
    }
    if (message.type !== 'kernel/commit' || operation.phase !== 'accepted') return;
    if (concurrent >= maxConcurrent) {
      settle(message.requestId, {
        ok: false, code: 'host-concurrency', outcomeKnown: true,
      });
      return;
    }
    operation.phase = 'committed';
    operation.abort = new AbortController();
    concurrent += 1;
    if (operation.deadlineAt <= now()) {
      settle(message.requestId, {
        ok: false, code: 'controller-deadline-expired', outcomeKnown: true,
      });
      return;
    }
    post({
      type: 'controller/committed', requestId: message.requestId,
      grantId: operation.grantId,
    });
    // The host owns an independent deadline. If the kernel event loop stalls
    // after commit, the sealed Worker still loses its grant on time and the
    // operation settles conservatively unknown rather than running forever.
    armDeadline(message.requestId, operation);
    // why load only here: accepted is custody without effects. The rich worker
    // graph and controller do not exist until the kernel commits a real call.
    // loadController coalesces a live generation itself. Resolve it per call
    // so a generation that crashes after startup can be replaced on the next
    // committed operation.
    Promise.resolve().then(loadController)
      .then((controller) => controller.call(operation.capability, operation.payload, {
        signal: /** @type {AbortController} */ (operation.abort).signal,
        authority: operation.authority,
        deadlineAt: operation.deadlineAt,
        kernelCall: (kernelOperation, payload) => {
          if (operation.phase !== 'committed'
              || operation.kernelCalls.size >= operation.quota.pendingCap
              || operation.deadlineAt <= now()
              || typeof kernelOperation !== 'string'
              || !/^[a-z][a-z0-9./-]{0,127}$/.test(kernelOperation)) {
            return Promise.resolve({
              ok: false, code: 'kernel-operation-invalid', outcomeKnown: true,
            });
          }
          const admitted = operation.quota.admit(kernelOperation, payload);
          if (admitted?.ok !== true) {
            return Promise.resolve(admitted);
          }
          const rpcId = newId();
          return new Promise((resolve) => {
            operation.kernelCalls.set(rpcId, {
              resolve, operation: kernelOperation, payload,
            });
            try {
              post({
                type: 'controller/kernel-call', requestId: message.requestId,
                grantId: operation.grantId, rpcId,
                operation: kernelOperation, payload,
              });
            } catch {
              operation.kernelCalls.delete(rpcId);
              resolve({ ok: false, code: 'kernel-channel-lost', outcomeKnown: false });
            }
          });
        },
      }))
      .then(
        (result) => settle(message.requestId, {
          ...result,
          // A successful settlement is evidence that the handler completed.
          // A post-dispatch failure is NOT evidence that no effect landed: the
          // controller must explicitly classify that exceptional safe case.
          outcomeKnown: result?.ok === true
            ? result?.outcomeKnown !== false
            : result?.outcomeKnown === true,
        }),
        (cause) => settle(message.requestId, {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: false,
        }),
      );
  };
  port.onmessageerror = close;
  port.addEventListener('close', close, { once: true });
  port.start();
  post({ type: 'controller/ready', capabilities });
  return Object.freeze({
    close, epoch: kernelEpoch, kernelEpoch, kernelIdentity,
    hostEpoch, channelId, buildDigest,
  });
};

/**
 * Own the one live controller epoch. Retired random epoch IDs can never be
 * re-adopted by delayed messages after a replacement service worker connects.
 * @param {Object} deps
 * @param {string} deps.expectedWorkerUrl
 * @param {string} deps.expectedBuildDigest
 * @param {string[]} deps.supportedCaps
 * @param {(() => Promise<any>) & { close?: () => void }} deps.loadController
 * @param {() => string} [deps.newId]
 */
export const makeControllerOfferHandler = ({
  expectedWorkerUrl,
  expectedBuildDigest,
  supportedCaps,
  loadController,
  newId = () => crypto.randomUUID(),
}) => {
  const retiredEpochs = new Set();
  /** @type {{ epoch: string, kernelIdentity?:unknown, close: () => void } | null} */
  let active = null;
  const handleOffer = (/** @type {MessageEvent} */ event) => {
    const source = /** @type {{ scriptURL?: string } | null} */ (event.source);
    const data = /** @type {any} */ (event.data);
    const offeredCaps = parseControllerCaps(data?.capabilities);
    const offeredIdentity = data?.kernelIdentity === undefined
      ? null : parseKernelIdentity(data.kernelIdentity);
    if (!event.isTrusted
        || source?.scriptURL !== expectedWorkerUrl
        || data?.type !== CONTROLLER_CHANNEL_OFFER
        || data?.protocol !== CONTROLLER_CHANNEL_PROTOCOL
        || typeof data?.channelId !== 'string'
        || data?.buildDigest !== expectedBuildDigest
        || !isControllerBuildDigest(data?.buildDigest)
        || typeof data?.kernelEpoch !== 'string'
        || (data?.kernelIdentity !== undefined
          && (!offeredIdentity || offeredIdentity.kernelEpoch !== data.kernelEpoch))
        || !offeredCaps
        || event.ports?.length !== 1) return false;
    if (retiredEpochs.has(data.kernelEpoch) || active?.epoch === data.kernelEpoch) {
      event.ports[0].close();
      return false;
    }
    if (active?.kernelIdentity && offeredIdentity
        && !kernelIdentityIsSuccessor(active.kernelIdentity, offeredIdentity)) {
      event.ports[0].close();
      return false;
    }
    if (active) {
      retiredEpochs.add(active.epoch);
      active.close();
    }
    active = bindControllerChannel({
      port: event.ports[0],
      channelId: data.channelId,
      buildDigest: data.buildDigest,
      kernelEpoch: data.kernelEpoch,
      ...(offeredIdentity ? { kernelIdentity: offeredIdentity } : {}),
      hostEpoch: newId(),
      offeredCaps,
      supportedCaps,
      loadController,
      onClose: () => {
        retiredEpochs.add(data.kernelEpoch);
        if (active?.epoch === data.kernelEpoch) active = null;
      },
    });
    return true;
  };
  // A feature-lease revocation must retire the exact controller epoch and its
  // sealed Worker rather than merely dropping the keepalive transport. A late
  // offer from that kernel generation then remains permanently fenced.
  handleOffer.close = () => {
    if (!active) {
      loadController.close?.();
      return;
    }
    retiredEpochs.add(active.epoch);
    const prior = active;
    active = null;
    prior.close();
  };
  return handleOffer;
};
