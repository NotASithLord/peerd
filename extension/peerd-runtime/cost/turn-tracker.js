// @ts-check
// Per-turn cost tracking + the hard spend-limit halt (feature 06).
//
// The accumulator (accumulator.js) is the functional core — pure folds
// over token usage. This file is the next ring out: the per-turn
// imperative shell the SW used to inline in runAgentTurn, now a factory
// with every IO surface injected (persist, push, halt). The SW's
// streaming switch reduces to:
//
//   if (ev.type === 'usage') { await tracker.onUsage(ev); tracker.maybeHalt(ev); }
//
// Two tallies compose (see accumulator.js): the CURRENT turn's tally
// (pushed live for the meter's "this turn" readout) and the running
// session tally (persisted + checked against the limit).
//
// Snapshot semantics: model, pricing overrides, and the spend limit are
// captured at construction (turn start) — exactly like the SW's other
// per-turn settings reads. A mid-turn settings change applies to the
// NEXT turn, never mid-stream.

import {
  emptyTally, normalizeTally, addUsage, bumpTurn, limitExceeded,
} from './accumulator.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').TokenUsage} TokenUsage */

/**
 * @param {Object} deps
 * @param {(model: string|undefined, usage: Partial<TokenUsage>, overrides?: object) => { cost: number }} deps.costOf
 *   Pricing fn (peerd-provider's local table). Injected, never imported —
 *   the runtime takes Layer-1 capabilities via DI.
 * @param {string|undefined} deps.model
 *   The SESSION's model (the one that actually produced the usage), not
 *   the current Settings selection — an old chat keeps its original
 *   model even if the user later switches the default.
 * @param {object|undefined} deps.pricingOverrides   settings.pricingOverrides snapshot
 * @param {number|undefined} deps.limitUsd           settings.spendLimitUsd snapshot (0/absent = no limit)
 * @param {object|null|undefined} deps.initialSessionCost
 *   The session record's persisted tally; normalized + turn-bumped here
 *   so pre-feature sessions and corrupt writes can't poison the meter.
 * @param {(sessionTally: object) => Promise<void>} deps.persistCost
 *   Persist the running session total (sessions.setCost bound to the
 *   turn's sessionId). Failures are swallowed — a persist hiccup must
 *   never break the stream.
 * @param {(info: { sessionId: any, turn: object, session: object, limitUsd: number|undefined }) => void} [deps.onCost]
 *   Live meter push after every fold (the SW posts turn/cost; it owns
 *   the side-panel-port guard).
 * @param {(info: { sessionId: any, spent: number, limitUsd: number|undefined }) => void} [deps.onLimitExceeded]
 *   The hard-limit halt (the SW posts turn/spend-limit-reached, audits,
 *   and aborts the turn). Fired ONCE per tracker: the abort it triggers
 *   is idempotent and kills the stream, so a one-shot latch is the same
 *   halt semantics without duplicate notifications/audit rows if a
 *   straggler usage event lands before the abort unwinds.
 */
export const makeTurnCostTracker = (deps) => {
  const {
    costOf,
    model,
    pricingOverrides,
    limitUsd,
    initialSessionCost,
    persistCost,
    onCost = () => {},
    onLimitExceeded = () => {},
  } = deps;

  // Start the session tally from whatever's persisted on the session
  // record, and count this user turn in both tallies.
  let turnTally = bumpTurn(emptyTally());
  let sessionTally = bumpTurn(normalizeTally(initialSessionCost));
  let limitFired = false;

  /**
   * Fold one provider `usage` event: price it from the LOCAL table
   * (+ user overrides — no usage leaves the browser), accumulate both
   * tallies, persist the session total (so /chats review and a SW
   * restart both see an accurate lifetime spend), then push the live
   * meter. Ordering preserved from the original inline code:
   * fold → persist → push.
   *
   * @param {{ sessionId?: any, usage: Partial<TokenUsage> }} ev
   */
  const onUsage = async (ev) => {
    const { cost } = costOf(model, ev.usage, pricingOverrides);
    turnTally = addUsage(turnTally, ev.usage, cost);
    sessionTally = addUsage(sessionTally, ev.usage, cost);
    try { await persistCost(sessionTally); } catch { /* never break the stream */ }
    onCost({ sessionId: ev.sessionId, turn: turnTally, session: sessionTally, limitUsd });
  };

  /**
   * HARD LIMIT: when the session's accumulated cost crosses the user's
   * cap, fire onLimitExceeded (once) so the caller halts the agent.
   * Returns whether the limit is currently exceeded.
   *
   * @param {{ sessionId?: any }} ev
   * @returns {boolean}
   */
  const maybeHalt = (ev) => {
    if (!limitExceeded(sessionTally.cost, limitUsd)) return false;
    if (!limitFired) {
      limitFired = true;
      onLimitExceeded({ sessionId: ev.sessionId, spent: sessionTally.cost, limitUsd });
    }
    return true;
  };

  return Object.freeze({
    onUsage,
    maybeHalt,
    /** Current turn tally (read-only view for callers/tests). */
    turn: () => turnTally,
    /** Running session tally (read-only view for callers/tests). */
    session: () => sessionTally,
  });
};
