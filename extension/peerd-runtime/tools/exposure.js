// @ts-check
// Tool exposure policy — which tools the MAIN agent sees.
//
// After the DESIGN-17 actor cutover, the main agent's browser surface is
// list_tabs / open_tab / message_actor (+ capture). The page itself is
// reached by messaging the tab's web ACTOR — do/get/check and the low-level
// DOM/page tools (a11y snapshots, element refs, click/type/navigate, raw page
// content, code-exec) all LEFT the main agent: the actor holds the DOM
// toolset, subagents still drive a page through do/get/check. This keeps
// untrusted page content and ref noise out of the main context: the security +
// long-task-reliability thesis. The strip is RUNNER_PAGE_TOOLS + the actor
// mutating tier, applied by filterActorSurface (below) + the gate.
//
// The tools remain REGISTERED; the actor + subagents still receive them via
// tool narrowing (spawn.js). This module ONLY filters what the MAIN model SEES.
// It is the realization of the V1.3 exposure manifest (gates.js exposureGate).
//
// Pure — unit-tested. The SW applies mainAgentDescriptors() to the main turn's
// descriptor list, and leaves getToolDescriptors() (the runner's source) full.

// The DOM/page tools hidden from the MAIN agent. The runner uses these. Keep in
// sync with peerd-runtime/runner/index.js DO_TOOLSET / READ_TOOLSET (those are
// the runner-side allow-list; this is the main-side deny-list).
//
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
// web_search and submit_form are GONE (deleted, not hidden) — the web actor
// covers search (navigate to an engine + read results) and form submission (its
// DOM type/click tools) now. The ONE direct web-ish tool the orchestrator keeps
// is `capture`: a user-facing screenshot of the active tab, whose image is
// redacted to a sentinel before the model sees it (loop/redact.js) — no page
// content leaks. list_tabs/open_tab also stay (tab metadata only, no content).
// Every web READ is the actor's, reached via message_actor.
export const MAIN_AGENT_HIDDEN_TOOLS = Object.freeze(new Set([
  'read_page', 'snapshot', 'read_state', 'watch_changes', 'query_dom',
  'page_eval', 'page_exec', 'page_keys', 'navigate', 'type', 'click',
  // read_pdf returns untrusted PDF text — same boundary as read_page; the
  // runner reaches it through get/do.
  'read_pdf',
  // fetch_url is the web ACTOR's secure fetch — its NON-render web mechanism (the
  // other is drive-a-tab). It's actor-only: the orchestrator delegates web INTENT
  // via message_actor and the web actor picks fetch-vs-render, so the main agent
  // never holds it. With call_api/read_article/web_search/submit_form removed, the
  // web actor (fetch_url + drive-a-tab) is the single entry point for ALL web work.
  'fetch_url',
]));

/** Is this tool hidden from the main agent (runner-only)? Pure. @param {string} name */
export const isHiddenFromMain = (name) => MAIN_AGENT_HIDDEN_TOOLS.has(name);

/**
 * Filter a tool descriptor list down to what the MAIN agent should see.
 * Pure — values in, values out.
 *
 * @param {ReadonlyArray<{name: string}>} descriptors
 * @returns {Array<{name: string}>}
 */
export const mainAgentDescriptors = (descriptors) =>
  descriptors.filter((t) => !MAIN_AGENT_HIDDEN_TOOLS.has(t.name));

// ── Progressive disclosure: instance-gated engine ops ───────────────────
//
// The webvm/notebook/app families are large, but most of their tools only make
// sense once the chat HAS an instance of that kind. We always expose the entry +
// auto-creating tools (vm_create/vm_list/vm_boot, js_create/js_list/js_notebook,
// app_create/app_list/app_open/app_search) so every family is discoverable and
// bootstrappable in one call — vm_boot/js_notebook auto-create, app_create IS the
// create. The SECONDARY ops below are hidden from the main agent UNTIL a current
// instance of their kind exists in the chat; they appear the step after one is
// created (the SW recomputes the descriptor list per step — agent-loop's
// refreshTools — and every create path sets the session default). This shrinks
// the always-on surface (~12 tools deferred) for sharper tool selection without
// breaking any bootstrap flow. Keys match the instanceState shape the SW builds
// from the engine registries' getDefaultForSession() — the kind vocabulary is
// { webvm, notebook, app }.
export const INSTANCE_GATED_TOOLS = Object.freeze({
  webvm: Object.freeze(['vm_import', 'vm_write_file', 'vm_delete']),
  notebook: Object.freeze(['js_write_file', 'js_read_file', 'js_delete']),
  app: Object.freeze([
    'app_update', 'app_write_file', 'app_read_file',
    'app_list_files', 'app_delete_file', 'app_delete',
  ]),
});

