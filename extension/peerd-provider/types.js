// @ts-check
// JSDoc type declarations for provider-internal message shapes.
//
// No runtime exports. The internal shape stays intentionally minimal:
// user text, assistant text, assistant tool_use blocks, and user
// tool_result blocks — the four shapes the V1 agent loop produces.

/**
 * @typedef {Object} ToolUseBlock
 * @property {string} id                         provider-issued id (e.g. 'toolu_X')
 * @property {string} name                       tool name
 * @property {Record<string, any>} input         parsed JSON input
 */

/**
 * @typedef {Object} ToolResultBlock
 * @property {string} tool_use_id                matches a prior ToolUseBlock.id
 * @property {string} content                    serialized tool output (JSON string for V1)
 * @property {boolean} [is_error]                true if the tool failed or was gate-blocked
 * @property {Array<{ mediaType: string, data: string }>} [images]  live vision blocks
 *   (base64) spliced in for ONE model call (send-once). Rendered as image blocks
 *   inside the tool_result content on Anthropic, and as a follow-on user image
 *   message on OpenAI (its tool role takes string content only). Never persisted.
 * @property {import('/shared/tool-types.js').ToolMeta} [meta]   dispatcher meta — UI uses this
 */

/**
 * @typedef {Object} Attachment
 * @property {string} name                       original filename (chip label)
 * @property {string} mediaType                  e.g. 'image/png', 'application/pdf', 'text/plain'
 * @property {'image'|'pdf'|'text'} kind         classified by peerd-runtime/loop/attachments.js
 * @property {number} size                       decoded byte size
 * @property {string} [data]                     base64 payload — present ONLY on the turn the
 *                                               attachment is sent (send-once-then-strip)
 * @property {boolean} [stripped]                true once the payload has been dropped; the
 *                                               persisted shape and every later re-send carry
 *                                               this metadata-only form
 */

/**
 * @typedef {Object} UserMessage
 * @property {'user'} role
 * @property {string} content                    plain text; '' when this is a pure tool-result message
 * @property {ToolResultBlock[]} [toolResults]   present when the message exists only to feed tool results back
 * @property {Attachment[]} [attachments]        user-attached files; image/pdf render as content
 *                                               blocks the turn they're sent (to-anthropic.js)
 * @property {string} id                         UUIDv7
 * @property {number} when                       ms since epoch
 * @property {boolean} [synthetic]               true on machine-synthesised entries (the
 *                                               trim drop-summary, loop/trim.js); consumers
 *                                               that must skip non-human content check it
 *                                               (e.g. memory/auto-memory.js)
 */

/**
 * @typedef {Object} AssistantMessage
 * @property {'assistant'} role
 * @property {string} content                    concatenated stream text
 * @property {ToolUseBlock[]} [toolUses]         tool calls the model made this turn
 * @property {string} id                         UUIDv7
 * @property {number} when                       ms since epoch
 * @property {string} [model]                    e.g. 'claude-sonnet-4-6'
 * @property {string} [provider]                 e.g. 'anthropic'
 * @property {boolean} [streaming]               true while the stream is in flight
 * @property {string} [stopReason]               'end_turn' | 'max_tokens' | 'tool_use' | ...
 * @property {string} [error]                    populated when the stream failed
 * @property {string} [thinking]                 rendered extended-thinking text
 *                                               (collapsible "Reasoning" section)
 * @property {ThinkingBlock[]} [thinkingBlocks]  signed/redacted blocks replayed
 *                                               on the next tool-use turn
 */

/**
 * @typedef {Object} ThinkingBlock
 * @property {'thinking'|'redacted_thinking'} type
 * @property {string} [thinking]     plaintext reasoning (type 'thinking')
 * @property {string} [signature]    opaque signature; MUST be replayed on the
 *                                   next tool-use turn (to-anthropic.js)
 * @property {string} [data]         opaque ciphertext (type 'redacted_thinking')
 *   The signed/redacted extended-thinking blocks the agent loop captures off the
 *   reasoning-stop event and persists so the next tool-use turn replays them
 *   intact — Anthropic 400s a tool_use turn that drops them. See agent-loop.js.
 */

/**
 * @typedef {UserMessage | AssistantMessage} InternalMessage
 */

export {};
