// @ts-check
// Resume notes — make interrupted reasoning resumable instead of lost.
//
// why this module exists: two layers conspire to erase an interrupted
// reasoning attempt from the next request.
//   1. The Anthropic API strips prior-turn thinking blocks server-side —
//      replayed signed blocks are only consumed on the in-flight tool-use
//      continuation path; on a fresh turn the model cannot see what it
//      already thought.
//   2. peerd's format layer (peerd-provider/format/to-anthropic.js) DROPS
//      thinking-only assistant messages outright — "Empty (or
//      thinking-only) assistant message is invalid" on the wire.
// Net effect: a turn interrupted mid-reasoning (steer-live abort,
// output-token truncation, provider error) leaves NO trace of the attempt
// in the next request, and the model restarts the same doomed reasoning
// from scratch.
//
// The session, however, persists the reasoning text per-delta on the
// assistant message's `thinking` field (agent-loop.js). This module
// rewrites interrupted turns so that persisted-but-unseeable thinking
// becomes VISIBLE assistant text — partial working notes the next call
// can resume from. Pure: values in, values out, no IO, no clock.

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */

// Tail cap on injected notes. The point of the notes is "where was I" —
// the most recent reasoning carries that; ancient preamble does not.
export const RESUME_NOTES_MAX_CHARS = 3000;

// When the cap bites, scan this many chars forward into the tail for a
// line break to cut on, so the notes start on a whole line instead of
// mid-sentence shrapnel. Beyond the window, keep the raw cut — losing
// 200 chars is fine, losing a whole long paragraph is not.
const LINE_SNAP_WINDOW = 200;

// One line, bracketed: the model reads this inline as its own prior turn,
// so it must say what happened AND what to do (resume, don't restart).
const RESUME_PREAMBLE = '[This turn was interrupted mid-reasoning; below'
  + ' are its partial working notes. Resume from where they leave off'
  + ' rather than restarting the reasoning from scratch.]';

/** @param {string} thinking */
const tailNotes = (thinking) => {
  if (thinking.length <= RESUME_NOTES_MAX_CHARS) return thinking;
  const tail = thinking.slice(-RESUME_NOTES_MAX_CHARS);
  const nl = tail.indexOf('\n');
  return nl !== -1 && nl < LINE_SNAP_WINDOW ? tail.slice(nl + 1) : tail;
};

/**
 * Rewrite interrupted reasoning-only assistant turns so their persisted
 * `thinking` text rides the next request as visible resume notes.
 *
 * A message qualifies only when ALL hold:
 *   (a) no toolUses — tool_use turns are untouched: their signed
 *       thinkingBlocks are REQUIRED replay for the in-flight tool loop
 *       (the API 400s without them), and the orphan-repair path already
 *       narrates interruption there;
 *   (b) a non-empty string `thinking` field — otherwise nothing to resume;
 *   (c) an interrupted marker — stopReason 'aborted', 'max_tokens', or
 *       'incomplete', or a truthy `error`. ('incomplete' always ships
 *       with an `error` today; matching it by name keeps a future path
 *       that sets it alone from silently losing its notes.) A completed
 *       turn's thinking already led into its visible answer; injecting
 *       notes there would only bloat.
 *
 * Qualifying messages become a shallow copy: thinkingBlocks removed (the
 * API strips replayed thinking on a fresh turn anyway — shipping signed
 * blocks alongside the visible notes would pay the payload twice), and
 * content = existing text (if any, first, then a blank line) + preamble +
 * the last RESUME_NOTES_MAX_CHARS chars of the thinking. Every other
 * message passes through by reference; the input array is never mutated.
 *
 * @param {ReadonlyArray<InternalMessage>} messages
 * @returns {InternalMessage[]}
 */
export const injectResumeNotes = (messages) => (messages ?? []).map((m) => {
  if (m?.role !== 'assistant') return m;
  if (Array.isArray(m.toolUses) && m.toolUses.length > 0) return m;
  const thinking = /** @type {any} */ (m).thinking;
  if (typeof thinking !== 'string' || thinking.length === 0) return m;
  const interrupted = m.stopReason === 'aborted'
    || m.stopReason === 'max_tokens'
    || m.stopReason === 'incomplete'
    || Boolean(m.error);
  if (!interrupted) return m;

  const notes = `${RESUME_PREAMBLE}\n${tailNotes(thinking)}`;
  const copy = /** @type {any} */ ({ ...m });
  delete copy.thinkingBlocks;
  copy.content = typeof m.content === 'string' && m.content.length > 0
    ? `${m.content}\n\n${notes}`
    : notes;
  return copy;
});
