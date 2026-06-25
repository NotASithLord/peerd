// @ts-check
// Tool exposure policy — which tools the MAIN agent sees.
//
// After the do/get/check cutover, the main agent's browser surface is just
// {do, get, check} plus list_tabs / open_tab (tab management — they return no
// page content). The low-level DOM/page tools (a11y snapshots, element refs,
// click/type/navigate, raw page content, code-exec) are HIDDEN from the main
// agent — they belong to the disposable browser-runner, reached only through
// do/get/check. This keeps untrusted page content and ref noise out of the main
// context: the security + long-task-reliability thesis.
//
// The tools remain REGISTERED; the runner still receives them via tool
// narrowing (spawn.js). This module ONLY filters what the MAIN model SEES. It is
// the minimal realization of the V1.3 exposure manifest (gates.js exposureGate).
//
// Pure — unit-tested. The SW applies mainAgentDescriptors() to the main turn's
// descriptor list, and leaves getToolDescriptors() (the runner's source) full.

// The DOM/page tools hidden from the MAIN agent. The runner uses these. Keep in
// sync with peerd-runtime/runner/index.js DO_TOOLSET / READ_TOOLSET (those are
// the runner-side allow-list; this is the main-side deny-list).
//
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
// submit_form is hidden too: it's a 'tab' tool that opens a tab, submits a form,
// and returns raw post-submit PAGE TEXT to the caller — a content leak that
// bypasses the runner. do() covers form submission now (and respects the
// single-tab model submit_form's own-tab-open would break). NOT hidden, and
// deliberately so: list_tabs/open_tab (tab metadata only, no page content) and
// capture (its image is redacted to a sentinel before the model sees it —
// loop/redact.js). The web-fetch tools read_article/call_api are a SEPARATE
// primitive ('web') with their own <untrusted_web_content> wrapping; the runner
// is the BROWSER-page boundary, not the web-fetch boundary.
export const MAIN_AGENT_HIDDEN_TOOLS = Object.freeze(new Set([
  'read_page', 'snapshot', 'read_state', 'watch_changes', 'query_dom',
  'page_eval', 'page_exec', 'page_keys', 'navigate', 'type', 'click',
  'submit_form',
  // read_pdf returns untrusted PDF text — same boundary as read_page; the
  // runner reaches it through get/do.
  'read_pdf',
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

// ── DESIGN-17: resident tab agents — the capability tier ────────────────────
//
// A `kind:'resident'` session OWNS one tab-hosted instance and exclusively
// holds that environment's MUTATING tools. The split has two sides, both
// enforced at the dispatch gate (gates.js — the WALL, not just these
// descriptor filters which are advisory):
//
//   - RESIDENT_MUTATING_TOOLS leave the MAIN agent. A non-resident ctx
//     (main / subagent / runner / review / direct) is REFUSED any of them —
//     so a one-line `spawn_subagent({tools:['app_delete']})` can't escalate.
//     Only MUTATION is tiered; READS (app_read_file/app_list_files/
//     js_read_file) stay GLOBAL + id-addressable, per the spec.
//   - A resident is POSITIVELY constrained to its own kind's toolset
//     (residentAllowedTools) — the keyless/narrow runner trust model
//     generalized: a hallucinated/injected non-env tool from a resident
//     fails closed at the gate, not just in the descriptor list.
//
// The exposure marker is a free string on ctx: 'main' (main turn) / 'resident'
// (resident turn) / unset (subagent/runner). Consts here so a typo can't
// silently widen authority. All of this is behind shared/flags.js
// RESIDENT_TAB_AGENTS — with the flag OFF these sets are referenced by nothing
// load-bearing and instance tools stay on the main agent exactly as today.
export const EXPOSURE_MAIN = 'main';
export const EXPOSURE_RESIDENT = 'resident';

// The tiered MUTATION set — refused for every non-resident ctx when the flag is
// on. vm_boot/js_notebook are the RUN tools (they mutate instance state);
// edit_file is the cross-kind SEARCH/REPLACE write path for App/Notebook files;
// the rest are write/delete ops. js_run (headless, no instance) stays a parent
// tool and is deliberately ABSENT.
export const RESIDENT_MUTATING_TOOLS = Object.freeze(new Set([
  'vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
  'js_notebook', 'js_write_file', 'js_delete',
  'app_update', 'app_write_file', 'app_delete_file', 'app_delete',
  'edit_file',
]));

/** Is this a tiered mutating tool (resident-only when the flag is on)? Pure. @param {string} name */
export const isResidentMutatingTool = (name) => RESIDENT_MUTATING_TOOLS.has(name);

// DESIGN-17 web resident — the DOM toolset it owns. MUST mirror the runner's
// DO_TOOLSET (`runner/index.js`): the web resident IS the runner's lineage with a
// tier marker + a tab pin, so it holds exactly the runner's tools. Kept as a
// literal here (not imported) so exposure.js stays a leaf — a drift-guard test
// (exposure.test.ts) asserts equality with DO_TOOLSET. why these and not
// page_eval/page_exec: same as the runner — it ingests untrusted page text, so it
// must not also wield code-exec (the exclusion IS the boundary).
export const WEB_RESIDENT_DOM_TOOLS = Object.freeze([
  'snapshot', 'read_page', 'read_state', 'watch_changes',
  'click', 'type', 'navigate', 'query_dom', 'page_keys', 'read_pdf',
]);

// The POSITIVE allow-list a resident of each kind may call — its own kind's
// operational surface (mutations + reads + edit_file). Everything else (other
// kinds' tools, browser/web/memory/spawn tools) is refused for a resident ctx.
// Keys match the residentKind vocabulary { webvm, notebook, app, web }.
const RESIDENT_KIND_TOOLS = Object.freeze({
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
  // The web resident owns a tab via the DOM toolset. The DOM mutators
  // (click/type/navigate) are NOT in RESIDENT_MUTATING_TOOLS — they're contained
  // for the main agent by MAIN_AGENT_HIDDEN_TOOLS (the exposure axis), and the
  // runner (exposure unset) keeps using them. Putting them in this POSITIVE set
  // is what lets a web-resident ctx call them (gate rule 2) — the reconciliation.
  web: Object.freeze(new Set(WEB_RESIDENT_DOM_TOOLS)),
});

/** The Set of tool names a resident of `kind` may call (empty for an unknown kind). Pure. @param {string} [kind] */
export const residentAllowedTools = (kind) =>
  RESIDENT_KIND_TOOLS[/** @type {keyof typeof RESIDENT_KIND_TOOLS} */ (kind)] ?? new Set();

/** May a resident of `kind` call this tool? Pure. @param {string} name @param {string} [kind] */
export const isAllowedForResidentKind = (name, kind) => residentAllowedTools(kind).has(name);

// Per-tool target-id ARG field — what a resident-gated tool calls its instance
// target. The resident dispatch wrapper force-injects the bound id here (the
// per-instance pin); the gate reads it for a defense-in-depth mismatch refusal.
// null = no explicit id arg (the tool resolves the session-default instance,
// which for a resident is its bound instance via setDefaultForSession).
const RESIDENT_TARGET_ID_FIELD = Object.freeze({
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
export const residentTargetIdField = (name) =>
  /** @type {Record<string, string|null>} */ (RESIDENT_TARGET_ID_FIELD)[name] ?? null;

/**
 * The EXPLICIT instance id/name a tool call names, or undefined when it names
 * none (relying on the session-default). Pure — read-only over args.
 * @param {string} name @param {Record<string, any> | null | undefined} args @returns {string | undefined}
 */
export const residentTargetId = (name, args) => {
  const field = residentTargetIdField(name);
  if (!field || !args) return undefined;
  const v = args[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

// DESIGN-17 web resident — the tab pin. A web resident owns ONE tab; the DOM
// tools resolve their target via `resolveTargetTab`, which honors an explicit
// numeric `args.tabId`. So the pin is on tabId (a number), not an instance-id
// string — `residentTargetId` (string-only) can't express it. The web resident's
// `residentInstanceId` is its owned tabId AS A STRING. The GATE runs before
// `resolveTargetTab` (async) and can only see the explicit arg, so this checks
// the EXPLICIT `args.tabId`: absent → defaults to the bound tab (fine); present
// and ≠ the owned tab → refused.
/**
 * The explicit numeric `tabId` a DOM-tool call names, or undefined. Pure.
 * @param {Record<string, any> | null | undefined} args
 * @returns {number | undefined}
 */
export const residentWebTabTarget = (args) =>
  args && typeof args.tabId === 'number' ? args.tabId : undefined;

/**
 * The descriptor list a resident of `kind` should SEE — its own kind's toolset.
 * Pure. (The gate is the wall; this keeps the model's advertised list tight.)
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @param {string} [kind] @returns {T[]}
 */
export const residentDescriptors = (descriptors, kind) => {
  const allow = residentAllowedTools(kind);
  return descriptors.filter((t) => allow.has(t.name));
};

/**
 * Re-shape the MAIN agent's descriptor list for the resident world. Flag ON:
 * the mutating tier LEAVES the main agent (it delegates via message_resident,
 * which is kept). Flag OFF: status quo — the mutating tier stays on main and
 * message_resident is hidden (its orchestrator isn't wired). Pure; composes
 * after mainAgentDescriptors()/the instance/dweb/goal filters.
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors @param {boolean} flagOn @returns {T[]}
 */
export const filterResidentSurface = (descriptors, flagOn) =>
  flagOn
    ? descriptors.filter((t) => !RESIDENT_MUTATING_TOOLS.has(t.name))
    : descriptors.filter((t) => t.name !== 'message_resident');

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
