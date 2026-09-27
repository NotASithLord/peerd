// @ts-check
import './pod-realm-seal.js'; // MUST remain the first import.
import { wasmerThreadPayload } from './wasmer-worker-proxy.js';

const sdkUrl = new URL('../../vendor/wasmer/pkg/wasmer_sdk_js.js', import.meta.url).href;
/** @type {MessageEvent[]} */ const pending = [];
/** @type {((event:MessageEvent)=>unknown)|null} */ let sdkHandler = null;
let accepted = false;

// why: The SDK imports the URL in its init message. Pin it before any SDK code.
addEventListener('message', (event) => {
  event.stopImmediatePropagation();
  const message = wasmerThreadPayload(event.data);
  if (!accepted) {
    if (message?.type !== 'init' || message.sdkUrl !== sdkUrl
        || !(message.module instanceof WebAssembly.Module)
        || !(message.memory instanceof WebAssembly.Memory)) {
      throw new TypeError('Invalid Wasmer thread initialization');
    }
    accepted = true;
    pending.push(event);
    import('../../vendor/wasmer/dist/browser-worker.js').then(() => {
      sdkHandler = globalThis.onmessage;
      if (!sdkHandler) throw new TypeError('Wasmer thread handler is unavailable');
      globalThis.onmessage = null;
      for (const queued of pending.splice(0)) sdkHandler(queued);
    }).catch((error) => globalThis.reportError(error));
    return;
  }
  if (message?.type === 'init') throw new TypeError('Wasmer thread is already initialized');
  if (sdkHandler) sdkHandler(event);
  else {
    if (pending.length >= 1024) throw new RangeError('Wasmer thread message limit reached');
    pending.push(event);
  }
});
