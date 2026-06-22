// @ts-check
// Command palette — keyboard-first autocomplete for the composer.
//
// Renders ABOVE the textarea as a popup list when the user is typing a
// `/command` or an `@reference`. The input-bar owns the textarea and
// feeds us the current trigger (from activeTrigger()); we own the
// candidate list, filtering, keyboard navigation, and emit a `select`
// when the user commits a candidate.
//
// Accessibility (a11y) — non-negotiable per the harness brief:
//   - the popup is a `role="listbox"`, options are `role="option"`
//   - the textarea points at us via aria-controls / aria-activedescendant
//     (wired in input-bar) so screen readers announce the active option
//   - FULLY keyboard-navigable: ArrowUp/Down move, Enter/Tab commit,
//     Esc closes. The input-bar routes those keys to us so focus never
//     leaves the textarea (typing stays uninterrupted).
//   - NO animation that ignores prefers-reduced-motion. The popup just
//     appears/disappears; any transition is gated in CSS on the
//     media query. We add no JS-driven motion here.
//
// State the parent passes in `attrs`:
//   trigger   { type:'command'|'ref', kind?, query, from, to } | null
//   items     candidate list already fetched for this trigger type
//   index     active option index (parent owns it for shared keyboarding)
//   onselect  (candidate) => void
//   onhover   (i) => void

import m from '/vendor/mithril/mithril.js';
import { filterCandidates } from '/peerd-runtime/index.js';

/** @typedef {import('/peerd-runtime/composer/parse.js').RefKind} RefKind */

/**
 * The active composer trigger, as produced by `activeTrigger()`.
 * @typedef {{ type: 'command'|'ref', query: string, kind?: RefKind, from: number, to: number }} Trigger
 */

/**
 * A display candidate shown in the palette. Extends the filter's
 * {id,label,detail} Candidate shape with the insert text + kind tag.
 * @typedef {Object} PaletteCandidate
 * @property {string} id
 * @property {string} label
 * @property {string} [detail]
 * @property {string} insert      text spliced over the trigger span on commit
 * @property {string} kind        'command' | 'meta' | 'tab' | 'file'
 * @property {boolean} [disabled]
 */

/**
 * The fetched candidate source lists, keyed by trigger type.
 * @typedef {Object} PaletteItems
 * @property {Array<{ name: string, description?: string }>} [commands]
 * @property {Array<{ id: number|string, title?: string, origin?: string, active?: boolean, blocked?: boolean }>} [tabs]
 * @property {string[]} [files]
 */

/** @param {number} i */
export const PALETTE_OPTION_ID = (i) => `palette-opt-${i}`;

// Map a trigger + raw source list into display candidates. Commands and
// refs share the {id,label,detail} candidate shape so the filter is
// uniform; only the label/detail text differs.
/**
 * @param {Trigger|null|undefined} trigger
 * @param {PaletteItems} items
 * @returns {PaletteCandidate[]}
 */
export const candidatesFor = (trigger, items) => {
  if (!trigger) return [];
  if (trigger.type === 'command') {
    return (items.commands ?? []).map((c) => ({
      id: c.name,
      label: c.name,
      detail: c.description || '',
      insert: `/${c.name} `,
      kind: 'command',
    }));
  }
  // ref trigger. With no kind yet (`@`), offer the two kinds + the tab
  // shortcut. With kind=tab, list tabs; kind=file, list files.
  if (!trigger.kind) {
    return [
      { id: 'kind:tab', label: 'tab', detail: 'inline a browser tab’s live content', insert: '@tab', kind: 'meta' },
      { id: 'kind:file', label: 'file', detail: 'inline a stored file', insert: '@file:', kind: 'meta' },
    ];
  }
  if (trigger.kind === 'tab') {
    const tabs = items.tabs ?? [];
    return [
      { id: 'tab:active', label: 'tab (active)', detail: 'the current active tab', insert: '@tab ', kind: 'tab' },
      ...tabs.filter((t) => !t.active).map((t) => ({
        id: `tab:${t.id}`,
        label: t.title || t.origin || `tab ${t.id}`,
        detail: t.blocked ? `${t.origin} — blocked (denylisted)` : t.origin,
        insert: `@tab:${t.id} `,
        kind: 'tab',
        disabled: t.blocked,
      })),
    ];
  }
  // kind === 'file'
  return (items.files ?? []).map((path) => ({
    id: `file:${path}`,
    label: path,
    detail: '',
    insert: `@file:${path} `,
    kind: 'file',
  }));
};

// Pure: produce the visible, filtered+ranked list for the current query.
/**
 * @param {Trigger|null|undefined} trigger
 * @param {PaletteItems} items
 * @returns {PaletteCandidate[]}
 */
export const visibleCandidates = (trigger, items) => {
  const all = candidatesFor(trigger, items);
  return /** @type {PaletteCandidate[]} */ (filterCandidates(all, trigger?.query ?? '', 12));
};

export const CommandPalette = {
  /**
   * @param {{ attrs: {
   *   trigger: Trigger|null,
   *   items: PaletteItems,
   *   index: number,
   *   onselect: (c: PaletteCandidate) => void,
   *   onhover: (i: number) => void,
   * } }} vnode
   */
  view: ({ attrs: { trigger, items, index, onselect, onhover } }) => {
    if (!trigger) return null;
    const candidates = visibleCandidates(trigger, items);
    if (candidates.length === 0) {
      return m('.command-palette', { id: 'composer-palette', role: 'listbox', 'aria-label': 'Composer suggestions' },
        m('.palette-empty', trigger.type === 'command'
          ? 'No matching commands'
          : 'No matches'));
    }
    const active = Math.max(0, Math.min(index, candidates.length - 1));
    return m('.command-palette', {
      id: 'composer-palette',
      role: 'listbox',
      'aria-label': trigger.type === 'command' ? 'Slash commands' : 'References',
    }, candidates.map((c, i) => m('.palette-option', {
      id: PALETTE_OPTION_ID(i),
      key: c.id,
      role: 'option',
      'aria-selected': i === active ? 'true' : 'false',
      'aria-disabled': c.disabled ? 'true' : 'false',
      class: [i === active ? 'active' : '', c.disabled ? 'disabled' : ''].filter(Boolean).join(' '),
      // why: mousedown (not click) so the selection commits BEFORE the
      // textarea loses focus on blur — keeps the caret where we put it.
      onmousedown: (/** @type {Event} */ e) => {
        e.preventDefault();
        if (!c.disabled) onselect(c);
      },
      onmouseover: () => onhover(i),
    }, [
      m('.palette-label', [
        m('span.palette-sigil', trigger.type === 'command' ? '/' : '@'),
        c.label,
      ]),
      c.detail ? m('.palette-detail', c.detail) : null,
    ])));
  },
};
