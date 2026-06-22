// @ts-check
// Hooks view — the Context tab over the pre/post tool-use hook registry.
//
// Surface for feature 10's policy chokepoint: every tool call flows
// through the hook runner, so WHICH hooks exist and whether they're on
// is security-relevant state the user could previously only infer from
// the audit trail. This tab lists the merged population the dispatcher
// actually consumes (built-in code hooks + user config hooks), with
// provenance made explicit:
//
//   - BUILT-IN hooks are trusted in-tree code registered at boot. They
//     cannot be disabled or removed from config — the egress-allowlist
//     pre-hook is the always-on floor of the lethal-trifecta defense,
//     and a UI switch that could turn it off would be a security hole,
//     not a feature. The row says "always on" and shows the reason
//     instead of hiding the missing control.
//   - USER hooks are serializable records the user authored. They can
//     be toggled and removed here; every mutation is audited by the SW
//     (same discipline as denylist edits).
//
// Like SkillsView (the pattern this tab follows), the view is a pure
// projection of its own fetched list — hooks aren't on the global
// pushState payload (no reason to ship the registry on every state
// tick). It re-fetches after every mutation; the SW is the source of
// truth, no optimistic local edits.

import m from '/vendor/mithril/mithril.js';

/**
 * One hook record from `hooks/list`.
 * @typedef {Object} HookRecord
 * @property {string} id
 * @property {'pre-tool-use'|'post-tool-use'|string} event
 * @property {number} [order]
 * @property {boolean} enabled
 * @property {boolean} isDefault
 * @property {string} [kind]
 * @property {string} [match]
 * @property {string} [doc]
 */

/**
 * Component-local state for HooksView.
 * @typedef {Object} HooksState
 * @property {HookRecord[]|null} hooks
 * @property {{ ok: boolean, text: string }|null} note
 * @property {string|null} confirmRemove   hook id pending the remove confirm
 * @property {boolean} addOpen
 * @property {string} addText
 * @property {boolean} busy
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: HooksState, attrs: { send: Send } }} HooksVnode */

// Stable, human-sensible order: pre-hooks before post-hooks (mirroring
// when they fire around a tool call), then the runner's own ordering
// (order asc, id) so the list reads as "what runs, in what sequence".
/** @param {HookRecord[]} hooks */
export const orderHooks = (hooks) => [...hooks].sort((a, b) =>
  (a.event === b.event ? 0 : a.event === 'pre-tool-use' ? -1 : 1)
  || (a.order ?? 100) - (b.order ?? 100)
  || String(a.id).localeCompare(String(b.id)));

// Authoring placeholder — the declarative (no-code) shape from
// peerd-runtime/tools/hooks/compile.js, which works under any CSP.
const ADD_PLACEHOLDER = [
  '---',
  'id: block-typed-secrets',
  'event: pre-tool-use',
  'match: type',
  'rule:',
  '  matchArg: text',
  '  pattern: sk-[a-zA-Z0-9]{20,}',
  '  reason: looks like an API key',
  '---',
  'Block the type tool from typing anything that looks like a secret.',
].join('\n');

