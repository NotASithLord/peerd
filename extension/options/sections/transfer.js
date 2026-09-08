// @ts-check
// Options → Backup & restore — the explicit migration path between
// installs, including between peerd (store) and peerd preview, which
// are separate extensions with isolated storage by design. Backed by the
// existing guarded transfer routes:
// transfer/export + transfer/inspectImport + transfer/import.

import m from '/vendor/mithril/mithril.js';
import { CHANNEL } from '/shared/channel-config.js';
import { bundleToOtlp } from '/peerd-runtime/options.js';
import { PrivateTransferPortError } from '../private-transfer-client.js';
import {
  isUnknownMutationOutcome, mutationFailureCopy, unknownMutationCopy,
} from '../mutation-custody.js';

const MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;
const EXPORT_PASSPHRASE_MIN_LENGTH = 16;
const IMPORT_NOT_STARTED_CODES = new Set([
  'channel-unavailable', 'channel-request-failed', 'channel-timeout', 'post-failed',
]);
/** @param {string | null | undefined} did */
const displayDid = (did) => did || 'unknown';
/** @param {any} summary */
const hasApplicableImport = (summary) => !!summary && (
  summary.settingsKeys?.length > 0
  || summary.hasSecrets
  || (summary.hasIdentityRecord && !summary.dwebDropped)
  || summary.memoryDocs > 0
  || summary.hooks > 0
  || summary.endpointUrls?.length > 0
);
/** @param {any} counts */
const describeImportedCounts = (counts = {}) =>
  `${counts.settings ?? 0} setting(s), ${counts.secrets ?? 0} stored credential(s), `
  + `${counts.providerEndpoints ?? 0} provider endpoint(s), ${counts.memoryWritten ?? 0} memory doc(s), `
  + `and ${counts.hooks ?? 0} hook(s)`;
/** @param {string | null | undefined} failure */
const describeImportFailure = (failure) => (/** @type {Record<string, string>} */ ({
  'wrong-passphrase': 'The peer identity could not be unlocked with that passphrase.',
  'dweb-identity-stop-failed': 'The peer network could not be paused safely.',
  'dweb-identity-store-failed': 'The peer identity could not be stored.',
  'dweb-identity-resume-failed': 'The peer network could not be resumed.',
  'write-failed': 'A local write failed.',
}))[failure ?? ''] ?? 'A local restore step failed.';
/** @param {string | null | undefined} error */
const describeImportError = (error) => {
  if (error?.startsWith('unsupported-export-version-')) {
    return 'This backup was created by an incompatible peerd version. Update peerd and try again.';
  }
  return (/** @type {Record<string, string>} */ ({
    'wrong-passphrase': 'Wrong passphrase for this backup’s encrypted credentials or peer identity.',
    'vault-locked': 'Vault is locked. Unlock it in the peerd panel, then try again.',
    'dweb-identity-in-use': 'This identity cannot be replaced while locally authored apps are shared. Unshare them first, then try again.',
    'dweb-identity-unavailable': 'Peer identity restore is unavailable in this build. Update peerd preview, then try again.',
    'dweb-identity-dweb-disabled': 'Peer identity restore is unavailable because the peer network is disabled in this build.',
    'dweb-identity-vault-locked': 'Vault is locked. Unlock it in the peerd panel, then try again.',
    'dweb-identity-identity-changed': 'The local peer identity changed after review. Inspect the backup again before choosing whether to replace it.',
    'dweb-identity-no-openable-wrapper': 'The peer identity could not be unlocked with that passphrase.',
    'dweb-identity-invalid-local-identity': 'The local peer identity is damaged. Stop and restore it from a known-good backup before importing other state.',
    'dweb-identity-unsupported': 'This backup uses a peer identity format this build cannot restore. Update peerd preview and try again.',
    'dweb-identity-adopt-failed': 'The peer identity could not be restored. Reopen peerd and try again.',
    'dweb-identity-approval-required': 'Identity replacement approval expired. Inspect the backup and review both identities again.',
    'not-a-peerd-export': 'That file is not a peerd export.',
    'invalid-export-sections': 'That peerd export has malformed or oversized sections and was refused.',
  }))[error ?? ''] ?? 'Import failed. Reopen peerd, inspect the backup again, and retry.';
};
/** @param {unknown} value */
const describeSettingValue = (value) => {
  const encoded = JSON.stringify(value);
  return typeof encoded === 'string' ? encoded : String(value);
};

