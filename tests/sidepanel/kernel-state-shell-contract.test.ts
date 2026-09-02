import { describe, expect, test } from 'bun:test';
import {
  KERNEL_STATE_DEFERRED_FIELDS,
  KERNEL_STATE_PROVENANCE,
  KERNEL_STATE_SCHEMA,
} from '../../extension/shared/kernel-state-contract.js';
import {
  coldStateIsCurrent,
  normalizeColdStateSnapshot,
} from '../../extension/shared/kernel-state-shell.js';

const vault = {
  initialized: false, locked: true, unlockedAt: 0,
  prfEnrolled: false, hasRecovery: false, lockReason: null,
};
const settings = { vaultAutoLockMs: 2_700_000, confirmWebWrites: true };
const actorExecution = {
  status: 'available', host: 'offscreen-document-worker', reason: null, retryable: false,
};

const projected = (generation = 1, authorityEpoch = 'kernel-epoch-0001') => ({
  hydrated: true,
  vault,
  settings,
  session: {
    sessionId: null, messages: [],
    permission: { mode: 'plan', confirmActions: true },
  },
  providers: { current: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
  composer: {
    provider: 'anthropic', model: 'claude-sonnet-4-6', keyless: false,
    credentialReady: false, localReady: false, canSend: false, reason: 'vault-locked',
  },
  capabilities: { actorExecution },
  actors: {},
  spawned: { byToolUse: {}, sessions: {} },
  asyncTasks: {},
  actorProjectionEpoch: null,
  actorProjectionRevision: 0,
  projection: {
    schema: KERNEL_STATE_SCHEMA,
    provenance: KERNEL_STATE_PROVENANCE,
    authorityEpoch,
    generation,
    settings: 'hydrated',
    actorIsolation: 'base',
    semanticController: 'required',
    deferredFields: [...KERNEL_STATE_DEFERRED_FIELDS],
    failures: [],
  },
});

describe('cold shell state contract', () => {
  test('rejects provenance-less legacy snapshots', () => {
    const legacy = { vault, settings, capabilities: { actorExecution } };
    expect(normalizeColdStateSnapshot(legacy)).toBeNull();
  });

  test('accepts only current valid projections and rejects corrupt/future snapshots', () => {
    expect(normalizeColdStateSnapshot(projected())).toEqual(projected());
    expect(normalizeColdStateSnapshot({})).toBeNull();
    expect(normalizeColdStateSnapshot({ vault, settings })).toBeNull();
    expect(normalizeColdStateSnapshot({
      ...projected(), projection: { ...projected().projection, provenance: 'controller' },
    })).toBeNull();
    expect(normalizeColdStateSnapshot({
      ...projected(), projection: { ...projected().projection, schema: KERNEL_STATE_SCHEMA + 1 },
    })).toBeNull();
    expect(normalizeColdStateSnapshot({
      ...projected(),
      capabilities: { actorExecution: {
        status: 'unavailable', host: null, reason: 'legacy', retryable: true,
      } },
    })).toBeNull();
    expect(normalizeColdStateSnapshot({ ...projected(), pendingConfirm: null })).toBeNull();
    expect(normalizeColdStateSnapshot({
      ...projected(), vault: { ...vault, locked: false },
    })).toBeNull();
    expect(normalizeColdStateSnapshot({
      ...projected(), session: { sessionId: null, messages: [] },
    })).toBeNull();
  });

  test('invalid snapshots cannot be mistaken for a completed shell adoption', () => {
    const shell = Bun.file(new URL('../../extension/sidepanel/vault-shell.js', import.meta.url));
    return shell.text().then((source) => {
      expect(source).toContain('return false;');
      expect(source).toContain('reply?.ok && reply.state && adopt(reply.state, readyEpoch)');
      expect(source).not.toContain('if (reply?.ok && reply.state) {\n              adopt(reply.state);');
    });
  });

  test('terminal boot failures remain visible and expose one explicit reload retry', () => {
    const shell = Bun.file(new URL('../../extension/sidepanel/vault-shell.js', import.meta.url));
    return shell.text().then((source) => {
      expect(source).toContain("dataset.peerdBootStage = 'failed'");
      expect(source).toContain("shell.setAttribute('role', 'alert')");
      expect(source).toContain("retry.textContent = 'Retry'");
      expect(source).toContain("retry.addEventListener('click', () => location.reload(), { once: true })");
      expect(source).toContain('root.append(shell)');
    });
  });

  test('an authoritative Port loss restarts the bounded state watchdog', async () => {
    const source = await Bun.file(
      new URL('../../extension/sidepanel/vault-shell.js', import.meta.url),
    ).text();
    const disconnect = source.slice(source.indexOf('connectedPort.onDisconnect.addListener'),
      source.indexOf('const refreshUntilChanged'));
    expect(disconnect).toContain('hydrated: false');
    expect(disconnect).toContain('void refreshUntilChanged()');
    expect(source).toContain('renderFailure(cause);');
  });

  test('vault effects use bounded RPC and reconcile even when the receipt is lost', async () => {
    const source = await Bun.file(
      new URL('../../extension/sidepanel/vault-shell.js', import.meta.url),
    ).text();
    expect(source).toContain("import { makeUiRuntimeClient } from '/shared/ui-runtime-client.js'");
    expect(source).toContain('const uiRuntime = makeUiRuntimeClient({ browser })');
    expect(source).toContain('await uiRuntime.send(');
    expect(source).toContain("type.startsWith('vault/') && type !== 'vault/prfStatus'");
    expect(source).toContain('if (reconcile) void refreshUntilChanged()');
    expect(source).not.toContain('await browser.runtime.sendMessage(message)');
  });

  test('first paint may read only the nonsecret posture index while authority stays in the worker', () => {
    const shell = Bun.file(new URL('../../extension/sidepanel/vault-shell.js', import.meta.url));
    return shell.text().then((source) => {
      expect(source).toContain('browser.storage.local.get(VAULT_POSTURE_INDEX_KEY)');
      expect(source).toContain("typeof indexedDB.databases !== 'function'");
      expect(source).toContain("!databases.some((entry) => entry?.name === 'peerd')");
      expect(source).toContain('if (!posture && !freshInstall) return;');
      expect(source).toContain("peerdVaultPosture = posture\n        ? 'indexed' : 'fresh-provisional'");
      expect(source).toContain('hydrated: false');
      expect(source).toContain("dataset.peerdBootStage = 'vault-posture'");
      expect(source).toContain("dataset.peerdVaultPosture = 'authoritative'");
      expect(source).toContain('if (stopped || authoritativeStateSeen) return;');
      expect(source).not.toContain('browser.storage.local.set(');
      expect(source).not.toContain('browser.storage.local.remove(');
    });
  });

  test('rejects older same-epoch replies but permits worker epoch replacement', () => {
    expect(coldStateIsCurrent(projected(2), projected(1))).toBe(false);
    expect(coldStateIsCurrent(projected(2), projected(2))).toBe(true);
    expect(coldStateIsCurrent(projected(2), projected(1, 'kernel-epoch-0002'))).toBe(false);
    expect(coldStateIsCurrent(
      projected(2), projected(1, 'kernel-epoch-0002'), new Set(), 'kernel-epoch-0002',
    )).toBe(true);
    expect(coldStateIsCurrent({ vault }, projected(1))).toBe(true);
  });

  test('a retired authority epoch cannot recapture the shell after A to B replacement', () => {
    const retired = new Set(['kernel-epoch-0001']);
    expect(coldStateIsCurrent(
      projected(1, 'kernel-epoch-0002'),
      projected(99, 'kernel-epoch-0001'),
      retired,
    )).toBe(false);
    expect(coldStateIsCurrent(
      projected(1, 'kernel-epoch-0002'),
      projected(2, 'kernel-epoch-0003'),
      retired, 'kernel-epoch-0003',
    )).toBe(true);
    expect(coldStateIsCurrent(projected(1), { vault }, retired)).toBe(false);
  });

});
