// @ts-check
// Context → Denylist tab — the user-editable origin ban list.
//
// The effective denylist = (seed − disabled) ∪ added (the SW owns that
// merge; this view never recomputes it). Provenance decides what
// "remove" honestly means:
//
//   - USER-ADDED patterns get a true delete — they're the user's own.
//   - SEED patterns can only be DISABLED — the user overlay can't
//     delete from the built-in seed. The control says "Disable", the
//     confirm carries a built-in tag, and a disabled pattern stays
//     visible in its own section with one-click re-enable (protection
//     that's been turned off is never invisible).
//
// Both paths arm an inline confirm first (hooks-view's confirmRemove
// pattern — the app-level ConfirmModal is wired to the SW confirmation
// coordinator for AGENT actions, not mountable for a local UI choice),
// and the confirm copy states the consequence ("peerd will be able to
// act on <pattern> again") before anything dispatches. Every mutation
// is audited by the SW (denylist_added / denylist_removed, seed flag).
//
// Like HooksView/SkillsView, the pane self-fetches over the SW routes:
// the SW is the source of truth, no optimistic local edits — mutations
// re-fetch. The search box is a client-side substring filter (a few
// hundred entries, no indexing) with an n-of-N count so a filtered
// list is visibly filtered.

import m from '/vendor/mithril/mithril.js';
import { denylistModel, removalCopy, groupDenylist } from './denylist-format.js';

/**
 * Component-local state for DenylistView.
 * @typedef {Object} DenylistState
 * @property {string[]|null} patterns   null = loading; the EFFECTIVE list
 * @property {string[]} added           user-added overlay
 * @property {string[]} disabled        seed patterns the user disabled
 * @property {string} draft             add-pattern input
 * @property {string} query            live search filter
 * @property {Record<string, string[]>} categories  the seed's own category map
 * @property {Set<string>} openGroups   category keys currently expanded
 * @property {{ ok: boolean, text: string }|null} note
 * @property {string|null} confirm      pattern with the armed remove/disable confirm
 * @property {boolean} confirmNeedsFocus  move focus to the verb on the NEXT strip mount only
 * @property {string|null} refocus      pattern whose arm button should regain focus after a disarm
 * @property {HTMLInputElement|null} searchEl
 * @property {boolean} busy
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: DenylistState, attrs: { send: Send, onChanged?: () => void } }} DenylistVnode */

