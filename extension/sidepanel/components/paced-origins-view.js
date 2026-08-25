// @ts-check
// Settings → Paced sites: the sites peerd has slowed itself down on, and the
// only place a rule can be forgotten.
//
// why its own nav entry rather than a block under Learned sites: the two answer
// different questions. Learned sites is "which sites does peerd treat as
// YOURS"; this is "which sites asked peerd to go slower". A user watching a turn
// crawl is looking for this page, and burying it under a page about session
// custody would hide it from exactly that search.
//
// The distinction the copy has to carry: a rule here is peerd being polite, not
// peerd being blocked. Forgetting one does not unlock anything - it only lets
// peerd go back to full speed and, if the site still minds, learn the same rule
// again on the next refusal. That matters because forgetting is the ONE
// direction an injected page would want, and the reason it is safe here is that
// the caller is a person on a settings page rather than anything the agent can
// reach.
//
// Follows LearnedOriginsView's shape deliberately (self-fetch over the SW route,
// no optimistic edits, an armed inline confirm before anything destructive, the
// same `p.key-msg` outcome banner) so the security pages behave alike.

import m from '/vendor/mithril/mithril.js';

/**
 * Human-readable duration. Presentation only, which is why it lives here rather
 * than in the policy core: nothing about a decision depends on how it reads.
 * @param {number} ms
 */
export const formatPaceDuration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return 'no delay';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
};

/**
 * Milliseconds left on a pause the site stated, or 0 when none is running.
 * @param {PacedRow} row @param {number} now
 */
const pending = (row, now) => Math.max(0, (row.notBeforeMs || 0) - now);

/** How a rule's source reads to a person. */
const SOURCE_COPY = {
  'retry-after-seconds': 'the site stated how long to wait',
  'retry-after-date': 'the site stated a time to come back',
  'status-backoff': 'the site refused a request as too frequent',
  none: 'peerd measured the rate that got refused',
};

/**
 * @typedef {Object} PacedRow
 * @property {string} origin
 * @property {number} minIntervalMs
 * @property {number} notBeforeMs
 * @property {string} notBeforeSource
 * @property {number} observations
 */

/**
 * @typedef {Object} PacedState
 * @property {PacedRow[]|null} origins   null = loading
 * @property {{ ok: boolean, text: string }|null} note
 * @property {boolean} degraded          the durable read failed; writes fail closed
 * @property {string|null} confirm       origin with an armed forget confirm
 * @property {boolean} confirmAll
 * @property {boolean} busy
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: PacedState, attrs: { send: Send } }} PacedVnode */

/** Restore keyboard focus after Mithril has replaced an inline control. */
const focusAfterRender = (/** @type {'heading'|'trigger'|'confirm'|'trigger-all'|'confirm-all'} */ role, /** @type {string|null} */ origin = null) => {
  requestAnimationFrame(() => {
    const controls = [...document.querySelectorAll(`.paced-sites [data-paced-role="${role}"]`)];
    const target = origin
      ? controls.find((element) => /** @type {HTMLElement} */ (element).dataset.pacedOrigin === origin)
      : controls[0];
    /** @type {HTMLElement | undefined} */ (target)?.focus();
  });
};

