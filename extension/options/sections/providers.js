// @ts-check
// Options → Providers & models — provider key cards + default model.
//
// Ported verbatim from the panel's settings-view "Providers & models"
// section (the disclosure Section wrapper is dropped; the options shell
// renders the page heading). Each provider gets its own logo card with
// a slick inline key editor (collapsed to a masked badge until you hit
// Replace), plus the default provider+model selectors, the web-actor
// model, and the Ollama GPU-fit recommendation.
//
// The key is sent to the SW as plaintext via runtime.sendMessage; the
// SW encrypts it with the vault DK before persisting. The plaintext
// never lands in chrome.storage and never leaves the SW after the
// encryption step.

import m from '/vendor/mithril/mithril.js';
import {
  KEY_PREFIX,
  OLLAMA_MODEL_TIERS,
  checkApiKeyFormat,
  probeGpuCapability,
  recommendOllamaModel,
} from '/peerd-provider/index.js';
import { LocalModelsSection } from './local-models.js';
import {
  isUnknownMutationOutcome, mutationFailureCopy,
} from '../mutation-custody.js';

/** @typedef {import('./reset-row.js').Send} Send */
/** @typedef {{ name: string, label: string, defaultModel?: string, defaultRunnerModel?: string, hasKey?: boolean, keyless?: boolean, liveModels?: boolean, keyPreview?: string }} ProviderRow */

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
// Z.ai: a teal tile with a white Z monogram — brand-evocative, not a logo clone.
const ZAI_MARK =
  '<svg viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="Z.ai">'
  + '<rect width="32" height="32" rx="7" fill="#0EA5A4"/>'
  + '<path d="M9 10 H23 L11 22 H23" fill="none" stroke="#fff" stroke-width="2.6"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>'
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
  if (name === 'glm') return m('span.provider-logo', m.trust(ZAI_MARK));
  if (name === 'ollama') return m('span.provider-logo', m.trust(OLLAMA_MARK));
  return m('span.provider-logo.logo-generic', (String(name)[0] ?? '?').toUpperCase());
};

