// @ts-check
// Chat view — message list + input bar + empty-state nudges.
//
// V1 surface: the chat is the primary thing the user sees once the
// vault is unlocked. Three render branches:
//   - No API key yet: nudge toward Settings.
//   - Empty session (no messages yet): a friendly placeholder.
//   - Live session: keyed message list + input bar.

import m from '/vendor/mithril/mithril.js';
import { LINUX_PATH, HTML5_PATH } from '/vendor/simple-icons/brand-paths.js';
import { manifestLabel } from '/peerd-runtime/index.js';
import { openOptions } from '/shared/open-options.js';
import { mapError, errorSettingsTarget } from '../error-display.js';
import { MessageList } from './message-list.js';
import { InputBar } from './input-bar.js';
import { ModeSelector, EffortDial, GoalToggle } from './mode-badge.js';
import { RalphPanel } from './ralph-panel.js';
import { GoalBar } from './goal-bar.js';
import { AsyncTasksBar } from './async-tasks-bar.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {Record<string, ((...args: any[]) => any) | undefined>} UiActions */

/**
 * Component-local state for ChatView.
 * @typedef {Object} ChatViewState
 * @property {boolean} goalArmed             the Goal toggle's arm state (UI-only)
 * @property {string|null|undefined} _sid    which chat the arm state belongs to
 */

/**
 * @typedef {{ state: ChatViewState, attrs: {
 *   state: ChatState, send: Send, voiceManager: any, uiActions?: UiActions,
 *   surface?: string, activeTabIsWeb?: boolean,
 * } }} ChatViewVnode
 */

