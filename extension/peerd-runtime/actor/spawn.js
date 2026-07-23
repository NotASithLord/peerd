// @ts-check
// Actor orchestrator (docs/ACTORS.md).
//
// An actor is NOT a fourth engine kind — it's an orchestration
// primitive. "Who is reasoning about the next step?" is the agent loop,
// the *r* letter. So an actor is just a session with parentage that
// runs the SAME runUserTurn loop the top-level chat does. This file
// sets up the call args (a fresh child session, a narrowed tool subset,
// a task-focused system prompt, an output cap) and invokes the existing
// loop. It does NOT duplicate the loop.
//
// Two surfaces call in here through one orchestrator (same audit, same
// gates, same permission inheritance):
//   - the `actor_create` tool        (the model decomposing a task)
//   - the `actor/spawn` SW route    (Notebook code via peerd.runtime.runAgent)
//
// Functional-core/imperative-shell as everywhere else: every IO surface
// (the loop, the model, the dispatcher, the session store, the prompt
// renderer, audit) is INJECTED. That keeps this module unit-testable in
// Bun without resolving the extension's `/`-rooted import graph.

// Deep imports of PURE policy modules (not module barrels) so this file
// stays importable under the bun test runner — same pattern as
// tools/gates.js. confirmActionsFromRecord normalizes legacy permission
// records; resolveManifestAllow resolves the parent session's tool
// manifest into the allow-set the narrowing intersects.
import { confirmActionsFromRecord } from '../permissions/policy.js';
import { resolveManifestAllow } from '../tools/manifests.js';
// The MAIN-AGENT tool surface: an actor is a CHILD of the main agent and must hold
// no more than it could. mainAgentDescriptors drops MAIN_AGENT_HIDDEN_TOOLS (the
// actor-only DOM/page/fetch tools — read_page, page_exec, click, navigate, fetch_url,
// …) so an actor cannot reach the user's foreground tab (DESIGN-17: web/DOM work
// goes through the web actor via message_actor, never a raw grant); filterActorSurface
// drops the actor-only instance tier (vm_*/js_*/app_*/edit_file — writes AND the
// fenced reads, already gate-refused for a non-actor). Both are pure.
import { mainAgentDescriptors, filterActorSurface, REVIEW_INSTANCE_READS, EXPOSURE_REVIEW } from '../tools/exposure.js';

/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */

// Guardrail defaults (docs/ACTORS.md §guardrails). Callers may lower
// them per spawn; they can't be raised past the loop's own MAX_STEPS
// backstop (runUserTurn clamps maxSteps itself).
export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// Wall-clock ceiling for a child's WHOLE run (spawned-as-async-actors,
// PR #134 phase 2). Before this, an actor had only step/depth caps — a
// single hung tool call or provider stall could park it forever, with no
// abort path (no signal was threaded) and nothing to wake the parent. The
// timer aborts the child's turn-slot controller, so the loop unwinds
// through its normal abort branch (persists the partial, stopReason
// 'aborted') and the parent is woken with a timeout-flagged result.
// Callers may pass timeoutMs lower or higher, clamped to MAX — the same
// "can't be raised past the backstop" posture as maxSteps.
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * Compute the tool subset an actor may use.
 *
 * Rules, in order (docs/ACTORS.md §tool-narrowing):
 *   - explicit `tools: [...]` → exactly those names (intersected with
 *     what's actually registered). An empty array means NO tools.
 *   - otherwise → inherit the parent's full set.
 *   - either way → intersect with `allow` (the parent SESSION's resolved
 *     tool manifest, tools/manifests.js) when one is set. A manifest is
 *     an authority BOUND on the whole session tree: a child's effective
 *     set can be narrower than its parent's, never wider. null = no
 *     manifest = no extra cut.
 *   - either way → strip `actor_create` unless `allowRecursion`. This
 *     is the recursion guard; it always applies, even to an explicit
 *     list, so an actor can't out-clever its way into spawning.
 *
 * Pure — exported for direct unit testing.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} available  full registered descriptors
 * @param {{ tools?: string[], allowRecursion?: boolean, allow?: Set<string> | null }} opts
 * @returns {ReadonlyArray<T>}
 */
export const narrowTools = (available, { tools, allowRecursion = false, allow = null } = {}) => {
  /** @type {ReadonlyArray<T>} */
  let subset = available;
  if (Array.isArray(tools)) {
    const want = new Set(tools);
    subset = available.filter((t) => want.has(t.name));
  }
  if (allow instanceof Set) {
    subset = subset.filter((t) => allow.has(t.name));
  }
  if (!allowRecursion) {
    subset = subset.filter((t) => t.name !== 'actor_create');
  }
  return subset;
};

