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
import { checkApiKeyFormat, KEY_PREFIX } from '/peerd-provider/index.js';

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
 * @property {{ ok: boolean, text: string }|null} msg
 * @property {Record<string, 'checking'|'connected'|'down'>} conn
 */

/** @typedef {{ state: ProviderStepState, attrs: { send: Send, onDone: () => void, busy?: boolean } }} ProviderStepVnode */

export const ProviderStep = {
  /** @param {ProviderStepVnode} vnode */
  oninit(vnode) {
    vnode.state.rows = null;
    vnode.state.selected = 'anthropic';
    vnode.state.keyInput = '';
    vnode.state.busy = false;
    vnode.state.msg = null;
    vnode.state.conn = {};
    vnode.attrs.send({ type: 'provider/status' }).then((r) => {
      // A resolved-but-not-ok reply must not strand the step on 'Loading…'
      // forever - the dispatcher turns route throws into { ok:false }, and
      // an empty list still leaves the skip as the honest way forward.
      if (!r?.ok) { vnode.state.rows = []; m.redraw(); return; }
      vnode.state.rows = r.providers ?? [];
      // Quietly probe live keyless daemons (Ollama) so REACHED reflects a
      // daemon that actually answered - same posture as the options card.
      for (const p of vnode.state.rows ?? []) {
        if (p.keyless && p.liveModels) {
          vnode.state.conn[p.name] = 'checking';
          vnode.attrs.send({ type: 'provider/test', provider: p.name, activate: false })
            .then((t) => { vnode.state.conn[p.name] = t?.ok ? 'connected' : 'down'; m.redraw(); })
            .catch(() => { vnode.state.conn[p.name] = 'down'; m.redraw(); });
        }
      }
      m.redraw();
    }).catch(() => { vnode.state.rows = []; m.redraw(); });
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
          const saved = await send({
            type: 'provider/setKey', provider: selectedRow.name,
            plaintext: check.value, activate: false,
          });
          if (!saved?.ok) {
            ui.msg = { ok: false, text: saved?.error ?? 'Something went wrong.' };
            return;
          }
          // The same one-token ping the options card runs after a save - the
          // user should leave this step knowing the key works, not hoping.
          // why verify BEFORE switching the active provider: a failed verify
          // must leave the previously configured provider in force, not a
          // half-configured one the next send trips over.
          const test = await send({ type: 'provider/test', provider: selectedRow.name });
          if (!test?.ok) {
            ui.msg = {
              ok: false,
              text: test?.error === 'invalid-key'
                ? 'Provider rejected the key (401). Double-check it.'
                : `Saved, but the key could not be verified: ${test?.error ?? 'unknown error'}.`,
            };
            return;
          }
          const switched = await send({ type: 'settings/update', patch: { providerName: selectedRow.name, providerModel: '' } });
          if (!switched?.ok) {
            ui.msg = { ok: false, text: switched?.error ?? 'Something went wrong.' };
            return;
          }
          // The plaintext has done its job - it lives encrypted in the vault
          // now, and must not linger in component state.
          ui.keyInput = '';
          onDone();
        } finally {
          ui.busy = false;
          m.redraw();
        }
        return;
      }
      // Keyless (Ollama): nothing to store - just make it the provider.
      ui.busy = true;
      m.redraw();
      try {
        const switched = await send({ type: 'settings/update', patch: { providerName: selectedRow.name, providerModel: '' } });
        if (!switched?.ok) {
          ui.msg = { ok: false, text: switched?.error ?? 'Something went wrong.' };
          return;
        }
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
        ? m('p.muted', 'Loading…')
        : m('.onb-provider-rows', { role: 'radiogroup', 'aria-label': 'Provider' },
            rows.map((p) => m('button.onb-provider-row', {
              type: 'button',
              role: 'radio',
              'aria-checked': ui.selected === p.name ? 'true' : 'false',
              class: `${ui.selected === p.name ? 'is-selected' : ''} ${usable(p) ? '' : 'is-unusable'}`.trim(),
              disabled: ui.busy || !usable(p),
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
          disabled: ui.busy,
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
          type: 'button', disabled: ui.busy || !selectedRow,
          onclick: saveAndContinue,
        }, ui.busy ? '…' : 'Save and continue'),
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
