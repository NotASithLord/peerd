// @ts-check
// Options → Providers & models — provider key cards + default model.
//
// Ported verbatim from the panel's settings-view "Providers & models"
// section (the disclosure Section wrapper is dropped; the options shell
// renders the page heading). Each provider gets its own logo card with
// a slick inline key editor (collapsed to a masked badge until you hit
// Replace), plus the default provider+model selectors, the page-reader
// model, and the Ollama GPU-fit recommendation.
//
// The key is sent to the SW as plaintext via runtime.sendMessage; the
// SW encrypts it with the vault DK before persisting. The plaintext
// never lands in chrome.storage and never leaves the SW after the
// encryption step.

import m from '/vendor/mithril/mithril.js';
import {
  OLLAMA_MODEL_TIERS,
  probeGpuCapability,
  recommendOllamaModel,
} from '/peerd-provider/index.js';
import { resetRow } from './reset-row.js';
import { LocalModelsSection } from './local-models.js';

/** @typedef {import('./reset-row.js').Send} Send */
/** @typedef {{ name: string, label: string, hasKey?: boolean, keyless?: boolean, keyPreview?: string }} ProviderRow */

// ── Provider logos ──────────────────────────────────────────────────────
// Inline SVG marks (no network, no external asset — same privacy posture
// as the rest of peerd). Brand-evocative, not pixel-exact reproductions:
// a coral sunburst for Anthropic, a routing fan-out for OpenRouter, and a
// neutral monogram tile for anything else.
const ANTHROPIC_MARK =
  '<svg viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="Anthropic">'
  + '<rect width="32" height="32" rx="7" fill="#CC785C"/>'
  + '<g stroke="#fff" stroke-width="3" stroke-linecap="round">'
  + '<line x1="16" y1="8" x2="16" y2="24"/><line x1="8" y1="16" x2="24" y2="16"/>'
  + '<line x1="10.3" y1="10.3" x2="21.7" y2="21.7"/><line x1="21.7" y1="10.3" x2="10.3" y2="21.7"/>'
  + '</g></svg>';
const OPENROUTER_MARK =
  '<svg viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="OpenRouter">'
  + '<rect width="32" height="32" rx="7" fill="#6566F1"/>'
  + '<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8 16 H15"/><path d="M15 16 L23.5 10.5"/><path d="M15 16 L23.5 21.5"/>'
  + '</g>'
  + '<g fill="#fff"><circle cx="8" cy="16" r="2"/><circle cx="23.5" cy="10.5" r="2"/><circle cx="23.5" cy="21.5" r="2"/></g>'
  + '</svg>';
// Ollama: a minimal llama-head silhouette on a neutral tile — evocative
// of the upstream mark without reproducing it.
const OLLAMA_MARK =
  '<svg viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="Ollama">'
  + '<rect width="32" height="32" rx="7" fill="#3B3B40"/>'
  + '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M12 12 V7.5"/><path d="M20 12 V7.5"/>'
  + '<rect x="9" y="10.5" width="14" height="14" rx="6"/>'
  + '</g>'
  + '<g fill="#fff"><circle cx="13.5" cy="17" r="1.5"/><circle cx="18.5" cy="17" r="1.5"/></g>'
  + '</svg>';

/** @param {string} name */
const providerLogo = (name) => {
  if (name === 'anthropic') return m('span.provider-logo', m.trust(ANTHROPIC_MARK));
  if (name === 'openrouter') return m('span.provider-logo', m.trust(OPENROUTER_MARK));
  if (name === 'ollama') return m('span.provider-logo', m.trust(OLLAMA_MARK));
  return m('span.provider-logo.logo-generic', (String(name)[0] ?? '?').toUpperCase());
};

