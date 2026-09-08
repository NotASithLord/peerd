import { describe, expect, test } from 'bun:test';
import {
  IdentityTransferHostError as IdentityTransferError,
  makeDwebTransferHost,
} from '../../extension/offscreen/dweb-transfer-host.js';

const material = JSON.stringify({ v: 1, seed: 'seed', pub: 'pub' });

const baseDeps = (over: Record<string, any> = {}): Record<string, any> => ({
  vault: {
    isLocked: () => false,
    getSecret: async () => material,
    setSecret: async () => {},
  },
  identitySecretName: 'distributed/identity/v1',
  runCustodyOperation: async (operation: string) => operation === 'export'
    ? { did: 'did:key:zPortable' }
    : { adopted: true, material, did: 'did:key:zPortable', reason: 'already-present' },
  canReplaceIdentity: async () => true,
  stopIdentityRuntime: async () => {},
  startIdentityRuntime: async () => {},
  audit: async () => {},
  ...over,
});

const makeDwebTransfer = (deps: ReturnType<typeof baseDeps>) => {
  let sequence = 0;
  const host = makeDwebTransferHost({
    callEffect: async (operation: string, args: any, context: any) => {
      deps.observeEffect?.(operation, context);
      if (deps.vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (operation === 'identity/read') {
        return { ok: true, value: await deps.vault.getSecret(deps.identitySecretName) };
      }
      if (operation === 'identity/policy') {
        if (typeof deps.canAdoptIdentity === 'function'
            && !await deps.canAdoptIdentity(args.incomingDid)) {
          return { ok: true, allowed: false, reason: 'self-custody-mismatch' };
        }
        return await deps.canReplaceIdentity()
          ? { ok: true, allowed: true }
          : { ok: true, allowed: false, reason: 'identity-in-use' };
      }
      if (operation === 'identity/commit') {
        context.onDispatched?.();
        await deps.vault.setSecret(deps.identitySecretName, args.value);
        await deps.audit({
          type: args.expectedExistingDid ? 'dweb_identity_replaced' : 'dweb_identity_adopted',
          details: { did: args.incomingDid, previousDid: args.expectedExistingDid ?? null },
        }).catch(() => {});
        return { ok: true, committed: true };
      }
      return { ok: false, error: 'effect-unknown' };
    },
    runCrypto: deps.runCustodyOperation,
    stopIdentityRuntime: deps.stopIdentityRuntime,
    startIdentityRuntime: deps.startIdentityRuntime,
  });
  const context = () => ({
    operationId: `operation:${++sequence}`,
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    ...(deps.observePhase ? { setPhase: deps.observePhase } : {}),
  });
  return {
    exportRecord: (passphrase: string) => host.exportRecord(passphrase, context()),
    prepareRecord: (record: any, passphrase: string, options: any = {}) =>
      host.prepareRecord(record, passphrase, options, context()),
    adoptRecord: (record: any, passphrase: string, options: any = {}) =>
      host.adoptRecord(record, passphrase, options, context()),
  };
};

describe('dweb transfer custody host', () => {
  test('identity adoption cannot split an existing self-device membership', async () => {
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      canAdoptIdentity: async (incomingDid: string) => incomingDid === 'did:key:zMemberRoot',
      runCustodyOperation: async () => ({
        adopted: true, material, did: 'did:key:zOtherRoot', incomingDid: 'did:key:zOtherRoot',
        existingDid: 'did:key:zMemberRoot', reason: 'replaced',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => material,
        setSecret: async () => { writes++; },
      },
    }));
    expect(await transfer.prepareRecord({}, 'passphrase', { replaceExisting: true }))
      .toMatchObject({ adopted: false, reason: 'self-custody-mismatch' });
    expect(writes).toBe(0);
  });

  test('fails loudly on a bad host reply', async () => {
    const messages: any[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async (operation: string, args: any) => {
        messages.push({ operation, args });
        throw Object.assign(new Error('worker crashed'), { code: 'worker-crashed' });
      },
    }));
    await expect(transfer.exportRecord('backup-passphrase'))
      .rejects.toMatchObject({ name: 'IdentityTransferError', code: 'worker-crashed' });
    expect(messages[0]).toMatchObject({
      operation: 'export',
      args: { material: { v: 1, seed: 'seed', pub: 'pub' }, passphrase: 'backup-passphrase' },
    });
  });

  test('an install without an identity exports no identity section', async () => {
    let hosted = false;
    const transfer = makeDwebTransfer(baseDeps({
      vault: { isLocked: () => false, getSecret: async () => null, setSecret: async () => {} },
      runCustodyOperation: async () => { hosted = true; return null; },
    }));
    expect(await transfer.exportRecord('backup-passphrase')).toBeNull();
    expect(hosted).toBe(false);
  });
});

