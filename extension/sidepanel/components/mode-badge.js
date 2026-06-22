// @ts-check
// Plan/Act mode UI.
//
//   ModeSelector  — the PLAN/ACT permission selector (Feature 03). Plan =
//                   read-only; Act = writes allowed, with a single
//                   "Confirm actions" toggle controlling whether each
//                   non-read action asks first (the 2026-06-12 tier
//                   collapse — the old suggest/full-auto endpoints kept,
//                   the auto-edit middle removed). Interactive: clicking
//                   flips mode / the toggle mid-session via the SW.
//   EffortDial    — the reasoning-effort selector (Anthropic
//                   output_config.effort). Lives in the mode row by owner
//                   call: "act sooner vs think deeper" is a per-task dial,
//                   so it belongs where turns happen, not buried in
//                   Settings. Writes the GLOBAL settings.reasoningEffort
//                   (the same value the Settings page edits — one source
//                   of truth); the SW snapshots settings at turn start, so
//                   a change applies from the next message.

import m from '/vendor/mithril/mithril.js';

/**
 * Typed message sender — posts to the SW and resolves with its reply.
 * @typedef {(msg: object) => Promise<any>} Send
 */

const MODE_LABEL = { plan: 'Plan', act: 'Act' };

/**
 * The Plan/Act control. A mode toggle (Plan ⇄ Act) plus a confirm-actions
 * toggle. Always visible in the top bar; reflects state.session.
 * permission and drives `permission/set` on change — the SAME route the
 * Settings "Confirm before actions" toggle uses, so there is exactly one
 * source of truth for the confirm setting. Keyboard-operable (native
 * buttons); honors prefers-reduced-motion via CSS (the pill transitions
 * are CSS-driven, gated globally in styles.css).
 *
 * attrs:
 *   permission { mode, confirmActions }  — current, from SW state
 *   send                                 — typed message sender returning a Promise
 */
export const ModeSelector = {
  /**
   * @param {{ attrs: {
   *   permission?: { mode?: string, confirmActions?: boolean } | null,
   *   send: Send,
   * } }} vnode
   */
  view: ({ attrs: { permission, send } }) => {
    const mode = permission?.mode === 'act' ? 'act' : 'plan';
    // why: fail toward "confirms on" in the RENDER too — if the SW state
    // hasn't arrived yet, show the cautious reading the policy would
    // actually enforce rather than promising autonomy.
    const confirms = permission?.confirmActions !== false;
    const isAct = mode === 'act';

    /** @param {string} next */
    const setMode = (next) => send({ type: 'permission/set', mode: next });
    /** @param {boolean} next */
    const setConfirm = (next) => send({ type: 'permission/set', confirmActions: next });

    return m('.planact', { role: 'group', 'aria-label': 'Agent permission mode' }, [
      // Mode toggle. Two buttons so the active one is obvious and each is
      // a real focus target; aria-pressed announces the state.
      m('.planact-modes', [
        m('button.planact-mode', {
          class: mode === 'plan' ? 'is-active' : '',
          'aria-pressed': String(mode === 'plan'),
          title: 'Plan — read-only + navigation. The agent can look and load URLs, but not act.',
          onclick: () => mode !== 'plan' && setMode('plan'),
        }, MODE_LABEL.plan),
        m('button.planact-mode', {
          class: mode === 'act' ? 'is-active' : '',
          'aria-pressed': String(mode === 'act'),
          title: 'Act — writes allowed. "Confirm" controls whether each action asks first.',
          onclick: () => mode !== 'act' && setMode('act'),
        }, MODE_LABEL.act),
      ]),
      // Confirm-actions toggle — only meaningful in Act (Plan blocks
      // instead of confirming). Rendered disabled in Plan so the layout
      // doesn't jump and the user sees the setting their Act will resume
      // in. Same state as the Settings "Confirm before actions" toggle.
      m('button.planact-confirm', {
        class: confirms ? 'is-on' : '',
        disabled: !isAct,
        'aria-pressed': String(confirms),
        title: !isAct
          ? 'Switch to Act to change confirmation'
          : confirms
            ? 'Confirm actions: ON — every non-read action asks before running'
            : 'Confirm actions: OFF — the agent runs without asking, until you halt',
        onclick: () => setConfirm(!confirms),
      }, confirms ? 'Confirm: on' : 'Confirm: off'),
    ]);
  },
};

/**
 * Loop arming toggle. The mode-row entry point for the Ralph persistent
 * loop (peerd-runtime/ralph). Until now a loop could only be launched by
 * typing the undiscoverable `/loop [goal]` slash command; this surfaces it
 * beside Plan/Act. It is NOT a synchronous state flip like Plan/Act — a
 * loop is "launch a background run WITH a goal" — so the toggle ARMS the
 * next send: while ON, sending sends the draft as the loop's goal (the
 * InputBar routes it through the same /loop path) and the toggle disarms.
 * The running loop then surfaces in its own RalphPanel, which owns the
 * stop/status half. Same pill family + accent-when-active as the planact
 * controls (owner call for this row).
 *
 * attrs:
 *   armed     — whether the next send is armed to launch a loop
 *   disabled  — no API key yet (the send it arms can't fire)
 *   onToggle  — flip handler; receives the next armed boolean
 */
export const LoopToggle = {
  /**
   * @param {{ attrs: {
   *   armed?: boolean,
   *   disabled?: boolean,
   *   onToggle: (next: boolean) => void,
   * } }} vnode
   */
  view: ({ attrs: { armed, disabled, onToggle } }) => {
    const on = !!armed;
    return m('button.loop-toggle', {
      class: on ? 'is-on' : '',
      disabled: !!disabled,
      'aria-pressed': String(on),
      title: on
        ? 'Loop is armed — your next message starts an autonomous loop on that goal '
          + '(plan → build → repeat). Click to disarm.'
        : 'Loop — arm the next message to run as an autonomous loop '
          + '(plan → build → repeat) instead of a single turn.',
      onclick: () => onToggle(!on),
    }, on ? 'Loop: on' : 'Loop');
  },
};

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Reasoning-effort dial. A compact pill select matching the planact
 * controls; 'medium' is the build default (owner call 2026-06-12 — long
 * invisible deliberation reads as a hang in a browser harness; raise the
 * dial for hard tasks).
 *
 * attrs:
 *   settings  — current settings from SW state (reads reasoningEffort)
 *   send      — typed message sender returning a Promise
 */
export const EffortDial = {
  /**
   * @param {{ attrs: {
   *   settings?: { reasoningEffort?: string } | null,
   *   send: Send,
   * } }} vnode
   */
  view: ({ attrs: { settings, send } }) => {
    const effort = settings?.reasoningEffort;
    const current = effort !== undefined && EFFORT_LEVELS.includes(effort)
      ? effort
      : 'medium';
    return m('select.effort-dial', {
      'aria-label': 'Reasoning effort',
      title: 'Reasoning effort — how long the agent deliberates before acting.\n'
        + 'Lower = earlier visible action; higher = deeper thinking on hard tasks.\n'
        + 'Applies from the next message.',
      value: current,
      onchange: (/** @type {Event} */ e) => send({ type: 'settings/update',
        patch: { reasoningEffort: /** @type {HTMLSelectElement} */ (e.target).value } }),
    }, EFFORT_LEVELS.map((level) =>
      m('option', { value: level }, level === 'medium' ? 'effort: medium' : `effort: ${level}`)));
  },
};
