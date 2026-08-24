// @ts-check
// Sealed vault authority bootstrap. No static feature dependency evaluates
// before the ambient realm is removed; only a fixed packaged runtime is loaded.

export {};

const denied = () => { throw new Error('vault authority ambient capability denied'); };
/** @type {string[]} */
const sealFailures = [];
const denyGlobal = (/** @type {string} */ name) => {
  try { Object.defineProperty(globalThis, name, { value: denied, configurable: false }); }
  catch { sealFailures.push(name); return; }
  if ((/** @type {Record<string, unknown>} */ (globalThis))[name] !== denied) {
    sealFailures.push(name);
  }
};
for (const name of [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
  'EventSource', 'WebTransport', 'RTCPeerConnection', 'RTCDataChannel',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches',
  'importScripts',
]) denyGlobal(name);
for (const name of ['storage', 'serviceWorker', 'locks', 'sendBeacon']) {
  try { Object.defineProperty(navigator, name, { value: undefined, configurable: false }); }
  catch { sealFailures.push(`navigator.${name}`); }
}
const globals = /** @type {Record<string, unknown>} */ (globalThis);
if (typeof globals.browser !== 'undefined') sealFailures.push('browser');
if (typeof globals.chrome !== 'undefined') sealFailures.push('chrome');

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