export const ChatView = {
  /** @param {ChatViewVnode} vnode */
  oninit(vnode) {
    // Goal arming is pure composer intent (it just rewrites the next send
    // into the existing /loop path), so it lives here as UI-only state —
    // no SW round-trip. Reset when the chat changes (each chat owns its
    // own loop), mirroring the InputBar's per-session draft swap.
    vnode.state.goalArmed = false;
    vnode.state._sid = vnode.attrs.state?.session?.sessionId;
  },

  /** @param {ChatViewVnode} vnode */
  view: ({ attrs: { state, send, voiceManager, uiActions, surface, activeTabIsWeb }, state: ui }) => {
    const sid = state.session?.sessionId;
    if (sid !== ui._sid) { ui._sid = sid; ui.goalArmed = false; }
    const messages = state.session?.messages ?? [];
    const hasKey = state.providers?.hasKey;
    // Fingerprint of the settings that shape the model-picker options. The
    // side panel gets live settings pushes (e.g. editing the OpenRouter
    // curated set in Settings while this chat stays open), so when this key
    // moves the picker re-pulls instead of showing the options it cached on
    // mount. why include each: providerName/providerModel drive the active
    // selection + custom-model append; openrouterModels is the curated list;
    // hasKey flips which providers contribute at all.
    const modelOptionsKey = [
      state.settings?.providerName ?? '',
      state.settings?.providerModel ?? '',
      (state.settings?.openrouterModels ?? []).join(','),
      hasKey ? '1' : '0',
    ].join('|');
    const showVoiceOnboarding = !!state.settings
      && !state.settings.voiceOnboardingDismissed
      && !state.settings.voiceEnabled
      // why: only nudge once the user has gotten past the API-key
      // hurdle. Stacking onboarding cards is hostile.
      && hasKey
      && messages.length === 0;

    return m('.chat-view', [
      // Inline banner on the latest error from the SW. Sticks until a
      // new message succeeds (which sets lastError back to null via the
      // state push).
      state.lastError ? m('.error-banner', [
        m('span', mapError(state.lastError)),
        // why conditional: only offer "Open settings" when Settings can
        // actually fix it (key/auth → providers, spend limit → costs). A
        // 429/529 throttle, a network blip, or an external billing cap aren't
        // fixable here, so the banner shows the guidance copy alone instead of
        // misdirecting the user into a page that can't help (errorSettingsTarget).
        (() => {
          const target = errorSettingsTarget(state.lastError);
          return target
            ? m('button.secondary', { onclick: () => openOptions(target.section) }, 'Open settings')
            : null;
        })(),
      ]) : null,

      // Rate-limit retry indicator. Without this the retry is a blank
      // spinner — the user thinks it's broken and keeps re-sending (which
      // aborts the retry), so the error never surfaces. Make it loud.
      state.rateLimit ? m('.rate-limit-banner', [
        m('span.rl-spinner', { 'aria-hidden': 'true' }, '⏳'),
        m('span',
          `Rate limited — retrying${state.rateLimit.attempt ? ` (attempt ${state.rateLimit.attempt})` : ''}. `
          + 'Hang tight; sending another message cancels the retry. If this keeps up, '
          + 'your provider account may be over its usage or credit limit.'),
      ]) : null,

      // Ralph persistent-loop status (peerd-runtime/ralph). The driver
      // was already pushing loop state to the panel; this renders it.
      // Self-hides unless a run is live (or just ended this lifetime).
      m(RalphPanel, { ralph: state.ralph, send }),

      // Goal mode (the mode-row Goal toggle) — a persistent "running · turn N ·
      // Stop" bar while an autonomous goal run is live. Self-hides otherwise.
      m(GoalBar, { goal: state.goal, send }),

      // In-flight async subagents (DESIGN-11). Pinned + self-hiding: the agent
      // can fire background subagents whose results land later as wake turns,
      // so this shows what's still cooking. Keyed to the ACTIVE session —
      // background chats run their own; the panel mirrors only the viewed one.
      m(AsyncTasksBar, { tasks: state.asyncTasks?.[state.session?.sessionId ?? ''] ?? [] }),

      showVoiceOnboarding ? m(VoiceOnboardingCard, { send }) : null,

      messages.length === 0 ? m(EmptyState, { hasKey, send, surface, activeTabIsWeb })
        : m(MessageList, {
            messages,
            vmStreams: state.vmStreams,
            // The AI peer's display name (default profile, set during
            // onboarding) — labels assistant rows, and ONLY there.
            peerName: state.profile?.peerName,
            // subagent nested-transcript wiring (docs/SUBAGENTS.md)
            subagents: state.subagents,
            loadSubagent: uiActions?.loadSubagent,
            // "peerd opened a tab" notices render INLINE in the transcript at the
            // turn they happened (and fade into the backlog as the chat continues)
            // — not a bright sticky footer. Filtered to this session.
            tabEvents: (state.agentTabEvents ?? []).filter((e) => e.sessionId === state.session?.sessionId),
            uiActions,
          }),

      // Per-chat model picker, above the composer. Available at all times —
      // on a fresh chat it sets provider+model for the next send; mid-session
      // it switches the model on THIS session (model-only, same provider). The
      // component self-hides unless there are 2+ choices.
      hasKey ? m(ModelPicker, { send, sessionId: state.session?.sessionId, optionsKey: modelOptionsKey }) : null,

      // Feature 03: the Plan/Act permission selector. Lives in the chat
      // context (not the global header — the TopBar is icon-budget-bound)
      // right above the input, where the authority it grants is exercised.
      m('.chat-mode-row', [
        m(ModeSelector, { permission: state.session?.permission, send }),
        // Reasoning-effort dial — same control family as Plan/Act ("how
        // the agent works"), so it sits beside it. Hidden while reasoning
        // is off AND on chats whose provider can't honor effort (only the
        // Anthropic adapter forwards it — OpenRouter ignores the reasoning
        // object entirely today, Ollama has no effort concept): a dial
        // that silently does nothing is a lie. Fresh chats read the
        // SELECTED provider (what the session will bind to on first send).
        state.settings?.reasoningEnabled
            && (state.session?.provider ?? state.providers?.current) === 'anthropic'
          ? m(EffortDial, { settings: state.settings, send })
          : null,
        // Goal arming — the first in-chat entry point for the Ralph loop
        // (it was previously reachable only via the hidden `/loop` command).
        // Arms the NEXT send to launch an autonomous goal run; the InputBar
        // consumes the arm and disarms. Greyed until there's a key (the send
        // it arms needs one).
        m(GoalToggle, {
          armed: ui.goalArmed,
          disabled: !hasKey,
          onToggle: (/** @type {boolean} */ next) => { ui.goalArmed = next; },
        }),
        m('.spacer'),
        // /system presence chip — the session's custom instructions
        // silently change every turn's system prompt, so their existence
        // must be visible where the prompt is exercised. Hover shows the
        // text; "/system clear" removes it.
        state.session?.customSystemPrompt ? m('span.session-sys-badge', {
          title: `Session instructions active:\n${state.session.customSystemPrompt}\n\n"/system" shows them - "/system clear" removes them.`,
        }, '/system') : null,
        // /tools presence chip — a narrowed tool manifest silently changes
        // what the agent CAN do, so it gets the same visibility contract
        // as /system: a monochrome chip where the authority is exercised.
        state.session?.toolManifest ? m('span.session-sys-badge', {
          title: `Tool manifest active: ${manifestLabel(state.session.toolManifest)} - only that toolset is exposed to the agent this chat.\n\n"/tools" shows it - "/tools full" restores everything.`,
        }, `/tools ${manifestLabel(state.session.toolManifest)}`) : null,
      ]),

      // (The per-chat usage chip lives inside the InputBar action row,
      // next to the mic/Send buttons — feature 06.)
      m(InputBar, {
        state, send, voiceManager,
        goalArmed: ui.goalArmed,
        onGoalSent: () => { ui.goalArmed = false; },
      }),
    ]);
  },
};

