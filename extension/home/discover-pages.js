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
/** @typedef {NonNullable<ReturnType<typeof import('./discover-model.js').saysIt>>} SaysIt */
/** @typedef {{name:string|null, key:string}} Maker */
/** @typedef {{kind:'status', text:string}|{kind:'update'|'open'|'review'}} TileAction */
/** @typedef {{label:string, onclick:()=>void, disabled?:boolean}} ButtonProps */
/** @typedef {{label:string, value:string, code?:boolean, copy?:ButtonProps}} Fact */

/** @param {string} name sprite id without the ic- prefix @param {number} size */
export const icon = (name, size) => m('svg.ic', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
  m('use', { href: `#ic-${name}` }));

/** @param {{letter:string, tone:string, variant:'tile'|'page'|'row'|'person'|'chip'}} props */
export const letterAvatar = ({ letter, tone, variant }) => m(`div.disc-letter.disc-letter--${variant}`, {
  'aria-hidden': 'true', style: { background: `var(${tone})` },
}, letter);

/** @param {Maker} maker */
const makerName = (maker) => maker.name ? m('bdi', maker.name) : m('bdi.type-code.disc-maker-key', maker.key);
// why the words outside the <bdi>: a saved name is one the user chose, so it
// says so, and its direction stays inside its own element.
/** @param {Maker} maker */
export const makerText = (maker) => ['Made by ', makerName(maker), maker.name ? ', someone you know' : null];

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
 * Update comes with Open: the installed version still runs.
 * @param {TileAction} action
 * @param {{onOpen:()=>void, onUpdate:()=>void, onReview:()=>void}} on
 */
export const actionView = (action, on) => {
  if (action.kind === 'status') return m('span.type-small.disc-tile-status', action.text);
  if (action.kind === 'open') return m('button.library-open.disc-tile-action', { type: 'button', onclick: on.onOpen }, ['Open', icon('ext', 13)]);
  if (action.kind === 'update') {
    return [
      m('button.library-open.disc-tile-action', { type: 'button', onclick: on.onUpdate }, 'Update'),
      m('button.secondary.disc-tile-action', { type: 'button', onclick: on.onOpen }, 'Open'),
    ];
  }
  return m('button.library-open.disc-tile-action', { type: 'button', onclick: on.onReview }, 'Look at it');
};

/** @param {{label:string, onclick:()=>void, disabled?:boolean, open?:boolean, ariaLabel?:string}} props */
export const tileButton = ({ label, onclick, disabled, open, ariaLabel }) => m('button.library-open.disc-tile-action', {
  type: 'button', disabled, onclick, 'aria-label': ariaLabel,
}, open ? [label, icon('ext', 13)] : label);

// why a stretched name button: a tile without an action ("This browser cannot
// run it") must still open its page from the keyboard, and the whole tile
// stays clickable.
/** @param {{name:string, cls:string, onOpen?:()=>void}} props */
const nameView = ({ name, cls, onOpen }) => onOpen
  ? m(`button.disc-tile-open${cls}`, { type: 'button', dir: 'auto', title: name, onclick: onOpen }, name)
  : m(`div${cls}`, { dir: 'auto', title: name }, name);

// why the error inside the tile or row: a line above a long grid or list sits
// off screen for the tile the user clicked.
/**
 * @param {{key:string, name:string, letter:string, tone:string, meta:unknown, description?:string,
 *   action:unknown, error?:unknown, onOpen?:()=>void}} props
 */
export const tile = ({ key, name, letter, tone, meta, description, action, error, onOpen }) =>
  m('.disc-card.disc-tile', { key, 'data-key': key }, [
    letterAvatar({ letter, tone, variant: 'tile' }),
    m('.disc-tile-id', [
      nameView({ name, cls: '.type-heading.disc-tile-name', onOpen }),
      m('.type-small.disc-tile-meta', meta),
    ]),
    description
      ? m('p.type-body-sm.disc-tile-desc', { dir: 'auto' }, description)
      : m('p.type-body-sm.disc-tile-desc.is-missing', 'No description from the maker.'),
    m('.disc-actions', action),
    error,
  ]);

