// @ts-check
// Session typedefs. No runtime exports.

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * @typedef {'chat' | 'subagent' | 'actor'} SessionKind
 *   'chat'     — a top-level conversation the user drives. Shows in /chats.
 *   'subagent' — a session spawned by another session (the model via
 *                spawn_subagent, or Notebook code via peerd.runtime.runAgent).
 *                Hidden from /chats; discovered through its parent's
 *                transcript. See docs/SUBAGENTS.md.
 *   'actor' — a per-instance agent that OWNS one tab-hosted execution
 *                instance (WebVM / Notebook / App): it exclusively holds that
 *                environment's mutating tools and is addressed only by
 *                `message_actor`. Hidden from /chats (reached via its
 *                instance, not the chat list). Lazily minted; bound to the
 *                instance by `actorSessionId` on the engine registry record,
 *                and self-describes via `instanceId` + `actorType` below.
 *                See docs/specs/DESIGN-17-actor-agents.md.
 */

/**
 * @typedef {Object} Session
 * @property {string} sessionId               UUIDv7
 * @property {number} createdAt               ms since epoch
 * @property {string} provider                e.g. 'anthropic'
 * @property {string} model                   provider-specific model id
 * @property {InternalMessage[]} messages
 * @property {number} [archivedAt]            present when archived
 * @property {string} [title]                 V1.x — derived from first message
 *
 * Subagent parentage (see docs/SUBAGENTS.md). A subagent is just a
 * session with a parent — no new shape, four fields. Solo dev: no
 * migration code, so these default at read time (`kind ?? 'chat'`,
 * `depth ?? 0`) for sessions written before subagents landed.
 * @property {SessionKind} kind               'chat' (default) | 'subagent' | 'actor'
 * @property {string} [parentSessionId]       who spawned this; absent for top-level
 * @property {string} [task]                  the spawning prompt (subagents only)
 * @property {number} depth                   0 for top-level; parent.depth + 1 otherwise
 *
 * Actor binding (DESIGN-17). A `kind:'actor'` session self-describes
 * which instance it owns: `instanceId` (the WebVM/Notebook/App id it drives, or
 * — for a `web` actor — the owned tabId AS A STRING) and `actorType` (the
 * kind, used to scope its toolset + prompt). The FORWARD pointer lives on the
 * engine registry record (`actorSessionId`) for the three engine kinds, or in
 * the tab→session bindings store (`subagent/web-actor.js`) for `web`. These
 * are the REVERSE pointer the actor turn reads. Absent on chat/subagent.
 * @property {string} [instanceId]            the instance (engine id), the owned tabId (String), or — for a DESIGN-18 API actor — the owned ORIGIN
 * @property {'webvm' | 'notebook' | 'app' | 'web'} [actorType]  webvm/notebook/app = engine kinds; web = a browser tab OR (DESIGN-18) an API origin
 * @property {'tab' | 'api'} [backing]         DESIGN-18: a `web` actor's backing — 'tab' (default; absent = tab) drives a DOM at a MUTABLE origin; 'api' owns ONE FIXED origin, fetch-only, no tab ever
 *
 * Cost/usage telemetry (feature 06). Accumulated client-side from
 * provider `usage` events × the local pricing table. Absent on sessions
 * created before the feature; defaulted to an empty tally at read time.
 * @property {import('../cost/accumulator.js').CostTally} [cost]
 *
 * Plan/Act permission state, written at create() and flipped
 * mid-session via update() so the choice survives a SW restart
 * (absent-key contract). Records carry only `confirmActions` — read via
 * confirmActionsFromRecord (permissions/policy.js).
 * @property {string} [permissionMode]
 * @property {boolean} [confirmActions]
 *
 * Rolling trim-summary state (loop/rolling-summary.js), persisted by
 * setTrimSummary so an SW restart doesn't lose what an earlier trim
 * already folded. Absent until the first trim fires.
 * @property {import('../loop/rolling-summary.js').TrimSummaryState} [trimSummary]
 *
 * Per-session user-authored system-prompt augmentation (the /system
 * composer command). Rendered as an appended <session_instructions>
 * block — it AUGMENTS the base prompt, never replaces it (the base
 * carries the security/defense text). Absent = none set; cleared by
 * removing the key (sessions/store.js setCustomSystemPrompt). Subagents
 * deliberately do NOT inherit it (see subagent/spawn.js).
 * @property {string} [customSystemPrompt]
 *
 * Per-session tool exposure manifest (the /tools composer command;
 * tools/manifests.js). Absent = every registered tool stays exposed —
 * today's behavior. When present, the main turn's descriptor list and
 * the exposure gate both intersect with it (fail-closed), and subagents
 * INHERIT it (the inverse of customSystemPrompt — a manifest is an
 * authority bound, not a preference, so a child must never escalate
 * past it). Cleared by removing the key (setToolManifest).
 * @property {import('../tools/manifests.js').ToolManifest} [toolManifest]
 */

export {};