export const ProvidersSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    // Per-provider key entry state — keyed by provider name so every
    // provider has its own independent input / busy / message / editing.
    vnode.state.keyInput = {};      // name -> draft value
    vnode.state.keyBusy = {};       // name -> bool
    vnode.state.keyMsg = {};        // name -> { ok, text }
    vnode.state.keyEditing = {};    // name -> bool (Replace revealed the field)
    vnode.state.providerStatus = null;  // [{ name, label, defaultModel, hasKey }]
    ProvidersSection.loadProviderStatus(vnode);
  },

  // Fetch per-provider key status (which providers have a key stored).
  // Called on mount and after any key save so the badges stay accurate.
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  loadProviderStatus(vnode) {
    vnode.attrs.send({ type: 'provider/status' }).then((/** @type {any} */ r) => {
      if (r?.ok) { vnode.state.providerStatus = r.providers; m.redraw(); }
    }).catch(() => {});
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const provider = state.providers ?? { current: 'anthropic', hasKey: false };
    const providerModel = state.settings?.providerModel ?? '';

    // Per-provider key prefixes — a cheap "looks like a real key" format
    // check so a wrong paste is caught at save time instead of silently
    // failing on the first chat. Both shipped key providers use stable
    // sk- prefixes; absence from this map = no prefix check (fails open).
    /** @type {Record<string, string>} */
    const KEY_PREFIX = { anthropic: 'sk-ant-', openrouter: 'sk-or-' };

    // Save a key for ONE provider, independently of the others.
    /** @param {string} name */
    const saveKey = async (name) => {
      if (ui.keyBusy[name]) return;
      const value = (ui.keyInput[name] ?? '').trim();
      ui.keyMsg[name] = null;
      if (value.length < 8) {
        ui.keyMsg[name] = { ok: false, text: 'Paste a complete API key.' };
        m.redraw();
        return;
      }
      const prefix = KEY_PREFIX[name];
      if (prefix && !value.startsWith(prefix)) {
        ui.keyMsg[name] = {
          ok: false,
          text: `That doesn't look like this provider's API key — it should start with "${prefix}".`,
        };
        m.redraw();
        return;
      }
      ui.keyBusy[name] = true;
      m.redraw();
      const reply = await send({ type: 'provider/setKey', provider: name, plaintext: value });
      ui.keyBusy[name] = false;
      if (reply?.ok) {
        ui.keyInput[name] = '';
        ui.keyEditing[name] = false;   // collapse the editor back to the badge
        ui.keyMsg[name] = { ok: true, text: 'Saved — encrypted in the vault.' };
        // Refresh the badges so this provider flips to "Key saved".
        const sr = await send({ type: 'provider/status' });
        if (sr?.ok) ui.providerStatus = sr.providers;
        // Auto-verify so the user never has to click Test (the ask). For
        // OpenRouter the model panel below loads the live catalog — that load
        // IS the verification (and populates the curation list). Bump its
        // reload token BEFORE the redraw so the panel (mounting now the key
        // exists) loads exactly once, not twice. For the others, a 1-token
        // ping confirms in the card.
        if (name === 'openrouter') ui.orReloadToken = (ui.orReloadToken ?? 0) + 1;
        m.redraw();
        if (name !== 'openrouter') await testKey(name);
      } else {
        ui.keyMsg[name] = {
          ok: false,
          text: reply?.error === 'locked'
            ? 'Vault is locked — unlock in the peerd panel first.'
            : reply?.error ?? 'Something went wrong.',
        };
      }
      m.redraw();
    };

    // Validate a SAVED key with a 1-token ping on the real provider endpoint,
    // so the tester knows it works before sending a real message. Keyless
    // providers (Ollama) ping the local daemon instead — the SW reports
    // the installed-model count.
    /** @param {string} name */
    const testKey = async (name) => {
      if (ui.keyBusy[name]) return;
      ui.keyBusy[name] = true; ui.keyMsg[name] = null; m.redraw();
      const reply = await send({ type: 'provider/test', provider: name });
      ui.keyBusy[name] = false;
      ui.keyMsg[name] = reply?.ok
        ? {
            ok: true,
            text: typeof reply.models === 'number'
              ? `✓ Connected — Ollama is running (${reply.models} model${reply.models === 1 ? '' : 's'} installed).`
              : '✓ Connected — the key works.',
          }
        : {
            ok: false,
            text: reply?.error === 'invalid-key' ? 'Provider rejected the key (401). Double-check it.'
              : reply?.error === 'no-key' ? 'No key saved for this provider yet.'
              : reply?.error === 'locked' ? 'Vault is locked — unlock in the peerd panel first.'
              : `Couldn’t reach the provider: ${reply?.error ?? 'unknown error'}.`,
          };
      m.redraw();
    };

    // Providers for the keys manager + default selector. Falls back to
    // the known names while the provider/status fetch is in flight.
    /** @type {ProviderRow[]} */
    const providerRows = ui.providerStatus ?? [
      { name: 'anthropic',  label: 'Anthropic',  hasKey: provider.current === 'anthropic'  && provider.hasKey },
      { name: 'openrouter', label: 'OpenRouter', hasKey: provider.current === 'openrouter' && provider.hasKey },
      { name: 'ollama',     label: 'Ollama (local)', hasKey: true, keyless: true },
    ];
    /** @param {string} name */
    const keyPlaceholder = (name) => `${KEY_PREFIX[name] ?? 'sk-'}...`;
    const defaultProvRow = providerRows.find((p) => p.name === provider.current);

    // One provider per card: logo, name, key status, and a slick inline
    // key editor that stays collapsed to the masked badge until you hit
    // Replace — no permanent "paste a new key" field cluttering the row.
    // Keyless providers (Ollama) get a "no key needed" badge and only the
    // Test button — there is no key to save or replace.
    /** @param {ProviderRow} p */
    const renderProviderCard = (p) => {
      const editing = !!ui.keyEditing[p.name];
      const busy = !!ui.keyBusy[p.name];
      const msg = ui.keyMsg[p.name];
      const draft = ui.keyInput[p.name] ?? '';
      const showForm = !p.keyless && (editing || !p.hasKey);
      return m('.provider-card', [
        m('.provider-card-main', [
          providerLogo(p.name),
          m('.provider-card-text', [
            m('span.provider-card-name', p.label),
            p.keyless
              ? m('span.key-badge.key-set', '✓ Local — no key needed')
              : p.hasKey
                ? m('span.key-badge.key-set', p.keyPreview ? `✓ ${p.keyPreview}` : '✓ Key saved')
                : m('span.key-badge.key-unset', 'No key set'),
          ]),
          ((p.hasKey || p.keyless) && !editing)
            ? m('span', { style: 'margin-left:auto;display:inline-flex;gap:10px;' }, [
                m('button.linkish', {
                  type: 'button',
                  disabled: busy,
                  onclick: () => testKey(p.name),
                }, busy ? '…' : 'Test'),
                p.keyless ? null : m('button.linkish', {
                  type: 'button',
                  onclick: () => { ui.keyEditing[p.name] = true; ui.keyMsg[p.name] = null; m.redraw(); },
                }, 'Replace'),
              ])
            : null,
        ]),
        showForm
          ? m('form.provider-card-form', { onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); saveKey(p.name); } }, [
              m('.input-row', [
                m('input', {
                  type: 'password',
                  autocomplete: 'off',
                  spellcheck: false,
                  placeholder: keyPlaceholder(p.name),
                  value: draft,
                  disabled: busy,
                  // why: focus the field the instant Replace reveals it.
                  oncreate: editing ? (/** @type {{ dom: HTMLInputElement }} */ vn) => vn.dom.focus() : undefined,
                  oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.keyInput[p.name] = e.target.value; },
                }),
                m('button', { type: 'submit', disabled: busy || !draft.trim() },
                  busy ? '…' : p.hasKey ? 'Replace' : 'Save'),
                editing
                  ? m('button.secondary', {
                      type: 'button',
                      disabled: busy,
                      onclick: () => {
                        ui.keyEditing[p.name] = false;
                        ui.keyInput[p.name] = '';
                        ui.keyMsg[p.name] = null;
                        m.redraw();
                      },
                    }, 'Cancel')
                  : null,
              ]),
            ])
          : null,
        // Card-level message (Save OR Test) — shows whether the form is open or
        // collapsed (Test runs while the card is collapsed).
        msg ? m(`p.key-msg${msg.ok ? '.ok' : '.err'}`, msg.text) : null,
      ]);
    };

    return m('div', [
      m('p', 'Bring your own key — set one per provider; each is stored '
        + 'independently and encrypted in the vault. OpenRouter is an '
        + 'OpenAI-compatible gateway to many vendors’ models. Ollama '
        + 'runs models on THIS machine — keyless, $0, fully local.'),
      m('.provider-cards', providerRows.map(renderProviderCard)),

      // OpenRouter model curation — only once a key is saved (the gateway has
      // hundreds of models, so the user checks which ones the chat picker
      // offers). Reload token bumps after a key save so a replaced key
      // re-verifies + re-lists.
      (providerRows.find((p) => p.name === 'openrouter')?.hasKey)
        ? [m('.settings-divider'), m(OpenRouterModels, { state, send, reloadToken: ui.orReloadToken ?? 0 })]
        : null,

      m('.settings-divider'),
      m('h3', 'Default model for new chats'),
      m('p', 'Which provider + model a fresh chat starts on. With keys for '
        + 'more than one provider you can also switch the model per chat from '
        + 'the picker above the message box. Existing chats keep theirs.'),
      m('.input-row', [
        m('label', { for: 'provider' }, 'Provider'),
        m('select', {
          id: 'provider',
          value: provider.current,
          onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
            // Reset the model override on switch so the new provider's
            // default applies until the user picks one.
            await send({ type: 'settings/update', patch: { providerName: e.target.value, providerModel: '' } });
            m.redraw();
          },
        }, providerRows.map((p) => m('option', { value: p.name }, p.label))),
      ]),
      m('.input-row', [
        m('label', { for: 'model' }, 'Model'),
        m('input', {
          id: 'model',
          type: 'text',
          spellcheck: false,
          placeholder: provider.model ?? '',
          value: providerModel,
          onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
            await send({ type: 'settings/update', patch: { providerModel: e.target.value } });
            m.redraw();
          },
        }),
      ]),
      m('p.hint', provider.current === 'openrouter'
        ? ['Model id like ', m('code', 'openai/gpt-4o'), '. Leave blank for the default.']
        : provider.current === 'ollama'
          ? ['Model id like ', m('code', 'qwen3:8b'), ' — it must be pulled in Ollama first. Leave blank for the default.']
          : ['Leave blank for the default (', m('code', provider.model ?? 'claude-sonnet-4-6'), ').']),
      (defaultProvRow && !defaultProvRow.hasKey)
        ? m('p.error.hint', `No key set for ${defaultProvRow.label} yet — add one above, or new chats on it will fail.`)
        : null,
      // "Which local model fits this machine?" — only meaningful when
      // local inference is the selected provider.
      provider.current === 'ollama'
        ? [m('.settings-divider'), m(OllamaRecommendation, { send })]
        : null,
      m('.input-row', [
        m('label', { for: 'runner-model' }, 'Page-reader model'),
        m('input', {
          id: 'runner-model',
          type: 'text',
          spellcheck: false,
          // why: blank no longer means "inherit chat model" — it means this
          // provider's fast runner default (Haiku on Anthropic). Show that id
          // as the placeholder so the field is honest about what runs.
          placeholder: provider.defaultRunnerModel ?? 'claude-haiku-4-5',
          value: state.settings?.runnerModel ?? '',
          onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
            await send({ type: 'settings/update', patch: { runnerModel: e.target.value } });
            m.redraw();
          },
        }),
      ]),
      m('p.hint', [
        'The page-reading sub-agents (',
        m('code', 'get'), '/', m('code', 'check'),
        ') run on a fast, cheap model by default — ',
        m('code', provider.defaultRunnerModel ?? 'claude-haiku-4-5'),
        ' on ', m('strong', defaultProvRow?.label ?? 'this provider'),
        '. Leave blank for that default, or pin any same-provider model id. ',
        'It falls back to the chat model automatically when it struggles.',
      ]),
      resetRow(send, ['providerName', 'providerModel', 'runnerModel']),

      m('p.muted.settings-footer', [
        'Default model: ', m('code', provider.model ?? 'claude-sonnet-4-6'),
        '. All traffic goes through ', m('code', 'safeFetch'),
        ' against the hardcoded provider allowlist.',
      ]),

      // On-device WebGPU models live on the SAME page as the cloud providers —
      // one place to configure every model the agent can use, local or remote.
      m('.settings-divider'),
      m('h3.providers-subhead', 'On-device models (WebGPU)'),
      m(LocalModelsSection, { state, send }),
    ]);
  },
};

