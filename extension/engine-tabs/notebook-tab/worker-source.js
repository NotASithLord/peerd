// @ts-check
// notebook-tab/worker-source.js — builds the sealed Notebook worker's source.
//
// SECURITY-CRITICAL + host-agnostic. This is the ONE place the worker realm is
// assembled: the realm seal as the FIRST import, the peerd.* capability surface,
// the postMessage bridges (fetch / opfs / actor / display), and the entry
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
const POD_SEAL_MODULE_URL = new URL('../pod-tab/pod-realm-seal.js', import.meta.url).href;
const STD_MODULE_URL = new URL('./notebook-std.js', import.meta.url).href;
const WASI_MODULE_URL = new URL('./notebook-wasi.js', import.meta.url).href;

// The bare-specifier → URL map both hosts feed the resolver. Exported so a host's
// own `compose-module` (dynamic-import) path resolves the builtins the same way
// the static entry import does. Don't let it drift from buildEntry's builtins
// below. peerd:wasi is pure compute over caller-built capabilities (its own
// header has the security story), so exposing it everywhere peerd:std goes adds
// no authority to the realm.
export const NOTEBOOK_BUILTINS = { 'peerd:std': STD_MODULE_URL, 'peerd:wasi': WASI_MODULE_URL };

// The default capability profile — the surface every worker had before profiles
// existed. A caller that passes nothing gets EXACTLY the historical worker.
// why a profile at all: the web actor's code-REPL arm (PR #119) runs
// MODEL-AUTHORED page-driving code in this same sealed worker, and its actor
// deliberately holds NO egress / subagent / opfs (an actor that ingests
// untrusted page text must not also wield those — the exclusion IS the
// boundary, exposure.js). The profile is enforced TWICE: here (the surface is
// absent / throws inside the realm) and in the HOST relay (job-runner.js
// refuses the bridge message), so a seal escape alone doesn't re-open a lane.
// caps.provider (design 5) is OFF by default EVERYWHERE: it spends the user's
// paid key, so only the script tool mints it — per-run, and only when the code
// actually references peerd.provider.
// why distributed defaults true: the wired base-network reads are the
// historical tab surface (the Notebook host answers 'distributed-request');
// the headless job runner forces it off — it has no handler, so without the
// in-realm throw a touch of peerd.distributed.* would hang to the job
// wall-clock (design 7.3).
export const DEFAULT_WORKER_CAPS = Object.freeze({
  page: false, egress: true, subagent: true, opfs: true, provider: false, distributed: true,
});

/**
 * Build the worker-entry source string for one run.
 *
 * @param {string} userCode
 * @param {Object} opts
 * @param {string} [opts.entryPath]   resolver entry name (default 'notebook.js')
 * @param {string} opts.notebookId    realm id surfaced as peerd.self.id
 * @param {import('/peerd-engine/module-resolver.js').ResolverDeps} opts.resolverDeps  host-injected (fetchRemote only in egress-capable lanes — module-resolver.js)
 * @param {boolean} [opts.a2a]   expose the `mesh` agent-to-agent client (capability-gated; the host relays a2a-request → SW a2a/call). Off by default.
 * @param {boolean} [opts.actors] expose the `actors` delegation client (capability-gated; the host relays actors-request → SW actors/call). Off by default.
 * @param {string} [opts.siteFetch] DESIGN-19: expose the `site` client PINNED to this origin (site.fetch → the host site-fetch-request relay → SW site-fetch/call). Off by default; when set, egress/opfs/subagent/page are all off (a site-client run's ONLY outward edge is the pinned fetch).
 * @param {number} [opts.actorsGuardMs] the actors bridge guard — passed from the timeout tower (actors-api.js ACTORS_BRIDGE_GUARD_MS) so it cannot drift below the per-ask cap.
 * @param {{ page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean, provider?: boolean, distributed?: boolean }} [opts.caps]
 * @param {{args?:string[],stdin?:string,env?:Record<string,string>,cwd?:string}} [opts.podCommand]
 *   Pod's restricted JS command profile. It swaps in the stricter Pod seal and
 *   exposes only lexical args/stdin/env/cwd/pod helpers over the existing OPFS
 *   bridge. Remote resolution remains a host policy decision.
 *   capability profile (defaults = DEFAULT_WORKER_CAPS — the historical surface;
 *   caps.page is the web actor's page bridge, PR #119; caps.provider is the
 *   script tool's sub-model lane, design 5; caps.distributed gates the
 *   base-network reads — off on hosts with no 'distributed-request' handler)
 * @returns {Promise<{ source: string, cache: Map<string, { blobUrl: string, source: string }>, bodyLine: number }>}
 *   bodyLine: the 1-based source line the user code's first line lands on
 *   (user line L = source line bodyLine + L - 1) — feed it to mapWorkerError.
 */
