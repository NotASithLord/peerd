// @ts-check
import '../../../../../engine-tabs/pod-tab/wasmer-realm-seal.js'; // MUST remain the first import.
import { Wasmer } from '../../../../../vendor/wasmer/dist/index.js';
import { wasmer_napi_create_global_context } from '../../../../../vendor/wasmer/pkg/snippets/wasmer-napi-4dc421676e010b84/inline0.js';

/** @param {()=>unknown} operation */
const attempt = (operation) => {
  try { operation(); return { threw: false }; }
  catch (error) { return { threw: true, name: /** @type {Error} */ (error).name }; }
};

/** @param {any} target @param {string} name */
const inspect = (target, name) => {
  let prototypeCopy = false;
  for (let prototype = Object.getPrototypeOf(target); prototype; prototype = Object.getPrototypeOf(prototype)) {
    if (Object.getOwnPropertyDescriptor(prototype, name)) prototypeCopy = true;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (constructor?.prototype && Object.getOwnPropertyDescriptor(constructor.prototype, name)) prototypeCopy = true;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return { prototypeCopy, writable: descriptor?.writable, configurable: descriptor?.configurable };
};

addEventListener('message', (event) => {
  if (event.data?.type !== 'run-probes') return;
  const sdkUrl = new URL('../../../../../vendor/wasmer/dist/browser-worker.js', import.meta.url).href;
  // why: N-API captures host globals at import. Probe its real captured context.
  const context = /** @type {any} */ (wasmer_napi_create_global_context()).scope;
  const workerConstructor = Object.getPrototypeOf(globalThis.Worker.prototype).constructor;
  const inheritedWorker = /** @type {typeof Worker} */ (globalThis.Worker.prototype.constructor);
  const safeThread = new globalThis.Worker(sdkUrl, { type: 'module' });
  safeThread.terminate();
  postMessage({
    type: 'wasmer-seal-result',
    sdkImported: typeof Wasmer === 'function',
    probes: {
      fetch: attempt(() => globalThis.fetch('https://example.invalid/')),
      Worker: attempt(() => new globalThis.Worker('https://example.invalid/thread.js', { type: 'module' })),
      inheritedWorker: attempt(() => new inheritedWorker('https://example.invalid/thread.js', { type: 'module' })),
      rawOpfs: attempt(() => navigator.storage.getDirectory()),
      caches: attempt(() => globalThis.caches.open('peerd-seal-probe')),
      indexedDB: attempt(() => globalThis.indexedDB.open('peerd')),
      BroadcastChannel: attempt(() => new globalThis.BroadcastChannel('peerd-seal-probe')),
      napiFetch: attempt(() => context.fetch('https://example.invalid/')),
      napiWorker: attempt(() => new context.Worker('https://example.invalid/thread.js', { type: 'module' })),
      napiStorage: attempt(() => context.navigator.storage.getDirectory()),
      napiCaches: attempt(() => context.caches.open('peerd-seal-probe')),
      napiIndexedDB: attempt(() => context.indexedDB.open('peerd')),
      napiBroadcastChannel: attempt(() => new context.BroadcastChannel('peerd-seal-probe')),
    },
    inspection: Object.fromEntries(['fetch', 'Worker', 'caches', 'indexedDB', 'chrome', 'browser']
      .map((name) => [name, inspect(globalThis, name)])),
    storageInspection: inspect(navigator, 'storage'),
    inheritedWorkerIsRelay: inheritedWorker === globalThis.Worker,
    workerParentIsEventTarget: workerConstructor === EventTarget,
    napiWorkerIsRelay: context.Worker === globalThis.Worker,
    chromeAbsent: /** @type {any} */ (globalThis).chrome === undefined && context.chrome === undefined,
    browserAbsent: /** @type {any} */ (globalThis).browser === undefined && context.browser === undefined,
  });
});
postMessage({ type: 'fixture-ready' });
