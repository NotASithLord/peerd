// @ts-check
// "Reset section to defaults" — shared per-page affordance.
//
// Forgets the STORED values for the page's keys so the channel defaults
// (CHANNEL_DEFAULTS) apply again — and keep applying across upgrades. This
// is the one sanctioned way to pick up new defaults; upgrades never
// silently change a setting you've touched.
//
// why the key lists live at each call site: a page's reset must touch
// ONLY the keys that page owns. The old panel groupings bundled
// spendLimitUsd/autoMemoryEnabled into "Agent behavior" and
// pricingOverrides into "Advanced"; those keys moved pages in the
// options IA (Costs, Memory) and their reset rows moved with them — a
// Costs reset must never flip Behavior toggles.

import m from '/vendor/mithril/mithril.js';

/**
 * The one-shot message sender these settings pages thread down from
 * options.js. Reply shapes are per-route (~80 of them) — `any` mirrors
 * shared/messaging.js's own send contract.
 * @typedef {(msg: { type: string } & Record<string, any>) => Promise<any>} Send
 */

/**
 * @param {Send} send
 * @param {string[]} keys
 */
export const resetRow = (send, keys) => m('div', { style: 'margin-top:10px;' }, [
  m('button.secondary', {
    type: 'button',
    style: 'font-size:12px;',
    onclick: async () => {
      await send({ type: 'settings/reset', keys });
      m.redraw();
    },
  }, 'Reset section to defaults'),
]);