/** @typedef {import('./reset-row.js').Send} Send */

export const TransferSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.exportPass = '';
    vnode.state.exportConfirm = '';
    vnode.state.exportBusy = false;
    vnode.state.exportMsg = null;             // { ok, text }
    vnode.state.importPayload = null;         // parsed export file
    vnode.state.importSummary = null;         // inspectImport summary
    vnode.state.importPass = '';
    vnode.state.importBusy = false;
    vnode.state.importInspectBusy = false;
    vnode.state.importMsg = null;             // { ok, text } | null
    vnode.state.importNotices = [];
    vnode.state.identityConflict = null;
    vnode.state.replacementPending = false;
    vnode.state.importFileInput = null;
    vnode.state.importInspectGeneration = 0;
    vnode.state.restoreFocusToReview = false;
    vnode.state.focusImportFileOnUpdate = false;
    vnode.state.focusImportStatusOnUpdate = false;
    // Artifacts (.peerd app/notebook/vm files — DESIGN-10). Same
    // inspect-then-apply shape as the settings import above, but a
    // separate state island: artifacts and settings never mix.
    vnode.state.artifactEnvelope = null;      // parsed .peerd envelope
    vnode.state.artifactSummary = null;       // import/inspect summary
    vnode.state.artifactInspectGeneration = 0;
    vnode.state.artifactBusy = false;
    vnode.state.artifactMsg = null;           // { ok, text } | null
    // Debug bundle (the debug surface's options-page entry point): a session
    // picker over ALL chats — unlike the in-chat debug chip, this reaches any
    // past session without opening it.
    vnode.state.debugSessions = null;         // null = loading; [] = none
    vnode.state.debugSessionsError = '';
    vnode.state.debugSessionId = '';
    vnode.state.debugBusy = false;
    vnode.state.debugMsg = null;              // { ok, text } | null
    vnode.state.loadDebugSessions = () => {
      vnode.state.debugSessions = null;
      vnode.state.debugSessionsError = '';
      Promise.resolve(vnode.attrs.send({ type: 'session/list' })).then((reply) => {
        if (reply?.ok !== false && Array.isArray(reply?.sessions)) {
          vnode.state.debugSessions = reply.sessions;
          vnode.state.debugSessionId = reply.sessions[0]?.sessionId ?? '';
        } else {
          vnode.state.debugSessions = [];
          vnode.state.debugSessionsError = reply?.error ?? 'Temporarily unavailable. Try again.';
        }
        m.redraw();
      }).catch(() => {
        vnode.state.debugSessions = [];
        vnode.state.debugSessionsError = 'Temporarily unavailable. Try again.';
        m.redraw();
      });
    };
    vnode.state.loadDebugSessions();
  },

  /** @param {{ attrs: { send: Send }, state: any }} vnode */
  view: ({ attrs: { send }, state: ui }) => {
    // The debug surface: same route + pure OTel mapper the in-chat chip uses;
    // the options page adds only the session picker (any chat, not just the
    // open one) and this save shell.
    const exportDebug = async (/** @type {'json'|'otlp'} */ format) => {
      if (ui.debugBusy || !ui.debugSessionId) return;
      ui.debugBusy = true;
      ui.debugMsg = null;
      m.redraw();
      try {
        const reply = await send({ type: 'session/debugBundle', sessionId: ui.debugSessionId });
        if (!reply?.ok) {
          ui.debugMsg = {
            ok: false,
            text: reply?.error === 'locked'
              ? 'Vault is locked; unlock in the peerd panel first.'
              : 'The debug bundle could not be created.',
          };
          return;
        }
        const payload = format === 'otlp' ? bundleToOtlp(reply.bundle) : reply.bundle;
        const stem = format === 'otlp' ? 'peerd-trace' : 'peerd-debug';
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${stem}-${ui.debugSessionId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        ui.debugMsg = { ok: true, text: format === 'otlp' ? 'OTel trace saved.' : 'Debug bundle saved.' };
      } finally {
        ui.debugBusy = false;
        m.redraw();
      }
    };

    const doExport = async () => {
      if (ui.exportBusy) return;
      ui.exportMsg = null;
      if (ui.exportPass.length < EXPORT_PASSPHRASE_MIN_LENGTH) {
        ui.exportMsg = {
          ok: false,
          text: `Use a long, unique passphrase (${EXPORT_PASSPHRASE_MIN_LENGTH}+ characters).`,
        };
        return;
      }
      if (ui.exportPass !== ui.exportConfirm) {
        ui.exportMsg = { ok: false, text: 'Passphrases don’t match.' };
        return;
      }
      ui.exportBusy = true;
      m.redraw();
      try {
        const reply = await send({ type: 'transfer/export', passphrase: ui.exportPass });
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
          ui.exportMsg = {
            ok: true,
            text: reply.identityIncluded
              ? `Backup saved with peer identity ${displayDid(reply.identityDid)}. Keep both the file and its passphrase safe.`
              : CHANNEL === 'preview'
                ? 'Backup saved without a peer identity because this install does not have one yet. Keep both the file and its passphrase safe.'
                : 'Backup saved. This build does not carry a peer identity. Keep both the file and its passphrase safe.',
          };
        } else {
          ui.exportMsg = {
            ok: false,
            text: reply?.error === 'vault-locked' ? 'Vault is locked — unlock in the peerd panel first.'
              : reply?.error === 'passphrase-required' ? `A long passphrase (${EXPORT_PASSPHRASE_MIN_LENGTH}+ characters) is required to protect credentials and peer identity.`
              : reply?.error === 'identity-export-failed' ? 'Backup stopped because your peer identity could not be protected. Nothing was downloaded; retry after reopening peerd.'
              : 'The backup could not be created.',
          };
        }
      } catch {
        ui.exportMsg = { ok: false, text: 'peerd became unavailable while creating the backup. Reopen peerd and retry.' };
      } finally {
        ui.exportBusy = false;
        m.redraw();
      }
    };

    const onImportFile = async (/** @type {{ target: HTMLInputElement }} */ e) => {
      const generation = ++ui.importInspectGeneration;
      ui.importMsg = null;
      ui.importSummary = null;
      ui.importPayload = null;
      ui.importNotices = [];
      ui.identityConflict = null;
      ui.replacementPending = false;
      const file = e.target.files?.[0];
      if (!file) return;
      ui.importInspectBusy = true;
      m.redraw();
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        ui.importMsg = { ok: false, text: 'That backup is too large to import safely (32 MB maximum).' };
        e.target.value = '';
        ui.importInspectBusy = false;
        m.redraw();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        if (generation !== ui.importInspectGeneration) return;
        ui.importMsg = { ok: false, text: 'Could not parse that file as JSON.' };
        e.target.value = '';
        ui.importInspectBusy = false;
        m.redraw();
        return;
      }
      if (generation !== ui.importInspectGeneration) return;
      try {
        const reply = await send({ type: 'transfer/inspectImport', payload });
        if (generation !== ui.importInspectGeneration) return;
        if (reply?.ok) {
          ui.importPayload = payload;
          ui.importSummary = reply.summary;
        } else {
          ui.importMsg = {
            ok: false,
            text: describeImportError(reply?.error),
          };
          e.target.value = '';
        }
      } catch {
        if (generation !== ui.importInspectGeneration) return;
        ui.importMsg = { ok: false, text: 'peerd became unavailable while inspecting the backup. Reopen peerd and retry.' };
        e.target.value = '';
      }
      if (generation === ui.importInspectGeneration) ui.importInspectBusy = false;
      m.redraw();
    };

    const onArtifactFile = async (/** @type {{ target: HTMLInputElement }} */ e) => {
      const generation = ++ui.artifactInspectGeneration;
      ui.artifactMsg = null;
      ui.artifactSummary = null;
      ui.artifactEnvelope = null;
      const file = e.target.files?.[0];
      if (!file) return;
      let exportFileLimitBytes;
      try {
        ({ EXPORT_FILE_LIMIT_BYTES: exportFileLimitBytes } = await import('/peerd-engine/artifact.js'));
      } catch {
        if (generation !== ui.artifactInspectGeneration) return;
        ui.artifactMsg = { ok: false, text: 'Artifact import is unavailable in this build.' };
        e.target.value = '';
        m.redraw();
        return;
      }
      if (generation !== ui.artifactInspectGeneration) return;
      if (file.size > exportFileLimitBytes) {
        ui.artifactMsg = {
          ok: false,
          text: `That artifact is too large to import safely (${Math.round(exportFileLimitBytes / 1024 / 1024)} MB maximum).`,
        };
        e.target.value = '';
        m.redraw();
        return;
      }
      let envelope;
      try {
        const text = await file.text();
        if (generation !== ui.artifactInspectGeneration) return;
        envelope = JSON.parse(text);
      } catch {
        if (generation !== ui.artifactInspectGeneration) return;
        ui.artifactMsg = { ok: false, text: 'Could not parse that file as a .peerd envelope.' };
        m.redraw();
        return;
      }
      try {
        const reply = await send({ type: 'import/inspect', envelope });
        if (generation !== ui.artifactInspectGeneration) return;
        if (reply?.ok) {
          ui.artifactEnvelope = envelope;
          ui.artifactSummary = reply.summary;
        } else {
          ui.artifactMsg = { ok: false, text: 'That artifact could not be inspected.' };
        }
      } catch {
        if (generation !== ui.artifactInspectGeneration) return;
        ui.artifactMsg = { ok: false, text: 'peerd became unavailable while inspecting the artifact. Reopen peerd and retry.' };
      }
      if (generation === ui.artifactInspectGeneration) m.redraw();
    };

    const doArtifactApply = async () => {
      if (ui.artifactBusy || !ui.artifactEnvelope) return;
      ui.artifactBusy = true;
      ui.artifactMsg = null;
      m.redraw();
      try {
        const reply = await send({ type: 'import/apply', envelope: ui.artifactEnvelope });
        if (reply?.ok) {
          ui.artifactMsg = {
            ok: true,
            text: reply.kind === 'vm'
              ? `Imported as a new VM (${reply.id}). The base image is integrity-pinned; first boot streams it fresh.`
              : `Imported as a new ${reply.kind} (${reply.id}).`,
          };
          ui.artifactEnvelope = null;
          ui.artifactSummary = null;
        } else if (isUnknownMutationOutcome(reply)) {
          ui.artifactMsg = {
            ok: false, text: unknownMutationCopy('importing the artifact'),
          };
          // Re-inspection is the safe reconciliation boundary. Never leave the
          // same Class-E apply payload armed after an unknown result.
          ui.artifactEnvelope = null;
          ui.artifactSummary = null;
        } else {
          ui.artifactMsg = { ok: false, text: mutationFailureCopy(reply, {
            action: 'importing the artifact', fallback: 'The artifact could not be imported.',
          }) };
        }
      } catch {
        ui.artifactMsg = { ok: false, text: unknownMutationCopy('importing the artifact') };
        ui.artifactEnvelope = null;
        ui.artifactSummary = null;
      } finally {
        ui.artifactBusy = false;
        m.redraw();
      }
    };

    /** @param {boolean} [focusFile] */
    const clearImportSelection = (focusFile = false) => {
      ui.importInspectGeneration++;
      ui.importPayload = null; ui.importSummary = null; ui.importPass = '';
      ui.identityConflict = null; ui.replacementPending = false;
      ui.importNotices = [];
      if (ui.importFileInput) ui.importFileInput.value = '';
      if (focusFile) ui.focusImportFileOnUpdate = true;
    };

    /** @param {'normal'|'replace'|'skip'} identityChoice */
    const doImport = async (identityChoice = 'normal') => {
      if (ui.importBusy || !ui.importPayload) return;
      ui.importBusy = true;
      ui.importMsg = null;
      m.redraw();
      try {
        const reply = await send({
          type: 'transfer/import',
          payload: ui.importPayload,
          passphrase: ui.importPass,
          replaceDwebIdentity: identityChoice === 'replace',
          skipDwebIdentity: identityChoice === 'skip',
          ...(identityChoice === 'replace' ? {
            approvedExistingDwebDid: ui.identityConflict?.existingDid,
            approvedExistingDwebRevision: ui.identityConflict?.existingRevision,
            approvedIncomingDwebDid: ui.identityConflict?.incomingDid,
          } : {}),
        });
        if (reply?.ok) {
          ui.importNotices = reply.notices ?? [];
          const identityText = (/** @type {Record<string, string>} */ ({
            restored: ' The peer identity was restored.',
            replaced: ' The previous peer identity was replaced.',
            'already-present': ' The backup’s peer identity was already present.',
            'kept-local': ' The local peer identity was kept.',
            unsupported: ' The backup’s peer identity was not supported by this build.',
            'not-present': '',
          }))[reply.identityOutcome ?? 'not-present'] ?? '';
          const recoveryText = reply.runtimeRecoveryPending
            ? ' Peer network restart pending.'
            : '';
          ui.importMsg = {
            ok: true,
            text: `Imported ${reply.imported.settings} setting(s), ${reply.imported.secrets} stored credential(s), `
              + `${reply.imported.providerEndpoints ?? 0} provider endpoint(s), `
              + `${reply.imported.memoryWritten} memory doc(s), and ${reply.imported.hooks} hook(s).${identityText}${recoveryText}`,
          };
          ui.importPayload = null;
          ui.importSummary = null;
          ui.importPass = '';
          ui.identityConflict = null;
          ui.replacementPending = false;
          ui.focusImportStatusOnUpdate = true;
          if (ui.importFileInput) ui.importFileInput.value = '';
        } else if (isUnknownMutationOutcome(reply)) {
          ui.importMsg = {
            ok: false,
            text: 'Peerd could not confirm the restore’s final state. Inspect local state, then choose the backup file again.',
          };
          clearImportSelection(true);
        } else if (reply?.partial) {
          ui.identityConflict = null;
          ui.replacementPending = false;
          ui.importMsg = {
            ok: false,
            text: `Import stopped after restoring ${describeImportedCounts(reply.partial)}. `
              + `The peer identity was not changed. ${describeImportFailure(reply.failure)} `
              + 'Review local state before choosing the backup file again.',
          };
          clearImportSelection(true);
        } else if (reply?.error === 'dweb-identity-conflict') {
          ui.identityConflict = reply.conflict;
          ui.replacementPending = false;
          ui.importMsg = null;
        } else {
          ui.importMsg = {
            ok: false,
            text: describeImportError(reply?.error),
          };
        }
      } catch (error) {
        if (error instanceof PrivateTransferPortError
            && IMPORT_NOT_STARTED_CODES.has(error.code)) {
          ui.importMsg = {
            ok: false,
            text: 'Restore did not start because the private connection was unavailable. Close any other peerd Settings tabs, then try again.',
          };
          ui.focusImportStatusOnUpdate = true;
        } else {
          ui.importMsg = {
            ok: false,
            text: 'The connection to peerd was lost during the import, so its final state is unknown. Reopen peerd, inspect local state, then choose the backup file again.',
          };
          clearImportSelection(true);
        }
      } finally {
        ui.importBusy = false;
        m.redraw();
      }
    };

    return m('.transfer-section', [
      m('h3', 'Back up peerd'),
      m('p', 'Download a JSON file with your settings, memory, hooks, '
        + 'skill list, provider endpoints, encrypted credentials, and, in '
        + 'preview builds, your encrypted peer identity. Most settings remain '
        + 'readable in the file; the passphrase protects credentials and identity. '
        + 'Use this to back up, or to move state '
        + 'between peerd and peerd preview (separate installs that never '
        + 'share storage automatically).'),
      m('.input-row', [
        m('label', { for: 'exppass' }, 'Export passphrase'),
        m('input', {
          id: 'exppass', type: 'password', autocomplete: 'new-password',
          minlength: EXPORT_PASSPHRASE_MIN_LENGTH, 'aria-describedby': 'backup-passphrase-help',
          value: ui.exportPass, disabled: ui.exportBusy,
          oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.exportPass = e.target.value; },
        }),
      ]),
      m('p.hint', { id: 'backup-passphrase-help' },
        `Use ${EXPORT_PASSPHRASE_MIN_LENGTH}+ characters. You will need this passphrase to restore encrypted credentials or your peer identity.`),
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
          ui.exportBusy ? 'Creating backup…' : 'Download backup'),
      ]),
      ui.exportMsg ? m(ui.exportMsg.ok ? 'p.transfer-status.transfer-status--success' : 'p.error.transfer-status.transfer-status--error',
        { role: ui.exportMsg.ok ? 'status' : 'alert' },
        ui.exportMsg.text) : null,

      m('.settings-divider'),
      m('h3', 'Restore from backup'),
      m('p', 'Pick a peerd export file. You will see exactly what it '
        + 'contains — and what will be overwritten — before anything is '
        + 'applied.'),
      m('label', { for: 'peerd-backup-file' }, 'Backup file'),
      m('input', {
        id: 'peerd-backup-file', type: 'file', accept: 'application/json,.json',
        disabled: ui.importBusy,
        oncreate: (/** @type {{ dom: HTMLInputElement }} */ vnode) => { ui.importFileInput = vnode.dom; },
        onupdate: (/** @type {{ dom: HTMLInputElement }} */ vnode) => {
          if (ui.focusImportFileOnUpdate && !vnode.dom.disabled) {
            ui.focusImportFileOnUpdate = false;
            vnode.dom.focus();
          }
        },
        onchange: onImportFile,
      }),
      ui.importInspectBusy ? m('.transfer-progress-row', [
        m('p.transfer-progress', { role: 'status', 'aria-live': 'polite' },
          'Inspecting backup. Keep this page open, or cancel and choose another file.'),
        m('button.secondary', {
          type: 'button',
          onclick: () => { ui.importInspectBusy = false; clearImportSelection(true); },
        }, 'Cancel inspection'),
      ]) : null,
      ui.importSummary ? m('span.sr-only', { role: 'status' }, 'Backup inspected. Review the import summary and choose what to restore.') : null,
      ui.importSummary ? m('.import-summary', {
        id: 'restore-summary', tabindex: -1, 'aria-busy': ui.importBusy ? 'true' : 'false',
        oncreate: (/** @type {{ dom: HTMLElement }} */ vnode) => vnode.dom.focus(),
      }, [
        m('h3', 'This import will apply:'),
        m('ul', [
          ui.importSummary.settingsKeys.length > 0
            ? m('li', [
                `${ui.importSummary.settingsKeys.length} setting(s) overwrite your current values.`,
                m('details.import-setting-values', [
                  m('summary', 'Review complete setting values'),
                  m('ul', ui.importSummary.settingsKeys.map((/** @type {string} */ key) =>
                    m('li', m('code', `${key} = ${describeSettingValue(ui.importPayload?.settings?.[key])}`)))),
                ]),
              ])
            : null,
          ui.importSummary.hasSecrets ? m('li', 'Stored credentials (encrypted — passphrase required below); existing credentials with the same name are overwritten') : null,
          ui.importSummary.hasIdentityRecord
            ? m('li', [
                'Peer identity ', m('code.identity-did', displayDid(ui.importSummary.identityDid)),
                ' (encrypted; restoring it may replace an identity created on this install)',
              ])
            : null,
          ui.importSummary.memoryDocs > 0 ? m('li', `${ui.importSummary.memoryDocs} memory doc(s) — newer local edits are kept (last-write-wins)`) : null,
          ui.importSummary.hooks > 0 ? m('li', `${ui.importSummary.hooks} hook(s) — hooks with the same id are replaced`) : null,
          ui.importSummary.skills.length > 0 ? m('li', `Skill list (metadata only): ${ui.importSummary.skills.join(', ')}`) : null,
        ]),
        ui.importSummary.notices.map((/** @type {string} */ n) => m('p.hint', n)),
        ui.importSummary.sourceChannel && ui.importSummary.sourceChannel !== CHANNEL
          ? m('p.hint', `This export came from a ${ui.importSummary.sourceChannel} build; you are on ${CHANNEL}. Your explicit values travel verbatim — channel defaults only apply to settings you have not touched.`)
          : null,
        ui.importSummary.requiresPassphrase ? m('.input-row', [
          m('label', { for: 'imppass' }, 'File passphrase'),
          m('input', {
            id: 'imppass', type: 'password', autocomplete: 'off',
            'aria-describedby': 'restore-passphrase-help',
            value: ui.importPass, disabled: ui.importBusy,
            oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.importPass = e.target.value; },
          }),
          m('p.hint', { id: 'restore-passphrase-help' },
            'Enter the passphrase that was used when this backup was created.'),
        ]) : null,
        ui.identityConflict ? m('.import-summary', {
          id: 'identity-conflict', tabindex: -1, role: 'alert',
          'aria-labelledby': 'identity-conflict-title',
          oncreate: (/** @type {{ dom: HTMLElement }} */ vnode) => vnode.dom.focus(),
        }, [
          m('h4', { id: 'identity-conflict-title' }, 'Identity conflict'),
          ui.identityConflict.existingUnreadable
            ? m('p', ['This install’s local peer identity is unreadable. The backup contains ',
                m('code.identity-did', displayDid(ui.identityConflict.incomingDid)), '.'])
            : m('p', ['This install uses ', m('code.identity-did', displayDid(ui.identityConflict.existingDid)),
                '; the backup uses ', m('code.identity-did', displayDid(ui.identityConflict.incomingDid)), '.']),
          m('p.hint', ui.identityConflict.existingUnreadable
            ? 'Keeping the current data imports the other backup sections only. Restoring the backup discards the damaged identity data.'
            : 'Keeping it imports the other backup sections only. Replacing changes the permanent peer identity seen by existing peers.'),
        ]) : null,
        ui.identityConflict && ui.replacementPending ? m('.identity-replace-confirmation', {
          id: 'identity-replace-confirmation', role: 'alert', tabindex: -1,
          oncreate: (/** @type {{ dom: HTMLElement }} */ vnode) => vnode.dom.focus(),
        }, [
          ui.identityConflict.existingUnreadable
            ? m('p.error', ['Discard the unreadable local identity and restore ',
                m('code.identity-did', displayDid(ui.identityConflict.incomingDid)), '?'])
            : m('p.error', ['Replace permanent peer identity ',
                m('code.identity-did', displayDid(ui.identityConflict.existingDid)), ' with ',
                m('code.identity-did', displayDid(ui.identityConflict.incomingDid)), '?']),
          m('p.hint', ui.identityConflict.existingUnreadable
            ? 'This permanently discards damaged local identity data. Existing peers will see the restored backup identity. This cannot proceed while locally authored apps are shared.'
            : 'Existing peers will see a new identity. You can restore the old identity only from another backup. This cannot proceed while locally authored apps are shared.'),
        ]) : null,
        ui.importBusy
          ? m('p.transfer-progress', { role: 'status', 'aria-live': 'polite' },
              'Restore in progress. It cannot be canceled. Identity checks may take a few seconds. Keep this page open.')
          : null,
        !ui.importBusy ? m('p.hint',
          'After restore starts, it cannot be canceled. Keep this page open until it finishes.') : null,
        m('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' }, [
          ui.identityConflict
              ? m('button', { type: 'button', disabled: ui.importBusy, onclick: () => doImport('skip') },
                ui.importBusy ? 'Importing…' : 'Keep current identity & import rest')
            : m('button', {
                type: 'button',
                disabled: ui.importBusy || !hasApplicableImport(ui.importSummary)
                  || (ui.importSummary.requiresPassphrase && !ui.importPass),
                onclick: () => doImport('normal'),
              },
                ui.importBusy ? 'Importing…' : hasApplicableImport(ui.importSummary) ? 'Apply import' : 'Nothing to restore'),
          ui.identityConflict
            ? ui.replacementPending
              ? m('button.danger', { type: 'button', disabled: ui.importBusy, onclick: () => doImport('replace') },
                  ui.importBusy ? 'Replacing identity…'
                    : ui.identityConflict.existingUnreadable
                      ? 'Discard damaged identity and restore'
                      : 'Permanently replace identity')
              : m('button.danger', {
                  type: 'button', disabled: ui.importBusy,
                  oncreate: (/** @type {{ dom: HTMLButtonElement }} */ vnode) => {
                    if (ui.restoreFocusToReview) { ui.restoreFocusToReview = false; vnode.dom.focus(); }
                  },
                  onupdate: (/** @type {{ dom: HTMLButtonElement }} */ vnode) => {
                    if (ui.restoreFocusToReview) { ui.restoreFocusToReview = false; vnode.dom.focus(); }
                  },
                  onclick: () => { ui.replacementPending = true; },
                },
                  'Review identity replacement')
            : null,
          ui.replacementPending
            ? m('button.secondary', {
                type: 'button', disabled: ui.importBusy,
                onclick: () => { ui.restoreFocusToReview = true; ui.replacementPending = false; },
              }, 'Go back')
            : null,
          m('button.secondary', {
            type: 'button', disabled: ui.importBusy,
            onclick: () => {
              ui.importMsg = null;
              clearImportSelection(true);
            },
          }, 'Cancel'),
        ]),
      ]) : null,
      ui.importNotices.map((/** @type {string} */ n) => m('p.hint', n)),
      ui.importMsg ? m(ui.importMsg.ok ? 'p.transfer-status.transfer-status--success' : 'p.error.transfer-status.transfer-status--error',
        {
          id: 'transfer-import-status', tabindex: -1,
          role: ui.importMsg.ok ? 'status' : 'alert',
          oncreate: (/** @type {{ dom: HTMLElement }} */ vnode) => {
            if (ui.focusImportStatusOnUpdate) { ui.focusImportStatusOnUpdate = false; vnode.dom.focus(); }
          },
          onupdate: (/** @type {{ dom: HTMLElement }} */ vnode) => {
            if (ui.focusImportStatusOnUpdate) { ui.focusImportStatusOnUpdate = false; vnode.dom.focus(); }
          },
        },
        ui.importMsg.text) : null,

      // --- Artifacts (.peerd files) — separate from settings & data ----
      // Apps, Notebooks, and VM recipes exported from their tabs.
      // Same inspect-then-apply contract: nothing is written until the
      // file's hashes verify AND the user clicks Apply; imports always
      // create a NEW artifact (fresh id), never overwriting one.
      m('.settings-divider'),
      m('h3', 'Debug bundle'),
      m('p', 'Download one chat\u2019s whole debugging story as a local JSON file: '
        + 'the transcript (including every actor and actor it delegated to), the '
        + 'audit slice, cost, settings, and live context snapshots \u2014 or the same '
        + 'data as an OpenTelemetry trace for any OTel viewer. Nothing is sent '
        + 'anywhere; stored credentials cannot appear in either file.'),
      m('.input-row', [
        m('label', { for: 'dbgsess' }, 'Chat'),
        ui.debugSessionsError
          ? m('button.muted', { type: 'button', onclick: ui.loadDebugSessions }, ui.debugSessionsError)
          : ui.debugSessions === null
          ? m('span.muted', 'loading\u2026')
          : ui.debugSessions.length === 0
            ? m('span.muted', 'no chats yet')
            : m('select', {
                id: 'dbgsess', value: ui.debugSessionId, disabled: ui.debugBusy,
                onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui.debugSessionId = e.target.value; },
              }, ui.debugSessions.map((/** @type {any} */ row) => m('option', { value: row.sessionId },
                `${row.title || '(untitled)'} \u00b7 ${new Date(row.createdAt).toLocaleString()}`))),
      ]),
      m('.button-row', [
        m('button', {
          disabled: ui.debugBusy || !ui.debugSessionId,
          onclick: () => exportDebug('json'),
        }, 'Export debug bundle'),
        m('button.secondary', {
          disabled: ui.debugBusy || !ui.debugSessionId,
          onclick: () => exportDebug('otlp'),
        }, 'Export OTel trace'),
      ]),
      ui.debugMsg ? m(ui.debugMsg.ok ? 'p.ok-msg' : 'p.err-msg', ui.debugMsg.text) : null,

      m('h3', 'Artifacts'),
      m('p', 'Import an app, Notebook, or VM recipe from a .peerd file '
        + '(exported via the Export button in the artifact’s own tab). '
        + 'This is separate from the settings export above: a .peerd file '
        + 'carries one artifact, verified against its content hashes, and '
        + 'importing always creates a new copy — nothing you have is '
        + 'overwritten.'),
      m('label', { for: 'peerd-artifact-file' }, 'Artifact file'),
      m('input', {
        id: 'peerd-artifact-file', type: 'file', accept: '.peerd',
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
            onclick: () => {
              ui.artifactInspectGeneration += 1;
              ui.artifactEnvelope = null;
              ui.artifactSummary = null;
            },
          }, 'Cancel'),
        ]),
      ]) : null,
      ui.artifactMsg ? m(ui.artifactMsg.ok ? 'p.transfer-status.transfer-status--success' : 'p.error.transfer-status.transfer-status--error',
        { role: ui.artifactMsg.ok ? 'status' : 'alert' }, ui.artifactMsg.text) : null,
    ]);
  },
};
