// @ts-check
// Top-level App component.
//
// Dispatches between views based on attrs.view (passed in from the
// router). All components are pure projections of attrs — no internal
// mutable state beyond UI-ephemeral concerns like "is this input
// focused" (which the DOM tracks for us anyway).

import m from '/vendor/mithril/mithril.js';
import { VaultGate } from './vault-gate.js';
import { ChatView } from './chat-view.js';
import { SessionsView } from './sessions-view.js';
import { openOptions } from '/shared/open-options.js';
import { openHome } from '/shared/open-home.js';
import { CHANNEL } from '/shared/channel-config.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {Record<string, ((...args: any[]) => any) | undefined>} UiActions */

export const App = {
  /**
   * @param {{ attrs: {
   *   state: ChatState, send: Send, voiceManager: any,
   *   uiActions: UiActions, view: string, optionsActive: boolean,
   *   activeTabIsWeb?: boolean,
   * } }} vnode
   */
  view: ({ attrs }) => {
    const { state, send, voiceManager, uiActions, view, optionsActive, activeTabIsWeb } = attrs;
    const unlocked = state.vault.initialized && !state.vault.locked;
    // First-run onboarding is a HOME-page blocker (home.js), not a side-panel
    // route — the panel is reached by popping it from an onboarded home.

    // why: ONE app-shell with a stable `.body` at position 1. The header
    // sits at position 0 and is `null` until unlocked — so the lock /
    // sign-up screen has no header logo at all (the big "manifest" hero
    // logo in the vault gate is the only brand mark there). When the
    // vault unlocks, the TopBar mounts FRESH, which makes its wordmark
    // type itself in with the same intro animation as the hero. Keeping
    // `.body` at a fixed position means the unlock transition patches it
    // in place instead of tearing it down and flashing.
    // Confirmation prompt overlay. Present only when confirmations are
    // enabled (Settings) AND a non-read action is waiting on the user.
    const confirm = unlocked && state.pendingConfirm
      ? m(ConfirmModal, { prompt: state.pendingConfirm, uiActions })
      : null;

    // Transient system notices (e.g. /init progress). Dismissible; no
    // animation so prefers-reduced-motion is respected by default.
    const notices = unlocked && state.notices?.length
      ? m(NoticeBar, { notices: state.notices, uiActions })
      : null;

    return m('div', { class: 'app-shell' }, [
      unlocked ? m(TopBar, { state, send, optionsActive }) : null,
      notices,
      m('.body', unlocked
        ? [
            view === 'chat'   ? m(ChatView, { state, send, voiceManager, uiActions, surface: 'sidepanel', activeTabIsWeb })
            : view === 'chats'  ? m(SessionsView, { state, send })
            : m(PlaceholderView, { label: 'Unknown view' }),
          ]
        : m(VaultGate, { state, send })),
      confirm,
    ]);
  },
};

/**
 * Inline brand wordmark — five colored blocks matching peerd.ai. The
 * blocks abut (no gap); outer corners are rounded via CSS. The
 * letters are lowercase mono and inherit white from `.block`. Same
 * construction as the website's hero/nav wordmark, scaled down to
 * fit the side-panel top bar (22px blocks by default).
 *
 * `aria-label="peerd"` so screen readers announce the brand without
 * spelling out the per-letter spans.
 *
 * On first mount it plays the two-phase "manifest" intro from peerd.ai:
 * the letters type out left-to-right behind a terminal cursor, then the
 * blocks colorize. Pure CSS, runs once — the router now diffs the header in
 * place across /chat↔/chats (Root is one shared component), so this node is
 * never recreated on a tab switch and the intro doesn't replay.
 *
 * It also HANDS OFF to the options page: driven by the explicit
 * `optionsActive` state (is the options tab foregrounded), it plays a
 * reverse-order "self-delete" (`.wordmark--exit`) when you open Settings and
 * renders back in (`.wordmark--enter`) when you leave — so the brand appears
 * to shift to the full-tab page rather than be duplicated. A closure
 * component holds the phase so an unrelated redraw never restarts the
 * animation; only a real optionsActive transition does. Respects
 * prefers-reduced-motion (the CSS collapses every phase to the final state).
 */
