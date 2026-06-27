// @ts-check
// Options → Behavior — how the agent acts.
//
// The panel's "Agent behavior" section, renamed and regrouped per the
// options IA: confirm-before-actions, reasoning + effort, background
// tabs, plus advanced automation and developer mode (both moved out of
// the old "Advanced" section — they are behavior toggles, not a junk
// drawer). Spend limit moved to Costs; auto-memory moved to Memory —
// and their resetRow keys moved with them.

import m from '/vendor/mithril/mithril.js';
import { listProviders } from '/peerd-provider/index.js';
import { resetRow } from './reset-row.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const BehaviorSection = {
  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const reasoningEnabled = state.settings?.reasoningEnabled !== false;
    const devMode = !!state.settings?.devMode;
    // One source of truth with the chat top bar's ModeSelector: both read
    // permission.confirmActions off SW state and write through the same
    // permission/set route. There is no second axis.
    const confirmsOn = state.session?.permission?.confirmActions === true;

    return m('div', [
      // peerd ACTS by default (acting on the browser is the point). This
      // is the optional seatbelt: flip it on to confirm each side-effect.
      m('h3', 'Confirm before actions'),
      m('p', confirmsOn
        ? 'ON — peerd asks before each side-effecting action (click, type, navigate, run code, fetch, write). Confirmation prompts appear in the peerd panel, next to the chat.'
        : 'OFF — peerd acts without asking (it clicks, types, navigates, runs code, and edits). That’s the default: acting on a live tab, a Notebook, or a WebVM is the point. Memory writes always confirm.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button.secondary', {
          type: 'button',
          disabled: ui.confirmBusy,
          onclick: async () => {
            if (ui.confirmBusy) return;
            ui.confirmBusy = true;
            // why: flip ONLY the confirm boolean — mode (Plan/Act) is the
            // ModeSelector's axis and this toggle must not yank a user
            // out of Plan as a side effect.
            await send({ type: 'permission/set', confirmActions: !confirmsOn });
            ui.confirmBusy = false;
            m.redraw();
          },
        }, ui.confirmBusy ? '…' : confirmsOn ? 'Disable confirmations' : 'Enable confirmations'),
      ]),

      m('.settings-divider'),
      // Anti-exfiltration gate for NON-GET web egress (fetch_url + the WebVM
      // bridge) — independent of the Plan/Act confirm toggle above, which is OFF
      // by default. This one is ON by default: it's the seatbelt against a
      // prompt-injected agent silently POSTing in-context data to an attacker.
      ((webWritesOn) => [
        m('h3', 'Confirm before sending data out'),
        m('p', webWritesOn
          ? 'ON — peerd asks before any request that can transmit a BODY out of the browser (POST/PUT/PATCH/DELETE/OPTIONS) — from the web actor\'s fetch or inside a WebVM (curl, etc.). You can approve a single write or all writes for that chat. This is the main guard against a prompt-injected agent exfiltrating data via a write. (Plain reads — GET/HEAD — are never gated; the denylist is the guard there.)'
          : 'OFF — peerd can send POST/PUT/DELETE requests to any non-denylisted host WITHOUT asking, including under prompt injection. The denylist still blocks known-sensitive sites, but everything else is open. Not recommended.'),
        m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
          m('button.secondary', {
            type: 'button',
            disabled: ui.webWriteBusy,
            onclick: async () => {
              if (ui.webWriteBusy) return;
              // Turning it OFF is a deliberate, risk-acknowledged choice.
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
              } finally {
                ui.webWriteBusy = false; m.redraw();
              }
            },
          }, ui.webWriteBusy ? '…' : webWritesOn ? 'Turn off write confirmations' : 'Turn on write confirmations'),
        ]),
      ])(state.settings?.confirmWebWrites !== false),

      m('.settings-divider'),
      m('h3', 'Reasoning'),
      m('p', reasoningEnabled
        ? 'The model streams its chain-of-reasoning before each answer, shown as a collapsible “Reasoning” section in chat. Costs a little extra latency and tokens per turn.'
        : 'Answers stream directly with no visible reasoning. Enable to surface the model’s chain-of-reasoning (extended thinking) above each reply — useful for watching the agent plan multi-step work.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button.secondary', {
          type: 'button',
          disabled: ui.reasoningBusy,
          onclick: async () => {
            if (ui.reasoningBusy) return;
            ui.reasoningBusy = true;
            await send({ type: 'settings/update', patch: { reasoningEnabled: !reasoningEnabled } });
            ui.reasoningBusy = false;
            m.redraw();
          },
        }, ui.reasoningBusy ? '…' : reasoningEnabled ? 'Disable reasoning' : 'Enable reasoning'),
      ]),
      // Effort only applies while reasoning is on, so hide it otherwise.
      // Also dialable from the chat mode row — this is the same global
      // setting, just its settings-page home.
      reasoningEnabled ? [
        m('.input-row', [
          m('label', { for: 'reasoning-effort' }, 'Reasoning effort'),
          m('select', {
            id: 'reasoning-effort',
            value: state.settings?.reasoningEffort ?? 'medium',
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

      // (No "Background tabs" toggle: a tab peerd OPENS takes focus so the
      // user sees it (DECISIONS #20, 2026-06-14); acting on an existing tab
      // never steals focus. open_tab active:false opens quietly when needed.)

      m('.settings-divider'),
      m('h3', 'Advanced automation'),
      (() => {
        // Firefox has no chrome.debugger WebExtension API (the build
        // strips the permission from Firefox manifests) — render the
        // truth instead of a switch that can't do anything.
        if (!globalThis.chrome?.debugger) {
          return m('p', 'Not available in this browser — the Chrome '
            + 'debugger API doesn’t exist in Firefox WebExtensions. '
            + 'peerd reads pages and uses selector-based click/type here; '
            + 'apps that block injected scripts (Gmail, Notion, Slack) '
            + 'may not be drivable.');
        }
        // This is a SETTING, not a permission flow: Chrome refuses
        // `debugger` in optional_permissions ("Permission 'debugger'
        // cannot be listed as optional"), so the permission is granted
        // at install and this switch controls whether the SW actually
        // wires the CDP pool into tool contexts.
        const aaOn = state.settings?.advancedAutomationEnabled !== false;
        return [
          m('p', aaOn
            ? 'On. peerd can drive apps that block injected scripts (Gmail, Notion, Slack) using the Chrome debugger. Chrome shows a "debugging this browser" banner while peerd is connected to a tab for automation; that connection can persist between actions until the tab closes or you turn this off. peerd never touches the sites on its built-in denylist (banks, health, password managers) regardless.'
            : 'Off. Some apps (Gmail, Notion, Slack) block injected automation, and page reading falls back to a slower path. Turning this on lets peerd act on them via the Chrome debugger, which shows a visible "debugging this browser" banner while it’s connected to a tab. The denylist applies regardless.'),
          m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
            m('button.secondary', {
              type: 'button',
              disabled: ui.debuggerBusy,
              onclick: async () => {
                if (ui.debuggerBusy) return;
                ui.debuggerBusy = true; m.redraw();
                try {
                  await send({
                    type: 'settings/update',
                    patch: { advancedAutomationEnabled: !aaOn },
                  });
                } catch (e) {
                  console.warn('[options] advanced-automation toggle failed', e);
                } finally {
                  ui.debuggerBusy = false; m.redraw();
                }
              },
            }, ui.debuggerBusy ? '…' : aaOn ? 'Turn off advanced automation' : 'Turn on advanced automation'),
          ]),
        ];
      })(),

      m('.settings-divider'),
      m('h3', 'Developer mode'),
      m('p', devMode
        ? 'Verbose VM diagnostics ON: the wrapper install + verify output is shown in the WebVM terminal at boot, and marker round-trips are timed in the boot log. Your own commands are never traced. Takes effect on the next WebVM reset.'
        : 'Show the WebVM wrapper install + verify output in the terminal at boot, plus marker timing in the boot log. Useful when curl/wget wrappers aren’t working and you need to see why. Off by default — extra noise.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button.secondary', {
          type: 'button',
          disabled: ui.devModeBusy,
          onclick: async () => {
            if (ui.devModeBusy) return;
            ui.devModeBusy = true;
            await send({ type: 'settings/update', patch: { devMode: !devMode } });
            ui.devModeBusy = false;
            m.redraw();
          },
        }, ui.devModeBusy ? '…' : devMode ? 'Disable developer mode' : 'Enable developer mode'),
      ]),

      // ── Resilience ─────────────────────────────────────────────────
      m('.settings-divider'),
      m('h3', 'Auto-resume interrupted turns'),
      (() => {
        const arOn = state.settings?.autoResumeInterruptedTurns !== false;
        return [
          m('p', arOn
            ? 'On. If a turn is cut off mid-flight — the browser reclaims peerd’s background worker, or the model stream drops — reopening the chat (or unlocking the vault) continues it from where it left off. A turn you Stop yourself is never auto-resumed.'
            : 'Off. A turn cut off mid-flight stays frozen until you resend. Turn this on to have peerd pick an interrupted turn back up automatically when you reopen the chat.'),
          m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
            m('button.secondary', {
              type: 'button',
              disabled: ui.autoResumeBusy,
              onclick: async () => {
                if (ui.autoResumeBusy) return;
                ui.autoResumeBusy = true; m.redraw();
                try {
                  await send({ type: 'settings/update', patch: { autoResumeInterruptedTurns: !arOn } });
                } finally { ui.autoResumeBusy = false; m.redraw(); }
              },
            }, ui.autoResumeBusy ? '…' : arOn ? 'Disable auto-resume' : 'Enable auto-resume'),
          ]),
        ];
      })(),

      m('.settings-divider'),
      m('h3', 'Provider failover'),
      (() => {
        const foOn = state.settings?.providerFailoverEnabled !== false;
        const active = state.settings?.providerName || 'anthropic';
        const fallbacks = Array.isArray(state.settings?.providerFallbacks)
          ? state.settings.providerFallbacks : [];
        const others = listProviders()
          .map((p) => p.name)
          .filter((name) => name !== active);
        const setFallbacks = async (/** @type {string[]} */ next) => {
          if (ui.fallbackBusy) return;
          ui.fallbackBusy = true; m.redraw();
          try {
            await send({ type: 'settings/update', patch: { providerFallbacks: next } });
          } finally { ui.fallbackBusy = false; m.redraw(); }
        };
        return [
          m('p', foOn
            ? 'On. When your active provider stays overloaded past peerd’s retries, or returns a hard usage limit (out of credit / over a cap), peerd switches to a fallback provider below and continues the turn — but only before any of the answer has streamed. Each fallback uses its own key (or local daemon) and its default model. Without a fallback selected, this does nothing.'
            : 'Off. A provider that stays down (or out of credit) ends the turn with an error. Turn this on, then pick one or more fallback providers, to have peerd switch and keep going.')
          ,
          m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
            m('button.secondary', {
              type: 'button',
              disabled: ui.failoverBusy,
              onclick: async () => {
                if (ui.failoverBusy) return;
                ui.failoverBusy = true; m.redraw();
                try {
                  await send({ type: 'settings/update', patch: { providerFailoverEnabled: !foOn } });
                } finally { ui.failoverBusy = false; m.redraw(); }
              },
            }, ui.failoverBusy ? '…' : foOn ? 'Disable failover' : 'Enable failover'),
          ]),
          // Fallback picker — only meaningful while failover is on. Each row
          // is a registered provider other than the active one; checking it
          // appends to the ordered fallback list, unchecking removes it.
          foOn ? m('div', { style: 'margin-top:10px;' }, [
            m('p.hint', others.length === 0
              ? 'No other providers are registered to fall back to.'
              : 'Fallbacks are tried in the order you select them. Each needs its own API key (or running daemon).'),
            ...others.map((name) => {
              const checked = fallbacks.includes(name);
              return m('label', {
                style: 'display:flex; gap:8px; align-items:center; margin:4px 0;',
              }, [
                m('input', {
                  type: 'checkbox',
                  checked,
                  disabled: ui.fallbackBusy,
                  onchange: () => setFallbacks(
                    checked
                      ? fallbacks.filter((/** @type {string} */ n) => n !== name)
                      : [...fallbacks, name],
                  ),
                }),
                m('span', name + (checked ? ` (#${fallbacks.indexOf(name) + 1})` : '')),
              ]);
            }),
          ]) : null,
        ];
      })(),

      resetRow(send, [
        'reasoningEnabled', 'reasoningEffort', 'confirmWebWrites', 'advancedAutomationEnabled', 'devMode',
        'autoResumeInterruptedTurns', 'providerFailoverEnabled', 'providerFallbacks',
      ]),
    ]);
  },
};