export const DenylistView = {
  /** @param {DenylistVnode} vnode */
  oninit(vnode) {
    vnode.state.patterns = null;   // null = loading; the EFFECTIVE list
    vnode.state.added = [];        // user-added overlay
    vnode.state.disabled = [];     // seed patterns the user disabled
    vnode.state.draft = '';        // add-pattern input
    vnode.state.query = '';        // live search filter
    vnode.state.openGroups = new Set(['__user']);   // your own patterns open; the seed's categories collapsed
    vnode.state.note = null;       // { ok, text } action banner
    vnode.state.confirm = null;    // pattern with the armed remove/disable confirm
    vnode.state.confirmNeedsFocus = false;
    vnode.state.refocus = null;
    vnode.state.searchEl = null;
    vnode.state.busy = false;
    DenylistView.refresh(vnode);
  },

  /** @param {DenylistVnode} vnode */
  refresh(vnode) {
    vnode.attrs.send({ type: 'denylist/list' }).then((r) => {
      if (r?.ok) {
        vnode.state.patterns = r.patterns ?? [];
        vnode.state.added = r.added ?? [];
        vnode.state.disabled = r.disabled ?? [];
        // The seed's own taxonomy, read-only. Absent (old SW, failed seed fetch)
        // → {} → one ungrouped list, which is the pre-grouping rendering.
        vnode.state.categories = r.categories ?? {};
      } else {
        vnode.state.patterns = vnode.state.patterns ?? [];
        vnode.state.note = { ok: false, text: r?.error ?? 'failed to load denylist' };
      }
      m.redraw();
    }).catch((e) => {
      vnode.state.patterns = vnode.state.patterns ?? [];
      vnode.state.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load denylist' };
      m.redraw();
    });
  },

  // One mutation round-trip: send, banner the outcome, re-fetch on
  // success — and tell the parent, so the Context tab badge count
  // stays live without a full Context refresh.
  /**
   * @param {DenylistVnode} vnode
   * @param {object} msg
   * @param {string} okText
   */
  act(vnode, msg, okText) {
    const ui = vnode.state;
    if (ui.busy) return Promise.resolve(null);
    ui.busy = true; ui.note = null;
    return vnode.attrs.send(msg).then((r) => {
      ui.busy = false;
      ui.note = r?.ok
        ? { ok: true, text: okText }
        : { ok: false, text: r?.error === 'invalid-pattern'
            ? 'Not a valid pattern — use a hostname like chase.com or a glob like *.chase.com.'
            : r?.error ?? 'Action failed.' };
      if (r?.ok) {
        ui.confirm = null;
        DenylistView.refresh(vnode);
        vnode.attrs.onChanged?.();
      }
      m.redraw();
      return r;
    }).catch((e) => {
      ui.busy = false;
      ui.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'Action failed.' };
      m.redraw();
      return null;
    });
  },

  /** @param {DenylistVnode} vnode */
  view({ state: ui, attrs }) {
    const vnode = { state: ui, attrs };
    if (ui.patterns === null) return m('p.muted', 'Loading…');

    const model = denylistModel(
      { patterns: ui.patterns, added: ui.added, disabled: ui.disabled }, ui.query);

    return m('.denylist-pane', [
      m('p.muted', { style: 'font-size:12px; margin:0 0 8px;' },
        'Origins the agent will never touch — the built-in list plus your own '
        + 'patterns. Your patterns can be removed; built-in ones can only be '
        + 'disabled, and a disabled one stays visible below. Every change is audited.'),

      // Add form. Enter or the button both submit; the draft survives a
      // failed add so an invalid pattern can be fixed in place.
      m('form.denylist-add', {
        onsubmit: (/** @type {Event} */ e) => {
          e.preventDefault();
          if (!ui.draft.trim() || ui.busy) return;
          DenylistView.act(vnode,
            { type: 'denylist/add', pattern: ui.draft }, `Added ${ui.draft.trim()}.`)
            .then((r) => { if (r?.ok) { ui.draft = ''; m.redraw(); } });
        },
      }, [
        m('input.denylist-input', {
          type: 'text',
          placeholder: 'chase.com or *.chase.com',
          'aria-label': 'Add a denylist pattern',
          value: ui.draft,
          oninput: (/** @type {Event} */ e) => { ui.draft = /** @type {HTMLInputElement} */ (e.target).value; },
        }),
        m('button', { type: 'submit', disabled: ui.busy || !ui.draft.trim() }, 'Block'),
      ]),

      // Search — client-side substring filter across BOTH sections, with
      // an n-of-N count so a narrowed list never masquerades as the
      // whole thing.
      m('.denylist-search', [
        m('input.denylist-search-input', {
          type: 'search',
          placeholder: 'Search patterns…',
          'aria-label': 'Search denylist patterns',
          value: ui.query,
          oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => { ui.searchEl = v.dom; },
          onremove: () => { ui.searchEl = null; },
          oninput: (/** @type {Event} */ e) => {
            ui.query = /** @type {HTMLInputElement} */ (e.target).value;
            // why: a pending refocus is a one-shot claim for the chip that
            // replaced a disarmed strip - typing means the user moved on,
            // and a match resurfacing later must not yank focus from here.
            ui.refocus = null;
          },
        }),
        m('span.denylist-count',
          model.filtered
            ? `${model.shown} of ${model.total}`
            : `${model.total} pattern${model.total === 1 ? '' : 's'}`),
        model.filtered
          ? m('button.linkish', {
              'aria-label': 'Clear search',
              onclick: () => { ui.query = ''; },
            }, 'Clear')
          : null,
      ]),

      // why role=status: the banner announces the outcome of a mutation
      // (added / removed / re-enabled / refused) to assistive tech without
      // stealing focus. why ALWAYS mounted: a live region announces content
      // CHANGES inside a registered region - a node freshly inserted with its
      // text already present is announced unreliably (VoiceOver, some NVDA).
      // Empty it takes no space (.key-msg:empty zeroes the margin).
      m('p.key-msg', {
        role: 'status',
        class: ui.note ? (ui.note.ok ? 'ok' : 'err') : '',
      }, ui.note ? ui.note.text : null),

      // A search that matches nothing says so ONCE, at the top. The groups stay
      // listed underneath (a category that vanishes reads as "peerd does not
      // block this"), so without this line the page would show eight headings
      // and no statement that the search itself came up empty.
      model.filtered && model.shown === 0
        ? m('p.muted', 'No patterns match the search.')
        : null,

      model.active.length === 0 && !model.filtered && ui.disabled.length === 0
        ? m('p.muted', 'Denylist is empty.')
        : m('.denylist-groups', groupDenylist(model.active, ui.categories, ui.patterns ?? [])
          .map((g) => groupBlock(vnode, g))),

      // Disabled seed patterns — kept visible so protection that's been
      // turned off is never invisible. One click re-enables (no confirm:
      // turning protection back ON is the safe direction).
      ui.disabled.length > 0 ? m('.denylist-disabled', [
        m('p.muted', { style: 'font-size:12px; margin:10px 0 6px;' },
          'Disabled built-in patterns (not enforced):'),
        model.disabled.length === 0
          ? m('p.muted', 'No disabled patterns match the search.')
          : m('.denylist-grid', model.disabled.map((p) =>
              m('span.denylist-item-row', { key: p }, [
                m('code.denylist-item.is-disabled', { title: 'Built-in pattern, currently disabled' }, p),
                m('button.linkish', {
                  title: 'Re-enable this built-in pattern',
                  'aria-label': `Re-enable ${p}`,
                  disabled: ui.busy,
                  onclick: () => DenylistView.act(vnode,
                    { type: 'denylist/add', pattern: p }, `Re-enabled ${p}.`),
                }, 'Re-enable'),
              ]))),
      ]) : null,
    ]);
  },
};

