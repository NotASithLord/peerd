// @ts-check
// Tool exposure policy — which tools the MAIN agent sees.
//
// After the DESIGN-17 actor cutover, the main agent's browser surface is
// actor_list / open_tab / message_actor (+ capture). The page itself is
// reached by messaging the tab's web ACTOR — the low-level DOM/page tools
// (a11y snapshots, element refs, click/type/navigate, raw page content,
// code-exec) all LEFT the main agent and now live on the web actor directly.
// This keeps untrusted page content and ref noise out of the main context: the
// security + long-task-reliability thesis. The strip is the actor mutating
// tier, applied by filterActorSurface (below) + the gate.
//
// The DOM tools remain REGISTERED; the web actor receives them via tool
// narrowing (spawn.js). This module ONLY filters what the MAIN model SEES.
// It is the realization of the V1.3 exposure manifest (gates.js exposureGate).
//
// Pure — unit-tested. The SW applies mainAgentDescriptors() to the main turn's
// descriptor list, and leaves getToolDescriptors() (the actor's source) full.

import {
  actorCodeSurfaceTools,
  actorCapabilityManifest,
  ACTOR_CAPABILITY_MANIFESTS,
  WEB_ACTOR_DOM_TOOL_NAMES,
} from '../actor/capability-manifest.js';

// The DOM/page tools hidden from the MAIN agent. The web actor uses these
// (ACTOR_TYPE_TOOLS.web below is the actor-side allow-list; this is the
// main-side deny-list).
//
/** @typedef {ReturnType<typeof import('./metadata/descriptor.js').toToolDescriptor>} Tool */
// web_search and submit_form are GONE (deleted, not hidden) — the web actor
// covers search (navigate to an engine + read results) and form submission (its
// DOM type/click tools) now. The ONE direct web-ish tool the orchestrator keeps
// is `capture`: a user-facing screenshot of the active tab, whose image is
// redacted to a sentinel before the model sees it (loop/redact.js) — no page
// content leaks. actor_list/open_tab also stay (handle/metadata only, no content).
// Every web READ is the actor's, reached via message_actor.
export const MAIN_AGENT_HIDDEN_TOOLS = Object.freeze(new Set([
  'read_page', 'snapshot', 'read_state', 'watch_changes', 'query_dom',
  'navigate', 'type', 'click',
  // read_doc returns untrusted PDF/Office/OpenDocument text, so it sits on the
  // same actor-only tier as page content.
  'read_doc',
  // view returns an UNTRUSTED page screenshot as a model-visible image — same
  // boundary as read_page (raw page content), so it stays actor-only; the web
  // actor sees the pixels and reports back. (capture is NOT here: its image is
  // redacted to a sentinel before the model sees it.)
  'view',
  // fetch_url is the web ACTOR's secure fetch — its NON-render web mechanism (the
  // other is drive-a-tab). It's actor-only: the orchestrator delegates web INTENT
  // via message_actor and the web actor picks fetch-vs-render, so the main agent
  // never holds it. With call_api/read_article/web_search/submit_form removed, the
  // web actor (fetch_url + drive-a-tab) is the single entry point for ALL web work.
  'fetch_url',
  // page_code is the code-surface web actor's action tool (PR #119 A/B arm) —
  // same boundary as the DOM tools it wraps: page-driving stays off the main agent.
  'page_code',
  // DESIGN-19 site clients — per-origin derived API clients. All web-actor-only:
  // run executes a client (untrusted-provenance code) behind an origin-pinned
  // fetch; read/capture ingest page/response bytes; write persists them. Same
  // tier as fetch_url — the orchestrator delegates web work via message_actor.
  'site_client_run', 'site_client_read', 'site_client_write', 'site_capture',
  // login (Tier 0) — INITIATES a user-gesture sign-in on the active tab. It holds
  // no credential and never fills a password, but it drives the page and its
  // confirm names the live origin, so it rides the web-actor tier like every other
  // page-driving tool: the orchestrator delegates "sign in here" via message_actor.
  'login',
]));