// ── capability-by-need stripping for narrowed child contexts ──────────────
//
// why: childCtx carries the FULL set of capability CLOSURES buildToolContext
// hands every context — getSecret (→ the unlocked vault DK), safeFetch/webFetch
// (egress), the spawn closures (escalation), memory, kv/idb, dweb (signs as the
// user). Tool NARROWING only limits which tools the model may NAME; it does NOT
// remove those closures from the heap object the child shares with the service
// worker. So a confused-deputy bug in a granted tool (e.g. a DOM tool fed
// crafted args) would have the vault one property access away in a SHARED heap.
// We close it BY CONSTRUCTION: strip every capability closure that NONE of the
// child's granted tools consume, so a narrowed child's context literally has no
// path to secrets/egress/spawn. The heap split now runs the child's loop in its
// OWN Worker heap (offscreen path) where it never receives these closures at all
// — this restrict is the SW-side ctx build the tool-dispatch route reuses per
// relayed call, AND the standalone defense for the in-SW fallback (Firefox /
// offscreen unavailable), where the shared-heap soft spot still applies.
//
// The lists below are the COMPLETE set of ctx.<cap> readers among tools
// (grep `ctx.<cap>` over tools/**). getSecret/safeFetch have NO tool reader —
// the provider key and the provider-allowlisted fetch are the agent LOOP's,
// injected via spawn deps, never read off childCtx — so they are always stripped
// from a child. A capability with no granted consumer is removed; everything
// else (denylist, allowlist, activeTab, debuggerPool, scripting, domRefs, tabs,
// confirm, audit, …) is untouched. Keep a list in sync if a new tool reads a
// capability off ctx — fail-safe is conservative here: an UNLISTED reader whose
// tool is granted would lose its closure (a loud throw, not a silent bypass).
export const CAPABILITY_CONSUMERS = Object.freeze({
  getSecret:          [],
  safeFetch:          [],
  webFetch:           ['vm_import', 'fetch_url'],
  webCache:           ['fetch_url', 'read_web_cache', 'read_page'],
  // DESIGN-19 site clients — the two-tier store (run/read/write reach it) and the
  // capture closure (site_capture only). Stripped from any child/actor whose
  // toolset lacks them, like every other capability-by-need closure.
  siteClients:        ['site_client_run', 'site_client_read', 'site_client_write'],
  siteCapture:        ['site_capture'],
  memory:             ['read_memory', 'remember'],
  kv:                 ['inspect'],
  idb:                ['inspect'],
  spawnActor:      ['actor_create'],
  spawnActorAsync: ['actor_create'],
  actorTasks:      ['actor_tasks'],
  actorCancel:     ['actor_cancel'],
  requestReview:      ['request_review'],
  // sandbox_create's app arm reads ctx.dweb to decide whether to build a
  // dwapp, so it keeps the dweb closure alongside the dweb_* tools.
  dweb:               ['dweb_share', 'dweb_discover', 'dweb_install', 'dweb_peers',
    'dweb_block', 'dweb_discovery', 'dweb_guide', 'sandbox_create'],
  // DESIGN-17: the engine instance closures buildToolContext injects into EVERY
  // ctx — the SW-side clients + registries + tab trackers that the
  // vm_*/js_*/app_*/edit_file tools reach through. Listing them here strips them
  // from any narrowed child whose granted tools don't read them — the keyless tool
  // ctx the actor relies on, and the confused-deputy close for plain spawned.
  // The reader lists are EXHAUSTIVE (an omitted reader silently loses its closure
  // and the tool returns `*_not_available`, never a crash — covered by tests).
  // NOTE: edit_file reaches appRegistry/jsRegistry via a COMPUTED property
  // (edit-file.js: ctx[kind==='app'?'appRegistry':'jsRegistry']), so it must be
  // listed in BOTH despite not matching a `.appRegistry` grep.
  // actor_list reads the registries + tab trackers of ALL three engine kinds
  // (plus tabs + listApiIntegrations, which are ungated/always present) to build
  // the unified catalog — so it appears in every engine registry+tracker list.
  vm:                 ['vm_boot', 'vm_write_file', 'vm_import'],
  vmRegistry:         ['sandbox_create', 'vm_delete', 'vm_boot', 'actor_list'],
  vmTabTracker:       ['sandbox_create', 'vm_delete', 'actor_list'],
  jsClient:           ['js_notebook', 'js_write_file', 'js_read_file', 'edit_file'],
  jsRegistry:         ['js_notebook', 'sandbox_create', 'js_delete', 'edit_file', 'actor_list'],
  jsTabTracker:       ['sandbox_create', 'js_delete', 'actor_list'],
  jsOffscreenClient:  ['script', 'a2a_run', 'page_code', 'site_client_run'],
  appClient:          ['sandbox_create', 'app_open', 'app_update', 'app_write_file',
    'app_read_file', 'app_list_files', 'app_delete_file', 'app_delete', 'app_search', 'edit_file'],
  appRegistry:        ['app_delete', 'edit_file', 'actor_list'],
  appTabTracker:      ['actor_list'],
  messageActor:    ['message_actor'],
  // The script tool's run registry (Stop plumbing for its actors surface). A
  // narrowed child without the script grant loses it; one granted script but
  // not message_actor keeps the registry yet loses the messageActor closure —
  // and script's actors mint requires BOTH, so its delegation surface composes
  // off exactly the same grant that message_actor itself needs.
  scriptRuns:      ['script'],
  // DESIGN-17: the web actor's lazy tab-open hook (SW-injected for kind:'web' only).
  // navigate reads it to open/adopt the actor's tab when it owns none; kept for the
  // web actor (which has navigate), stripped from any kind whose toolset lacks it.
  adoptWebTab:        ['navigate'],
});

