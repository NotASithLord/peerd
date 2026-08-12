// @ts-check
// Options → Security → Git credentials.
//
// Per-host bearer tokens for private Git across WebVMs, Apps, and lightweight
// Notebook repositories, stored in the SAME encrypted vault as your provider API keys (a git PAT is the same
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
      try {
        const r = await send({ type: 'git-cred/set', host, token });
        if (r?.ok) {
          ui.hostInput = ''; ui.tokenInput = '';
          ui.msg = { ok: true, text: `Saved for ${r.host}: encrypted in the vault.` };
          const lr = await send({ type: 'git-cred/list' });
          if (lr?.ok) ui.hosts = lr.hosts;
        } else {
          ui.msg = { ok: false, text: errText(r?.error) };
        }
      } catch (error) {
        ui.msg = { ok: false, text: /** @type {{message?:string}} */ (error)?.message ?? 'Could not save token.' };
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    const remove = async (/** @type {string} */ host) => {
      if (ui.busy) return;
      ui.busy = true; ui.msg = null; m.redraw();
      try {
        const r = await send({ type: 'git-cred/delete', host });
        if (r?.ok) {
          ui.hosts = (ui.hosts ?? []).filter((/** @type {string} */ h) => h !== host);
          ui.msg = { ok: true, text: `Removed ${host}.` };
        } else {
          ui.msg = { ok: false, text: errText(r?.error) };
        }
      } catch (error) {
        ui.msg = { ok: false, text: /** @type {{message?:string}} */ (error)?.message ?? 'Could not remove token.' };
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    return m('div', [
      m('p', [
        'Tokens for private GitHub/GitLab repositories in WebVMs, Apps, Notebooks, and Pods. Each is '
        + 'encrypted in the same vault as your API keys, decrypted only for a clone, fetch, or push request to that host, '
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
        ' token where possible. GitHub fine-grained tokens need Contents: read for clone/fetch and '
        + 'Contents: read and write for push. For GitLab use ', m('code', 'gitlab.com'),
        ' with ', m('code', 'read_repository'), ' for clone/fetch and ', m('code', 'write_repository'), ' for push.',
      ]),
      m('form.provider-card-form', { onsubmit: (/** @type {any} */ e) => { e.preventDefault(); save(); } }, [
        m('.input-row', [
          m('input', {
            type: 'text', spellcheck: false, autocapitalize: 'none', autocomplete: 'off',
            'aria-label': 'Git credential host',
            placeholder: 'github.com', value: ui.hostInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.hostInput = e.target.value; },
            style: 'flex:0 0 11rem;',
          }),
          m('input', {
            type: 'password', spellcheck: false, autocomplete: 'off',
            'aria-label': 'Personal access token',
            placeholder: 'paste token…', value: ui.tokenInput, disabled: ui.busy,
            oninput: (/** @type {any} */ e) => { ui.tokenInput = e.target.value; },
          }),
          m('button', { type: 'submit', disabled: ui.busy || !ui.hostInput.trim() || !ui.tokenInput.trim() },
            ui.busy ? '…' : 'Save'),
        ]),
      ]),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, { role: ui.msg.ok ? 'status' : 'alert', 'aria-live': 'polite' }, ui.msg.text) : null,

      m('p.muted.settings-footer', [
        'Stored as ', m('code', 'git:<host>'), ' in the vault. Anonymous clones '
        + '(public repos) need no token. OAuth sign-in is planned; for now use a PAT.',
      ]),
    ]);
  },
};
