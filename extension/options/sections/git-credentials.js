// @ts-check
// Options → Security → Git credentials.
//
// Per-host bearer tokens for private `git clone` inside the WebVM, stored in
// the SAME encrypted vault as your provider API keys (a git PAT is the same
// class of secret). The token is sent to the SW as plaintext via
// runtime.sendMessage; the SW encrypts it with the vault DK before persisting.
// It is decrypted only at request time, bound to its host, and NEVER shown to
// the agent or the VM. This UI only ever sees the HOST NAMES (git-cred/list
// returns no values).

import m from '/vendor/mithril/mithril.js';

export const GitCredentialsSection = {
  oninit(/** @type {any} */ vnode) {
    vnode.state.hosts = null;     // string[] | null (loading)
    vnode.state.hostInput = '';
    vnode.state.tokenInput = '';
    vnode.state.busy = false;
    vnode.state.msg = null;       // { ok, text }
    GitCredentialsSection.load(vnode);
  },

  load(/** @type {any} */ vnode) {
    vnode.attrs.send({ type: 'git-cred/list' }).then((/** @type {any} */ r) => {
      vnode.state.hosts = r?.ok ? r.hosts : [];
      if (r && !r.ok && r.error === 'locked') vnode.state.msg = { ok: false, text: 'Vault is locked — unlock in the peerd panel first.' };
      m.redraw();
    }).catch(() => { vnode.state.hosts = []; m.redraw(); });
  },

  view: (/** @type {{ attrs: { send: any }, state: any }} */ { attrs: { send }, state: ui }) => {
    const errText = (/** @type {string} */ error) => error === 'locked'
      ? 'Vault is locked — unlock in the peerd panel first.'
      : error === 'bad-host' ? 'Enter a real host like github.com (no localhost or IPs).'
      : error === 'bad-token' ? 'Paste a complete token (no spaces).'
      : error ?? 'Something went wrong.';

    const save = async () => {
      if (ui.busy) return;
      const host = ui.hostInput.trim();
      const token = ui.tokenInput.trim();
      ui.msg = null;
      if (!host) { ui.msg = { ok: false, text: 'Enter a host (e.g. github.com).' }; m.redraw(); return; }
      if (token.length < 8) { ui.msg = { ok: false, text: 'Paste a complete token.' }; m.redraw(); return; }
      ui.busy = true; m.redraw();
      const r = await send({ type: 'git-cred/set', host, token });
      ui.busy = false;
      if (r?.ok) {
        ui.hostInput = ''; ui.tokenInput = '';
        ui.msg = { ok: true, text: `Saved for ${r.host} — encrypted in the vault.` };
        const lr = await send({ type: 'git-cred/list' });
        if (lr?.ok) ui.hosts = lr.hosts;
      } else {
        ui.msg = { ok: false, text: errText(r?.error) };
      }
      m.redraw();
    };

    const remove = async (/** @type {string} */ host) => {
      if (ui.busy) return;
      ui.busy = true; ui.msg = null; m.redraw();
      const r = await send({ type: 'git-cred/delete', host });
      ui.busy = false;
      if (r?.ok) {
        ui.hosts = (ui.hosts ?? []).filter((/** @type {string} */ h) => h !== host);
        ui.msg = { ok: true, text: `Removed ${host}.` };
      } else {
        ui.msg = { ok: false, text: errText(r?.error) };
      }
      m.redraw();
    };

    return m('div', [
      m('p', [
        'Tokens for private ', m('code', 'git clone'), ' inside the WebVM. Each is '
        + 'encrypted in the same vault as your API keys, decrypted only at clone time, '
        + 'bound to its host, and ', m('strong', 'never shown to the agent or the VM'),
        '. peerd only sends it to that exact host over HTTPS (redirects are refused), '
        + 'so it can’t leak elsewhere.',
      ]),

      // Existing tokens (host names only — values never leave the vault).
      ui.hosts === null
        ? m('p.hint', 'Loading…')
        : ui.hosts.length === 0
          ? m('p.hint', 'No git tokens yet.')
          : m('.provider-cards', ui.hosts.map((/** @type {string} */ host) => m('.provider-card', [
              m('.provider-card-main', [
                m('.provider-card-text', [
                  m('span.provider-card-name', host),
                  m('span.key-badge.key-set', '✓ Token saved'),
                ]),
                m('span', { style: 'margin-left:auto;' },
                  m('button.linkish', { type: 'button', disabled: ui.busy, onclick: () => remove(host) }, 'Remove')),
              ]),
            ]))),

      m('.settings-divider'),
      m('h3', 'Add a token'),
      m('p.hint', [
        'Host + a Personal Access Token. Use a ', m('strong', 'fine-grained, repo-scoped'),
        ' token where possible (e.g. GitHub → Settings → Developer settings → '
        + 'Fine-grained tokens). For GitLab use ', m('code', 'gitlab.com'),
        ' with a read_repository token.',
      ]),
      m('form.provider-card-form', { onsubmit: (/** @type {any} */ e) => { e.preventDefault(); save(); } }, [
        m('.input-row', [
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            placeholder: 'github.com', value: ui.hostInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.hostInput = e.target.value; },
            style: 'flex:0 0 11rem;',
          }),
          m('input', {
            type: 'password', spellcheck: false, autocomplete: 'off',
            placeholder: 'paste token…', value: ui.tokenInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.tokenInput = e.target.value; },
          }),
          m('button', { type: 'submit', disabled: ui.busy || !ui.hostInput.trim() || !ui.tokenInput.trim() },
            ui.busy ? '…' : 'Save'),
        ]),
      ]),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, ui.msg.text) : null,

      m('p.muted.settings-footer', [
        'Stored as ', m('code', 'git:<host>'), ' in the vault. Anonymous clones '
        + '(public repos) need no token. OAuth sign-in is planned; for now use a PAT.',
      ]),
    ]);
  },
};