// One category block. Collapsed it is a single line you can scan; expanded it
// shows its chips. why a group is never hidden when it has no search hits: a
// list that drops empty groups reads as "these protections don't exist", which
// is the opposite of the truth — it stays, dimmed, at `0 of N`.
/**
 * @param {DenylistVnode} vnode
 * @param {{ key: string, label: string, rows: { pattern: string, user: boolean }[], shown: number, total: number, user: boolean }} g
 */
const groupBlock = (vnode, g) => {
  const ui = vnode.state;
  // A search HIT opens its group on its own: hiding the match behind a click is
  // the one thing a filter must never do. The user's own toggle is untouched, so
  // clearing the search returns the page to how they left it.
  const open = ui.openGroups.has(g.key) || (ui.query.trim().length > 0 && g.shown > 0);
  const empty = g.shown === 0;
  // The fraction only means something while a search is narrowing the list;
  // unfiltered, "38 of 38" is noise where "38" is the fact. ("Your patterns"
  // has no seed total to be a fraction of, so it is always a plain count.)
  const count = (g.user || !ui.query.trim()) ? String(g.total) : `${g.shown} of ${g.total}`;
  const headId = `denylist-group-head-${g.key}`;
  const bodyId = `denylist-group-body-${g.key}`;
  const header = m('button.denylist-group-head', {
    type: 'button',
    id: headId,
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': bodyId,
    'aria-label': `${g.label}, ${count} patterns`,
    onclick: () => {
      if (ui.openGroups.has(g.key)) ui.openGroups.delete(g.key);
      else ui.openGroups.add(g.key);
      m.redraw();
    },
  }, [
    m('span.denylist-group-chev', { class: open ? 'is-open' : '', 'aria-hidden': 'true' }, '›'),
    m('span.denylist-group-label', g.label),
    m('span.denylist-group-count', count),
  ]);

  return m('.denylist-group', {
    key: g.key,
    class: `${open ? 'is-open' : ''} ${empty ? 'is-empty' : ''} ${g.user ? 'is-user' : ''}`.trim(),
  }, [
    header,
    open && g.rows.length > 0
      ? m('.denylist-group-body', {
          id: bodyId,
          role: 'group',
          'aria-labelledby': headId,
        }, g.rows.map(({ pattern: p, user }) =>
        ui.confirm === p ? confirmStrip(vnode, p, user) : patternChip(vnode, p, user)))
      : null,
    // why the id here too: an expanded-but-empty group renders this line as
    // its whole body, and the header's aria-controls must resolve to it.
    open && g.rows.length === 0
      ? m('p.muted.denylist-group-empty', { id: bodyId }, ui.query.trim()
        ? 'No patterns in this group match the search.'
        : 'Every pattern in this group is currently disabled.')
      : null,
  ]);
};

