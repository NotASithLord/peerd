// @ts-check
// Options → Security → API integrations.
//
// DESIGN-18 P1. An API key bound to ONE origin, stored in the SAME encrypted vault as
// your provider keys + git tokens (same class of secret). It is sent to the SW as
// plaintext via runtime.sendMessage; the SW encrypts it with the vault DK before
// persisting under origin:<origin>. It is decrypted only at the egress boundary
// (withApiCredentials), injected ONLY on a same-origin HTTPS request the API actor
// makes, and NEVER shown to the agent. This UI only ever sees the ORIGINS + the header
// NAME (origin-cred/list returns no values).

import m from '/vendor/mithril/mithril.js';

export const ApiIntegrationsSection = {
  oninit(/** @type {any} */ vnode) {
    vnode.state.integrations = null;   // Array<{origin, header}> | null (loading)
    vnode.state.originInput = '';
    vnode.state.keyInput = '';
    vnode.state.headerInput = '';      // blank = Authorization: Bearer
    vnode.state.busy = false;
    vnode.state.msg = null;
    ApiIntegrationsSection.load(vnode);
  },

  load(/** @type {any} */ vnode) {
    vnode.attrs.send({ type: 'origin-cred/list' }).then((/** @type {any} */ r) => {
      vnode.state.integrations = r?.ok ? r.integrations : [];
      if (r && !r.ok && r.error === 'locked') vnode.state.msg = { ok: false, text: 'Vault is locked — unlock in the peerd panel first.' };
      m.redraw();
    }).catch(() => { vnode.state.integrations = []; m.redraw(); });
  },

  view: (/** @type {{ attrs: { send: any }, state: any }} */ { attrs: { send }, state: ui }) => {
    const errText = (/** @type {string} */ error) => error === 'locked'
      ? 'Vault is locked — unlock in the peerd panel first.'
      : error === 'bad-origin' ? 'Enter a real https host like api.stripe.com (https only; no localhost or IPs).'
      : error === 'bad-key' ? 'Paste a complete key (no spaces).'
      : error ?? 'Something went wrong.';

    const save = async () => {
      if (ui.busy) return;
      const origin = ui.originInput.trim();
      const key = ui.keyInput.trim();
      const header = ui.headerInput.trim();
      ui.msg = null;
      if (!origin) { ui.msg = { ok: false, text: 'Enter an API host (e.g. api.stripe.com).' }; m.redraw(); return; }
      if (key.length < 8) { ui.msg = { ok: false, text: 'Paste a complete key.' }; m.redraw(); return; }
      ui.busy = true; m.redraw();
      // Blank header → Bearer (the common case); a custom header → the key verbatim.
      const arg = header
        ? { type: 'origin-cred/set', origin, key, header, scheme: 'raw' }
        : { type: 'origin-cred/set', origin, key };
      const r = await send(arg);
      ui.busy = false;
      if (r?.ok) {
        ui.originInput = ''; ui.keyInput = ''; ui.headerInput = '';
        ui.msg = { ok: true, text: `Saved for ${r.origin} — encrypted in the vault.` };
        const lr = await send({ type: 'origin-cred/list' });
        if (lr?.ok) ui.integrations = lr.integrations;
      } else {
        ui.msg = { ok: false, text: errText(r?.error) };
      }
      m.redraw();
    };

    const remove = async (/** @type {string} */ origin) => {
      if (ui.busy) return;
      ui.busy = true; ui.msg = null; m.redraw();
      const r = await send({ type: 'origin-cred/delete', origin });
      ui.busy = false;
      if (r?.ok) {
        ui.integrations = (ui.integrations ?? []).filter((/** @type {any} */ x) => x.origin !== origin);
        ui.msg = { ok: true, text: `Removed ${origin}.` };
      } else {
        ui.msg = { ok: false, text: errText(r?.error) };
      }
      m.redraw();
    };

    return m('div', [
      m('p', [
        'API keys for the agent’s ', m('strong', 'API integrations'), ' — an origin-locked, '
        + 'keyless web actor (address it as ', m('code', 'message_actor("api.host.com", …)'),
        '). Each key is encrypted in the same vault as your API keys, injected only on a '
        + 'same-origin HTTPS request that integration makes, and ',
        m('strong', 'never shown to the agent'),
        '. Redirects are refused and cross-origin requests carry nothing, so it can’t leak elsewhere.',
      ]),

      ui.integrations === null
        ? m('p.hint', 'Loading…')
        : ui.integrations.length === 0
          ? m('p.hint', 'No API integrations yet.')
          : m('.provider-cards', ui.integrations.map((/** @type {any} */ it) => m('.provider-card', [
              m('.provider-card-main', [
                m('.provider-card-text', [
                  m('span.provider-card-name', it.origin),
                  m('span.key-badge.key-set', `✓ ${it.header || 'Authorization'}`),
                ]),
                m('span', { style: 'margin-left:auto;' },
                  m('button.linkish', { type: 'button', disabled: ui.busy, onclick: () => remove(it.origin) }, 'Remove')),
              ]),
            ]))),

      m('.settings-divider'),
      m('h3', 'Add an API key'),
      m('p.hint', [
        'The API host + your key. Leave ', m('strong', 'Header'), ' blank for the common ',
        m('code', 'Authorization: Bearer <key>'), '. Set a header name (e.g. ',
        m('code', 'X-API-Key'), ') to send the key verbatim in that header instead.',
      ]),
      m('form.provider-card-form', { onsubmit: (/** @type {any} */ e) => { e.preventDefault(); save(); } }, [
        m('.input-row', [
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            placeholder: 'api.stripe.com', value: ui.originInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.originInput = e.target.value; },
            style: 'flex:0 0 11rem;',
          }),
          m('input', {
            type: 'password', spellcheck: false, autocomplete: 'off',
            placeholder: 'paste key…', value: ui.keyInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.keyInput = e.target.value; },
          }),
        ]),
        m('.input-row', [
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            placeholder: 'Header (blank = Authorization: Bearer)', value: ui.headerInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.headerInput = e.target.value; },
            style: 'flex:1;',
          }),
          m('button', { type: 'submit', disabled: ui.busy || !ui.originInput.trim() || !ui.keyInput.trim() },
            ui.busy ? '…' : 'Save'),
        ]),
      ]),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, ui.msg.text) : null,

      m('p.muted.settings-footer', [
        'Stored as ', m('code', 'origin:<origin>'), ' in the vault (https only). The agent '
        + 'never holds the key — it’s attached at the egress boundary, same-origin only.',
      ]),
    ]);
  },
};
