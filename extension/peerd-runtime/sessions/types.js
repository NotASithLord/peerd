// @ts-check
// Session typedefs. No runtime exports.

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * @typedef {'chat' | 'spawned' | 'actor'} SessionKind
 *   'chat'     — a top-level conversation the user drives. Shows in /chats.
 *   'spawned' — a session spawned by another session (the model via
 *                actor_create, or Notebook code via peerd.runtime.runAgent).
 *                Hidden from /chats; discovered through its parent's
 *                transcript. See docs/ACTORS.md.
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
 * Actor parentage (see docs/ACTORS.md). An actor is just a
 * session with a parent — no new shape, four fields. Solo dev: no
 * migration code, so these default at read time (`kind ?? 'chat'`,
 * `depth ?? 0`) for sessions written before spawned landed.
 * @property {SessionKind} kind               'chat' (default) | 'spawned' | 'actor'
 * @property {string} [parentSessionId]       who spawned this; absent for top-level
 * @property {string} [task]                  the spawning prompt (spawned only)
 * @property {string[]} [grantedOperations]   immutable exact host-operation grant minted by
 *   the sealed semantic owner at spawn, narrowed by every ancestor and revalidated on run.
 * @property {number} depth                   0 for top-level; parent.depth + 1 otherwise
 * @property {boolean} [spawnedTrusted]       was the SPAWNING turn trusted (non-inbound)?
 *   The per-hop verdict the trusted-lineage gate (actor/delegation-lineage.js)
 *   walks: stamped server-side at create() by spawn.js, never model-supplied.
 *   Absent on roots (nothing spawned them — treated as trusted) and on records
 *   written before the async-actor refactor (a PARENTED record missing it reads
 *   as untrusted — fail-closed; see the SW's getAncestry).
 *
 * Actor binding (DESIGN-17). A `kind:'actor'` session self-describes
 * which instance it owns: `instanceId` (the WebVM/Notebook/Pod/App id it drives, or
 * — for a `web` actor — the owned tabId AS A STRING) and `actorType` (the
 * kind, used to scope its toolset + prompt). The FORWARD pointer lives on the
 * engine registry record (`actorSessionId`) for the engine kinds, or in
 * the tab→session bindings store (`actor/web-actor.js`) for `web`. These
 * are the REVERSE pointer the actor turn reads. Absent on chat/actor.
 * @property {string} [instanceId]            the instance (engine id), the owned tabId (String), or — for a DESIGN-18 API actor — the owned ORIGIN
 * @property {'webvm' | 'notebook' | 'pod' | 'app' | 'web' | 'dweb'} [actorType]  webvm/notebook/pod/app = engine kinds; web = a browser tab OR (DESIGN-18) an API origin; dweb = the mesh operator (global singleton)
 * @property {'tab' | 'api'} [backing]         DESIGN-18: a `web` actor's backing — 'tab' (default; absent = tab) drives a DOM at a MUTABLE origin; 'api' owns ONE FIXED origin, fetch-only, no tab ever
 * @property {import('../actor/origin-lock.js').ActorOriginState} [originState]  issue 251: a TAB-backed web actor's origin authority — ROAMING (browses, owns nothing) or BOUND (owns one credentialed origin), plus the owned origin and the excursion counters. Durable because it IS the authority: losing it across a service-worker eviction turns a bound actor back into an unbounded one. Absent on every kind with no tab.
 *
 * Cost/usage telemetry (feature 06). Accumulated client-side from
 * provider `usage` events × the local pricing table. Absent on sessions
 * created before the feature; defaulted to an empty tally at read time.
 * @property {import('../cost/accumulator.js').CostTally} [cost]
 *
 * Goal-run plan-of-record (todo/core.js) — written by the todo_* tools
 * during a goal run, rendered live by the side panel's todo card (it rides
 * the ordinary state snapshots), and re-surfaced in every goal continuation
 * prompt. Absent until a run calls todo_init.
 * @property {import('../todo/core.js').TodoItem[]} [todos]
 *
 * Prewalk state (loop/prewalk.js) — present only while a prewalk-armed goal
 * run owns this session. phase 'planning' = frontier model, nudge injected;
 * 'executing' = the first mutating action landed, the session runs on the
 * executor model from the next turn. Cleared (and the planner model
 * restored) when the run ends.
 * @property {import('../loop/prewalk.js').PrewalkState} [prewalk]
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
 * removing the key (sessions/store.js setCustomSystemPrompt). Actors
 * deliberately do NOT inherit it (see actor/spawn.js).
 * @property {string} [customSystemPrompt]
 *
 * Manifest-defined App role. Unlike customSystemPrompt this is publisher-
 * provenance package metadata, not user-authored /system text. The digest is
 * also part of the actor's durable owner/execution identity: a changed peerd.json
 * must never reconnect to the prior actor generation.
 * @property {string} [appManifestDigest]
 * @property {string} [appOwnerAuthorityDigest] durable fingerprint of the effective App model surface
 * @property {string} [ownerSemanticPostureDigest] bound actor owner's effective model surface
 * @property {{source:'local'|'unsigned-import'|'dweb', publisher:string, manifestDigest:string, name?:string, instructions?:string}} [appRole]
 * @property {'code'} [actorSurface]            manifest-defined App actors use the code-first surface
 *
 * Per-session tool exposure manifest (the /tools composer command;
 * tools/manifests.js). Absent = every available tool stays exposed —
 * today's behavior. When present, the main turn's descriptor list and
 * the semantic exposure gate both intersect with it (fail-closed), and
 * spawned actors INHERIT it so descendants keep the same model-surface
 * narrowing. Exact host authority is represented and enforced separately.
 * Cleared by removing the key (setToolManifest).
 * @property {import('../tools/manifests.js').ToolManifest} [toolManifest]
 */

export {};
