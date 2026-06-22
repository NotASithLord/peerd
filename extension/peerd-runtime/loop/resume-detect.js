// @ts-check
// Interrupted-turn detection — the read side of auto-resume.
//
// why this exists: an agent turn can die between the model call and a
// durable, user-visible end state — the service worker is evicted
// mid-stream (MV3 reclaims it aggressively), the provider stream closes
// early ('incomplete'), or the SW dies after the model asked for tools
// but before the dispatch round finished. The session store persists
// every delta (agent-loop.js), so the PARTIAL transcript survives — but
// nothing re-drives it. The user reopens the chat to a half-written
// answer or a tool card stuck "pending", with no way forward but
// retyping. (This is the failure the screenshot that motivated the work
// showed in other tools: a turn frozen mid-flight.)
//
// This module is the pure decision: given a session, was its last turn
// interrupted by INFRASTRUCTURE (resumable) rather than by the user or a
// clean stop (not resumable)? The imperative shell (service-worker.js)
// calls it on session open / vault unlock and, when it says yes, drives
// one synthetic continuation turn — the loop rebuilds history from the
// session each step, so injectResumeNotes (partial reasoning) and the
// format layer's orphan-repair (dangling tool_use) make the continuation
// coherent without any special-casing here.
//
// Functional core, no IO, no clock — values in, a verdict out. Bun-tested.

/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * @typedef {'stream-interrupted' | 'incomplete' | 'tools-pending' | 'model-call-pending'} ResumeReason
 */

/**
 * @typedef {{
 *   resumable: true,
 *   reason: ResumeReason,
 *   markerId: string,
 * } | { resumable: false }} ResumeVerdict
 *   `markerId` is the id of the message that marks the interruption. The
 *   shell remembers it so it auto-resumes a given dead turn AT MOST ONCE
 *   per SW lifetime — a fresh interruption (new markerId) resumes again,
 *   the same one does not loop.
 */

const NOT_RESUMABLE = Object.freeze({ resumable: false });

/**
 * Decide whether a session's last turn was interrupted by infrastructure
 * and should be auto-resumed.
 *
 * Resumable (infrastructure cut the turn off mid-flight):
 *   - last is an assistant message still flagged `streaming` — the SW died
 *     mid-stream; the persisted content is partial;
 *   - last is an assistant message with stopReason 'incomplete' — the
 *     provider stream closed without a message_stop (rate limit / drop);
 *   - last is an assistant message carrying an `error` (and NOT a user
 *     abort) — a provider/transport failure ended the turn;
 *   - last is an assistant message whose stopReason is 'tool_use' with
 *     pending toolUses — the model asked for tools but the dispatch round
 *     never produced the matching tool_result turn (SW died between);
 *   - last is a user message carrying `toolResults` — the tools ran and
 *     were persisted, but the follow-up model call never started.
 *
 * NOT resumable:
 *   - empty session;
 *   - last assistant stopReason 'aborted' — the USER pressed Stop / steered;
 *     auto-resuming would fight the user's own choice;
 *   - a normally-completed assistant turn (end_turn / stop / max_tokens as a
 *     real final answer / max_steps clean stop) — there's nothing to finish;
 *   - a bare trailing user message (no toolResults) — too ambiguous to
 *     re-drive automatically (the user can just resend), and it risks
 *     double-acting on a turn that may yet be in flight.
 *
 * @param {Session | null | undefined} session
 * @returns {ResumeVerdict}
 */
export const detectInterruptedTurn = (session) => {
  const messages = session?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return NOT_RESUMABLE;
  const last = messages[messages.length - 1];
  if (!last) return NOT_RESUMABLE;

  if (last.role === 'assistant') {
    // User-initiated stop wins over every interruption signal: never
    // auto-resume what the user deliberately ended.
    if (last.stopReason === 'aborted') return NOT_RESUMABLE;
    if (last.streaming === true) return resumable('stream-interrupted', last);
    if (last.stopReason === 'incomplete') return resumable('incomplete', last);
    // why we DON'T resume on a bare `error`: only stream-drop markers
    // (streaming / 'incomplete') and the tool states below are reliably
    // INFRASTRUCTURE interruptions. A turn that ended with a generic error
    // is more often PERMANENT (a 400 — bad request, context too long): the
    // model can't get past it, and re-resuming would re-fail and re-spend on
    // every cold SW wake (the dedupe only spans one SW lifetime, and each
    // failed resume mints a new markerId). Transient overload/credit faults
    // are instead handled in-turn by provider failover, not here.
    if (last.stopReason === 'tool_use'
        && Array.isArray(last.toolUses) && last.toolUses.length > 0) {
      return resumable('tools-pending', last);
    }
    return NOT_RESUMABLE;
  }

  if (last.role === 'user'
      && Array.isArray(last.toolResults) && last.toolResults.length > 0) {
    // Tools completed and were persisted; the next model call never ran.
    return resumable('model-call-pending', last);
  }

  return NOT_RESUMABLE;
};

/** @param {ResumeReason} reason @param {InternalMessage} marker */
const resumable = (reason, marker) => ({
  resumable: true,
  reason,
  // Fall back to a stable synthetic marker if a legacy message lacks an id,
  // so the shell's dedupe key is always a string.
  markerId: typeof marker.id === 'string' && marker.id ? marker.id : `${reason}:nomarkerid`,
});

// The synthetic user nudge that drives the continuation. Kept terse and
// framed as the system speaking, not the user: the model should pick the
// task back up, not treat this as new instruction. The real continuity
// comes from the rebuilt history (resume notes + orphan-repaired tool
// results), not from this text.
export const RESUME_NUDGE = 'The previous turn was interrupted before it '
  + 'finished (the browser session was reclaimed mid-task). Continue from '
  + 'where it left off — do not restart the task from scratch.';