const Wordmark = () => {
  /** @type {boolean|undefined} */
  let prevActive;          // undefined until the first view
  let phase = 'intro';     // intro | exit | enter | gone
  return {
    /** @param {{ attrs: { optionsActive?: boolean } }} vnode */
    view: ({ attrs }) => {
      const active = !!attrs.optionsActive;
      if (prevActive === undefined) phase = active ? 'gone' : 'intro';
      else if (active !== prevActive) phase = active ? 'exit' : 'enter';
      // else: unchanged since last redraw — keep phase so the CSS animation
      // for it isn't interrupted by an unrelated redraw.
      prevActive = active;
      return m(`.wordmark.wordmark--${phase}`, { 'aria-label': 'peerd', role: 'img' }, [
        m('.block.b-p',  'p'),
        m('.block.b-e',  'e'),
        m('.block.b-e2', 'e'),
        m('.block.b-r',  'r'),
        m('.block.b-d',  'd'),
        // Terminal cursor that leads the typing in phase 1, then fades out
        // before the colorize phase. Decorative — hidden from a11y tree.
        m('.wordmark-cursor', { 'aria-hidden': 'true' }),
      ]);
    },
  };
};

const TopBar = {
  /** @param {{ attrs: { state: ChatState, send: Send, optionsActive: boolean } }} vnode */
  view: ({ attrs: { state, send, optionsActive } }) => {
    const unlocked = state.vault.initialized && !state.vault.locked;
    return m('.topbar', [
      // Brand cluster: the preview badge sits inline to the RIGHT of the
      // wordmark, vertically centered (keeps the top bar thin). The hand-off
      // animation still drives both — the wordmark self-deletes and the
      // badge slides out together.
      m('.topbar-brand', [
        m(Wordmark, { optionsActive }),
        // Channel indicator (§12): the preview package wears a small badge so
        // nobody has to guess which peerd they're in ("why doesn't peerd
        // have the dweb" — because it's the store package). CHANNEL is a
        // build-time literal; this node is dead code in store artifacts.
        CHANNEL === 'preview'
          ? m('span.channel-badge', {
              class: optionsActive ? 'is-exiting' : '',
              title: 'peerd preview — dweb preview package',
            }, 'preview')
          : null,
      ]),
      // Spacer BEFORE the actions: brand hugs the left edge, the action icons
      // right-align (owner call, 2026-06-12).
      m('.spacer'),
      unlocked ? m('.topbar-actions', [
        m('button.icon', {
          title: 'Chats',
          onclick: () => m.route.set(
            m.route.get() === '/chats' ? '/chat' : '/chats'),
        }, '☰'),
        m('button.icon', {
          title: 'New chat',
          onclick: async () => {
            await send({ type: 'session/reset' });
            m.route.set('/chat');
          },
        }, '+'),
        // Home — opens the full-tab HOME page (a primary surface, distinct from
        // Settings; focus-or-create so it doesn't pile up duplicate tabs).
        m('button.icon', {
          title: 'Home',
          onclick: () => openHome(),
        }, '⌂'),
        // why: settings + context (memory/activity/denylist/skills/hooks)
        // moved to the full-tab options page — the panel is the pure
        // conversation surface. One ⚙ replaces the old ▤/⚙ pair;
        // openOptions() focuses an existing options tab via
        // runtime.openOptionsPage rather than opening duplicates.
        m('button.icon', {
          title: 'Settings',
          onclick: () => openOptions(),
        }, '⚙'),
        // Close the panel. The toolbar action now opens Home rather than
        // toggling the panel shut, so the panel needs its own dismiss — this
        // reuses the SW's sidepanel/close (disable+re-arm; Chrome-only, no-op
        // on Firefox's sidebar). Lock moved to the Home rail.
        m('button.icon', {
          title: 'Close panel',
          onclick: () => send({ type: 'sidepanel/close' }),
        }, '✕'),
      ]) : null,
    ]);
  },
};

const PlaceholderView = {
  /** @param {{ attrs: { label: string } }} vnode */
  view: ({ attrs: { label } }) => m('.placeholder', `${label} — coming soon`),
};

// Transient system-notice banner (e.g. /init progress). Each notice is
// dismissible. role=status + aria-live=polite so a screen reader
// announces it without stealing focus. No transition — reduced-motion
// safe by construction.
// Exported so the full-page home renders the SAME system-notice bar (DESIGN-12
// equality) — /init progress and the grant-debugger nudge must be visible
// wherever the user is, not just the side panel.
/**
 * @typedef {{ id: number, text?: string, action?: { kind?: string, label?: string } | null }} Notice
 */

export const NoticeBar = {
  /** @param {{ attrs: { notices?: Notice[], uiActions?: UiActions } }} vnode */
  view: ({ attrs: { notices, uiActions } }) => {
    // open-tab notices render as a PROMINENT card in the chat (chat-view's
    // OpenTabCards), not this thin top bar — so skip them here. If nothing else
    // remains, render nothing (no empty bar).
    const visible = (notices ?? []).filter((n) => n.action?.kind !== 'open-tab');
    if (!visible.length) return null;
    return m('.notice-bar', { role: 'status', 'aria-live': 'polite' },
      visible.map((n) => m('.notice', { key: n.id }, [
        m('span.notice-text', n.text),
        // Optional one-click action (e.g. "Turn on advanced automation",
        // which flips the advancedAutomationEnabled setting — the debugger
        // permission itself is required at install; Chrome forbids
        // optional `debugger`).
        n.action?.kind === 'grant-debugger'
          ? m('button.notice-action', {
              type: 'button',
              onclick: () => uiActions?.requestDebugger?.(n.id),
            }, n.action.label ?? 'Enable')
          : null,
        m('button.notice-dismiss', {
          type: 'button',
          'aria-label': 'Dismiss notice',
          onclick: () => uiActions?.dismissNotice?.(n.id),
        }, '×'),
      ])));
  },
};