export const HooksView = {
  /** @param {HooksVnode} vnode */
  oninit(vnode) {
    vnode.state.hooks = null;         // null = loading; [] = none
    vnode.state.note = null;          // { ok, text } action banner
    vnode.state.confirmRemove = null; // hook id pending the remove confirm
    vnode.state.addOpen = false;
    vnode.state.addText = '';
    vnode.state.busy = false;
    HooksView.refresh(vnode);
  },

  /** @param {HooksVnode} vnode */
  refresh(vnode) {
    vnode.attrs.send({ type: 'hooks/list' }).then((r) => {
      vnode.state.hooks = r?.ok ? orderHooks(r.hooks) : [];
      if (!r?.ok) vnode.state.note = { ok: false, text: r?.error ?? 'failed to load hooks' };
      m.redraw();
    }).catch((e) => {
      vnode.state.hooks = [];
      vnode.state.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load hooks' };
      m.redraw();
    });
  },

  // One mutation round-trip: send, banner the outcome, re-fetch on
  // success. Returns the response so callers (the add form) can chain.
  /**
   * @param {HooksVnode} vnode
   * @param {object} msg
   * @param {string} okText
   */
  act(vnode, msg, okText) {
    const ui = vnode.state;
    if (ui.busy) return Promise.resolve(null);
    ui.busy = true; ui.note = null;
    return vnode.attrs.send(msg).then((r) => {
      ui.busy = false;
      ui.note = r?.ok ? { ok: true, text: okText } : { ok: false, text: r?.error ?? 'Action failed.' };
      if (r?.ok) { ui.confirmRemove = null; HooksView.refresh(vnode); }
      m.redraw();
      return r;
    }).catch((e) => {
      ui.busy = false;
      ui.note = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'Action failed.' };
      m.redraw();
      return null;
    });
  },

  /** @param {HooksVnode} vnode */
  view({ state: ui, attrs }) {
    const vnode = { state: ui, attrs };
    const hooks = ui.hooks;

    return m('.hooks-pane', [
      m('p.muted', { style: 'font-size:12px; margin:0 0 8px;' },
        'Policy hooks run around every tool call — a pre hook can block or '
        + 'rewrite it, a post hook observes the result. Built-in hooks are '
        + 'code and always on (the egress allowlist is the safety floor); '
        + 'your own hooks can be toggled or removed. Every change is audited.'),

      m('.hooks-actions', [
        m('button.secondary', {
          onclick: () => { ui.addOpen = !ui.addOpen; ui.note = null; },
        }, ui.addOpen ? 'Cancel' : 'Add hook…'),
        m('.spacer'),
      ]),

      ui.addOpen ? m('form.hook-add', {
        onsubmit: (/** @type {Event} */ e) => {
          e.preventDefault();
          if (!ui.addText.trim() || ui.busy) return;
          HooksView.act(vnode, { type: 'hooks/save', markdown: ui.addText }, 'Hook saved.')
            .then((r) => {
              if (r?.ok) { ui.addOpen = false; ui.addText = ''; m.redraw(); }
            });
        },
      }, [
        m('textarea.hook-add-editor', {
          rows: 10,
          spellcheck: false,
          placeholder: ADD_PLACEHOLDER,
          'aria-label': 'Hook markdown',
          value: ui.addText,
          oninput: (/** @type {Event} */ e) => { ui.addText = /** @type {HTMLTextAreaElement} */ (e.target).value; },
        }),
        m('p.muted', { style: 'font-size:11px; margin:0;' },
          'Markdown with frontmatter (id, event, match, an optional declarative '
          + 'rule block) — the .peerd/hooks/*.md format. Compile errors surface here.'),
        m('button', { type: 'submit', disabled: ui.busy || !ui.addText.trim() },
          ui.busy ? 'Saving…' : 'Save hook'),
      ]) : null,

      ui.note ? m(`p.key-msg${ui.note.ok ? '.ok' : '.err'}`, ui.note.text) : null,

      hooks === null
        ? m('p.muted', 'Loading…')
        : hooks.length === 0
          ? m('p.muted', 'No hooks registered.')
          : m('.hook-list', hooks.map((h) => hookRow(vnode, h))),
    ]);
  },
};

/**
 * @param {HooksVnode} vnode
 * @param {HookRecord} h
 */
const hookRow = (vnode, h) => {
  const ui = vnode.state;
  return m('.hook-row', { key: h.id, class: h.enabled ? '' : 'is-off' }, [
    m('.hook-main', [
      m('.hook-line', [
        m('code.hook-name', h.id),
        m('span.hook-badge.hook-phase',
          { title: h.event === 'pre-tool-use'
              ? 'Runs before the tool executes — may block or rewrite the call'
              : 'Runs after the tool executes — observe-only' },
          h.event === 'pre-tool-use' ? 'pre' : 'post'),
        m('span.hook-badge', { title: h.isDefault
            ? 'Built-in: trusted in-tree code, registered at boot'
            : `Your config (${h.kind})` },
          h.isDefault ? 'built-in' : 'user'),
        m('code.hook-match', { title: 'Tool-name match' }, h.match ?? '*'),
      ]),
      h.doc ? m('p.hook-doc', h.doc) : null,
    ]),
    m('.hook-controls', h.isDefault
      // Built-ins: visibly NOT disableable. The doc line above carries
      // the per-hook reason; the title repeats it on the control itself.
      ? m('span.hook-lock', {
          title: `Built-in code hook — not user config. ${h.id === 'egress-allowlist'
              ? 'The egress allowlist is the always-on safety floor; it has no off switch.'
              : 'It cannot be disabled or removed here.'}`,
        }, 'always on')
      : [
          m('label.hook-toggle', [
            m('input', {
              type: 'checkbox',
              checked: h.enabled,
              disabled: ui.busy,
              'aria-label': `Enable ${h.id}`,
              onchange: (/** @type {Event} */ e) => HooksView.act(vnode,
                { type: 'hooks/toggle', id: h.id, enabled: /** @type {HTMLInputElement} */ (e.target).checked },
                `${/** @type {HTMLInputElement} */ (e.target).checked ? 'Enabled' : 'Disabled'} ${h.id}.`),
            }),
            h.enabled ? 'on' : 'off',
          ]),
          ui.confirmRemove === h.id
            ? m('span.hook-confirm', [
                m('button.linkish.danger-text', {
                  disabled: ui.busy,
                  onclick: () => HooksView.act(vnode,
                    { type: 'hooks/remove', id: h.id }, `Removed ${h.id}.`),
                }, 'Remove?'),
                m('button.linkish', {
                  'aria-label': 'Cancel remove',
                  onclick: () => { ui.confirmRemove = null; },
                }, '✕'),
              ])
            : m('button.linkish.hook-x', {
                'aria-label': `Remove ${h.id}`,
                title: 'Remove this hook',
                disabled: ui.busy,
                onclick: () => { ui.confirmRemove = h.id; },
              }, '×'),
        ]),
  ]);
};
