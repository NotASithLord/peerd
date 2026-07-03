// @ts-check
// delegation-lineage — the PURE trust decision for the "subagents as async
// actors" refactor (PR #134, WIRED — the sender gate in actor-messaging.js
// routes through mayMessageActor and stamps messageProvenance on envelopes).
//
// PROBLEM. Today a subagent and a message_actor actor are two different async
// lifecycles. The one that matters here: a subagent CANNOT message an actor, so
// a subagent can't drive a tab / VM / notebook the way the orchestrator can.
// What blocks it is the sender gate's IDENTITY check
// (subagent/actor-messaging.js — `senderSessionId !== active` refuses), which
// uses "are you the foreground chat" as a stand-in for "are you trusted." A
// subagent runs under a child session id that is never `currentSessionId`, so it
// is refused even though it is a first-party descendant of the active chat.
//
// THE FIX (this file is its crux). Replace the `=== active` identity check with
// a trusted-LINEAGE check: a session may message an actor when it is the active
// chat OR a descendant of it reached ENTIRELY through trusted SPAWN edges. Two
// walls stay exactly as they are:
//   1. the inbound wall — `inbound === true` still refuses. `inbound` is the
//      turn's untrusted-origin flag (synthetic && !trusted, service-worker.js).
//      It is what keeps an injected/synthetic re-entry from delegating, and it is
//      ALSO what keeps an async-subagent's RESULT-wake from delegating (that wake
//      re-enters the parent trusted:false → inbound:true), preserving the explicit
//      "a parent reacting to a child result is not trusted to delegate" decision.
//      So the RESULT edge needs no handling here: the inbound wall already covers it.
//   2. the capability strip — message_actor's ctx closure survives only for a ctx
//      whose toolset grants message_actor (spawn.js CAPABILITY_CONSUMERS). A
//      tools:[] fan-out child still can't delegate. Unchanged.
//
// THE HOLE THIS CLOSES (why lineage alone is not enough). An INBOUND turn on the
// active chat is refused message_actor directly — but it can still call
// spawn_subagent, and the child it spawns runs non-inbound turns. Without care,
// that child would be a "descendant of the active chat" and could message actors
// on the injected turn's behalf — laundering delegation around the inbound wall.
// So a spawn edge is trusted ONLY when the spawning turn was itself trusted
// (not inbound). The shell stamps that verdict onto the child at spawn time
// (`spawnedTrusted`), and one untrusted spawn taints its whole subtree. Because
// parentSessionId is set server-side at sessions.create (never model-supplied),
// the ancestry chain itself is not attacker-forgeable; the only thing that can
// downgrade trust is an inbound spawning turn, which is exactly what we taint on.
//
// PURE (no IO) → Bun-testable. The imperative shell (actor-messaging.js, once
// wired) builds `ancestry` by walking parentSessionId up from the sender via the
// session store, then asks this function yes/no. This function reads values only.

// Feature flag for the refactor — ON: the sender gate (actor-messaging.js)
// routes through mayMessageActor(), subagents run under abortable,
// timeout-bounded turn slots (spawn.js), and envelopes carry provenance.
// Kept (not deleted) so the gate can revert to the strict `=== active`
// identity check with a one-line flip if a field problem surfaces; OFF
// restores the pre-#134 sender gate, everything else stands.
export const ASYNC_SUBAGENT_ACTORS = true;

/**
 * One hop of a sender's ancestry: a session record reduced to the fields the
 * trust decision needs. Nearest-first (the sender itself is index 0).
 * @typedef {Object} LineageHop
 * @property {string} sessionId              this session's id
 * @property {string | null} parentSessionId who spawned it (server-set; null for a root chat)
 * @property {boolean} spawnedTrusted        was the SPAWNING turn trusted (non-inbound)?
 *   true for a root chat (nothing spawned it) and for a child spawned by a
 *   trusted turn; false when an INBOUND turn spawned this session — that taints
 *   the whole subtree beneath it.
 */

/**
 * May `senderSessionId` send a message to an actor? The trusted-lineage rule
 * that replaces the sender gate's `senderSessionId === active` identity check.
 *
 * Accept iff, in order:
 *   1. the current turn is NOT inbound (untrusted-origin wall, unchanged), AND
 *   2. the sender IS the active chat, OR it is a descendant of the active chat
 *      whose entire ancestry up to the active chat was spawned by trusted turns.
 *
 * @param {Object} req
 * @param {boolean} req.inbound           the CURRENT turn's untrusted-origin flag
 * @param {string | null | undefined} req.senderSessionId  the calling session
 * @param {string | null | undefined} req.activeSessionId  currentSessionId (foreground chat)
 * @param {ReadonlyArray<LineageHop>} [req.ancestry]  sender-first chain toward the
 *   root, built by the shell from the store. Omitted/empty → only the direct
 *   foreground-identity path can pass (fail-closed for a missing chain).
 * @returns {boolean}
 */