/**
 * Return a COPY of a child tool-context with every capability closure no granted
 * tool needs removed. Pure — never mutates the input (so the parent ctx the
 * closures are shared from is untouched). `allowedNames` is the child's granted
 * tool-name Set (post tool-narrowing + manifest intersection).
 *
 * @param {Record<string, unknown>} ctx
 * @param {Set<string>} allowedNames
 * @returns {Record<string, unknown>}
 */
export const restrictCtxCapabilities = (ctx, allowedNames) => {
  const out = { ...ctx };
  for (const [cap, consumers] of Object.entries(CAPABILITY_CONSUMERS)) {
    if (!consumers.some((name) => allowedNames.has(name))) delete out[cap];
  }
  return out;
};

/**
 * Pull the actor's "result" — the final assistant text — out of a
 * completed session. The last assistant message with text content is
 * the answer; tool-only assistant turns before it are intermediate.
 *
 * @param {Session | undefined} session
 * @returns {string}
 */
export const finalAssistantText = (session) => {
  const messages = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) {
      return m.content;
    }
  }
  return '';
};

/**
 * Build an actor orchestrator bound to its IO dependencies. The SW
 * calls this once at boot and injects the bound `spawnActor` into the
 * tool context (so the `actor_create` tool reaches it) and exposes it
 * on the `actor/spawn` route (so the Notebook reaches it).
 *
 * @param {Object} deps
 * @param {ReturnType<typeof import('../sessions/store.js').createSessionStore>} deps.sessions
 * @param {typeof import('../loop/agent-loop.js').runUserTurn} deps.runUserTurn
 * @param {(args: object) => AsyncIterable<any>} deps.callModel
 *   provider stream factory; element type is the erased ProviderEvent union
 *   (the SW binds a real provider, tests bind a mock — kept `any` so a mock
 *   stream doesn't have to reconstruct the full discriminated union)
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.safeFetch
 * @param {(entry: object) => Promise<unknown>} deps.appendAudit
 * @param {(opts: { sessionId: string, activeTabId?: number }) => Promise<object>} deps.buildToolContext
 *   SW variant of buildToolContext that targets an explicit session id.
 * @param {(call: import('/shared/tool-types.js').ToolCall, ctx: object) => Promise<import('/shared/tool-types.js').ToolResult | { ok: boolean, content?: string, error?: string }>} deps.dispatchToolCall
 * @param {(opts: object) => Promise<string>} deps.renderSystemPrompt
 * @param {() => Array<{ name: string, description: string, schema: object }>} deps.getToolDescriptors
 *   Returns the full registered tool descriptor set (parent's tools).
 * @param {() => number} [deps.now]
 * @param {{ claim: (sessionId: string) => { controller: AbortController, release: () => void }, stop: (sessionId: string) => boolean }} [deps.turnSlots]
 *   The per-session turn-slot system (loop/turn-slots.js). PR #134 phase 1: a
 *   child runs UNDER a slot so it is abortable — Stop, the wall-clock timeout,
 *   and actorCancel all reach it via the slot's controller. The default is a
 *   standalone stub (a fresh controller per spawn, stop() a no-op) so orchestrators
 *   that never stop children (tests, cheap-call harnesses) need no wiring.
 * @param {(call: Record<string, any>) => void} [deps.recordModelCall]
 *   The context inspector's capture hook — sees the in-SW fallback loop's model
 *   calls (the offscreen path is captured at the actor relay). Optional no-op.
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: unknown) => void} [deps.clearTimer]
 *   Injected timer pair (setTimeout/clearTimeout in the SW) so the timeout is
 *   Bun-testable without real waiting.
 * @param {((job: object, opts?: { signal?: AbortSignal, onEvent?: (ev: object) => void }) => Promise<{ ok: boolean, started?: boolean, finalText?: string, newMessages?: any[], usage?: any, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean }>) | null} [deps.runChildOffscreen]
 *   Heap split: run a child's loop in a dedicated offscreen Worker (its own heap;
 *   key never enters it). Tool-less children only relay the model call; tool-bearing
 *   children (job.tools set) also relay each tool call to the SW-gated dispatch.
 *   null = use the in-SW loop.
 * @param {((task: string) => Promise<string> | string) | null} [deps.renderSystemPromptForChild]
 *   Render the child's system prompt SW-side for the offscreen path (the worker
 *   never assembles it). Required alongside runChildOffscreen.
 */