export const PacedOriginsView = {
  /** @param {PacedVnode} vnode */
  oninit(vnode) {
    vnode.state.origins = null;
    vnode.state.note = null;
    vnode.state.degraded = false;
    vnode.state.confirm = null;
    vnode.state.confirmAll = false;
    vnode.state.busy = false;
    PacedOriginsView.refresh(vnode);
  },

  /** @param {PacedVnode} vnode */
  refresh(vnode) {
    return vnode.attrs.send({ type: 'paced/list' }).then((r) => {
      vnode.state.origins = r?.ok ? (r.origins ?? []) : (vnode.state.origins ?? []);
      vnode.state.degraded = r?.ok ? (r.state?.ok === false) : vnode.state.degraded;
      if (!r?.ok) vnode.state.note = { ok: false, text: r?.error ?? 'failed to load paced sites' };
      m.redraw();
    }).catch((e) => {
      vnode.state.origins = vnode.state.origins ?? [];
      vnode.state.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load paced sites' };
      m.redraw();
    });
  },

  /**
   * One mutation round-trip: send, banner the outcome, re-fetch.
   * @param {PacedVnode} vnode
   * @param {{ type: string, origin?: string }} msg
   * @param {string | ((reply: any) => string)} okText
   */
  act(vnode, msg, okText) {
    const ui = vnode.state;
    if (ui.busy) return Promise.resolve(null);
    ui.busy = true; ui.note = null; m.redraw();
    return vnode.attrs.send(msg).then(async (r) => {
      ui.busy = false;
      // `not-paced` means THIS VIEW IS STALE - the rule decayed out, or another
      // surface already forgot it. Re-fetch on that path too, or the phantom row
      // stays on screen with its confirm armed under a message saying it is gone.
      const stale = r?.error === 'not-paced';
      ui.note = r?.ok
        ? { ok: true, text: typeof okText === 'function' ? okText(r) : okText }
        : { ok: false, text: stale
          ? 'That site was already back at full speed. Refreshed the list.'
          : r?.error ?? 'Action failed.' };
      if (r?.ok || stale) {
        ui.confirm = null;
        ui.confirmAll = false;
        await PacedOriginsView.refresh(vnode);
      }
      m.redraw();
      if (r?.ok) focusAfterRender('heading');
      else if (stale) focusAfterRender(ui.origins?.length ? 'trigger' : 'heading');
      else focusAfterRender(msg.type === 'paced/clear' ? 'confirm-all' : 'confirm', /** @type {any} */ (msg).origin ?? null);
      return r;
    }).catch((e) => {
      ui.busy = false;
      ui.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'Action failed.' };
      m.redraw();
      focusAfterRender(msg.type === 'paced/clear' ? 'confirm-all' : 'confirm', /** @type {any} */ (msg).origin ?? null);
      return null;
    });
  },

  /** @param {PacedVnode} vnode */
  view({ state: ui, attrs }) {
    const vnode = { state: ui, attrs };
    const rows = ui.origins;
    const now = Date.now();

    return m('div.paced-sites', [
      m('h3', { tabindex: -1, 'data-paced-role': 'heading' }, 'Sites peerd is going slower on'),
      m('p', 'When a site answers that peerd is asking too often, peerd records the '
        + 'pause that site asked for and waits it out before acting there again. '
        + 'peerd never tries to disguise itself or work around a site’s limits.'),
      m('p.hint', 'A rule fades on its own after the site stops refusing. '
        + 'Forget one here to go back to full speed immediately. If the site still '
        + 'minds, peerd will learn the same rule again the next time it is refused.'),

      // The durable read failed. Say so plainly: an empty list and a broken list
      // look identical, and only one of them explains why an action just refused.
      ui.degraded
        ? m('p.key-msg.err', { role: 'alert' },
          'peerd could not read its pacing record, so it is refusing browser actions '
          + 'rather than risk acting inside a pause a site asked for. Start a fresh '
          + 'record below to clear that state.')
        : null,

      ui.note ? m(`p.key-msg${ui.note.ok ? '.ok' : '.err'}`, {
        role: ui.note.ok ? 'status' : 'alert',
        'aria-live': ui.note.ok ? 'polite' : 'assertive',
      }, ui.note.text) : null,

      rows === null
        ? m('p.muted', 'Loading…')
        : rows.length === 0 && !ui.degraded
          ? m('p.muted', 'No site has asked peerd to slow down.')
          : m('div', [
            // why no keys on the rows: keyed and unkeyed siblings cannot be
            // mixed, and the list is re-fetched wholesale after every mutation,
            // so keys would buy nothing. Same call as LearnedOriginsView.
            m('div', rows.map((row) => m('div', {
              style: 'display:flex; align-items:center; gap:8px; padding:6px 0; flex-wrap:wrap;',
            }, [
              m('span', { style: 'flex:1; min-width:220px;' }, [
                m('code', row.origin),
                m('span.hint', { style: 'display:block;' }, [
                  row.minIntervalMs > 0
                    ? `waiting ${formatPaceDuration(row.minIntervalMs)} between actions`
                    : 'waiting only for the pause the site asked for',
                  ' · ',
                  SOURCE_COPY[/** @type {keyof SOURCE_COPY} */ (row.notBeforeSource)] ?? row.notBeforeSource,
                ]),
                // A pause that is still running is the reason peerd is refusing
                // this site RIGHT NOW. Without it the row explains a rule while
                // the user is asking about a refusal they just saw.
                pending(row, now)
                  ? m('span.hint', { style: 'display:block;' },
                    `paused for another ${formatPaceDuration(pending(row, now))}`)
                  : null,
              ]),
              ui.confirm === row.origin
                ? m('span', { style: 'display:flex; gap:6px; align-items:center;' }, [
                  m('span.hint', 'Go back to full speed on this site?'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    'data-paced-role': 'confirm',
                    'data-paced-origin': row.origin,
                    'aria-label': `Confirm forgetting the pacing rule for ${row.origin}`,
                    onclick: () => PacedOriginsView.act(
                      vnode, { type: 'paced/forget', origin: row.origin }, `Forgot the rule for ${row.origin}.`,
                    ),
                  }, ui.busy ? '…' : 'Forget'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    'aria-label': `Keep the pacing rule for ${row.origin}`,
                    onclick: () => {
                      ui.confirm = null; m.redraw();
                      focusAfterRender('trigger', row.origin);
                    },
                  }, 'Keep'),
                ])
                : m('button.secondary', {
                  type: 'button',
                  disabled: ui.busy,
                  'data-paced-role': 'trigger',
                  'data-paced-origin': row.origin,
                  'aria-label': `Forget the pacing rule for ${row.origin}`,
                  onclick: () => {
                    ui.confirm = row.origin; ui.note = null; m.redraw();
                    focusAfterRender('confirm', row.origin);
                  },
                }, 'Forget'),
            ]))),
            m('div', { style: 'margin-top:12px;' }, [
              ui.confirmAll
                ? m('span', { style: 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;' }, [
                  m('span.hint', rows.length
                    ? `Forget all ${rows.length} pacing rules?`
                    : 'Start a fresh pacing record?'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    'data-paced-role': 'confirm-all',
                    'aria-label': 'Confirm forgetting all pacing rules',
                    onclick: () => PacedOriginsView.act(
                      vnode, { type: 'paced/clear' },
                      (r) => `Forgot ${r?.forgotten ?? 0} pacing ${(r?.forgotten === 1) ? 'rule' : 'rules'}.`,
                    ),
                  }, ui.busy ? '…' : 'Forget all'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    onclick: () => {
                      ui.confirmAll = false; m.redraw();
                      focusAfterRender('trigger-all');
                    },
                  }, 'Cancel'),
                ])
                : m('button.secondary', {
                  type: 'button',
                  disabled: ui.busy,
                  'data-paced-role': 'trigger-all',
                  onclick: () => {
                    ui.confirmAll = true; ui.note = null; m.redraw();
                    focusAfterRender('confirm-all');
                  },
                }, rows.length ? 'Forget all' : 'Start a fresh record'),
            ]),
          ]),
    ]);
  },
};
