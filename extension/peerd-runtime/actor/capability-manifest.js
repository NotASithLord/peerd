// @ts-check
// capability-manifest.js — the declarative contract for every code client an
// agent-facing worker may receive, plus the effective surface of each bound
// actor kind.
//
// why one manifest: these capabilities cross four independently-loaded realms
// (model prompt → generated worker client → offscreen host relay → SW policy
// route). A hand-maintained method list at each hop turns a rename into either a
// hallucinated API or, worse, an authority hole. The manifest contains only
// inert data. Translation modules still validate arguments and policy routes
// still dispatch through their existing gates; consumers generate from or
// positively validate against this data.

/** @typedef {'read'|'write'|'delegate'|'spend'} CodeEffect */
/** @typedef {{ op: string, signature: string, effect: CodeEffect, tool?: string, canonical?: boolean, worker?: string }} CodeMethod */
/** @typedef {{ global: string, bridge: string, methods: Readonly<Record<string, CodeMethod>>, maxTraceOps: number }} CodeClientManifest */

// One cap for every inner-op trace ring, irrespective of client. The authority
// cap may be tighter at its policy route; observability is never allowed to grow
// without bound just because a new bridge was added.
export const CODE_RUN_MAX_TRACE_OPS = 50;

/** @param {string} global @param {string} bridge @param {Record<string, CodeMethod>} methods @returns {CodeClientManifest} */
const client = (global, bridge, methods) => Object.freeze({
  global, bridge, methods: Object.freeze(methods), maxTraceOps: CODE_RUN_MAX_TRACE_OPS,
});