/** Is this tool hidden from the main agent (actor-only)? Pure. @param {string} name */
export const isHiddenFromMain = (name) => MAIN_AGENT_HIDDEN_TOOLS.has(name);

/**
 * Filter a tool descriptor list down to what the MAIN agent should see.
 * Pure — values in, values out. Generic so it preserves the descriptor shape
 * (name/description/schema) for callers that map the survivors.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @returns {T[]}
 */
export const mainAgentDescriptors = (descriptors) =>
  // Dweb tools are the DWEB ACTOR's family (owner call 2026-07-04): the main
  // agent never holds them — mesh work is always message_actor("dweb", ...)
  // (the actor exists only when the user enables it). Unconditional, so the
  // orchestrator surface doesn't morph with a setting. why by NAME not the
  // `dweb:true` flag: the descriptor PROJECTION (getToolDescriptors →
  // {name,description,schema}) strips the flag, so isDwebTool would be a no-op
  // on a projected list — the name is the only reliable signal here. (The gate
  // sees the full controller tool and keeps using the flag.)
  descriptors.filter((t) => !MAIN_AGENT_HIDDEN_TOOLS.has(t.name) && !isDwebToolName(t.name));

// ── DESIGN-17: actor tab agents — the capability tier ────────────────────
//
// A `kind:'actor'` session OWNS one tab-hosted instance and exclusively
// holds that environment's instance tools. The split has two sides, both
// enforced at the dispatch gate (gates.js — the WALL, not just these
// descriptor filters which are advisory):
//
//   - ACTOR_ONLY_TOOLS leave the MAIN agent. A non-actor ctx
//     (main / actor / review / direct) is REFUSED any of them —
//     so a one-line `actor_create({tools:['app_delete']})` can't escalate.
//     Originally only MUTATION was tiered and the fenced READS
//     (app_read_file/app_list_files/js_read_file) stayed global for cheap
//     no-actor-hop inspection; that was reversed (owner call 2026-07-05) —
//     an instance file is not reliably agent-authored (notebook/app code
//     fetches and persists web data), so even a fenced read hands untrusted
//     bytes to the orchestrator's context. The convenience broke the
//     isolation premise; reads now ride the actor heap like everything else.
//   - An actor is POSITIVELY constrained to its own kind's toolset
//     (actorAllowedTools) — a keyless, narrow trust model: a
//     hallucinated/injected non-env tool from an actor fails closed at the
//     gate, not just in the descriptor list.
//
// The exposure marker is a free string on ctx: 'main' (main turn) / 'actor'
// (actor turn) / unset (actor). EXPOSURE_ACTOR is a const so a
// typo can't silently widen authority at its (many) read sites; 'main' stays a
// bare literal — it's only ever the gate's negative space, never matched by name.
export const EXPOSURE_ACTOR = 'actor';

// Each ENGINE kind's full operational surface — runs, writes, deletes, AND the
// fenced reads (see the isolation note above: instance bytes stay behind the
// actor heap even for reads). edit_file is the cross-kind SEARCH/REPLACE write
// path for App/Notebook files. script (headless, no instance) is deliberately
// ABSENT — it stays a parent tool. These per-kind sets are BOTH the positive
// allow-list of that kind's actor (ACTOR_TYPE_TOOLS below) AND, unioned, the
// tier that leaves the main agent — one source of truth, so a new instance op
// added to its kind's set is automatically refused for every non-actor ctx
// (forgetting the union was previously a silent escalation hole).
const ENGINE_ACTOR_TOOLS = Object.freeze({
  webvm: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.webvm.tools)),
  notebook: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.notebook.tools)),
  pod: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.pod.tools)),
  app: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.app.tools)),
});

// The tiered instance-OPERATION set — refused for every non-actor ctx (the
// main agent delegates these via message_actor). DERIVED as the union of the
// per-kind engine sets above, never hand-maintained.
export const ACTOR_ONLY_TOOLS = Object.freeze(new Set(
  Object.values(ENGINE_ACTOR_TOOLS).flatMap((set) => [...set]),
));