// name → kind reverse index (frozen). null for any non-gated tool.
const GATED_TOOL_KIND = Object.freeze(
  Object.entries(INSTANCE_GATED_TOOLS).reduce((m, [kind, names]) => {
    for (const n of names) m[n] = kind;
    return m;
  }, /** @type {Record<string,string>} */ ({})),
);

/** The engine kind this tool is gated on ('webvm'|'notebook'|'app'), or null. Pure. @param {string} name @returns {string | null} */
export const instanceGateKind = (name) => GATED_TOOL_KIND[name] ?? null;

/**
 * Should this tool be HIDDEN from the main agent given the current engine-
 * instance state? `instanceState` is { webvm, notebook, app } booleans (does the
 * chat have a current instance of that kind). Non-gated tools are never hidden by
 * this rule. A null/absent instanceState fails CLOSED — gated ops stay hidden
 * until an instance is proven to exist (so a missing snapshot can't widen the
 * surface, and the dispatch gate refuses a premature op). Pure.
 *
 * @param {string} name
 * @param {{ webvm?: boolean, notebook?: boolean, app?: boolean } | null} [instanceState]
 * @returns {boolean}
 */
export const isInstanceGatedOut = (name, instanceState) => {
  const kind = /** @type {'webvm' | 'notebook' | 'app' | undefined} */ (GATED_TOOL_KIND[name]);
  if (!kind) return false;             // not an instance-gated op
  return !instanceState?.[kind];       // hidden unless that kind's instance exists
};

/**
 * Filter a descriptor list to what the main agent should see GIVEN the current
 * engine-instance state — drops instance-gated ops whose kind has no current
 * instance. Composes after mainAgentDescriptors() and the manifest filter. Pure.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {{ webvm?: boolean, notebook?: boolean, app?: boolean } | null} instanceState
 * @returns {T[]}
 */
export const filterByInstanceState = (descriptors, instanceState) =>
  descriptors.filter((t) => !isInstanceGatedOut(t.name, instanceState));

// ── DESIGN-17: actor tab agents — the capability tier ────────────────────
//
// A `kind:'actor'` session OWNS one tab-hosted instance and exclusively
// holds that environment's MUTATING tools. The split has two sides, both
// enforced at the dispatch gate (gates.js — the WALL, not just these
// descriptor filters which are advisory):
//
//   - ACTOR_MUTATING_TOOLS leave the MAIN agent. A non-actor ctx
//     (main / subagent / runner / review / direct) is REFUSED any of them —
//     so a one-line `spawn_subagent({tools:['app_delete']})` can't escalate.
//     Only MUTATION is tiered; READS (app_read_file/app_list_files/
//     js_read_file) stay GLOBAL + id-addressable, per the spec.
//   - An actor is POSITIVELY constrained to its own kind's toolset
//     (actorAllowedTools) — the keyless/narrow runner trust model
//     generalized: a hallucinated/injected non-env tool from an actor
//     fails closed at the gate, not just in the descriptor list.
//
// The exposure marker is a free string on ctx: 'main' (main turn) / 'actor'
// (actor turn) / unset (subagent/runner). EXPOSURE_ACTOR is a const so a
// typo can't silently widen authority at its (many) read sites; 'main' stays a
// bare literal — it's only ever the gate's negative space, never matched by name.
export const EXPOSURE_ACTOR = 'actor';