// Per-chat model selector. Available at all times above the composer — on a
// FRESH chat it picks the provider+model the lazily-created session will
// snapshot (writes providerName/providerModel); MID-SESSION it switches the
// model on THIS session so the next turn uses it (model-only — the provider is
// fixed once a chat starts, so the picker lists only that provider's models).
// Renders only when there are 2+ options, so a single-model user sees no chrome.
// why re-fetch on session change: switching/opening a chat must re-read that
// session's provider + current model, not stick to the last one shown.
/**
 * One model option from `models/options`.
 * @typedef {Object} ModelOption
 * @property {string} value
 * @property {string} label
 * @property {string} model
 * @property {string} [provider]
 * @property {string} [providerLabel]
 */

/**
 * @typedef {Object} ModelPickerState
 * @property {ModelOption[]|null} options
 * @property {string|null} selected
 * @property {boolean} locked
 * @property {string|undefined} fetchedKey
 */

/** @typedef {{ state: ModelPickerState, attrs: { send: Send, sessionId?: string|null, optionsKey?: string } }} ModelPickerVnode */

const ModelPicker = {
  /** @param {ModelPickerVnode} vnode */
  oninit(vnode) {
    vnode.state.options = null;
    vnode.state.selected = null;
    vnode.state.locked = false;      // mid-session: provider fixed, model-only
    vnode.state.fetchedKey = undefined;
    ModelPicker.fetch(vnode);
  },
  /** @param {ModelPickerVnode} vnode */
  onupdate(vnode) {
    // Refetch when the session changes OR when the options fingerprint moves
    // (settings edited elsewhere, e.g. the OpenRouter curated set) — otherwise
    // the picker would keep the list it cached on mount and miss the edit.
    if (ModelPicker.keyOf(vnode) !== vnode.state.fetchedKey) ModelPicker.fetch(vnode);
  },
  /** @param {ModelPickerVnode} vnode */
  keyOf(vnode) {
    return `${vnode.attrs.sessionId ?? ''}|${vnode.attrs.optionsKey ?? ''}`;
  },
  /** @param {ModelPickerVnode} vnode */
  fetch(vnode) {
    vnode.state.fetchedKey = ModelPicker.keyOf(vnode);
    const sessionId = vnode.attrs.sessionId ?? null;
    vnode.attrs.send({ type: 'models/options', sessionId }).then((r) => {
      if (r?.ok) {
        vnode.state.options = r.options;
        vnode.state.selected = r.selected;
        vnode.state.locked = !!r.sessionProvider;
        m.redraw();
      }
    }).catch(() => {});
  },
  /** @param {ModelPickerVnode} vnode */
  view: ({ attrs: { send, sessionId }, state: ui }) => {
    if (!ui.options || ui.options.length < 2) return null;
    const options = ui.options;
    return m('.model-picker', [
      m('span.model-picker-label', 'Model'),
      m('select.model-picker-select', {
        value: ui.selected,
        onchange: async (/** @type {Event} */ e) => {
          const opt = options.find((o) => o.value === /** @type {HTMLSelectElement} */ (e.target).value);
          if (!opt) return;
          ui.selected = opt.value;
          if (ui.locked && sessionId) {
            // Mid-session, same provider — bind the new model to this session.
            await send({ type: 'session/setModel', sessionId, model: opt.model });
          } else {
            // Fresh chat — set the default the lazy session-create snapshots.
            await send({
              type: 'settings/update',
              patch: { providerName: opt.provider, providerModel: opt.model },
            });
          }
          m.redraw();
        },
      }, options.map((o) =>
        // Mid-session shows just the model name (provider is fixed); fresh
        // chats show "Provider · Model" since the provider can change too.
        m('option', { value: o.value }, ui.locked ? o.label : `${o.providerLabel} · ${o.label}`))),
    ]);
  },
};