/** Is this a tiered instance tool (actor-only, off the main agent)? Pure. @param {string} name */
export const isActorOnlyTool = (name) => ACTOR_ONLY_TOOLS.has(name);

// DESIGN-17 web actor — the DOM toolset it owns. This list is the sole source
// of truth for that set. The retired arbitrary page-code tools are not part of
// any actor surface; page_code exposes only the named manifest below.
export const WEB_ACTOR_DOM_TOOLS = WEB_ACTOR_DOM_TOOL_NAMES;

// PR #119 — the CODE-surface web actor's toolset (the Aside-style A/B arm: the
// actor WRITES page-driving JS instead of emitting discrete tool calls). The
// surface is derived from the page client manifest: the actor perceives AND
// acts through page.* (page.snapshot()/page.content() for perception — still
// the a11y snapshot, the unchanged axis — and page.goto/click/fill for action),
// every call routing through a fixed SW page-program route to the SAME gated DOM
// tools on its owned tab. Operations not represented by a page method stay
// discrete; today that is site_client_run, because nesting a second sealed job
// inside page_code would deadlock the bounded relay pool.
// why NOT also expose direct snapshot/read_page: those resolve the tab from the
// ACTOR's turn context, which a fresh actor has none of — and a tab adopted
// mid-turn inside page_code (SW-side) never repins that turn context, so a
// direct snapshot after a page.goto failed and the actor thrashed. Routing ALL
// page interaction through page_code keeps ONE consistent tab. (page.snapshot()
// still dispatches the snapshot tool via the route's inner tools-surface ctx.)
export const WEB_ACTOR_CODE_TOOLS = Object.freeze(new Set(actorCodeSurfaceTools('web', 'tab')));
export const APP_ACTOR_CODE_TOOLS = Object.freeze(new Set(actorCodeSurfaceTools('app')));

// The POSITIVE allow-list an actor of each kind may call — its own kind's
// operational surface (mutations + reads + edit_file). Everything else (other
// kinds' tools, browser/web/memory/spawn tools) is refused for an actor ctx.
// Keys match the actorType vocabulary { webvm, notebook, app, web, dweb }; the
// engine kinds are the shared ENGINE_ACTOR_TOOLS sets above (the same sets
// whose union is the ACTOR_ONLY_TOOLS tier).
const ACTOR_TYPE_TOOLS = Object.freeze({
  ...ENGINE_ACTOR_TOOLS,
  // The web actor owns a tab via the DOM toolset. The DOM mutators
  // (click/type/navigate) are NOT in ACTOR_ONLY_TOOLS — they're contained
  // for the main agent by MAIN_AGENT_HIDDEN_TOOLS (the exposure axis). Putting
  // them in this POSITIVE set is what lets a web-actor ctx call them (gate rule
  // 2) — the reconciliation. PLUS fetch_url: the web actor's SESSIONLESS
  // non-render mechanism, added OUTSIDE WEB_ACTOR_DOM_TOOLS to keep that set a
  // clean DOM-only list. The web actor is the only ctx allowed fetch_url, and
  // the capability strip (spawn.js) keeps it keyless: webFetch survives,
  // getSecret / safeFetch do not.
  // Plus the DESIGN-19 site-client family: run/read/write persist + replay derived
  // per-origin API clients; site_capture records traffic to derive them (tab only —
  // an API actor has no tab, so the WEB_API_TOOLS set below drops site_capture).
  web: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.web.tools)),
  // The dweb actor — the mesh's operator (global singleton, handle "dweb").
  // Exactly the dweb family, nothing else: no egress tools, no DOM, no engine
  // mutation — the envoy posture. Its worst case must be a wrong reply, so the
  // only authority it holds is the mesh surface itself (ctx.dweb), and the
  // dangerous pair (share/install) force-confirms regardless of the toggle.
  dweb: Object.freeze(new Set(ACTOR_CAPABILITY_MANIFESTS.dweb.tools)),
});

