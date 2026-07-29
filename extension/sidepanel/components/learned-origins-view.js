// @ts-check
// Settings → Learned sites — the origins peerd LEARNED the user has an account
// on, and the only place one can be un-learned.
//
// why its own nav entry, next to the denylist rather than inside it: the two are
// opposites worth reading together (the denylist is sites the user BANNED peerd
// from; this is sites peerd decided are theirs), but the denylist page is ~164
// seed patterns tall — appending to it put this below the fold, and an un-learn
// control the user cannot find is the exact problem this view exists to fix.
//
// The distinction the copy has to carry: un-learning does NOT make a site
// unprotected in general. A learned origin is a guess; the curated shared-doc
// list and a stored credential are not, and those two keep protecting a site
// whatever this list says. Otherwise a user would "clear" a row and reasonably
// expect roaming access to a site that still refuses one.
//
// Follows DenylistView's shape deliberately (self-fetch over the SW route, no
// optimistic edits, an armed inline confirm before anything destructive, the
// same `p.key-msg` outcome banner) so the two security pages behave alike.

import m from '/vendor/mithril/mithril.js';

/** How a learned reason reads to a person. */
const REASON_COPY = {
  'password-field': 'a sign-in form was on a page peerd read',
  'confirmed-write': 'you approved peerd sending data to it',
};

/**
 * @typedef {Object} LearnedState
 * @property {Array<{ origin: string, reason: string }>|null} origins  null = loading
 * @property {{ ok: boolean, text: string }|null} note
 * @property {string|null} confirm    origin with an armed forget confirm
 * @property {boolean} confirmAll     the clear-everything confirm is armed
 * @property {boolean} busy
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: LearnedState, attrs: { send: Send } }} LearnedVnode */