/** @type {Readonly<Record<string, CodeClientManifest>>} */
export const CODE_CLIENT_MANIFESTS = Object.freeze({
  // Elixir/OTP-shaped local process messaging. `call` is the canonical awaited
  // request/reply primitive. `ask` remains a non-advertised compatibility alias
  // for scripts written during the #327 rollout; there is deliberately no
  // `cast` until the host can provide a genuine no-reply mailbox send.
  actors: client('actors', 'actors', {
    list: { op: 'list', signature: 'list()', effect: 'read', tool: 'actor_list', canonical: true, worker: "() => actorsCall('list', {})" },
    call: { op: 'call', signature: 'call(address, message, options?)', effect: 'delegate', tool: 'message_actor', canonical: true, worker: "(address, message, options) => actorsCall('call', { address, message, timeoutMs: options && options.timeoutMs, oneShot: options && options.oneShot })" },
    ask: { op: 'call', signature: 'ask(address, message, options?)', effect: 'delegate', tool: 'message_actor', worker: "(address, message, options) => actorsCall('ask', { address, message, timeoutMs: options && options.timeoutMs, oneShot: options && options.oneShot })" },
  }),
  // Playwright-shaped control plus the tab web actor's non-DOM facilities.
  // Every method maps to an existing gated tool; the bridge itself owns no new
  // browser or network authority.
  page: client('page', 'page', {
    goto: { op: 'goto', signature: 'goto(url)', effect: 'write', tool: 'navigate', canonical: true, worker: "(url) => pageCall('goto', { url })" },
    click: { op: 'click', signature: 'click(selectorOrRef, options?)', effect: 'write', tool: 'click', canonical: true, worker: "(target, options) => pageCall('click', { target, nth: options && options.nth })" },
    fill: { op: 'fill', signature: 'fill(selectorOrRef, text, options?)', effect: 'write', tool: 'type', canonical: true, worker: "(target, text, options) => pageCall('fill', { target, text, submit: options && options.submit })" },
    snapshot: { op: 'snapshot', signature: 'snapshot()', effect: 'read', tool: 'snapshot', canonical: true, worker: "() => pageCall('snapshot', {})" },
    content: { op: 'content', signature: 'content()', effect: 'read', tool: 'read_page', canonical: true, worker: "() => pageCall('content', {})" },
    readState: { op: 'readState', signature: 'readState(selectorOrRef)', effect: 'read', tool: 'read_state', canonical: true, worker: "(target) => pageCall('readState', { target })" },
    watchChanges: { op: 'watchChanges', signature: 'watchChanges()', effect: 'read', tool: 'watch_changes', canonical: true, worker: "() => pageCall('watchChanges', {})" },
    query: { op: 'query', signature: 'query(selector, options?)', effect: 'read', tool: 'query_dom', canonical: true, worker: "(selector, options) => pageCall('query', { selector, options })" },
    keys: { op: 'keys', signature: 'keys(sequence)', effect: 'write', tool: 'page_keys', canonical: true, worker: "(sequence) => pageCall('keys', { sequence })" },
    readPdf: { op: 'readPdf', signature: 'readPdf(options?)', effect: 'read', tool: 'read_pdf', canonical: true, worker: "(options) => pageCall('readPdf', { options })" },
    view: { op: 'view', signature: 'view()', effect: 'read', tool: 'view', canonical: true, worker: "() => pageCall('view', {})" },
    fetch: { op: 'fetch', signature: 'fetch(url, options?)', effect: 'read', tool: 'fetch_url', canonical: true, worker: "(url, options) => pageCall('fetch', { url, options })" },
    readDocument: { op: 'readDocument', signature: 'readDocument(url, options?)', effect: 'read', tool: 'read_doc', canonical: true, worker: "(url, options) => pageCall('readDocument', { url, options })" },
    readCache: { op: 'readCache', signature: 'readCache(key, options?)', effect: 'read', tool: 'read_web_cache', canonical: true, worker: "(key, options) => pageCall('readCache', { key, options })" },
    readSiteClient: { op: 'readSiteClient', signature: 'readSiteClient(origin)', effect: 'read', tool: 'site_client_read', canonical: true, worker: "(origin) => pageCall('readSiteClient', { origin })" },
    writeSiteClient: { op: 'writeSiteClient', signature: 'writeSiteClient(origin, {summary?, endpoints?, auth?, deriver?, body})', effect: 'write', tool: 'site_client_write', canonical: true, worker: "(origin, definition) => pageCall('writeSiteClient', { origin, definition })" },
    captureSite: { op: 'captureSite', signature: 'captureSite("start"|"stop")', effect: 'read', tool: 'site_capture', canonical: true, worker: "(action) => pageCall('captureSite', { action })" },
    login: { op: 'login', signature: 'login(selectorOrRef, options?)', effect: 'write', tool: 'login', canonical: true, worker: "(target, options) => pageCall('login', { target, options })" },
  }),
  mesh: client('mesh', 'a2a', {
    peers: { op: 'peers', signature: 'peers()', effect: 'read', canonical: true, worker: "() => meshCall('peers', {})" },
    card: { op: 'card', signature: 'card(did)', effect: 'read', canonical: true, worker: "(did) => meshCall('card', { did })" },
    publishCard: { op: 'publishCard', signature: 'publishCard(card)', effect: 'write', canonical: true, worker: "(card) => meshCall('publishCard', { card })" },
    call: { op: 'ask', signature: 'call(did, message, options?)', effect: 'write', canonical: true, worker: "(did, message, options) => meshCall('call', { did, message, timeoutMs: options && options.timeoutMs })" },
    cast: { op: 'send', signature: 'cast(did, message)', effect: 'write', canonical: true, worker: "(did, message) => meshCall('cast', { did, message })" },
    // Compatibility aliases for pre-#326 scripts. New model output sees the
    // same call/cast vocabulary locally and over the mesh.
    ask: { op: 'ask', signature: 'ask(did, message, options?)', effect: 'write', worker: "(did, message, options) => meshCall('ask', { did, message, timeoutMs: options && options.timeoutMs })" },
    send: { op: 'send', signature: 'send(did, message)', effect: 'write', worker: "(did, message) => meshCall('send', { did, message })" },
    inbox: { op: 'inbox', signature: 'inbox()', effect: 'read', canonical: true, worker: "() => meshCall('inbox', {})" },
    converse: { op: 'converse', signature: 'converse(did, message, options?)', effect: 'write', canonical: true, worker: "(did, message, options) => meshCall('converse', { did, message, timeoutMs: options && options.timeoutMs })" },
    say: { op: 'say', signature: 'say(conversationId, message, options?)', effect: 'write', canonical: true, worker: "(conversationId, message, options) => meshCall('say', { convId: conversationId, message, timeoutMs: options && options.timeoutMs })" },
  }),
  provider: client('peerd.provider', 'provider', {
    call: { op: 'call', signature: 'call({ prompt|messages, system?, model?, maxTokens? })', effect: 'spend', canonical: true },
  }),
  site: client('site', 'site-fetch', {
    fetch: { op: 'fetch', signature: 'fetch(pathOrUrl, options?)', effect: 'write', canonical: true },
  }),
});

/** @param {string} clientName @param {boolean} [includeCompatibility] */
export const codeClientMethods = (clientName, includeCompatibility = false) => {
  const manifest = CODE_CLIENT_MANIFESTS[clientName];
  if (!manifest) return [];
  return Object.entries(manifest.methods)
    .filter(([, method]) => includeCompatibility || method.canonical === true)
    .map(([name]) => name);
};