/** The Set of tool names an actor of `kind` may call (empty for an unknown kind). Pure. @param {string} [kind] */
export const actorAllowedTools = (kind) =>
  ACTOR_TYPE_TOOLS[/** @type {keyof typeof ACTOR_TYPE_TOOLS} */ (kind)] ?? new Set();

/** May an actor of `kind` call this tool? Pure. @param {string} name @param {string} [kind] */
export const isAllowedForActorType = (name, kind) => actorAllowedTools(kind).has(name);

// DESIGN-18: an API actor is a `web` actor with `backing:'api'` — it owns ONE origin
// and has NO tab, so the whole DOM toolset (which needs a tab it never has) is removed
// from its allow-set. It keeps the keyless, tab-free fetch/cache surface plus
// site-client run/read/write for its fixed origin, but NOT site_capture, which
// needs a tab it never has. Used by BOTH the gate and capability strip, so the
// no-DOM boundary is enforced rather than merely omitted from descriptors.
const WEB_API_TOOLS = Object.freeze(new Set(actorCapabilityManifest('web', 'api').tools));

/**
 * The Set an actor may call given its kind AND (for a web actor) its backing — the
 * full web toolset for a tab backing, the API manifest for an API backing. PR #119:
 * a tab-backed web actor on the CODE surface gets WEB_ACTOR_CODE_TOOLS instead
 * (mapped page operations collapse into page_code; unmapped operations remain
 * discrete). An
 * absent surface means 'tools' — every existing caller keeps today's set. Pure.
 * @param {string} [kind] @param {'tab' | 'api'} [backing] @param {'tools' | 'code'} [surface]
 */
export const actorAllowedToolsFor = (kind, backing, surface) => {
  if (kind === 'web' && backing === 'api') return WEB_API_TOOLS;
  // Absent is the legacy tab spelling. Any PRESENT unknown value is corrupt or
  // from a future policy version and must not inherit the full tab surface.
  if (kind === 'web' && backing !== undefined && backing !== 'tab') return new Set();
  if (kind === 'web' && surface === 'code') return WEB_ACTOR_CODE_TOOLS;
  if (kind === 'app' && surface === 'code') return APP_ACTOR_CODE_TOOLS;
  return actorAllowedTools(kind);
};

/** May an actor of `kind`/`backing`/`surface` call this tool? Pure. @param {string} name @param {string} [kind] @param {'tab' | 'api'} [backing] @param {'tools' | 'code'} [surface] */
export const isAllowedForActor = (name, kind, backing, surface) => actorAllowedToolsFor(kind, backing, surface).has(name);

// Per-tool target-id ARG field — what an actor-gated tool calls its instance
// target. The actor dispatch wrapper force-injects the bound id here (the
// per-instance pin); the gate reads it for a defense-in-depth mismatch refusal.
// null = no explicit id arg (the tool resolves the session-default instance,
// which for an actor is its bound instance via setDefaultForSession).
const ACTOR_TARGET_ID_FIELD = Object.freeze({
  vm_boot: 'vm',          // id OR name
  vm_delete: 'vmId',
  vm_write_file: null,
  vm_import: null,
  js_notebook: 'notebook',
  js_write_file: 'notebook',
  js_read_file: 'notebook',
  js_delete: 'notebookId',
  pod_exec: 'podId',
  pod_status: 'podId',
  pod_cancel: 'podId',
  pod_read: 'podId',
  pod_write: 'podId',
  pod_destroy: 'podId',
  app_update: 'appId',
  app_write_file: 'appId',
  app_read_file: 'appId',
  app_list_files: 'appId',
  app_delete_file: 'appId',
  app_delete: 'appId',
  edit_file: 'targetId',
});

/** The arg field holding this tool's instance target id, or null. Pure. @param {string} name @returns {string|null} */
export const actorTargetIdField = (name) =>
  /** @type {Record<string, string|null>} */ (ACTOR_TARGET_ID_FIELD)[name] ?? null;

