// @ts-check
// background/a2a-consent.js — the two PURE consent decisions for a2a first-contact.
//
// Extracted from service-worker.js so the security-sensitive rule the swarm
// flagged — "Allow once" must NOT persist as a standing signing grant — is unit
// tested in isolation, not left to trace-by-eye through the SW. Values in, values
// out, no IO.
//
// The two decisions work together (the SW wires both):
//   1. downgradesActorConfirm — the DESIGN-17 actor per-turn rule rewrites an
//      ephemeral actor's "yes_session" to a one-shot so an actor can't accumulate
//      a standing grant. a2a_contact is the SANCTIONED exception: it's an explicit
//      first-contact ALLOWLIST decision (the exact peer did is shown to the user,
//      like adding a contact), not a steer-able per-action confirm — so its raw
//      answer survives.
//   2. a2aConsentOutcome — given that surviving answer, decide whether this call is
//      allowed and whether the peer is PERSISTED to the allowlist. Only
//      "yes_session" persists; "yes_once" allows this call ONLY.

// The sanctioned allowlist confirms whose "Allow for session" survives the
// actor per-turn downgrade: a2a_contact (first contact) and a2a_reply
// (per-conversation reply consent) are both explicit, user-shown, revocable
// grants — not steer-able per-action confirms.
const A2A_ALLOWLIST_CONFIRMS = new Set(['a2a_contact', 'a2a_reply']);

/**
 * Should the actor per-turn rule downgrade this confirm answer to a one-shot?
 * True only for an ephemeral (actor) session answering "yes_session" on a tool
 * OTHER than the sanctioned allowlist decisions above; every other actor
 * confirm keeps the strict downgrade.
 * @param {string} tool
 * @param {boolean} ephemeral   is the confirming session an actor (kind:'actor')?
 * @param {string} answer       the raw confirm answer
 * @returns {boolean}
 */
export const downgradesActorConfirm = (tool, ephemeral, answer) =>
  ephemeral === true && !A2A_ALLOWLIST_CONFIRMS.has(tool) && answer === 'yes_session';

/**
 * Turn a resolved a2a_contact answer into { ok, persist }.
 *   yes_session → ok, and PERSIST the peer to the revocable allowlist (silent after)
 *   yes_once    → ok for THIS call only, never persisted
 *   anything else (no / dismissed) → denied
 * @param {string} answer
 * @returns {{ ok: boolean, persist: boolean }}
 */
export const a2aConsentOutcome = (answer) => ({
  ok: answer === 'yes_once' || answer === 'yes_session',
  persist: answer === 'yes_session',
});