const VoiceOnboardingCard = {
  /** @param {{ attrs: { send: Send } }} vnode */
  view: ({ attrs: { send } }) => m('.onboarding-card', [
    m('h3', 'Try voice input'),
    m('p.muted',
      'Talk to peerd instead of typing. The Settings page lists what\'s '
      + 'available in this browser — fully-local Moonshine when vendored, '
      + 'or the browser\'s built-in Web Speech API as a fallback.'),
    m('.onboarding-actions', [
      m('button', {
        // Deep-link straight to the Voice page — this card is ABOUT
        // voice; the providers default would strand the user.
        onclick: () => openOptions('voice'),
      }, 'Set up voice'),
      m('button.secondary', {
        onclick: () => send({
          type: 'settings/update',
          patch: { voiceOnboardingDismissed: true },
        }),
      }, 'Maybe later'),
    ]),
  ]),
};

// Starter "path" menu for a fresh chat — NOT a generic chat box but a
// "select your path" grid: a fast way to show what peerd can do (ask about
// itself, drive the live page, crunch numbers in a notebook, run a real
// shell, build an app). Each entry carries an action TYPE that picks a
// uniform glyph (PATH_ICONS) + a module accent (.path-card in styles.css).
// The `text` is what gets sent; clicking one fires it immediately. For now
// these are just the prompts; later the same surface presents recipes /
// workflows (a mix of deterministic code + agent execution).
const STARTER_PROMPTS = [
  { type: 'ask', label: 'Ask', text: 'What can you do?' },
  { type: 'web', label: 'Browse', text: 'Open Hacker News and summarize the top 5 stories.' },
  { type: 'notebook', label: 'Notebook', text: 'Make a notebook on Bitcoin halving math, with a chart.' },
  { type: 'vm', label: 'Linux VM', text: 'Spin up a Linux VM and run `python3 --version`.' },
  { type: 'app', label: 'App', text: 'Build me a drum machine I can play in the browser.' },
  { type: 'app', label: 'App', text: 'Build me a Mandelbrot set explorer I can zoom and pan.' },
];

// The starter set is page-aware in the SIDE PANEL: when the panel sits next to
// a real web page (an http(s) tab, not peerd's own home/options page), the
// Browse path offers to summarize THAT page — the thing you're looking at —
// instead of the generic Hacker News demo. On the home full-tab surface (no
// "page next to you") it always shows the Hacker News prompt. Kept a pure fn of
// attrs so armReveal + view agree on the exact text they animate/render.
/** @param {{ surface?: string, activeTabIsWeb?: boolean }} attrs */
const promptsFor = (attrs) => (attrs.surface !== 'home' && attrs.activeTabIsWeb
  ? STARTER_PROMPTS.map((p) => (p.type === 'web'
      ? { ...p, label: 'Summarize', text: 'Summarize the current page.' }
      : p))
  : STARTER_PROMPTS);

// Action-type glyphs for the path cards. Two voices, both monochrome
// (currentColor): conceptual paths (ask / web) are stroked LINE icons in
// the same voice as the composer's send/clip glyphs; the three engine
// sandboxes wear the LOGO of the tech they run (Notebook → JS, VM → Linux/
// Tux, App → HTML5) so the kind reads at a glance. The glyph + label carry
// the path's module accent PERMANENTLY (cyan/green/amber). why: owner
// override (2026-06-21) — this menu is a deliberate, wayfinding-first
// departure from the "one rainbow accent on monochrome" brand rule; the
// tile background + outline stay grey so color doesn't run away with the
// surface. One glyph per TYPE, so the two "App" prompts share the HTML5
// mark, etc.
/** @param {...any} children */
const pathIcon = (...children) => m('svg', {
  viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none',
  stroke: 'currentColor', 'stroke-width': 1.6,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
}, children);

