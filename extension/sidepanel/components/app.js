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
import { ActorIsolationBanner } from './actor-isolation-banner.js';
import { openOptions } from '/shared/open-options.js';
import { openHome } from '/shared/open-home.js';
import { CHANNEL } from '/shared/channel-config.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {Record<string, ((...args: any[]) => any) | undefined>} UiActions */

// Icon from the redesign mono-stroke set (sprite in sidepanel.html). why a
// helper: every chrome glyph is now one drawn symbol referenced by id, so the
// stroke inherits currentColor + theme for free and renders identically across
// platforms (the old unicode glyphs did not).
/** @param {string} name @param {number} [size] */
const icon = (name, size = 16) =>
  m('svg.ic', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    m('use', { href: `#ic-${name}` }));

export const StateRuntimeFailure = {
  /** @param {{attrs:{retry?:()=>void,lead?:any}}} vnode */
  view: ({ attrs }) => [
    attrs.lead ?? null,
    m('h2', 'Peerd is taking longer to start'),
    m('p', 'No action was run. Retry the secure background connection.'),
    m('button.primary', { type: 'button', onclick: attrs.retry }, 'Retry'),
  ],
};

export const App = {
  /**
   * @param {{ attrs: {
   *   state: ChatState, send: Send, voiceManager: any,
 *   uiActions: UiActions, view: string, optionsActive: boolean,
 *   stateFailed?: boolean, retryState?: () => void,
   *   activeTabStatus?: 'none'|'unknown'|'web'|'protected_private'|'protected_sensitive',
   * } }} vnode
   */
  view: ({ attrs }) => {
    const {
      state, send, voiceManager, uiActions, view, optionsActive, activeTabStatus,
      stateFailed, retryState,
    } = attrs;
    if (stateFailed) return m('div.app-shell', [
      null,
      m('.body', m('.placeholder', m(StateRuntimeFailure, { retry: retryState }))),
    ]);
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
    const actorIsolation = unlocked
      ? m(ActorIsolationBanner, { capability: state.capabilities?.actorExecution, send })
      : null;

    return m('div', { class: 'app-shell' }, [
      unlocked ? m(TopBar, { state, send, optionsActive }) : null,
      notices,
      actorIsolation,
      m('.body', unlocked
        ? [
            view === 'chat'   ? m(ChatView, { state, send, voiceManager, uiActions, surface: 'sidepanel', activeTabStatus })
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
        // Watch mode: bring the agent's tab to the foreground and follow it, so
        // you see the real page it's driving. Opt-in inverse of no-focus-steal;
        // active state + tooltip carry the meaning (the top bar is icon-only).
        m('button.icon', {
          class: state.settings?.watchAgentTab ? 'is-active' : '',
          'aria-label': 'Watch the agent’s tab',
          title: state.settings?.watchAgentTab
            ? 'Watching the agent’s tab — click to stop following'
            : 'Watch the agent’s tab (bring it to the front and follow along)',
          'aria-pressed': state.settings?.watchAgentTab ? 'true' : 'false',
          onclick: () => send({ type: 'settings/update', patch: { watchAgentTab: !state.settings?.watchAgentTab } }),
        }, icon('target')),
        m('button.icon', {
          'aria-label': 'Chats',
          title: 'Chats',
          onclick: () => m.route.set(
            m.route.get() === '/chats' ? '/chat' : '/chats'),
        }, icon('menu')),
        m('button.icon', {
          'aria-label': 'New chat',
          title: 'New chat',
          onclick: async () => {
            await send({ type: 'session/reset' });
            m.route.set('/chat');
          },
        }, icon('plus')),
        // Home — opens the full-tab HOME page (a primary surface, distinct from
        // Settings; focus-or-create so it doesn't pile up duplicate tabs).
        m('button.icon', {
          'aria-label': 'Home',
          title: 'Home',
          onclick: () => openHome(),
        }, icon('home')),
        // why: settings + context (memory/activity/denylist/skills/hooks)
        // moved to the full-tab options page — the panel is the pure
        // conversation surface. One ⚙ replaces the old ▤/⚙ pair;
        // openOptions() focuses an existing options tab via
        // runtime.openOptionsPage rather than opening duplicates.
        // §5g: manual lock, back in the panel too - stepping away happens
        // wherever you are, and a lock you have to open another surface to
        // reach is a lock that doesn't get used. Same route as the Home
        // rail's; the SW pushes locked state and the panel flips to the gate.
        m('button.icon', {
          'aria-label': 'Lock the vault',
          title: 'Lock the vault',
          onclick: () => send({ type: 'vault/lock' }),
        }, icon('lock')),
        m('button.icon', {
          'aria-label': 'Settings',
          title: 'Settings',
          onclick: () => openOptions(),
        }, icon('set')),
        // Close the panel. The toolbar action OPENS peerd (the side panel by
        // default, or Home via the frontDoorView setting) — only Chrome's
        // native action-click toggle ever closes it — so the panel keeps its
        // own dismiss; this reuses the SW's sidepanel/close (disable+re-arm;
        // Chrome-only, no-op on Firefox's sidebar).
        m('button.icon', {
          'aria-label': 'Close panel',
          title: 'Close panel',
          onclick: () => send({ type: 'sidepanel/close' }),
        }, icon('x')),
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
 * @typedef {{ id: number, text?: string, action?: { kind?: string, label?: string, url?: string } | null }} Notice
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
        // open-url: the SW attaches an https link (e.g. the preview
        // update's XPI - background/update-check.js). The click IS the user
        // gesture the target flow needs, so no SW round-trip: open the tab
        // from here. https only, checked again at render (defense in depth -
        // the SW already validates the feed's link).
        n.action?.kind === 'open-url' && n.action.url?.startsWith('https://')
          ? m('button.notice-action', {
              type: 'button',
              onclick: () => { window.open(n.action?.url, '_blank', 'noopener'); },
            }, n.action.label ?? 'Open')
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
// non-read action), OR for a persistent code or memory write (the always-on
// lethal-trifecta gates, which render the exact proposed contents). Three answers map to
// the ConfirmAnswer union the dispatcher expects: yes_once / yes_session
// / no. Reuses the .peerd-modal styling.
/** @type {Record<string, string>} */
const ACTION_CLASS_LABEL = {
  workspace_write: 'a workspace write',
  shell: 'a code-execution',
  external: 'a side-effecting',
};

// The session button says WHAT a standing grant covers (UI redesign §4d): the
// noun comes from the action class the prompt already carries, and the scope
// line mirrors confirm-grant-key.js - origin present → the grant is bound to
// that origin; absent → it really does cover any site this chat touches. A
// user who reads "for session" as "for this site" approves once and stops
// being asked everywhere; the label was the only place to catch that.
/** @type {Readonly<Record<string, string>>} */
const ACTION_CLASS_GRANT_NOUN = Object.freeze({
  workspace_write: 'writes',
  shell: 'code runs',
  external: 'actions',
});
/** @param {ConfirmPrompt} prompt */
const sessionGrantNoun = (prompt) => (prompt.actionClass ? ACTION_CLASS_GRANT_NOUN[prompt.actionClass] : undefined)
  ?? (prompt.kind === 'web_write' ? 'writes' : 'actions');
/** @param {string[]} origins */
const sessionGrantScope = (origins) => `this chat, ${origins.length ? 'this site' : 'any site'}`;

/** @type {Readonly<Record<string, string>>} */
const SITE_AUTH_LABEL = Object.freeze({
  session: 'a signed-in browser session was observed',
  bearer: 'token authentication was observed; no credential is stored in this client',
  none: 'no authentication was observed',
  unknown: 'authentication could not be determined',
});

/** @type {Readonly<Record<string, string>>} */
const SITE_DERIVER_LABEL = Object.freeze({
  probe: 'learned by probing the site',
  'capture-cdp': 'learned from observed site requests',
  'capture-tap': 'learned from observed site requests',
});

/**
 * The confirmation is the authority boundary, so opening it must move keyboard
 * and screen-reader attention into the dialog and keep it there until answered.
 * @param {(answer: string) => void} answer
 * @param {{ returnFocus?: HTMLElement | null }} state
 */
const confirmationDialogAttrs = (answer, state) => {
  /** @param {{ dom: Element }} vnode */
  const oncreate = ({ dom }) => {
    state.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = /** @type {HTMLElement} */ (dom);
    const reject = /** @type {HTMLElement | null} */ (dialog.querySelector('[data-confirm-reject]'));
    (reject ?? dialog).focus();
  };
  /** @param {KeyboardEvent} event */
  const onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      answer('no');
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = /** @type {HTMLElement} */ (event.currentTarget);
    const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'peerd-confirm-title',
    tabindex: -1,
    oncreate,
    onkeydown,
    onremove: () => state.returnFocus?.focus(),
  };
};

/**
 * A pending confirmation prompt broadcast by the SW dispatcher.
 * @typedef {Object} ConfirmPrompt
 * @property {string} id
 * @property {string} [kind]
 * @property {{
 *   op: string, header?: string, addedLines?: number, removedLines?: number,
 *   body?: string, prevBody?: string, bodyBytesBefore?: number, bodyBytesAfter?: number,
 *   dossier?: { origin?: string, summary?: string, endpoints?: Array<{ method?: string, path?: string }>, auth?: string, deriver?: string },
 *   endpointDelta?: { added?: number, removed?: number },
 * }} [proposal]
 * @property {string} [actionClass]
 * @property {string} [sideEffect]
 * @property {string} [summary]
 * @property {string} [note]   why this call is being confirmed when the reason
 *   is something other than the ordinary Plan/Act policy, such as a UGC-zone
 *   override or a repeat after an unknown outcome. Plain prose, rendered verbatim.
 * @property {string} [lifecycleTarget] immutable target bound to an
 *   unknown-outcome repeat approval; never derived from the current live tab
 * @property {boolean} [oneShot] this approval cannot read or create a standing
 *   session grant; used for exact unknown-outcome repeats
 * @property {boolean} [ephemeral]  this answer cannot become a standing grant —
 *   DESIGN-17 downgrades an actor's yes_session to yes_once. Set by the SW so
 *   the card does not offer a button that would do nothing.
 * @property {string} [tool]
 * @property {string | null} [sessionId] exact execution session
 * @property {string | null} [ownerSessionId] root chat that owns the prompt
 * @property {string | null} [dispatchId] exact tool dispatch being approved
 * @property {string[]} [origins]
 * @property {'passkey'|'sso'} [method]   login only: the sign-in method the
 *   `login` tool derived from the page (ground truth, not a model argument).
 * @property {string | null} [provider]   login only: the SSO provider name for a
 *   'sso' method (e.g. 'Google'); null/absent for a passkey.
 * @property {boolean} [verified]   login only: the DESTINATION was proven a known
 *   IdP (an href/formAction host passing isKnownIdp). false for a recognized-name-
 *   only sso — the card must then NOT vouch for where the button leads.
 * @property {string | null} [idpOrigin] login only: the exact system-derived IdP
 *   origin authorized by a verified SSO confirmation.
 * @property {number} [raisedAt]  when the coordinator raised the prompt - the
 *   90s hint times against this so replayed prompts share the real deadline.
 */

/**
 * @typedef {Object} ConfirmModalState
 * @property {HTMLElement | null} [returnFocus]
 * @property {string} [hintPromptId]
 * @property {boolean} [showTimeoutHint]
 * @property {ReturnType<typeof setTimeout>} [timeoutHintTimer]
 */
// Exported so the full-page home renders the SAME permission prompt (DESIGN-12
// full equality) — a confirm broadcast must be answerable on whichever surface
// is open, not just the side panel.
// The 90-second hint (§4e): a quiet line before the 120s auto-deny - NOT a
// countdown, which would turn a security decision into a timed exam. Timed
// from raisedAt so a late-joining surface (replay) hints on the same clock.
// why armed per PROMPT ID, not oninit: the modal is mounted unkeyed and the
// reducer overwrites pendingConfirm in place, so a second prompt can replace
// the first without a remount - it must get its own timer on its own clock,
// never inherit the previous prompt's.
/** @param {ConfirmModalState} state @param {ConfirmPrompt} prompt */
const armTimeoutHint = (state, prompt) => {
  if (state.hintPromptId === prompt.id) return;
  state.hintPromptId = prompt.id;
  if (state.timeoutHintTimer) clearTimeout(state.timeoutHintTimer);
  const raisedAt = typeof prompt.raisedAt === 'number' ? prompt.raisedAt : Date.now();
  const delay = Math.max(0, raisedAt + 90_000 - Date.now());
  state.showTimeoutHint = delay === 0;
  state.timeoutHintTimer = setTimeout(() => {
    state.showTimeoutHint = true;
    m.redraw();
  }, delay);
};

export const ConfirmModal = {
  /** @param {{ state: ConfirmModalState }} vnode */
  onremove(vnode) {
    if (vnode.state.timeoutHintTimer) clearTimeout(vnode.state.timeoutHintTimer);
  },
  /** @param {{ attrs: { prompt: ConfirmPrompt, uiActions?: UiActions }, state: ConfirmModalState }} vnode */
  view: (vnode) => {
    const { prompt, uiActions } = vnode.attrs;
    const dialogState = /** @type {ConfirmModalState} */ (vnode.state);
    armTimeoutHint(dialogState, prompt);
    const timeoutHint = dialogState.showTimeoutHint
      ? m('p.muted.confirm-timeout-hint', { role: 'status' }, 'No answer counts as Reject.')
      : null;
    /** @param {string} a */
    const answer = (a) => uiActions?.confirmAnswer?.(prompt, a);
    const origins = Array.isArray(prompt.origins) ? prompt.origins.filter(Boolean) : [];
    const lifecycleTarget = typeof prompt.lifecycleTarget === 'string'
      && prompt.lifecycleTarget.length > 0
      ? prompt.lifecycleTarget
      : null;

    // Login consent — its own render path, because a sign-in is the highest-stakes
    // confirm we show and it needs a distinctive, obvious card. The real origin is
    // the HERO (the anti-phishing anchor the user checks); the method/provider come
    // from the login tool's ground-truth classifier (never a model string), so the
    // card cannot be spoofed. No "Allow for session" — every login is fresh consent.
    if (prompt.kind === 'login') {
      const origin = origins[0] || '';
      let host = origin;
      try { host = new URL(origin).host || origin; } catch { /* malformed → show the raw origin */ }
      // The origin is the anti-phishing HERO — it must never be BLANK on an approvable
      // card. The tool guarantees an https origin, but the modal is shared, so guard
      // defensively: label a blank origin and DISABLE the primary action (nothing to
      // approve without a verified destination to name).
      const blankOrigin = !host;
      if (!host) host = 'an unverified site';
      const isPasskey = prompt.method === 'passkey';
      const provider = prompt.provider ? String(prompt.provider) : '';
      // An UNVERIFIED sso: peerd took origin-named consent but could NOT prove the
      // button leads to a known IdP. Soften the copy — keep the origin hero, but do
      // not vouch for the destination.
      const unverified = prompt.method === 'sso' && prompt.verified === false;
      const idpOrigin = prompt.method === 'sso' && prompt.verified === true
        ? String(prompt.idpOrigin ?? '')
        : '';
      let idpHost = '';
      try { idpHost = new URL(idpOrigin).host; } catch { /* malformed means no approvable verified destination */ }
      const missingVerifiedDestination = prompt.method === 'sso' && prompt.verified === true && !idpHost;
      return m('.peerd-modal-backdrop', [
        m('.peerd-modal.confirm-modal.login-modal', confirmationDialogAttrs(answer, dialogState), [
          m('h3#peerd-confirm-title', 'Approve sign-in'),
          m('.login-hero', [
            m('.badge', icon('lock', 18)),
            m('.ht', [
              m('.scheme', 'peerd is signing you in to'),
              m('.host', host),
            ]),
          ]),
          m('.login-method', [
            m('.mic', icon(isPasskey ? 'key' : 'globe', 15)),
            isPasskey
              ? 'Continue with a passkey'
              : unverified
                ? `Continue with ${provider || 'your provider'} — peerd could not verify where this leads`
                : `Continue with ${provider || 'your provider'}`,
          ]),
          idpHost ? m('.login-destination', [
            m('span', 'Provider page'),
            m('strong', idpHost),
          ]) : null,
          m('.login-reassure', [
            m('.ok', icon('check', 15)),
            m('span', unverified
              ? `peerd never sees your password and could not confirm this button’s destination — only continue if you trust ${host}. You finish signing in yourself.`
              : `peerd never sees your password. You finish signing in yourself — with your device${provider ? ` or ${provider}` : ''}.`),
          ]),
          timeoutHint,
          m('.peerd-modal-actions', [
            m('button.secondary', { type: 'button', 'data-confirm-reject': '', onclick: () => answer('no') }, 'Cancel'),
            m('button', {
              type: 'button',
              disabled: blankOrigin || missingVerifiedDestination,
              onclick: () => { if (!blankOrigin && !missingVerifiedDestination) answer('yes_once'); },
            }, 'Allow sign-in'),
          ]),
        ]),
      ]);
    }
    // why: persistent writes render the exact proposed bytes so the user
    // approves the executable or remembered contents, not a summary of them.
    const isMemory = prompt.kind === 'memory_write' && prompt.proposal;
    const isSiteClient = prompt.kind === 'site_client_write' && prompt.proposal;
    // why non-null in either branch: both are only truthy when
    // prompt.proposal exists, so reads of `p` there are always defined.
    const p = /** @type {NonNullable<ConfirmPrompt['proposal']>} */ (prompt.proposal);
    // For non-memory prompts, prefer the Plan/Act policy's action class for
    // the wording; fall back to the raw sideEffect for older prompts.
    const kind = (prompt.actionClass ? ACTION_CLASS_LABEL[prompt.actionClass] : undefined)
      ?? (prompt.sideEffect === 'mutate_external' ? 'a side-effecting' : 'a page');
    return m('.peerd-modal-backdrop', [
      m('.peerd-modal.confirm-modal', confirmationDialogAttrs(answer, dialogState), [
        m('h3#peerd-confirm-title', isMemory ? 'Confirm memory write' : isSiteClient ? 'Confirm site client' : 'Confirm action'),
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
          : isSiteClient
            ? p.op === 'delete'
              ? [
                  m('p.muted', { style: 'margin:0 0 8px;' },
                    `The agent wants to delete the saved site client for ${p.dossier?.origin || origins[0] || 'this site'}.`),
                  m('pre.confirm-summary', { 'aria-label': 'Site-client deletion' },
                    '(this deletes the saved runnable module and dossier)'),
                ]
              : [
                  m('p.muted', { style: 'margin:0 0 8px;' },
                    p.op === 'update'
                      ? `The agent wants to update runnable JavaScript that persists across sessions. Endpoints change by +${p.endpointDelta?.added ?? 0}/-${p.endpointDelta?.removed ?? 0}.`
                      : `The agent wants to create runnable JavaScript that persists across sessions with ${p.dossier?.endpoints?.length ?? 0} declared endpoint(s).`),
                  m('.site-client-dossier', [
                    m('strong', 'Purpose'),
                    m('p', p.dossier?.summary || '(no purpose provided)'),
                    m('strong', 'Access'),
                    m('p', `${SITE_AUTH_LABEL[p.dossier?.auth ?? ''] || 'authentication mode is not recognized'}; ${SITE_DERIVER_LABEL[p.dossier?.deriver ?? ''] || 'learning method is not recognized'}`),
                    m('strong', 'Endpoints'),
                    m('pre.confirm-summary', { 'aria-label': 'Proposed site-client endpoints' },
                      p.dossier?.endpoints?.length
                        ? p.dossier.endpoints.map((endpoint) => `${endpoint.method || '?'} ${endpoint.path || '?'}`).join('\n')
                        : '(no endpoints declared)'),
                  ]),
                  p.op === 'update'
                    ? [
                        m('strong', 'Existing runnable JavaScript'),
                        m('pre.confirm-summary',
                          { style: 'max-height:160px; overflow:auto; white-space:pre-wrap;',
                            'aria-label': 'Existing site-client code' },
                          p.prevBody || '(empty)'),
                      ]
                    : null,
                  m('strong', p.op === 'update' ? 'Proposed runnable JavaScript' : 'Runnable JavaScript'),
                  m('pre.confirm-summary',
                    { style: 'max-height:240px; overflow:auto; white-space:pre-wrap;',
                      'aria-label': 'Proposed site-client code' },
                    p.body || '(empty)'),
                ]
            : prompt.tool === 'a2a_contact' || prompt.tool === 'a2a_reply'
            ? [
                m('p.muted', { style: 'margin:0 0 8px;' },
                  prompt.tool === 'a2a_reply'
                    ? 'Your dweb agent wants to REPLY to this peer over the mesh, continuing your conversation. "Allow for session" lets it keep replying on this thread (revoke by blocking the peer).'
                    : 'Your dweb agent wants to MESSAGE this peer on the mesh for the first time. "Allow for session" adds them as an approved contact (revoke by blocking the peer).'),
              ]
            : [
              m('p.muted', { style: 'margin:0 0 8px;' },
                `The agent wants to run ${kind} action.`),
              // why: an optional one-sentence reason, shown only when the
              // confirm was forced by something OTHER than the ordinary
              // Plan/Act policy — today the #242 UGC-zone rule. It sits ABOVE
              // the call summary because it is the part the user has to weigh;
              // the summary is the detail. Absent → the card renders exactly as
              // it always has.
              prompt.note
                ? m('p.muted', { style: 'margin:0 0 8px;' }, prompt.note)
                : null,
              lifecycleTarget
                ? m('.lifecycle-confirm-target', {
                    'aria-label': 'Unknown-outcome repeat approval',
                  }, [
                    m('span', 'Exact target'),
                    m('code', lifecycleTarget),
                    m('span', 'Action'),
                    m('code', prompt.tool || 'unknown tool'),
                  ])
                : null,
              m('pre.confirm-summary', prompt.summary ?? prompt.tool),
            ],
        origins.length
          ? m('p.muted', { style: 'font-size:12px;' }, `On: ${origins.join(', ')}`)
          : null,
        // The absence is explained, not offered (§4d): when a helper raised the
        // prompt the session button is correctly hidden - but hidden SILENTLY,
        // the user cannot tell a missing option from a missing feature.
        // "content", not the design's "pages": ephemeral covers EVERY actor
        // kind - a Notebook or VM helper is steered by instance output, not
        // pages - and the sentence must stay true for all of them.
        prompt.ephemeral
          ? m('p.muted.confirm-ephemeral-note',
              'A helper asked for this, and a helper can be steered by the content it reads - so this one can only be approved a single time.')
          : null,
        timeoutHint,
        m('.peerd-modal-actions', [
          m('button.secondary', { type: 'button', 'data-confirm-reject': '', onclick: () => answer('no') }, 'Reject'),
          // why prompt.ephemeral hides it rather than disabling it: an actor's
          // yes_session is downgraded to yes_once server-side (DESIGN-17 — an
          // actor can be steered by untrusted output across turns, so a standing
          // grant would silence the next prompt). Offering the button anyway
          // gives the user a control that reads as "stop asking me" and does
          // nothing — worse than not offering it, because they stop looking for
          // another way out. The quiet line above the actions says WHY it is
          // missing. a2a keeps the legacy label: its grant is peer-scoped and
          // the body copy explains it by that name. A oneShot lifecycle
          // confirm never offers a standing grant either.
          isMemory || isSiteClient || prompt.ephemeral || prompt.oneShot
            ? null
            : prompt.tool === 'a2a_contact' || prompt.tool === 'a2a_reply'
              ? m('button.secondary', { type: 'button', onclick: () => answer('yes_session') }, 'Allow for session')
              : m('button.secondary.confirm-session-grant', { type: 'button', onclick: () => answer('yes_session') }, [
                  `Allow all ${sessionGrantNoun(prompt)}`,
                  m('span.confirm-grant-scope', sessionGrantScope(origins)),
                ]),
          m('button', {
            type: 'button',
            class: prompt.oneShot ? 'lifecycle-confirm-allow' : '',
            onclick: () => answer('yes_once'),
          },
            isMemory ? 'Save' : isSiteClient ? (p.op === 'delete' ? 'Delete client' : 'Save client') : 'Allow once'),
        ]),
      ]),
    ]);
  },
};
