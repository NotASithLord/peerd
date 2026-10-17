// @ts-check
// home/discover-pages.js - view pieces for the Discover flow (2a design).
//
// Each function takes one props object and returns vnodes. No state and no
// sends: discover-section.js computes every value and passes every handler.
// Publisher text (app names, descriptions) renders with dir="auto", so its
// direction stays inside its own element and cannot flow into "Made by".
// A maker name or short key next to other text sits in a <bdi> for the same
// reason: a right-to-left contact name cannot reorder " · 48 KB".

import m from '/vendor/mithril/mithril.js';
import { installSteps } from './discover-model.js';

/** @typedef {import('./discover-model.js').InstallState} InstallState */
/** @typedef {import('./discover-model.js').StepState} StepState */
/** @typedef {import('./discover-model.js').Pill} Pill */
/** @typedef {{name:string|null, key:string}} Maker */
/** @typedef {{kind:'status', text:string}|{kind:'update'|'open'|'review'}} TileAction */
/** @typedef {{label:string, onclick:()=>void, disabled?:boolean}} ButtonProps */
/** @typedef {{label:string, value:string, code?:boolean, copy?:ButtonProps}} Fact */

/** @param {string} name sprite id without the ic- prefix @param {number} size */
export const icon = (name, size) => m('svg.ic', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
  m('use', { href: `#ic-${name}` }));

/** @param {{letter:string, tone:string, variant:'tile'|'page'|'row'|'person'}} props */
export const letterAvatar = ({ letter, tone, variant }) => m(`div.disc-letter.disc-letter--${variant}`, {
  'aria-hidden': 'true', style: { background: `var(${tone})` },
}, letter);

/** @param {Maker} maker */
export const makerText = (maker) => ['Made by ', maker.name ? m('bdi', maker.name) : m('bdi.type-code.disc-maker-key', maker.key)];

/** "Made by Ana · 48 KB", either part optional.
 * @param {Maker|null} maker @param {string|null} kb */
export const makerMeta = (maker, kb) => [maker ? makerText(maker) : null, kb ? `${maker ? ' · ' : ''}${kb}` : null];

/**
 * Parts keyed by name, nulls left out. A keyed part keeps its DOM node while
 * the parts around it change, so focus and typed text stay put.
 * @param {Record<string, unknown>} parts
 */
export const keyedParts = (parts) => Object.entries(parts).flatMap(([key, part]) => part ? [m.fragment({ key }, part)] : []);

/** @param {ButtonProps} props */
export const primaryButton = ({ label, onclick, disabled }) => m('button.disc-primary', { type: 'button', disabled, onclick }, label);
/** @param {ButtonProps & {attrs?:Record<string, string>}} props */
export const secondaryButton = ({ label, onclick, disabled, attrs }) => m('button.secondary.disc-btn', {
  type: 'button', disabled, onclick, ...attrs,
}, label);

/**
 * @param {TileAction} action
 * @param {{onOpen:()=>void, onUpdate:()=>void, onReview:()=>void}} on
 */
export const actionView = (action, on) => {
  if (action.kind === 'status') return m('span.type-small.disc-tile-status', action.text);
  if (action.kind === 'open') return m('button.library-open.disc-tile-action', { type: 'button', onclick: on.onOpen }, ['Open', icon('ext', 13)]);
  return m('button.library-open.disc-tile-action', {
    type: 'button', onclick: action.kind === 'update' ? on.onUpdate : on.onReview,
  }, action.kind === 'update' ? 'Update' : 'Review');
};

/** @param {{label:string, onclick:()=>void, disabled?:boolean, open?:boolean}} props */
export const tileButton = ({ label, onclick, disabled, open }) => m('button.library-open.disc-tile-action', {
  type: 'button', disabled, onclick,
}, open ? [label, icon('ext', 13)] : label);

// why a stretched name button: a tile without an action ("Can’t run") must
// still open its page from the keyboard, and the whole tile stays clickable.
/** @param {{name:string, cls:string, onOpen?:()=>void}} props */
const nameView = ({ name, cls, onOpen }) => onOpen
  ? m(`button.disc-tile-open${cls}`, { type: 'button', dir: 'auto', title: name, onclick: onOpen }, name)
  : m(`div${cls}`, { dir: 'auto', title: name }, name);

/**
 * @param {{key:string, name:string, letter:string, tone:string, meta:unknown, description?:string,
 *   updateReady?:boolean, action:unknown, onOpen?:()=>void}} props
 */
