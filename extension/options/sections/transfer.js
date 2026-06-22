// @ts-check
// Options → Export & import — the explicit migration path between
// installs, including between peerd (store) and peerd preview, which
// are separate extensions with isolated storage by design. Ported
// unchanged from the panel's "Export & import" section; the routes are
// transfer/export + transfer/inspectImport + transfer/import.

import m from '/vendor/mithril/mithril.js';
import { CHANNEL } from '/shared/channel-config.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const TransferSection = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.exportPass = '';
    vnode.state.exportConfirm = '';
    vnode.state.exportBusy = false;
    vnode.state.exportMsg = null;             // { ok, text }
    vnode.state.importPayload = null;         // parsed export file
    vnode.state.importSummary = null;         // inspectImport summary
    vnode.state.importPass = '';
    vnode.state.importBusy = false;
    vnode.state.importMsg = null;             // { ok, text } | null
    vnode.state.importNotices = [];
    // Artifacts (.peerd app/notebook/vm files — DESIGN-10). Same
    // inspect-then-apply shape as the settings import above, but a
    // separate state island: artifacts and settings never mix.
    vnode.state.artifactEnvelope = null;      // parsed .peerd envelope
    vnode.state.artifactSummary = null;       // import/inspect summary
    vnode.state.artifactBusy = false;
    vnode.state.artifactMsg = null;           // { ok, text } | null
  },

  /** @param {{ attrs: { send: Send }, state: any }} vnode */
  view: ({ attrs: { send }, state: ui }) => {
    const doExport = async () => {
      if (ui.exportBusy) return;
      ui.exportMsg = null;
      if (ui.exportPass.length < 8) {
        ui.exportMsg = { ok: false, text: 'Passphrase must be at least 8 characters.' };
        return;
      }
      if (ui.exportPass !== ui.exportConfirm) {
        ui.exportMsg = { ok: false, text: 'Passphrases don’t match.' };
        return;
      }
      ui.exportBusy = true;
      m.redraw();
      const reply = await send({ type: 'transfer/export', passphrase: ui.exportPass });
      ui.exportBusy = false;
      if (reply?.ok) {
        const blob = new Blob([JSON.stringify(reply.payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `peerd-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        ui.exportPass = '';
        ui.exportConfirm = '';
        ui.exportMsg = { ok: true, text: 'Exported. Keep the file AND the passphrase — your API keys are encrypted with it.' };
      } else {
        ui.exportMsg = {
          ok: false,
          text: reply?.error === 'vault-locked' ? 'Vault is locked — unlock in the peerd panel first.'
            : reply?.error === 'passphrase-required' ? 'A passphrase (8+ characters) is required because the vault holds API keys.'
            : reply?.error ?? 'Export failed.',
        };
      }
      m.redraw();
    };

    const onImportFile = async (/** @type {{ target: HTMLInputElement }} */ e) => {
      ui.importMsg = null;
      ui.importSummary = null;
      ui.importPayload = null;
      ui.importNotices = [];
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const reply = await send({ type: 'transfer/inspectImport', payload });
        if (reply?.ok) {
          ui.importPayload = payload;
          ui.importSummary = reply.summary;
        } else {
          ui.importMsg = {
            ok: false,
            text: reply?.error === 'not-a-peerd-export'
              ? 'That file is not a peerd export.'
              : reply?.error ?? 'Could not read that file.',
          };
        }
      } catch {
        ui.importMsg = { ok: false, text: 'Could not parse that file as JSON.' };
      }
      m.redraw();
    };

    const onArtifactFile = async (/** @type {{ target: HTMLInputElement }} */ e) => {
      ui.artifactMsg = null;
      ui.artifactSummary = null;
      ui.artifactEnvelope = null;
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const envelope = JSON.parse(await file.text());
        const reply = await send({ type: 'import/inspect', envelope });
        if (reply?.ok) {
          ui.artifactEnvelope = envelope;
          ui.artifactSummary = reply.summary;
        } else {
          ui.artifactMsg = { ok: false, text: reply?.error ?? 'Could not read that file.' };
        }
      } catch {
        ui.artifactMsg = { ok: false, text: 'Could not parse that file as a .peerd envelope.' };
      }
      m.redraw();
    };

    const doArtifactApply = async () => {
      if (ui.artifactBusy || !ui.artifactEnvelope) return;
      ui.artifactBusy = true;
      ui.artifactMsg = null;
      m.redraw();
      const reply = await send({ type: 'import/apply', envelope: ui.artifactEnvelope });
      ui.artifactBusy = false;
      if (reply?.ok) {
        ui.artifactMsg = {
          ok: true,
          text: reply.kind === 'vm'
            ? `Imported as a new VM (${reply.id}). The base image is integrity-pinned; first boot streams it fresh.`
            : `Imported as a new ${reply.kind} (${reply.id}).`,
        };
        ui.artifactEnvelope = null;
        ui.artifactSummary = null;
      } else {
        ui.artifactMsg = { ok: false, text: reply?.error ?? 'Import failed.' };
      }
      m.redraw();
    };

    const doImport = async () => {
      if (ui.importBusy || !ui.importPayload) return;
      ui.importBusy = true;
      ui.importMsg = null;
      m.redraw();
      const reply = await send({ type: 'transfer/import', payload: ui.importPayload, passphrase: ui.importPass });
      ui.importBusy = false;
      if (reply?.ok) {
        ui.importNotices = reply.notices ?? [];
        ui.importMsg = {
          ok: true,
          text: `Imported ${reply.imported.settings} setting(s), ${reply.imported.secrets} API key(s), `
            + `${reply.imported.memoryWritten} memory doc(s), ${reply.imported.hooks} hook(s).`,
        };
        ui.importPayload = null;
        ui.importSummary = null;
        ui.importPass = '';
      } else {
        ui.importMsg = {
          ok: false,
          text: reply?.error === 'wrong-passphrase' ? 'Wrong passphrase for the API keys in this file.'
            : reply?.error === 'vault-locked' ? 'Vault is locked — unlock in the peerd panel first.'
            : reply?.error ?? 'Import failed.',
        };
      }
      m.redraw();
    };

    return m('div', [
      m('h3', 'Export settings'),
      m('p', 'Download a JSON file with your settings, memory, hooks, '
        + 'skill list, and provider endpoints. API keys are included '
        + 'ENCRYPTED under a passphrase you choose now — the file is '
        + 'useless without it. Use this to back up, or to move state '
        + 'between peerd and peerd preview (separate installs that never '
        + 'share storage automatically).'),
      m('.input-row', [
        m('label', { for: 'exppass' }, 'Export passphrase'),
        m('input', {
          id: 'exppass', type: 'password', autocomplete: 'new-password',
          value: ui.exportPass, disabled: ui.exportBusy,
          oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.exportPass = e.target.value; },
        }),
      ]),
      m('.input-row', [
        m('label', { for: 'exppass2' }, 'Confirm passphrase'),
        m('input', {
          id: 'exppass2', type: 'password', autocomplete: 'new-password',
          value: ui.exportConfirm, disabled: ui.exportBusy,
          oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.exportConfirm = e.target.value; },
        }),
      ]),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button', { type: 'button', disabled: ui.exportBusy, onclick: doExport },
          ui.exportBusy ? '…' : 'Export settings'),
      ]),
      ui.exportMsg ? m(ui.exportMsg.ok ? 'p' : 'p.error',
        ui.exportMsg.ok ? { style: 'color: var(--ok);' } : {}, ui.exportMsg.text) : null,

      m('.settings-divider'),
      m('h3', 'Import settings'),
      m('p', 'Pick a peerd export file. You will see exactly what it '
        + 'contains — and what will be overwritten — before anything is '
        + 'applied.'),
      m('input', {
        type: 'file', accept: 'application/json,.json',
        disabled: ui.importBusy,
        onchange: onImportFile,
      }),
      ui.importSummary ? m('.import-summary', [
        m('h3', 'This import will apply:'),
        m('ul', [
          ui.importSummary.settingsKeys.length > 0
            ? m('li', `${ui.importSummary.settingsKeys.length} setting(s): ${ui.importSummary.settingsKeys.join(', ')} — these overwrite your current values`)
            : null,
          ui.importSummary.hasSecrets ? m('li', 'API keys (encrypted — passphrase required below); existing keys with the same provider are overwritten') : null,
          ui.importSummary.memoryDocs > 0 ? m('li', `${ui.importSummary.memoryDocs} memory doc(s) — newer local edits are kept (last-write-wins)`) : null,
          ui.importSummary.hooks > 0 ? m('li', `${ui.importSummary.hooks} hook(s) — hooks with the same id are replaced`) : null,
          ui.importSummary.skills.length > 0 ? m('li', `Skill list (metadata only): ${ui.importSummary.skills.join(', ')}`) : null,
        ]),
        ui.importSummary.notices.map((/** @type {string} */ n) => m('p.hint', n)),
        ui.importSummary.sourceChannel && ui.importSummary.sourceChannel !== CHANNEL
          ? m('p.hint', `This export came from a ${ui.importSummary.sourceChannel} build; you are on ${CHANNEL}. Your explicit values travel verbatim — channel defaults only apply to settings you have not touched.`)
          : null,
        ui.importSummary.hasSecrets ? m('.input-row', [
          m('label', { for: 'imppass' }, 'File passphrase'),
          m('input', {
            id: 'imppass', type: 'password', autocomplete: 'off',
            value: ui.importPass, disabled: ui.importBusy,
            oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.importPass = e.target.value; },
          }),
        ]) : null,
        m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
          m('button', { type: 'button', disabled: ui.importBusy, onclick: doImport },
            ui.importBusy ? '…' : 'Apply import'),
          m('button.secondary', {
            type: 'button',
            onclick: () => { ui.importPayload = null; ui.importSummary = null; ui.importPass = ''; },
          }, 'Cancel'),
        ]),
      ]) : null,
      ui.importNotices.map((/** @type {string} */ n) => m('p.hint', n)),
      ui.importMsg ? m(ui.importMsg.ok ? 'p' : 'p.error',
        ui.importMsg.ok ? { style: 'color: var(--ok);' } : {}, ui.importMsg.text) : null,

      // --- Artifacts (.peerd files) — separate from settings & data ----
      // Apps, Notebooks, and VM recipes exported from their tabs.
      // Same inspect-then-apply contract: nothing is written until the
      // file's hashes verify AND the user clicks Apply; imports always
      // create a NEW artifact (fresh id), never overwriting one.
      m('.settings-divider'),
      m('h3', 'Artifacts'),
      m('p', 'Import an app, Notebook, or VM recipe from a .peerd file '
        + '(exported via the Export button in the artifact’s own tab). '
        + 'This is separate from the settings export above: a .peerd file '
        + 'carries one artifact, verified against its content hashes, and '
        + 'importing always creates a new copy — nothing you have is '
        + 'overwritten.'),
      m('input', {
        type: 'file', accept: '.peerd',
        disabled: ui.artifactBusy,
        onchange: onArtifactFile,
      }),
      ui.artifactSummary ? m('.import-summary', [
        m('h3', 'This file contains:'),
        m('ul', [
          m('li', `Kind: ${(/** @type {Record<string, string>} */ ({ app: 'App', notebook: 'Notebook', vm: 'VM recipe' }))[ui.artifactSummary.kind] ?? ui.artifactSummary.kind}`),
          m('li', `Name: ${ui.artifactSummary.name}`),
          m('li', `Size: ${ui.artifactSummary.size < 1_048_576
            ? `${Math.max(1, Math.round(ui.artifactSummary.size / 1024))} KB`
            : `${(ui.artifactSummary.size / 1_048_576).toFixed(1)} MB`}`),
          ui.artifactSummary.kind === 'vm'
            ? m('li', 'Recipe only — base image URL + integrity pin; no disk contents travel')
            : m('li', `${ui.artifactSummary.fileCount} file(s)`),
        ]),
        ui.artifactSummary.kind === 'vm'
          ? m('p.hint', 'The new VM pins the base image before its first boot, so a changed image fails closed.')
          : m('p.hint', 'Imported artifacts run in the same sandboxed realm as ones built here — importing grants no extra authority.'),
        m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
          m('button', { type: 'button', disabled: ui.artifactBusy, onclick: doArtifactApply },
            ui.artifactBusy ? '…' : 'Apply import'),
          m('button.secondary', {
            type: 'button',
            onclick: () => { ui.artifactEnvelope = null; ui.artifactSummary = null; },
          }, 'Cancel'),
        ]),
      ]) : null,
      ui.artifactMsg ? m(ui.artifactMsg.ok ? 'p' : 'p.error',
        ui.artifactMsg.ok ? { style: 'color: var(--ok);' } : {}, ui.artifactMsg.text) : null,
    ]);
  },
};