// The tiered MUTATION set — refused for every non-actor ctx (the main agent
// delegates these via message_actor). vm_boot/js_notebook are the RUN tools
// (they mutate instance state); edit_file is the cross-kind SEARCH/REPLACE write
// path for App/Notebook files; the rest are write/delete ops. js_run (headless,
// no instance) stays a parent tool and is deliberately ABSENT.
export const ACTOR_MUTATING_TOOLS = Object.freeze(new Set([
  'vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
  'js_notebook', 'js_write_file', 'js_delete',
  'app_update', 'app_write_file', 'app_delete_file', 'app_delete',
  'edit_file',
]));

/** Is this a tiered mutating tool (actor-only, off the main agent)? Pure. @param {string} name */
export const isActorMutatingTool = (name) => ACTOR_MUTATING_TOOLS.has(name);

// DESIGN-17 web-actor cutover — the do/get/check page RUNNER, folded into the
// actor model. The orchestrator reaches a page ONLY by messaging that tab's
// actor (open_tab + message_actor), so these leave the MAIN agent.
// Subagents (exposure unset) keep them — they can't message actors.
// The tools + the runner stay REGISTERED (a subagent still drives a page through
// them) — only the main-agent surface narrows.
export const RUNNER_PAGE_TOOLS = Object.freeze(new Set(['do', 'get', 'check']));

/** Is this one of the do/get/check page-runner tools? Pure. @param {string} name */
export const isRunnerPageTool = (name) => RUNNER_PAGE_TOOLS.has(name);

// DESIGN-17 web actor — the DOM toolset it owns. MUST mirror the runner's
// DO_TOOLSET (`runner/index.js`): the web actor IS the runner's lineage with a
// tier marker + a tab pin, so it holds exactly the runner's tools. Kept as a
// literal here (not imported) so exposure.js stays a leaf — a drift-guard test
// (exposure.test.ts) asserts equality with DO_TOOLSET. why these and not
// page_eval/page_exec: same as the runner — it ingests untrusted page text, so it
// must not also wield code-exec (the exclusion IS the boundary).
export const WEB_ACTOR_DOM_TOOLS = Object.freeze([
  'snapshot', 'read_page', 'read_state', 'watch_changes',
  'click', 'type', 'navigate', 'query_dom', 'page_keys', 'read_pdf',
]);

// The POSITIVE allow-list an actor of each kind may call — its own kind's
// operational surface (mutations + reads + edit_file). Everything else (other
// kinds' tools, browser/web/memory/spawn tools) is refused for an actor ctx.
// Keys match the actorType vocabulary { webvm, notebook, app, web }.
const ACTOR_TYPE_TOOLS = Object.freeze({
  webvm: Object.freeze(new Set([
    'vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
  ])),
  notebook: Object.freeze(new Set([
    'js_notebook', 'js_write_file', 'js_read_file', 'js_delete', 'edit_file',
  ])),
  app: Object.freeze(new Set([
    'app_update', 'app_write_file', 'app_read_file', 'app_list_files',
    'app_delete_file', 'app_delete', 'edit_file',
  ])),
  // The web actor owns a tab via the DOM toolset. The DOM mutators
  // (click/type/navigate) are NOT in ACTOR_MUTATING_TOOLS — they're contained
  // for the main agent by MAIN_AGENT_HIDDEN_TOOLS (the exposure axis), and the
  // runner (exposure unset) keeps using them. Putting them in this POSITIVE set
  // is what lets a web-actor ctx call them (gate rule 2) — the reconciliation.
  // PLUS fetch_url: the web actor's SESSIONLESS non-render mechanism, added
  // OUTSIDE WEB_ACTOR_DOM_TOOLS so that set stays == the runner's DO_TOOLSET
  // (the drift guard). The web actor is the only ctx allowed fetch_url, and the
  // capability strip (spawn.js) keeps it keyless: webFetch survives, getSecret /
  // safeFetch do not.
  web: Object.freeze(new Set([...WEB_ACTOR_DOM_TOOLS, 'fetch_url'])),
});

/** The Set of tool names an actor of `kind` may call (empty for an unknown kind). Pure. @param {string} [kind] */
export const actorAllowedTools = (kind) =>
  ACTOR_TYPE_TOOLS[/** @type {keyof typeof ACTOR_TYPE_TOOLS} */ (kind)] ?? new Set();

