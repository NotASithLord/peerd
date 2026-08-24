// @ts-check
// Onboarding step 0 - Choose a provider (§5h).
//
// The one step the shipped funnel was missing: nothing between the vault and
// the first chat mentioned a provider, so a brand-new user reached an empty
// composer whose first message failed against a model they never chose. This
// step sits BETWEEN the vault gate and the naming funnel deliberately - the
// ordering IS the trust argument: "your key is encrypted in the vault you
// just created" is only true in that order.
//
// It CALLS the shipped plumbing, never forks it: the paste sanity check is
// the shared checkApiKeyFormat (peerd-provider/key-format.js), the save is
// the same provider/setKey route the options card uses, the verification is
// the same provider/test one-token ping, and the Ollama reachability mark is
// EARNED by the same live daemon probe - green is never assumed.
//
// Skippable by design (the spec's open question, resolved to its author's
// lean): "I'll do this later" advances the funnel with no writes, and the
// downstream surfaces already land a keyless user somewhere honest (the
// composer's add-a-key-in-Settings empty state).

import m from '/vendor/mithril/mithril.js';
import { checkApiKeyFormat, KEY_PREFIX } from '/peerd-provider/ui.js';

/** @typedef {(msg: object) => Promise<any>} Send */

/**
 * @typedef {Object} ProviderRow
 * @property {string} name
 * @property {string} label
 * @property {boolean} keyless
 * @property {boolean} [liveModels]
 * @property {boolean} [hasKey]
 */

// §5h row labels where the mock names a provider differently from the
// registry label. Display-only - the registry stays the identity.
/** @type {Readonly<Record<string, string>>} */
const DISPLAY_LABEL = Object.freeze({
  glm: 'Z.ai GLM',
  ollama: 'Ollama (local)',
  'local-webgpu': 'On-device runner',
});

/**
 * @typedef {Object} ProviderStepState
 * @property {ProviderRow[]|null} rows
 * @property {string} selected
 * @property {string} keyInput
 * @property {boolean} busy
 * @property {'save'|'test'|'switch'|null} uncertain
 * @property {{ ok: boolean, text: string }|null} msg
 * @property {Record<string, 'checking'|'connected'|'empty'|'down'>} conn
 * @property {boolean} statusError
 * @property {number} statusGeneration
 */

/** @typedef {{ state: ProviderStepState, attrs: { send: Send, onDone: () => void, busy?: boolean } }} ProviderStepVnode */

