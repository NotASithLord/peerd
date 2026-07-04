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
 * @param {boolean} [opts.a2a]   expose the `mesh` agent-to-agent client (capability-gated; the host relays a2a-request → SW a2a/call). Off by default.
 * @returns {Promise<{ source: string, cache: Map<string, { blobUrl: string, source: string }>, bodyLine: number }>}
 *   bodyLine: the 1-based source line the user code's first line lands on
 *   (user line L = source line bodyLine + L - 1) — feed it to mapWorkerError.
 */
export const buildWorkerSource = async (userCode, { entryPath = 'notebook.js', notebookId, resolverDeps, a2a = false }) => {
  const { imports, body, cache } = await buildEntry(userCode, entryPath, {
    ...resolverDeps,
    builtins: NOTEBOOK_BUILTINS,
  });
  const source = `import ${JSON.stringify(SEAL_MODULE_URL)}; // realm seal — MUST stay the first import
${imports}
const NOTEBOOK_ID = ${JSON.stringify(notebookId)};
const PEERD_BUILTINS = ${JSON.stringify(NOTEBOOK_BUILTINS)};
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

// --- worker↔host request/response bridges ---
// Every capability the worker reaches on the host (OPFS, the embedded subagent,
// base-network reads, the a2a mesh) speaks the SAME postMessage protocol: mint a
// monotonic rid, stash the resolver, post a '<name>-request', settle when the
// matching '<name>-response' lands. makeBridge is that protocol expressed ONCE;
// each bridge is then one line + a thin arg-shaping wrapper. why not fetch or
// display here: fetch is owned by the realm seal (its own listener, so untrusted
// code can't unseat it) and display is one-way (no reply to correlate).
const bridges = [];
const makeBridge = (name, { timeoutMs, shape } = {}) => {
  const pending = new Map();
  let seq = 0;
  const call = (payload = {}) => new Promise((resolve, reject) => {
    const rid = (seq += 1);
    pending.set(rid, { resolve, reject });
    postMessage({ type: name + '-request', rid, ...payload });
    if (timeoutMs) setTimeout(() => {
      // keep the op/method in the message — a stuck-bridge error is only
      // actionable if it says WHICH call hung (payload.op for opfs, .method for a2a).
      if (pending.delete(rid)) reject(new Error(name + ' ' + (payload.op || payload.method || 'call') + ' timed out'));
    }, timeoutMs);
  });
  // Returns true when the message was ours (routed by type), so the listener
  // stops — even if the rid already settled (a late reply after a timeout).
  const onResponse = (m) => {
    if (m.type !== name + '-response') return false;
    const p = pending.get(m.rid);
    if (p) {
      pending.delete(m.rid);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(shape ? shape(m.result) : m.result);
    }
    return true;
  };
  bridges.push({ onResponse });
  return call;
};

// --- peerd.* OPFS proxy ---
const opfsRelay = makeBridge('opfs', { timeoutMs: 15000 });
const opfsCall = (op, args) => opfsRelay({ op, args });
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
  // A BUILTIN (peerd:std) is not an OPFS file — the compose path would miss and
  // throw "cannot resolve". Import its real URL directly, same as the static
  // resolver does (the literal-specifier rewrite already does this at build
  // time; this covers the non-literal peerd.self.import(name) route).
  if (Object.prototype.hasOwnProperty.call(PEERD_BUILTINS, opfsPath)) {
    return import(PEERD_BUILTINS[opfsPath]);
  }
  const source = await opfsCall('compose-module', { path: opfsPath });
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  return import(url);
};

// --- peerd.runtime.runAgent (embedded agent) proxy ---
const subagentRelay = makeBridge('subagent');
const subagentCall = (args) => subagentRelay({ args });

// --- peerd.distributed.* (base-network read) proxy ---
// One message type ('distributed-request') fetches the whole base-network info
// blob; the distributed.* methods above each slice what they need. The host
// returns { ok, running, did, peers, presence } (or { ok:false, error }); we
// expose ok as "available" so the surface can render inert when dweb is off.
const distributedRelay = makeBridge('distributed', {
  shape: (result) => { const r = result ?? {}; return { available: r.ok === true, ...r }; },
});
const distributedInfo = () => distributedRelay({});

// --- peerd.mesh.* (agent-to-agent) proxy — capability-gated (a2a) ---
// The code the dweb actor writes drives peers through this client; each call
// leaves the sealed realm as an a2a-request the host relays to the SW a2a/call
// route (consent + gated mesh op). Signing calls (ask/send/publishCard) the SW
// gates; a reply/timeout comes back as a2a-response. why a 130s timeout: an ask
// awaits a peer's reply (the SW caps it at 120s), so the worker guard must sit
// ABOVE that, else the worker rejects a still-valid ask.
${a2a ? `
const meshRelay = makeBridge('a2a', { timeoutMs: 130000 });
const meshCall = (method, args) => meshRelay({ method, args });
const __mesh = {
  peers:       () => meshCall('peers', {}),
  card:        (did) => meshCall('card', { did }),
  ask:         (did, message, opts) => meshCall('ask', { did, message, timeoutMs: opts && opts.timeoutMs }),
  send:        (did, message) => meshCall('send', { did, message }),
  publishCard: (card) => meshCall('publishCard', { card }),
  inbox:       () => meshCall('inbox', {}),
};
globalThis.mesh = __mesh;
` : ''}

// ONE listener fans every '<name>-response' out to its bridge. Each bridge's
// onResponse claims only its own type, so registration order doesn't matter.
// ('fetch-response' is consumed by the realm seal's own listener, not here.)
self.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  for (const b of bridges) if (b.onResponse(m)) return;
});

const __start = performance.now();
(async () => {
__PEERD_BODY__})()
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
  // The 1-based source line the body's FIRST line lands on. Import extraction
  // preserves line positions (module-resolver re-inserts removed newlines), so
  // user line L sits at source line bodyLine + L - 1 — the offset mapWorkerError
  // needs to translate a blob-URL stack frame back to <entryPath>:<line>.
  const markerAt = source.indexOf('__PEERD_BODY__');
  const bodyLine = source.slice(0, markerAt).split('\n').length;
  // why a function replacement: a string replacement interprets `$&`/`$1` in
  // the BODY as substitution patterns and corrupts agent code containing them.
  return { source: source.replace('__PEERD_BODY__', () => `${body}\n`), cache, bodyLine };
};

/**
 * Map a worker error (a stack whose frames point into the entry blob URL) back
 * to user-code coordinates: `blob:…:<L>:<C>` → `<entryPath>:<L - bodyLine + 1>:<C>`.
 * Frames outside the body (the injected preamble) and other modules' blob URLs
 * are left untouched. Pure — shared by the Notebook tab and the headless
 * job runner so both surfaces report the same mapped location.
 *
 * @param {string | null | undefined} raw
 * @param {string} blobUrl      the entry worker's own blob URL
 * @param {number} bodyLine     from buildWorkerSource
 * @param {string} [entryPath]
 * @returns {string | null | undefined}
 */
export const mapWorkerError = (raw, blobUrl, bodyLine, entryPath = 'notebook.js') => {
  if (typeof raw !== 'string' || !raw || !blobUrl) return raw;
  const parts = raw.split(`${blobUrl}:`);
  if (parts.length === 1) return raw;
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    const m = /^(\d+):(\d+)/.exec(seg);
    const userLine = m ? Number(m[1]) - bodyLine + 1 : 0;
    out += (m && userLine >= 1)
      ? `${entryPath}:${userLine}:${m[2]}${seg.slice(m[0].length)}`
      : `${blobUrl}:${seg}`;
  }
  return out;
};
