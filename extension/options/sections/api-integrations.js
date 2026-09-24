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
//
// One exception to "no values", and it is the point of the DPoP option: for a
// proof-of-possession credential the list also returns the `jkt` — the PUBLIC
// thumbprint of the origin's non-extractable keypair (INV-15). It is a hash of a
// public key, not a secret, and the user MUST be able to read it: it is what they
// paste into the authorization server's client registration so the token it issues
// is bound to this device's key. Without a way to save `scheme:'dpop'` and a way to
// read the thumbprint back, the whole proof-of-possession path was unreachable.

import m from '/vendor/mithril/mithril.js';
import { GitCredentialsSection } from './git-credentials.js';
import { mutationFailureCopy } from '../mutation-custody.js';

/** The three auth styles a credential can be saved as, in the order shown. */
const SCHEMES = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'raw', label: 'Custom header' },
  { value: 'dpop', label: 'DPoP (proof of possession)' },
];

export const ApiIntegrationsSection = {
  oninit(/** @type {any} */ vnode) {
    vnode.state.integrations = null;   // Array<{origin, header, scheme?, jkt?}> | null (loading)
    vnode.state.originInput = '';
    vnode.state.keyInput = '';
    vnode.state.headerInput = '';      // only used by the 'raw' scheme
    vnode.state.schemeInput = 'bearer';
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.loadError = null;
    vnode.state.msg = null;
    ApiIntegrationsSection.load(vnode);
  },

  async load(/** @type {any} */ vnode) {
    try {
      const r = await vnode.attrs.send({ type: 'origin-cred/list' });
      if (r?.ok && Array.isArray(r.integrations)) vnode.state.integrations = r.integrations;
      else if (vnode.state.integrations === null) vnode.state.integrations = [];
      if (r && !r.ok && r.error === 'locked') vnode.state.msg = { ok: false, text: 'Vault is locked — unlock in the peerd panel first.' };
      m.redraw();
      return r;
    } catch {
      if (vnode.state.integrations === null) vnode.state.integrations = [];
      m.redraw(); return null;
    }
  },

  view: (/** @type {{ attrs: { send: any }, state: any }} */ { attrs: { send }, state: ui }) => {
    const errText = (/** @type {unknown} */ reply, /** @type {string} */ action) =>
      mutationFailureCopy(reply, {
        action, fallback: 'The API integration could not be changed.',
        messages: {
          locked: 'Vault is locked; unlock in the peerd panel first.',
          'bad-origin': 'Enter a real https host like api.stripe.com (https only; no localhost or IPs).',
          'bad-key': 'Paste a complete key (no spaces).',
        },
      });

    const save = async () => {
      if (ui.busy || ui.uncertain) return;
      const origin = ui.originInput.trim();
      const key = ui.keyInput.trim();
      const header = ui.headerInput.trim();
      const scheme = ui.schemeInput;
      ui.msg = null;
      if (!origin) { ui.msg = { ok: false, text: 'Enter an API host (e.g. api.stripe.com).' }; m.redraw(); return; }
      if (key.length < 8) { ui.msg = { ok: false, text: 'Paste a complete key.' }; m.redraw(); return; }
      if (scheme === 'raw' && !header) { ui.msg = { ok: false, text: 'Enter the header name to send the key in (e.g. X-API-Key).' }; m.redraw(); return; }
      ui.busy = true; m.redraw();
      // Bearer is the default and sends no `scheme` at all — the same message this
      // form has always sent, so the common case is byte-for-byte unchanged.
      const arg = scheme === 'raw' ? { type: 'origin-cred/set', origin, key, header, scheme: 'raw' }
        : scheme === 'dpop' ? { type: 'origin-cred/set', origin, key, scheme: 'dpop' }
        : { type: 'origin-cred/set', origin, key };
      try {
        let r;
        try { r = await send(arg); }
        catch { r = { ok: false, outcomeKnown: false }; }
        if (r?.ok) {
          ui.originInput = ''; ui.keyInput = ''; ui.headerInput = ''; ui.schemeInput = 'bearer';
          ui.msg = { ok: true, text: scheme === 'dpop'
            ? `Saved for ${r.origin}; encrypted in the vault. Register the key thumbprint below with ${r.origin}.`
            : `Saved for ${r.origin}; encrypted in the vault.` };
          await ApiIntegrationsSection.load({ attrs: { send }, state: ui });
        } else {
          ui.msg = { ok: false, text: errText(r, 'saving the API integration') };
          if (r?.outcomeKnown === false) {
            ui.uncertain = true;
            const status = await ApiIntegrationsSection.load({ attrs: { send }, state: ui });
            if (status?.ok) {
              ui.uncertain = false;
              ui.msg = { ok: false, text: 'The save receipt was lost. Current integrations were refreshed; verify the list before trying again.' };
            }
          }
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    const remove = async (/** @type {string} */ origin) => {
      if (ui.busy || ui.uncertain) return;
      ui.busy = true; ui.msg = null; m.redraw();
      try {
        let r;
        try { r = await send({ type: 'origin-cred/delete', origin }); }
        catch { r = { ok: false, outcomeKnown: false }; }
        if (r?.ok) {
          ui.integrations = (ui.integrations ?? []).filter((/** @type {any} */ x) => x.origin !== origin);
          ui.msg = { ok: true, text: `Removed ${origin}.` };
        } else {
          ui.msg = { ok: false, text: errText(r, 'removing the API integration') };
          if (r?.outcomeKnown === false) {
            ui.uncertain = true;
            const status = await ApiIntegrationsSection.load({ attrs: { send }, state: ui });
            if (status?.ok) {
              ui.uncertain = false;
              ui.msg = { ok: false, text: 'The remove receipt was lost. Current integrations were refreshed; verify the list before trying again.' };
            }
          }
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
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
                  m('span.key-badge.key-set',
                    { title: it.scheme === 'dpop'
                      ? 'Proof-of-possession: bound to a device-only key peerd cannot export'
                      : `Sent as ${it.header || 'Authorization'}` },
                    it.scheme === 'dpop' ? '✓ DPoP · device-bound' : `✓ ${it.header || 'Authorization'}`),
                ]),
                m('span', { style: 'margin-left:auto;' },
                  m('button.linkish', { type: 'button', disabled: ui.busy || ui.uncertain, onclick: () => remove(it.origin) }, 'Remove')),
              ]),
              // The public thumbprint of this origin's key. Shown ONLY for DPoP, and
              // shown in full because pasting it into the server's client registration
              // is the step that makes the token binding real. Removing the
              // integration retires the key, so this fingerprint doesn't outlive it.
              // The device-bound line is not decoration: a non-extractable key can't
              // be synced or ride a vault export (buildExport never gathers the key
              // store, and the material can't be serialized anyway), so moving to
              // another device means re-registering there — say so before the user is
              // surprised by a 401 on a machine they restored a vault onto.
              it.scheme === 'dpop'
                ? m('p.hint', { style: 'margin:4px 0 0;' }, it.jkt
                  ? ['Key thumbprint (', m('code', 'jkt'), '): ', m('code', it.jkt),
                    ' — register this with ', it.origin, '. ', m('strong', 'Device-bound'),
                    ': the key stays on this device — it doesn’t sync and isn’t part of a vault export, so you’ll register a new one on another device.']
                  : ['Key thumbprint unavailable — it is created on the next request to ', it.origin, '.'])
                : null,
            ]))),

      m('.settings-divider'),
      m('h3', 'Add an API key'),
      m('p.hint', [
        'The API host + your key. ', m('strong', 'Bearer token'), ' is the common ',
        m('code', 'Authorization: Bearer <key>'), '. ', m('strong', 'Custom header'),
        ' sends the key verbatim in a header you name (e.g. ', m('code', 'X-API-Key'), '). ',
        m('strong', 'DPoP'), ' stores an OAuth token that is only spendable alongside a '
        + 'proof signed by a key peerd generates on this device and ',
        m('em', 'cannot read or export'),
        ' — peerd shows you the key’s public thumbprint to register with the server. '
        + 'Needs a server that implements RFC 9449.',
      ]),
      m('form.provider-card-form', { onsubmit: (/** @type {any} */ e) => { e.preventDefault(); save(); } }, [
        m('.input-row', [
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            placeholder: 'api.stripe.com', value: ui.originInput, disabled: ui.busy || ui.uncertain,
            oninput: (/** @type {any} */ e) => { ui.originInput = e.target.value; },
            style: 'flex:0 0 11rem;',
          }),
          m('input', {
            type: 'password', spellcheck: false, autocomplete: 'off',
            placeholder: 'paste key…', value: ui.keyInput, disabled: ui.busy || ui.uncertain,
            oninput: (/** @type {any} */ e) => { ui.keyInput = e.target.value; },
          }),
        ]),
        // why margin-top here (not the shared .provider-card-form .input-row, which is
        // margin:0 and is reused by the single-row git section): this form has TWO stacked
        // rows, so the second needs its own vertical gap from the first.
        m('.input-row', { style: 'margin-top:8px;' }, [
          // The auth style, explicit. It used to be INFERRED from whether the header
          // field was blank, which left the strongest option (DPoP) with no way to
          // reach it at all. Same 11rem lead column as the origin field above.
          m('select', {
            value: ui.schemeInput, disabled: ui.busy || ui.uncertain, style: 'flex:0 0 11rem;',
            onchange: (/** @type {any} */ e) => { ui.schemeInput = e.target.value; },
          }, SCHEMES.map((s) => m('option', { value: s.value }, s.label))),
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            placeholder: ui.schemeInput === 'raw' ? 'Header name (e.g. X-API-Key)' : 'Header name (Custom header only)',
            value: ui.headerInput, disabled: ui.busy || ui.uncertain || ui.schemeInput !== 'raw',
            oninput: (/** @type {any} */ e) => { ui.headerInput = e.target.value; },
            style: 'flex:1;',
          }),
          m('button', { type: 'submit', disabled: ui.busy || ui.uncertain || !ui.originInput.trim() || !ui.keyInput.trim() },
            ui.busy ? '…' : 'Save'),
        ]),
      ]),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, ui.msg.text) : null,

      m('p.muted.settings-footer', [
        'Stored as ', m('code', 'origin:<origin>'), ' in the vault (https only). The agent '
        + 'never holds the key — it’s attached at the egress boundary, same-origin only.',
      ]),

      // Git credentials fold in here — a git PAT is the same class of secret (a
      // host-bound bearer token, stored git:<host> in the same vault), just for private
      // Git operations across every engine repository. Rendered as a subsection rather than its own nav
      // entry (owner's call). GitCredentialsSection owns its own load/save/list lifecycle.
      m('.settings-divider'),
      m('h3', 'Git credentials'),
      m(GitCredentialsSection, { send }),

      // DESIGN-19 site clients fold in here too — per-origin derived API clients the
      // web actor builds from observed traffic. Not secrets (they hold no
      // credentials), but same conceptual family (per-origin agent web state), so
      // they live on this page. SiteClientsSection owns its own list/delete lifecycle.
      m('.settings-divider'),
      m('h3', 'Site clients'),
      m(SiteClientsSection, { send }),
    ]);
  },
};

