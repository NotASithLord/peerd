// @ts-check
// JSDoc type declarations for tools and tool contexts.
//
// This file has no runtime exports — it exists purely to centralize the
// JSDoc @typedef definitions that the rest of the codebase references
// via `@param {import('/shared/tool-types.js').Tool} tool`.
//
// New tool fields go here; the dispatcher and tool implementations both
// reference these types, so adding a field forces both ends to be
// considered together.

/**
 * The architectural primitive each tool exercises. Surfaces in the
 * tool-call UI as a default "lineage" header so users see what kind of
 * thing the agent is doing. Lowercase, one token per peerd convention.
 *
 *   inspect   — sovereignty introspection (storage, audit, denylist, ...)
 *   tab       — browser tabs + DOM
 *   web       — web fetch / search wrappers
 *   time      — temporal grounding (clock)
 *   webvm     — CheerpX Linux instance
 *   notebook  — Notebook (Web Worker + OPFS)
 *   app       — stored-HTML App in a sandboxed iframe
 *   subagent  — orchestration: a child session running the agent loop
 *   memory    — file-based AGENTS.md memory (read/confirm-gated write)
 *
 * @typedef {'inspect' | 'tab' | 'web' | 'time' | 'webvm' | 'notebook' | 'app' | 'subagent' | 'memory'} Primitive
 */

/**
 * @typedef {'read' | 'write' | 'mutate_external' | 'destructive'} SideEffect
 *
 *   read             pure read of agent-accessible state; no confirmation
 *   write            modifies state inside already-authorized scope
 *   mutate_external  the dangerous bucket: form submits, downloads,
 *                    credentials, cross-origin requests (confirmed)
 *   destructive      irreversible deletes (vm_delete, app_delete, …). The
 *                    Plan/Act policy (Feature 03) classes this as EXTERNAL
 *                    — confirmed in Act whenever confirmActions is on.
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} args
 */

/**
 * @typedef {Object} GateResult
 * @property {string} name             gate name (persona, exposure, origin, ...)
 * @property {boolean} allowed         pass/block
 * @property {string} reason           human-readable explanation rendered in UI
 */

/**
 * @typedef {Object} HookOutcome
 * @property {string} id               hook id (e.g. 'egress-allowlist')
 * @property {'allow' | 'block' | 'modify' | 'observe'} action
 * @property {string} reason           human-readable; rendered in lineage + audit
 */

/**
 * @typedef {Object} ToolMeta
 * @property {string} toolName
 * @property {Primitive | 'unknown'} primitive
 * @property {SideEffect} [sideEffect]  the tool's side-effect class (lineage compaction reads it)
 * @property {string[]} [origins]      origins the call touched (spine field; populated on executed calls)
 * @property {GateResult[]} gates      ordered, one per gate the dispatcher ran
 * @property {HookOutcome[]} [hooks]   ordered, one per lifecycle hook that ran (pre + post)
 * @property {number} durationMs       wall-clock duration of execute(); 0 on gate block
 */

/**
 * @typedef {Object} ToolResultOk
 * @property {true} ok
 * @property {any} content
 * @property {Array<{ mediaType: string, data: string }>} [images]  optional vision
 *   blocks (base64, no data: prefix) — e.g. a page screenshot from `view`. The
 *   agent loop delivers them to the model ONCE (the step after capture) and never
 *   persists the bytes (send-once-then-strip, like attachments). content carries
 *   the bytes-free metadata.
 * @property {ToolMeta} [meta]         populated by the dispatcher, not by tools
 */

/**
 * @typedef {Object} ToolResultErr
 * @property {false} ok
 * @property {string} error
 * @property {ToolMeta} [meta]
 */

/** @typedef {ToolResultOk | ToolResultErr} ToolResult */

/**
 * @typedef {Object} ActiveTab
 * @property {number} id
 * @property {string} url
 * @property {string} origin
 */

/**
 * @typedef {Object} SessionLite
 * @property {string} sessionId
 */

