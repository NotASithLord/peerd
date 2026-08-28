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
import { manifestLabel, bundleToOtlp, detectVoiceCapability } from '/peerd-runtime/ui.js';
import { openOptions } from '/shared/open-options.js';
import { mapError, errorSettingsTarget } from '../error-display.js';
import { MessageList } from './message-list.js';
import { hasUnconfirmedAgentSend, InputBar, sendAgentWithCustody } from './input-bar.js';
import { ModeSelector, EffortDial, GoalToggle } from './mode-badge.js';
import { GoalBar } from './goal-bar.js';
import { TodoCard } from './todo-card.js';
import { ActorFabric } from './actor-fabric.js';
import { ContextInspector } from './context-inspector.js';
import { composerForState, composerUnavailableCopy } from '../provider-readiness.js';

// The transfer section's Blob + anchor pattern — the panel document is a
// normal DOM context, so a synthetic download link is all a file save takes.
/** @param {unknown} payload @param {string} filename */
const saveJsonFile = (payload, filename) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {Record<string, ((...args: any[]) => any) | undefined>} UiActions */

/**
 * Component-local state for ChatView.
 * @typedef {Object} ChatViewState
 * @property {boolean} goalArmed             the Goal toggle's arm state (UI-only)
 * @property {string|null|undefined} _sid    which chat the arm state belongs to
 * @property {boolean} hadMessages           whether this chat already mounted a transcript
 * @property {boolean} hasObservedSession    whether initial session hydration has completed
 * @property {Map<string|undefined, Set<string>>} seenRecoveryIdsBySession recovery announcements already heard per chat
 * @property {boolean} [debugMenuOpen]       the debug-export flyout's open state
 * @property {boolean} [inspectorOpen]       the context-inspector modal's open state
 * @property {Array<Record<string, any>>|null} [snapshots]  the inspector's fetched snapshots (null = loading)
 * @property {string|null} [snapshotsError]  why the fetch failed (locked vault, etc.), for an honest modal
 */

/**
 * @typedef {{ state: ChatViewState, attrs: {
 *   state: ChatState, send: Send, voiceManager: any, uiActions?: UiActions,
 *   surface?: string, activeTabStatus?: 'none'|'unknown'|'web'|'protected_private'|'protected_sensitive',
 * } }} ChatViewVnode
 */