// One enforced pattern chip with its remove/disable arm button. The
// button label/verb tracks provenance so a seed row never pretends to
// offer a delete it can't perform.
/**
 * @param {DenylistVnode} vnode
 * @param {string} p
 * @param {boolean} user
 */
const patternChip = (vnode, p, user) => {
  const ui = vnode.state;
  // why the refocus dance: a disarm (Escape / ✕) destroys the focused verb
  // button, which would drop keyboard focus to <body>. The chip that replaces
  // the strip claims focus back onto the arm button it grew from.
  const takeFocus = (/** @type {{ dom: HTMLButtonElement }} */ v) => {
    if (ui.refocus === p) { ui.refocus = null; v.dom.focus(); }
  };
  return m('span.denylist-item-row', { key: p }, [
    m(`code.denylist-item${user ? '.is-user' : ''}`,
      { title: user ? 'Added by you' : 'Built-in seed pattern' }, p),
    m('button.linkish.denylist-x', {
      'aria-label': `${user ? 'Remove' : 'Disable'} ${p}`,
      title: user ? 'Remove this pattern' : 'Disable this built-in pattern (reversible)',
      disabled: ui.busy,
      oncreate: takeFocus,
      onupdate: takeFocus,
      onclick: () => { ui.confirm = p; ui.confirmNeedsFocus = true; },
    }, '×'),
  ]);
};

// The armed confirm: takes the full row width so the consequence copy
// is readable, names the provenance, and only then offers the verb.
// Nothing dispatches until the verb button is clicked; ✕ disarms.
/**
 * @param {DenylistVnode} vnode
 * @param {string} p
 * @param {boolean} user
 */
const confirmStrip = (vnode, p, user) => {
  const ui = vnode.state;
  const { verb, consequence } = removalCopy(p, user);
  return m('span.denylist-item-row.is-arming', {
    key: p,
    // why Escape here (not per button): cancel must work wherever focus
    // sits inside the armed strip, and keydown bubbles to the row. The
    // event keeps bubbling - nothing above this pane handles Escape, and
    // silently eating a key an ancestor may someday want is how document-
    // level directives get shadowed by accident.
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape') { ui.confirm = null; ui.refocus = p; }
    },
  }, [
    m(`code.denylist-item${user ? '.is-user' : ''}`, p),
    m('span.denylist-badge',
      { title: user ? 'A pattern you added' : 'Ships with peerd — can be disabled, not deleted' },
      user ? 'user' : 'built-in'),
    m('span.denylist-consequence', consequence),
    m('button.linkish.danger-text', {
      disabled: ui.busy,
      // why the name carries the pattern: the visible label is just
      // "Remove?" - a screen reader landing here must hear WHAT it removes.
      'aria-label': `${verb} ${p}`,
      // why focus on arm - and ONLY on arm: the confirm replaces the chip
      // the user just clicked, so focus would otherwise be left on a removed
      // node. But this strip also re-mounts on unrelated redraws (group
      // collapse/expand, a search narrowing past it and back) while
      // ui.confirm survives - a re-mount must never steal focus, so the
      // one-shot flag is consumed on the first mount after arming.
      oncreate: (/** @type {{ dom: HTMLButtonElement }} */ v) => {
        if (ui.confirmNeedsFocus) { ui.confirmNeedsFocus = false; v.dom.focus(); }
      },
      // why refocus search on success: the strip (and for a removal, the
      // chip itself) is gone once the mutation lands - the search box is
      // the pane's one stable control for focus to land on.
      onclick: () => DenylistView.act(vnode, { type: 'denylist/remove', pattern: p },
        user ? `Removed ${p}.` : `Disabled ${p} - re-enable it below.`)
        .then((r) => { if (r?.ok) ui.searchEl?.focus(); }),
    }, `${verb}?`),
    m('button.linkish', {
      'aria-label': 'Cancel',
      onclick: () => { ui.confirm = null; ui.refocus = p; },
    }, '✕'),
  ]);
};