export const buildWorkerSource = async (userCode, { entryPath = 'notebook.js', notebookId, resolverDeps, a2a = false, actors = false, actorsGuardMs = 250000, caps, siteFetch = '', podCommand }) => {
  const profile = { ...DEFAULT_WORKER_CAPS, ...(caps ?? {}) };
  const { imports, body, cache } = await buildEntry(userCode, entryPath, {
    ...resolverDeps,
    builtins: NOTEBOOK_BUILTINS,
  });
  const source = `${podCommand
    ? `import ${JSON.stringify(POD_SEAL_MODULE_URL)};`
    : `import ${JSON.stringify(SEAL_MODULE_URL)};`} // realm seal — MUST stay the first import
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
  ${podCommand ? '// Pod host captures bounded log messages as they stream.' : 'consoleOutput.push({ level, text });'}
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
// Every capability the worker reaches on the host (OPFS, the embedded actor,
// base-network reads, the a2a mesh) speaks the SAME postMessage protocol: mint a
// monotonic rid, stash the resolver, post a '<name>-request', settle when the
// matching '<name>-response' lands. makeBridge is that protocol expressed ONCE;
// each bridge is then one line + a thin arg-shaping wrapper. why not fetch or
// display here: fetch is owned by the realm seal (its own listener, so untrusted
// code can't unseat it) and display is one-way (no reply to correlate).
const bridges = [];
const makeBridge = (name, { timeoutMs, shape, timeoutMessage } = {}) => {
  const pending = new Map();
  let seq = 0;
  const call = (payload = {}) => new Promise((resolve, reject) => {
    const rid = (seq += 1);
    pending.set(rid, { resolve, reject });
    postMessage({ type: name + '-request', rid, ...payload });
    if (timeoutMs) setTimeout(() => {
      // keep the op/method in the message — a stuck-bridge error is only
      // actionable if it says WHICH call hung. A bridge whose CLIENT name differs
      // from its wire name (the a2a bridge's client is mesh.*) passes
      // timeoutMessage to keep its original wording; opfs default reproduces
      // "opfs <op> timed out".
      if (pending.delete(rid)) reject(new Error(
        timeoutMessage ? timeoutMessage(payload) : name + ' ' + (payload.op || payload.method || 'call') + ' timed out'));
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
// runtime.runAgent, provider.call (capability-gated — the script lane mints
// caps.provider per-run, quota enforced at the SW relay; design 5),
// distributed.{whoami,status,peers,presence} (base-network
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
  // p · provider (cyan) — BYOK model access. call is WIRED capability-gated
  // (overridden below per the profile); listModels stays a placeholder.
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
  // reaches it via the script tool); runUntrusted = headless opaque-origin iframe
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
    runAgent:     (args) => actorCall(args ?? {}),
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
    deleteFile: (path) => opfsCall('delete', { path }),
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
const actorRelay = makeBridge('actor');
const actorCall = (args) => actorRelay({ args });

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
const meshRelay = makeBridge('a2a', { timeoutMs: 130000, timeoutMessage: (p) => 'mesh.' + p.method + ' timed out' });
const meshCall = (method, args) => meshRelay({ method, args });
const __mesh = {
  peers:       () => meshCall('peers', {}),
  card:        (did) => meshCall('card', { did }),
  ask:         (did, message, opts) => meshCall('ask', { did, message, timeoutMs: opts && opts.timeoutMs }),
  send:        (did, message) => meshCall('send', { did, message }),
  publishCard: (card) => meshCall('publishCard', { card }),
  inbox:       () => meshCall('inbox', {}),
  converse:    (did, message, opts) => meshCall('converse', { did, message, timeoutMs: opts && opts.timeoutMs }),
  say:         (convId, message, opts) => meshCall('say', { convId, message, timeoutMs: opts && opts.timeoutMs }),
};
globalThis.mesh = __mesh;
` : ''}

