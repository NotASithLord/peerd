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
//     why: an async actor finishing must re-enter its parent as a new
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

// WHY the abort carries a REASON. Both paths below abort the same controller, but
// they mean opposite things to work the turn had delegated: Stop means "end it", a
// steer means "also do this" — the user added a message, they did not ask for the
// web actor mid-fetch to be thrown away. A bare abort() is indistinguishable at the
// listener, so an awaited delegation had to treat every abort as a cancel and
// destroyed in-flight actor work on a steer. These reasons let a listener tell them
// apart (actor-messaging.js routes a steer through degrade-to-async instead of
// cancelling). Plain strings, compared by identity-free equality: the signal crosses
// no worker boundary, but a string survives one and an Error subclass would not.
export const ABORT_STOP = 'peerd:stop';
export const ABORT_STEER = 'peerd:steer';

/**
 * @returns {{
 *   claim: (sessionId: string) => { controller: AbortController, release: () => void },
 *   stop: (sessionId: string) => boolean,
 *   isBusy: (sessionId: string) => boolean,
 *   runWhenIdle: (sessionId: string, fn: () => void) => void,
 *   runWhenIdleClaimed: (sessionId: string, fn: (lease: { controller: AbortController, release: () => void }) => void) => void,
 *   advanceQueue: (sessionId: string) => void,
 * }}
 * @param {{ onAbort?: (sessionId: string) => void, forceReleaseMs?: number }} [deps]
 *   onAbort fires whenever a session's turn is aborted (a steer-live supersede
 *   or Stop). The SW wires it to confirmCoordinator.declineSession, so a turn
 *   parked on ctx.confirm() is unblocked (declined) instead of left stranded
 *   for the full timeout while a steered turn writes the same session. Default
 *   no-op (tests / orchestrators that don't need it).
 *   forceReleaseMs overrides the abort watchdog delay (tests).
 */
export const makeTurnSlots = ({ onAbort, forceReleaseMs = 15_000 } = {}) => {
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
    // wake that does not claim the slot would leave remaining wakes stranded
    // until the next real turn — so a wake that DECLINES to run a turn (e.g.
    // the post-Stop gen-skip in actor-messaging) must call advanceQueue below
    // to keep the pump moving.
    try { fn(); } catch { /* swallowed */ }
  };

  // Abort watchdog (issue #176). Slot removal normally relies on the turn's
  // own release() — but a turn parked on an abort-ignoring await (an un-timed
  // CDP call, a stuck page promise) never unwinds, so abort() alone would pin
  // the slot for the SW lifetime: the session reads busy forever and queued
  // idle-wakes never drain. After an abort, if the SAME controller still owns
  // the slot once the grace elapses, force-release it. Self-scoped like
  // release(): if the turn DID unwind (or a steer re-claimed), the guard
  // no-ops. The zombie turn's own late release() is equally self-scoped, so a
  // forced release can't clear a newer turn's claim.
  /** @param {string} sessionId @param {AbortController} controller */
  const forceReleaseAfterGrace = (sessionId, controller) => {
    setTimeout(() => {
      if (slots.get(sessionId) === controller) {
        slots.delete(sessionId);
        drainIdle(sessionId);
      }
    }, forceReleaseMs);
  };

  /** @param {string} sessionId */
  const claim = (sessionId) => {
    // Steer-live: a second send into the SAME chat supersedes the
    // turn already streaming there. onAbort decline-settles the superseded
    // turn's pending confirm (if any) so it doesn't run the cancelled action.
    const superseded = slots.get(sessionId);
    if (superseded) { superseded.abort(ABORT_STEER); onAbort?.(sessionId); }
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
  };

  return {
    claim,

    stop(sessionId) {
      const controller = slots.get(sessionId);
      if (!controller) return false;
      controller.abort(ABORT_STOP);
      onAbort?.(sessionId); // decline any confirm this turn is parked on
      // A well-behaved turn observes the abort and release()s within ms; a
      // hung one never does — reap it so Stop actually frees the session.
      // (claim()'s supersede path needs no watchdog: it re-claims the slot
      // for the new turn in the same tick.)
      forceReleaseAfterGrace(sessionId, controller);
      return true;
    },

    isBusy: (sessionId) => slots.has(sessionId),

    runWhenIdle(sessionId, fn) {
      if (!slots.has(sessionId)) { fn(); return; }
      const q = idleQueues.get(sessionId) ?? [];
      q.push(fn);
      idleQueues.set(sessionId, q);
    },

    // Actor delivery has asynchronous setup before its model driver can claim.
    // Reserve synchronously at dequeue and pass that exact lease through setup,
    // so a second queued message cannot see an idle slot and overtake it.
    runWhenIdleClaimed(sessionId, fn) {
      const startClaimed = () => {
        const lease = claim(sessionId);
        try { fn(lease); }
        catch {
          // A synchronous setup failure must not strand the reservation.
          lease.release();
        }
      };
      if (!slots.has(sessionId)) { startClaimed(); return; }
      const q = idleQueues.get(sessionId) ?? [];
      q.push(startClaimed);
      idleQueues.set(sessionId, q);
    },

    // A runWhenIdle wake that DECLINED to start a turn (so no claim/release
    // will re-drain) calls this to hand the idle slot to the next queued wake.
    // No-op when a turn holds the slot (drainIdle's own guard) — safe to call
    // unconditionally. Re-entrant with drainIdle: a chain of consecutive
    // decliners drains synchronously and stops at the first wake that starts a
    // turn (its async claim then owns the slot; its release re-drains the rest).
    advanceQueue(sessionId) { drainIdle(sessionId); },
  };
};
