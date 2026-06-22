// @ts-check
// Cost/usage meter — the always-visible spend surface (feature 06).
//
// Browser-native angle: the user is WATCHING the agent work in their
// browser, so the meter lives in the chat header strip, ticking up live
// as `turn/cost` events land. It shows this turn's spend, the session
// lifetime total, and — when a hard limit is set — a budget bar that
// fills toward the cap and turns into a clear "spend limit reached" halt
// banner when the agent is stopped.
//
// Pure projection of state.cost (+ state.session.cost as the persisted
// fallback). No IO. All dollar values are computed upstream from the
// LOCAL pricing table — this component never does network or pricing.

import m from '/vendor/mithril/mithril.js';

/**
 * A token/cost tally — the live turn or persisted session usage shape.
 * @typedef {Object} CostTally
 * @property {number} [cost]              dollar cost
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 */

// Compact USD formatter. Sub-cent spend is common on cheap models, so we
// widen precision below a penny rather than rounding everything to $0.00
// (which would make the meter look broken on an OpenRouter mini model).
/** @param {number|null|undefined} n */
const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
};

/** @param {CostTally|null|undefined} t */
const tallyTokens = (t) => t
  ? (t.inputTokens || 0) + (t.outputTokens || 0)
    + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0)
  : 0;

// (The original always-visible CostMeter was removed — superseded by the
// CostChip below + the Logs/Context "Total usage" line. fmtUsd / tallyTokens
// are still used by CostChip.)

// CostChip — the per-chat usage surface. A single line of tiny muted text
// in the composer's action row: this chat's running dollar total, plus a
// live "+$…" delta while a turn streams. No button, no dropdown — the
// per-turn breakdown was more granularity than anyone wants here; the
// cumulative cross-session total lives in the Logs view.
export const CostChip = {
  /**
   * @param {{ attrs: {
   *   cost?: { session?: CostTally|null, turn?: CostTally|null, limitReached?: boolean } | null,
   *   streaming?: boolean,
   * } }} vnode
   */
  view: ({ attrs: { cost, streaming } }) => {
    const session = cost?.session ?? null;
    const turn = cost?.turn ?? null;
    const sessionCost = session?.cost ?? 0;
    const halted = !!cost?.limitReached;
    const turnTokens = tallyTokens(turn);
    return m(`span.cost-chip${halted ? '.cost-chip--halt' : ''}`, {
      role: 'status',
      'aria-live': 'polite',
      title: 'Usage for this chat',
      'aria-label': `This chat: ${fmtUsd(sessionCost)}`,
    }, [
      m('span.cost-chip-dollars', fmtUsd(sessionCost)),
      (turn && turnTokens > 0 && streaming)
        ? m('span.cost-chip-live', ` +${fmtUsd(turn.cost)}`)
        : null,
    ]);
  },
};