describe('dweb transfer adoption shell', () => {
  test('replacement stops the old runtime before the vault write, audits, then restarts', async () => {
    const events: string[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => {
        events.push('crypto');
        return {
          adopted: true,
          material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
          did: 'did:key:zNew',
          existingDid: 'did:key:zOld',
          reason: 'replaced',
        };
      },
      vault: {
        isLocked: () => false,
        getSecret: async () => material,
        setSecret: async () => { events.push('write'); },
      },
      stopIdentityRuntime: async () => { events.push('stop'); },
      startIdentityRuntime: () => { events.push('start'); },
      audit: async () => { events.push('audit'); },
    }));
    const outcome = await transfer.adoptRecord({}, 'backup-passphrase', { replaceExisting: true });
    expect(outcome.reason).toBe('replaced');
    expect(events).toEqual(['crypto', 'stop', 'write', 'audit', 'start']);
  });

  test('a stop failure prevents the custody write', async () => {
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => ({ adopted: true, material, reason: 'replaced' }),
      stopIdentityRuntime: async () => { throw new IdentityTransferError('stop-failed'); },
      vault: {
        isLocked: () => false,
        getSecret: async () => material,
        setSecret: async () => { writes++; },
      },
    }));
    await expect(transfer.adoptRecord({}, 'backup-passphrase', { replaceExisting: true }))
      .rejects.toMatchObject({ code: 'stop-failed' });
    expect(writes).toBe(0);
  });

  test('does not retain a local serial tail', async () => {
    let concurrent = 0;
    let peak = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return { adopted: false, material: null, reason: 'did-conflict' };
      },
    }));
    await Promise.all([
      transfer.adoptRecord({}, 'one'),
      transfer.adoptRecord({}, 'two'),
    ]);
    expect(peak).toBe(2);
  });

  test('a hung crypto call does not block a later transfer', async () => {
    let started = () => {};
    let observedSignal: AbortSignal | undefined;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async (operation: string, args: any, context: any) => {
        if (args.passphrase === 'hung') {
          observedSignal = context.signal;
          started();
          return new Promise(() => {});
        }
        return operation === 'export' ? { did: 'did:key:zPortable' } : null;
      },
    }));
    const entered = new Promise<void>((resolve) => { started = resolve; });
    void transfer.exportRecord('hung');
    await entered;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    await expect(transfer.exportRecord('next')).resolves.toMatchObject({
      identityRecord: { did: 'did:key:zPortable' },
    });
  });

  test('a hung runtime stop does not block a read-only transfer', async () => {
    let stopping = () => {};
    const transfer = makeDwebTransfer(baseDeps({
      stopIdentityRuntime: async () => {
        stopping();
        return new Promise(() => {});
      },
    }));
    const entered = new Promise<void>((resolve) => { stopping = resolve; });
    void transfer.adoptRecord({}, 'backup-passphrase', { replaceExisting: true });
    await entered;
    await expect(transfer.exportRecord('backup-passphrase')).resolves.toMatchObject({
      identityRecord: { did: 'did:key:zPortable' },
    });
  });

  test('a hung runtime restart does not block a read-only transfer', async () => {
    let restarting = () => {};
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async (operation: string) => operation === 'export'
        ? { did: 'did:key:zPortable' }
        : {
            adopted: true,
            material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
            did: 'did:key:zNew', existingDid: 'did:key:zOld',
            incomingDid: 'did:key:zNew', reason: 'replaced',
          },
      startIdentityRuntime: async () => {
        restarting();
        return new Promise(() => {});
      },
    }));
    const entered = new Promise<void>((resolve) => { restarting = resolve; });
    void transfer.adoptRecord({}, 'backup-passphrase', { replaceExisting: true });
    await entered;
    await expect(transfer.exportRecord('backup-passphrase')).resolves.toMatchObject({
      identityRecord: { did: 'did:key:zPortable' },
    });
  });

  test('binds every kernel effect to its parent operation', async () => {
    const parents: string[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      observeEffect: (_operation: string, context: any) => {
        parents.push(context.parentOperationId);
      },
    }));
    await transfer.exportRecord('backup-passphrase');
    expect(parents.length).toBeGreaterThan(0);
    expect(new Set(parents).size).toBe(1);
    expect(parents[0]).toMatch(/^operation:/);
  });

  test('replacement is refused while local shares are identity-bound', async () => {
    let stops = 0;
    let starts = 0;
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      canReplaceIdentity: async () => false,
      runCustodyOperation: async () => ({
        adopted: true, material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        existingDid: 'did:key:zOld', incomingDid: 'did:key:zNew', reason: 'replaced',
      }),
      stopIdentityRuntime: async () => { stops++; },
      startIdentityRuntime: async () => { starts++; },
      vault: {
        isLocked: () => false,
        getSecret: async () => material,
        setSecret: async () => { writes++; },
      },
    }));
    expect(await transfer.adoptRecord({}, 'backup-passphrase', { replaceExisting: true }))
      .toMatchObject({ adopted: false, reason: 'identity-in-use' });
    expect({ stops, starts, writes }).toEqual({ stops: 0, starts: 0, writes: 0 });
  });

  test('commit refuses when the prepared local did changed before adoption', async () => {
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => ({
        adopted: true, material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        existingDid: 'did:key:zUnexpected', incomingDid: 'did:key:zIncoming', reason: 'replaced',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => material,
        setSecret: async () => { writes++; },
      },
    }));
    expect(await transfer.adoptRecord({}, 'backup-passphrase', {
      replaceExisting: true,
      expectedExistingDid: 'did:key:zApproved',
      expectedIncomingDid: 'did:key:zIncoming',
    })).toMatchObject({ adopted: false, reason: 'identity-changed' });
    expect(writes).toBe(0);
  });

  test('fresh recovery suspends only for the commit, then resumes', async () => {
    const events: string[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      observeEffect: (operation: string) => {
        if (operation === 'identity/read') events.push('lane');
      },
      stopIdentityRuntime: async () => { events.push('suspend'); },
      startIdentityRuntime: async () => { events.push('resume'); },
      runCustodyOperation: async () => ({
        adopted: true,
        material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        did: 'did:key:zIncoming', existingDid: null, incomingDid: 'did:key:zIncoming', reason: 'recovered',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => { events.push('write'); },
      },
    }));
    expect(await transfer.adoptRecord({}, 'backup-passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    })).toMatchObject({ adopted: true, reason: 'recovered' });
    expect(events).toEqual(['lane', 'suspend', 'write', 'resume']);
  });

  test('commit phase begins only when the effect is dispatched', async () => {
    const phases: string[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      observePhase: (phase: string) => { phases.push(phase); },
      runCustodyOperation: async () => ({
        adopted: true, material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        did: 'did:key:zIncoming', existingDid: null,
        incomingDid: 'did:key:zIncoming', reason: 'recovered',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => {},
      },
    }));
    await transfer.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    expect(phases).toEqual(['suspending', 'commit-dispatched', 'recovering']);
  });

  test('a committed identity reports runtime recovery when lease release is retrying', async () => {
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => ({
        adopted: true,
        material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        did: 'did:key:zIncoming', existingDid: null,
        incomingDid: 'did:key:zIncoming', reason: 'recovered',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => {},
      },
      startIdentityRuntime: async () => { throw new Error('lost acknowledgement'); },
    }));
    expect(await transfer.adoptRecord({}, 'backup-passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    })).toMatchObject({
      adopted: true, reason: 'recovered', runtimeRecoveryPending: true,
    });
  });

  test('a pre-commit crypto error does not suspend or enter recovery', async () => {
    let starts = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => {
        throw Object.assign(new Error('bad passphrase'), { code: 'bad-passphrase' });
      },
      startIdentityRuntime: async () => { starts += 1; },
    }));
    await expect(transfer.adoptRecord({}, 'wrong', { replaceExisting: true }))
      .rejects.toMatchObject({ code: 'bad-passphrase', outcomeKnown: true });
    expect(starts).toBe(0);
  });

  test('fresh recovery is blocked when local shares still bind the old publisher', async () => {
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      canReplaceIdentity: async () => false,
      runCustodyOperation: async () => ({
        adopted: true,
        material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        did: 'did:key:zIncoming', existingDid: null,
        incomingDid: 'did:key:zIncoming', reason: 'recovered',
      }),
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => { writes++; },
      },
    }));
    expect(await transfer.prepareRecord({}, 'backup-passphrase'))
      .toMatchObject({ adopted: false, reason: 'identity-in-use' });
    expect(writes).toBe(0);
  });

  test('repair approval is bound to the exact unreadable local value', async () => {
    let stored = '{broken-a';
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async (_operation: string, args: any) => args.replaceExisting
        ? {
            adopted: true,
            material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
            did: 'did:key:zIncoming', existingDid: null,
            incomingDid: 'did:key:zIncoming', reason: 'replaced-invalid-local',
          }
        : {
            adopted: false, material: null, did: null, existingDid: null,
            incomingDid: 'did:key:zIncoming', reason: 'invalid-local-identity',
          },
      vault: {
        isLocked: () => false,
        getSecret: async () => stored,
        setSecret: async () => { writes++; },
      },
    }));
    const prepared = await transfer.prepareRecord({}, 'backup-passphrase');
    expect(prepared).toMatchObject({
      reason: 'invalid-local-identity', existingUnreadable: true,
      incomingDid: 'did:key:zIncoming',
    });
    stored = '{broken-b';
    expect(await transfer.adoptRecord({}, 'backup-passphrase', {
      replaceExisting: true,
      expectedExistingDid: null,
      expectedExistingRevision: prepared.existingRevision,
      expectedIncomingDid: 'did:key:zIncoming',
    })).toMatchObject({ adopted: false, reason: 'identity-changed' });
    expect(writes).toBe(0);
  });
});