/**
 * @param {{key:string, name:string, letter:string, tone:string, meta:unknown, description?:string,
 *   action:unknown, error?:unknown, onOpen?:()=>void}} props
 */
export const appRow = ({ key, name, letter, tone, meta, description, action, error, onOpen }) =>
  m('li.disc-app-row', { key, 'data-key': key }, [
    letterAvatar({ letter, tone, variant: 'row' }),
    m('.disc-app-row-id', [
      nameView({ name, cls: '.type-subheading', onOpen }),
      m('.type-small', meta),
      description ? m('.type-body-sm', { dir: 'auto' }, description) : null,
      error,
    ]),
    m('.disc-app-row-action', action),
  ]);

/** `note` is a smaller line under the text. @param {{icon:string, title:string, text:unknown, note?:string, action:unknown, extra?:unknown}} props */
export const startRow = ({ icon: name, title, text, note, action, extra }) => m('li.disc-start-row', [
  m('.disc-start-main', [
    m('span.disc-start-icon', icon(name, 20)),
    m('.disc-start-text', [m('.type-heading', title), m('.type-body-sm', text), note ? m('.type-small.disc-start-small', note) : null]),
  ]),
  m('.disc-start-action', action),
  extra ? m('.disc-start-note', extra) : null,
]);

/** A boxed line with an icon, as under the start list. @param {{icon:string, text:string}} props */
export const noteBox = ({ icon: name, text }) => m('.disc-note-box', [
  m('span.disc-note-icon', icon(name, 18)),
  m('p.type-body-sm', text),
]);

/**
 * why a stable status node: a live region must exist before its text changes.
 * Only its empty state leaves the flex flow, so it adds no gap.
 * `onCancel` closes the row (Cancel, or Escape in the input); null while
 * a receipt is held, because only its outcome releases the row.
 * @param {{value:string, inputDisabled:boolean, checkDisabled:boolean, status:string|null, note:string|null, error:string,
 *   oninput:(value:string)=>void, onCheck:()=>void, onCancel:(()=>void)|null}} props
 */