/** May an actor of `kind` call this tool? Pure. @param {string} name @param {string} [kind] */
export const isAllowedForActorType = (name, kind) => actorAllowedTools(kind).has(name);

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
// string — `actorTargetId` (string-only) can't express it. The web actor's
// `actorInstanceId` is its owned tabId AS A STRING. The GATE runs before
// `resolveTargetTab` (async) and can only see the explicit arg, so this checks
// the EXPLICIT `args.tabId`: absent → defaults to the bound tab (fine); present
// and ≠ the owned tab → refused.
/**
 * The explicit numeric `tabId` a DOM-tool call names, or undefined. Pure.
 * @param {Record<string, any> | null | undefined} args
 * @returns {number | undefined}
 */
export const actorWebTabTarget = (args) =>
  args && typeof args.tabId === 'number' ? args.tabId : undefined;

/**
 * The descriptor list an actor of `kind` should SEE — its own kind's toolset.
 * Pure. (The gate is the wall; this keeps the model's advertised list tight.)
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @param {string} [kind] @returns {T[]}
 */
export const actorDescriptors = (descriptors, kind) => {
  const allow = actorAllowedTools(kind);
  return descriptors.filter((t) => allow.has(t.name));
};

/**
 * Re-shape the MAIN agent's descriptor list for the actor world: the instance-
 * mutating tier and the do/get/check page runner both LEAVE the main agent (it
 * bootstraps + delegates via message_actor, which it keeps). Pure; composes
 * after mainAgentDescriptors()/the instance/dweb/goal filters.
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @returns {T[]}
 */
export const filterActorSurface = (descriptors) =>
  descriptors.filter((t) => !ACTOR_MUTATING_TOOLS.has(t.name) && !RUNNER_PAGE_TOOLS.has(t.name));

// ── dweb tools: gated on the dweb being enabled ─────────────────────────────
// The dweb network tools (publish/discover/install) are exposed to the agent
// ONLY when the dweb is on. On the store build the agent never sees them — the
// boundary's "channel behavior never exposed to the agent": the tool still
// registers (so dispatch can refuse it by name), it's just absent from the
// descriptor list the model reads. A tool opts in with `dweb: true`.
/** @param {Partial<Tool> | null | undefined} tool reads only the dweb flag */
export const isDwebTool = (tool) => tool?.dweb === true;

/**
 * Drop dweb tools from a descriptor list when the dweb is off. Composes after
 * mainAgentDescriptors() + filterByInstanceState(). Pure.
 *
 * @template {{ name: string, dweb?: boolean }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {boolean} dwebOn  DWEB_ENABLED && the dwebEnabled setting
 * @returns {T[]}
 */
export const filterByDwebEnabled = (descriptors, dwebOn) =>
  dwebOn ? [...descriptors] : descriptors.filter((t) => !isDwebTool(t));

// ── dweb tools: progressive disclosure of the SECONDARY surface ──────────────
// The dweb family has ENTRY tools — discover/share/install AND dweb_guide — always
// on when the dweb is enabled, so a session can start a dweb flow (or read the
// bridge reference BEFORE building a multiplayer dwapp) in one call. The SECONDARY
// tools below (the sovereign controls) stay hidden until the session has ENGAGED
// the dweb — i.e. a dweb tool was actually called this session. Then they appear
// the next step, exactly like an instance-gated op after a create.
//
// why dweb_guide is ENTRY, not secondary: the prompt tells the agent to call it
// FIRST when building a shared app — which is BEFORE any other dweb tool, so
// dwebActive is still false. Gating it created a chicken-and-egg (the agent
// couldn't see the tool it was told to call first, and fell back to load_skill).
// The tool schema is tiny; the bulky guide text only loads when it's CALLED, so
// keeping it always-visible costs ~nothing and keeps the bridge how-to reachable.
//
// why ENGAGEMENT, not connectivity (for the rest): the base network is always-on
// and auto-connects to whatever peers are online, so "has peers" is true within
// seconds for nearly everyone — a useless signal. Calling a dweb tool (dweb_discover
// is the natural opener) is real intent. Mirrors INSTANCE_GATED_TOOLS.
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
export const GOAL_ONLY_TOOLS = Object.freeze(new Set(['complete_goal']));

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
