// @ts-check
// Cost/usage accumulation — the functional core of feature 06.
//
// Pure reducers over token usage. No IO, no storage, no clock. The SW
// owns the imperative shell (read persisted totals → fold in new usage →
// persist → push to side panel → enforce the limit). This file just does
// the arithmetic so it's trivially unit-testable.
//
// Two tallies compose:
//   - turn total:    usage + cost for the CURRENT user turn (one user
//                    message → N model calls as the agent uses tools).
//                    Reset at the start of each user turn.
//   - session total: usage + cost across every turn in the session.
//                    Persisted on the session so /chats review shows the
//                    lifetime spend of a conversation.
//
// A single model call can emit multiple `usage` events only in pathological
// cases; normally one per call. We ADD every usage event into the turn, so
// a multi-step tool-using turn correctly sums all its model calls.

/** @typedef {import('/peerd-provider/format/from-anthropic.js').TokenUsage} TokenUsage */

/**
 * @typedef {Object} CostTally
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} cost           USD, accumulated client-side
 * @property {number} turns          # of user turns folded in (session tally)
 */

/** A zeroed tally. Fresh object each call — never share a mutable default. */
export const emptyTally = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  turns: 0,
});

/**
 * Coerce an arbitrary stored value into a valid tally. Sessions written
 * before this feature have no tally; a corrupt write shouldn't poison the
 * meter. Pure; returns a fresh object.
 *
 * @param {Partial<CostTally> | null | undefined} t
 * @returns {CostTally}
 */
export const normalizeTally = (t) => {
  const base = emptyTally();
  if (!t || typeof t !== 'object') return base;
  for (const k of /** @type {(keyof CostTally)[]} */ (Object.keys(base))) {
    const v = t[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[k] = v;
  }
  return base;
};

/**
 * Fold one usage event (+ its computed cost) into a tally. Returns a NEW
 * tally — the input is not mutated. `turns` is left untouched here; bump
 * it explicitly with `bumpTurn` at user-turn boundaries so a multi-call
 * turn counts as one.
 *
 * @param {CostTally} tally
 * @param {Partial<TokenUsage> | null | undefined} usage  fields read defensively
 * @param {number} cost   USD for THIS usage event (from costOf)
 * @returns {CostTally}
 */
export const addUsage = (tally, usage, cost) => {
  const u = usage ?? {};
  return {
    inputTokens:      tally.inputTokens      + (u.inputTokens      || 0),
    outputTokens:     tally.outputTokens     + (u.outputTokens     || 0),
    cacheReadTokens:  tally.cacheReadTokens  + (u.cacheReadTokens  || 0),
    cacheWriteTokens: tally.cacheWriteTokens + (u.cacheWriteTokens || 0),
    cost:             tally.cost             + (Number.isFinite(cost) ? cost : 0),
    turns:            tally.turns,
  };
};

/**
 * Increment the user-turn counter. Returns a new tally.
 * @param {CostTally} tally
 * @returns {CostTally}
 */
export const bumpTurn = (tally) => ({ ...tally, turns: tally.turns + 1 });

/**
 * Total tokens across all four buckets — handy for the compact meter.
 * @param {CostTally} tally
 */
export const totalTokens = (tally) =>
  (tally.inputTokens || 0) + (tally.outputTokens || 0)
  + (tally.cacheReadTokens || 0) + (tally.cacheWriteTokens || 0);

/**
 * Hard-limit predicate. The user sets an optional session spend cap (USD);
 * when the accumulated session cost crosses it, the agent halts. Pure so
 * the SW can call it after every usage fold and the test can assert the
 * exact crossing boundary.
 *
 * A non-positive or non-finite limit means "no limit" → never exceeded.
 * We use strict `>` (not `>=`): a session that lands exactly on the cap is
 * allowed; only spend that PUSHES PAST it halts. This matches the user's
 * mental model of "stop me before I spend MORE than $X".
 *
 * @param {number} sessionCost   USD accumulated this session
 * @param {number | null | undefined} limit   USD cap, or null/0 for none
 * @returns {boolean}
 */
export const limitExceeded = (sessionCost, limit) => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return false;
  return sessionCost > limit;
};