export const shareRow = ({ value, inputDisabled, checkDisabled, status, note, error, oninput, onCheck, onCancel }) =>
  m('li.disc-start-row.is-open', [
    m('.disc-start-main', [
      m('span.disc-start-icon', icon('ext', 20)),
      m('.disc-start-text', [
        m('.type-heading', 'Open an app a friend sent you'),
        m('.type-body-sm', 'Paste the link they shared. You can look at the app before you install it.'),
      ]),
    ]),
    m('form.disc-start-form', {
      onsubmit: (/** @type {Event} */ event) => { event.preventDefault(); if (!checkDisabled) onCheck(); },
    }, [
      m('input', {
        type: 'text', value, maxlength: 4096, 'aria-label': 'Share link', placeholder: 'dwapp://…',
        disabled: inputDisabled,
        oninput: (/** @type {{target:HTMLInputElement}} */ event) => oninput(event.target.value),
        onkeydown: (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape' && onCancel) onCancel(); },
      }),
      m('button.secondary.disc-btn', { type: 'submit', disabled: checkDisabled }, 'Check link'),
      onCancel ? m('button.secondary.disc-btn', { type: 'button', onclick: onCancel }, 'Cancel') : null,
    ]),
    m('p.type-small.disc-footnote', { role: 'status', style: status ? null : 'position:absolute' }, status),
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
const PILLS = Object.freeze([['all', 'All'], ['contacts', 'From people you know'], ['updates', 'Updates'], ['included', 'Comes with peerd']]);
/** @param {{value:Pill, onSelect:(pill:Pill)=>void}} props */
export const pills = ({ value, onSelect }) => m('.disc-pills', { role: 'group', 'aria-label': 'Show' },
  PILLS.map(([id, label]) => m('button.disc-pill', { type: 'button', 'aria-pressed': String(value === id), onclick: () => onSelect(id) }, label)));

const SEARCH_ID = 'disc-search';
/** @param {{value:string, oninput:(value:string)=>void}} props */
export const searchInput = ({ value, oninput }) => m('.disc-search-field', [
  m('label.type-label-strong', { for: SEARCH_ID }, 'What do you want to do?'),
  m('input.disc-search', {
    id: SEARCH_ID, type: 'search', placeholder: 'For example, split a bill or plan a trip', value,
    oninput: (/** @type {{target:HTMLInputElement}} */ event) => oninput(event.target.value),
  }),
]);

/**
 * `waiting`: the title is a status with a spinner, as the waiting card draws it.
 * @param {{title?:string, text:string, actions:unknown[], boxed?:boolean, status?:boolean, waiting?:boolean}} props
 */
export const emptyState = ({ title, text, actions, boxed, status, waiting }) => m('.disc-empty', {
  class: boxed ? 'disc-empty--boxed' : '', role: status ? 'status' : undefined,
}, [
  title && waiting ? m('.disc-empty-waiting', [
    m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }), m('h2.type-heading', { role: 'status' }, title),
  ]) : title ? m('h2.type-heading', title) : null,
  m('p.type-body-sm', text),
  actions.some(Boolean) ? m('.disc-empty-actions', actions) : null,
]);

/** `label` names the page Back returns to: an app name is peer text. @param {{onclick:()=>void, label?:string}} props */
export const backLink = ({ onclick, label = 'Discover' }) => m('button.linklike.disc-back', { type: 'button', onclick }, [
  m('span.disc-flip', icon('right', 14)), m('bdi', label),
]);

/**
 * `meta` is the size, or where the app is ("In your Library"). `onShare`
 * opens the share dialog; null when the app has no share link.
 * @param {{name:string, letter:string, tone:string, maker:Maker|null, onMaker:()=>void, meta:string|null,
 *   modified?:boolean, description?:string, onShare?:(()=>void)|null}} props
 */
export const appHead = ({ name, letter, tone, maker, onMaker, meta, modified, description, onShare }) => [
  m('.disc-app-head', [
    letterAvatar({ letter, tone, variant: 'page' }),
    m('.disc-app-id', [
      m('h2.type-page-title.disc-app-title', { dir: 'auto' }, name),
      maker ? m('button.linklike.disc-app-maker', { type: 'button', onclick: onMaker }, makerText(maker)) : null,
      meta ? m('span.type-small.disc-app-size', meta) : null,
      modified ? m('span.type-small.disc-chip--strong', 'Changed on this device') : null,
    ]),
    onShare ? m('button.secondary.disc-share-open', { type: 'button', 'data-share-open': '', onclick: onShare }, [
      icon('share', 16), 'Share',
    ]) : null,
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

/** @param {string} label @param {()=>void} onclick */
const linkButton = (label, onclick) => m('button.linklike.disc-link-btn', { type: 'button', onclick }, label);

// why the installed line takes focus (tabindex -1), never Open: Open runs
// peer code, so one stray key press after the install must not reach it.
// The action is keyed by its label for the same reason: a fast reply turns
// "Install and share" into "Open" in one redraw, and a reused node would
// keep the focus.
/**
 * The action panel with the three install steps. `message` is the in-flight
 * note; `failure` and `unknown` say what went wrong and what to do; `notice`
 * is a committed warning after success; `error` is an Open failure.
 * `otherVersion`: the Library holds another version, so the installed line
 * claims no version. `fresh`: this visit installed it, so the line says so
 * and names it. `secondary` sits next to `primary`; `sharing` explains what
 * Install and share does; `onLibrary` adds Go to Library next to Open.
 * @param {{state:InstallState, name:string, message:string|null,
 *   failure?:{action:'install'|'update', hint:string, cancelled?:boolean}|null, unknown?:{status:string, hint:string}|null,
 *   transfer?:any, notice:string|null, error:unknown, primary:ButtonProps|null, secondary?:ButtonProps|null,
 *   otherVersion?:boolean, fresh?:boolean, sharing?:string|null, onLibrary?:(()=>void)|null}} props
 */
export const installPanel = ({
  state, name, message, failure, unknown, notice, error, transfer, primary, secondary, otherVersion, fresh, sharing, onLibrary,
}) => {
  const actions = primary ? m('.disc-panel-actions', keyedParts({
    [primary.label]: primaryButton(primary), ...(secondary ? { [secondary.label]: secondaryButton(secondary) } : {}),
    library: state === 'installed' && onLibrary ? linkButton('Go to Library', onLibrary) : null,
  })) : null;
  return m('.disc-panel', [
    m('ol.disc-steps', { 'aria-label': 'Install steps' }, installSteps(state).map((step, i) =>
      m(`li.disc-step.is-${step.state}`, { 'aria-current': ARIA_CURRENT.has(step.state) ? 'step' : undefined }, [
        m('span.disc-step-mark', stepMark(step.state, i + 1)),
        m('span.disc-step-text', [
          m('span.disc-step-title', step.title),
          step.sub ? m('span.type-small.disc-step-sub', step.sub) : null,
        ]),
      ]))),
    state === 'installing' && transfer ? m.fragment({}, [transfer]) : null,
    state === 'installing' && message ? m('p.type-small.disc-footnote', { role: 'status' }, message) : null,
    state === 'installed' || (secondary && otherVersion) ? m('p.type-body-sm.disc-installed', { tabindex: -1, role: 'status' }, otherVersion
      ? 'Another version of this app is in your Library. Open runs the version you have.'
      : fresh ? [m('strong', 'Installed.'), ' ', m('bdi', name), ' is now in your Library. Other people can get it from you while your peer network is on.']
        : 'In your Library. Other people can get it from you while your peer network is on.') : null,
    state === 'failed' && failure ? [
      failure.cancelled ? m('p.type-body-sm', { role: 'status' }, failure.action === 'update' ? 'Update cancelled. Your installed version is unchanged.' : 'Installation cancelled.')
        : m('p.error.disc-panel-error', { role: 'alert' }, ['peerd could not ', failure.action, ' ', m('bdi', name), '.']),
      m('p.type-body-sm.disc-hint', failure.hint),
    ] : null,
    state === 'unknown' && unknown ? [
      m('p.type-body-sm', { role: 'status' }, unknown.status),
      m('p.type-body-sm.disc-hint', unknown.hint),
    ] : null,
    notice ? m('p.type-small.disc-footnote', { role: 'status' }, notice) : null,
    error,
    sharing && actions ? m('.disc-panel-cta', [actions, m('p.type-small.disc-footnote', sharing)]) : actions,
  ]);
};

/**
 * An installed app with a newer version on offer. Open runs the installed
 * version, so nothing here says the user has or shares the new one. `update`
 * is null when the new version cannot run in this browser.
 * @param {{update:ButtonProps|null, open:ButtonProps, notice:string|null, error:unknown}} props
 */
export const updatePanel = ({ update, open, notice, error }) => m('.disc-panel', [
  update ? m('.type-label-strong', 'Update ready') : m('p.type-body-sm', [
    m('strong', 'This browser cannot run the new version.'),
    ' You can keep using the version you have. Technical details says what it needs.',
  ]),
  notice ? m('p.type-small.disc-footnote', { role: 'status' }, notice) : null,
  error,
  update ? m('.disc-panel-cta', [
    m('.disc-panel-actions', keyedParts({ update: primaryButton(update), open: secondaryButton(open) })),
    m('p.type-small.disc-footnote', 'After you update, other people can get the new version from you while your peer network is on.'),
  ]) : m('.disc-panel-actions', keyedParts({ open: primaryButton(open) })),
]);

/** @param {{disabled:boolean, onFork:()=>void, onReplace:()=>void, onCancel:()=>void}} props */
export const conflictPanel = ({ disabled, onFork, onReplace, onCancel }) => m('.disc-panel', [
  m('.type-label-strong', 'Update ready'),
  m('p.type-body-sm', [
    m('strong', 'You changed this app on this device.'),
    ' The update does not replace your changes unless you choose that.',
  ]),
  m('.disc-panel-actions', [
    primaryButton({ label: 'Keep my copy and update', onclick: onFork, disabled }),
    secondaryButton({ label: 'Replace my changes', onclick: onReplace, disabled }),
    secondaryButton({ label: 'Cancel', onclick: onCancel }),
  ]),
  m('p.type-small.disc-footnote', 'Keep my copy puts your changed copy in your Library, next to the new version.'),
]);

export const cantRunPanel = () => m('.disc-panel', m('p.type-body-sm', [
  m('strong', 'This browser cannot run this app.'),
  ' It needs a feature that peerd cannot use here. Technical details says which one.',
]));

/** @param {string} name @param {unknown} text */
const safetyRow = (name, text) => m('.disc-safety-row', [
  m('span.disc-safety-icon', icon(name, 16)),
  m('span.type-body-sm.disc-safety-text', text),
]);
// why "by itself": the app sandbox CSP blocks every network request of its
// own, but an app can still reach peers through peerd.
// why `checked`: a share link was inspected ('link'), or the Library holds
// this version ('installed'), so peerd has checked every file. A heard card is
// only a claim. why the past for 'installed': an edit on this device can
// change the files after the install, so the check belongs to the install.
// `action` names what the page offers: an update page updates.
// why `mine` outranks `checked`: the user made the app, so peerd may never have
// checked it at an install. Its one line is true in every case.
const SAFETY_TITLE = 'disc-safety-title';
/** @param {{maker:Maker|null, checked:'link'|'installed'|null, action?:'install'|'update', mine?:boolean}} props */
export const safetyLines = ({ maker, checked, action = 'install', mine = false }) => {
  const made = maker ? ['Made by ', makerName(maker), '. '] : [];
  const who = maker?.name ? m('bdi', maker.name) : 'its maker';
  const check = checked === 'installed' ? ['When you installed it, peerd checked that it was exactly the app ', who, ' shared.']
    : checked === 'link' ? ['peerd checked that this is exactly the app ', who, ' shared.']
      : [`When you ${action} it, peerd checks that every file is exactly what `, who, ' shared.'];
  return m('section.disc-section.disc-safety', { 'aria-labelledby': SAFETY_TITLE }, [
    m('h3.type-label-strong', { id: SAFETY_TITLE }, 'What to know'),
    safetyRow('key', mine ? 'You made this app. Other people get the files you share from your Library.'
      : [...made, ...check, ' Nobody reviewed it for safety.']),
    safetyRow('lock', 'It runs in its own tab and cannot reach the internet by itself.'),
    safetyRow('globe', 'You can remove it from your Library at any time.'),
  ]);
};

const SAYS_TITLE = 'disc-says-title';
/**
 * "The app says it", under What to know: chips for what the app's own files
 * ask of peerd, or one line. saysIt in discover-model.js picks every word.
 * @param {SaysIt} props
 */
export const saysItSection = ({ kind, chips, line, note }) => m('section.disc-section.disc-says', { 'aria-labelledby': SAYS_TITLE }, [
  m('h3.type-label-strong', { id: SAYS_TITLE }, 'The app says it'),
  chips.length ? m('ul.disc-says-chips', chips.map(chip => m('li.type-small', { class: chip.strong ? 'is-strong' : '' }, chip.text))) : null,
  line ? m(kind === 'unknown' ? 'p.type-body-sm.disc-footnote' : 'p.type-body-sm', line) : null,
  note ? m('p.type-small.disc-footnote', note) : null,
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
// drawn as "Made by" draws it everywhere else. `menu` ends the head.
/** @param {{title:string, letter:string, tone:string, saved:boolean, menu?:unknown}} props */
export const makerHead = ({ title, letter, tone, saved, menu }) => m('.disc-person-head', [
  letterAvatar({ letter, tone, variant: 'person' }),
  m('.disc-person-id', [
    m('h2.type-page-title', { dir: 'auto' }, saved ? title : m('bdi.type-code', title)),
    m('.type-small', saved ? 'Someone you know. You saved this name on this device.' : 'You have not saved a name for this maker.'),
  ]),
  menu ?? null,
]);

/** Arrows, Home and End move through the items; Escape closes. @param {()=>void} onEscape */
const menuKeys = (onEscape) => (/** @type {KeyboardEvent & {redraw?:boolean}} */ event) => {
  if (event.key === 'Escape') { event.preventDefault(); onEscape(); return; }
  event.redraw = false;
  const items = /** @type {HTMLElement[]} */ ([.../** @type {HTMLElement} */ (event.currentTarget).querySelectorAll('[role="menuitem"]')]);
  const index = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const target = event.key === 'ArrowDown' ? items[(index + 1) % items.length]
    : event.key === 'ArrowUp' ? items[(index - 1 + items.length) % items.length]
      : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : null;
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
};

/**
 * The maker page menu, drawn as the Library's kebab menu. Focus moves to the
 * first item when it opens. `onClose(refocus)`: Escape closes it with focus
 * back on its button; Tab or a click elsewhere just closes it.
 * @param {{maker:Maker, open:boolean, rename:string, block:boolean, onToggle:()=>void,
 *   onClose:(refocus:boolean)=>void, onRename:()=>void, onBlock:()=>void}} props
 */
export const makerMenuView = ({ maker, open, rename, block, onToggle, onClose, onRename, onBlock }) => {
  const label = `More for ${maker.name ?? maker.key}`;
  return m('.disc-maker-menu', {
    onfocusout: (/** @type {FocusEvent & {redraw?:boolean}} */ event) => {
      const next = event.relatedTarget;
      if (!open || (next instanceof Node && /** @type {Element} */ (event.currentTarget).contains(next))) { event.redraw = false; return; }
      onClose(false);
    },
  }, [
    m('button.icon.library-kebab.disc-kebab', {
      type: 'button', 'data-maker-menu': '', 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-label': label, onclick: onToggle,
    }, icon('dots', 18)),
    open ? m('.library-menu.disc-menu', {
      role: 'menu', 'aria-label': label, onkeydown: menuKeys(() => onClose(true)),
      oncreate: (/** @type {{dom:Element}} */ { dom }) => {
        const first = dom.querySelector('[role="menuitem"]');
        if (first instanceof HTMLElement) first.focus({ preventScroll: true });
      },
    }, [
      m('button.library-menu-item', { type: 'button', role: 'menuitem', onclick: onRename }, rename),
      block ? m('.library-menu-sep', { role: 'separator' }) : null,
      block ? m('button.library-menu-item.is-danger', { type: 'button', role: 'menuitem', onclick: onBlock }, ['Block ', makerName(maker)]) : null,
    ]) : null,
  ]);
};

const RENAME_ID = 'disc-rename-name';
/**
 * Name a maker on this device, as Contacts does. `failed`: the last save
 * failed, so the form says so and stays.
 * @param {{value:string, busy:boolean, failed:boolean, canSave:boolean,
 *   oninput:(value:string)=>void, onSave:()=>void, onCancel:()=>void}} props
 */
export const renameForm = ({ value, busy, failed, canSave, oninput, onSave, onCancel }) => m('form.disc-rename', {
  onsubmit: (/** @type {Event} */ event) => { event.preventDefault(); if (canSave && !busy) onSave(); },
}, [
  m('label.type-label-strong', { for: RENAME_ID }, 'Name'),
  m('.disc-rename-row', [
    m('input', {
      id: RENAME_ID, type: 'text', value, maxlength: 64, placeholder: 'Add a name…', autocomplete: 'off', disabled: busy,
      oninput: (/** @type {{target:HTMLInputElement}} */ event) => oninput(event.target.value),
      onkeydown: (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); } },
    }),
    m('button.disc-primary', { type: 'submit', disabled: busy || !canSave }, busy ? 'Saving…' : 'Save'),
    m('button.secondary.disc-btn', { type: 'button', disabled: busy, onclick: onCancel }, 'Cancel'),
  ]),
  failed ? m('p.error', { role: 'alert' }, 'peerd could not save the name. Try again.') : null,
]);

/** A blocked maker's page says so in place of their apps. Focus lands here after a block. @param {{maker:Maker}} props */
export const blockedLine = ({ maker }) => m('p.type-body-sm.disc-blocked', { role: 'status', tabindex: -1 }, [
  makerName(maker), ' is blocked. You can undo this in Contacts.',
]);

/**
 * The "Your apps" row at the top of the network-on roots: Library apps,
 * each with Open, and a link to the rest. why its own classes: the tile
 * lookups (.disc-card, .disc-tile, [data-key]) must never count this row.
 * @param {{apps:{id:string, name:string, letter:string, tone:string, onOpen:()=>void, error?:unknown}[],
 *   onMore:(()=>void)|null}} props
 */
export const yourAppsRow = ({ apps, onMore }) => m('section.disc-yours', { 'aria-labelledby': 'disc-yours-title' }, [
  m('h2.type-label-strong', { id: 'disc-yours-title' }, 'Your apps'),
  m('ul.disc-yours-list', apps.map(app => m('li.disc-yours-item', { key: app.id, 'data-app-id': app.id }, [
    letterAvatar({ letter: app.letter, tone: app.tone, variant: 'chip' }),
    m('span.type-heading.disc-yours-name', { dir: 'auto', title: app.name }, app.name),
    m('button.library-open.disc-yours-open', { type: 'button', onclick: app.onOpen }, 'Open'),
    app.error,
  ]))),
  onMore ? linkButton('See all in Library', onMore) : null,
]);

const SHARE_TITLE = 'disc-share-title';
const SHARE_LINK = 'disc-share-link';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';
// why a trap: the dialog is modal, so Tab must cycle inside it until it closes.
// why the dialog itself counts: it holds focus while every control is off, and
// after a click on its own text.
/** @param {()=>void} onClose */
const dialogKeys = (onClose) => (/** @type {KeyboardEvent & {redraw?:boolean}} */ event) => {
  if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
  event.redraw = false;
  if (event.key !== 'Tab') return;
  const dialog = /** @type {HTMLElement} */ (event.currentTarget);
  const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll(FOCUSABLE)]);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last || document.activeElement === dialog
      || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
};

/**
 * The share dialog: the app's share link to copy. `status` is the copy
 * outcome ('copied', 'failed' or null). The section moves focus in on open
 * and back to the Share button on close. A click on the dialog's text
 * focuses the dialog itself (tabindex -1), so Escape and Tab still work.
 * @param {{name:string, letter:string, tone:string, address:string, maker:Maker|null, status:'copied'|'failed'|null,
 *   copyDisabled:boolean, onCopy:()=>void, onClose:()=>void}} props
 */
export const shareDialog = ({ name, letter, tone, address, maker, status, copyDisabled, onCopy, onClose }) =>
  m('.peerd-modal-backdrop.disc-share-backdrop', {
    onclick: (/** @type {MouseEvent} */ event) => { if (event.target === event.currentTarget) onClose(); },
  }, m('.peerd-modal.disc-share', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': SHARE_TITLE, tabindex: -1, onkeydown: dialogKeys(onClose),
  }, [
    m('.disc-share-head', [
      letterAvatar({ letter, tone, variant: 'chip' }),
      m('h2.type-heading', { id: SHARE_TITLE }, ['Share ', m('bdi', name)]),
      m('button.icon.disc-share-close', { type: 'button', 'aria-label': 'Close', onclick: onClose }, icon('x', 16)),
    ]),
    m('p.type-body-sm', 'Send this link to a friend. They open it in peerd with the peer network on, and can look at the app before they install it.'),
    m('label.type-label-strong', { for: SHARE_LINK }, 'Share link'),
    m('.disc-share-row', [
      m('input.disc-share-link', {
        id: SHARE_LINK, type: 'text', readonly: true, value: address,
        onfocus: (/** @type {{target:HTMLInputElement, redraw?:boolean}} */ event) => { event.redraw = false; event.target.select(); },
      }),
      m('button.disc-primary', { type: 'button', 'data-share-copy': '', disabled: copyDisabled, onclick: onCopy }, 'Copy link'),
    ]),
    // why a stable status node: a live region must exist before its text changes.
    m('p.type-small.disc-share-status', { role: 'status', style: status ? null : 'position:absolute' }, status === 'copied'
      ? [icon('check', 14), 'Link copied.']
      : status === 'failed' ? 'peerd could not copy the link. Select it and copy it yourself.' : null),
    m('p.type-small.disc-footnote', [
      'The link points to this exact version. If ', maker?.name ? m('bdi', maker.name) : 'its maker',
      ' updates the app later, your friend gets the version you shared.',
    ]),
  ]));

const BLOCK_TITLE = 'disc-block-title';
const BLOCK_TEXT = 'disc-block-text';
/**
 * The block confirm. It opens on Cancel (the section moves focus). `issue` is
 * the last try: 'failed' says so and keeps Block; 'unknown' stays neutral and
 * offers Check again, which reads the blocked list. While `busy` every
 * control is off, the dialog itself holds focus (tabindex -1), and the
 * section ignores Cancel.
 * @param {{maker:Maker, busy:boolean, issue:'failed'|'unknown'|null, onConfirm:()=>void, onCancel:()=>void, onCheck:()=>void}} props
 */
export const blockDialog = ({ maker, busy, issue, onConfirm, onCancel, onCheck }) => m('.peerd-modal-backdrop.disc-block-backdrop', {
  onclick: (/** @type {MouseEvent} */ event) => { if (event.target === event.currentTarget) onCancel(); },
}, m('.peerd-modal.disc-block', {
  role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': BLOCK_TITLE, 'aria-describedby': BLOCK_TEXT, tabindex: -1,
  onkeydown: dialogKeys(onCancel),
}, [
  m('h2.type-heading', { id: BLOCK_TITLE }, ['Block ', makerName(maker), '?']),
  m('p.type-body-sm', { id: BLOCK_TEXT },
    'Their apps leave Discover. peerd stops downloading their files and disconnects from them. Apps you already installed stay in your Library.'),
  m('p.type-small.disc-footnote', 'You can undo this in Contacts.'),
  issue === 'failed' ? m('p.error', { role: 'alert' }, ['peerd could not block ', makerName(maker), '. Try again.']) : null,
  issue === 'unknown'
    ? m('p.type-body-sm', { role: 'status' }, ['peerd is not sure ', makerName(maker), ' is blocked. Check again before you try again.'])
    : null,
  // why keyed: Check again replaces Block, and a reused node would keep its focus.
  m('.peerd-modal-actions.disc-block-actions', keyedParts({
    cancel: m('button.secondary.disc-btn', { type: 'button', 'data-block-cancel': '', disabled: busy, onclick: onCancel }, 'Cancel'),
    check: issue === 'unknown' ? m('button.secondary.disc-btn', {
      type: 'button', 'data-block-check': '', disabled: busy, onclick: onCheck,
    }, busy ? 'Checking…' : 'Check again') : null,
    block: issue === 'unknown' ? null : m('button.disc-danger.disc-btn', {
      type: 'button', 'data-block-confirm': '', disabled: busy, onclick: onConfirm,
    }, busy ? 'Blocking…' : ['Block ', makerName(maker)]),
  })),
]));
