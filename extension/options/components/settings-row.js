// @ts-check
// The settings ROW — one setting, readable at a glance (P1 of the UI redesign).
//
// What it replaces: an <h3>, one or two dense paragraphs, and a button labelled
// with its own inverse ("Turn off write confirmations"). Eleven of those stacked
// on Behavior meant the page carried its state in prose — you read a paragraph
// to learn whether a thing was on, and a safety-critical setting looked exactly
// like a cosmetic one.
//
// The row instead says three things in a fixed order: WHAT it is (label), WHETHER
// it is on (pill + toggle, both readable without reading), and WHAT THAT MEANS
// right now (one line, present tense). The rationale that used to be the whole
// block collapses behind "Why this matters" — available, never the default
// reading.
//
// why a shared component and not markup inside behavior.js: the same row is what
// the other settings pages want, and a pattern that lives in one page's view
// function gets re-typed slightly differently on the next page. That drift is
// exactly what made two surfaces render the same tab title two different ways
// (see prompt-wrap.js safeTitle).
//
// TIERS. `band: 'safety'` raises the group and rules it; everything else sits
// flush. That is the only visual difference, and it is deliberate: a user
// skimming for "what can peerd do to me" should find those four rows without
// reading a word of copy.

import m from '/vendor/mithril/mithril.js';

/**
 * A toggle switch. Not an <input type=checkbox> restyled — a button with
 * `role="switch"`, so the accessible name and state come from the same element
 * the pointer hits, and `aria-checked` carries the value rather than a visual.
 *
 * @param {{ on: boolean, busy?: boolean, disabled?: boolean, label: string, onclick: () => void }} p
 */
export const toggleSwitch = ({ on, busy = false, disabled = false, label, onclick }) => m('button.set-toggle', {
  type: 'button',
  role: 'switch',
  'aria-checked': on ? 'true' : 'false',
  'aria-label': label,
  class: `${on ? 'is-on' : ''} ${busy ? 'is-busy' : ''} ${disabled ? 'is-na' : ''}`.trim(),
  disabled: disabled || busy,
  onclick,
}, m('span.set-toggle-knob', { 'aria-hidden': 'true' }));

/**
 * One settings row.
 *
 * @param {{
 *   id?: string | null,
 *   label: string,
 *   summary: string,
 *   pill?: string | null,
 *   badge?: string | null,
 *   control?: any,
 *   why?: string | null,
 *   open?: boolean,
 *   onToggleWhy?: () => void,
 *   children?: any,
 * }} p
 *   id - wires the disclosure: the "Why this matters" button declares
 *     aria-controls on the rationale region it expands. Absent = the button
 *     still carries aria-expanded, but controls nothing nameable.
 *   summary — present tense, describing the CURRENT state. Not a description of
 *     the setting: "peerd clicks and types without asking" tells you where you
 *     stand; "controls whether peerd asks" does not.
 *   why — the long rationale, collapsed. Absent = no disclosure trigger.
 *   children — controls that only make sense while this row is on (an effort
 *     select, a model input). They render under the row; collapsing hides them
 *     and MUST NOT discard their values.
 */
export const settingsRow = ({
  id = null, label, summary, pill = null, badge = null, control = null,
  why = null, open = false, onToggleWhy, children = null,
}) => m('.set-row', [
  m('.set-row-main', [
    m('.set-row-text', [
      m('.set-row-head', [
        m('span.set-row-label', label),
        pill ? m('span.set-pill', { class: pill === 'ON' ? 'is-on' : '' }, pill) : null,
        badge ? m('span.set-badge', badge) : null,
      ]),
      m('p.set-row-summary', summary),
      why
        ? m('button.set-why', {
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': id ? `${id}-why` : undefined,
          onclick: onToggleWhy,
        }, [
          m('span.set-why-chev', { class: open ? 'is-open' : '', 'aria-hidden': 'true' }, '›'),
          'Why this matters',
        ])
        : null,
    ]),
    control ? m('.set-row-control', control) : null,
  ]),
  why && open ? m('.set-why-body', { id: id ? `${id}-why` : undefined }, why) : null,
  children ? m('.set-row-children', children) : null,
]);

/**
 * A band of rows. `safety` is the only one that is raised and ruled — see the
 * header note on why that distinction is worth a whole visual tier.
 *
 * @param {{ name: string, subtitle?: string | null, safety?: boolean, rows: any[] }} p
 */
export const settingsBand = ({ name, subtitle = null, safety = false, rows }) => m('.set-band', {
  class: safety ? 'is-safety' : '',
}, [
  m('.set-band-head', [
    // No lock glyph: the options page has no icon sprite, and an emoji lock
    // renders in colour — which the brand rule reserves for the wordmark. The
    // band's raised fill and left rule carry the distinction instead.
    m('span.set-band-name', name),
    subtitle ? m('span.set-band-sub', subtitle) : null,
  ]),
  m('.set-band-rows', rows),
]);
