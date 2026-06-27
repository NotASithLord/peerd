// @ts-check
// Subagent orchestrator (docs/SUBAGENTS.md).
//
// A subagent is NOT a fourth engine kind — it's an orchestration
// primitive. "Who is reasoning about the next step?" is the agent loop,
// the *r* letter. So a subagent is just a session with parentage that
// runs the SAME runUserTurn loop the top-level chat does. This file
// sets up the call args (a fresh child session, a narrowed tool subset,
// a task-focused system prompt, an output cap) and invokes the existing
// loop. It does NOT duplicate the loop.
//
// Two surfaces call in here through one orchestrator (same audit, same
// gates, same permission inheritance):
//   - the `spawn_subagent` tool        (the model decomposing a task)
//   - the `subagent/spawn` SW route    (Notebook code via peerd.runtime.runAgent)
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

/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */

// Guardrail defaults (docs/SUBAGENTS.md §guardrails). Callers may lower
// them per spawn; they can't be raised past the loop's own MAX_STEPS
// backstop (runUserTurn clamps maxSteps itself).
export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Compute the tool subset a subagent may use.
 *
 * Rules, in order (docs/SUBAGENTS.md §tool-narrowing):
 *   - explicit `tools: [...]` → exactly those names (intersected with
 *     what's actually registered). An empty array means NO tools.
 *   - otherwise → inherit the parent's full set.
 *   - either way → intersect with `allow` (the parent SESSION's resolved
 *     tool manifest, tools/manifests.js) when one is set. A manifest is
 *     an authority BOUND on the whole session tree: a child's effective
 *     set can be narrower than its parent's, never wider. null = no
 *     manifest = no extra cut.
 *   - either way → strip `spawn_subagent` unless `allowRecursion`. This
 *     is the recursion guard; it always applies, even to an explicit
 *     list, so a subagent can't out-clever its way into spawning.
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
    subset = subset.filter((t) => t.name !== 'spawn_subagent');
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
// crafted args) would have the vault one property access away — the precise
// soft spot of the single-thread/shared-heap model (docs §security, "not
// isolated like Cloudflare"). We close it BY CONSTRUCTION: strip every
// capability closure that NONE of the child's granted tools consume, so a
// browser-runner's context literally has no path to secrets/egress/spawn.
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
  webFetch:           ['call_api', 'read_article', 'web_search', 'vm_import', 'fetch_url'],
  memory:             ['read_memory', 'remember'],
  kv:                 ['inspect_storage'],
  idb:                ['inspect_audit_log'],
  spawnSubagent:      ['spawn_subagent'],
  spawnSubagentAsync: ['spawn_subagent'],
  subagentTasks:      ['subagent_tasks'],
  subagentCancel:     ['subagent_cancel'],
  requestReview:      ['request_review'],
  // app_create reads ctx.dweb to decide whether to build a dwapp, so it keeps
  // the dweb closure alongside the dweb_* tools.
  dweb:               ['dweb_share', 'dweb_discover', 'dweb_install', 'dweb_peers',
    'dweb_block', 'dweb_discovery', 'dweb_guide', 'app_create'],
  // DESIGN-17: the engine instance closures buildToolContext injects into EVERY
  // ctx — the SW-side clients + registries + tab trackers that the
  // vm_*/js_*/app_*/edit_file tools reach through. Listing them here strips them
  // from any narrowed child whose granted tools don't read them — the keyless tool
  // ctx the resident relies on, and the confused-deputy close for plain subagents.
  // The reader lists are EXHAUSTIVE (an omitted reader silently loses its closure
  // and the tool returns `*_not_available`, never a crash — covered by tests).
  // NOTE: edit_file reaches appRegistry/jsRegistry via a COMPUTED property
  // (edit-file.js: ctx[kind==='app'?'appRegistry':'jsRegistry']), so it must be
  // listed in BOTH despite not matching a `.appRegistry` grep.
  vm:                 ['vm_boot', 'vm_write_file', 'vm_import'],
  vmRegistry:         ['vm_create', 'vm_delete', 'vm_boot', 'vm_list'],
  vmTabTracker:       ['vm_create', 'vm_delete', 'vm_list'],
  jsClient:           ['js_notebook', 'js_write_file', 'js_read_file', 'edit_file'],
  jsRegistry:         ['js_notebook', 'js_create', 'js_delete', 'js_list', 'edit_file'],
  jsTabTracker:       ['js_create', 'js_delete', 'js_list'],
  jsOffscreenClient:  ['js_run'],
  appClient:          ['app_create', 'app_open', 'app_update', 'app_write_file',
    'app_read_file', 'app_list_files', 'app_delete_file', 'app_delete', 'app_search', 'edit_file'],
  appRegistry:        ['app_delete', 'app_list', 'edit_file'],
  appTabTracker:      ['app_list'],
  messageResident:    ['message_resident'],
  // DESIGN-17: the web actor's lazy tab-open hook (SW-injected for kind:'web' only).
  // navigate reads it to open/adopt the actor's tab when it owns none; kept for the
  // web resident (which has navigate), stripped from any kind whose toolset lacks it.
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
 * Pull the subagent's "result" — the final assistant text — out of a
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
 * Build a subagent orchestrator bound to its IO dependencies. The SW
 * calls this once at boot and injects the bound `spawnSubagent` into the
 * tool context (so the `spawn_subagent` tool reaches it) and exposes it
 * on the `subagent/spawn` route (so the Notebook reaches it).
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
 */
export const makeSpawnSubagent = (deps) => {
  const {
    sessions, runUserTurn, callModel, getSecret, safeFetch,
    appendAudit, buildToolContext, dispatchToolCall,
    renderSystemPrompt, getToolDescriptors,
    now = Date.now,
  } = deps;

  /**
   * @param {Object} req
   * @param {string} req.task                      the spawning prompt
   * @param {string[]} [req.tools]                 explicit tool-name subset
   * @param {string} [req.model]                   override the inherited model
   * @param {number} [req.maxSteps]                step cap (default 20)
   * @param {number} [req.maxOutputTokens]         per-call output cap (default 4096)
   * @param {number} [req.maxDepth]                depth ceiling (default 5)
   * @param {boolean} [req.allowRecursion]         keep spawn_subagent in the subset
   * @param {string} req.parentSessionId           who is spawning this
   * @param {number} [req.parentDepth]             spawner's depth (child = +1)
   * @param {(ev: object) => void} [req.onEvent]   live forwarder for the side panel
   * @param {string} [req.parentToolUseId]         links the parent's card → child session
   * @param {string} [req.systemPromptOverride]    a full system prompt used VERBATIM
   *   (browser-runner). Bypasses the base template + <subagent_task> block; the
   *   goal still arrives as the first user message.
   * @param {number} [req.tabId]                   pin the child's DOM tools (and the
   *   origin/denylist gate) to ONE specific tab. Used by do/get/check.
   * @param {string} [req.taskContext]              bulky context appended to the
   *   child's first USER MESSAGE only (e.g. a pre-captured page snapshot).
   *   Deliberately kept OUT of session.task, the side-panel card label, the
   *   session-title derivation, and the audit slice — those stay the short
   *   human-legible task. Page-derived text must never leak into the audit log.
   * @param {boolean} [req.persistDeltas=true]      set false for ephemeral
   *   children (browser-runners): skips the per-streamed-delta full-record
   *   IDB rewrite. Finalization writes still happen — the result extraction
   *   below reads the COMPLETED session, which is the only persistence an
   *   ephemeral child needs (a mid-run SW death orphans the await anyway).
   * @returns {Promise<{ result: string, sessionId: string | null, toolCalls: number, durationMs: number, depth: number, usage?: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, exceeded?: true, refused?: true }>}
   */
  const spawnSubagent = async (req) => {
    const {
      task,
      tools,
      model,
      maxSteps = DEFAULT_MAX_STEPS,
      maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
      maxDepth = DEFAULT_MAX_DEPTH,
      allowRecursion = false,
      parentSessionId,
      parentDepth = 0,
      onEvent,
      parentToolUseId,
      // Browser-runner extensions (do/get/check). systemPromptOverride replaces
      // the base+<subagent_task> prompt with the runner's own; tabId pins the
      // child's DOM tools (and the origin/denylist gate) to ONE specific tab.
      systemPromptOverride,
      tabId,
      taskContext,
      persistDeltas = true,
    } = req;

    if (typeof task !== 'string' || task.trim().length === 0) {
      return { result: 'subagent refused: empty task', sessionId: null, toolCalls: 0, durationMs: 0, depth: parentDepth + 1, refused: true };
    }

    const depth = parentDepth + 1;

    // ---- Guardrail 1: maxDepth -------------------------------------------
    // Refuse BEFORE creating a session — a refused spawn leaves no trace
    // in the store, only an audit entry. This is what stops infinite
    // self-spawning regardless of allowRecursion.
    if (depth > maxDepth) {
      appendAudit({
        type: 'subagent_refused',
        details: { reason: 'max_depth', depth, maxDepth, parentSessionId },
      }).catch(() => {});
      return {
        result: `subagent refused: max depth ${maxDepth} exceeded (would be depth ${depth})`,
        sessionId: null,
        toolCalls: 0,
        durationMs: 0,
        depth,
        exceeded: true,
        refused: true,
      };
    }

    // ---- Inherit permissions + provider from the parent -------------------
    // Guardrail 3: the subagent runs under the parent's Plan/Act
    // permission through the same six gates. It never escalates.
    // Provider/model inherit too (model overridable) so the subagent
    // uses the same key + endpoint.
    const parent = await sessions.get(parentSessionId);
    const provider = parent?.provider ?? 'anthropic';

    // why: read the parent's confirm setting AT THE EDGE —
    // confirmActionsFromRecord pulls the `confirmActions` boolean off the
    // parent record so the CHILD record inherits it; undefined when the
    // parent has no explicit choice.
    const parentConfirmActions = confirmActionsFromRecord(parent);

    const child = await sessions.create({
      kind: 'subagent',
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
    });

    // why: tag EVERY audit entry this subagent produces with its
    // parentage + depth so the trail is reconstructable from any level
    // (guardrail 4). Both the loop's own audits and the dispatcher's
    // per-tool audits flow through this wrapped fn.
    /** @param {{ type: string, sessionId?: string, details?: object }} entry */
    const taggedAudit = (entry) => appendAudit({
      ...entry,
      details: { ...(entry.details ?? {}), parentSessionId, subagentSessionId: child.sessionId, depth },
    });

    taggedAudit({ type: 'subagent_spawned', details: { task: task.slice(0, 200), maxSteps, maxDepth } }).catch(() => {});

    // ---- Guardrail 2: tool narrowing -------------------------------------
    // The parent session's tool manifest caps the child's set whatever the
    // caller asked for — intersection, never escalation (fail-closed: a
    // manifest naming none of the requested tools yields a tool-less child).
    const parentAllow = resolveManifestAllow(parent?.toolManifest);
    const subset = narrowTools(getToolDescriptors(), { tools, allowRecursion, allow: parentAllow });
    const allowedNames = new Set(subset.map((t) => t.name));
    const subsetDescriptors = subset.map((t) => ({
      name: t.name, description: t.description, schema: t.schema,
    }));

    // Only stand up a dispatcher when the subagent actually has tools.
    // A tools:[] subagent (the common parallel-fan-out case) is pure
    // reasoning and never touches the dispatcher/context plumbing.
    /** @type {((call: import('/shared/tool-types.js').ToolCall) => Promise<import('/shared/tool-types.js').ToolResult>) | undefined} */
    let toolDispatch;
    if (subsetDescriptors.length > 0) {
      const baseCtx = await buildToolContext({ sessionId: child.sessionId, activeTabId: tabId });
      // why restrictCtxCapabilities: capability-by-need. buildToolContext returns
      // the full capability surface (secrets/egress/spawn closures); we remove the
      // ones no granted tool needs so a narrowed child — above all the do/get/check
      // browser-runner, which reads untrusted pages — has no closure path to them
      // even if a granted tool were confused into reaching for one.
      const childCtx = restrictCtxCapabilities({ ...baseCtx, audit: taggedAudit }, allowedNames);
      toolDispatch = (call) => {
        // Defense in depth: even if the model hallucinates a tool name
        // outside its granted subset, the dispatch refuses it. The
        // descriptor narrowing is what the model SEES; this is what it
        // can DO.
        if (!allowedNames.has(call.name)) {
          return Promise.resolve({
            ok: false,
            error: `tool_not_available_to_subagent: ${call.name}`,
            meta: { toolName: call.name, primitive: 'unknown', gates: [], durationMs: 0 },
          });
        }
        // why: dispatchToolCall's union return (a loose { ok, content?, error? }
        // for test mocks) is the dispatcher's real ToolResult at runtime.
        return /** @type {Promise<import('/shared/tool-types.js').ToolResult>} */ (
          dispatchToolCall(call, childCtx));
      };
    }

    // why: a browser-runner (do/get/check) supplies its OWN system prompt — the
    // base template + <subagent_task> block doesn't apply. When
    // systemPromptOverride is set, use it verbatim (the runner's goal still
    // arrives as the first user message, userText below). Otherwise: the normal
    // subagent prompt.
    //
    // why no customSystemPrompt here: the parent session's /system
    // instructions are deliberately NOT inherited — a subagent gets its
    // own task framing (taskOverride) and nothing else. The instructions
    // are user preferences for the parent CONVERSATION; leaking them
    // would distort the child's one-shot task and silently widen the
    // blast radius of a session-scoped instruction. Inheritance is
    // "absent", by design.
    const getSystemPrompt = (typeof systemPromptOverride === 'string' && systemPromptOverride.trim().length > 0)
      ? () => Promise.resolve(systemPromptOverride)
      : () => renderSystemPrompt({ taskOverride: task });

    // Guardrail 5 (output cap): inject maxTokens into every model call.
    /** @param {object} modelArgs */
    const cappedCallModel = (modelArgs) => callModel({ ...modelArgs, maxTokens: maxOutputTokens });

    // Announce the child up-front so the side panel can map the parent's
    // tool card → this session id and render live, before any loop event.
    onEvent?.({ type: 'subagent-start', parentToolUseId, parentSessionId, sessionId: child.sessionId, depth, task });

    let toolCalls = 0;
    let lastStopReason;
    // why: the child's model usage is yielded as 'usage' events but is NOT
    // folded into the parent/main turn tally (the main SW only accumulates its
    // OWN session's usage). That means runner spend is naturally SEPARATE from
    // main-agent spend — exactly what do/get/check needs (the main context stays
    // clean). We sum it here so the runner's token cost is at least VISIBLE to
    // the caller (eval telemetry / success criterion 5), without polluting main.
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const start = now();
    try {
      for await (const ev of runUserTurn({
        sessionId: child.sessionId,
        // why: taskContext (e.g. a pre-captured snapshot) rides ONLY here —
        // the model sees it, but session.task / cards / audit keep the
        // short task string.
        userText: (typeof taskContext === 'string' && taskContext.length > 0)
          ? `${task}\n\n${taskContext}`
          : task,
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
    } finally {
      onEvent?.({ type: 'subagent-stop', parentToolUseId, sessionId: child.sessionId, depth });
    }

    const durationMs = now() - start;
    const final = await sessions.get(child.sessionId);
    const result = finalAssistantText(final);
    // Guardrail 5 (step cap): a max_steps stop means the subagent ran out
    // of room before finishing. Surface it so the caller (and the model)
    // knows the result may be partial.
    const exceeded = lastStopReason === 'max_steps';

    taggedAudit({
      type: 'subagent_completed',
      details: { toolCalls, durationMs, exceeded, resultChars: result.length },
    }).catch(() => {});

    return {
      result,
      sessionId: child.sessionId,
      toolCalls,
      durationMs,
      depth,
      usage,
      ...(exceeded ? { exceeded: true } : {}),
    };
  };

  return spawnSubagent;
};
