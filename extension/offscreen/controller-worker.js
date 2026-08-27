// @ts-check
// Sealed controller Worker bootstrap. This file intentionally has no static
// imports: every ambient network/storage constructor is neutralized before the
// rich controller module can evaluate and capture it.

const denied = () => { throw new Error('controller ambient capability denied'); };
/** @type {string[]} */
const sealFailures = [];
const denyGlobal = (/** @type {string} */ name) => {
  try { Object.defineProperty(globalThis, name, { value: denied, configurable: false }); }
  catch { sealFailures.push(name); return; }
  if ((/** @type {Record<string, unknown>} */ (globalThis))[name] !== denied) sealFailures.push(name);
};

for (const name of [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
  'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCIceTransport',
  'RTCDataChannel', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB',
  'caches', 'importScripts',
]) denyGlobal(name);
const denyNavigator = (/** @type {string} */ name, /** @type {unknown} */ value) => {
  try { Object.defineProperty(navigator, name, { value: undefined, configurable: false }); }
  catch { sealFailures.push(`navigator.${name}`); return; }
  if ((/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (navigator)))[name] !== value) sealFailures.push(`navigator.${name}`);
};
denyNavigator('sendBeacon', undefined);
for (const name of ['storage', 'serviceWorker', 'locks']) denyNavigator(name, undefined);
const globals = /** @type {Record<string, unknown>} */ (globalThis);
const ABORT_CLEANUP_OPERATIONS = new Set([
  'turn.model.cancel-inference',
  'turn.model.cancel-local',
  'turn.abort.finalize',
  'turn.finalize',
  'turn.tool.settle',
]);
if (typeof globals.browser !== 'undefined') sealFailures.push('browser');
if (typeof globals.chrome !== 'undefined') sealFailures.push('chrome');

const realm = () => ({
  window: typeof globals.window !== 'undefined',
  document: typeof globals.document !== 'undefined',
  browser: typeof globals.browser !== 'undefined',
  chrome: typeof globals.chrome !== 'undefined',
  fetch: globals.fetch !== denied,
  xhr: globals.XMLHttpRequest !== denied,
  webSocket: globals.WebSocket !== denied,
  eventSource: globals.EventSource !== denied,
  webTransport: globals.WebTransport !== denied,
  rtc: globals.RTCPeerConnection !== denied,
  worker: globals.Worker !== denied,
  sharedWorker: globals.SharedWorker !== denied,
  broadcastChannel: globals.BroadcastChannel !== denied,
  indexedDB: globals.indexedDB !== denied,
  caches: globals.caches !== denied,
  opfsRoot: navigator.storage !== undefined,
  serviceWorker: navigator.serviceWorker !== undefined,
  locks: navigator.locks !== undefined,
  sendBeacon: navigator.sendBeacon !== undefined,
  importScripts: globals.importScripts !== denied,
});

const CONTROLLER_RUNTIME_URL = '/offscreen/controller-runtime.js';

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
    // Fixed packaged module, never a host-provided URL. The future controller
    // receives only audited kernel RPC and explicitly cloned directory handles.
    const module = await import(CONTROLLER_RUNTIME_URL);
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
    port.postMessage({ type: 'controller-worker/ready', realm: realm() });
  } catch (cause) {
    port.postMessage({
      type: 'controller-worker/error',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
addEventListener('message', onBootstrap);