/**
 * @typedef {Object} ProviderLite
 * @property {string} name             e.g. 'anthropic'
 * @property {string} model            e.g. 'claude-sonnet-4-6'
 * @property {boolean} hasKey          true if a key is stored in the vault
 */

/**
 * @typedef {Object} VaultLite
 * @property {boolean} isLocked        snapshot at ctx-build time
 */

/**
 * @typedef {Object} ToolContext
 * @property {SessionLite} session
 * @property {ActiveTab} [activeTab]
 * @property {Object} [dom]            legacy slot — buildToolContext injects
 *                                     `dom: undefined` today (DOM work goes
 *                                     through scripting/debuggerPool/domRefs)
 * @property {Object} vm               VM run() function
 * @property {Object} tabs             chrome.tabs API surface
 * @property {Object} [scripting]      chrome.scripting API surface (executeScript) —
 *                                     web tools + DOM-walk fallbacks read it
 * @property {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} [webFetch]
 *                                     denylist-gated fetch for the web tools
 *                                     (fetch_url)
 * @property {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} [safeFetch]
 *                                     provider-allowlist fetch (locked down;
 *                                     for tools that legitimately hit a provider)
 * @property {Record<string, any>} [settings]   settings snapshot at ctx-build time
 *                                     (web tools no longer read any — tab focus is
 *                                     policy, not a setting; see DECISIONS #20)
 * @property {Object} [skills]         skill registry injected by the SW
 *                                     (createSkillRegistry — load_skill reads
 *                                     ctx.skills.loadBody on invocation)
 * @property {(name: string) => Promise<string | null>} getSecret
 * @property {(entry: { type: string, details?: Record<string, any> }) => Promise<unknown>} audit
 * @property {(prompt: ConfirmPrompt) => Promise<ConfirmAnswer>} confirm
 * @property {Object} kv               peerd-egress kv namespace
 * @property {Object} idb              peerd-egress idb namespace
 * @property {readonly string[]} denylist   loaded denylist patterns (egress + denylist gate input)
 * @property {ProviderLite} provider
 * @property {VaultLite} vault
 */

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} description
 * @property {Primitive} primitive    the RESOURCE/domain this tool exercises
 *   (tab / web / webvm / notebook / app / memory / inspect / subagent). Answers
 *   "what does it touch?".
 * @property {'inline'|'runner'|'subagent'} [dispatch]   the EXECUTION mechanism —
 *   orthogonal to `primitive`. Absent/'inline' = runs in the dispatcher.
 *   'runner' = carried out by a spawned browser-runner (do/get/check: a tab
 *   resource driven by a runner). Lets the UI show "tab · via runner" without
 *   conflating the mechanism into the primitive. Answers "how is it run?".
 * @property {Record<string, any>} schema           JSON Schema for args
 * @property {SideEffect} sideEffect
 * @property {boolean} [dweb]   true = a dweb network tool (publish/discover/
 *   install). The exposure layer (filterByDwebEnabled) hides these from the agent
 *   unless the dweb is on, so on the store build they never surface.
 * @property {(args: any, ctx: ToolContext) => string[]} origins
 *   Returns the set of origins this call would touch. Used by the denylist
 *   check (§4.2).
 * @property {(args: any, ctx: ToolContext) => Promise<ToolResult>} execute
 */

/**
 * @typedef {Object} ConfirmPrompt
 * @property {string} id              UUIDv7
 * @property {string} toolName
 * @property {string} description     human-readable: "Submit the form on chase.com?"
 * @property {string[]} origins       origins involved
 * @property {SideEffect} sideEffect
 * @property {string} [actionClass]   Plan/Act action class driving the prompt
 *                                    (workspace_write | shell | external)
 * @property {string | null} [sessionId]   chat the prompt belongs to — lets the
 *                                    coordinator decline a session's pending
 *                                    confirms when its turn is aborted
 */

/**
 * @typedef {'yes_once' | 'yes_session' | 'no'} ConfirmAnswer
 */

// Empty export keeps this a valid ES module.
export {};
