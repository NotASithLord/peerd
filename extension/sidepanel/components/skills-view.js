// @ts-check
// Skills view — list / install / remove progressive-disclosure skills.
//
// Minimal management surface for feature 07. Local install pastes a
// SKILL.md directly. The remote sources (git URL, static manifest URL)
// are gated behind REMOTE_SKILL_INSTALL (off for store V1 — see
// docs/store/OPEN-DECISIONS.md); when off, only the paste source shows
// and the tab bar is hidden. The list shows each installed skill's name,
// one-line description, source badge, size, and an enable toggle + remove
// button — including skills installed earlier from a remote source, which
// keep working.
//
// The view is a pure projection of its own fetched state (the installed
// list) + ephemeral form state. It pulls the list via the explicit
// `skills/list` message on mount and after every mutation — skills aren't
// on the global pushState payload (no reason to ship metas on every state
// tick). a11y: real <button>/<label> elements, aria-live on the status
// line; no animation, so prefers-reduced-motion is moot here.

import m from '/vendor/mithril/mithril.js';
import { REMOTE_SKILL_INSTALL } from '/shared/flags.js';

/**
 * One installed skill's metadata from `skills/list`.
 * @typedef {Object} SkillMeta
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} source
 * @property {string} [version]
 * @property {boolean} enabled
 * @property {number} sizeBytes
 * @property {string} [origin]
 */

/**
 * Component-local state for SkillsView.
 * @typedef {Object} SkillsState
 * @property {SkillMeta[]|null} skills
 * @property {'local'|'git'|'manifest'} tab
 * @property {string} localText
 * @property {string} gitUrl
 * @property {string} manifestUrl
 * @property {boolean} busy
 * @property {{ ok: boolean, text: string }|null} status
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: SkillsState, attrs: { send: Send } }} SkillsVnode */

