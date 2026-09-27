// @ts-check
import { applyRealmSeal } from '../notebook-tab/notebook-neutralizers.js';
import { createWasmerWorkerProxy } from './wasmer-worker-proxy.js';

// why: Only the trusted host can create native Workers. This realm holds a relay.
export const wasmerThreads = createWasmerWorkerProxy(
  (message) => postMessage(message),
  new URL('../../vendor/wasmer/dist/browser-worker.js', import.meta.url).href,
);
applyRealmSeal(globalThis, {
  environment: 'Wasmer Pod',
  exposeGlobalFetch: false,
  blockHostStorage: true,
  blockExtensionApis: true,
  workerConstructor: wasmerThreads.Worker,
});
addEventListener('message', (event) => wasmerThreads.receive(event.data));