export const ProvidersSection = {
  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  oninit(vnode) {
    // Per-provider key entry state — keyed by provider name so every
    // provider has its own independent input / busy / message / editing.
    vnode.state.keyInput = {};      // name -> draft value
    vnode.state.keyBusy = {};       // name -> bool
    vnode.state.keyMsg = {};        // name -> { ok, text }
    vnode.state.keyEditing = {};    // name -> bool (Replace revealed the field)
    vnode.state.keyUncertain = {};  // name -> save receipt lost; status must reconcile
    vnode.state.providerStatus = null;  // [{ name, label, defaultModel, hasKey }]
    vnode.state.providerStatusError = false;
    // name -> 'checking' | 'connected' | 'down' — the LIVE reachability of a
    // keyless daemon (Ollama). Drives the badge so green means "actually
    // connected", never just "no key needed".
    vnode.state.connStatus = {};
    // Model dropdown options — fetched lazily from the view (see modelOptionsKey)
    // using the SAME source as the chat picker (models/options).
    vnode.state.modelOptions = null;
    vnode.state.modelOptionsKey = '';
    vnode.state.modelOptionsGeneration = 0;
    vnode.state.probeGeneration = {};
    vnode.state.ollamaHostSave = null;
    vnode.state.ollamaHostSaving = false;
    vnode.state.ollamaHostUncertain = false;
    vnode.state.ollamaHostSaveGeneration = 0;
    vnode.state.settingsBusy = false;
    vnode.state.settingsUncertain = false;
    vnode.state.settingsMsg = null;
    vnode.state.providerStatusGeneration = 0;
    vnode.state.observedConfigRevision = vnode.attrs.state?.providers?.configRevision ?? 0;
    ProvidersSection.loadProviderStatus(vnode);
  },

  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  onupdate(vnode) {
    const revision = vnode.attrs.state?.providers?.configRevision ?? 0;
    if (revision !== vnode.state.observedConfigRevision) {
      vnode.state.observedConfigRevision = revision;
      ProvidersSection.loadProviderStatus(vnode);
    }
  },

  // Fetch per-provider key status (which providers have a key stored).
  // Called on mount and after any key save so the badges stay accurate.
  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  async loadProviderStatus(vnode) {
    const generation = vnode.state.providerStatusGeneration + 1;
    vnode.state.providerStatusGeneration = generation;
    vnode.state.providerStatusError = false;
    try {
      const r = await vnode.attrs.send({ type: 'provider/status' });
      if (vnode.state.providerStatusGeneration !== generation) return;
      if (!r?.ok || !Array.isArray(r.providers)) {
        vnode.state.providerStatusError = true;
        m.redraw();
        return null;
      }
      vnode.state.providerStatus = r.providers;
      m.redraw();
      // Auto-probe keyless providers that expose a live daemon (Ollama): the
      // badge should reflect REAL reachability, not a default-green. Quiet
      // (no card message) so an unused provider doesn't shout a red error on
      // mount; clicking Test still gives the full message.
      for (const p of r.providers) {
        if (p.keyless && p.liveModels) ProvidersSection.probeConnection(vnode, p.name);
      }
      return r;
    } catch {
      if (vnode.state.providerStatusGeneration !== generation) return null;
      vnode.state.providerStatusError = true;
      m.redraw();
      return null;
    }
  },

  // Quietly ping a keyless daemon (provider/test) and record reachability for
  // the badge. The explicit Test button reuses provider/test too, but also
  // surfaces the full message; this path only moves the badge.
  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {string} name */
  probeConnection(vnode, name) {
    const generation = (vnode.state.probeGeneration[name] ?? 0) + 1;
    vnode.state.probeGeneration[name] = generation;
    vnode.state.connStatus[name] = 'checking';
    m.redraw();
    vnode.attrs.send({ type: 'provider/test', provider: name }).then((/** @type {any} */ r) => {
      if (vnode.state.probeGeneration[name] !== generation) return;
      vnode.state.connStatus[name] = r?.ok ? 'connected'
        : r?.reachable && r?.error === 'no-models' ? 'no-models'
          : 'down';
      vnode.state.modelOptionsKey = '';
      m.redraw();
    }).catch(() => {
      if (vnode.state.probeGeneration[name] !== generation) return;
      vnode.state.connStatus[name] = 'down';
      m.redraw();
    });
  },

  // Fetch the Model-dropdown options from the SAME source the chat picker uses
  // (models/options -> buildModelOptions): every configured provider's curated
  // models. Called from the view whenever the provider / curated set / key
  // state changes, so the selector tracks what you've picked.
  /**
   * @param {any} state
   * @param {Send} send
   */
  loadModelOptions(state, send) {
    const generation = ++state.modelOptionsGeneration;
    send({ type: 'models/options' }).then((/** @type {any} */ r) => {
      if (generation !== state.modelOptionsGeneration) return;
      if (r?.ok) { state.modelOptions = r.options ?? []; m.redraw(); }
    }).catch(() => {});
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const provider = state.providers ?? { current: 'anthropic', hasKey: false };
    const providerModel = state.settings?.providerModel ?? '';
    const actorExecution = state.capabilities?.actorExecution;
    const actorUnavailable = actorExecution && actorExecution.status !== 'available';

    /**
     * @param {{ type: string } & Record<string, any>} message
     * @param {string} action
     */
    const saveSetting = async (message, action) => {
      if (ui.settingsBusy || ui.settingsUncertain) return false;
      ui.settingsBusy = true;
      ui.settingsMsg = null;
      m.redraw();
      try {
        let reply;
        try { reply = await send(message); }
        catch { reply = { ok: false, outcomeKnown: false }; }
        if (reply?.ok) return true;
        ui.settingsUncertain = isUnknownMutationOutcome(reply);
        ui.settingsMsg = mutationFailureCopy(reply, {
          action,
          fallback: 'The provider setting could not be saved.',
        });
        return false;
      } finally {
        ui.settingsBusy = false;
        m.redraw();
      }
    };

    // Save a key for ONE provider, independently of the others. The paste
    // sanity check is the shared checkApiKeyFormat (peerd-provider) - the
    // onboarding provider step applies the identical rule (§5h).
    /** @param {string} name */
    const saveKey = async (name) => {
      if (ui.keyBusy[name]) return;
      ui.keyMsg[name] = null;
      const check = checkApiKeyFormat(name, ui.keyInput[name]);
      if (!check.ok) {
        ui.keyMsg[name] = { ok: false, text: check.message };
        m.redraw();
        return;
      }
      const value = check.value;
      ui.keyBusy[name] = true;
      m.redraw();
      try {
        let reply;
        try { reply = await send({ type: 'provider/setKey', provider: name, plaintext: value }); }
        catch { reply = { ok: false, outcomeKnown: false }; }
        if (reply?.ok) {
          ui.keyUncertain[name] = false;
          ui.keyInput[name] = '';
          ui.keyEditing[name] = false;   // collapse the editor back to the badge
          ui.keyMsg[name] = { ok: true, text: 'Saved; encrypted in the vault.' };
          // Refresh the badges so this provider flips to "Key saved".
          await ProvidersSection.loadProviderStatus({ attrs: { state, send }, state: ui });
          // Auto-verify so the user never has to click Test (the ask). For
          // OpenRouter the model panel below loads the live catalog; that load
          // IS the verification (and populates the curation list).
          if (name === 'openrouter') ui.orReloadToken = (ui.orReloadToken ?? 0) + 1;
          m.redraw();
          if (name !== 'openrouter') {
            ui.keyBusy[name] = false;
            await testKey(name);
          }
        } else {
          const uncertain = isUnknownMutationOutcome(reply);
          ui.keyUncertain[name] = uncertain;
          ui.keyMsg[name] = { ok: false, text: mutationFailureCopy(reply, {
            action: 'saving the provider key', fallback: 'The provider key could not be saved.',
            messages: { locked: 'Vault is locked; unlock in the peerd panel first.' },
          }) };
        }
      } finally {
        ui.keyBusy[name] = false;
        m.redraw();
      }
    };

    // Validate a SAVED key with a 1-token ping on the real provider endpoint,
    // so the tester knows it works before sending a real message. Keyless
    // providers (Ollama) ping the local daemon instead — the SW reports
    // the installed-model count.
    /** @param {string} name */
    const testKey = async (name) => {
      // A blur/change event can race the immediately following Test click.
      // Never let the test route observe the old persisted host.
      while (name === 'ollama' && ui.ollamaHostSave) {
        await ui.ollamaHostSave.catch(() => {});
      }
      if (ui.keyBusy[name]) return;
      const generation = (ui.probeGeneration[name] ?? 0) + 1;
      ui.probeGeneration[name] = generation;
      ui.keyBusy[name] = true; ui.keyMsg[name] = null; m.redraw();
      let reply;
      try { reply = await send({ type: 'provider/test', provider: name }); }
      catch { reply = { ok: false, outcomeKnown: false }; }
      ui.keyBusy[name] = false;
      if (ui.probeGeneration[name] !== generation) { m.redraw(); return; }
      // Keep the badge in sync with an explicit Test (keyless daemons only — the
      // badge for keyed providers tracks hasKey, not live reachability).
      ui.connStatus[name] = reply?.ok ? 'connected'
        : reply?.reachable && reply?.error === 'no-models' ? 'no-models'
          : 'down';
      const uncertain = isUnknownMutationOutcome(reply);
      if (uncertain) ui.keyUncertain[name] = true;
      ui.keyMsg[name] = reply?.ok
        ? {
            ok: true,
            text: typeof reply.models === 'number'
              ? `✓ Connected — Ollama is running (${reply.models} model${reply.models === 1 ? '' : 's'} installed).`
              : '✓ Connected — the key works.',
          }
        : {
            ok: false,
            text: uncertain ? 'Peerd could not confirm the provider test. Refresh before testing again.'
              : reply?.error === 'invalid-key' ? 'Provider rejected the key (401). Double-check it.'
              : reply?.error === 'no-key' ? 'No key saved for this provider yet.'
              : reply?.error === 'locked' ? 'Vault is locked — unlock in the peerd panel first.'
              : reply?.error === 'no-models' ? 'Ollama is running, but it has no models installed. Get one with: ollama pull qwen3:8b'
              : name === 'ollama' && reply?.error === 'unreachable'
                ? 'Couldn’t reach Ollama. Start it with: ollama serve'
              : 'Couldn’t reach the provider.',
          };
      if (name === 'ollama' && (reply?.ok || reply?.reachable)) ui.modelOptionsKey = '';
      m.redraw();
    };

    // Providers for the keys manager + default selector. Falls back to
    // the known names while the provider/status fetch is in flight.
    /** @type {ProviderRow[]} */
    const providerRows = ui.providerStatus ?? [
      { name: 'anthropic',  label: 'Anthropic',  hasKey: provider.current === 'anthropic'  && provider.hasKey },
      { name: 'openrouter', label: 'OpenRouter', hasKey: provider.current === 'openrouter' && provider.hasKey },
      { name: 'openai',     label: 'OpenAI', hasKey: provider.current === 'openai' && provider.hasKey },
      { name: 'glm',        label: 'Z.ai',       hasKey: provider.current === 'glm'        && provider.hasKey },
      { name: 'ollama',     label: 'Ollama', hasKey: true, keyless: true },
    ];
    /** @param {string} name */
    const keyPlaceholder = (name) => KEY_PREFIX[name]
      ? `${KEY_PREFIX[name]}...`
      // why: providers without a stable sk- prefix (Z.ai GLM keys are shaped
      // `id.secret`) get a neutral hint rather than a misleading `sk-...`.
      : 'your API key';
    const settingsProviderName = state.settings?.providerName ?? '';
    const localWebGpuAvailable = state.capabilities?.localWebGpuHost?.status === 'available';
    // why NOT localWebGpuAvailable here: that flag is a HOST fact, not readiness.
    // It reports only that an offscreen document can be created, so it is true on
    // every Chrome regardless of GPU or whether the on-device model was ever
    // downloaded. models/options is the readiness signal: model-catalog drops
    // local-webgpu until it is resident, so membership there means a first turn
    // would actually run. Matches ensureActiveProvider, which binds a new chat on
    // localModelState.available(); Settings must not name a default the SW would
    // refuse to bind.
    const localWebGpuReady = (ui.modelOptions ?? [])
      .some((/** @type {any} */ o) => o.provider === 'local-webgpu');
    // why: A provider is usable when it has its required key, the on-device model
    // is resident, or a keyless daemon is reachable. Keep an explicitly chosen
    // Ollama usable through a transient outage so its warning does not replace
    // the configured default controls. A confirmed no-models result still blocks.
    /** @param {ProviderRow} p */
    const isUsable = (p) => (!p.keyless && !!p.hasKey)
      || (p.name === 'local-webgpu' && localWebGpuReady)
      || (!!p.keyless && ui.connStatus[p.name] === 'connected')
      || (p.name === 'ollama'
        && settingsProviderName === p.name
        && ui.connStatus[p.name] !== 'no-models');
    const firstUsable = providerRows.find(isUsable);
    const anyUsable = !!firstUsable || ((ui.modelOptions ?? []).length > 0);
    // The provider the block edits. HONOR an explicit choice as-is — even one
    // with no key yet: the "No key set" hint below says so honestly, whereas
    // silently switching would desync the <select> from the persisted
    // providerName (and start fresh chats on a different provider than shown).
    // Only when NOTHING is explicitly chosen do we pick the first usable
    // provider — so a fresh OpenRouter/Ollama user sees THAT, not the Anthropic
    // fallback resolveActiveProvider returns for an empty providerName. The
    // modelOptions[0] fallback covers the brief window where a daemon probe is
    // still in flight (so it never momentarily reads as Anthropic).
    const selectableProviderRows = providerRows.filter((p) =>
      p.name !== 'local-webgpu'
        || localWebGpuAvailable);
    const effectiveProvider =
      (settingsProviderName && selectableProviderRows.some((p) => p.name === settingsProviderName))
        ? settingsProviderName
        : (firstUsable?.name ?? (ui.modelOptions ?? [])[0]?.provider ?? provider.current);
    const defaultProvRow = providerRows.find((p) => p.name === effectiveProvider);
    const providerRunnerDefault = defaultProvRow?.defaultRunnerModel ?? provider.defaultRunnerModel ?? 'claude-haiku-4-5';
    const localRunnerCapable = localWebGpuAvailable;
    // Keep the Model selector populated from the chat-picker source; re-fetch
    // when the active provider, the curated OpenRouter set, or key-state changes.
    const providerStatusKey = providerRows
      .map((p) => `${p.name}:${p.hasKey ? 1 : 0}:${ui.connStatus[p.name] ?? ''}`)
      .join(',');
    const moKey = `${effectiveProvider}|${providerStatusKey}|${state.settings?.ollamaHost ?? ''}|${(state.settings?.openrouterModels ?? []).join(',')}`;
    if (moKey !== ui.modelOptionsKey) {
      ui.modelOptionsKey = moKey;
      ProvidersSection.loadModelOptions(ui, send);
    }
    const modelOpts = (ui.modelOptions ?? []).filter((/** @type {any} */ o) => o.provider === effectiveProvider);

    // One provider per card: logo, name, key status, and a slick inline
    // key editor that stays collapsed to the masked badge until you hit
    // Replace — no permanent "paste a new key" field cluttering the row.
    // Keyless providers (Ollama) get a "no key needed" badge and only the
    // Test button — there is no key to save or replace.
    /** @param {ProviderRow} p */
    const renderProviderCard = (p) => {
      const editing = !!ui.keyEditing[p.name];
      const busy = !!ui.keyBusy[p.name] || !!ui.keyUncertain[p.name]
        || (p.name === 'ollama' && (ui.ollamaHostSaving || ui.ollamaHostUncertain));
      const msg = ui.keyMsg[p.name];
      const draft = ui.keyInput[p.name] ?? '';
      const showForm = !p.keyless && (editing || !p.hasKey);
      return m('.provider-card', [
        m('.provider-card-main', [
          providerLogo(p.name),
          m('.provider-card-text', [
            m('span.provider-card-name', p.label),
            p.keyless
              // Keyless local daemon (Ollama): green is EARNED by a live probe,
              // not given for free. Neutral until we've confirmed it answers.
              ? (ui.connStatus[p.name] === 'connected'
                  ? m('span.key-badge.key-set', '✓ Connected')
                  : ui.connStatus[p.name] === 'no-models'
                    ? m('span.key-badge.key-local', 'Connected, no models')
                  : ui.connStatus[p.name] === 'checking'
                    ? m('span.key-badge.key-local', 'Checking…')
                    : ui.connStatus[p.name] === 'down'
                      ? m('span.key-badge.key-local', 'Not reachable')
                    : m('span.key-badge.key-local', 'No key needed'))
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
                  disabled: busy,
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
        ui.keyUncertain[p.name] && !p.keyless && draft
          ? m('button.secondary', {
              type: 'button', disabled: !!ui.keyBusy[p.name],
              onclick: () => saveKey(p.name),
            }, 'Finish the same save')
          : null,
        p.name === 'ollama' ? [
          m('.input-row', [
            m('label', { for: 'ollama-host' }, 'Ollama host'),
            m('input', {
              id: 'ollama-host',
              type: 'text',
              spellcheck: false,
              disabled: ui.ollamaHostSaving || ui.ollamaHostUncertain,
              placeholder: 'http://localhost:11434',
              value: state.settings?.ollamaHost ?? '',
              onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
                if (ui.ollamaHostSaving || ui.ollamaHostUncertain) return;
                const value = e.target.value.trim();
                const generation = ++ui.ollamaHostSaveGeneration;
                ui.ollamaHostSaving = true;
                m.redraw();
                const save = (async () => {
                  let reply;
                  try {
                    reply = value
                      ? await send({ type: 'settings/update', patch: { ollamaHost: value } })
                      : await send({ type: 'settings/reset', keys: ['ollamaHost'] });
                  } catch {
                    reply = { ok: false, outcomeKnown: false };
                  }
                  if (generation !== ui.ollamaHostSaveGeneration) return;
                  if (!reply?.ok) {
                    ui.ollamaHostUncertain = isUnknownMutationOutcome(reply);
                    ui.keyMsg.ollama = { ok: false, text: mutationFailureCopy(reply, {
                      action: 'saving the Ollama host',
                      fallback: 'Enter a full http:// or https:// Ollama URL.',
                    }) };
                    return;
                  }
                  ui.ollamaHostUncertain = false;
                  ui.keyMsg.ollama = null;
                  ui.modelOptionsKey = '';
                  ProvidersSection.probeConnection({ state: ui, attrs: { send } }, 'ollama');
                })();
                ui.ollamaHostSave = save;
                try { await save; }
                finally {
                  if (generation === ui.ollamaHostSaveGeneration) {
                    ui.ollamaHostSaving = false;
                    ui.ollamaHostSave = null;
                  }
                  m.redraw();
                }
              },
            }),
          ]),
          m('p.hint', [
            'Leave blank for ', m('code', 'http://localhost:11434'),
            ', or enter the address of a remote daemon. Over plain HTTP only ',
            m('code', '11434'), ' is reachable; an HTTPS-fronted host works on any port.',
          ]),
        ] : null,
      ]);
    };

    return m('div', [
      m('p', 'Bring your own key — set one per provider; each is stored '
        + 'independently and encrypted in the vault. OpenRouter is an '
        + 'OpenAI-compatible gateway to many vendors’ models. Z.ai serves '
        + 'its GLM models (GLM-5.2, …) from a direct OpenAI-compatible '
        + 'endpoint. Ollama runs models on a daemon you control: keyless '
        + 'with no per-token API cost. Using localhost keeps inference on this machine.'),
      ui.providerStatusError ? m('.settings-inline-error', { role: 'alert' }, [
        m('p', 'Peerd could not refresh provider status. Existing choices remain unchanged.'),
        m('button', {
          type: 'button',
          onclick: () => ProvidersSection.loadProviderStatus({ attrs: { state, send }, state: ui }),
        }, 'Retry provider status'),
      ]) : null,
      // The on-device WebGPU model is a full provider now — its card hosts the
      // hardware-test → download → ready flow inline (the old split-out
      // "On-device models" section is folded in here), with a status-driven
      // badge instead of a meaningless key form.
      m('.provider-cards', providerRows.map((p) =>
        p.name === 'local-webgpu'
          ? m(LocalModelsSection, {
              state,
              send,
              logo: providerLogo('local-webgpu'),
              label: p.label,
              onReady: () => { ui.modelOptionsKey = ''; m.redraw(); },
            })
          : renderProviderCard(p))),

      // OpenRouter model curation — only once a key is saved (the gateway has
      // hundreds of models, so the user checks which ones the chat picker
      // offers). Reload token bumps after a key save so a replaced key
      // re-verifies + re-lists.
      (providerRows.find((p) => p.name === 'openrouter')?.hasKey)
        ? [m('.settings-divider'), m(OpenRouterModels, { state, send, reloadToken: ui.orReloadToken ?? 0 })]
        : null,

      // Gated: until ANY provider is usable (a key saved, or a reachable Ollama),
      // this whole block stays out — no Anthropic-by-default selectors on a
      // fresh install. It appears + becomes configurable the moment you connect
      // one, bound to that provider (effectiveProvider), not a keyless guess.
      // Render nothing until provider status has loaded, so an established user
      // never flashes the empty-state during the initial fetch.
      ui.providerStatus === null ? null : anyUsable ? [
        m('.settings-divider'),
        m('h3', 'Default model for new chats'),
        m('p', 'Which provider + model a fresh chat starts on. With keys for '
          + 'more than one provider you can also switch the model per chat from '
          + 'the picker above the message box. Existing chats keep theirs.'),
        m('.input-row', [
          m('label', { for: 'provider' }, 'Provider'),
          m('select', {
            id: 'provider',
            disabled: ui.settingsBusy || ui.settingsUncertain,
            value: effectiveProvider,
            onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
              // Reset the model override on switch so the new provider's
              // default applies until the user picks one.
              await saveSetting(
                { type: 'settings/update', patch: { providerName: e.target.value, providerModel: '' } },
                'changing the default provider',
              );
            },
          }, selectableProviderRows.map((p) => m('option', { value: p.name }, p.label))),
        ]),
        m('.input-row', [
          m('label', { for: 'model' }, 'Model'),
          m('select', {
            id: 'model',
            disabled: ui.settingsBusy || ui.settingsUncertain,
            value: providerModel,
            onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
              await saveSetting(
                { type: 'settings/update', patch: { providerModel: e.target.value } },
                'changing the default model',
              );
            },
          }, [
            // Blank = the provider's own default model.
            m('option', { value: '' }, `Default — ${defaultProvRow?.defaultModel ?? 'provider default'}`),
            ...modelOpts.map((/** @type {any} */ o) => m('option', { value: o.model }, o.label)),
            // Keep a current custom/legacy id selectable even if it isn't curated.
            (providerModel && !modelOpts.some((/** @type {any} */ o) => o.model === providerModel))
              ? m('option', { value: providerModel }, `${providerModel} (custom)`)
              : null,
          ]),
        ]),
        m('p.hint', effectiveProvider === 'openrouter'
          ? ['Pick from the models you curated above, or ', m('strong', 'Default'), ' for the gateway default.']
          : effectiveProvider === 'ollama'
            ? ['Models you’ve pulled in Ollama appear here, or ', m('strong', 'Default'), ' for the provider default.']
            : ['Choose a model, or ', m('strong', 'Default'), ' for the provider default.']),
        (defaultProvRow && !defaultProvRow.hasKey)
          ? m('p.error.hint', `No key set for ${defaultProvRow.label} yet — add one above, or new chats on it will fail.`)
          : null,
        // "Which local model fits this machine?" — only meaningful when
        // local inference is the selected provider.
        effectiveProvider === 'ollama'
          ? [
              m('.settings-divider'),
              m(OllamaRecommendation, { send }),
            ]
          : null,
        m('.input-row', [
          m('label', { for: 'runner-model' }, 'Web actor model'),
          m('input', {
            id: 'runner-model',
            'aria-describedby': actorUnavailable ? 'runner-model-hint runner-model-status' : 'runner-model-hint',
            type: 'text',
            spellcheck: false,
            disabled: ui.settingsBusy || ui.settingsUncertain,
            // Blank is an automatic policy, not a fixed provider model: an
            // installed Local WebGPU runner wins, then the provider fast model.
            placeholder: 'Automatic',
            value: state.settings?.runnerModel ?? '',
            onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
              await saveSetting(
                { type: 'settings/update', patch: { runnerModel: e.target.value } },
                'changing the web actor model',
              );
            },
          }),
        ]),
        m('p.hint', { id: 'runner-model-hint' }, [
          'The web actor — peerd’s page reader and operator — runs on a fast, cheap ',
          'model. Leave blank for Automatic: ',
          ...(localRunnerCapable
            ? ['use Local WebGPU when its model is installed; otherwise use ']
            : ['use ']),
          m('code', providerRunnerDefault),
          ' on ', m('strong', defaultProvRow?.label ?? 'this provider'),
          '. Enter a model id to pin the web actor to this provider instead.',
        ]),
        actorUnavailable
          ? m('p.hint', { id: 'runner-model-status' }, actorExecution.status === 'temporarily_unavailable'
              ? 'Actor work is paused. You can set this now; it will apply after actor execution recovers.'
              : 'This browser cannot run actors. You can still save this setting for a browser that can.')
          : null,
        m('div', { style: 'margin-top:10px;' }, [
          m('button.secondary', {
            type: 'button',
            style: 'font-size:12px;',
            disabled: ui.settingsBusy || ui.settingsUncertain,
            onclick: () => saveSetting(
              { type: 'settings/reset', keys: ['providerName', 'providerModel', 'runnerModel'] },
              'resetting the provider settings',
            ),
          }, ui.settingsBusy ? 'Saving…' : 'Reset section to defaults'),
        ]),
        ui.settingsMsg ? m('p.error.hint', ui.settingsMsg) : null,

        m('p.muted.settings-footer', [
          'Default model: ', m('code', defaultProvRow?.defaultModel ?? 'provider default'),
          '. All traffic goes through ', m('code', 'safeFetch'),
          ' against the hardcoded provider allowlist.',
        ]),
      ] : [
        m('.settings-divider'),
        m('h3', 'Default model for new chats'),
        m('p.muted', 'Add an API key for a provider above — or start a local '
          + 'Ollama daemon — and this is where you’ll pick the default model and '
          + 'web actor model for new chats. Nothing is assumed until you '
          + 'connect a provider.'),
      ],
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
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.error = null;
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
      disabled: ui.applied || ui.busy || ui.uncertain,
      onclick: async () => {
        if (ui.busy || ui.uncertain) return;
        ui.busy = true;
        ui.error = null;
        m.redraw();
        try {
          let reply;
          try { reply = await send({ type: 'settings/update', patch: { providerModel: model } }); }
          catch { reply = { ok: false, outcomeKnown: false }; }
          if (reply?.ok) ui.applied = true;
          else {
            ui.uncertain = isUnknownMutationOutcome(reply);
            ui.error = mutationFailureCopy(reply, {
              action: 'setting the recommended model',
              fallback: 'The recommended model could not be saved.',
            });
          }
        } finally {
          ui.busy = false;
          m.redraw();
        }
      },
    }, ui.applied ? '✓ Set as default model' : ui.busy ? 'Saving…' : 'Use as default model');

    return m('.ollama-recommend', [
      m('h3', 'Recommended local model'),
      ui.error ? m('p.error.hint', ui.error) : null,
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
    vnode.state.saving = false;
    vnode.state.uncertain = false;
    vnode.state.saveError = null;
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
          : 'Couldn’t reach OpenRouter.';
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
  async toggle(vnode, id) {
    if (vnode.state.saving || vnode.state.uncertain) return;
    const sel = vnode.state.selected;
    const previous = new Set(sel);
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    vnode.state.saving = true;
    vnode.state.saveError = null;
    m.redraw();
    try {
      let reply;
      try {
        reply = await vnode.attrs.send({
          type: 'settings/update', patch: { openrouterModels: [...sel] },
        });
      } catch {
        reply = { ok: false, outcomeKnown: false };
      }
      if (!reply?.ok) {
        vnode.state.uncertain = isUnknownMutationOutcome(reply);
        vnode.state.saveError = mutationFailureCopy(reply, {
          action: 'saving the OpenRouter model selection',
          fallback: 'The OpenRouter model selection could not be saved.',
        });
        if (!vnode.state.uncertain) vnode.state.selected = previous;
      }
    } finally {
      vnode.state.saving = false;
      m.redraw();
    }
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
      ui.saveError ? m('p.error.hint', ui.saveError) : null,
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
            disabled: ui.saving || ui.uncertain,
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
