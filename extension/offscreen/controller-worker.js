// @ts-check
// Sealed controller Worker bootstrap. This file intentionally has no static
// imports: every ambient network/storage constructor is neutralized before the
// rich controller module can evaluate and capture it.

const denied = () => { throw new Error('controller ambient capability denied'); };
/** @type {string[]} */
const sealFailures = [];
const sealedThroughPrototype = (
  /** @type {any} */ target, /** @type {string} */ name, /** @type {unknown} */ value,
) => {
  let own = true;
  for (let object = target; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) { own = false; continue; }
    if (!own || descriptor.configurable || descriptor.value !== value
        || descriptor.writable !== false) return false;
    own = false;
  }
  return true;
};
const seal = (
  /** @type {any} */ target, /** @type {string} */ name, /** @type {unknown} */ value,
) => {
  for (let object = target; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) continue;
    if (!descriptor.configurable) {
      if (object !== target || descriptor.value !== value || descriptor.writable !== false) {
        return false;
      }
      continue;
    }
    try { delete object[name]; } catch { return false; }
  }
  try {
    Object.defineProperty(target, name, {
      value, writable: false, configurable: false, enumerable: false,
    });
  } catch { return false; }
  return sealedThroughPrototype(target, name, value);
};
const recoveredPrototypeCapabilityBlocked = async (
  /** @type {any} */ target, /** @type {string} */ name, /** @type {unknown} */ argument,
) => {
  for (let object = Object.getPrototypeOf(target); object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) continue;
    try {
      const recovered = typeof descriptor.get === 'function'
        ? descriptor.get.call(target) : descriptor.value;
      if (typeof recovered === 'function') {
        await Promise.resolve(recovered.call(target, argument)).catch(() => {});
      } else if (recovered && typeof recovered.getDirectory === 'function') {
        await Promise.resolve(recovered.getDirectory()).catch(() => {});
      }
    } catch { /* a throwing recovered primitive is still reachable */ }
    return false;
  }
  return true;
};
const denyGlobal = (/** @type {string} */ name) => {
  if (!seal(globalThis, name, denied)) sealFailures.push(name);
};

for (const name of [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
  'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCIceTransport',
  'RTCDataChannel', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB',
  'caches', 'importScripts',
]) denyGlobal(name);
const denyNavigator = (/** @type {string} */ name) => {
  if (!seal(navigator, name, undefined)) sealFailures.push(`navigator.${name}`);
};
denyNavigator('sendBeacon');
for (const name of ['storage', 'serviceWorker', 'locks']) denyNavigator(name);
const globals = /** @type {Record<string, unknown>} */ (globalThis);
const ABORT_CLEANUP_OPERATIONS = new Set([
  'turn.model.cancel-inference',
  'turn.model.cancel-local',
  'turn.abort.finalize',
  'turn.finalize',
]);
if (!seal(globalThis, 'browser', undefined)) sealFailures.push('browser');
if (!seal(globalThis, 'chrome', undefined)) sealFailures.push('chrome');

const realm = () => ({
  window: typeof globals.window !== 'undefined',
  document: typeof globals.document !== 'undefined',
  browser: !sealedThroughPrototype(globalThis, 'browser', undefined),
  chrome: !sealedThroughPrototype(globalThis, 'chrome', undefined),
  fetch: !sealedThroughPrototype(globalThis, 'fetch', denied),
  xhr: !sealedThroughPrototype(globalThis, 'XMLHttpRequest', denied),
  webSocket: !sealedThroughPrototype(globalThis, 'WebSocket', denied),
  eventSource: !sealedThroughPrototype(globalThis, 'EventSource', denied),
  webTransport: !sealedThroughPrototype(globalThis, 'WebTransport', denied),
  rtc: !sealedThroughPrototype(globalThis, 'RTCPeerConnection', denied),
  worker: !sealedThroughPrototype(globalThis, 'Worker', denied),
  sharedWorker: !sealedThroughPrototype(globalThis, 'SharedWorker', denied),
  broadcastChannel: !sealedThroughPrototype(globalThis, 'BroadcastChannel', denied),
  indexedDB: !sealedThroughPrototype(globalThis, 'indexedDB', denied),
  caches: !sealedThroughPrototype(globalThis, 'caches', denied),
  opfsRoot: !sealedThroughPrototype(navigator, 'storage', undefined),
  serviceWorker: !sealedThroughPrototype(navigator, 'serviceWorker', undefined),
  locks: !sealedThroughPrototype(navigator, 'locks', undefined),
  sendBeacon: !sealedThroughPrototype(navigator, 'sendBeacon', undefined),
  importScripts: !sealedThroughPrototype(globalThis, 'importScripts', denied),
});