export const ProviderStep = {
  /** @param {ProviderStepVnode} vnode */
  oninit(vnode) {
    vnode.state.rows = null;
    vnode.state.selected = 'anthropic';
    vnode.state.keyInput = '';
    vnode.state.busy = false;
    vnode.state.uncertain = null;
    vnode.state.msg = null;
    vnode.state.conn = {};
    vnode.state.statusError = false;
    vnode.state.statusGeneration = 0;
    ProviderStep.loadStatus(vnode);
  },

  /** @param {ProviderStepVnode} vnode */
  async loadStatus(vnode) {
    const generation = ++vnode.state.statusGeneration;
    vnode.state.statusError = false;
    if (vnode.state.rows === null) m.redraw();
    try {
      const r = await vnode.attrs.send({ type: 'provider/status' });
      if (generation !== vnode.state.statusGeneration) return;
      if (!r?.ok || !Array.isArray(r.providers)) {
        vnode.state.rows = null;
        vnode.state.statusError = true;
        m.redraw();
        return;
      }
      vnode.state.rows = r.providers;
      // Quietly probe live keyless daemons (Ollama) so REACHED reflects a
      // daemon that actually answered - same posture as the options card.
      for (const p of vnode.state.rows ?? []) {
        if (p.keyless && p.liveModels) {
          vnode.state.conn[p.name] = 'checking';
          vnode.attrs.send({ type: 'provider/test', provider: p.name })
            .then((t) => {
              vnode.state.conn[p.name] = t?.ok ? 'connected'
                : t?.reachable === true && t?.models === 0 ? 'empty' : 'down';
              m.redraw();
            })
            .catch(() => { vnode.state.conn[p.name] = 'down'; m.redraw(); });
        }
      }
      m.redraw();
    } catch {
      if (generation !== vnode.state.statusGeneration) return;
      vnode.state.rows = null;
      vnode.state.statusError = true;
      m.redraw();
    }
  },

  /** @param {ProviderStepVnode} vnode */
  view(vnode) {
    const { send, onDone } = vnode.attrs;
    const ui = vnode.state;
    const rows = ui.rows;
    /** @param {ProviderRow} p */
    const usable = (p) => !(p.keyless && !p.liveModels);
    const selectedRow = rows?.find((p) => p.name === ui.selected) ?? null;
    const needsKey = !!selectedRow && !selectedRow.keyless;

    const saveAndContinue = async () => {
      if (ui.busy || !selectedRow) return;
      ui.msg = null;
      if (needsKey) {
        const check = checkApiKeyFormat(selectedRow.name, ui.keyInput);
        if (!check.ok) { ui.msg = { ok: false, text: check.message }; return; }
        ui.busy = true;
        m.redraw();
        try {
          let phase = ui.uncertain ?? 'save';
          const effect = async (/** @type {any} */ message) => {
            try { return await send(message); }
            catch { return { ok: false, outcomeKnown: false }; }
          };
          if (phase === 'save') {
            const saved = await effect({
              type: 'provider/setKey', provider: selectedRow.name,
              plaintext: check.value, activate: false,
            });
            if (!saved?.ok) {
              ui.uncertain = saved?.outcomeKnown === false ? 'save' : null;
              ui.msg = { ok: false, text: ui.uncertain
                ? 'Peerd could not confirm the save. Finish the same save before changing the key.'
                : saved?.error === 'locked' ? 'Vault is locked; unlock it and try again.'
                  : 'The provider key could not be saved.' };
              return;
            }
            phase = 'test';
          }
          // The same one-token ping the options card runs after a save - the
          // user should leave this step knowing the key works, not hoping.
          // why verify BEFORE switching the active provider: a failed verify
          // must leave the previously configured provider in force, not a
          // half-configured one the next send trips over.
          if (phase === 'test') {
            const test = await effect({ type: 'provider/test', provider: selectedRow.name });
            if (!test?.ok) {
              ui.uncertain = test?.outcomeKnown === false ? 'test' : null;
              ui.msg = { ok: false, text: ui.uncertain
                ? 'The key is saved, but Peerd could not confirm the test. Verify again when ready.'
                : test?.error === 'invalid-key'
                  ? 'Provider rejected the key (401). Double-check it.'
                  : 'Saved, but the key could not be verified.' };
              return;
            }
            phase = 'switch';
          }
          const switched = await effect({
            type: 'settings/update', patch: { providerName: selectedRow.name, providerModel: '' },
          });
          if (!switched?.ok) {
            ui.uncertain = switched?.outcomeKnown === false ? 'switch' : null;
            ui.msg = { ok: false, text: ui.uncertain
              ? 'Peerd could not confirm the provider selection. Finish the same selection to continue.'
              : 'The provider selection could not be saved.' };
            return;
          }
          // The plaintext has done its job - it lives encrypted in the vault
          // now, and must not linger in component state.
          ui.keyInput = '';
          ui.uncertain = null;
          onDone();
        } finally {
          ui.busy = false;
          m.redraw();
        }
        return;
      }
      // Keyless (Ollama): nothing to store - just make it the provider.
      if (ui.conn[selectedRow.name] === 'empty') {
        ui.msg = { ok: false, text: 'Ollama is running, but it has no models. Pull a model before continuing.' };
        return;
      }
      ui.busy = true;
      m.redraw();
      try {
        let switched;
        try {
          switched = await send({
            type: 'settings/update', patch: { providerName: selectedRow.name, providerModel: '' },
          });
        } catch { switched = { ok: false, outcomeKnown: false }; }
        if (!switched?.ok) {
          ui.uncertain = switched?.outcomeKnown === false ? 'switch' : null;
          ui.msg = { ok: false, text: ui.uncertain
            ? 'Peerd could not confirm the provider selection. Finish the same selection to continue.'
            : 'The provider selection could not be saved.' };
          return;
        }
        ui.uncertain = null;
        onDone();
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    /** @param {ProviderRow} p */
    const chip = (p) => {
      if (p.keyless && !p.liveModels) return m('span.onb-provider-chip', 'NOT YET USABLE');
      if (p.keyless) {
        if (ui.conn[p.name] === 'empty') return m('span.onb-provider-chip', 'NO MODELS');
        return ui.conn[p.name] === 'connected'
          ? m('span.onb-provider-chip.is-reached', [m('span.onb-provider-dot', { 'aria-hidden': 'true' }), 'REACHED'])
          : m('span.onb-provider-chip', 'NO KEY NEEDED');
      }
      return m('span.onb-provider-chip', 'API KEY');
    };

    return [
      m('h3.onb-provider-heading', 'Choose a provider'),
      m('p.muted.onb-provider-sub',
        'Your key is encrypted in the vault you just created and is sent ' +
        'only to the provider you choose. There is no peerd account.'),
      rows === null
        ? ui.statusError
          ? m('.onb-provider-status-error', { role: 'alert' }, [
              m('p', 'Peerd could not load provider choices. No key or setting was changed.'),
              m('button', {
                type: 'button',
                onclick: () => ProviderStep.loadStatus(vnode),
              }, 'Retry loading providers'),
            ])
          : m('p.muted', 'Loading…')
        : m('.onb-provider-rows', { role: 'radiogroup', 'aria-label': 'Provider' },
            rows.map((p) => m('button.onb-provider-row', {
              type: 'button',
              role: 'radio',
              'aria-checked': ui.selected === p.name ? 'true' : 'false',
              class: `${ui.selected === p.name ? 'is-selected' : ''} ${usable(p) ? '' : 'is-unusable'}`.trim(),
              disabled: ui.busy || !!ui.uncertain || !usable(p),
              onclick: () => { ui.selected = p.name; ui.msg = null; },
            }, [
              m('span.onb-provider-radio', { 'aria-hidden': 'true' }),
              m('span.onb-provider-name', DISPLAY_LABEL[p.name] ?? p.label),
              chip(p),
            ]))),
      needsKey ? m('.onb-provider-key', [
        m('label.onb-provider-key-label', { for: 'onb-key' }, 'API key'),
        m('input', {
          id: 'onb-key',
          type: 'password',
          autocomplete: 'off',
          placeholder: KEY_PREFIX[ui.selected] ? `${KEY_PREFIX[ui.selected]}...` : 'your API key',
          value: ui.keyInput,
          disabled: ui.busy || !!ui.uncertain,
          oninput: (/** @type {Event} */ e) => { ui.keyInput = /** @type {HTMLInputElement} */ (e.target).value; },
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveAndContinue(); }
          },
        }),
      ]) : null,
      (selectedRow?.keyless && selectedRow.liveModels) ? m('p.muted.onb-provider-note',
        'No key to store - Ollama runs on your own machine. Default ' +
        'http://localhost:11434, changeable in Settings.') : null,
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, { role: 'status' }, ui.msg.text) : null,
      m('.onboarding-actions', [
        m('button', {
          // Disabled until a row is actually selectable - an enabled button
          // that silently no-ops during the status round-trip is a lie.
          type: 'button', disabled: ui.busy || !selectedRow
            || ui.conn[selectedRow.name] === 'empty',
          onclick: saveAndContinue,
        }, ui.busy ? '…' : ui.uncertain === 'save' ? 'Finish the same save'
          : ui.uncertain === 'test' ? 'Verify again'
            : ui.uncertain === 'switch' ? 'Finish selection' : 'Save and continue'),
        m('button.linklike.onboarding-skip', {
          type: 'button', disabled: ui.busy,
          // The skip contract: no writes - the user lands on the honest
          // empty state and can connect a provider from Settings later.
          onclick: () => onDone(),
        }, 'I’ll do this later'),
      ]),
    ];
  },
};
