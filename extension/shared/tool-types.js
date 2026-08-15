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
 *   pod      : Pod (sealed shell/WASI jobs + OPFS)
 *   app       — stored-HTML App in a sandboxed iframe
 *   actor  — orchestration: a child session running the agent loop
 *   engine   : cross-kind sandbox ops (sandbox_create spans webvm/notebook/pod/app;
 *               its result stamps the concrete `kind` for the handle harvest)
 *   memory    — file-based AGENTS.md memory (read/confirm-gated write)
 *
 * @typedef {'inspect' | 'tab' | 'web' | 'time' | 'webvm' | 'notebook' | 'pod' | 'app' | 'engine' | 'spawned' | 'memory'} Primitive
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
 * @property {boolean} [paged]         this result is a deliberately-sized offset/
 *   limit PAGE the model asked for — set by any offset/limit paging tool. The
 *   loop redacts a paged result at the larger paged ceiling (loop/redact.js
 *   PAGED_MAX_CHARS) rather than the 8k backstop, so a requested slice is not
 *   re-cut. Set by the paging tool; the dispatcher preserves it (like evalError)
 *   since it spreads the tool result.
 * @property {boolean} [evalError]     the tool ran fine but the CODE it evaluated
 *   errored (a notebook eval's in-band [ERROR]). ok stays true — the error text
 *   is the legitimate result — but the one-shot latch reads this to give the
 *   actor its promised recovery turn instead of short-circuiting a crash back
 *   as the raw reply (the oneShot contract: "an errored round falls through").
 * @property {boolean} [endTurn]       return this result to the caller and end
 *   the current model turn without another inference or tool dispatch
 * @property {any} [structured]        optional host-only structured twin of a
 *   presentation-oriented `content` string. The model loop ignores it; trusted
 *   relays may consume it without parsing human-formatted text.
 * @property {string} [actorDeliveryId] internal durable mailbox correlation.
 *   Preserved into the persisted tool-result block and removed from the mailbox
 *   only after that message commits. Provider formatters ignore this field.
 * @property {string[]} [actorDeliveryIds] internal durable mailbox correlations
 *   for a tool that consumed multiple actor replies, such as script.
 * @property {string} [actorCorrelationId] host-only actor correlation that does
 *   not acknowledge the durable mailbox; provider formatters ignore it.
 * @property {boolean} [actorTerminal] host-stamped actor completion state.
 * @property {boolean} [actorOutcomeKnown] host-stamped outcome certainty.
 * @property {boolean} [actorPerformed] host-stamped execution state.
 * @property {boolean} [actorAborted] host-stamped user cancellation state.
 */

/**
 * @typedef {Object} ToolResultErr
 * @property {false} ok
 * @property {string} error
 * @property {boolean} [endTurn]
 * @property {any} [content]  optional human-readable explanation authored
 *   alongside the machine `error` code (e.g. "User declined the outbound
 *   write."); the loop surfaces it on the failure path — see agent-loop.js.
 * @property {'transport-lost' | 'host-lost' | 'pre-effect-failure' | 'effect-completed'} [outcomeKind]
 *   typed failure outcome for the lifecycle recovery contract
 *   (peerd-runtime/lifecycle/failure-taxonomy.js): a tool that KNOWS how it
 *   failed stamps this so the recovery decision is deterministic instead of
 *   string-matched. Optional — unstamped failures take the heuristic path.
 * @property {any} [structured] optional host-side policy or recovery details;
 *   a tool that needs model-visible structure must serialize a safe compact
 *   form into `content` as well
 * @property {ToolMeta} [meta]
 * @property {string} [actorDeliveryId] internal durable mailbox correlation;
 *   never serialized to a provider.
 * @property {string[]} [actorDeliveryIds] internal durable mailbox correlations;
 *   never serialized to a provider.
 * @property {string} [actorCorrelationId] host-only non-ack actor correlation.
 * @property {boolean} [actorTerminal] host-stamped actor completion state.
 * @property {boolean} [actorOutcomeKnown] host-stamped outcome certainty.
 * @property {boolean} [actorPerformed] host-stamped execution state.
 * @property {boolean} [actorAborted] host-stamped user cancellation state.
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
 * @property {string} [kind]           session kind ('chat'|'spawned'|'actor'|…); SW-injected
 * @property {number} [depth]          delegation depth (parent + 1); SW-injected
 * @property {number} [messageCount]   session message count at ctx-build — the load_skill dedup anchor; SW-injected
 * @property {number} [trimCovered]    leading messages the rolling summary folded out of the sent slice — the load_skill dedup watermark; SW-injected
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
 * @property {(origin: string) => boolean} [canUseSiteClientOrigin]
 *                                     synchronous early custody check
 * @property {(origin: string) => Promise<boolean>} [authorizeSiteClientOrigin]
 *                                     final live-tab custody check; web actors
 *                                     only, fail-closed when absent
 * @property {(origin: string, signal?: AbortSignal) => Promise<boolean>} [authorizeSignInOrigin]
 *                                     post-consent relying-site promotion for
 *                                     login; tab-backed web actors only
 * @property {(idpOrigin: string, signal?: AbortSignal) => Promise<boolean>} [authorizeSignInExcursion]
 *                                     arms one exact verified IdP after consent
 * @property {(idpOrigin: string, signal?: AbortSignal) => Promise<boolean>} [revokeSignInExcursion]
 *                                     removes a still-unused grant after failure
 * @property {() => Promise<import('../peerd-runtime/actor/landing-rule.js').LandingVerdict | null>} [revalidateActorLanding]
 *                                     execute-time live origin/auth check for
 *                                     every tab-backed web-actor tool
 * @property {boolean} [idpTransitOnly] stale-session defense that causes every
 *                                     API actor tool to fail closed
 * @property {Record<string, any>} [settings]   settings snapshot at ctx-build time
 *                                     (web tools no longer read any — tab focus is
 *                                     policy, not a setting; see DECISIONS #20)
 * @property {Object} [skills]         skill registry injected by the SW
 *                                     (createSkillRegistry — load_skill reads
 *                                     ctx.skills.loadBody on invocation)
 * @property {(name: string) => Promise<string | null>} getSecret
 * @property {(entry: { type: string, details?: Record<string, any> }) => Promise<unknown>} audit
 * @property {(prompt: ConfirmPrompt, signal?: AbortSignal) => Promise<ConfirmAnswer>} confirm
 * @property {string | null} [lifecycleOwnerSessionId] root chat that owns
 *                                     lifecycle intent for this execution
 * @property {Object} kv               peerd-egress kv namespace
 * @property {Object} idb              peerd-egress idb namespace
 * @property {readonly string[]} denylist   loaded denylist patterns (egress + denylist gate input)
 * @property {ProviderLite} provider
 * @property {VaultLite} vault
 * @property {AbortSignal} [abortSignal] Stop/cancel signal for this dispatch;
 *                                     relayed code operations must preserve it
 */

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} description
 * @property {Primitive} primitive    the RESOURCE/domain this tool exercises
 *   (tab / web / webvm / notebook / pod / app / memory / inspect / actor). Answers
 *   "what does it touch?".
 * @property {'inline'|'spawned'} [dispatch]   the EXECUTION mechanism —
 *   orthogonal to `primitive`. Absent/'inline' = runs in the dispatcher.
 *   'spawned' = carried out by a spawned child session. Lets the UI show the
 *   mechanism without conflating it into the primitive. Answers "how is it run?".
 * @property {Record<string, any>} schema           JSON Schema for args
 * @property {SideEffect} sideEffect
 * @property {'A'|'B'|'C'|'D'|'E'|'F'} [retryClass] optional explicit lifecycle retry class
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
 * @property {string} [note]          one plain sentence saying WHY this call is
 *   being confirmed, when the reason is something other than the ordinary
 *   Plan/Act policy — e.g. the #242 UGC-zone forced confirm. Rendered verbatim
 *   above the call summary. why a free-form line and not a code: the user is
 *   the audience, and the only thing that makes a confirm worth showing is that
 *   it explains itself.
 * @property {string} [lifecycleTarget] immutable target from an unknown-outcome
 *                                    approval claim; the confirmation UI shows
 *                                    this exact value rather than a mutable live URL
 * @property {boolean} [oneShot]      this approval must be answered directly
 *                                    and cannot read or create a session grant
 * @property {string | null} [sessionId]   exact execution session; lets the
 *                                    coordinator decline a turn's pending
 *                                    confirms when it is aborted
 * @property {string | null} [ownerSessionId] root chat whose user owns the
 *                                    action; scopes display and replay
 * @property {string | null} [dispatchId] exact tool dispatch covered by the
 *                                    answer; null for non-tool confirmations
 */

/**
 * @typedef {'yes_once' | 'yes_session' | 'no'} ConfirmAnswer
 */

// Empty export keeps this a valid ES module.
export {};