export const tile = ({ key, name, letter, tone, meta, description, updateReady, action, onOpen }) =>
  m('.disc-card.disc-tile', { key, 'data-key': key }, [
    letterAvatar({ letter, tone, variant: 'tile' }),
    m('.disc-tile-id', [
      nameView({ name, cls: '.type-heading.disc-tile-name', onOpen }),
      m('.type-small.disc-tile-meta', meta),
    ]),
    description ? m('p.type-body-sm.disc-tile-desc', { dir: 'auto' }, description) : null,
    updateReady ? m('span.type-small.disc-tile-flag', 'Update ready') : null,
    m('.disc-actions', action),
  ]);

/**
 * @param {{key:string, name:string, letter:string, tone:string, meta:unknown, description?:string,
 *   action:unknown, onOpen?:()=>void}} props
 */
export const appRow = ({ key, name, letter, tone, meta, description, action, onOpen }) =>
  m('li.disc-app-row', { key, 'data-key': key }, [
    letterAvatar({ letter, tone, variant: 'row' }),
    m('.disc-app-row-id', [
      nameView({ name, cls: '.type-subheading', onOpen }),
      m('.type-small', meta),
      description ? m('.type-body-sm', { dir: 'auto' }, description) : null,
    ]),
    m('.disc-app-row-action', action),
  ]);

/** @param {{icon:string, title:string, text:unknown, action:unknown, extra?:unknown}} props */
export const startRow = ({ icon: name, title, text, action, extra }) => m('li.disc-start-row', [
  m('.disc-start-main', [
    m('span.disc-start-icon', icon(name, 20)),
    m('.disc-start-text', [m('.type-heading', title), m('.type-body-sm', text)]),
  ]),
  m('.disc-start-action', action),
  extra ? m('.disc-start-note', extra) : null,
]);

/**
 * The share row, opened in place by "Paste link". `status` explains a held
 * install receipt; `note` says why "Check link" is off.
 * @param {{value:string, inputDisabled:boolean, checkDisabled:boolean, status:string|null, note:string|null, error:string,
 *   oninput:(value:string)=>void, onCheck:()=>void}} props
 */
export const shareRow = ({ value, inputDisabled, checkDisabled, status, note, error, oninput, onCheck }) =>
  m('li.disc-start-row.is-open', [
    m('.disc-start-main', [
      m('span.disc-start-icon', icon('ext', 20)),
      m('.disc-start-text', [
        m('.type-heading', 'Open a share link'),
        m('.type-body-sm', 'Someone sent you a link to an app? Paste it to check it.'),
      ]),
    ]),
    m('form.disc-start-form', {
      onsubmit: (/** @type {Event} */ event) => { event.preventDefault(); if (!checkDisabled) onCheck(); },
    }, [
      m('input', {
        type: 'text', value, maxlength: 4096, 'aria-label': 'Share link', placeholder: 'dwapp://…',
        disabled: inputDisabled,
        oninput: (/** @type {{target:HTMLInputElement}} */ event) => oninput(event.target.value),
      }),
      m('button.secondary.disc-btn', { type: 'submit', disabled: checkDisabled }, 'Check link'),
    ]),
    status ? m('p.type-small.disc-footnote', { role: 'status' }, status) : null,
    note ? m('p.type-small.disc-footnote', note) : null,
    error ? m('p.error', { role: 'alert' }, error) : null,
  ]);

/** @param {{text:string, count:string|null, buttons:Record<string, unknown>}} props */
export const statusRow = ({ text, count, buttons }) => m('.disc-status', [
  m('span.type-body-sm.disc-status-live', { role: 'status', 'aria-live': 'polite' }, [icon('globe', 16), text]),
  count ? m('span.type-body-sm.disc-status-count', count) : null,
  m('span.spacer'),
  keyedParts(buttons),
]);

/** @param {{spinning:boolean, onclick:()=>void}} props */
export const refreshButton = ({ spinning, onclick }) => m('button.icon.disc-refresh', {
  type: 'button', title: 'Refresh', 'aria-label': 'Refresh', class: spinning ? 'is-spinning' : '', disabled: spinning, onclick,
}, icon('refresh', 16));

/** @type {ReadonlyArray<[Pill, string]>} */
const PILLS = Object.freeze([['all', 'All'], ['updates', 'Updates'], ['contacts', 'From contacts'], ['included', 'Included']]);
/** @param {{value:Pill, onSelect:(pill:Pill)=>void}} props */
export const pills = ({ value, onSelect }) => m('.disc-pills', { role: 'group', 'aria-label': 'Show' },
  PILLS.map(([id, label]) => m('button.disc-pill', { type: 'button', 'aria-pressed': String(value === id), onclick: () => onSelect(id) }, label)));