/**
 * DESIGN-17 per-instance PIN. Force an actor's tool-call instance-target arg to
 * its BOUND instance (overwriting any id/name the model — or, in the heap-split,
 * a possibly-injected worker — supplied), and lock edit_file to the actor's kind.
 * The gate's pin check is the defense-in-depth backstop; this is the
 * normalization that makes it pass. Mutates call.args in place. Pure logic,
 * shared by every dedicated-worker host. The privileged relay re-pins the
 * worker's call and never trusts it. One implementation prevents drift at this
 * security seam.
 * @param {any} call @param {string|undefined} actorType @param {string|undefined} instanceId
 */
export const pinActorCall = (call, actorType, instanceId) => {
  if (!instanceId) return;
  const field = actorTargetIdField(call?.name);
  if (field) call.args = { ...(call.args ?? {}), [field]: instanceId };
  // edit_file is cross-kind — also lock it to the actor's own workspace kind.
  if (call?.name === 'edit_file' && actorType) {
    call.args = { ...(call.args ?? {}), kind: actorType === 'notebook' ? 'notebook' : 'app' };
  }
};

/**
 * The EXPLICIT instance id/name a tool call names, or undefined when it names
 * none (relying on the session-default). Pure — read-only over args.
 * @param {string} name @param {Record<string, any> | null | undefined} args @returns {string | undefined}
 */
