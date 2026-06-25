// @ts-check
// notebook-tab/worker-source.js — builds the sealed Notebook worker's source.
//
// SECURITY-CRITICAL + host-agnostic. This is the ONE place the worker realm is
// assembled: the realm seal as the FIRST import, the peerd.* capability surface,
// the postMessage bridges (fetch / opfs / subagent / display), and the entry
// IIFE. BOTH hosts use it — the visible Notebook tab (notebook-tab.js) and the
// headless offscreen job runner (offscreen/job-runner.js) — so the seal +
// surface can never diverge between them. Co-located with realm-seal.js +
// notebook-std.js so their URLs resolve against THIS module's location.
//
// Pure: returns { source, cache }. The caller injects `resolverDeps`
// (readFile / makeBlobUrl / log) — OPFS + logging differ per host — and owns
// blob-URL revocation via `cache`. The peerd:std builtin is added here so every
// host resolves it identically.

import { buildEntry } from '/peerd-engine/index.js';

// why absolute URLs: the worker entry is a blob; its FIRST static import must be
// the realm seal (ES module graphs evaluate depth-first in declaration order, so
// this guarantees the seal runs before any agent module body). peerd:std loads
// AFTER the seal and is pure. Both resolve against import.meta.url so they work
// on the extension origin AND the http origin the in-browser harness serves from.
const SEAL_MODULE_URL = new URL('./realm-seal.js', import.meta.url).href;
const STD_MODULE_URL = new URL('./notebook-std.js', import.meta.url).href;

// The bare-specifier → URL map both hosts feed the resolver. Exported so a host's
// own `compose-module` (dynamic-import) path resolves peerd:std the same way the
// static entry import does. Don't let it drift from buildEntry's builtins below.
export const NOTEBOOK_BUILTINS = { 'peerd:std': STD_MODULE_URL };

/**
 * Build the worker-entry source string for one run.
 *
 * @param {string} userCode
 * @param {Object} opts
 * @param {string} [opts.entryPath]   resolver entry name (default 'notebook.js')
 * @param {string} opts.notebookId    realm id surfaced as peerd.self.id
 * @param {{ readFile: (path: string) => Promise<string>, makeBlobUrl: (source: string) => string, log?: (entry: { type: string, path: string, blobUrl?: string, error?: string }) => void }} opts.resolverDeps  host-injected
 * @returns {Promise<{ source: string, cache: Map<string, { blobUrl: string, source: string }> }>}
 */