const onBootstrap = async (/** @type {MessageEvent} */ event) => {
  if (event.data?.type !== 'controller-worker/bootstrap' || event.ports?.length !== 1) return;
  removeEventListener('message', onBootstrap);
  const port = event.ports[0];
  if (sealFailures.length > 0) {
    port.postMessage({
      type: 'controller-worker/error',
      error: `controller realm seal failed: ${sealFailures.join(', ')}`,
    });
    port.close();
    return;
  }
  // No future ambient postMessage channel: all traffic is bound to this port.
  denyGlobal('postMessage');
  if (sealFailures.length > 0) {
    port.postMessage({ type: 'controller-worker/error', error: 'controller postMessage seal failed' });
    port.close();
    return;
  }
  try {
    const prototypeFetchBlocked = await recoveredPrototypeCapabilityBlocked(
      globalThis, 'fetch', 'data:text/plain,controller-seal-probe',
    );
    const prototypeStorageBlocked = await recoveredPrototypeCapabilityBlocked(
      navigator, 'storage', undefined,
    );
    if (!prototypeFetchBlocked || !prototypeStorageBlocked) {
      throw new Error('controller prototype capability remained reachable');
    }
    // Fixed packaged module, never a host-provided URL. The future controller
    // receives only audited kernel RPC and explicitly cloned directory handles.
    const module = await import('/offscreen/controller-runtime.js');
    const controller = await module.createController();
    /** @type {Map<string, {
     *   abort: AbortController,
     *   kernelCalls: Map<string, { resolve: (value:any) => void }>,
     * }>} */
    const calls = new Map();
    port.onmessage = (callEvent) => {
      const message = /** @type {any} */ (callEvent.data);
      if (message?.type === 'controller-worker/cancel' && typeof message.requestId === 'string') {
        calls.get(message.requestId)?.abort.abort();
        return;
      }
      if (message?.type === 'controller-worker/kernel-result'
          && typeof message.requestId === 'string'
          && typeof message.rpcId === 'string') {
        const call = calls.get(message.requestId);
        const pending = call?.kernelCalls.get(message.rpcId);
        if (!call || !pending) return;
        call.kernelCalls.delete(message.rpcId);
        pending.resolve(message.result ?? {
          ok: false, code: 'kernel-empty-result', outcomeKnown: false,
        });
        return;
      }
      if (message?.type !== 'controller-worker/call'
          || typeof message.requestId !== 'string'
          || typeof message.capability !== 'string'
          || calls.has(message.requestId)) return;
      const abort = new AbortController();
      /** @type {Map<string, { resolve: (value:any) => void }>} */
      const kernelCalls = new Map();
      calls.set(message.requestId, { abort, kernelCalls });
      const kernelCall = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
        if (abort.signal.aborted && !ABORT_CLEANUP_OPERATIONS.has(operation)) {
          return Promise.resolve({ ok: false, code: 'controller-call-aborted', outcomeKnown: false });
        }
        const rpcId = crypto.randomUUID();
        return new Promise((resolve) => {
          kernelCalls.set(rpcId, { resolve });
          try {
            port.postMessage({
              type: 'controller-worker/kernel-call', requestId: message.requestId,
              rpcId, operation, payload,
            });
          } catch {
            kernelCalls.delete(rpcId);
            resolve({ ok: false, code: 'kernel-channel-lost', outcomeKnown: false });
          }
        });
      };
      Promise.resolve(controller.call(message.capability, message.payload, {
        signal: abort.signal,
        authority: message.authority,
        deadlineAt: message.deadlineAt,
        kernelCall,
      }))
        .then(
          (result) => port.postMessage({
            type: 'controller-worker/result', requestId: message.requestId, result,
          }),
          (error) => port.postMessage({
            type: 'controller-worker/result', requestId: message.requestId,
            result: {
              ok: false, outcomeKnown: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }),
        )
        .finally(() => {
          for (const pending of kernelCalls.values()) {
            pending.resolve({ ok: false, code: 'controller-call-settled', outcomeKnown: false });
          }
          kernelCalls.clear();
          calls.delete(message.requestId);
        });
    };
    port.start();
    port.postMessage({
      type: 'controller-worker/ready', realm: realm(),
      prototypeFetchBlocked, prototypeStorageBlocked,
    });
  } catch (cause) {
    port.postMessage({
      type: 'controller-worker/error',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
addEventListener('message', onBootstrap);
