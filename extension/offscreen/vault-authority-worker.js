// @ts-check
// Sealed vault authority bootstrap. No static feature dependency evaluates
// before the ambient realm is removed; only a fixed packaged runtime is loaded.

export {};

const denied = () => { throw new Error('vault authority ambient capability denied'); };
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
  'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCIceTransport', 'RTCDataChannel',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches',
  'importScripts',
]) denyGlobal(name);
for (const name of ['storage', 'serviceWorker', 'locks', 'sendBeacon']) {
  if (!seal(navigator, name, undefined)) sealFailures.push(`navigator.${name}`);
}
if (!seal(globalThis, 'browser', undefined)) sealFailures.push('browser');
if (!seal(globalThis, 'chrome', undefined)) sealFailures.push('chrome');

const onBootstrap = async (/** @type {MessageEvent} */ event) => {
  if (event.data?.type !== 'vault-authority-worker/bootstrap'
      || event.data?.protocol !== 1
      || typeof event.data?.channelId !== 'string'
      || event.ports?.length !== 1) return;
  removeEventListener('message', onBootstrap);
  const port = event.ports[0];
  if (sealFailures.length > 0) {
    port.postMessage({
      type: 'vault-authority/result', protocol: 1,
      channelId: event.data.channelId, requestId: 'bootstrap-error', ok: false,
      error: `vault authority realm seal failed: ${sealFailures.join(', ')}`,
    });
    port.close(); close(); return;
  }
  denyGlobal('postMessage');
  try {
    const prototypeFetchBlocked = await recoveredPrototypeCapabilityBlocked(
      globalThis, 'fetch', 'data:text/plain,vault-authority-seal-probe',
    );
    const prototypeStorageBlocked = await recoveredPrototypeCapabilityBlocked(
      navigator, 'storage', undefined,
    );
    if (!prototypeFetchBlocked || !prototypeStorageBlocked) {
      throw new Error('vault authority prototype capability remained reachable');
    }
    const { serveVaultAuthority } = await import('./vault-authority-runtime.js');
    await serveVaultAuthority({ port, channelId: event.data.channelId });
    close();
  } catch (cause) {
    try {
      port.postMessage({
        type: 'vault-authority/result', protocol: 1,
        channelId: event.data.channelId, requestId: 'bootstrap-error', ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } catch { /* closed */ }
    try { port.close(); } catch { /* closed */ }
    close();
  }
};
addEventListener('message', onBootstrap);