export const ChatView = {
  /** @param {ChatViewVnode} vnode */
  oninit(vnode) {
    // Goal arming is pure composer intent (it just flags the next send as
    // goal:true), so it lives here as UI-only state — no SW round-trip. Reset
    // when the chat changes (each chat owns its own run), mirroring the
    // InputBar's per-session draft swap.
    vnode.state.goalArmed = false;
    vnode.state._sid = vnode.attrs.state?.session?.sessionId;
    vnode.state.hadMessages = (vnode.attrs.state?.session?.messages?.length ?? 0) > 0;
    vnode.state.hasObservedSession = vnode.state._sid != null;
    vnode.state.seenRecoveryIdsBySession = new Map();
  },

  /** @param {ChatViewVnode} vnode */
  view: ({ attrs: { state, send, voiceManager, uiActions, surface, activeTabStatus }, state: ui }) => {
    const sid = state.session?.sessionId;
    const messages = state.session?.messages ?? [];
    const changedSession = sid !== ui._sid;
    const isUserVisibleSwitch = changedSession && ui.hasObservedSession && sid != null;
    if (sid !== ui._sid) {
      ui._sid = sid;
      ui.goalArmed = false;
      ui.hadMessages = messages.length > 0;
      // The debug surface is per-session UI: a flyout or inspector left open
      // on chat A must not survive a switch to chat B (B would silently show
      // A's snapshots).
      ui.debugMenuOpen = false;
      ui.inspectorOpen = false;
      ui.snapshots = null;
    }
    if (sid != null) ui.hasObservedSession = true;
    const announceOnMount = messages.length > 0
      && (isUserVisibleSwitch || !ui.hadMessages);
    if (messages.length > 0) ui.hadMessages = true;
    const composer = composerForState(state);
    const canSend = !!composer.canSend;
    // Fingerprint of the settings that shape the model-picker options. The
    // side panel gets live settings pushes (e.g. editing the OpenRouter
    // curated set in Settings while this chat stays open), so when this key
    // moves the picker re-pulls instead of showing the options it cached on
    // mount. why include each: providerName/providerModel drive the active
    // selection + custom-model append; openrouterModels is the curated list;
    // composer readiness flips which providers contribute at all. The
    // configured-provider revision catches a second key being added while the
    // current provider remains ready; ollamaHost prevents stale daemon models.
    const modelOptionsKey = [
      state.settings?.providerName ?? '',
      state.settings?.providerModel ?? '',
      (state.settings?.openrouterModels ?? []).join(','),
      state.settings?.ollamaHost ?? '',
      state.providers?.configRevision ?? 0,
      canSend ? '1' : '0',
    ].join('|');
    const showVoiceOnboarding = !!state.settings
      && !state.settings.voiceOnboardingDismissed
      && !state.settings.voiceEnabled
      // why: only nudge once the user has gotten past the API-key
      // hurdle. Stacking onboarding cards is hostile.
      && canSend
      && messages.length === 0
      && detectVoiceCapability('auto', {
        moonshineHostAvailable: state.capabilities?.moonshineVoiceHost?.status === 'available',
      }).engine !== null;

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

      // Goal mode (the mode-row Goal toggle) — a persistent "running · turn N ·
      // Stop" bar while THIS chat's autonomous goal run is live (each chat owns
      // its own run; a run in another chat shows its bar there). Self-hides
      // otherwise.
      m(GoalBar, { goal: state.goalRuns?.[state.session?.sessionId ?? ''], send }),

      // The goal run's plan-of-record (session.todos, the todo_* tools) — the
      // visible checklist that ticks as the run works. Renders straight off
      // the session snapshot; stays up after the run ends as its receipt.
      m(TodoCard, {
        todos: /** @type {any} */ (state.session)?.todos,
        active: !!state.goalRuns?.[state.session?.sessionId ?? '']?.active,
      }),

      // The Actor Fabric unifies the previously separate background-task bar,
      // bound-actor cards, and spawned streams into one live topology. It is a
      // projection only. Transcript cards remain the durable chronological
      // receipt, and the fabric self-hides when this chat has no isolated work running.
      m(ActorFabric, {
        session: state.session,
        actors: state.actors,
        spawned: state.spawned,
        asyncTasks: state.asyncTasks,
      }),

      showVoiceOnboarding ? m(VoiceOnboardingCard, { send }) : null,

      messages.length === 0 ? m(EmptyState, {
        canSend, composer, send, surface, activeTabStatus, sessionId: sid,
        actorExecution: state.capabilities?.actorExecution,
      })
        : m(MessageList, {
            sessionId: state.session?.sessionId,
            announceOnMount,
            seenRecoveryIdsBySession: ui.seenRecoveryIdsBySession,
            messages,
            vmStreams: state.vmStreams,
            // The AI peer's display name (default profile, set during
            // onboarding) — labels assistant rows, and ONLY there.
            peerName: state.profile?.peerName,
            // actor nested-transcript wiring (docs/ACTORS.md)
            spawned: state.spawned,
            // DESIGN-17 P1: actor display cards (glass pane) — keyed by the
            // message_actor tool_use id; rendered inline under that card.
            actors: state.actors,
            // Live delegation feed for in-flight `script` runs (keyed by the
            // script call's toolUseId) — the chain-of-events line the user
            // watches while a script fans work out to actors.
            scriptOps: state.scriptOps,
            loadActor: uiActions?.loadActor,
            // "peerd opened a tab" notices render INLINE in the transcript at the
            // turn they happened (and fade into the backlog as the chat continues)
            // — not a bright sticky footer. Filtered to this session.
            tabEvents: (state.agentTabEvents ?? []).filter((e) => e.sessionId === state.session?.sessionId),
            // Confirm settles for THIS chat only - the events carry their
            // sessionId so a background chat's timeout can't leak into view.
            confirmEvents: (state.confirmEvents ?? []).filter((e) => e.sessionId === state.session?.sessionId),
            uiActions,
            send,
            // A model turn may be idle after acknowledging asynchronous actor
            // work. That is not yet the human task's final answer; mirror the
            // route's in-flight guard so the UI never offers a no-op verdict.
            busy: state.streaming || Object.values(state.actors ?? {})
              .some((card) => /** @type {any} */ (card)?.streaming === true),
          }),

      // Per-chat model picker, above the composer. Available at all times —
      // on a fresh chat it sets provider+model for the next send; mid-session
      // it switches the model on THIS session (model-only, same provider). The
      // component self-hides unless there are 2+ choices.
      !state.vault?.locked
        ? m(ModelPicker, { send, sessionId: state.session?.sessionId, optionsKey: modelOptionsKey })
        : null,

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
            && composer.provider === 'anthropic'
          ? m(EffortDial, { settings: state.settings, send })
          : null,
        // Goal arming — the in-chat entry point for goal mode. Arms the NEXT
        // send to launch an autonomous goal run; the InputBar consumes the arm
        // and disarms — but the toggle STAYS lit while the run itself is live
        // (it reflects state.goalRuns), and clicking it then stops the run.
        m(GoalToggle, {
          armed: ui.goalArmed,
          run: state.goalRuns?.[sid ?? ''] ?? null,
          disabled: !canSend,
          onToggle: (/** @type {boolean} */ next) => { ui.goalArmed = next; },
          onStop: () => send({ type: 'agent/stop' }),
        }),
        m('.spacer'),
        // /system presence chip — the session's custom instructions
        // silently change every turn's system prompt, so their existence
        // must be visible where the prompt is exercised. Hover shows the
        // text; "/system clear" removes it.
        state.session?.customSystemPrompt ? m('span.session-sys-badge', {
          title: `Session instructions active:\n${state.session.customSystemPrompt}\n\n"/system" shows them - "/system clear" removes them.`,
        }, '/system') : null,
        // /tools presence chip: a narrowed manifest silently changes which
        // tools the model is offered, so it gets the same visibility contract
        // as /system: a monochrome chip where the model surface is active.
        state.session?.toolManifest ? m('span.session-sys-badge', {
          title: `Tool manifest active: ${manifestLabel(state.session.toolManifest)} - only that toolset is exposed to the agent this chat.\n\n"/tools" shows it - "/tools full" restores everything.`,
        }, `/tools ${manifestLabel(state.session.toolManifest)}`) : null,
        // The debug surface's chat entry point: export this session's debug
        // bundle (transcript + children + audit slice + cost + settings +
        // live context snapshots) as one local JSON file, or the same data
        // as OTLP spans. devMode adds the context inspector. Chip-sized on
        // purpose — support tooling, not a headline control.
        state.session?.sessionId ? m('.debug-export', [
          m('button.debug-export-btn', {
            title: 'Debug: export this chat\'s debug bundle (a local file — nothing is sent anywhere)',
            onclick: () => { ui.debugMenuOpen = !ui.debugMenuOpen; },
          }, 'debug'),
          ui.debugMenuOpen ? m('.debug-menu-backdrop', {
            onclick: () => { ui.debugMenuOpen = false; },
          }) : null,
          ui.debugMenuOpen ? m('.debug-menu', [
            m('button.debug-menu-item', {
              onclick: async () => {
                ui.debugMenuOpen = false;
                const sessionId = state.session?.sessionId;
                const reply = await send({ type: 'session/debugBundle', sessionId });
                if (!reply?.ok) return;
                saveJsonFile(reply.bundle, `peerd-debug-${String(sessionId).slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`);
              },
            }, 'export debug bundle (.json)'),
            m('button.debug-menu-item', {
              onclick: async () => {
                ui.debugMenuOpen = false;
                const sessionId = state.session?.sessionId;
                const reply = await send({ type: 'session/debugBundle', sessionId });
                if (!reply?.ok) return;
                // why converted HERE: bundleToOtlp is pure, so the second
                // format costs no second route and no SW round trip.
                saveJsonFile(bundleToOtlp(reply.bundle), `peerd-trace-${String(sessionId).slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`);
              },
            }, 'export OTel trace (.json)'),
            state.settings?.devMode ? m('button.debug-menu-item', {
              onclick: async () => {
                ui.debugMenuOpen = false;
                ui.inspectorOpen = true;
                ui.snapshots = null;
                try {
                  const reply = await send({ type: 'session/contextSnapshots', sessionId: state.session?.sessionId });
                  ui.snapshots = reply?.ok ? reply.snapshots : [];
                  ui.snapshotsError = reply?.ok ? null : (reply?.error ?? 'request failed');
                } catch (e) {
                  ui.snapshots = [];
                  ui.snapshotsError = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
                }
                m.redraw();
              },
            }, 'context inspector') : null,
          ]) : null,
        ]) : null,
      ]),

      // (The per-chat usage chip lives inside the InputBar action row,
      // next to the mic/Send buttons — feature 06.)
      m(InputBar, {
        state, send, voiceManager,
        goalArmed: ui.goalArmed,
        onGoalSent: () => { ui.goalArmed = false; },
      }),

      // The context inspector modal (devMode, opened from the debug menu).
      ui.inspectorOpen ? m(ContextInspector, {
        snapshots: ui.snapshots ?? null,
        error: ui.snapshotsError ?? null,
        onClose: () => { ui.inspectorOpen = false; },
      }) : null,
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
 * @property {number} requestGeneration
 * @property {boolean} changing
 * @property {string|null} error
 * @property {{value:string,message:Record<string,any>}|null} unconfirmed
 */