// --- actors.* (the orchestrator's OWN actors) proxy — capability-gated ---
// The script tool's delegation client: ask/send hand a GOAL to a local actor
// (vm/notebook/app instance, "web", an API origin) through the SW actors/call
// route — the full message_actor gate chain runs per call. The guard value is
// INTERPOLATED from the timeout tower (actors-api.js): it sits above the
// per-ask cap by construction, and the job wall-clock sits above it.
${actors ? `
const actorsRelay = makeBridge('actors', { timeoutMs: ${JSON.stringify(actorsGuardMs)}, timeoutMessage: (p) => 'actors.' + p.method + ' timed out' });
const actorsCall = (method, args) => actorsRelay({ method, args });
const __actors = {
  list: () => actorsCall('list', {}),
  ask:  (to, goal, opts) => actorsCall('ask', { to, goal, timeoutMs: opts && opts.timeoutMs, oneShot: opts && opts.oneShot }),
  send: (to, goal, opts) => actorsCall('send', { to, goal, oneShot: opts && opts.oneShot }),
};
globalThis.actors = __actors;
` : ''}

// --- peerd.provider.call (sub-model text call) — capability-gated (caps.provider) ---
// Design 5: a pure text transform mid-script ({ system?, prompt | messages,
// model?, maxTokens? } → { text }). No tools, no streaming — a sub-call that
// could call tools would be an invisible agent loop (that is runAgent's lane).
// The host relay refuses 'provider-request' when the cap is off (two walls),
// the SW route validates args + enforces the per-run quota + holds the key.
// why no bridge timeout (mirrors the runAgent bridge): a model call's wall is
// the RUN's wall-clock — the host terminates the worker and the SW aborts the
// in-flight provider fetch on Stop/release, so a local timer here could only
// orphan a paid call.
${profile.provider ? `
const providerRelay = makeBridge('provider');
// Re-type quota refusals in-realm: the bridge re-raises plain Errors, so the
// SW's structured refusal arrives as a message string — restore the name so
// catch (e) { e.name === 'ProviderQuotaError' } works, not just string-matching.
globalThis.peerd.provider.call = (args) => providerRelay({ args: args ?? {} }).catch((e) => {
  if (e && typeof e.message === 'string' && e.message.indexOf('provider quota exceeded') === 0) e.name = 'ProviderQuotaError';
  throw e;
});
` : `
globalThis.peerd.provider.call = () => {
  throw new Error('peerd.provider.call is not available in this worker (no-provider capability profile).');
};
`}
// --- page.* (web-actor page control) proxy — capability-gated (caps.page) ---
// PR #119 code-REPL arm: each page.* call is ONE host round-trip; the host
// relays it to the SW's 'page/call' route, which dispatches the SAME gated tool
// the tool-call web actor uses (denylist / confirm / audit unchanged) against
// the ONE tab this actor owns. The host attaches the owner identity itself —
// nothing this realm sends can choose the session or the tab.
${profile.page ? `
const pageRelay = makeBridge('page', { timeoutMs: 30000, timeoutMessage: (p) => 'page.' + p.method + ' timed out' });
const pageCall = (method, args) => pageRelay({ method, args });
// The Playwright-shaped API is a BARE \`page\` global (the tool description +
// actor lore both use \`await page.goto(...)\`), mirrored on peerd.page for
// discoverability. Exposing only peerd.page left \`page\` undefined → every
// script ReferenceError'd before its first action.
const __page = {
  goto:     (url) => pageCall('goto', { url }),
  click:    (selector, opts) => pageCall('click', (opts && typeof opts.nth === 'number') ? { selector, nth: opts.nth } : { selector }),
  fill:     (selector, text) => pageCall('fill', { selector, text }),
  snapshot: () => pageCall('snapshot', {}),
  content:  () => pageCall('content', {}),
};
globalThis.page = __page;
globalThis.peerd.page = __page;
` : ''}${siteFetch ? `
// --- site.* (DESIGN-19 site client) proxy — ONE origin-pinned fetch ---
// A site-client run's ONLY outward edge: site.fetch(path, { method, headers, body })
// leaves the sealed realm as a site-fetch-request the host relays to the SW
// site-fetch/call route, which resolves the path against the PINNED origin, runs it
// through the actor's session-scoped + denylisted + audited webFetch, and confirms a
// non-GET (web:write). The worker cannot choose the origin, add credentials, or reach
// any other host — cross-origin is refused at the route. RESOLVES to
// { status, finalUrl, contentType, body (text), json } for ANY HTTP response —
// NOTE: no Fetch-API 'ok' and json is already the parsed value or null (not a
// method); it REJECTS only when the call is refused/blocked or the network fails,
// so check status yourself and wrap in try/catch.
const siteRelay = makeBridge('site-fetch', { timeoutMs: 60000, timeoutMessage: (p) => 'site.fetch ' + (p.pathOrUrl || '') + ' timed out' });
const __site = {
  origin: ${JSON.stringify(siteFetch)},
  fetch: (pathOrUrl, init) => siteRelay({ pathOrUrl, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body }),
};
globalThis.site = __site;
globalThis.peerd.site = __site;
` : ''}${profile.egress ? '' : `
// Capability profile: NO egress. peerd.egress.fetch throws in-realm; the host
// relay refuses any 'fetch-request' this realm still emits (global fetch is the
// seal's bridge and cannot be removed here) — two walls, same refusal.
globalThis.peerd.egress.fetch = () => {
  throw new Error('peerd.egress.fetch is not available in this worker (no-egress capability profile).');
};
`}${profile.subagent ? '' : `
// Capability profile: NO subagents.
globalThis.peerd.runtime.runAgent = () => {
  throw new Error('peerd.runtime.runAgent is not available in this worker (no-subagent capability profile).');
};
`}${profile.opfs ? '' : `
// Capability profile: NO OPFS. Files and dynamic imports are off; the host
// relay refuses any 'opfs-request' as the second wall.
const noOpfs = (name) => () => {
  throw new Error('peerd.self.' + name + ' is not available in this worker (no-opfs capability profile).');
};
globalThis.peerd.self.readFile = noOpfs('readFile');
globalThis.peerd.self.writeFile = noOpfs('writeFile');
globalThis.peerd.self.deleteFile = noOpfs('deleteFile');
globalThis.peerd.self.listFiles = noOpfs('listFiles');
globalThis.peerd.self.import = noOpfs('import');
globalThis.__peerd_dynamic_import = noOpfs('import');
`}${profile.distributed ? '' : `
// Capability profile: NO distributed. The base-network reads throw
// synchronously in-realm; the host relay refuses any 'distributed-request'
// this realm still emits, as the second wall. why: this host has no
// distributed handler — an unanswered bridge call would hang the run to its
// wall-clock for a one-word answer.
const noDistributed = (name) => () => {
  throw new Error('peerd.distributed.' + name + ' is not available in this worker (no-distributed capability profile).');
};
globalThis.peerd.distributed.whoami = noDistributed('whoami');
globalThis.peerd.distributed.status = noDistributed('status');
globalThis.peerd.distributed.peers = noDistributed('peers');
globalThis.peerd.distributed.presence = noDistributed('presence');
`}${podCommand ? `
// Pod JS gets local Web-standard JavaScript plus named, instance-rooted file
// capabilities. Network access stays in the explicit shell curl command so
// workspace bytes and arbitrary computed URLs never share one capability realm.
const args = Object.freeze(${JSON.stringify(podCommand.args ?? [])});
const stdin = ${JSON.stringify(podCommand.stdin ?? '')};
const env = Object.freeze(${JSON.stringify(podCommand.env ?? {})});
const cwd = ${JSON.stringify(podCommand.cwd ?? '/')};
const pod = Object.freeze({
  readFile: (path) => peerd.self.readFile(path),
  writeFile: (path, content) => peerd.self.writeFile(path, content),
  deleteFile: (path) => peerd.self.deleteFile(path),
  listFiles: () => peerd.self.listFiles(),
});
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