// ---- Ollama: GPU capability → model recommendation ------------------------
//
// Rendered when Ollama is the selected provider. The probe
// (navigator.gpu adapter limits + deviceMemory/hardwareConcurrency) only
// works in a document context — exactly where this component lives; the
// SW never runs it. The recommendation logic itself is pure
// (peerd-provider/ollama-recommend.js) and bun-tested.

const OllamaRecommendation = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.loading = true;
    vnode.state.rec = null;
    vnode.state.applied = false;
    probeGpuCapability()
      .then((cap) => { vnode.state.rec = recommendOllamaModel(cap); })
      .catch(() => { vnode.state.rec = null; })
      .finally(() => { vnode.state.loading = false; m.redraw(); });
  },
  /** @param {{ attrs: { send: Send }, state: any }} vnode */
  view: ({ attrs: { send }, state: ui }) => {
    const rec = ui.rec;
    // Smallest tier = the safe suggestion when the machine is unreadable.
    const smallest = OLLAMA_MODEL_TIERS[OLLAMA_MODEL_TIERS.length - 1];
    /** @param {string} model */
    const pullHint = (model) => m('p', { style: 'margin:6px 0;' }, [
      'Get it with: ', m('code', `ollama pull ${model}`),
    ]);
    /** @param {string} model */
    const useButton = (model) => m('button.secondary', {
      type: 'button',
      style: 'font-size:12px;',
      disabled: ui.applied,
      onclick: async () => {
        await send({ type: 'settings/update', patch: { providerModel: model } });
        ui.applied = true;
        m.redraw();
      },
    }, ui.applied ? '✓ Set as default model' : 'Use as default model');

    return m('.ollama-recommend', [
      m('h3', 'Recommended local model'),
      ui.loading
        ? m('p.hint', 'Sizing up this machine…')
        : !rec || rec.confidence === 'none'
          // No capability signals at all (no WebGPU, no deviceMemory) —
          // suggest the smallest tier rather than nothing.
          ? [
              m('p', [
                'This browser exposes no hardware signals (WebGPU unavailable), so peerd can’t size this machine. ',
                m('code', smallest.model),
                ` (${smallest.sizeClass}-class) is a safe starting point.`,
              ]),
              pullHint(smallest.model),
              useButton(smallest.model),
            ]
          : rec.model
            ? [
                m('p', [
                  `Based on ${rec.signals.includes('webgpu') ? 'this machine’s GPU limits' : 'coarse browser signals'}, `,
                  m('strong', rec.label),
                  ` (${rec.sizeClass}-class, ~${rec.q4SizeGB} GB download) should run well here.`,
                ]),
                rec.confidence === 'low'
                  ? m('p.hint', 'WebGPU isn’t available here, so this is a conservative guess — a bigger machine may handle a larger tier.')
                  : null,
                pullHint(rec.model),
                useButton(rec.model),
              ]
            : [
                // Signals exist but even the smallest tier doesn't fit.
                m('p', [
                  'This machine reads as too small for local inference to be pleasant — but ',
                  m('code', smallest.model),
                  ` (${smallest.sizeClass}-class) may still work for light use.`,
                ]),
                pullHint(smallest.model),
              ],
    ]);
  },
};