/** @param {{value:string, oninput:(value:string)=>void}} props */
export const searchInput = ({ value, oninput }) => m('input.disc-search', {
  type: 'search', 'aria-label': 'Search apps', placeholder: 'Search apps…', value,
  oninput: (/** @type {{target:HTMLInputElement}} */ event) => oninput(event.target.value),
});

/** @param {{title?:string, text:string, actions:unknown[], boxed?:boolean, status?:boolean}} props */
export const emptyState = ({ title, text, actions, boxed, status }) => m('.disc-empty', {
  class: boxed ? 'disc-empty--boxed' : '', role: status ? 'status' : undefined,
}, [
  title ? m('h2.type-heading', title) : null,
  m('p.type-body-sm', text),
  actions.some(Boolean) ? m('.disc-empty-actions', actions) : null,
]);

/** @param {{onclick:()=>void}} props */
export const backLink = ({ onclick }) => m('button.linklike.disc-back', { type: 'button', onclick }, [
  m('span.disc-flip', icon('right', 14)), 'Discover',
]);

/**
 * @param {{name:string, letter:string, tone:string, maker:Maker|null, onMaker:()=>void, kb:string|null,
 *   modified?:boolean, description?:string}} props
 */
export const appHead = ({ name, letter, tone, maker, onMaker, kb, modified, description }) => [
  m('.disc-app-head', [
    letterAvatar({ letter, tone, variant: 'page' }),
    m('.disc-app-id', [
      m('h2.type-page-title.disc-app-title', { dir: 'auto' }, name),
      maker ? m('button.linklike.disc-app-maker', { type: 'button', onclick: onMaker }, makerText(maker)) : null,
      kb ? m('span.type-small.disc-app-size', kb) : null,
      modified ? m('span.type-small.disc-chip--strong', 'Locally modified') : null,
    ]),
  ]),
  description
    ? m('p.type-body.disc-app-desc', { dir: 'auto' }, description)
    : m('p.type-body.disc-app-desc.is-missing', 'No description from the maker.'),
];

const ARIA_CURRENT = new Set(['current', 'working', 'failed', 'unknown']);
/** @param {StepState} state @param {number} n */
const stepMark = (state, n) => state === 'done' ? icon('check', 14)
  : state === 'working' ? m('span.peerd-spinner', { 'aria-hidden': 'true' })
    : state === 'failed' ? icon('x', 13) : String(n);

// why the installed line takes focus (tabindex -1), never Open: Open runs
// peer code, so one stray key press after the install must not reach it.
// The action is keyed by its label for the same reason: a fast reply turns
// "Install and share" into "Open" in one redraw, and a reused node would
// keep the focus.
/**
 * The action panel with the three install steps. `message` is the state line
 * (failure or unknown text, or the in-flight note); `notice` is a committed
 * warning after success; `error` is an Open failure. `otherVersion`: the
 * Library holds another version, so the installed line claims no version.
 * `secondary` sits next to `primary`.
 * @param {{state:InstallState, message:string|null, notice:string|null, error:string|null,
 *   primary:ButtonProps|null, secondary?:ButtonProps|null, otherVersion?:boolean}} props
 */
export const installPanel = ({ state, message, notice, error, primary, secondary, otherVersion }) => m('.disc-panel', [
  m('ol.disc-steps', { 'aria-label': 'Install steps' }, installSteps(state).map((step, i) =>
    m(`li.disc-step.is-${step.state}`, { 'aria-current': ARIA_CURRENT.has(step.state) ? 'step' : undefined }, [
      m('span.disc-step-mark', stepMark(step.state, i + 1)),
      m('span.disc-step-text', [
        m('span.disc-step-title', step.title),
        step.sub ? m('span.type-small.disc-step-sub', step.sub) : null,
      ]),
    ]))),
  state === 'installing' && message ? m('p.type-small.disc-footnote', { role: 'status' }, message) : null,
  state === 'installed' ? m('p.type-body-sm.disc-installed', { tabindex: -1, role: 'status' }, otherVersion
    ? 'In your Library. Open runs the version you have.'
    : 'In your Library. Peers can get this version from you while your peer network is on.') : null,
  state === 'failed' && message ? m('p.error.disc-panel-error', { role: 'alert' }, message) : null,
  state === 'unknown' && message ? m('p.type-body-sm', { role: 'status' }, message) : null,
  notice ? m('p.type-small.disc-footnote', { role: 'status' }, notice) : null,
  error ? m('p.error', { role: 'alert' }, error) : null,
  primary ? m('.disc-panel-actions', keyedParts({
    [primary.label]: primaryButton(primary), ...(secondary ? { [secondary.label]: secondaryButton(secondary) } : {}),
  })) : null,
]);