export const LearnedOriginsView = {
  /** @param {LearnedVnode} vnode */
  oninit(vnode) {
    vnode.state.origins = null;
    vnode.state.note = null;
    vnode.state.confirm = null;
    vnode.state.confirmAll = false;
    vnode.state.busy = false;
    LearnedOriginsView.refresh(vnode);
  },

  /** @param {LearnedVnode} vnode */
  refresh(vnode) {
    vnode.attrs.send({ type: 'learned/list' }).then((r) => {
      vnode.state.origins = r?.ok ? (r.origins ?? []) : (vnode.state.origins ?? []);
      if (!r?.ok) vnode.state.note = { ok: false, text: r?.error ?? 'failed to load learned sites' };
      m.redraw();
    }).catch((e) => {
      vnode.state.origins = vnode.state.origins ?? [];
      vnode.state.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load learned sites' };
      m.redraw();
    });
  },

  /**
   * One mutation round-trip: send, banner the outcome, re-fetch.
   * @param {LearnedVnode} vnode
   * @param {object} msg
   * @param {string | ((reply: any) => string)} okText  a function when the copy
   *   depends on the reply (Forget all reports how many it actually forgot).
   */
  act(vnode, msg, okText) {
    const ui = vnode.state;
    if (ui.busy) return Promise.resolve(null);
    ui.busy = true; ui.note = null; m.redraw();
    return vnode.attrs.send(msg).then((r) => {
      ui.busy = false;
      // `not-learned` means THIS VIEW IS STALE — another tab, or the panel, already
      // removed the row. So it re-fetches like the success path does: an earlier
      // draft said "reloading" while refreshing only on success, which left the
      // phantom row on screen with its confirm still armed underneath a message
      // saying the row was gone.
      const stale = r?.error === 'not-learned';
      ui.note = r?.ok
        ? { ok: true, text: typeof okText === 'function' ? okText(r) : okText }
        : { ok: false, text: stale
          ? 'That site was already removed somewhere else — refreshed the list.'
          : r?.error ?? 'Action failed.' };
      if (r?.ok || stale) { ui.confirm = null; ui.confirmAll = false; LearnedOriginsView.refresh(vnode); }
      m.redraw();
      return r;
    }).catch((e) => {
      ui.busy = false;
      ui.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'Action failed.' };
      m.redraw();
      return null;
    });
  },

  /** @param {LearnedVnode} vnode */
  view({ state: ui, attrs }) {
    const vnode = { state: ui, attrs };
    const rows = ui.origins;

    return m('div', [
      m('h3', 'Sites peerd thinks you have an account on'),
      m('p', 'peerd learns these from ordinary use, and a helper that browses the '
        + 'open web is not allowed onto them - it hands the work to a helper bound to '
        + 'that one site instead. Remove a site here if the guess was wrong.'),
      m('p.hint', 'Removing a site does not make it unprotected: a site on peerd’s '
        + 'built-in shared-document list, or one you have stored a key for, stays '
        + 'protected either way. peerd can also learn the same site again next time '
        + 'it reads a sign-in form there.'),

      // `p.key-msg.ok` / `.err` — the same banner DenylistView and HooksView use.
      // (A bare `.ok` has no rule in either stylesheet this page links, so the
      // success case rendered as ordinary body text, indistinguishable from the
      // explanatory copy above it.)
      ui.note ? m(`p.key-msg${ui.note.ok ? '.ok' : '.err'}`, ui.note.text) : null,

      rows === null
        ? m('p.muted', 'Loading…')
        : rows.length === 0
          ? m('p.muted', 'Nothing learned yet.')
          : m('div', [
            // The rows get their OWN container so this outer array stays a
            // constant two children (list, then the Forget-all block) while the
            // list length changes underneath.
            //
            // why no keys on the rows: keyed and unkeyed siblings cannot be
            // mixed — Mithril throws on the mix, and during development that
            // threw mid-redraw and stranded the whole block on "Loading…" while
            // the SW already held two learned origins. The list is re-fetched
            // wholesale after every mutation, so keys would buy nothing here.
            m('div', rows.map(({ origin, reason }) => m('div', {
              style: 'display:flex; align-items:center; gap:8px; padding:6px 0; flex-wrap:wrap;',
            }, [
              m('span', { style: 'flex:1; min-width:220px;' }, [
                m('code', origin),
                m('span.hint', { style: 'display:block;' },
                  REASON_COPY[/** @type {keyof REASON_COPY} */ (reason)] ?? reason),
              ]),
              ui.confirm === origin
                ? m('span', { style: 'display:flex; gap:6px; align-items:center;' }, [
                  m('span.hint', 'Stop treating this as yours?'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    onclick: () => LearnedOriginsView.act(
                      vnode, { type: 'learned/forget', origin }, `Removed ${origin}.`,
                    ),
                  }, ui.busy ? '…' : 'Remove'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    onclick: () => { ui.confirm = null; m.redraw(); },
                  }, 'Keep'),
                ])
                : m('button.secondary', {
                  type: 'button',
                  disabled: ui.busy,
                  onclick: () => { ui.confirm = origin; ui.note = null; m.redraw(); },
                }, 'Remove'),
            ]))),
            m('div', { style: 'margin-top:12px;' }, [
              ui.confirmAll
                ? m('span', { style: 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;' }, [
                  m('span.hint', `Forget all ${rows.length} learned sites?`),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    onclick: () => LearnedOriginsView.act(
                      vnode, { type: 'learned/clear' },
                      // Report what it actually forgot: "cleared" alone cannot be
                      // told apart from a clear that found nothing to do.
                      (r) => `Forgot ${r?.forgotten ?? 0} learned ${(r?.forgotten === 1) ? 'site' : 'sites'}.`,
                    ),
                  }, ui.busy ? '…' : 'Forget all'),
                  m('button.secondary', {
                    type: 'button',
                    disabled: ui.busy,
                    onclick: () => { ui.confirmAll = false; m.redraw(); },
                  }, 'Cancel'),
                ])
                : m('button.secondary', {
                  type: 'button',
                  disabled: ui.busy,
                  onclick: () => { ui.confirmAll = true; ui.note = null; m.redraw(); },
                }, 'Forget all'),
            ]),
          ]),
    ]);
  },
};
