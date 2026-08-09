// @ts-check
// Options → Behavior — how the agent acts.
//
// Rebuilt on the settings ROW (P1 of the UI redesign). What changed is the
// reading, not the settings: every control that was here is still here, on the
// same route, with the same guards. What moved is where the words live — each
// row now states WHERE YOU STAND in one present-tense line, and the long
// rationale that used to BE the block collapses behind "Why this matters".
//
// Three bands, because eleven equal-weight blocks made a safety guard look like
// a diagnostic toggle. Only SAFETY is raised and ruled (options.css) — a user
// skimming for "what can peerd do to me" should find those four without reading
// a word of copy.
//
// The rationale text below is the SHIPPED prose, moved rather than rewritten: it
// is the part that took real thought, and paraphrasing it during a visual
// redesign is how a page quietly starts lying about its own guarantees.

import m from '/vendor/mithril/mithril.js';
import { listProviders } from '/peerd-provider/index.js';
import { resetRow } from './reset-row.js';
import { settingsRow, settingsBand, toggleSwitch } from '../components/settings-row.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const BehaviorSection = {
  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const s = state.settings ?? {};
    // Which rationales are open. Per-row, remembered while the page is mounted
    // and never persisted — a disclosure is a reading aid, not a preference.
    if (!ui.why) ui.why = new Set();
    const whyOpen = (/** @type {string} */ id) => ui.why.has(id);
    const toggleWhy = (/** @type {string} */ id) => () => {
      if (ui.why.has(id)) ui.why.delete(id); else ui.why.add(id);
      m.redraw();
    };

    /**
     * A row whose control is a switch. Holds the busy-flag dance in ONE place:
     * it was copy-pasted eight times, and a missed `finally` in any copy is a
     * control stuck spinning forever.
     * @param {{ id: string, label: string, on: boolean, busyKey: string,
     *   summary: string, why: string, apply: () => Promise<any>,
     *   badge?: string | null, children?: any }} p
     */
    const toggleRow = ({ id, label, on, busyKey, summary, why, apply, badge = null, children = null }) => {
      const busy = !!ui[busyKey];
      return settingsRow({
        id,
        label,
        pill: busy ? '…' : on ? 'ON' : 'OFF',
        badge,
        summary: busy ? 'Saving…' : summary,
        why,
        open: whyOpen(id),
        onToggleWhy: toggleWhy(id),
        control: toggleSwitch({
          on,
          busy,
          label: `${label} — ${on ? 'on' : 'off'}`,
          onclick: async () => {
            if (ui[busyKey]) return;
            ui[busyKey] = true; m.redraw();
            try { await apply(); } catch (e) { console.warn(`[options] ${id} toggle failed`, e); }
            finally { ui[busyKey] = false; m.redraw(); }
          },
        }),
        children,
      });
    };

    // ── Safety — changes what peerd MAY DO ───────────────────────────────────
    const confirmsOn = state.session?.permission?.confirmActions === true;
    const webWritesOn = s.confirmWebWrites !== false;
    const schemaOn = s.schemaValidatedReplies === true;
    const hasDebugger = !!globalThis.chrome?.debugger;
    const aaOn = s.advancedAutomationEnabled !== false;

    const safetyRows = [
      toggleRow({
        id: 'confirm-actions',
        label: 'Confirm before actions',
        on: confirmsOn,
        busyKey: 'confirmBusy',
        summary: confirmsOn
          ? 'peerd asks before each side-effecting action — click, type, navigate, run code, fetch, write.'
          : 'peerd clicks, types and navigates without asking. Memory writes always confirm.',
        why: confirmsOn
          ? 'ON — peerd asks before each side-effecting action (click, type, navigate, run code, fetch, write). Confirmation prompts appear in the peerd panel, next to the chat.'
          : 'OFF — peerd acts without asking (it clicks, types, navigates, runs code, and edits). That’s the default: acting on a live tab, a Notebook, or a WebVM is the point. Memory writes always confirm.',
        // why permission/set, not settings/update: mode (Plan/Act) is the
        // ModeSelector's axis, and this toggle must not yank a user out of Plan
        // as a side effect.
        apply: () => send({ type: 'permission/set', confirmActions: !confirmsOn }),
      }),

      settingsRow({
        id: 'web-writes',
        label: 'Confirm before sending data out',
        pill: ui.webWriteBusy ? '…' : webWritesOn ? 'ON' : 'OFF',
        summary: ui.webWriteBusy ? 'Saving…' : webWritesOn
          ? 'Asks before any request that could carry data out of the browser.'
          : 'peerd can POST, PUT and DELETE to any non-denylisted host without asking. Not recommended.',
        why: webWritesOn
          ? 'ON — peerd asks before any request that can transmit a BODY out of the browser (POST/PUT/PATCH/DELETE/OPTIONS) — from the web actor\'s fetch or inside a WebVM (curl, etc.). You can approve a single write or all writes for that chat. This is the main guard against a prompt-injected agent exfiltrating data via a write. (Plain reads — GET/HEAD — are never gated; the denylist is the guard there.)'
          : 'OFF — peerd can send POST/PUT/DELETE requests to any non-denylisted host WITHOUT asking, including under prompt injection. The denylist still blocks known-sensitive sites, but everything else is open. Not recommended.',
        open: whyOpen('web-writes'),
        onToggleWhy: toggleWhy('web-writes'),
        control: toggleSwitch({
          on: webWritesOn,
          busy: !!ui.webWriteBusy,
          label: `Confirm before sending data out — ${webWritesOn ? 'on' : 'off'}`,
          onclick: async () => {
            if (ui.webWriteBusy) return;
            // Turning it OFF stays a deliberate, risk-acknowledged choice. The
            // shipped dialogue is preserved VERBATIM — it is the reason this row
            // is a switch with a ceremony rather than a plain switch.
            if (webWritesOn && !window.confirm(
              'Turn off write confirmations?\n\n'
              + 'The agent will be able to send data out (POST/PUT/DELETE) to any '
              + 'non-denylisted host WITHOUT asking — including if a web page or '
              + 'tool output hijacks it (prompt injection). This is the main guard '
              + 'against silent data exfiltration.\n\nTurn it off anyway?')) {
              return;
            }
            ui.webWriteBusy = true; m.redraw();
            try {
              await send({ type: 'settings/update', patch: { confirmWebWrites: !webWritesOn } });
            } finally { ui.webWriteBusy = false; m.redraw(); }
          },
        }),
      }),

      toggleRow({
        id: 'schema-replies',
        label: 'Strict replies from web helpers',
        on: schemaOn,
        busyKey: 'schemaReplyBusy',
        badge: 'EXPERIMENT',
        summary: schemaOn
          ? 'A helper’s report must fit a fixed structure; one that doesn’t is thrown away.'
          : 'A helper’s report comes back as prose, marked untrusted — a hint, not a wall.',
        why: schemaOn
          ? 'ON — when a web helper finishes reading a page, it must hand its report back in a fixed structure that peerd checks before the main agent ever sees it. A report that does not fit is thrown away and the agent is told only that it was unreadable. This closes the gap where a page could smuggle text past the “this is data, not instructions” fence by imitating it. The tradeoff: if the model wanders off the format, you lose that report and have to ask again.'
          : 'OFF — a web helper reports back in plain prose, marked as untrusted data. That marking is a strong hint to the model, not a wall. Turning this on makes it a wall, at the cost of occasionally losing a report the model formatted wrong. Experimental.',
        apply: () => send({ type: 'settings/update', patch: { schemaValidatedReplies: !schemaOn } }),
      }),

      // Firefox has no chrome.debugger WebExtension API (the build strips the
      // permission from Firefox manifests) — render the truth instead of a
      // switch that can't do anything.
      hasDebugger
        ? toggleRow({
          id: 'advanced-automation',
          label: 'Advanced automation',
          on: aaOn,
          busyKey: 'debuggerBusy',
          summary: aaOn
            ? 'peerd can drive apps that block scripts — Gmail, Notion, Slack. Chrome shows a debugging banner.'
            : 'Apps that block injected automation stay undrivable, and page reading takes a slower path.',
          why: aaOn
            ? 'On. peerd can drive apps that block injected scripts (Gmail, Notion, Slack) using the Chrome debugger. Chrome shows a "debugging this browser" banner while peerd is connected to a tab for automation; that connection can persist between actions until the tab closes or you turn this off. peerd never touches the sites on its built-in denylist (banks, health, password managers) regardless.'
            : 'Off. Some apps (Gmail, Notion, Slack) block injected automation, and page reading falls back to a slower path. Turning this on lets peerd act on them via the Chrome debugger, which shows a visible "debugging this browser" banner while it’s connected to a tab. The denylist applies regardless.',
          apply: () => send({ type: 'settings/update', patch: { advancedAutomationEnabled: !aaOn } }),
        })
        : settingsRow({
          id: 'advanced-automation',
          label: 'Advanced automation',
          pill: 'N/A',
          summary: 'Not available in this browser — Firefox has no Chrome debugger API.',
          why: 'The Chrome debugger API doesn’t exist in Firefox WebExtensions. peerd reads pages and uses selector-based click/type here; apps that block injected scripts (Gmail, Notion, Slack) may not be drivable.',
          open: whyOpen('advanced-automation'),
          onToggleWhy: toggleWhy('advanced-automation'),
          control: toggleSwitch({
            on: false,
            disabled: true,
            label: 'Advanced automation — not available in this browser',
            onclick: () => {},
          }),
        }),
    ];

    // ── Behavior — changes how it works, not what it may do ─────────────────
    const frontDoor = s.frontDoorView === 'home' ? 'home' : 'panel';
    const reasoningEnabled = s.reasoningEnabled !== false;
    const effort = s.reasoningEffort ?? 'medium';
    const arOn = s.autoResumeInterruptedTurns !== false;
    const foOn = s.providerFailoverEnabled !== false;
    const activeProvider = s.providerName || 'anthropic';
    const fallbacks = Array.isArray(s.providerFallbacks) ? s.providerFallbacks : [];
    const otherProviders = listProviders().map((p) => p.name).filter((n) => n !== activeProvider);

    // Preview-only key: absent from store packages' CHANNEL_DEFAULTS, so the
    // row simply doesn't render there. Presence, not typeof: a crafted
    // transfer import can store a non-boolean verbatim, and that must not
    // hide the row on a preview build (the toggle itself heals the value).
    const autoUpdateAvailable = Object.hasOwn(s, 'autoUpdateEnabled');
    const auOn = s.autoUpdateEnabled === true;

    const behaviorRows = [
      settingsRow({
        id: 'front-door',
        label: 'Toolbar button',
        summary: frontDoor === 'panel'
          ? 'Opens the chat in the side panel, next to the page you’re on.'
          : 'Opens the full-page home tab. Once home is open, the button pulls the panel in instead.',
        why: 'The keyboard shortcut (Cmd+Shift+P on Mac, Alt+Shift+P elsewhere) always toggles the side panel, whichever default you pick.',
        open: whyOpen('front-door'),
        onToggleWhy: toggleWhy('front-door'),
        control: m('select.set-select', {
          id: 'front-door-view',
          'aria-label': 'What the toolbar button opens',
          value: frontDoor,
          onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
            await send({ type: 'settings/update', patch: { frontDoorView: e.target.value } });
            m.redraw();
          },
        }, [['panel', 'side panel'], ['home', 'full-page home']]
          .map(([value, label]) => m('option', { value }, label))),
      }),

      toggleRow({
        id: 'reasoning',
        label: 'Reasoning',
        on: reasoningEnabled,
        busyKey: 'reasoningBusy',
        summary: reasoningEnabled
          ? `Shows the model’s thinking above each reply. Effort: ${effort}.`
          : 'Answers stream directly, with no visible reasoning.',
        why: reasoningEnabled
          ? 'The model streams its chain-of-reasoning before each answer, shown as a collapsible “Reasoning” section in chat. Costs a little extra latency and tokens per turn.'
          : 'Answers stream directly with no visible reasoning. Enable to surface the model’s chain-of-reasoning (extended thinking) above each reply — useful for watching the agent plan multi-step work.',
        apply: () => send({ type: 'settings/update', patch: { reasoningEnabled: !reasoningEnabled } }),
        // Effort is a CHILD: it only means anything while reasoning is on.
        // Collapsing hides it and never discards the stored value. ALL FIVE
        // levels stay — the redesign never specified this control's option set,
        // and quietly dropping two would remove capability under cover of a
        // visual change.
        children: reasoningEnabled ? [
          m('.input-row', [
            m('label', { for: 'reasoning-effort' }, 'Reasoning effort'),
            m('select', {
              id: 'reasoning-effort',
              value: effort,
              onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
                await send({ type: 'settings/update', patch: { reasoningEffort: e.target.value } });
                m.redraw();
              },
            }, [
              ['max', 'max — deepest'],
              ['xhigh', 'xhigh'],
              ['high', 'high'],
              ['medium', 'medium — default'],
              ['low', 'low — fastest'],
            ].map(([value, label]) => m('option', { value }, label))),
          ]),
          m('p.hint', 'Lower effort = less up-front reasoning and earlier action; the deepest effort is best on hard tasks. Anthropic chats only — OpenRouter/Ollama don’t honor it yet.'),
        ] : null,
      }),

      toggleRow({
        id: 'auto-resume',
        label: 'Auto-resume interrupted turns',
        on: arOn,
        busyKey: 'autoResumeBusy',
        summary: arOn
          ? 'A turn cut off mid-flight continues when you reopen the chat. One you stop yourself never resumes.'
          : 'A turn cut off mid-flight stays frozen until you resend it.',
        why: arOn
          ? 'On. If a turn is cut off mid-flight — the browser reclaims peerd’s background worker, or the model stream drops — reopening the chat (or unlocking the vault) continues it from where it left off. A turn you Stop yourself is never auto-resumed.'
          : 'Off. A turn cut off mid-flight stays frozen until you resend. Turn this on to have peerd pick an interrupted turn back up automatically when you reopen the chat.',
        apply: () => send({ type: 'settings/update', patch: { autoResumeInterruptedTurns: !arOn } }),
      }),

      ...(autoUpdateAvailable ? [toggleRow({
        id: 'auto-update',
        label: 'Auto-update',
        on: auOn,
        busyKey: 'autoUpdateBusy',
        badge: 'PREVIEW',
        summary: auOn
          ? 'Checks for a new preview build at startup and installs it when nothing is running.'
          : 'Preview updates wait for the browser’s own periodic check.',
        why: auOn
          ? 'On. At startup peerd asks the browser for a newer preview build from the release feed. In Chrome the update installs immediately when no chat is mid-turn and no peerd surface is open; otherwise it applies on the next browser restart. In Firefox, which gives extensions no way to trigger their own update, peerd shows an “update available” notice with an install link, and Firefox’s own daily add-on check still installs it on its own.'
          : 'Off. peerd stays on the installed build until the browser’s own periodic update check picks up a new preview release. Turn this on to check at startup and install right away.',
        apply: () => send({ type: 'settings/update', patch: { autoUpdateEnabled: !auOn } }),
      })] : []),

      toggleRow({
        id: 'failover',
        label: 'Provider failover',
        on: foOn,
        busyKey: 'failoverBusy',
        summary: foOn
          ? (fallbacks.length === 0
            ? 'No fallback selected, so this does nothing yet.'
            : `Falls back to ${fallbacks.join(', ')} when your provider stays down.`)
          : 'A provider that stays down ends the turn with an error.',
        why: foOn
          ? 'On. When your active provider stays overloaded past peerd’s retries, or returns a hard usage limit (out of credit / over a cap), peerd switches to a fallback provider below and continues the turn — but only before any of the answer has streamed. Each fallback uses its own key (or local daemon) and its default model. Without a fallback selected, this does nothing.'
          : 'Off. A provider that stays down (or out of credit) ends the turn with an error. Turn this on, then pick one or more fallback providers, to have peerd switch and keep going.',
        apply: () => send({ type: 'settings/update', patch: { providerFailoverEnabled: !foOn } }),
        // The fallback picker is only meaningful while failover is on.
        children: foOn ? m('div', [
          m('p.hint', otherProviders.length === 0
            ? 'No other providers are registered to fall back to.'
            : 'Fallbacks are tried in the order you select them. Each needs its own API key (or running daemon).'),
          ...otherProviders.map((name) => {
            const checked = fallbacks.includes(name);
            return m('label', { style: 'display:flex; gap:8px; align-items:center; margin:4px 0;' }, [
              m('input', {
                type: 'checkbox',
                checked,
                disabled: ui.fallbackBusy,
                onchange: async () => {
                  if (ui.fallbackBusy) return;
                  ui.fallbackBusy = true; m.redraw();
                  try {
                    await send({
                      type: 'settings/update',
                      patch: {
                        providerFallbacks: checked
                          ? fallbacks.filter((/** @type {string} */ n) => n !== name)
                          : [...fallbacks, name],
                      },
                    });
                  } finally { ui.fallbackBusy = false; m.redraw(); }
                },
              }),
              m('span', name + (checked ? ` (#${fallbacks.indexOf(name) + 1})` : '')),
            ]);
          }),
        ]) : null,
      }),
    ];

    // ── Experimental & diagnostics ───────────────────────────────────────────
    const pwOn = s.prewalkEnabled === true;
    const engOn = s.enginePrewalkEnabled === true;
    const surface = s.webActorActionSurface === 'code' ? 'code' : 'tools';
    const devMode = !!s.devMode;

    const experimentalRows = [
      toggleRow({
        id: 'prewalk',
        label: 'Prewalk',
        on: pwOn,
        busyKey: 'prewalkBusy',
        badge: 'EXPERIMENT',
        summary: pwOn
          ? 'Goal runs plan on your chat model, then continue on a cheaper executor.'
          : 'Goal runs stay on your chat model end to end. Turning this on lowers spend.',
        why: pwOn
          ? 'On. Goal runs open on your chat model for the planning phase (explore → commit a todo checklist → first action), then hand the live context to a cheaper executor model for the rest of the run. Spend drops; the plan and progress stay visible in the todo card.'
          : 'Off. Goal runs stay on your chat model end-to-end. Turning this on makes a goal run plan on your chat model, then continue on a cheaper executor model once its first action lands — same context, lower spend. Benchmark it first in the home page Lab (baseline vs prewalk).',
        apply: () => send({ type: 'settings/update', patch: { prewalkEnabled: !pwOn } }),
        children: m('div', [
          m('label', { style: 'display:flex; gap:8px; align-items:center; margin:2px 0 6px;' }, [
            m('input', {
              type: 'checkbox',
              checked: engOn,
              disabled: ui.enginePrewalkBusy,
              onchange: async () => {
                if (ui.enginePrewalkBusy) return;
                ui.enginePrewalkBusy = true; m.redraw();
                try {
                  await send({ type: 'settings/update', patch: { enginePrewalkEnabled: !engOn } });
                } finally { ui.enginePrewalkBusy = false; m.redraw(); }
              },
            }),
            m('span', 'Also apply prewalk to engine actors (VM / Notebook / App)'),
          ]),
          m('p.hint', engOn
            ? 'On. VM/Notebook/App actors run their first turn on your chat model, then swap to the executor below — lower cost on multi-turn engine work.'
            : 'First turn on your chat model to plan against the real instance state, then the cheaper executor for the rest. Benchmark it in the home Lab first.'),
          (pwOn || engOn) ? [
            m('.input-row', [
              m('label', { for: 'prewalk-executor' }, 'Executor model'),
              m('input', {
                id: 'prewalk-executor',
                type: 'text',
                placeholder: 'empty = provider fast default (e.g. Haiku)',
                value: s.prewalkExecutorModel ?? '',
                onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
                  await send({ type: 'settings/update', patch: { prewalkExecutorModel: e.target.value } });
                  m.redraw();
                },
              }),
            ]),
            m('p.hint', 'A model id on the SAME provider as the chat, shared by goal-run and engine-actor prewalk. Leave empty to use the provider’s fast default — the same model the web actor rides.'),
          ] : null,
        ]),
      }),

      settingsRow({
        id: 'surface',
        label: 'Web actor: action surface',
        badge: 'MODE',
        summary: surface === 'code'
          ? 'The web helper drives pages by writing JavaScript. Same gates either way.'
          : 'One tool call per action. Same gates either way.',
        why: surface === 'code'
          ? 'Selected — the web actor writes short JavaScript against a Playwright-style page API in a sealed worker. The same page tools, denylist, confirmation, and audit gates remain underneath. Preview/dev starts here; a browser without the sealed-worker host automatically falls back to tool calls. Applies to the next web-actor turn; an in-flight actor finishes on the surface it started with.'
          : 'Selected — the web actor emits one tool call per page action (click, type, navigate). Store packages start here while the code surface gathers field evidence. The same gates apply in both modes. Applies to the next web-actor turn; an in-flight actor finishes on the surface it started with.',
        open: whyOpen('surface'),
        onToggleWhy: toggleWhy('surface'),
        control: m('select.set-select', {
          id: 'web-actor-surface',
          'aria-label': 'Web actor action surface',
          value: surface,
          onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
            await send({ type: 'settings/update', patch: { webActorActionSurface: e.target.value } });
            m.redraw();
          },
        }, [['tools', 'tool calls'], ['code', 'code']]
          .map(([value, label]) => m('option', { value }, label))),
      }),

      toggleRow({
        id: 'dev-mode',
        label: 'Developer mode',
        on: devMode,
        busyKey: 'devModeBusy',
        summary: devMode
          ? 'The WebVM wrapper install and verify output shows in the terminal at boot.'
          : 'WebVM wrapper install and verify output stays out of the terminal.',
        why: devMode
          ? 'Verbose VM diagnostics ON: the wrapper install + verify output is shown in the WebVM terminal at boot, and marker round-trips are timed in the boot log. Your own commands are never traced. Takes effect on the next WebVM reset.'
          : 'Show the WebVM wrapper install + verify output in the terminal at boot, plus marker timing in the boot log. Useful when curl/wget wrappers aren’t working and you need to see why. Off by default — extra noise.',
        apply: () => send({ type: 'settings/update', patch: { devMode: !devMode } }),
      }),
    ];

    return m('div', [
      settingsBand({
        name: 'Safety', subtitle: 'changes what peerd may do', safety: true, rows: safetyRows,
      }),
      settingsBand({
        name: 'Behavior', subtitle: 'changes how it works, not what it may do', rows: behaviorRows,
      }),
      settingsBand({ name: 'Experimental & diagnostics', rows: experimentalRows }),

      resetRow(send, [
        'frontDoorView',
        'reasoningEnabled', 'reasoningEffort', 'confirmWebWrites', 'schemaValidatedReplies',
        'advancedAutomationEnabled', 'devMode',
        'autoResumeInterruptedTurns', 'autoUpdateEnabled',
        'providerFailoverEnabled', 'providerFallbacks',
        'prewalkEnabled', 'enginePrewalkEnabled', 'prewalkExecutorModel',
      ]),
    ]);
  },
};