// ---- OpenRouter: curate which models the chat picker offers --------------
//
// OpenRouter is a gateway to hundreds of models — far too many for a chat
// dropdown. So Settings is where the user picks the ones they want: a search
// box over the LIVE catalog plus checkboxes; the checked ids persist to
// settings.openrouterModels and become the chat picker's OpenRouter options.
// The catalog load doubles as key verification (a 401/403 → "rejected"), which
// is why saving an OpenRouter key auto-(re)loads this panel — no Test click.

// How many of the curated "popular" seed to show before the user searches.
const OPENROUTER_PREVIEW_COUNT = 20;

/** @typedef {{ model: string, label: string }} OpenRouterModel */

const OpenRouterModels = {
  /** @param {{ state: any, attrs: { reloadToken?: number, send: Send, state?: any } }} vnode */
  oninit(vnode) {
    vnode.state.loading = true;
    vnode.state.error = null;
    vnode.state.models = null;        // full live catalog [{ model, label, ... }]
    vnode.state.popular = [];         // curated seed ids
    vnode.state.query = '';
    vnode.state.selected = null;      // working Set of chosen ids (seeded once)
    vnode.state.loadedToken = vnode.attrs.reloadToken ?? 0;
    OpenRouterModels.load(vnode);
  },
  /** @param {{ state: any, attrs: { reloadToken?: number, send: Send, state?: any } }} vnode */
  onupdate(vnode) {
    // A key save bumps reloadToken — re-verify + re-list against the new key.
    if ((vnode.attrs.reloadToken ?? 0) !== vnode.state.loadedToken) {
      vnode.state.loadedToken = vnode.attrs.reloadToken ?? 0;
      OpenRouterModels.load(vnode);
    }
  },
  /** @param {{ state: any, attrs: { send: Send, state?: any } }} vnode */
  load(vnode) {
    vnode.state.loading = true;
    vnode.state.error = null;
    m.redraw();
    vnode.attrs.send({ type: 'openrouter/models' }).then((/** @type {any} */ r) => {
      vnode.state.loading = false;
      if (r?.ok) {
        vnode.state.models = r.models ?? [];
        vnode.state.popular = r.popular ?? [];
        // Seed the working selection from saved settings the FIRST time we
        // have data; later toggles own it (and persist on each change).
        if (vnode.state.selected === null) {
          const saved = vnode.attrs.state?.settings?.openrouterModels ?? [];
          vnode.state.selected = new Set(saved);
        }
      } else {
        vnode.state.error = r?.error === 'invalid-key'
          ? 'OpenRouter rejected the key — double-check it above.'
          : `Couldn’t reach OpenRouter: ${r?.error ?? 'unknown error'}.`;
      }
      m.redraw();
    }).catch(() => {
      vnode.state.loading = false;
      vnode.state.error = 'Couldn’t reach OpenRouter.';
      m.redraw();
    });
  },
  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {string} id
   */
  toggle(vnode, id) {
    const sel = vnode.state.selected;
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    // Persist immediately — the chat picker reads settings.openrouterModels.
    vnode.attrs.send({ type: 'settings/update', patch: { openrouterModels: [...sel] } });
    m.redraw();
  },
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  view(vnode) {
    const ui = vnode.state;
    if (ui.loading && !ui.models) {
      return m('.or-models', m('p.hint', 'Verifying key & loading models…'));
    }
    if (ui.error) return m('.or-models', m('p.error.hint', ui.error));
    /** @type {OpenRouterModel[]} */
    const all = ui.models ?? [];
    if (all.length === 0) return null;
    /** @type {Set<string>} */
    const sel = ui.selected ?? new Set();
    const q = ui.query.trim().toLowerCase();

    // Default view (no search): the curated popular seed intersected with the
    // live catalog, plus any already-selected models outside the seed so a
    // custom pick stays visible. Searching filters the FULL catalog.
    /** @type {OpenRouterModel[]} */
    let shown;
    if (q) {
      shown = all
        .filter((mdl) => mdl.model.toLowerCase().includes(q) || mdl.label.toLowerCase().includes(q))
        .slice(0, 100);
    } else {
      const liveById = new Map(all.map((mdl) => [mdl.model, mdl]));
      /** @type {Set<string>} */
      const popularSet = new Set(ui.popular);
      const seed = ui.popular.filter((/** @type {string} */ id) => liveById.has(id)).map((/** @type {string} */ id) => liveById.get(id))
        .slice(0, OPENROUTER_PREVIEW_COUNT);
      const extra = all.filter((mdl) => sel.has(mdl.model) && !popularSet.has(mdl.model));
      shown = [...seed, ...extra];
    }

    return m('.or-models', [
      m('h3', 'Available OpenRouter models'),
      m('p.hint', [
        'Pick which models the chat picker offers. ',
        m('strong', `${sel.size} selected`),
        ` · ${all.length} available on OpenRouter.`,
      ]),
      m('input.or-search', {
        type: 'search',
        spellcheck: false,
        placeholder: `Search ${all.length} models…`,
        value: ui.query,
        oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.query = e.target.value; m.redraw(); },
      }),
      m('.or-model-list', shown.map((mdl) =>
        m('label.or-model-row', { key: mdl.model }, [
          m('input', {
            type: 'checkbox',
            checked: sel.has(mdl.model),
            onchange: () => OpenRouterModels.toggle(vnode, mdl.model),
          }),
          m('span.or-model-name', mdl.label),
          m('code.or-model-id', mdl.model),
        ]))),
      (!q && all.length > shown.length)
        ? m('p.hint', `Showing ${shown.length} popular — search to pick from all ${all.length}.`)
        : null,
    ]);
  },
};
