// @ts-check
// Confirmation prompt protocol (§4.4).
//
// The dispatcher calls `confirm(prompt)` and awaits the user's answer.
// Under the hood this is a SW ↔ side panel round-trip:
//
//   1. SW puts a prompt on the queue keyed by its UUIDv7
//   2. SW pushes a 'confirm/request' message to the side panel port
//   3. Side panel renders the prompt inline
//   4. User clicks Yes-once / Yes-session / No
//   5. Side panel posts 'confirm/answer' with { id, answer }
//   6. SW resolves the waiting Promise; the dispatcher proceeds
//
// Hang protection (alpha-hardening): a confirm MUST always settle — a turn that
// awaits ctx.confirm() can never hang. So:
//   - BROKEN CHANNEL (side panel closed / no port): auto-deny ('no') immediately
//     — fail-closed, the agent reports it couldn't get approval and moves on.
//   - OPEN BUT UNANSWERED: a generous timeout (the user may be deciding) then
//     auto-deny. While a prompt is pending, the SW raises an action-badge so the
//     user knows the agent is waiting on them (onPendingChange below).
//
// Session-scoped grants live in SW MEMORY (service-worker.js
// sessionConfirmGrants): sessionId → the set of tool NAMES the user
// blanket-approved for that chat. They die with the SW (same blast
// radius as the vault DK), and they are origin-blind — "yes for this
// session" on `click` approves `click` everywhere for that chat. A
// persistent, origin-scoped `tool_grants` store is a documented
// follow-up.

import { uuidv7 } from '/shared/util.js';

/** @typedef {import('/shared/tool-types.js').ConfirmPrompt} ConfirmPrompt */
/** @typedef {import('/shared/tool-types.js').ConfirmAnswer} ConfirmAnswer */

/**
 * Build a confirm coordinator. The SW creates exactly one of these and
 * passes its `confirm` function into every ToolContext.
 *
 * @param {Object} deps
 * @param {(prompt: ConfirmPrompt) => void} deps.notifySidePanel
 *   Push a 'confirm/request' to the side panel port. Called once per
 *   prompt; the side panel is responsible for rendering it.
 * @param {() => boolean} [deps.isChannelOpen]
 *   Whether the side panel can receive a prompt (port present). When it
 *   returns false, confirm() auto-denies immediately instead of hanging.
 *   Defaults to always-open (tests).
 * @param {number} [deps.timeoutMs]
 *   Max time to wait for the user before auto-denying an OPEN-but-unanswered
 *   prompt. Generous by default (the user may be deciding).
 * @param {(pendingCount: number) => void} [deps.onPendingChange]
 *   Called whenever the pending-prompt count changes, so the SW can raise/clear
 *   an action badge ("the agent is waiting on you"). Best-effort.
 * @param {(id: string) => void} [deps.onSettled]
 *   Called with a prompt's id whenever it settles for ANY reason — user answer,
 *   timeout auto-deny, or reset(). The SW broadcasts 'confirm/resolved' so every
 *   open surface dismisses the modal, not just the one that answered (DESIGN-12).
 */
export const makeConfirmCoordinator = ({
  notifySidePanel,
  isChannelOpen = () => true,
  timeoutMs = 120_000,
  onPendingChange = () => {},
  onSettled = () => {},
}) => {
  /** @type {Map<string, { settle: (answer: ConfirmAnswer) => void, prompt: ConfirmPrompt }>} */
  const pending = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();

  const notifyCount = () => { try { onPendingChange(pending.size); } catch { /* best-effort */ } };

  /**
   * Resolve a pending prompt. Called by the SW message handler when the
   * side panel posts 'confirm/answer'.
   *
   * @param {string} id
   * @param {ConfirmAnswer} answer
   */
  const resolve = (id, answer) => {
    const entry = pending.get(id);
    if (!entry) return;  // stale answer (e.g. duplicate / already timed out) — drop silently
    entry.settle(answer);
  };

  /**
   * Ask the user. Returns a Promise that ALWAYS settles with an answer
   * (auto-denies on a broken channel or timeout — never hangs the turn).
   *
   * @param {Omit<ConfirmPrompt, 'id'>} promptInput
   * @returns {Promise<ConfirmAnswer>}
   */
  const confirm = (promptInput) => new Promise((res) => {
    // Broken channel → fail-closed immediately. The agent can't reach the user,
    // so it must not perform the side-effect AND must not hang.
    if (!isChannelOpen()) { res('no'); return; }

    const id = uuidv7();
    const prompt = { ...promptInput, id };
    /** @param {ConfirmAnswer} answer */
    const settle = (answer) => {
      const t = timers.get(id); if (t) clearTimeout(t); timers.delete(id);
      // onSettled inside the delete-guard → fires EXACTLY once, on the first
      // settle (answer or timeout), so every surface dismisses the modal.
      if (pending.delete(id)) { res(answer); notifyCount(); try { onSettled(id); } catch { /* best-effort */ } }
    };
    pending.set(id, { settle, prompt });
    timers.set(id, setTimeout(() => settle('no'), timeoutMs));
    notifyCount();
    notifySidePanel(prompt);
  });

  /** Drop all pending prompts (e.g. on session end). Clears timers too, and
   * fires onSettled for each so any open modal is dismissed everywhere. */
  const reset = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const ids = [...pending.keys()];
    pending.clear();
    notifyCount();
    for (const id of ids) { try { onSettled(id); } catch { /* best-effort */ } }
  };

  /**
   * Decline (settle to 'no') every pending prompt for ONE session — called when
   * that session's turn is aborted (Stop / steer-live). why: a turn parked on
   * ctx.confirm() when the user aborts must NOT later run the side-effecting tool
   * the user just cancelled, and must not stay parked for the full timeout while
   * a steered turn writes the same session. Settling to 'no' unblocks the old
   * turn straight into its abort exit, performing nothing. First-settle-wins (the
   * settle guard): a user 'yes' that already landed is honored and this no-ops;
   * otherwise 'no' wins and a late 'yes' for that id is dropped. Session-scoped —
   * a Stop in one chat never touches a pending confirm in another.
   *
   * @param {string | null | undefined} sessionId
   */
  const declineSession = (sessionId) => {
    if (sessionId == null) return;
    // snapshot: settle() mutates `pending` as it resolves each promise.
    for (const { settle, prompt } of [...pending.values()]) {
      if (prompt.sessionId === sessionId) settle('no');
    }
  };

  // The most-recently-raised un-settled prompt — replayed to a surface that
  // connects AFTER it was broadcast (DESIGN-12 late-joiner; the state snapshot
  // does NOT carry confirm state, which flows on the confirm/* channel).
  const getPending = () => {
    /** @type {ConfirmPrompt | null} */
    let last = null;
    for (const { prompt } of pending.values()) last = prompt;
    return last;
  };

  return { confirm, resolve, reset, declineSession, getPending };
};