export const actorTargetId = (name, args) => {
  const field = actorTargetIdField(name);
  if (!field || !args) return undefined;
  const v = args[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

// DESIGN-17 web actor — the tab pin. A web actor owns ONE tab; the DOM
// tools resolve their target via `resolveTargetTab`, which honors an explicit
// numeric `args.tabId`. So the pin is on tabId (a number), not an instance-id
// string — `actorTargetId` (string-only) can't express it. The GATE (gates.js
// actorTierGate) compares this against ctx.activeTab.id, the actor's owned
// tab — NOT ctx.actorInstanceId, which is the fixed literal 'web' for the
// per-chat singleton actor (its message_actor address, stable across
// re-navigation, not a tab id). The GATE runs before `resolveTargetTab`
// (async) and can only see the explicit arg, so this checks the EXPLICIT
// `args.tabId`: absent → defaults to the bound tab (fine); present and ≠ the
// owned tab → refused.
/**
 * The explicit numeric `tabId` a DOM-tool call names, or undefined. Pure.
 * @param {Record<string, any> | null | undefined} args
 * @returns {number | undefined}
 */
export const actorWebTabTarget = (args) =>
  args && typeof args.tabId === 'number' ? args.tabId : undefined;

/**
 * The descriptor list an actor of `kind`/`backing` should SEE — its own toolset.
 * Pure. This keeps the model's advertised list tight so it is not shown tools
 * its semantic context would refuse. Host authority remains the fixed exact-op
 * grant and live policy edge. DESIGN-18: backing-aware, so an
 * API actor is advertised ONLY fetch_url, matching its lore + the gate. PR #119:
 * surface-aware, so a code-surface web actor is advertised only its code toolset.
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @param {string} [kind] @param {'tab' | 'api'} [backing] @param {'tools' | 'code'} [surface] @returns {T[]}
 */
export const actorDescriptors = (descriptors, kind, backing, surface) => {
  const allow = actorAllowedToolsFor(kind, backing, surface);
  return descriptors.filter((t) => allow.has(t.name));
};

/**
 * Re-shape the MAIN agent's descriptor list for the actor world: the instance-
 * mutating tier LEAVES the main agent (it bootstraps + delegates via
 * message_actor, which it keeps). Pure; composes after mainAgentDescriptors()/
 * the instance/dweb/goal filters.
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @returns {T[]}
 */
export const filterActorSurface = (descriptors) =>
  descriptors.filter((t) => !ACTOR_ONLY_TOOLS.has(t.name));

// ── dweb tools: gated on the dweb being enabled ─────────────────────────────
// The dweb network tools (publish/discover/install) are exposed to the agent
// ONLY when the dweb is on. On the store build the agent never sees them — the
// boundary's "channel behavior never exposed to the agent": the tool still
// registers (so dispatch can refuse it by name), it's just absent from the
// descriptor list the model reads. A tool opts in with `dweb: true`.
/** @param {Partial<Tool> | null | undefined} tool reads only the dweb flag */
export const isDwebTool = (tool) => tool?.dweb === true;

// The name-based twin, for descriptor lists where the `dweb:true` flag has been
// projected away (getToolDescriptors). Every dweb tool is named `dweb_*` and no
// non-dweb tool is — the naming convention IS the contract. why both exist: the
// gate holds the full controller tool (flag intact) and uses isDwebTool; the
// exposure filters see a stripped projection and must go by name.
/** @param {string} name @returns {boolean} */
export const isDwebToolName = (name) => typeof name === 'string' && (name.startsWith('dweb_') || name === 'a2a_run');

/**
 * Drop dweb tools from a descriptor list when the dweb is off. Composes after
 * mainAgentDescriptors(). Pure.
 *
 * @template {{ name: string, dweb?: boolean }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {boolean} dwebOn  DWEB_ENABLED && the dwebEnabled setting
 * @returns {T[]}
 */
export const filterByDwebEnabled = (descriptors, dwebOn) =>
  dwebOn ? [...descriptors] : descriptors.filter((t) => !isDwebTool(t));

// ── dweb tools: progressive disclosure of the SECONDARY surface ──────────────
// The dweb family has discover/share/install as entry tools whenever the dweb
// is enabled. The SECONDARY tools below (the sovereign controls) stay hidden
// until the session has ENGAGED
// the dweb — i.e. a dweb tool was actually called this session. Then they appear
// the next step, exactly like an instance-gated op after a create.
//
// why ENGAGEMENT, not connectivity (for the rest): the base network is always-on
// and auto-connects to whatever peers are online, so "has peers" is true within
// seconds for nearly everyone — a useless signal. Calling a dweb tool (dweb_discover
// is the natural opener) is real intent.
export const DWEB_SECONDARY_TOOLS = Object.freeze(new Set([
  'dweb_peers', 'dweb_block', 'dweb_discovery',
]));

/** Is this a dweb tool deferred until the session engages the dweb? Pure. @param {string} name */
export const isDwebSecondaryTool = (name) => DWEB_SECONDARY_TOOLS.has(name);

/**
 * Drop the dweb SECONDARY tools until the session has engaged the dweb. Composes
 * after filterByDwebEnabled (so it only ever sees a dweb-on list). Pure.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {boolean} dwebActive  has a dweb tool been called in this session
 * @returns {T[]}
 */
export const filterByDwebActive = (descriptors, dwebActive) =>
  dwebActive ? [...descriptors] : descriptors.filter((t) => !DWEB_SECONDARY_TOOLS.has(t.name));

// ── goal mode: complete_goal revealed only during an active run ─────────────
// Goal mode (loop/goal-runner.js) re-enters the agent turn until the agent
// calls complete_goal. That tool is a normal main-agent tool, so this filter
// (the DESCRIPTOR list, not the dispatcher) is what keeps it INVISIBLE outside
// a run — otherwise a normal chat would see a "complete the goal" tool with no
// goal. It's dropped unless the session has a live run; a stray call when it's
// hidden still dispatches, but the tool's execute() no-ops (see complete-goal.js).
export const GOAL_ONLY_TOOLS = Object.freeze(new Set([
  'complete_goal',
  // The plan-of-record checklist (todo/core.js) — the goal run's spine, and
  // what a prewalk executor steers by. Same reveal contract as complete_goal.
  'todo_init', 'todo_check', 'todo_add',
]));

/** Is this a tool that should appear ONLY during an active goal run? Pure. @param {string} name */
export const isGoalOnlyTool = (name) => GOAL_ONLY_TOOLS.has(name);

/**
 * Drop the goal-only tools unless a goal run is active for this session.
 * Composes after the other main-agent filters. Pure.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {boolean} goalActive  is a goal run live for the session
 * @returns {T[]}
 */
export const filterByGoalActive = (descriptors, goalActive) =>
  goalActive ? [...descriptors] : descriptors.filter((t) => !GOAL_ONLY_TOOLS.has(t.name));
