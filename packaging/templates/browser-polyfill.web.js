// browser-polyfill.web.js — a no-throw page stand-in for the webextension
// -polyfill, swapped in for /vendor/browser-polyfill.js by the `web` packaging
// target (packaging/web-target.ts).
//
// why: the real vendored polyfill runs a module-scope check and THROWS
// "This script should only be loaded in a browser extension." whenever
// chrome.runtime.id is absent — i.e. on any normal web page. Every curated
// module that does `import browser from '/vendor/browser-polyfill.js'`
// (peerd-egress storage, a few shared/* helpers) would fail at load. This shim
// exports the same default `browser` object with the small surface those modules
// actually touch: page-backed where it matters (storage), inert where it has no
// meaning on a single page (runtime/tabs/windows messaging). The web target
// reaches real browser capability through the host adapters (tab manager,
// scripting), never through this shim.

const noop = () => {};
const asyncNoop = async () => {};

// chrome.storage promise shape: get(keys) resolves an object of the requested
// keys (object form treats values as defaults); set/remove/clear mutate.
const makeArea = (read, write) => ({
  async get(keys) {
    const all = read();
    if (keys == null) return { ...all };
    if (typeof keys === 'string') return keys in all ? { [keys]: all[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in all) out[k] = all[k];
      return out;
    }
    const out = {};
    for (const [k, dflt] of Object.entries(keys)) out[k] = k in all ? all[k] : dflt;
    return out;
  },
  async set(obj) { const all = read(); Object.assign(all, obj); write(all); },
  async remove(keys) { const all = read(); for (const k of (Array.isArray(keys) ? keys : [keys])) delete all[k]; write(all); },
  async clear() { write({}); },
});

// storage.local → localStorage (survives reload); storage.session → memory.
const LOCAL_KEY = 'peerd:web:storage.local';
const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; } };
const writeLocal = (all) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); } catch { /* quota/off */ } };
let sessionMem = {};

const messageListeners = new Set();

const browser = {
  runtime: {
    id: 'peerd-web',                                  // truthy so runtime.id guards pass
    getURL: (path) => (path?.startsWith('/') ? path : '/' + (path ?? '')),
    sendMessage: asyncNoop,
    connect: () => ({ postMessage: noop, disconnect: noop, onMessage: { addListener: noop }, onDisconnect: { addListener: noop } }),
    onMessage: {
      addListener: (fn) => messageListeners.add(fn),
      removeListener: (fn) => messageListeners.delete(fn),
      hasListener: (fn) => messageListeners.has(fn),
    },
    openOptionsPage: asyncNoop,
  },
  storage: {
    local: makeArea(readLocal, writeLocal),
    session: makeArea(() => sessionMem, (all) => { sessionMem = all; }),
  },
  // No browser tabs/windows on a page; the host adapters own real "tabs".
  tabs: { create: asyncNoop, update: asyncNoop, query: async () => [] },
  windows: { create: asyncNoop, update: asyncNoop },
  commands: { onCommand: { addListener: noop } },
  sidebarAction: { open: asyncNoop, close: asyncNoop },
};

export default browser;
