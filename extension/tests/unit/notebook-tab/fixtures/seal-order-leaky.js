// @ts-check
// The "agent module" half of the seal-ordering fixture: its top-level
// body runs during module-graph evaluation — BEFORE the importing
// entry's own body — and immediately tries to open raw network channels,
// recording what happened for the entry to report.

/** @param {() => void} fn */
const attempt = (fn) => {
  try {
    fn();
    return { threw: false };
  } catch (e) {
    const err = /** @type {{ name?: string, message?: string }} */ (e);
    return { threw: true, name: err?.name ?? 'Error', message: String(err?.message ?? e) };
  }
};

// why: the seal-ordering probe is a bespoke channel the entry worker reads
// back off the global; cast through a writable view to attach it without
// augmenting the typed globalThis.
/** @type {{ __peerdSealOrderProbe: unknown }} */ (/** @type {unknown} */ (globalThis)).__peerdSealOrderProbe = {
  webSocket: attempt(() => new globalThis.WebSocket('wss://example.invalid/')),
  xhr: attempt(() => new globalThis.XMLHttpRequest()),
  fetchIsBridge: (() => {
    // The sealed bridge is an own, non-writable property; the native is
    // an inherited prototype method. Own + non-writable ⇒ the seal ran.
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    return Boolean(desc && desc.writable === false && desc.configurable === false);
  })(),
};