// Vendored brand logos (simple-icons) are FILLED silhouettes, not stroked
// line art — designed to be painted in one color (fill: currentColor).
/** @param {string} d */
const logoIcon = (d) => m('svg', {
  viewBox: '0 0 24 24', width: 28, height: 28, fill: 'currentColor', 'aria-hidden': 'true',
}, m('path', { d }));

/** @type {Record<string, () => any>} */
const PATH_ICONS = {
  // ask — a sparkle: "what can peerd do?" (capability / identity)
  ask: () => pathIcon(m('path', {
    d: 'M12 3.5 13.4 10.6 20.5 12 13.4 13.4 12 20.5 10.6 13.4 3.5 12 10.6 10.6 Z',
  })),
  // web — a globe: the live page / browsing the web
  web: () => pathIcon(
    m('circle', { cx: 12, cy: 12, r: 9 }),
    m('path', { d: 'M3 12 H21' }),
    m('path', { d: 'M12 3 C7.5 7 7.5 17 12 21 C16.5 17 16.5 7 12 3 Z' }),
  ),
  // notebook — the JS mark: a Notebook IS a sealed JS worker, so the glyph
  // invokes compute, not stationery. Stroked square + a filled "JS"
  // wordmark — a monochrome rendition of the JavaScript logo.
  notebook: () => pathIcon(
    m('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
    m('text', {
      x: 19, y: 18.5, 'text-anchor': 'end',
      'font-family': 'ui-monospace, "JetBrains Mono", monospace',
      'font-weight': 700, 'font-size': 10.5, fill: 'currentColor', stroke: 'none',
    }, 'JS'),
  ),
  // vm — Tux, the Linux mascot (the CheerpX Linux VM)
  vm: () => logoIcon(LINUX_PATH),
  // app — the HTML5 shield (the opaque-origin HTML iframe)
  app: () => logoIcon(HTML5_PATH),
};

const reducedMotion = () =>
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Type-in cadence for the path-card prompts (ms) — STEP 3 of the per-tile
// reveal (CSS owns steps 1+2: the box flicker, then the glyph+label
// flicker). `start` is set AFTER those CSS steps land (container 40ms +
// glyph ~540ms + its 380ms ≈ 960ms) so the text types only once the tile
// is fully drawn; `cascade` matches the CSS 90ms per-tile stagger. If you
// retune the CSS step delays, keep `start` past step-2's end (540+380) so
// the cursor never precedes the glyph. why exported mutable: lets a future
// test drive the loop in real time (TEASE/PROMPT_TYPE precedent in
// onboarding-view); production never writes it.
export const PATH_TYPE = { ms: 18, start: 980, cascade: 90 };

/**
 * One-shot reveal state for the path-card type-in.
 * @typedef {Object} EmptyState_State
 * @property {ReturnType<typeof setTimeout>[]} timers
 * @property {boolean} armed
 * @property {number[]} shown
 * @property {boolean[]} started
 */

/** @typedef {{ state: EmptyState_State, attrs: { hasKey?: boolean, send: Send, surface?: string, activeTabIsWeb?: boolean } }} EmptyStateVnode */

// Arm the one-shot type-in (step 3) for every card. Idempotent via
// `ui.armed`, so the redraw-driven onupdate can't re-trigger it; only runs
// once the menu is actually shown (hasKey) AND motion is allowed.
/** @param {EmptyStateVnode} vnode */
const armReveal = (vnode) => {
  const ui = vnode.state;
  if (ui.armed || reducedMotion() || !vnode.attrs.hasKey) return;
  ui.armed = true;
  promptsFor(vnode.attrs).forEach((p, i) => {
    const text = p.text;
    const tick = () => {
      ui.shown[i] += 1;
      if (ui.shown[i] < text.length) ui.timers.push(setTimeout(tick, PATH_TYPE.ms));
      // why Infinity (not text.length): once a card has settled, render its
      // FULL text even if the prompt later swaps (a side-panel tab switch can
      // change the Browse prompt) — a shorter `shown` would truncate it.
      else ui.shown[i] = Infinity;
      m.redraw();
    };
    // why the started flip: the cursor must not show until THIS tile's
    // type-in begins (step 3) - otherwise it blinks in an empty box before
    // the glyph has even flickered in (step 2). The start timeout flips
    // `started` and types the first char.
    ui.timers.push(setTimeout(() => {
      ui.started[i] = true;
      tick();
    }, PATH_TYPE.start + i * PATH_TYPE.cascade));
  });
};

// EmptyState is stateful only for that one-shot reveal. Each card's `shown`
// count walks 0 -> text length on a self-scheduling timeout; `started`
// gates the cursor until that card's turn. The reveal is armed from oninit
// when the key is already present, OR from onupdate when the key is ADDED
// while this empty chat stays open (oninit fires once, so without the
// re-arm the add-key-then-return first-run path would show the menu
// un-animated). Reduced motion shows the full text at once and never arms.
const EmptyState = {
  /** @param {EmptyStateVnode} vnode */
  oninit(vnode) {
    const ui = vnode.state;
    ui.timers = [];
    ui.armed = false;
    // Reduced motion -> full text immediately; otherwise start hidden (0),
    // ready to type. (hasKey false means the menu isn't rendered yet, so
    // these only matter once it appears - no full-text flash on the flip.)
    const reduce = reducedMotion();
    ui.shown = STARTER_PROMPTS.map(() => (reduce ? Infinity : 0));
    ui.started = STARTER_PROMPTS.map(() => reduce);
    armReveal(vnode);
  },
  /** @param {EmptyStateVnode} vnode */
  onupdate(vnode) { armReveal(vnode); },
  /** @param {EmptyStateVnode} vnode */
  onremove(vnode) {
    vnode.state.timers.forEach((t) => clearTimeout(t));
  },
  /** @param {EmptyStateVnode} vnode */
  view: ({ attrs, state: ui }) => {
    const { hasKey, send } = attrs;
    // The home full-tab surface has room for a wider 3-across grid; the side
    // panel stays 2-across (its column is narrow). One flag drives both the
    // wider container and the 3-column track (CSS owns the actual widths).
    const isHome = attrs.surface === 'home';
    const prompts = promptsFor(attrs);
    return m('.placeholder', m('.empty-state', { class: isHome ? 'empty-state--home' : '' }, [
    m('p', 'peerd is ready.'),
    m('p.muted', hasKey
      ? 'Ask anything — or pick a path:'
      : 'Add your Anthropic or OpenRouter API key in Settings to start chatting.'),
    hasKey
      ? m('.path-menu', { class: isHome ? 'path-menu--home' : '' }, prompts.map((p, i) => {
          const shown = ui.shown?.[i] ?? Infinity;
          const done = shown >= p.text.length;
          // cursor shows only once this tile has STARTED typing and isn't done
          const typing = (ui.started?.[i] ?? true) && !done;
          return m('button.path-card', {
            // why data-path (not an inline style): the per-type accent
            // color lives in CSS (styles.css owns the brand palette — no
            // hexes in JS). The glyph + label carry that color permanently;
            // the tile background + outline stay grey.
            'data-path': p.type,
            title: p.text,
            // a11y reads the full prompt even mid-type
            'aria-label': `${p.label}: ${p.text}`,
            // Fire-and-forget: the SW pushes turn state, which flips the
            // view out of the empty state into the live transcript.
            onclick: () => send({ type: 'agent/send', text: p.text }),
          }, [
            m('.path-card-icon', (PATH_ICONS[p.type] ?? PATH_ICONS.ask)()),
            m('span.path-card-label', p.label),
            m('span.path-card-text', [
              done ? p.text : p.text.slice(0, shown),
              // the brand terminal cursor (reused from onboarding) trails
              // the text only while this card is still typing
              typing ? m('span.onboarding-cursor', { 'aria-hidden': 'true' }) : null,
            ]),
          ]);
        }))
      : m('button', { onclick: () => openOptions('providers') }, 'Open settings'),
    ]));
  },
};

// mapError + errorSettingsTarget moved to ../error-display.js (pure, Bun-tested)
// — a component should hold no business logic, and that mapping is worth a
// test of its own (it matches both the SW's typed codes and the loop's raw
// throw text).
