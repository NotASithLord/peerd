// @ts-check
// Cheap prompt-token estimation — the input to the dynamic trim trigger.
//
// The trim layer (trim.js) decides when to collapse old turns by comparing
// the estimated prompt size to a fraction of the model's context window
// (context-window.js). It needs that estimate BEFORE the model call, so a
// real tokenizer is out (no per-vendor BPE in the no-build extension, and
// running one per step would cost more than it saves). A char/4 heuristic
// is the industry-standard cheap proxy: it tracks actual token counts
// closely enough for a TRIGGER, where the only decision is "are we near
// the budget?" and a conservative trigger fraction absorbs the error.
//
// Everything here is pure — values in, values out. The trim layer injects
// estimateMessagesTokens (and can swap in a better estimator later, e.g.
// folding the last turn's PROVIDER-reported inputTokens) without any
// change to the planning logic.

/** @typedef {import('../../peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * The estimator accepts a SUPERSET of InternalMessage: it also handles the
 * converter's expanded block form (`content` as an array of content blocks)
 * and reads `toolResults`/`toolUses` without narrowing on role, since both
 * arrive from imported/converted histories the strict union doesn't model.
 *
 * @typedef {Object} EstimableBlock
 * @property {string} [text]
 * @property {string} [content]
 * @property {unknown} [input]
 *
 * @typedef {Object} EstimableMessage
 * @property {string | EstimableBlock[]} [content]
 * @property {Array<{ content?: unknown }>} [toolResults]
 * @property {Array<{ input?: unknown, name?: string }>} [toolUses]
 */

// ~4 characters per token is the well-worn rough ratio for English-ish
// text + code + JSON. Deliberately a divisor, not a model: the trigger,
// not the bill, rides on this number.
export const CHARS_PER_TOKEN = 4;

// Fixed per-message overhead — role/turn framing the wire format adds that
// isn't in the content string. A few tokens; keeps short messages from
// estimating as ~0.
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Tokens for an arbitrary string. Empty / non-string → 0.
 * @param {unknown} text
 * @returns {number}
 */
export const estimateTextTokens = (text) =>
  typeof text === 'string' && text.length > 0
    ? Math.ceil(text.length / CHARS_PER_TOKEN)
    : 0;

/**
 * Estimate the tokens one InternalMessage contributes to the prompt. Sums
 * the text content, tool-result bodies (both stored shapes — the loop's
 * `toolResults` array and the converter's expanded content blocks), and
 * tool-use input JSON. Page-derived bulk lives in tool results, so it's
 * counted here — that bulk is exactly what pushes a session toward the
 * budget and what the trim then elides.
 *
 * @param {EstimableMessage | undefined} m
 * @returns {number}
 */
export const estimateMessageTokens = (m) => {
  if (!m) return 0;
  let chars = 0;
  if (typeof m.content === 'string') {
    chars += m.content.length;
  } else if (Array.isArray(m.content)) {
    // Expanded block form (converter output / imported histories).
    for (const block of m.content) {
      if (!block) continue;
      if (typeof block.text === 'string') chars += block.text.length;
      else if (typeof block.content === 'string') chars += block.content.length;
      // why: a tool_use block's serialized `input` is real prompt weight —
      // count it here too (the native `toolUses` branch below already does),
      // or an imported/converted history undercounts and trims/compacts too
      // late.
      if (block.input != null) {
        try { chars += JSON.stringify(block.input).length; }
        catch { /* unserializable input — skip its body */ }
      }
    }
  }
  if (Array.isArray(m.toolResults)) {
    for (const tr of m.toolResults) {
      if (typeof tr?.content === 'string') chars += tr.content.length;
    }
  }
  if (Array.isArray(m.toolUses)) {
    for (const tu of m.toolUses) {
      // Tool-use input is JSON on the wire; its serialized size is what
      // the model pays for.
      if (tu?.input != null) {
        try { chars += JSON.stringify(tu.input).length; }
        catch { /* circular / unserializable input — skip its body */ }
      }
      if (typeof tu?.name === 'string') chars += tu.name.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
};

/**
 * Estimate the total prompt tokens for a message list plus the system
 * prompt. The system block is part of the prompt the window must hold, so
 * it's included; tools are NOT (they're a roughly-constant cached prefix,
 * and the trigger fraction leaves headroom for them).
 *
 * Pure and additive: the list total is the system tokens plus the sum of
 * estimateMessageTokens(m), which lets the trim layer remove the oldest
 * messages one at a time and decrement the running estimate in lockstep.
 *
 * @param {readonly EstimableMessage[]} messages
 * @param {string} [system]
 * @returns {number}
 */
export const estimateMessagesTokens = (messages, system = '') => {
  let total = estimateTextTokens(system);
  if (Array.isArray(messages)) {
    for (const m of messages) total += estimateMessageTokens(m);
  }
  return total;
};