/**
 * An installed app with a newer version on offer. Open runs the installed
 * version, so nothing here says the user has or shares the new one. `update`
 * is null when the new version can't run in this browser.
 * @param {{update:ButtonProps|null, open:ButtonProps, notice:string|null, error:string|null}} props
 */
export const updatePanel = ({ update, open, notice, error }) => m('.disc-panel', [
  update ? m('.type-label-strong', 'Update ready') : m('p.type-body-sm', [
    m('strong', 'This update can’t run in this browser.'),
    ' It needs a feature peerd can’t use here. Technical details lists it.',
  ]),
  notice ? m('p.type-small.disc-footnote', { role: 'status' }, notice) : null,
  error ? m('p.error', { role: 'alert' }, error) : null,
  m('.disc-panel-actions', keyedParts(update ? { update: primaryButton(update), open: secondaryButton(open) } : { open: primaryButton(open) })),
]);

/** @param {{disabled:boolean, onFork:()=>void, onReplace:()=>void, onCancel:()=>void}} props */
export const conflictPanel = ({ disabled, onFork, onReplace, onCancel }) => m('.disc-panel', [
  m('.type-label-strong', 'Update ready'),
  m('p.type-body-sm', [
    m('strong', 'You changed this app locally.'),
    ' The update will not overwrite your changes unless you choose to replace them.',
  ]),
  m('.disc-panel-actions', [
    primaryButton({ label: 'Keep a fork & update', onclick: onFork, disabled }),
    secondaryButton({ label: 'Replace local copy', onclick: onReplace, disabled }),
    secondaryButton({ label: 'Cancel', onclick: onCancel }),
  ]),
  m('p.type-small.disc-footnote', 'Keeping a fork leaves your copy in the Library next to the new version.'),
]);

export const cantRunPanel = () => m('.disc-panel', m('p.type-body-sm', [
  m('strong', 'This app can’t run in this browser.'),
  ' It needs a feature peerd can’t use here. Technical details lists it.',
]));

/** @param {string} name @param {string} text */
const safetyRow = (name, text) => m('.disc-safety-row', [
  m('span.disc-safety-icon', icon(name, 16)),
  m('span.type-body-sm.disc-safety-text', text),
]);
// why "direct": the app sandbox CSP blocks every network request of its own,
// but an app can still reach peers through peerd.
export const safetyLines = () => m('.disc-section.disc-safety', [
  m('.type-label-strong', 'Before you install'),
  safetyRow('key', 'Signed by its maker. peerd checks every file when it installs. This is not a safety review.'),
  safetyRow('lock', 'Runs on its own, with no direct network access.'),
  safetyRow('globe', 'Installing also shares this version with peers while your peer network is on.'),
]);

/**
 * `footnote` qualifies the facts; `note` reports a Copy failure.
 * @param {{id:string, open:boolean, onToggle:()=>void, facts:Fact[], footnote?:string|null, note:string|null}} props
 */
export const techDetails = ({ id, open, onToggle, facts, footnote, note }) => m('.disc-section', [
  m('button.linklike.disc-tech-toggle', {
    type: 'button', 'aria-expanded': String(open), 'aria-controls': id, onclick: onToggle,
  }, ['Technical details', m('span.disc-chevron', icon('down', 14))]),
  m('dl.disc-facts', { id, hidden: !open }, facts.map(fact => [
    m('dt', fact.label),
    m('dd', [
      fact.code ? m('span.type-code', fact.value) : fact.value,
      fact.copy ? m('button.library-btn', { type: 'button', disabled: fact.copy.disabled, onclick: fact.copy.onclick }, fact.copy.label) : null,
    ]),
  ])),
  open && footnote ? m('p.type-small.disc-footnote', footnote) : null,
  open && note ? m('p.type-small.disc-footnote', { role: 'status' }, note) : null,
]);

// why the code style without a saved name: the title is then the short key,
// drawn as "Made by" draws it everywhere else.
/** @param {{title:string, letter:string, tone:string, saved:boolean}} props */
export const makerHead = ({ title, letter, tone, saved }) => m('.disc-person-head', [
  letterAvatar({ letter, tone, variant: 'person' }),
  m('.disc-person-id', [
    m('h2.type-page-title', { dir: 'auto' }, saved ? title : m('bdi.type-code', title)),
    saved ? m('.type-small', 'Saved as a contact on this device') : null,
  ]),
]);