/** @param {string} clientName @param {string} method */
export const codeClientAllows = (clientName, method) =>
  Object.hasOwn(CODE_CLIENT_MANIFESTS[clientName]?.methods ?? {}, method);

/** @param {string} clientName @param {string} method */
export const codeClientMethod = (clientName, method) =>
  CODE_CLIENT_MANIFESTS[clientName]?.methods?.[method] ?? null;

/**
 * Generate the compact API reference inserted into model lore. When an
 * effective tool set is supplied, methods backed by an unavailable tool are
 * omitted; this keeps session manifests and spawned grants honest.
 * @param {string} clientName @param {readonly string[] | null} [allowedTools]
 */
export const codeClientReference = (clientName, allowedTools = null) => {
  const manifest = CODE_CLIENT_MANIFESTS[clientName];
  if (!manifest) return '';
  const allowed = Array.isArray(allowedTools) ? new Set(allowedTools) : null;
  return Object.entries(manifest.methods)
    .filter(([, method]) => method.canonical === true
      && (!allowed || !method.tool || allowed.has(method.tool)))
    .map(([name, method]) => `${manifest.global}.${method.signature || `${name}()`}`)
    .join(', ');
};

const TRACE_METHODS = Object.freeze({
  actor: Object.freeze(new Set(['spawn'])),
  actors: Object.freeze(new Set(codeClientMethods('actors', true))),
  a2a: Object.freeze(new Set(codeClientMethods('mesh', true))),
  page: Object.freeze(new Set(codeClientMethods('page', true))),
  provider: Object.freeze(new Set(['call'])),
  toolbox: Object.freeze(new Set(['read'])),
  opfs: Object.freeze(new Set(['read', 'write', 'delete', 'list', 'compose-module'])),
  fetch: Object.freeze(new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])),
  'site-fetch': Object.freeze(new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])),
  distributed: Object.freeze(new Set()),
});

/**
 * Turn a worker-controlled label into a host-known trace token. Unknown or
 * oversized values collapse to a fixed word, so trace lines can safely live
 * outside the untrusted result fence.
 * @param {unknown} bridge @param {unknown} method
 */
export const canonicalCodeTraceLabel = (bridge, method) => {
  const bridgeName = typeof bridge === 'string' && Object.hasOwn(TRACE_METHODS, bridge)
    ? bridge : 'code';
  const candidate = (bridgeName === 'fetch' || bridgeName === 'site-fetch')
    ? String(method ?? '').toUpperCase()
    : String(method ?? '');
  const methods = /** @type {Readonly<Record<string, ReadonlySet<string>>>} */ (TRACE_METHODS);
  return {
    bridge: bridgeName,
    method: methods[bridgeName]?.has(candidate) ? candidate : 'unknown',
  };
};

/**
 * Render the host-authored, privacy-minimal inner-operation trace. Arguments,
 * results, and error bodies never enter this structure; those remain fenced in
 * the run output. Unknown bridges are still named honestly for forward safety.
 * @param {Array<{ seq?: number, bridge?: string, method?: string, outcome?: string, ms?: number }>} trace
 */
export const renderCodeOpTrace = (trace) => trace.map((entry) => {
  const { bridge, method } = canonicalCodeTraceLabel(entry.bridge, entry.method);
  const outcome = entry.outcome === 'ok' ? 'ok' : entry.outcome === 'pending' ? 'pending' : 'error';
  return `#${entry.seq ?? '?'} ${bridge}.${method} → ${outcome} (${entry.ms ?? 0}ms)`;
});

/**
 * Generate a worker client from the same method records used by authorization
 * and prompt lore. Provider/site use specialized install shapes, while the
 * generic clients render their declared worker expressions. Dynamic site
 * origin data is JSON-encoded here and still validated/pinned by the host.
 * @param {'actors'|'page'|'mesh'|'provider'|'site'} clientName
 * @param {{ timeoutMs?: number, siteOrigin?: string }} [options]
 */
