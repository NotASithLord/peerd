// @ts-check
// Sliding-window history trim — the backstop for very long sessions.
//
// Caching (system + tools + last message) and tool-result redaction
// handle the volume problem for most sessions. They don't help once
// the conversation itself is genuinely long enough that the cached
// prefix outgrows the API's context window or the user's rate-limit
// budget, even at 10% cached cost. That's where this comes in.
//
// Strategy
// --------
// Keep the most recent KEEP_RECENT turns intact. Everything older
// gets replaced by a single synthesized user message that summarises
// what happened. The summary is ROLLING (rolling-summary.js): when the
// trim fires again, the new summary INCORPORATES the prior summary
// state — counts and tool stats fold mechanically, and an optional
// cheap model call (summary-enrichment.js) adds structured
// facts/decisions/open-threads for future turns. The state persists on
// the session record (`session.trimSummary`) so an SW restart doesn't
// lose what was already summarised.
//
// Two triggers, but NOT co-equal — the accurate one wins by construction:
//   • token budget — DYNAMIC and AUTHORITATIVE whenever the caller passes the
//     active model's contextWindow: trim once the estimated prompt exceeds
//     TRIGGER_FRACTION of it, cutting down to TARGET_FRACTION. This is the
//     trigger that actually matters — a single page snapshot can be 100× a
//     short turn, so message count is a poor proxy for "near the window."
//     Scaling to the model's own window means a 1M Anthropic model trims far
//     later than a 128K GPT-4o (estimate.js + peerd-provider/context-window.js).
//   • message count — the backstop, active ONLY when the window is unknown.
//     why demoted: trimming reshapes what's SENT, not the at-rest history
//     (planTrim runs on a slice; session.messages stays whole). So with a
//     known window the count cap bounds nothing the token budget doesn't
//     bound more accurately — it would only PREMATURELY trim a long-but-light
//     session (60 short turns on a 1M model ≈ 20K tokens, nowhere near the
//     750K trigger), throwing away context the window had ample room for.
//     With a known window it's off; with an unknown window it's the sole,
//     cheap guard at SOFT_CAP. (To cap retained context BELOW the window for
//     cost, lower TRIGGER_FRACTION — that's the scaled, model-accurate knob.)
// The deep cut on trigger (down to TARGET_FRACTION, well below the
// trigger) is deliberate hysteresis: each trim BUSTS the prompt cache, so
// firing rarely and cutting deep beats nibbling every turn.
//
// This is a LOSSLESS-RECENT, LOSSY-OLDER trade: the agent retains
// full context for the last few exchanges and a thumbnail of
// everything before. The full unsummarized history still lives in
// session storage — only what gets SENT to the model is trimmed.
// `/undo` and the session-view in the side panel see the real thing.

import {
  emptySummaryState, normalizeSummaryState, foldDropped, renderSummaryText,
} from './rolling-summary.js';
import { estimateMessagesTokens } from './estimate.js';

const KEEP_RECENT_DEFAULT = 20;
const SOFT_CAP_DEFAULT = 60;

// Token-trigger fractions of the model's context window. Trim FIRES at
// TRIGGER and cuts down to TARGET — the gap is the hysteresis that keeps a
// trim from re-firing (and re-busting the cache) every following turn.
// TRIGGER < 1 leaves headroom for the completion, the tools block, and the
// estimator's error.
const TRIGGER_FRACTION_DEFAULT = 0.75;
const TARGET_FRACTION_DEFAULT = 0.55;

// Hard floor on the kept tail. The token path can want to drop deep into
// the recent window when a few messages are enormous; this guarantees the
// agent always keeps at least the last few exchanges verbatim no matter
// how big they are. (The message-count path's keepRecent is already well
// above this, so this clamp never touches legacy behavior.)
const MIN_KEEP_RECENT = 4;

/** @typedef {import('../../peerd-provider/types.js').InternalMessage} InternalMessage */
/** @typedef {import('./rolling-summary.js').TrimSummaryState} TrimSummaryState */
/** @typedef {import('../../peerd-provider/types.js').UserMessage} UserMessage */

/**
 * The trim accepts BOTH tool-result shapes (see carriesToolResults):
 * the loop's `{ content: '', toolResults: [...] }` and the converter's
 * expanded block form, where the tool_result blocks live in a content
 * ARRAY instead. The second member below is that block form.
 *
 * @typedef {InternalMessage
 *   | (Omit<UserMessage, 'content'> & { content: Array<{ type: string, tool_use_id: string, content: string }> })
 * } TrimInputMessage
 */