export const buildWorkerSource = async (userCode, { entryPath = 'notebook.js', notebookId, resolverDeps }) => {
  const { imports, body, cache } = await buildEntry(userCode, entryPath, {
    ...resolverDeps,
    builtins: NOTEBOOK_BUILTINS,
  });
  const source = `import ${JSON.stringify(SEAL_MODULE_URL)}; // realm seal — MUST stay the first import
${imports}
const NOTEBOOK_ID = ${JSON.stringify(notebookId)};
const consoleOutput = [];

const stringify = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
  try { return JSON.stringify(v); } catch { return String(v); }
};

const captureConsole = (level) => (...args) => {
  const text = args.map(stringify).join(' ');
  consoleOutput.push({ level, text });
  postMessage({ type: 'log', level, text });
};
console.log = captureConsole('info');
console.info = captureConsole('info');
console.warn = captureConsole('warn');
console.error = captureConsole('error');

// --- display sink ---
// Posts a value to the host's output (rendered by output-render.js: a table /
// chart descriptor → table / SVG, an array of rows → table, else JSON / text).
// JSON-clone-safe values only; anything else degrades to a string. Surfaced to
// author code as peerd.self.display (capability surface below).
const __peerdDisplay = (value) => {
  let safe;
  try { JSON.stringify(value); safe = value; }
  catch { safe = String(value); }
  postMessage({ type: 'display', value: safe });
};

// --- fetch ---
// Installed by the realm seal (first import above): global fetch IS the
// postMessage bridge to the host's audited webFetch, pinned non-configurable,
// with every raw network primitive hard-blocked. See notebook-neutralizers.js.
// The host side of the bridge is the 'fetch-request' handler.

// --- peerd.* OPFS proxy ---
const pendingOpfs = new Map();
let nextOpfsRid = 1;
const opfsCall = (op, args) => new Promise((resolve, reject) => {
  const rid = nextOpfsRid++;
  pendingOpfs.set(rid, { resolve, reject });
  postMessage({ type: 'opfs-request', rid, op, args });
  setTimeout(() => {
    if (pendingOpfs.has(rid)) {
      pendingOpfs.delete(rid);
      reject(new Error('opfs ' + op + ' timed out'));
    }
  }, 15000);
});
// ── The peerd capability surface ────────────────────────────────────────
// An artifact peerd builds (this Notebook today; Apps later) can call back into
// peerd and COMPOSE it — runAgent is the seed of that. Capabilities are grouped
// by the five modules ON PURPOSE: the module boundary doubles as the unit of
// AUTHORITY (DECISIONS #21). peerd.self is the ONE non-module bucket: the realm's
// OWN plumbing (its id, its module loader, its private OPFS scratch).
//
// STATUS: most methods are PLACEHOLDERS that throw. WIRED today: egress.fetch,
// runtime.runAgent, distributed.{whoami,status,peers,presence} (base-network
// READS, preview only — side-effect-free observation), all of self.
//
// SECURITY — READ BEFORE WIRING A PLACEHOLDER. This object is reachable from
// UNTRUSTED code (artifacts peerd generated; eventually Apps over the dweb).
// Wiring a capability for apps WITHOUT a per-app grant + quota is a vulnerability:
//   provider.call    → spends the user's API credits  → quota + explicit grant
//   engine.spawn*    → resource exhaustion / fork-bomb → hard per-app caps
//   runtime.runAgent → recursion (depth-capped); notify injects up → hostile input
//   distributed.*    → signs / publishes as the user   → preview-only, review
const notWired = (name) => () => {
  throw new Error('peerd.' + name + '() is a placeholder - that capability is '
    + 'not wired yet. See the capability map at the top of this block.');
};

globalThis.peerd = {
  // p · provider (cyan) — BYOK model access. PLACEHOLDER.
  provider: {
    listModels: notWired('provider.listModels'),
    call:       notWired('provider.call'),
  },
  // e · egress (red) — the audited network hole. WIRED. peerd.egress.fetch(url, {
  // method, headers, body }) rides the bridge to the host's audited webFetch
  // (SSRF + denylist + audit on every method). The seal blocks every other
  // network primitive (notebook-neutralizers.js).
  egress: {
    fetch: (url, init) => fetch(url, init),
  },
  // e · engine (amber) — execution environments. PLACEHOLDER. The sandbox
  // SPECTRUM (DECISIONS #25): runJob = headless own-code Worker (the MAIN agent
  // reaches it via the js_run tool); runUntrusted = headless opaque-origin iframe
  // for untrusted code. The peerd.* (app-spawns-a-job) forms stay notWired until
  // per-app grant + quota exist.
  engine: {
    spawnNotebook: notWired('engine.spawnNotebook'),
    spawnVm:      notWired('engine.spawnVm'),
    openApp:      notWired('engine.openApp'),
    runJob:       notWired('engine.runJob'),
    runUntrusted: notWired('engine.runUntrusted'),
  },
  // r · runtime (green) — the agent itself. WIRED: runAgent.
  runtime: {
    runAgent:     (args) => subagentCall(args ?? {}),
    notifyParent: notWired('runtime.notifyParent'),
    memory:       notWired('runtime.memory'),
  },
  // d · distributed (magenta) — the dweb. The always-on base network's READ
  // surface is WIRED (preview only): each method relays through the host to the
  // offscreen lobby host in ONE round-trip (distributed-request → dweb/distributed/
  // info) and slices the result. They OBSERVE the network — your did, the lobby
  // roster, who's present — and never join or sign, so no per-call grant. WRITES
  // stay deferred: publish/announce SIGN as the user, which can't land without a
  // per-realm grant + quota (DECISIONS #21); fetch (DHT/content read) is Phase 2.
  // Off preview, info() answers dweb-disabled → available:false, empty rosters.
  distributed: {
    whoami:   async () => { const i = await distributedInfo(); return { available: i.available, did: i.did ?? null }; },
    status:   async () => { const i = await distributedInfo(); return { available: i.available, running: !!i.running, rendezvous: i.rendezvous ?? 'none', peers: i.peerCount ?? 0, present: i.presentCount ?? 0, dhtSize: i.dhtSize ?? 0 }; },
    peers:    async () => (await distributedInfo()).peers ?? [],   // [{ did, name, linked, path, lastSeen }]
    presence: async () => (await distributedInfo()).peers ?? [],   // the live lobby roster (links ∪ gossip presence)
    publish:  notWired('distributed.publish'),
    announce: notWired('distributed.announce'),
    fetch:    notWired('distributed.fetch'),
  },
  // self — NOT a module. The realm's own identity + scratch + output; always
  // yours (realm-local plumbing). display() shows a value in this realm's output.
  self: {
    get id() { return NOTEBOOK_ID; },
    import:    (specifier) => globalThis.__peerd_dynamic_import(specifier),
    readFile:  (path) => opfsCall('read', { path }),
    writeFile: (path, content) => opfsCall('write', { path, content }),
    listFiles: () => opfsCall('list', {}),
    display:   (value) => { __peerdDisplay(value); return value; },
  },
};

// Dynamic import shim. Static imports resolve to host-realm blob URLs at build
// time and work via the worker's module loader. Dynamic import() of a host-realm
// blob URL fails to fetch (realm scoping), so we go through the host: it returns
// the fully-transformed source, we wrap it in a WORKER-realm blob URL, and
// dynamic-import that.
globalThis.__peerd_dynamic_import = async (opfsPath) => {
  const source = await opfsCall('compose-module', { path: opfsPath });
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  return import(url);
};

// --- peerd.runtime.runAgent (embedded agent) proxy ---
const pendingSubagents = new Map();
let nextSubagentRid = 1;
const subagentCall = (args) => new Promise((resolve, reject) => {
  const rid = nextSubagentRid++;
  pendingSubagents.set(rid, { resolve, reject });
  postMessage({ type: 'subagent-request', rid, args });
});

// --- peerd.distributed.* (base-network read) proxy ---
// One message type ('distributed-request') fetches the whole base-network info
// blob; the distributed.* methods above each slice what they need. The host
// returns { ok, running, did, peers, presence } (or { ok:false, error }); we
// expose ok as "available" so the surface can render inert when dweb is off.
const pendingDistributed = new Map();
let nextDistributedRid = 1;
const distributedInfo = () => new Promise((resolve, reject) => {
  const rid = nextDistributedRid++;
  pendingDistributed.set(rid, { resolve, reject });
  postMessage({ type: 'distributed-request', rid });
});

self.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'subagent-response') {
    const p = pendingSubagents.get(m.rid);
    if (!p) return;
    pendingSubagents.delete(m.rid);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
    return;
  }
  if (m.type === 'distributed-response') {
    const p = pendingDistributed.get(m.rid);
    if (!p) return;
    pendingDistributed.delete(m.rid);
    if (m.error) p.reject(new Error(m.error));
    else { const r = m.result ?? {}; p.resolve({ available: r.ok === true, ...r }); }
    return;
  }
  // ('fetch-response' is consumed by the realm seal's own listener.)
  if (m.type === 'opfs-response') {
    const p = pendingOpfs.get(m.rid);
    if (!p) return;
    pendingOpfs.delete(m.rid);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
    return;
  }
});

const __start = performance.now();
(async () => {
${body}
})()
  .then((value) => {
    let safe;
    try { JSON.stringify(value); safe = value; }
    catch { safe = String(value); }
    postMessage({
      type: 'done', value: safe, consoleOutput,
      durationMs: Math.round(performance.now() - __start),
    });
  })
  .catch((err) => {
    postMessage({
      type: 'done', value: undefined, consoleOutput,
      durationMs: Math.round(performance.now() - __start),
      error: err?.stack || (err?.name || 'Error') + ': ' + (err?.message || String(err)),
    });
  });
`;
  return { source, cache };
};