export const buildCodeClientSource = (clientName, options = {}) => {
  const manifest = CODE_CLIENT_MANIFESTS[clientName];
  if (!manifest) return '';
  if (clientName === 'provider') {
    return [
      "const providerRelay = makeBridge('provider');",
      'globalThis.peerd.provider.call = (args) => providerRelay({ args: args ?? {} }).catch((e) => {',
      "  if (e && typeof e.message === 'string' && e.message.indexOf('provider quota exceeded') === 0) e.name = 'ProviderQuotaError';",
      '  throw e;',
      '});',
    ].join('\n');
  }
  if (clientName === 'site') {
    if (typeof options.siteOrigin !== 'string' || !options.siteOrigin) return '';
    const timeout = typeof options.timeoutMs === 'number' ? Math.max(1, Math.floor(options.timeoutMs)) : 60_000;
    return [
      `const siteRelay = makeBridge('site-fetch', { timeoutMs: ${timeout}, timeoutMessage: () => 'site.fetch timed out' });`,
      'const __site = {',
      `  origin: ${JSON.stringify(options.siteOrigin)},`,
      "  fetch: (pathOrUrl, init) => siteRelay({ pathOrUrl, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body }),",
      '};',
      'globalThis.site = __site;',
      'globalThis.peerd.site = __site;',
    ].join('\n');
  }
  const methods = Object.entries(manifest.methods);
  if (methods.some(([, method]) => typeof method.worker !== 'string')) return '';
  const local = clientName;
  const timeout = typeof options.timeoutMs === 'number'
    ? `, { timeoutMs: ${Math.max(1, Math.floor(options.timeoutMs))}, timeoutMessage: (payload) => '${local}.' + payload.method + ' timed out' }`
    : '';
  const assignments = methods.map(([name, method]) => `  ${name}: ${method.worker},`).join('\n');
  const aliases = clientName === 'page' ? '\nglobalThis.peerd.page = __page;' : '';
  return [
    `const ${local}Relay = makeBridge('${manifest.bridge}'${timeout});`,
    `const ${local}Call = (method, args) => ${local}Relay({ method, args });`,
    `const __${local} = {`, assignments, '};',
    `globalThis.${manifest.global} = __${local};${aliases}`,
  ].join('\n');
};

/**
 * Resolve the tab-web action surface from the setting, session manifest, and
 * runtime host. Firefox currently lacks the offscreen worker host, so a stored
 * or packaged `code` preference must still advertise the usable tools surface.
 * @param {{ requested?: unknown, allowedTools?: Set<string>|null, headlessAvailable?: boolean }} input
 */
export const resolveWebActorSurface = ({ requested, allowedTools = null, headlessAvailable = false }) => {
  return resolveWebActorSurfaceDecision({ requested, allowedTools, headlessAvailable }).resolved;
};

/**
 * The contribution-safe form of the surface decision. It reports only the
 * reviewed product enums — never a missing tool name or host error — so the
 * actor settlement shell can count fallbacks without accepting raw strings.
 * @param {{ requested?: unknown, allowedTools?: Set<string>|null, headlessAvailable?: boolean }} input
 */
export const resolveWebActorSurfaceDecision = ({ requested, allowedTools = null, headlessAvailable = false }) => {
  const codeAllowed = allowedTools === null || (
    allowedTools.has('page_code')
    && Object.values(CODE_CLIENT_MANIFESTS.page.methods).every((method) => !method.tool || allowedTools.has(method.tool))
  );
  const requestedSurface = requested === 'code' ? 'code' : 'tools';
  if (requestedSurface === 'tools') {
    return Object.freeze({ requested: 'tools', resolved: 'tools', fallback: 'none' });
  }
  if (!headlessAvailable) {
    return Object.freeze({ requested: 'code', resolved: 'tools', fallback: 'worker_unavailable' });
  }
  if (!codeAllowed) {
    return Object.freeze({ requested: 'code', resolved: 'tools', fallback: 'capability_grant_incomplete' });
  }
  return Object.freeze({ requested: 'code', resolved: 'code', fallback: 'none' });
};

// The positive, declarative tool contract for bound actors. `codeDecision`
// records the safe-client decision even when the right answer is “no extra
// control bridge”: engine actors already write code in their owned runtime and
// must not gain a second host-control channel just for symmetry.
const ENGINE_TOOLS = Object.freeze({
  webvm: Object.freeze(['vm_boot', 'vm_write_file', 'vm_import', 'vm_delete']),
  notebook: Object.freeze(['js_notebook', 'js_write_file', 'js_read_file', 'js_delete', 'edit_file']),
  app: Object.freeze(['app_update', 'app_write_file', 'app_read_file', 'app_list_files', 'app_delete_file', 'app_delete', 'edit_file']),
});

export const WEB_ACTOR_DOM_TOOL_NAMES = Object.freeze([
  'snapshot', 'read_page', 'read_state', 'watch_changes', 'click', 'type',
  'navigate', 'query_dom', 'page_keys', 'read_pdf', 'view',
]);