// Confirmation prompt. Shown when the Plan/Act policy decides a non-read
// action needs the user's approval (Act mode with confirmActions ON — any
// non-read action), OR for a memory write (the always-on lethal-trifecta
// gate, which renders the proposed AGENTS.md diff). Three answers map to
// the ConfirmAnswer union the dispatcher expects: yes_once / yes_session
// / no. Reuses the .peerd-modal styling.
/** @type {Record<string, string>} */
const ACTION_CLASS_LABEL = {
  workspace_write: 'a workspace write',
  shell: 'a code-execution',
  external: 'a side-effecting',
};

/**
 * A pending confirmation prompt broadcast by the SW dispatcher.
 * @typedef {Object} ConfirmPrompt
 * @property {string} id
 * @property {string} [kind]
 * @property {{ op: string, header?: string, addedLines?: number, removedLines?: number, body?: string }} [proposal]
 * @property {string} [actionClass]
 * @property {string} [sideEffect]
 * @property {string} [summary]
 * @property {string} [tool]
 * @property {string[]} [origins]
 */
// Exported so the full-page home renders the SAME permission prompt (DESIGN-12
// full equality) — a confirm broadcast must be answerable on whichever surface
// is open, not just the side panel.
export const ConfirmModal = {
  /** @param {{ attrs: { prompt: ConfirmPrompt, uiActions?: UiActions } }} vnode */
  view: ({ attrs: { prompt, uiActions } }) => {
    /** @param {string} a */
    const answer = (a) => uiActions?.confirmAnswer?.(prompt.id, a);
    const origins = Array.isArray(prompt.origins) ? prompt.origins.filter(Boolean) : [];
    // why: memory writes (lethal-trifecta defense) render the proposed
    // AGENTS.md diff so the user approves the EXACT change, not a one-line
    // summary. The proposal carries op + the full proposed body.
    const isMemory = prompt.kind === 'memory_write' && prompt.proposal;
    // why non-null in the isMemory branch: isMemory is only truthy when
    // prompt.proposal exists, so reads of `p` there are always defined.
    const p = /** @type {NonNullable<ConfirmPrompt['proposal']>} */ (prompt.proposal);
    // For non-memory prompts, prefer the Plan/Act policy's action class for
    // the wording; fall back to the raw sideEffect for older prompts.
    const kind = (prompt.actionClass ? ACTION_CLASS_LABEL[prompt.actionClass] : undefined)
      ?? (prompt.sideEffect === 'mutate_external' ? 'a side-effecting' : 'a page');
    return m('.peerd-modal-backdrop', [
      m('.peerd-modal.confirm-modal', [
        m('h3', isMemory ? 'Confirm memory write' : 'Confirm action'),
        isMemory
          ? [
              m('p.muted', { style: 'margin:0 0 8px;' },
                `The agent wants to ${p.op} ${p.header} (+${p.addedLines}/−${p.removedLines} lines). This persists across sessions.`),
              // why: a scrollable, labelled preview of the body that will
              // be saved. Reduced-motion safe (no animation); plain pre.
              m('pre.confirm-summary',
                { style: 'max-height:240px; overflow:auto; white-space:pre-wrap;',
                  'aria-label': 'Proposed memory contents' },
                p.op === 'delete' ? '(this deletes the document)' : (p.body || '(empty)')),
            ]
          : [
              m('p.muted', { style: 'margin:0 0 8px;' },
                `The agent wants to run ${kind} action.`),
              m('pre.confirm-summary', prompt.summary ?? prompt.tool),
            ],
        origins.length
          ? m('p.muted', { style: 'font-size:12px;' }, `On: ${origins.join(', ')}`)
          : null,
        m('.peerd-modal-actions', [
          m('button.secondary', { type: 'button', onclick: () => answer('no') }, 'Reject'),
          isMemory
            ? null
            : m('button.secondary', { type: 'button', onclick: () => answer('yes_session') }, 'Allow for session'),
          m('button', { type: 'button', onclick: () => answer('yes_once') }, isMemory ? 'Save' : 'Allow once'),
        ]),
      ]),
    ]);
  },
};
