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
import { settleUiEffect } from '/shared/ui-runtime-client.js';

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
   * }, state: any }} vnode
   */
  view: ({ attrs: { permission, send }, state: ui }) => {
    const mode = permission?.mode === 'act' ? 'act' : 'plan';
    // why: fail toward "confirms on" in the RENDER too — if the SW state
    // hasn't arrived yet, show the cautious reading the policy would
    // actually enforce rather than promising autonomy.
    const confirms = permission?.confirmActions !== false;
    const isAct = mode === 'act';

    const commit = async (/** @type {Record<string,unknown>} */ message) => {
      if (ui.busy) return;
      ui.busy = true;
      ui.error = '';
      m.redraw();
      try {
        const reply = await send(message);
        if (reply?.ok === false) throw new Error(reply.error ?? 'Temporarily unavailable. Try again.');
      } catch (cause) {
        ui.error = cause instanceof Error
          ? cause.message : 'Temporarily unavailable. Try again.';
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };
    /** @param {string} next */
    const setMode = (next) => settleUiEffect(commit({ type: 'permission/set', mode: next }));
    /** @param {boolean} next */
    const setConfirm = (next) => settleUiEffect(
      commit({ type: 'permission/set', confirmActions: next }),
    );

    return m('.planact', { role: 'group', 'aria-label': 'Agent permission mode' }, [
      // Mode toggle. Two buttons so the active one is obvious and each is
      // a real focus target; aria-pressed announces the state.
      m('.planact-modes', [
        m('button.planact-mode', {
          class: mode === 'plan' ? 'is-active' : '',
          disabled: ui.busy,
          'aria-pressed': String(mode === 'plan'),
          title: 'Plan — read-only + navigation. The agent can look and load URLs, but not act.',
          onclick: () => mode !== 'plan' && setMode('plan'),
        }, MODE_LABEL.plan),
        m('button.planact-mode', {
          class: mode === 'act' ? 'is-active' : '',
          disabled: ui.busy,
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
        disabled: !isAct || ui.busy,
        'aria-pressed': String(confirms),
        title: !isAct
          ? 'Switch to Act to change confirmation'
          : confirms
            ? 'Confirm actions: ON — every non-read action asks before running'
            : 'Confirm actions: OFF — the agent runs without asking, until you halt',
        onclick: () => setConfirm(!confirms),
      }, confirms ? 'Confirm: on' : 'Confirm: off'),
      ui.error ? m('p.error-line', ui.error) : null,
    ]);
  },
};

/**
 * Goal toggle. The mode-row entry point for goal mode (loop/goal-runner.js),
 * and — while a run is live — its STATE light. Three faces:
 *
 *   off      "Goal"           click arms the next message as a goal
 *   armed    "Goal: on"       click disarms (the send consumes the arm)
 *   running  "Goal · turn N"  the toggle STAYS lit for the whole run —
 *                             armed hands off to running when the run's
 *                             goal/state arrives, so launching a goal never
 *                             reads as the switch "turning itself off".
 *                             Click stops the run (same route as the
 *                             GoalBar's Stop).
 *
 * why sticky: the original one-shot arm untoggled on send, which read as
 * "did it even start?" — the control now mirrors the run's actual lifecycle
 * (owner direction 2026-07-15). Same pill family + accent as the planact
 * controls.
 *
 * attrs:
 *   armed     — whether the next send is armed to launch a goal run
 *   run       — this chat's live goal-run state (state.goalRuns[sid]) or null
 *   disabled  — no API key yet (the send it arms can't fire)
 *   onToggle  — flip handler; receives the next armed boolean
 *   onStop    — stop the live run (only consulted while running)
 */
export const GoalToggle = {
  /**
   * @param {{ attrs: {
   *   armed?: boolean,
   *   run?: { active?: boolean, iteration?: number } | null,
   *   disabled?: boolean,
   *   onToggle: (next: boolean) => void,
   *   onStop?: () => void,
   * } }} vnode
   */
  view: ({ attrs: { armed, run, disabled, onToggle, onStop } }) => {
    const running = !!run?.active;
    const on = running || !!armed;
    const label = running
      ? `Goal · turn ${run?.iteration ?? '…'}`
      : on ? 'Goal: on' : 'Goal';
    return m('button.goal-toggle', {
      class: [on ? 'is-on' : '', running ? 'is-running' : ''].filter(Boolean).join(' '),
      disabled: !!disabled && !running,
      'aria-pressed': String(on),
      // While running the click STOPS the run — put that in the accessible
      // name (the visible label is just "Goal · turn N"; aria-pressed alone
      // doesn't convey "clicking stops it").
      'aria-label': running ? `Goal run active, turn ${run?.iteration ?? ''} — activate to stop` : undefined,
      title: running
        ? 'A goal run is live in this chat — the agent keeps taking turns until '
          + 'it\'s done. Click to stop the run.'
        : on
          ? 'Goal is armed — your next message starts an autonomous run: the agent '
            + 'keeps taking turns, acting WITHOUT per-action confirmation, until the '
            + 'goal is met or you Stop. Click to disarm.'
          : 'Goal — arm the next message to run as an autonomous goal: the agent keeps '
            + 'taking turns, acting without per-action confirmation, until it\'s done or you Stop.',
      onclick: () => (running ? onStop?.() : onToggle(!on)),
    }, label);
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
      onchange: (/** @type {Event} */ e) => settleUiEffect(send({ type: 'settings/update',
        patch: { reasoningEffort: /** @type {HTMLSelectElement} */ (e.target).value } })),
    }, EFFORT_LEVELS.map((level) =>
      m('option', { value: level }, level === 'medium' ? 'effort: medium' : `effort: ${level}`)));
  },
};