// The tools represented inside one `page_code` run. Contributor Metrics uses
// this same manifest-derived list for a fair code-vs-direct comparison; a
// second hand-maintained "page actions" list would drift as the client grows.
export const WEB_ACTOR_CODE_CLIENT_TOOL_NAMES = Object.freeze([
  ...new Set(Object.values(CODE_CLIENT_MANIFESTS.page.methods)
    .flatMap((method) => typeof method.tool === 'string' ? [method.tool] : [])),
]);

export const WEB_ACTOR_TOOL_NAMES = Object.freeze([
  ...WEB_ACTOR_DOM_TOOL_NAMES, 'fetch_url', 'read_doc', 'read_web_cache',
  'site_client_run', 'site_client_read', 'site_client_write', 'site_capture', 'login',
]);

export const WEB_API_TOOL_NAMES = Object.freeze([
  'fetch_url', 'read_web_cache', 'site_client_run', 'site_client_read', 'site_client_write',
]);

export const DWEB_ACTOR_TOOL_NAMES = Object.freeze([
  'dweb_share', 'dweb_discover', 'dweb_install', 'dweb_peers', 'dweb_block',
  'dweb_discovery', 'dweb_guide', 'a2a_run',
]);

// Remote peer bytes may wake the daemon actor, but that provenance must never
// acquire a signing, install, spend, or delegation edge. Every prompt/descriptor
// and both execution paths consume this same positive subset.
export const DWEB_INBOUND_TOOL_NAMES = Object.freeze([
  'dweb_discover', 'dweb_peers', 'dweb_block',
]);

/** @type {Readonly<Record<string, { tools: readonly string[], codeTool: string, client: string|null, codeDecision: string }>>} */
export const ACTOR_CAPABILITY_MANIFESTS = Object.freeze({
  webvm: Object.freeze({ tools: ENGINE_TOOLS.webvm, codeTool: 'vm_boot', client: null, codeDecision: 'shell is the code surface; no second host-control client' }),
  notebook: Object.freeze({ tools: ENGINE_TOOLS.notebook, codeTool: 'js_notebook', client: null, codeDecision: 'the owned notebook worker is the code surface' }),
  app: Object.freeze({ tools: ENGINE_TOOLS.app, codeTool: 'app_write_file', client: null, codeDecision: 'the actor writes the app artifact; a runtime control bridge would widen iframe authority' }),
  web: Object.freeze({ tools: WEB_ACTOR_TOOL_NAMES, codeTool: 'page_code', client: 'page', codeDecision: 'page maps only to the same gated web tools' }),
  api: Object.freeze({ tools: WEB_API_TOOL_NAMES, codeTool: 'site_client_run', client: 'site', codeDecision: 'origin-pinned site client code; no arbitrary-origin client' }),
  dweb: Object.freeze({ tools: DWEB_ACTOR_TOOL_NAMES, codeTool: 'a2a_run', client: 'mesh', codeDecision: 'mesh-only worker; no egress or local actor delegation' }),
});

/** @param {string} actorType @param {'tab'|'api'} [backing] */
export const actorCapabilityManifest = (actorType, backing) =>
  actorType === 'web' && backing === 'api'
    ? ACTOR_CAPABILITY_MANIFESTS.api
    : ACTOR_CAPABILITY_MANIFESTS[actorType] ?? Object.freeze({ tools: [], codeTool: '', client: null, codeDecision: 'unknown actor kind: no authority' });

/**
 * Derive the actor's code-facing tool surface from the same manifest that
 * defines its direct authority. A client with per-method tool mappings absorbs
 * exactly those direct tools; any unmapped operation must remain discrete.
 * Clients whose methods have no tool mapping are themselves the complete
 * consolidated capability, so only their code tool is exposed.
 * @param {string} actorType @param {'tab'|'api'} [backing]
 * @returns {readonly string[]}
 */
export const actorCodeSurfaceTools = (actorType, backing) => {
  const manifest = actorCapabilityManifest(actorType, backing);
  if (!manifest.codeTool) return Object.freeze([]);
  const clientManifest = manifest.client ? CODE_CLIENT_MANIFESTS[manifest.client] : null;
  if (!clientManifest) return Object.freeze([manifest.codeTool]);
  const mappedTools = new Set(Object.values(clientManifest.methods)
    .map((method) => method.tool)
    .filter((tool) => typeof tool === 'string'));
  if (mappedTools.size === 0) return Object.freeze([manifest.codeTool]);
  return Object.freeze([...new Set([
    manifest.codeTool,
    ...manifest.tools.filter((tool) => !mappedTools.has(tool)),
  ])]);
};
