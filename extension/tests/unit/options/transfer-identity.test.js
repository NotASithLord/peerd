// @ts-check
// Options → Backup/restore: the identity-only path must still ask for the file
// passphrase, and a different local did requires an explicit keep/replace choice.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { TransferSection } from '/options/sections/transfer.js';
import { PrivateTransferPortError } from '/options/private-transfer-client.js';

const RECORD = { did: 'did:key:zIncomingPortable' };
const SUMMARY = Object.freeze({
  settingsKeys: [], hasSecrets: false, hasIdentityRecord: true,
  requiresPassphrase: true, identityDid: RECORD.did,
  memoryDocs: 0, hooks: 0, skills: [], notices: [], sourceChannel: 'preview',
});

const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); m.redraw.sync(); };

/**
 * @param {(msg: any, calls: any[]) => any} importReply
 * @param {(msg: any, calls: any[]) => any} [inspectReply]
 * @param {Record<string, any>} [stateOverrides]
 */
const mount = async (importReply, inspectReply, stateOverrides = {}) => {
  const calls = /** @type {any[]} */ ([]);
  const send = async (/** @type {any} */ msg) => {
    calls.push(msg);
    if (msg.type === 'transfer/import') return importReply(msg, calls);
    if (msg.type === 'transfer/inspectImport' && inspectReply) return inspectReply(msg, calls);
    return { ok: true };
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const state = {
    exportPass: '', exportConfirm: '', exportBusy: false, exportMsg: null,
    importPayload: { dweb: { identityRecord: RECORD } }, importSummary: SUMMARY,
    importPass: '', importBusy: false, importInspectBusy: false, importMsg: null, importNotices: [],
    identityConflict: null, replacementPending: false, importFileInput: null,
    importInspectGeneration: 0, restoreFocusToReview: false, focusImportFileOnUpdate: false,
    focusImportStatusOnUpdate: false,
    artifactEnvelope: null, artifactSummary: null, artifactBusy: false, artifactMsg: null,
    debugSessions: [], debugSessionId: '', debugBusy: false, debugMsg: null,
    ...stateOverrides,
  };
  m.mount(root, { view: () => TransferSection.view({ attrs: { send }, state }) });
  await flush();
  return { root, calls, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** @param {(msg: any) => Promise<any>} send */
const mountWhole = async (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(TransferSection, { send }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const flushUntil = async (/** @type {() => boolean} */ ready) => {
  for (const _attempt of Array.from({ length: 20 })) {
    await flush();
    if (ready()) return;
  }
};

describe('options.transfer — artifact import', () => {
  it('loads the artifact rail on demand and inspects a small selected file', async () => {
    const calls = /** @type {any[]} */ ([]);
    let reads = 0;
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      if (message.type === 'session/list') return { ok: true, sessions: [] };
      if (message.type === 'import/inspect') return {
        ok: true,
        summary: { kind: 'app', name: 'Fixture', size: 12, fileCount: 1 },
      };
      return { ok: true };
    };
    const { root, unmount } = await mountWhole(send);
    try {
      const input = /** @type {HTMLInputElement} */ (root.querySelector('#peerd-artifact-file'));
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ size: 12, text: async () => { reads += 1; return '{"fixture":true}'; } }],
      });
      input.dispatchEvent(new Event('change'));
      await flushUntil(() => calls.some((call) => call.type === 'import/inspect'));
      expect(reads).toBe(1);
      expect(calls.filter((call) => call.type === 'import/inspect')).toEqual([
        { type: 'import/inspect', envelope: { fixture: true } },
      ]);
      expect(root.textContent).toContain('Name: Fixture');
    } finally { unmount(); }
  });

  it('rejects an oversized artifact before reading or sending it', async () => {
    const calls = /** @type {any[]} */ ([]);
    let reads = 0;
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      return message.type === 'session/list' ? { ok: true, sessions: [] } : { ok: true };
    };
    const { root, unmount } = await mountWhole(send);
    try {
      const input = /** @type {HTMLInputElement} */ (root.querySelector('#peerd-artifact-file'));
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ size: Number.MAX_SAFE_INTEGER, text: async () => { reads += 1; return '{}'; } }],
      });
      input.dispatchEvent(new Event('change'));
      await flushUntil(() => root.textContent?.includes('too large to import safely') === true);
      expect(root.textContent).toContain('96 MB maximum');
      expect(reads).toBe(0);
      expect(calls.some((call) => call.type === 'import/inspect')).toBe(false);
    } finally { unmount(); }
  });
});