/**
 * Output entries are the input messages plus, possibly, the synthesised
 * summary — flagged `synthetic: true` so consumers can tell it apart
 * from real user content.
 *
 * @typedef {TrimInputMessage & { synthetic?: boolean }} TrimmedMessage
 */

/**
 * Does this message carry tool_result content? The agent loop persists
 * results as `{ role: 'user', content: '', toolResults: [...] }`
 * (agent-loop.js resultMessage); the converter later expands them into
 * `{type:'tool_result'}` content blocks. We check both shapes so a
 * message that already arrived in block form snaps the same way.
 *
 * @param {TrimInputMessage | undefined} m
 * @returns {boolean}
 */
const carriesToolResults = (m) =>
  m?.role === 'user' && (
    (Array.isArray(m.toolResults) && m.toolResults.length > 0)
    || (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  );

/**
 * Plan the trim for one model call. If `messages.length <= softCap`,
 * the plan is a no-op (shallow copy, didTrim false). Otherwise the
 * oldest (length - keepRecent) entries collapse into a single
 * synthesised user message rendered from the ROLLING summary state:
 * the prior state (if any) plus the messages dropped beyond its
 * watermark, folded mechanically.
 *
 * The synthesised entry is shaped like a normal user message — plain
 * string content — so it flows through the existing format converter
 * without special-casing. It carries a marker tag in the prose so
 * future readers know it's a trim summary, not original content.
 *
 * The caller persists `summaryState` (the agent loop writes it to the
 * session record) and may hand `newlyDropped` to the enrichment seam.
 *
 * @param {readonly TrimInputMessage[]} messages
 * @param {Object} [opts]
 * @param {number} [opts.keepRecent]  number of newest messages to keep verbatim
 * @param {number} [opts.softCap]     message-count trigger (window-unknown ONLY): trim when messages.length > softCap; ignored when contextWindow > 0
 * @param {TrimSummaryState | null} [opts.summaryState]  prior rolling state
 * @param {number} [opts.contextWindow]
 *   The ACTIVE model's context window in tokens. When > 0, the dynamic
 *   token trigger is enabled: trim when the estimated prompt exceeds
 *   triggerFraction of it. Omitted / 0 (model window unknown) → only the
 *   message-count trigger applies, i.e. exactly the original behavior.
 * @param {string} [opts.system]      system prompt, counted toward the token estimate
 * @param {number} [opts.triggerFraction]  fraction of contextWindow that fires the trim (default 0.75)
 * @param {number} [opts.targetFraction]   fraction of contextWindow to cut down to (default 0.55)
 * @param {(messages: readonly TrimInputMessage[], system?: string) => number} [opts.estimateTokens]
 *   Injected prompt-token estimator (default estimate.js char/4 heuristic).
 * @param {(summaryText: string) => string} [opts.wrapSummary]
 *   DESIGN-17: post-process the rendered summary text before it becomes the
 *   synthesised message content. The WEB resident injects fenceWebResidentSummary
 *   here to SELF-FENCE its own (100%-untrusted-provenance) rolling summary. Default
 *   identity — every other caller renders the summary verbatim, unchanged.
 * @returns {{
 *   messages: TrimmedMessage[],
 *   didTrim: boolean,
 *   summaryState: TrimSummaryState | null,
 *   newlyDropped: TrimInputMessage[],
 * }}
 */
export const planTrim = (messages, opts = {}) => {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_DEFAULT;
  const softCap = opts.softCap ?? SOFT_CAP_DEFAULT;
  const contextWindow = opts.contextWindow ?? 0;
  const triggerFraction = opts.triggerFraction ?? TRIGGER_FRACTION_DEFAULT;
  const targetFraction = opts.targetFraction ?? TARGET_FRACTION_DEFAULT;
  const estimate = opts.estimateTokens ?? estimateMessagesTokens;
  const system = opts.system ?? '';
  const wrapSummary = typeof opts.wrapSummary === 'function' ? opts.wrapSummary : (/** @type {string} */ t) => t;
  const noop = () => ({
    messages: Array.isArray(messages) ? [...messages] : [],
    didTrim: false,
    summaryState: null,
    newlyDropped: [],
  });
  if (!Array.isArray(messages)) return noop();

  // Message-count trigger — the sole trigger pre-feature and when the window
  // is unknown, but DISABLED when the window is known (tokens are then the
  // accurate, authoritative budget; see the header). dropCount keeps the
  // legacy formula so the pinned message-count tests stay byte-identical.
  const countTriggerActive = contextWindow <= 0;
  const overCap = countTriggerActive && messages.length > softCap;
  let dropCount = overCap ? messages.length - keepRecent : 0;

  // Token trigger (only when the caller knows the model's window). When
  // the estimated prompt crosses triggerFraction, drop the oldest messages
  // until the kept estimate falls under targetFraction — possibly DEEPER
  // than the message-count formula when a few turns are enormous. Whichever
  // trigger wants to drop more wins.
  if (contextWindow > 0) {
    const total = estimate(messages, system);
    if (total > triggerFraction * contextWindow) {
      const target = targetFraction * contextWindow;
      let kept = total;
      let tokenDrop = 0;
      const maxDrop = messages.length - MIN_KEEP_RECENT;
      // why estimate([m], ''): decrement with the SAME (injected) estimator
      // that produced `total`, treated as additive — otherwise a custom
      // estimator (the docstring invites one) measures `total` on one scale
      // and the per-message decrement on another, mis-cutting the window.
      // For the default char/4 estimator this equals estimateMessageTokens(m).
      while (tokenDrop < maxDrop && kept > target) {
        kept -= estimate([messages[tokenDrop]], '');
        tokenDrop++;
      }
      if (tokenDrop > dropCount) dropCount = tokenDrop;
    }
  }

  if (dropCount <= 0) return noop();
  // why: the cut must never START the kept window on a tool_result-
  // carrying user message — its matching assistant tool_use would be on
  // the trimmed side and the provider 400s on the orphaned tool_result.
  // Snap the boundary BACKWARD until the window opens on the paired
  // assistant tool_use message (or any plain message): expanding the
  // kept window by a message or two is fine, an invalid history is not.
  // The loop handles multiple consecutive tool rounds (assistant
  // tool_use → user tool_results → assistant tool_use → ...): one step
  // back lands on that round's tool_use, whose results then sit safely
  // INSIDE the window. The trimmed prefix correspondingly ends on a
  // completed round, so no kept tool_use is left unanswered either.
  while (dropCount > 0 && carriesToolResults(messages[dropCount])) {
    dropCount--;
  }
  if (dropCount <= 0) return noop();

  let state = normalizeSummaryState(opts.summaryState);
  if (state.covered > 0) {
    const anchor = messages[state.covered - 1];
    // why reset on drift: the watermark assumes the message list is
    // append-only from index 0. If the anchor id no longer matches (a
    // future editing feature, an import, a corrupt write) — or the snap
    // landed BEFORE the covered prefix — refold from scratch. The full
    // history is still in session storage, so a refold only loses the
    // model-enriched sections, never correctness.
    if (state.covered > dropCount || !anchor || anchor.id !== state.coveredLastId) {
      state = emptySummaryState();
    }
  }
  const newlyDropped = messages.slice(state.covered, dropCount);
  const nextState = newlyDropped.length > 0 ? foldDropped(state, newlyDropped) : state;
  const kept = messages.slice(dropCount);
  /** @type {InternalMessage} */
  const summaryMsg = {
    role: 'user',
    content: wrapSummary(renderSummaryText(nextState)),
    id: `trim-summary-${dropCount}`,
    when: nextState.lastWhen ?? 0,
    // why: flag so the side panel can hide / dim this synthesised
    // entry rather than letting it look like a real user message in
    // the transcript.
    synthetic: true,
  };
  return {
    messages: [summaryMsg, ...kept],
    didTrim: true,
    summaryState: nextState,
    newlyDropped,
  };
};

/**
 * Back-compat array view of planTrim — same contract as the original
 * trimHistory: messages in, (possibly trimmed) messages out. Callers
 * that need the rolling state (the agent loop) use planTrim directly.
 *
 * @param {readonly TrimInputMessage[]} messages
 * @param {Object} [opts]  see planTrim
 * @returns {TrimmedMessage[]}
 */
export const trimHistory = (messages, opts = {}) => planTrim(messages, opts).messages;