export const mayMessageActor = ({ inbound, senderSessionId, activeSessionId, ancestry = [] }) => {
  // Wall 1 — inbound origin. An injected/synthetic turn (and the async result-
  // wake) never delegates, no matter whose lineage it runs under. Fail-closed.
  if (inbound === true) return false;
  if (!senderSessionId || !activeSessionId) return false;

  // The foreground chat itself — today's sole accepted sender. Kept as a fast path.
  if (senderSessionId === activeSessionId) return true;

  // Trusted-lineage: walk the sender's ancestry toward the root. The sender is
  // admitted only if it reaches the active chat AND every hop from the sender up
  // to (and including) the active chat was spawned by a trusted turn. A single
  // untrusted (inbound-spawned) hop taints the subtree and refuses.
  //
  // why require the sender itself to be spawnedTrusted: the sender is the child
  // an inbound turn would have spawned to launder access — so its own spawn
  // verdict is the first thing that must be trusted.
  const byId = new Map(ancestry.map((h) => [h.sessionId, h]));
  let cursor = /** @type {LineageHop | undefined} */ (byId.get(senderSessionId));
  const seen = new Set();                       // cycle guard (a corrupt chain can't hang us)
  while (cursor && !seen.has(cursor.sessionId)) {
    if (!cursor.spawnedTrusted) return false;    // an untrusted spawn anywhere → refuse
    if (cursor.parentSessionId === activeSessionId) return true; // reached the active root cleanly
    seen.add(cursor.sessionId);
    cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) : undefined;
  }
  // Ran out of chain without reaching the active chat: not a descendant. Refuse.
  return false;
};

// ── mailbox provenance — the choke-point judgement ──────────────────────────
//
// An actor is a serialized CHOKE POINT: one tab (or one origin), one mailbox,
// one turn at a time. While only the foreground chat messages it, "who sent
// this" is trivial. Once actors are SHARED — a web actor on a tab that several
// orchestrators or subagents all message — the actor (and the mailbox in front
// of it) must arbitrate: coalesce an accidental duplicate, order competing
// requests, cancel one a newer message supersedes, or keep unrelated senders
// fair. To make that call it needs each message's PROVENANCE: who sent it, and
// on whose behalf.
//
// The trusted-lineage chain already carries exactly that, so provenance is free
// once the gate has it. The shell stamps it onto the message ENVELOPE
// (denormalized) so the actor never has to walk the store mid-turn.
//
// why the envelope, not a structured session id: session ids are uuidv7
// (time-sortable, globally-unique store keys); overloading them with a parent
// path is brittle to parse and length-bound. The envelope carries the full
// reference instead — same capability (the actor can name the parent), no id
// overloading. Encoding it into the id is an owner call; the shape is the same.

/**
 * The provenance an actor's mailbox stamps on each incoming message, derived
 * from the sender's trusted-lineage chain.
 *
 * @param {Object} req
 * @param {string} req.senderSessionId
 * @param {ReadonlyArray<LineageHop>} [req.ancestry]  sender-first chain toward the root
 * @returns {{ senderSessionId: string, rootSessionId: string, lineagePath: string[] }}
 *   rootSessionId — the chat at the base of the lineage (who ULTIMATELY asked);
 *   equals senderSessionId for a top-level chat or a missing chain.
 *   lineagePath — root → … → sender ids: the "reference to the parent" an actor
 *   uses to group by root (fairness), match a supersede (same sender), or flag a
 *   likely duplicate (same lineagePath + same intent, close in time).
 */
export const messageProvenance = ({ senderSessionId, ancestry = [] }) => {
  const byId = new Map(ancestry.map((h) => [h.sessionId, h]));
  const path = [senderSessionId];
  const seen = new Set([senderSessionId]);
  let cursor = /** @type {LineageHop | undefined} */ (byId.get(senderSessionId));
  // Walk parentSessionId up to the root; the cycle guard keeps a corrupt chain
  // from hanging us (a self-referential parent just stops the walk).
  while (cursor?.parentSessionId && !seen.has(cursor.parentSessionId)) {
    path.push(cursor.parentSessionId);
    seen.add(cursor.parentSessionId);
    cursor = byId.get(cursor.parentSessionId);
  }
  path.reverse();                 // root → … → sender
  return { senderSessionId, rootSessionId: path[0], lineagePath: path };
};
