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
import { mutationFailureCopy } from '../mutation-custody.js';

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
export const resetRow = (send, keys) => m(ResetRow, { send, keys });

// why a component: the row owns a confirm step, a busy flag and the outcome
// line. One click used to forget every key on the page with no question and
// no reply, so a failed reset looked exactly like a reset.
const ResetRow = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.confirm = false;
    vnode.state.refocus = false;
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.msg = null;
  },

  /** @param {{ attrs: { send: Send, keys: string[] }, state: any }} vnode */
  view({ attrs: { send, keys }, state: ui }) {
    const reset = async () => {
      if (ui.busy || ui.uncertain) return;
      ui.confirm = false; ui.refocus = true; ui.busy = true; ui.msg = null;
      try {
        let reply;
        try { reply = await send({ type: 'settings/reset', keys }); }
        catch { reply = { ok: false, outcomeKnown: false }; }
        ui.uncertain = reply?.outcomeKnown === false;
        ui.msg = reply?.ok
          ? { ok: true, text: 'Section reset to defaults.' }
          : { ok: false, text: mutationFailureCopy(reply, {
              action: 'resetting this section', fallback: 'The section could not be reset.',
            }) };
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    // why oncreate AND onupdate: Yes/No remove the focused button, so the
    // trigger claims focus back when it returns. After Yes it returns disabled
    // while the reset runs, and a disabled button cannot take focus, so it
    // takes it on the update that re-enables it.
    /** @param {{ dom: HTMLButtonElement }} v */
    const refocus = (v) => { if (ui.refocus && !v.dom.disabled) { ui.refocus = false; v.dom.focus(); } };

    return m('div', { style: 'margin-top:10px;' }, [
      // why Yes sits apart from the trigger: a repeat click on the same spot
      // must land on the question, never on the action.
      ui.confirm
        ? m('span', { style: 'display:inline-flex; align-items:center; gap:8px;' }, [
            m('span.muted', { style: 'font-size:12px;' }, 'Reset the settings on this page to their defaults?'),
            m('button.linkish.danger-text', { type: 'button', onclick: reset }, 'Yes'),
            m('button.linkish', {
              type: 'button',
              // why focus lands on No: the strip replaced the focused
              // trigger, and a stray Enter must cancel, never reset.
              oncreate: (/** @type {{ dom: HTMLButtonElement }} */ v) => v.dom.focus(),
              onclick: () => { ui.confirm = false; ui.refocus = true; },
            }, 'No'),
          ])
        : m('button.secondary', {
            type: 'button',
            style: 'font-size:12px;',
            disabled: ui.busy || ui.uncertain,
            oncreate: refocus,
            onupdate: refocus,
            onclick: () => { ui.confirm = true; },
          }, ui.busy ? 'Resetting…' : 'Reset section to defaults'),
      m('p.key-msg', {
        role: 'status',
        class: ui.msg ? (ui.msg.ok ? 'ok' : 'err') : '',
      }, ui.msg ? ui.msg.text : null),
    ]);
  },
};
