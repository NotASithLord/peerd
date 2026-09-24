// @ts-check
// Preview/dev actor bootstrap. There are deliberately no static imports:
// extension Workers have ambient network and extension-origin storage until
// this first module removes them. Only then may the semantic runtime evaluate.
export {};

const denied = () => { throw new Error('actor ambient capability denied'); };
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
if (!seal(globalThis, 'browser', undefined)) sealFailures.push('browser');
if (!seal(globalThis, 'chrome', undefined)) sealFailures.push('chrome');
const realm = () => ({
  dedicatedWorker: globalThis.constructor?.name === 'DedicatedWorkerGlobalScope',
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

void (async () => {
  if (sealFailures.length > 0) throw new Error(`actor realm seal failed: ${sealFailures.join(', ')}`);
  const [{ startActorWorker }, { projectContributorSettlement }] = await Promise.all([
    import('/offscreen/actor-worker-runtime.js'),
    import('/peerd-runtime/controller-contributor.js'),
  ]);
  startActorWorker((result, program, metadata) => {
    const contributor = metadata.actorType === 'web' && metadata.backing === 'tab'
      ? projectContributorSettlement(result, program.provider, program.model) : null;
    return contributor ? { ...result, contributor } : result;
  }, realm);
})().catch((cause) => self.postMessage({
  type: 'error',
  error: cause instanceof Error ? cause.message : 'actor worker bootstrap failed',
}));