/** @typedef {{ state: ModelPickerState, attrs: { send: Send, sessionId?: string|null, optionsKey?: string } }} ModelPickerVnode */

const ModelPicker = {
  /** @param {ModelPickerVnode} vnode */
  oninit(vnode) {
    vnode.state.options = null;
    vnode.state.selected = null;
    vnode.state.locked = false;      // mid-session: provider fixed, model-only
    vnode.state.fetchedKey = undefined;
    vnode.state.requestGeneration = 0;
    vnode.state.changing = false;
    vnode.state.error = null;
    vnode.state.unconfirmed = null;
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
    const requestedKey = ModelPicker.keyOf(vnode);
    const requestGeneration = vnode.state.requestGeneration + 1;
    vnode.state.requestGeneration = requestGeneration;
    vnode.state.fetchedKey = requestedKey;
    const sessionId = vnode.attrs.sessionId ?? null;
    vnode.attrs.send({ type: 'models/options', sessionId }).then((r) => {
      // why: options requests can resolve out of order when settings/provider
      // pushes redraw the live panel. An older response must not overwrite the
      // selection fetched for the newer key. That visibly put the picker on a
      // different provider than the effort dial and the settings snapshot.
      if (vnode.state.requestGeneration !== requestGeneration
        || vnode.state.fetchedKey !== requestedKey
        || ModelPicker.keyOf(vnode) !== requestedKey) return;
      if (r?.ok) {
        vnode.state.options = r.options;
        vnode.state.locked = !!r.sessionProvider;
        if (vnode.state.unconfirmed) {
          if (r.selected === vnode.state.unconfirmed.value) {
            vnode.state.selected = r.selected;
            vnode.state.unconfirmed = null;
            vnode.state.error = null;
          }
        } else vnode.state.selected = r.selected;
        m.redraw();
      }
    }).catch(() => {});
  },
  /** @param {ModelPickerVnode} vnode @param {string} value @param {Record<string,any>} message */
  async apply(vnode, value, message) {
    const ui = vnode.state;
    if (ui.changing) return;
    const retrying = !!ui.unconfirmed;
    const previous = ui.selected;
    let refetch = false;
    ui.changing = true;
    ui.selected = value;
    ui.error = null;
    m.redraw();
    try {
      const reply = await vnode.attrs.send(message);
      if (reply?.ok) {
        ui.selected = value;
        ui.unconfirmed = null;
      } else if (reply?.outcomeKnown === false) {
        ui.unconfirmed = { value, message };
        ui.error = 'Model change unconfirmed.';
      } else {
        if (retrying) ui.unconfirmed = null;
        ui.selected = previous;
        ui.error = 'Model change failed.';
        refetch = retrying;
      }
    } catch (cause) {
      if (/** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === true) {
        if (retrying) ui.unconfirmed = null;
        ui.selected = previous;
        ui.error = 'Model change failed.';
        refetch = retrying;
      } else {
        ui.unconfirmed = { value, message };
        ui.error = 'Model change unconfirmed.';
      }
    } finally {
      ui.changing = false;
      m.redraw();
      if (ui.unconfirmed || refetch) ModelPicker.fetch(vnode);
    }
  },
  /** @param {ModelPickerVnode} vnode */
  view: (vnode) => {
    const { attrs: { send, sessionId }, state: ui } = vnode;
    const pendingModel = ui.unconfirmed;
    if (!ui.options || ui.options.length < 2) return null;
    const options = ui.options;
    return m('.model-picker', [
      m('span.model-picker-label', 'Model'),
      m('select.model-picker-select', {
        value: ui.selected,
        disabled: ui.changing || !!ui.unconfirmed,
        onchange: async (/** @type {Event} */ e) => {
          const opt = options.find((o) => o.value === /** @type {HTMLSelectElement} */ (e.target).value);
          if (!opt) return;
          const message = ui.locked && sessionId
            // Mid-session, same provider — bind the new model to this session.
            ? { type: 'session/setModel', sessionId, model: opt.model }
            // Fresh chat — set the default the lazy session-create snapshots.
            : {
              type: 'settings/update',
              patch: { providerName: opt.provider, providerModel: opt.model },
            };
          await ModelPicker.apply(vnode, opt.value, message);
        },
      }, options.map((o) =>
        // Mid-session shows just the model name (provider is fixed); fresh
        // chats show "Provider · Model" since the provider can change too.
        m('option', { value: o.value }, ui.locked ? o.label : `${o.providerLabel} · ${o.label}`))),
      ui.error ? m('span.model-picker-status', ui.error) : null,
      pendingModel ? m('button.secondary.model-picker-finish', {
        disabled: ui.changing,
        onclick: () => ModelPicker.apply(vnode, pendingModel.value, pendingModel.message),
      }, 'Finish same model change') : null,
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
/** @typedef {{ type: string, label: string, text: string, blocked?: boolean }} StarterPrompt */
/** @type {StarterPrompt[]} */
const STARTER_PROMPTS = [
  { type: 'ask', label: 'Ask', text: 'What can you do?' },
  { type: 'web', label: 'Browse', text: 'Open Hacker News and summarize the top 5 stories.' },
  { type: 'notebook', label: 'Notebook', text: 'Make a notebook on Bitcoin halving math, with a chart.' },
  { type: 'pod', label: 'Pod', text: 'Create a Pod and demonstrate files, a pipeline, JavaScript, and WASI.' },
  { type: 'vm', label: 'Linux VM', text: 'Spin up a Linux VM and run `python3 --version`.' },
  { type: 'app', label: 'App', text: 'Build me a drum machine I can play in the browser.' },
];

// The starter set is page-aware in the SIDE PANEL: when the panel sits next to
// a real web page (an http(s) tab, not peerd's own home/options page), the
// Browse path offers to summarize THAT page — the thing you're looking at —
// instead of the generic Hacker News demo. On the home full-tab surface (no
// "page next to you") it always shows the Hacker News prompt. Kept a pure fn of
// attrs so armReveal + view agree on the exact text they animate/render.
/** @param {{ surface?: string, activeTabStatus?: 'none'|'unknown'|'web'|'protected_private'|'protected_sensitive' }} attrs */
export const promptsFor = (attrs) => {
  if (attrs.surface === 'home') return STARTER_PROMPTS;
  if (attrs.activeTabStatus === 'web') {
    return STARTER_PROMPTS.map((prompt) => (prompt.type === 'web'
      ? { ...prompt, label: 'Summarize', text: 'Summarize the current page.' }
      : prompt));
  }
  const protectedCopy = attrs.activeTabStatus === 'protected_private'
    ? 'This private-network page is protected. peerd will not read or automate it.'
    : attrs.activeTabStatus === 'protected_sensitive'
      ? 'This sensitive page is protected. peerd will not read or automate it.'
      : null;
  if (!protectedCopy) return STARTER_PROMPTS;
  return STARTER_PROMPTS.map((prompt) => (prompt.type === 'web'
    ? { ...prompt, label: 'Protected', text: protectedCopy, blocked: true }
    : prompt));
};

// Action-type glyphs for the path cards. Two voices, both monochrome
// (currentColor): conceptual paths (ask / web) are stroked LINE icons in
// the same voice as the composer's send/clip glyphs; the engine
// sandboxes wear the LOGO of the tech they run (Notebook → JS, VM → Linux/
// Tux, Pod → terminal, App → HTML5) so the kind reads at a glance. The glyph + label carry
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
  // pod: a compact terminal prompt: shell-oriented but deliberately not Tux,
  // because a Pod is not Linux.
  pod: () => pathIcon(
    m('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
    m('path', { d: 'M7 9 10 12 7 15 M12 15 H17' }),
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
 * @property {boolean} busy
 * @property {number[]} shown
 * @property {boolean[]} started
 */

/** @typedef {{ state: EmptyState_State, attrs: { canSend?: boolean, composer?: any, send: Send, sessionId?: string|null, surface?: string, activeTabStatus?: 'none'|'unknown'|'web'|'protected_private'|'protected_sensitive', actorExecution?: { status?: string } } }} EmptyStateVnode */

// Arm the one-shot type-in (step 3) for every card. Idempotent via
// `ui.armed`, so the redraw-driven onupdate can't re-trigger it; only runs
// once the menu is actually shown (canSend) AND motion is allowed.
/** @param {EmptyStateVnode} vnode */
const armReveal = (vnode) => {
  const ui = vnode.state;
  if (ui.armed || reducedMotion() || !vnode.attrs.canSend) return;
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
export const EmptyState = {
  /** @param {EmptyStateVnode} vnode */
  oninit(vnode) {
    const ui = vnode.state;
    ui.timers = [];
    ui.armed = false;
    ui.busy = false;
    // Reduced motion -> full text immediately; otherwise start hidden (0),
    // ready to type. (canSend false means the menu isn't rendered yet, so
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
    const { canSend, composer, send } = attrs;
    // The home full-tab surface has room for a wider 3-across grid; the side
    // panel stays 2-across (its column is narrow). One flag drives both the
    // wider container and the 3-column track (CSS owns the actual widths).
    const isHome = attrs.surface === 'home';
    const prompts = promptsFor(attrs);
    const unconfirmed = hasUnconfirmedAgentSend(attrs.sessionId);
    return m('.placeholder', m('.empty-state', {
      class: isHome ? 'empty-state--home' : '',
      'data-active-tab-status': attrs.activeTabStatus ?? 'none',
    }, [
    m('p', canSend ? 'peerd is ready.' : 'Provider setup needed.'),
    m('p.muted', canSend
      ? 'Ask anything — or pick a path:'
      : composerUnavailableCopy(composer)),
    canSend
      ? m('.path-menu', { class: isHome ? 'path-menu--home' : '' }, prompts.map((p, i) => {
          const shown = ui.shown?.[i] ?? Infinity;
          const done = shown >= p.text.length;
          const actorUnavailable = attrs.actorExecution && attrs.actorExecution.status !== 'available' && p.type !== 'ask';
          const blocked = p.blocked === true;
          // cursor shows only once this tile has STARTED typing and isn't done
          const typing = (ui.started?.[i] ?? true) && !done;
          return m('button.path-card', {
            class: blocked ? 'path-card--protected' : '',
            // why data-path (not an inline style): the per-type accent
            // color lives in CSS (styles.css owns the brand palette — no
            // hexes in JS). The glyph + label carry that color permanently;
            // the tile background + outline stay grey.
            'data-path': p.type,
            title: blocked
              ? p.text
              : actorUnavailable ? 'Unavailable until the isolated actor worker recovers' : p.text,
            // a11y reads the full prompt even mid-type
            'aria-label': blocked
              ? `${p.label}: ${p.text}`
              : actorUnavailable
              ? `${p.label}: unavailable while actor work is paused`
              : `${p.label}: ${p.text}`,
            disabled: blocked || actorUnavailable || ui.busy || unconfirmed,
            onclick: async () => {
              if (ui.busy) return;
              ui.busy = true;
              const operationId = `send.${Date.now().toString(36)}.${crypto.randomUUID()}`;
              const pending = {
                operationId, text: p.text, goal: false,
                sessionId: attrs.sessionId ?? null,
                hadAttachments: false, source: /** @type {const} */ ('starter'),
              };
              try {
                const delivery = sendAgentWithCustody({
                  send,
                  message: {
                    type: 'agent/send', text: p.text, operationId,
                    sessionId: attrs.sessionId ?? null,
                  },
                  pending,
                  currentSessionId: () => attrs.sessionId,
                });
                m.redraw.sync();
                await delivery;
              } catch { /* the composer owns unknown delivery */ }
              finally { ui.busy = false; m.redraw(); }
            },
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
