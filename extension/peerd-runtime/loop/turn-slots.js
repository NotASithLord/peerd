// @ts-check
// Per-session turn slots — the concurrency contract for in-flight turns.
//
// One slot per SESSION, not one global slot. The original single-slot
// design meant sending a message in ANY chat aborted whatever turn was
// streaming in any OTHER chat — navigating to a second conversation and
// chatting there silently killed the first one's stream (owner report,
// 2026-06-12). The rules this module encodes:
//
//   - claim(sessionId): sending into a chat that is ALREADY streaming
//     aborts that chat's turn first (steer-live — the new message
//     supersedes). A turn streaming in a DIFFERENT chat is untouched.
//   - release is self-scoped: a superseded turn unwinding late can only
//     clear its OWN claim, never the newer turn that replaced it.
//   - stop(sessionId) aborts that session's turn only — the side
//     panel's Stop button must never reach across conversations.
//   - runWhenIdle(sessionId, fn): run fn the moment the session has no
//     live turn — NOW if idle, else after the current turn RELEASES.
//     why: an async subagent finishing must re-enter its parent as a new
//     turn (DESIGN-11), but the parent may be mid-turn (the user is
//     chatting with it). claim() would steer-abort that live turn — a
//     focus/work theft (DECISIONS #20). runWhenIdle waits for the slot
//     instead of seizing it. The queued fn is contracted to START a turn
//     (claim the slot); that turn's own release drains the next queued
//     wake, so wakes serialise instead of racing each other's claim.
//
// Pure with respect to IO: holds only AbortControllers in memory. The
// service worker is the imperative shell that binds these slots to the
// agent loop, the side-panel port, and auto-memory's busy gate.

/**
 * @returns {{
 *   claim: (sessionId: string) => { controller: AbortController, release: () => void },
 *   stop: (sessionId: string) => boolean,
 *   isBusy: (sessionId: string) => boolean,
 *   runWhenIdle: (sessionId: string, fn: () => void) => void,
 * }}
 */
export const makeTurnSlots = () => {
  /** @type {Map<string, AbortController>} */
  const slots = new Map();
  /** @type {Map<string, Array<() => void>>} idle-wake queue per session */
  const idleQueues = new Map();

  // Run the next queued wake for a session that just went idle. The wake
  // is contracted to start a turn (re-claim the slot); when THAT turn
  // releases, this drains again — so wakes run one at a time, never
  // concurrently (which would have them abort each other via claim()).
  /** @param {string} sessionId */
  const drainIdle = (sessionId) => {
    if (slots.has(sessionId)) return; // a turn already owns the slot; its release re-drains
    const q = idleQueues.get(sessionId);
    if (!q || q.length === 0) return;
    const fn = q.shift();
    if (q.length === 0) idleQueues.delete(sessionId);
    if (!fn) return;
    // why try/catch: a wake callback must never corrupt the slot map. A
    // wake that does not claim the slot leaves remaining wakes waiting for
    // the next real turn — acceptable; our only caller always runs a turn.
    try { fn(); } catch { /* swallowed */ }
  };

  return {
    claim(sessionId) {
      // Steer-live: a second send into the SAME chat supersedes the
      // turn already streaming there.
      slots.get(sessionId)?.abort();
      const controller = new AbortController();
      slots.set(sessionId, controller);
      return {
        controller,
        release: () => {
          // Only clear our own claim — if a steer already replaced this
          // controller, the newer turn owns the slot.
          if (slots.get(sessionId) === controller) {
            slots.delete(sessionId);
            drainIdle(sessionId);
          }
        },
      };
    },

    stop(sessionId) {
      const controller = slots.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },

    isBusy: (sessionId) => slots.has(sessionId),

    runWhenIdle(sessionId, fn) {
      if (!slots.has(sessionId)) { fn(); return; }
      const q = idleQueues.get(sessionId) ?? [];
      q.push(fn);
      idleQueues.set(sessionId, q);
    },
  };
};