export const SkillsView = {
  /** @param {SkillsVnode} vnode */
  oninit(vnode) {
    vnode.state.skills = null;          // null = loading; [] = none
    vnode.state.tab = 'local';          // 'local' | 'git' | 'manifest'
    vnode.state.localText = '';
    vnode.state.gitUrl = '';
    vnode.state.manifestUrl = '';
    vnode.state.busy = false;
    vnode.state.status = null;          // { ok, text }
    SkillsView.refresh(vnode);
  },

  /** @param {SkillsVnode} vnode */
  refresh(vnode) {
    vnode.attrs.send({ type: 'skills/list' }).then((r) => {
      vnode.state.skills = r?.ok ? r.skills : [];
      m.redraw();
    }).catch(() => { vnode.state.skills = []; m.redraw(); });
  },

  /**
   * @param {SkillsVnode} vnode
   * @param {'local'|'git'|'manifest'} type
   */
  install(vnode, type) {
    const ui = vnode.state;
    ui.busy = true; ui.status = null;
    /** @type {object} */
    let msg;
    if (type === 'local') msg = { type: 'skills/installLocal', text: ui.localText };
    else if (type === 'git') msg = { type: 'skills/installGit', url: ui.gitUrl.trim() };
    else msg = { type: 'skills/installManifest', url: ui.manifestUrl.trim() };

    vnode.attrs.send(msg).then((r) => {
      ui.busy = false;
      if (r?.ok) {
        if (type === 'manifest') {
          const n = r.installed?.length ?? 0;
          const f = r.failed?.length ?? 0;
          ui.status = { ok: true, text: `Installed ${n} skill(s)${f ? `, ${f} failed` : ''}.` };
        } else {
          ui.status = { ok: true, text: `Installed “${r.skill?.name}”.` };
          if (type === 'local') ui.localText = '';
        }
        SkillsView.refresh(vnode);
      } else {
        ui.status = { ok: false, text: r?.detail || r?.error || 'Install failed.' };
      }
      m.redraw();
    }).catch((e) => {
      ui.busy = false;
      ui.status = { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? 'Install failed.' };
      m.redraw();
    });
  },

  /**
   * @param {SkillsVnode} vnode
   * @param {string} name
   * @param {boolean} enabled
   */
  toggle(vnode, name, enabled) {
    vnode.attrs.send({ type: 'skills/setEnabled', name, enabled }).then(() => {
      SkillsView.refresh(vnode);
    });
  },

  /**
   * @param {SkillsVnode} vnode
   * @param {string} name
   */
  remove(vnode, name) {
    vnode.attrs.send({ type: 'skills/remove', name }).then(() => {
      SkillsView.refresh(vnode);
    });
  },

  /** @param {SkillsVnode} vnode */
  view: ({ state: ui, attrs }) => {
    const vnode = { state: ui, attrs };
    const skills = ui.skills;

    return m('.skills-view', { style: 'padding:12px; overflow-y:auto;' }, [
      m('h2', { style: 'margin:0 0 4px;' }, 'Skills'),
      m('p.muted', { style: 'margin:0 0 12px; font-size:12px; opacity:.7;' },
        'Installed skills add task playbooks. Only their descriptions load '
        + 'at startup; the agent reads a full skill on demand.'),

      // --- install panel ---
      m('.skills-install', { style: 'border:1px solid var(--border,#333); border-radius:8px; padding:10px; margin-bottom:14px;' }, [
        // Remote sources (git/manifest) are gated for store V1; with only
        // the paste source live, the tab bar is noise — hide it entirely.
        REMOTE_SKILL_INSTALL
          ? m('.skills-tabs', { role: 'tablist', style: 'display:flex; gap:6px; margin-bottom:8px;' },
              /** @type {Array<'local'|'git'|'manifest'>} */ (['local', 'git', 'manifest']).map((t) => m('button', {
                role: 'tab',
                'aria-selected': ui.tab === t ? 'true' : 'false',
                class: ui.tab === t ? 'active' : '',
                style: `flex:1; padding:4px; ${ui.tab === t ? 'font-weight:600;' : 'opacity:.6;'}`,
                onclick: () => { ui.tab = t; ui.status = null; },
              }, t === 'local' ? 'Paste' : t === 'git' ? 'Git URL' : 'Manifest')))
          : null,

        ui.tab === 'local' ? m('label', { style: 'display:block;' }, [
          m('span.sr-only', 'SKILL.md text'),
          m('textarea', {
            'aria-label': 'SKILL.md text',
            placeholder: '---\nname: my-skill\ndescription: ...\n---\n# instructions',
            rows: 6,
            style: 'width:100%; font-family:monospace; font-size:12px;',
            value: ui.localText,
            oninput: (/** @type {Event} */ e) => { ui.localText = /** @type {HTMLTextAreaElement} */ (e.target).value; },
          }),
        ]) : null,

        ui.tab === 'git' ? m('input', {
          type: 'url',
          'aria-label': 'Git URL to a SKILL.md',
          placeholder: 'https://github.com/user/repo/.../SKILL.md',
          style: 'width:100%;',
          value: ui.gitUrl,
          oninput: (/** @type {Event} */ e) => { ui.gitUrl = /** @type {HTMLInputElement} */ (e.target).value; },
        }) : null,

        ui.tab === 'manifest' ? m('input', {
          type: 'url',
          'aria-label': 'Static manifest URL',
          placeholder: 'https://example.com/skills.json',
          style: 'width:100%;',
          value: ui.manifestUrl,
          oninput: (/** @type {Event} */ e) => { ui.manifestUrl = /** @type {HTMLInputElement} */ (e.target).value; },
        }) : null,

        m('button', {
          style: 'margin-top:8px;',
          disabled: ui.busy,
          onclick: () => SkillsView.install(vnode, ui.tab),
        }, ui.busy ? 'Installing…' : 'Install'),

        ui.status ? m('.skills-status', {
          role: 'status',
          'aria-live': 'polite',
          style: `margin-top:8px; font-size:12px; color:${ui.status.ok ? 'var(--ok,#4caf50)' : 'var(--err,#e57373)'};`,
        }, ui.status.text) : null,
      ]),

      // --- installed list ---
      skills === null
        ? m('p.muted', 'Loading…')
        : skills.length === 0
          ? m('p.muted', { style: 'opacity:.6;' }, 'No skills installed yet.')
          : m('ul.skills-list', { style: 'list-style:none; padding:0; margin:0;' },
              skills.map((s) => m('li', {
                key: s.id,
                style: 'border:1px solid var(--border,#333); border-radius:8px; padding:10px; margin-bottom:8px;',
              }, [
                m('.skills-row', { style: 'display:flex; align-items:center; gap:8px;' }, [
                  m('strong', { style: s.enabled ? '' : 'opacity:.5;' }, s.name),
                  m('span.badge', {
                    style: 'font-size:10px; padding:1px 5px; border-radius:4px; background:var(--chip,#333);',
                  }, s.source),
                  s.version ? m('span.muted', { style: 'font-size:10px; opacity:.6;' }, `v${s.version}`) : null,
                  m('.spacer', { style: 'flex:1;' }),
                  m('label', { style: 'font-size:11px; display:flex; gap:4px; align-items:center;' }, [
                    m('input', {
                      type: 'checkbox',
                      checked: s.enabled,
                      'aria-label': `Enable ${s.name}`,
                      onchange: (/** @type {Event} */ e) => SkillsView.toggle(vnode, s.name, /** @type {HTMLInputElement} */ (e.target).checked),
                    }),
                    'on',
                  ]),
                  m('button', {
                    'aria-label': `Remove ${s.name}`,
                    title: 'Remove',
                    style: 'color:var(--err,#e57373);',
                    onclick: () => SkillsView.remove(vnode, s.name),
                  }, '✕'),
                ]),
                m('p', { style: 'margin:6px 0 0; font-size:12px; opacity:.8;' }, s.description),
                m('.muted', { style: 'font-size:10px; opacity:.5; margin-top:4px;' },
                  `${(s.sizeBytes / 1024).toFixed(1)} KB${s.origin ? ` · ${s.origin}` : ''}`),
              ]))),
    ]);
  },
};