export const makeSpawnActor = (deps) => {
  const {
    sessions, runUserTurn, callModel, getSecret, safeFetch,
    appendAudit, buildToolContext, dispatchToolCall,
    renderSystemPrompt, getToolDescriptors,
    now = Date.now,
    turnSlots = {
      claim: () => ({ controller: new AbortController(), release: () => {} }),
      stop: () => false,
    },
    setTimer = (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
    // The context inspector's capture hook (optional no-op, same contract as
    // the turn driver's): sees the in-SW fallback loop's model calls.
    recordModelCall = () => {},
    clearTimer = (/** @type {unknown} */ handle) => clearTimeout(/** @type {any} */ (handle)),
    // Heap-split phase 1: run a PURE-REASONING (empty granted toolset) child in a
    // dedicated offscreen Worker — its own heap, no key, no chrome.*, egress-less.
    // Tool-bearing children run here too (heap-split phase 4): their tool calls
    // relay to the SW-gated dispatch. null → the in-SW loop (Firefox / offscreen
    // unavailable). renderSystemPromptForChild renders the child's prompt SW-side so
    // the worker never assembles it.
    runChildOffscreen = null,
    renderSystemPromptForChild = null,
  } = deps;

  // Live-children registry (phase 5, multi-hop Stop): parent → the child
  // sessions whose loops are CURRENTLY running under this orchestrator.
  // In-memory, in-session only — same durability posture as async-actors'
  // task map (a child lost to SW death is reported interrupted, never resumed).
  /** @type {Map<string, Set<string>>} */
  const liveChildren = new Map();
  /** @param {string} parentSessionId @param {string} childSessionId */
  const registerChild = (parentSessionId, childSessionId) => {
    const set = liveChildren.get(parentSessionId) ?? new Set();
    set.add(childSessionId);
    liveChildren.set(parentSessionId, set);
  };
  /** @param {string} parentSessionId @param {string} childSessionId */
  const unregisterChild = (parentSessionId, childSessionId) => {
    const set = liveChildren.get(parentSessionId);
    if (!set) return;
    set.delete(childSessionId);
    if (set.size === 0) liveChildren.delete(parentSessionId);
  };

  /** The DIRECT live children of a session. @param {string} parentSessionId @returns {string[]} */
  const liveChildrenOf = (parentSessionId) => [...(liveChildren.get(parentSessionId) ?? [])];

  // Phase 5 — transitive Stop. Abort every live descendant's turn slot,
  // depth-first from the given root (the root itself is the caller's to stop —
  // agent/stop already does). Returns the descendants whose slot actually
  // aborted, for the caller's audit trail. The cycle guard is defensive: the
  // registry is built from fresh child ids, but a corrupt map must not hang us.
  /** @param {string} rootSessionId @returns {string[]} */
  const stopSubtree = (rootSessionId) => {
    const stopped = [];
    const seen = new Set([rootSessionId]);
    const queue = liveChildrenOf(rootSessionId);
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (turnSlots.stop(id)) stopped.push(id);
      queue.push(...liveChildrenOf(id));
    }
    return stopped;
  };

  /**
   * @param {Object} req
   * @param {string} req.task                      the spawning prompt
   * @param {string[]} [req.tools]                 explicit tool-name subset
   * @param {string} [req.model]                   override the inherited model
   * @param {number} [req.maxSteps]                step cap (default 20)
   * @param {number} [req.maxOutputTokens]         per-call output cap (default 4096)
   * @param {number} [req.maxDepth]                depth ceiling (default 5)
   * @param {boolean} [req.allowRecursion]         keep actor_create in the subset
   * @param {boolean} [req.review]                 issue 160 - SW-ONLY. Set solely by the
   *   review orchestrator (review/orchestrator.js). Re-adds the three instance
   *   READS (REVIEW_INSTANCE_READS) to the grantable surface and stamps
   *   ctx.exposure='review', which the actor-tier gate admits for those three
   *   names only. NOT reachable from the model: actor_create builds its spawn
   *   request from an explicit field whitelist and never spreads args (pinned by
   *   a test in review.test.ts). Never accept this from a worker or tool arg.
   * @param {string} req.parentSessionId           who is spawning this
   * @param {number} [req.parentDepth]             spawner's depth (child = +1)
   * @param {boolean} [req.parentInbound]          was the SPAWNING turn inbound
   *   (untrusted-origin)? Stamped onto the child as `spawnedTrusted` — the
   *   per-hop verdict the trusted-lineage gate walks (delegation-lineage.js).
   *   FAIL-CLOSED: only an explicit `false` (the actor_create tool passes
   *   ctx.inbound) yields a trusted hop; undefined (the Notebook route, review,
   *   cheap-call, any legacy caller) taints the child — those children never
   *   had delegation, so nothing regresses.
   * @param {number} [req.timeoutMs]               wall-clock budget for the whole
   *   run (default DEFAULT_TIMEOUT_MS, clamped to MAX_TIMEOUT_MS)
   * @param {(ev: object) => void} [req.onEvent]   live forwarder for the side panel
   * @param {string} [req.parentToolUseId]         links the parent's card → child session
   * @param {boolean} [req.persistDeltas=true]      set false for ephemeral
   *   children (e.g. cheap-call): skips the per-streamed-delta full-record
   *   IDB rewrite. Finalization writes still happen — the result extraction
   *   below reads the COMPLETED session, which is the only persistence an
   *   ephemeral child needs (a mid-run SW death orphans the await anyway).
   * @returns {Promise<{ result: string, sessionId: string | null, toolCalls: number, durationMs: number, depth: number, usage?: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, exceeded?: true, refused?: true, timedOut?: true, stopped?: true }>}
   */
  const spawnActor = async (req) => {
    const {
      task,
      tools,
      model,
      maxSteps = DEFAULT_MAX_STEPS,
      maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
      maxDepth = DEFAULT_MAX_DEPTH,
      allowRecursion = false,
      // #160: SW-ONLY flag (the review orchestrator). Grants the three instance
      // reads + stamps the review exposure marker. Unreachable from model args.
      review = false,
      parentSessionId,
      parentDepth = 0,
      parentInbound,
      timeoutMs,
      onEvent,
      parentToolUseId,
      persistDeltas = true,
    } = req;

    if (typeof task !== 'string' || task.trim().length === 0) {
      return { result: 'actor refused: empty task', sessionId: null, toolCalls: 0, durationMs: 0, depth: parentDepth + 1, refused: true };
    }

    const depth = parentDepth + 1;

    // ---- Guardrail 1: maxDepth -------------------------------------------
    // Refuse BEFORE creating a session — a refused spawn leaves no trace
    // in the store, only an audit entry. This is what stops infinite
    // self-spawning regardless of allowRecursion.
    if (depth > maxDepth) {
      appendAudit({
        type: 'actor_refused',
        details: { reason: 'max_depth', depth, maxDepth, parentSessionId },
      }).catch(() => {});
      return {
        result: `actor refused: max depth ${maxDepth} exceeded (would be depth ${depth})`,
        sessionId: null,
        toolCalls: 0,
        durationMs: 0,
        depth,
        exceeded: true,
        refused: true,
      };
    }

    // ---- Inherit permissions + provider from the parent -------------------
    // Guardrail 3: the actor runs under the parent's Plan/Act
    // permission through the same six gates. It never escalates.
    // Provider/model inherit too (model overridable) so the actor
    // uses the same key + endpoint.
    const parent = await sessions.get(parentSessionId);
    const provider = parent?.provider ?? 'anthropic';

    // why: read the parent's confirm setting AT THE EDGE —
    // confirmActionsFromRecord pulls the `confirmActions` boolean off the
    // parent record so the CHILD record inherits it; undefined when the
    // parent has no explicit choice.
    const parentConfirmActions = confirmActionsFromRecord(parent);

    // ---- Guardrail 2: tool narrowing (computed BEFORE create) ------------
    // The parent session's tool manifest caps the child's set whatever the
    // caller asked for — intersection, never escalation (fail-closed: a
    // manifest naming none of the requested tools yields a tool-less child).
    // Hoisted above create (heap-split phase 4) so the granted set can be
    // PERSISTED on the child record: when a tool-bearing child runs in its own
    // offscreen heap, the SW rebuilds the child's restricted tool context from
    // this persisted set at dispatch time and NEVER trusts the worker's call.
    const parentAllow = resolveManifestAllow(parent?.toolManifest);
    // SECURITY (DESIGN-17): narrow from the MAIN-AGENT surface, not the full registry.
    // Without this, an actor could be granted the actor-only DOM/page tools (read_page,
    // page_exec, click, navigate, fetch_url, …) — which NO gate refuses for an actor
    // (exposure!=='main', not actor-mutating) — and drive/read the user's FOREGROUND tab,
    // authority the spawning agent itself lacks. Filtering the grantable universe here is
    // the fix: an actor holds ⊆ what the main agent holds, delegating web/DOM work to
    // the web actor via message_actor like the main agent does.
    // #160: a REVIEW spawn re-adds the three instance READS that filterActorSurface
    // just dropped — by name, from the descriptors we already have. This is the
    // whole exemption: a positive re-add, never "skip the narrowing for review"
    // (which would restore fetch_url / read_page / site_client_run too, i.e. build
    // the exfiltration channel the reviewer must not have). `review` can only be
    // set by an SW-side caller — the review orchestrator — because actor_create
    // builds its spawn request from an explicit field whitelist and never spreads
    // model args (pinned by a test).
    const surface = filterActorSurface(mainAgentDescriptors(getToolDescriptors()));
    const grantable = review
      ? surface.concat(
        getToolDescriptors().filter((t) => REVIEW_INSTANCE_READS.has(t.name)
          && !surface.some((s) => s.name === t.name)),
      )
      : surface;
    const subset = narrowTools(grantable, { tools, allowRecursion, allow: parentAllow });
    const allowedNames = new Set(subset.map((t) => t.name));
    const subsetDescriptors = subset.map((t) => ({
      name: t.name, description: t.description, schema: t.schema,
    }));

    const child = await sessions.create({
      kind: 'spawned',
      parentSessionId,
      depth,
      task,
      provider,
      ...(model ? { model } : parent?.model ? { model: parent.model } : {}),
      // why: inherit the parent's Plan/Act permission INTO the child
      // record at create time. The SW's resolvePermission falls back to
      // the GLOBAL cached mode/confirm setting when a session record
      // carries none — so without these fields a child spawned from a
      // Plan-mode parent could silently run under the global Act default
      // (a privilege escalation, the inverse of guardrail 3). Copy only
      // when present so a parent with no explicit choice keeps the
      // normal fallback.
      ...(parent?.permissionMode !== undefined ? { permissionMode: parent.permissionMode } : {}),
      ...(parentConfirmActions !== undefined ? { confirmActions: parentConfirmActions } : {}),
      // why: the tool MANIFEST inherits (unlike customSystemPrompt, which
      // deliberately does not — see below). The manifest is an authority
      // bound, not a preference: copying it into the child record means
      // the child's OWN tool context (buildToolContext reads the child
      // session) re-enforces it at dispatch, and a grandchild spawn
      // intersects against it again — no depth at which the narrowing
      // evaporates.
      ...(parent?.toolManifest !== undefined ? { toolManifest: parent.toolManifest } : {}),
      // Heap-split phase 4: the child's GRANTED toolset (post-narrowing), persisted
      // so the SW-side offscreen tool-dispatch route rebuilds the child's restricted
      // ctx from THIS list and re-checks every relayed call against it — the actor
      // analog of the actor instance-pin. The worker's call args are never trusted.
      grantedTools: [...allowedNames],
      // PR #134 phase 3 — the trusted-lineage hop verdict, stamped SERVER-SIDE
      // at create so the chain is never model-supplied. Trusted ONLY when the
      // spawning turn explicitly proved itself non-inbound; an inbound spawn
      // (or a caller that doesn't know) taints this child and — because the
      // gate requires every hop trusted — its whole subtree. This is what
      // closes the laundering hole: an injected turn refused message_actor
      // can't spawn a child to delegate on its behalf.
      spawnedTrusted: parentInbound === false,
    });

    // why: tag EVERY audit entry this actor produces with its
    // parentage + depth so the trail is reconstructable from any level
    // (guardrail 4). Both the loop's own audits and the dispatcher's
    // per-tool audits flow through this wrapped fn.
    /** @param {{ type: string, sessionId?: string, details?: object }} entry */
    const taggedAudit = (entry) => appendAudit({
      ...entry,
      details: { ...(entry.details ?? {}), parentSessionId, actorSessionId: child.sessionId, depth },
    });

    taggedAudit({ type: 'actor_spawned', details: { task: task.slice(0, 200), maxSteps, maxDepth } }).catch(() => {});

    // PR #134 phases 1+2 — claim the child's turn slot and arm the wall-clock
    // timer NOW, immediately after the session exists, BEFORE the tool-context
    // build below. why here and not later: a Stop cascade enumerates the
    // live-children registry, so a child not yet registered when Stop fires
    // would escape it and run its full budget post-Stop (the tighter the window
    // between create and register, the smaller that hole). Claiming the CHILD's
    // own slot (a fresh id — nothing contends it) gives Stop/cancel/timeout one
    // uniform lever: abort the controller, and the loop unwinds through its
    // normal abort branch exactly like a steered main turn.
    const { controller, release } = turnSlots.claim(child.sessionId);
    registerChild(parentSessionId, child.sessionId);
    let timerFired = false;
    // Clamp to the backstop either way: a caller may lower the budget freely,
    // but can't park a child past MAX (same posture as maxSteps).
    const budgetMs = Math.min(
      Number.isFinite(timeoutMs) && /** @type {number} */ (timeoutMs) > 0 ? /** @type {number} */ (timeoutMs) : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const timer = setTimer(() => {
      timerFired = true;
      appendAudit({
        type: 'actor_timeout',
        details: { parentSessionId, actorSessionId: child.sessionId, depth, budgetMs },
      }).catch(() => {});
      // why turnSlots.stop AND controller.abort: stop() fires the slot's onAbort
      // hook (confirmCoordinator.declineSession) so a child parked on a confirm
      // is declined at once instead of overshooting the budget by the confirm
      // protocol's own 120s timeout — the same path user Stop / cancel take.
      // The direct abort() is the guaranteed backstop (the injected stub stop()
      // is a no-op in tests); abort() is idempotent, so calling both is safe.
      turnSlots.stop(child.sessionId);
      controller.abort();
    }, budgetMs);
    // Reclaim the child on ITS OWN abort too (#1/#3): an actor blocked in an
    // awaitReply message_actor call is suspended in tool dispatch — the loop
    // only checks the signal at wave boundaries, so aborting the controller
    // doesn't unwind that await by itself. message_actor reads this signal off
    // ctx and races the actor reply against it, so the timeout / cancel that
    // fires this controller also unblocks the awaiting child.

    // The in-SW tool dispatcher — built LAZILY, only on the fallback path. The
    // offscreen happy path dispatches SW-side in the actor/tool-dispatch route
    // (rebuilding the child ctx from the persisted grantedTools), so building this
    // here — including the awaited buildToolContext — would be wasted work AND would
    // couple the offscreen run to a ctx build it never uses (a transient vault/settings
    // read that throws here would fail an offscreen child before it even starts). A
    // tools:[] actor is pure reasoning and never stands one up at all.
    /** @returns {Promise<((call: import('/shared/tool-types.js').ToolCall) => Promise<import('/shared/tool-types.js').ToolResult>) | undefined>} */
    const buildInSwToolDispatch = async () => {
      if (subsetDescriptors.length === 0) return undefined;
      const baseCtx = await buildToolContext({ sessionId: child.sessionId });
      // why restrictCtxCapabilities: capability-by-need. buildToolContext returns
      // the full capability surface (secrets/egress/spawn closures); we remove the
      // ones no granted tool needs so a narrowed child has no closure path to them
      // even if a granted tool were confused into reaching for one.
      // abortSignal (#1/#3): the child's own abort signal, so a blocking tool
      // (message_actor awaitReply) can race its wait against it and unwind when
      // the wall-clock timeout / cancel fires — restrictCtxCapabilities passes
      // through any key not in CAPABILITY_CONSUMERS, so this survives the strip.
      // The review marker is stamped HERE, SW-side, from the trusted spawn req —
      // never carried in from a worker or a model arg. gates.js keys the #160
      // exemption on it (positively, and only for the three read names).
      const childCtx = restrictCtxCapabilities({
        ...baseCtx, audit: taggedAudit, abortSignal: controller.signal,
        ...(review ? { exposure: EXPOSURE_REVIEW } : {}),
      }, allowedNames);
      return (call) => {
        // Defense in depth: even if the model hallucinates a tool name
        // outside its granted subset, the dispatch refuses it. The
        // descriptor narrowing is what the model SEES; this is what it
        // can DO.
        if (!allowedNames.has(call.name)) {
          return Promise.resolve({
            ok: false,
            error: `tool_not_available_to_actor: ${call.name}`,
            meta: { toolName: call.name, primitive: 'unknown', gates: [], durationMs: 0 },
          });
        }
        // why: dispatchToolCall's union return (a loose { ok, content?, error? }
        // for test mocks) is the dispatcher's real ToolResult at runtime.
        return /** @type {Promise<import('/shared/tool-types.js').ToolResult>} */ (
          dispatchToolCall(call, childCtx));
      };
    };

    // why no customSystemPrompt here: the parent session's /system
    // instructions are deliberately NOT inherited — an actor gets its
    // own task framing (taskOverride) and nothing else. The instructions
    // are user preferences for the parent CONVERSATION; leaking them
    // would distort the child's one-shot task and silently widen the
    // blast radius of a session-scoped instruction. Inheritance is
    // "absent", by design.
    const getSystemPrompt = () => renderSystemPrompt({ taskOverride: task });

    // Guardrail 5 (output cap): inject maxTokens into every model call.
    // Also the context inspector's THIRD seam: this wrapper only feeds the
    // in-SW fallback loop (Firefox / offscreen never started) — the
    // offscreen path's calls are captured at the actor/model-call relay.
    /** @param {object} modelArgs */
    const cappedCallModel = (modelArgs) => {
      recordModelCall({ ...modelArgs, sessionId: child.sessionId, label: `actor d${depth} (in-SW)` });
      return callModel({ ...modelArgs, maxTokens: maxOutputTokens });
    };

    // why: the child's model usage is yielded as 'usage' events but is NOT
    // folded into the parent/main turn tally (the main SW only accumulates its
    // OWN session's usage). That means actor spend is naturally SEPARATE from
    // main-agent spend (the main context stays clean). We sum it here so the
    // child's token cost is at least VISIBLE to the caller (eval telemetry /
    // success criterion 5), without polluting main. These counters are read
    // AFTER the finally, so they live in the outer scope.
    let toolCalls = 0;
    let lastStopReason;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let start = 0;
    let ranOffscreen = false;
    // MED-3: the slot is CLAIMED, the child REGISTERED, and the wall-clock timer
    // ARMED above — three resources the finally below is the sole releaser of.
    // So the try must open HERE, before anything else that can throw. In
    // particular the actor-start emit calls an external onEvent forwarder;
    // when that threw (it sat outside the try before), the timer, slot, and
    // registration all leaked — a stuck slot blocks the session forever and the
    // orphan timer later aborts a REUSED controller. Everything downstream of the
    // resource acquisition now runs guarded.
    try {
      start = now();
      // Announce the child up-front so the side panel can map the parent's
      // tool card → this session id and render live, before any loop event.
      onEvent?.({ type: 'actor-start', parentToolUseId, parentSessionId, sessionId: child.sessionId, depth, task });
      // Heap split: EVERY child runs its loop in a dedicated offscreen Worker — its
      // own heap, no key, no chrome.*, no egress. A tool-LESS child (phase 1) only
      // relays its model call; a tool-BEARING child (phase 4) also relays each tool
      // call to the SW, which rebuilds the child's restricted ctx from the persisted
      // grantedTools and dispatches there (so script and friends run from the child's
      // own heap, keyless). Falls back to the in-SW loop when offscreen isn't wired
      // (Firefox), when the prompt renderer is absent, or when the offscreen run
      // HARD-fails to start (a normal completion, even error/abort, does NOT fall back
      // — that would double-run).
      const canRunOffscreen = typeof runChildOffscreen === 'function'
        && typeof renderSystemPromptForChild === 'function';
      if (canRunOffscreen) {
        const systemPrompt = await renderSystemPromptForChild(task);
        const r = await runChildOffscreen({
          sessionId: child.sessionId, task, systemPrompt,
          provider, model: model ?? parent?.model, depth,
          maxSteps, maxOutputTokens, budgetMs,
          // The granted descriptors the worker advertises to the model; each call
          // it makes relays back to the SW-gated, grantedTools-checked dispatch.
          tools: subsetDescriptors,
        }, { signal: controller.signal, onEvent });
        // Fall back to the in-SW loop ONLY when the worker never STARTED (offscreen
        // unavailable / concurrency cap / spawn throw). A run that STARTED — even if
        // it errored, aborted, or timed out — may have billed model calls, so
        // re-running it in-SW would double-run; surface it as-is instead.
        if (r && (r.ok || r.started)) {
          ranOffscreen = true;
          // Reconstruct the child transcript SW-side (the worker's heap held it) so
          // finalAssistantText + the card read a coherent session. Prefer the worker's
          // FULL transcript when it crossed back (a tool-bearing child has tool rounds
          // worth showing on the card); fall back to a user+answer pair for a tool-less
          // child or when no transcript came back. Cast: minimal role/content records.
          const newMessages = Array.isArray(r.newMessages) ? r.newMessages : [];
          if (newMessages.length > 0) {
            for (const m of newMessages) await sessions.appendMessage(child.sessionId, /** @type {any} */ (m)).catch(() => {});
          } else {
            const stamp = new Date(now()).toISOString();
            await sessions.appendMessage(child.sessionId, /** @type {any} */ ({ id: `off-u-${now()}`, when: stamp, role: 'user', content: task })).catch(() => {});
            await sessions.appendMessage(child.sessionId, /** @type {any} */ ({ id: `off-a-${now()}`, when: stamp, role: 'assistant', content: r.finalText ?? '' })).catch(() => {});
          }
          toolCalls = r.toolCalls ?? 0;
          lastStopReason = r.aborted ? 'aborted' : (r.stopReason ?? (r.ok ? 'end_turn' : undefined));
          if (r.usage) {
            usage.inputTokens += r.usage.inputTokens || 0;
            usage.outputTokens += r.usage.outputTokens || 0;
            usage.cacheReadTokens += r.usage.cacheReadTokens || 0;
            usage.cacheWriteTokens += r.usage.cacheWriteTokens || 0;
          }
          taggedAudit(r.ok
            ? { type: 'actor_ran_offscreen', details: { heapSplit: true } }
            : { type: 'actor_offscreen_error', details: { heapSplit: true, error: r.error ?? 'unknown', aborted: r.aborted === true } }).catch(() => {});
        } else {
          // Never started → defensive fallback to the in-SW loop, so a reasoning
          // child never just dies on infra it couldn't even reach.
          taggedAudit({ type: 'actor_offscreen_fallback', details: { error: r?.error ?? 'unknown' } }).catch(() => {});
        }
      }
      if (!ranOffscreen) {
        // Lazily stand up the in-SW dispatcher — ONLY now, on the fallback (see
        // buildInSwToolDispatch). The offscreen path above never reaches here.
        const toolDispatch = await buildInSwToolDispatch();
        for await (const ev of runUserTurn({
          sessionId: child.sessionId,
          userText: task,
          callModel: cappedCallModel,
          getSecret,
          safeFetch,
          sessions,
          getSystemPrompt,
          appendAudit: taggedAudit,
          tools: subsetDescriptors,
          toolDispatch,
          maxSteps,
          persistDeltas,
          now,
          // Phase 1: the child is abortable — Stop cascades, actorCancel, and
          // the wall-clock timer all fire this controller.
          signal: controller.signal,
        })) {
          if (ev.type === 'tool-use') toolCalls++;
          if (ev.type === 'stop') lastStopReason = ev.stopReason;
          if (ev.type === 'usage' && ev.usage) {
            usage.inputTokens += ev.usage.inputTokens || 0;
            usage.outputTokens += ev.usage.outputTokens || 0;
            usage.cacheReadTokens += ev.usage.cacheReadTokens || 0;
            usage.cacheWriteTokens += ev.usage.cacheWriteTokens || 0;
          }
          onEvent?.(ev);
        }
      }
    } finally {
      clearTimer(timer);
      unregisterChild(parentSessionId, child.sessionId);
      // Release AFTER unregistering, so a Stop racing this settle can't abort a
      // slot the registry no longer owns up to.
      release();
      onEvent?.({ type: 'actor-stop', parentToolUseId, sessionId: child.sessionId, depth });
    }

    const durationMs = now() - start;
    const final = await sessions.get(child.sessionId);
    const result = finalAssistantText(final);
    // Guardrail 5 (step cap): a max_steps stop means the actor ran out
    // of room before finishing. Surface it so the caller (and the model)
    // knows the result may be partial.
    const exceeded = lastStopReason === 'max_steps';
    // Phase 2: distinguish WHY an abort unwound the loop — but ONLY when the
    // loop actually aborted. timerFired alone doesn't imply a timeout: the timer
    // can fire in the race window between a clean 'end_turn' finish and this
    // finally's clearTimer, which must NOT relabel a complete result as partial.
    // Gate both flags on lastStopReason==='aborted' (a real abort unwind), then
    // split by cause: timer → timedOut, anything else (Stop cascade, cancel) →
    // stopped. A non-aborted finish is neither.
    const aborted = lastStopReason === 'aborted';
    const timedOut = aborted && timerFired;
    const stopped = aborted && !timerFired;

    taggedAudit({
      type: 'actor_completed',
      details: { toolCalls, durationMs, exceeded, timedOut, stopped, resultChars: result.length },
    }).catch(() => {});

    return {
      result,
      sessionId: child.sessionId,
      toolCalls,
      durationMs,
      depth,
      usage,
      ...(exceeded ? { exceeded: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(stopped ? { stopped: true } : {}),
    };
  };

  // The registry accessors ride ON the spawn function (not a wrapper object) so
  // the ~25 existing construction sites — `const spawn = makeSpawnActor(d)` —
  // keep working unchanged; the SW picks the extras off the same value.
  return Object.assign(spawnActor, { liveChildrenOf, stopSubtree });
};