describe('options.transfer — portable identity restore', () => {
  it('shows and retries a chat-list startup failure', async () => {
    let attempts = 0;
    const send = async (/** @type {any} */ msg) => {
      if (msg.type !== 'session/list') return { ok: true };
      attempts += 1;
      return attempts === 1 ? { ok: false, error: 'Temporarily unavailable. Try again.' }
        : { ok: true, sessions: [{ sessionId: 'chat-1', title: 'Chat', createdAt: 1 }] };
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(TransferSection, { send }) });
    try {
      await flush();
      const retry = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Temporarily unavailable. Try again.'));
      expect(retry).toBeTruthy();
      retry.click();
      await flush();
      expect(root.querySelector('#dbgsess')?.textContent).toContain('Chat');
    } finally { m.mount(root, null); root.remove(); }
  });

  it('asks for a passphrase even when the backup carries no API keys', async () => {
    const { root, unmount } = await mount(() => ({ ok: false, error: 'unused' }));
    try {
      expect(root.textContent).toContain('Peer identity');
      expect(root.querySelector('#imppass')).toBeTruthy();
      expect(root.textContent).toContain('restoring it may replace an identity');
    } finally { unmount(); }
  });

  it('shows complete long setting values inside a compact disclosure', async () => {
    const value = { fallbacks: Array.from({ length: 40 }, (_, index) => `model-${index}`) };
    const { root, unmount } = await mount(() => ({ ok: false }), undefined, {
      importPayload: { settings: { providerFallbacks: value }, dweb: { identityRecord: RECORD } },
      importSummary: { ...SUMMARY, settingsKeys: ['providerFallbacks'] },
    });
    try {
      const details = root.querySelector('details.import-setting-values');
      expect(details).toBeTruthy();
      expect(details?.textContent).toContain(JSON.stringify(value));
      expect(details?.textContent).toContain('model-39');
    } finally { unmount(); }
  });

  it('stops on a conflict and keeps the local identity only after explicit choice', async () => {
    const { root, calls, unmount } = await mount((msg) => msg.skipDwebIdentity
      ? { ok: true, imported: { settings: 0, secrets: 0, memoryWritten: 0, hooks: 0, dwebIdentity: 0 }, identityOutcome: 'kept-local', notices: [] }
      : {
          ok: false, error: 'dweb-identity-conflict',
          conflict: { existingDid: 'did:key:zExistingLocal', incomingDid: RECORD.did },
        });
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      const apply = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import'));
      apply.click();
      await flush();
      expect(root.querySelector('#identity-conflict')?.textContent).toContain('Identity conflict');
      expect(root.querySelector('#identity-conflict')?.getAttribute('role')).toBe('alert');
      expect(root.textContent).toContain('did:key:zExistingLocal');
      expect(root.textContent).toContain(RECORD.did);
      expect(root.textContent).toContain('Keep current identity & import rest');
      expect(root.textContent).toContain('Review identity replacement');

      const keep = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Keep current identity & import rest'));
      keep.click();
      await flush();
      const imports = calls.filter((call) => call.type === 'transfer/import');
      expect(imports[1].skipDwebIdentity).toBe(true);
      expect(imports[1].replaceDwebIdentity).toBe(false);
      expect(root.querySelector('[role=status]')?.textContent).toContain('local peer identity was kept');
    } finally { unmount(); }
  });

  it('requires a second destructive confirmation before replacement', async () => {
    const { root, calls, unmount } = await mount(() => ({
      ok: false, error: 'dweb-identity-conflict',
      conflict: { existingDid: 'did:key:zExistingLocal', incomingDid: RECORD.did },
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Review identity replacement')).click();
      await flush();
      expect(root.querySelector('#identity-replace-confirmation')?.textContent).toContain('Existing peers will see a new identity');
      expect(root.textContent).toContain('Permanently replace identity');
      expect(root.querySelector('button.danger')).toBeTruthy();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Permanently replace identity')).click();
      await flush();
      const replacement = calls.filter((/** @type {any} */ call) => call.type === 'transfer/import').at(-1);
      expect(replacement.approvedExistingDwebDid).toBe('did:key:zExistingLocal');
      expect(replacement.approvedIncomingDwebDid).toBe(RECORD.did);
    } finally { unmount(); }
  });

  it('recovers from a rejected extension message instead of wedging controls', async () => {
    const { root, unmount } = await mount(() => Promise.reject(new Error('worker restarted')));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      const apply = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import'));
      apply.click();
      await flush();
      expect(root.textContent).toContain('final state is unknown');
      expect(root.querySelector('#restore-summary')).toBeFalsy();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(root.querySelector('#peerd-backup-file')).toBe(document.activeElement);
    } finally { unmount(); }
  });

  it('keeps the inspected backup when the private restore connection never starts', async () => {
    const { root, unmount } = await mount(() => Promise.reject(new PrivateTransferPortError(
      'private-transfer-channel-target-missing', 'channel-request-failed',
    )));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(root.querySelector('[role=alert]')?.textContent).toContain('Restore did not start');
      expect(root.querySelector('#restore-summary')).toBeTruthy();
      expect(/** @type {HTMLInputElement} */ (root.querySelector('#imppass')).value)
        .toBe('backup-passphrase');
    } finally { unmount(); }
  });

  it('discards an older inspection reply when a newer file was selected', async () => {
    /** @type {(value: any) => void} */ let resolveA = () => {};
    /** @type {(value: any) => void} */ let resolveB = () => {};
    const replyA = new Promise((resolve) => { resolveA = resolve; });
    const replyB = new Promise((resolve) => { resolveB = resolve; });
    const { root, unmount } = await mount(() => ({ ok: false }), (msg) =>
      msg.payload.id === 'A' ? replyA : replyB);
    try {
      const input = /** @type {HTMLInputElement} */ (root.querySelector('#peerd-backup-file'));
      const select = (/** @type {string} */ id) => {
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: [{ size: 10, text: async () => JSON.stringify({ id }) }],
        });
        input.dispatchEvent(new Event('change'));
      };
      select('A');
      await flush();
      select('B');
      await flush();
      resolveB({ ok: true, summary: { ...SUMMARY, identityDid: 'did:key:zNewestBackup' } });
      await flush();
      resolveA({ ok: true, summary: { ...SUMMARY, identityDid: 'did:key:zStaleBackup' } });
      await flush();
      expect(root.textContent).toContain('did:key:zNewestBackup');
      expect(root.textContent?.includes('did:key:zStaleBackup')).toBe(false);
    } finally { unmount(); }
  });

  it('lets the user cancel a stalled inspection and ignores its late reply', async () => {
    /** @type {(value: any) => void} */ let resolveInspect = () => {};
    const inspect = new Promise((resolve) => { resolveInspect = resolve; });
    const { root, unmount } = await mount(() => ({ ok: false }), () => inspect);
    try {
      const input = /** @type {HTMLInputElement} */ (root.querySelector('#peerd-backup-file'));
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ size: 10, text: async () => JSON.stringify({ id: 'slow' }) }],
      });
      input.dispatchEvent(new Event('change'));
      await flush();
      expect(root.querySelector('[role=status]')?.textContent).toContain('Inspecting backup');
      const cancel = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Cancel inspection'));
      cancel.click();
      await flush();
      expect(root.textContent?.includes('Inspecting backup')).toBe(false);
      expect(document.activeElement?.id).toBe('peerd-backup-file');
      resolveInspect({ ok: true, summary: SUMMARY });
      await flush();
      expect(root.querySelector('#restore-summary')).toBeFalsy();
    } finally { unmount(); }
  });

  it('reports completed section counts when final identity adoption fails', async () => {
    const { root, unmount } = await mount(() => ({
      ok: false,
      error: 'import-partial',
      failure: 'dweb-identity-stop-failed',
      partial: { settings: 2, secrets: 1, memoryWritten: 3, hooks: 4, dwebIdentity: 0 },
      identityOutcome: 'not-changed',
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(root.textContent).toContain('2 setting(s), 1 stored credential(s), 0 provider endpoint(s), 3 memory doc(s), and 4 hook(s)');
      expect(root.textContent).toContain('peer identity was not changed');
      expect(root.textContent).toContain('peer network could not be paused safely');
      expect(root.querySelector('#restore-summary')).toBeFalsy();
    } finally { unmount(); }
  });

  it('never reports an uncertain final identity commit as unchanged', async () => {
    const { root, unmount } = await mount(() => ({
      ok: false, error: 'import-partial', outcomeKnown: false,
      failure: 'dweb-identity-identity-store-outcome-unknown',
      partial: { settings: 2, secrets: 1, dwebIdentity: 0 },
      identityOutcome: 'unknown',
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(root.textContent).toContain('could not confirm');
      expect(root.textContent?.includes('identity was not changed')).toBe(false);
      expect(root.querySelector('#restore-summary')).toBeFalsy();
    } finally { unmount(); }
  });

  it('restores focus to the replacement review action after going back', async () => {
    const { root, unmount } = await mount(() => ({
      ok: false, error: 'dweb-identity-conflict',
      conflict: { existingDid: 'did:key:zExistingLocal', incomingDid: RECORD.did },
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Review identity replacement')).click();
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Go back')).click();
      await flush();
      expect(document.activeElement?.textContent).toBe('Review identity replacement');
    } finally { unmount(); }
  });

  it('moves focus to the result after a successful restore', async () => {
    const { root, unmount } = await mount(() => ({
      ok: true,
      imported: { settings: 0, secrets: 0, providerEndpoints: 0, memoryWritten: 0, hooks: 0, dwebIdentity: 1 },
      identityOutcome: 'restored', notices: [],
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(document.activeElement?.id).toBe('transfer-import-status');
      expect(root.querySelector('[role=status]')?.textContent).toContain('peer identity was restored');
    } finally { unmount(); }
  });

  it('binds repair of an unreadable local identity to its reviewed revision', async () => {
    const { root, calls, unmount } = await mount(() => ({
      ok: false, error: 'dweb-identity-conflict',
      conflict: {
        existingDid: null, incomingDid: RECORD.did,
        existingUnreadable: true, existingRevision: 'revision-a',
      },
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(root.textContent).toContain('local peer identity is unreadable');
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Review identity replacement')).click();
      await flush();
      const confirm = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Discard damaged identity and restore'));
      expect(confirm).toBeTruthy();
      confirm.click();
      await flush();
      expect(calls.filter((call) => call.type === 'transfer/import').at(-1)
        .approvedExistingDwebRevision).toBe('revision-a');
    } finally { unmount(); }
  });

  it('turns expected internal failures into recovery guidance', async () => {
    const { root, unmount } = await mount(() => ({
      ok: false, error: 'dweb-identity-identity-changed',
    }));
    try {
      const passphrase = /** @type {HTMLInputElement} */ (root.querySelector('#imppass'));
      passphrase.value = 'backup-passphrase';
      passphrase.dispatchEvent(new Event('input'));
      await flush();
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply import')).click();
      await flush();
      expect(root.textContent).toContain('identity changed after review');
      expect(root.textContent?.includes('dweb-identity-identity-changed')).toBe(false);
    } finally { unmount(); }
  });
});