// DESIGN-19 — stored site clients (per-origin derived API clients). Read-only +
// delete: the agent derives + patches them (confirm-gated) via the web actor;
// here the user sees what's stored and can remove any. Shows staleness so a stale
// client is legible. No bodies are ever fetched — list returns metas only.
const fmtAge = (/** @type {number} */ ts) => {
  if (!ts) return 'never';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

export const SiteClientsSection = {
  oninit(/** @type {any} */ vnode) {
    vnode.state.clients = null;   // Array | null (loading)
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.msg = null;
    SiteClientsSection.load(vnode);
  },

  async load(/** @type {any} */ vnode) {
    try {
      const r = await vnode.attrs.send({ type: 'site-client/list' });
      if (r?.ok && Array.isArray(r.clients)) {
        vnode.state.clients = r.clients;
        vnode.state.loadError = null;
      } else {
        vnode.state.loadError = 'Site clients could not be loaded.';
      }
      m.redraw();
      return r;
    } catch {
      vnode.state.loadError = 'Site clients could not be loaded.';
      m.redraw(); return null;
    }
  },

  view: (/** @type {{ attrs: { send: any }, state: any }} */ { attrs: { send }, state: ui }) => {
    const remove = async (/** @type {string} */ origin) => {
      if (ui.busy || ui.uncertain) return;
      ui.busy = true; ui.msg = null; m.redraw();
      try {
        let r;
        try { r = await send({ type: 'site-client/delete', origin }); }
        catch { r = { ok: false, outcomeKnown: false }; }
        if (r?.ok) {
          ui.clients = (ui.clients ?? []).filter((/** @type {any} */ x) => x.origin !== origin);
          ui.msg = { ok: true, text: `Removed the site client for ${origin}.` };
        } else {
          ui.msg = { ok: false, text: mutationFailureCopy(r, {
            action: 'removing the site client', fallback: 'The site client could not be removed.',
          }) };
          if (r?.outcomeKnown === false) {
            ui.uncertain = true;
            const status = await SiteClientsSection.load({ attrs: { send }, state: ui });
            if (status?.ok) {
              ui.uncertain = false;
              ui.msg = { ok: false, text: 'The remove receipt was lost. Current site clients were refreshed; verify the list before trying again.' };
            }
          }
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    return m('div', [
      m('p.hint', [
        'Reusable API clients the agent ', m('strong', 'derived'), ' from watching sites you '
        + 'browsed — so it can call an API directly instead of re-driving the page. They hold '
        + 'no credentials (your session rides the browser), run pinned to their origin, and are ',
        m('strong', 'a cache, not a contract'), ' (the agent verifies them on use). Remove any here.',
      ]),
      ui.loadError ? m('p.key-msg.err', [
        ui.loadError, ' ',
        m('button.linkish', {
          type: 'button', disabled: ui.busy,
          onclick: () => SiteClientsSection.load({ attrs: { send }, state: ui }),
        }, 'Retry'),
      ]) : null,
      ui.clients === null
        ? (ui.loadError ? null : m('p.hint', 'Loading…'))
        : ui.clients.length === 0
          ? m('p.hint', 'No site clients yet — the agent creates these as it works.')
          : m('.provider-cards', ui.clients.map((/** @type {any} */ c) => m('.provider-card', [
              m('.provider-card-main', [
                m('.provider-card-text', [
                  m('span.provider-card-name', c.origin),
                  m('span.key-badge.key-set', `${c.endpoints} endpoint${c.endpoints === 1 ? '' : 's'}`),
                  c.recentFailures > 0 ? m('span.key-badge.key-unset', `${c.recentFailures} recent failure${c.recentFailures === 1 ? '' : 's'}`) : null,
                ]),
                m('span', { style: 'margin-left:auto;' },
                  m('button.linkish', { type: 'button', disabled: ui.busy || ui.uncertain, onclick: () => remove(c.origin) }, 'Remove')),
              ]),
              m('p.hint', { style: 'margin:4px 0 0;' },
                `${c.summary ? `${c.summary} · ` : ''}auth: ${c.auth} · derived ${fmtAge(c.derivedAt)} · `
                + `${c.lastVerifiedAt ? `verified ${fmtAge(c.lastVerifiedAt)}` : 'unverified'} · via ${c.deriver}`),
            ]))),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, ui.msg.text) : null,
    ]);
  },
};
