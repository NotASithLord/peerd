import { describe, expect, test } from 'bun:test';
import {
  IdentityTransferError,
  makeDwebTransfer,
} from '../../extension/background/dweb-transfer.js';

const material = JSON.stringify({ v: 1, seed: 'seed', pub: 'pub' });

const makeLane = () => {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
};

const baseDeps = (over: Record<string, any> = {}) => ({
  enabled: true,
  offscreenAvailable: true,
  vault: {
    isLocked: () => false,
    getSecret: async () => material,
    setSecret: async () => {},
  },
  identitySecretName: 'distributed/identity/v1',
  runCustodyOperation: async (operation: string) => operation === 'export'
    ? { did: 'did:key:zPortable' }
    : { adopted: true, material, did: 'did:key:zPortable', reason: 'already-present' },
  loadDweb: async () => ({ available: false }),
  withIdentityMutation: makeLane(),
  canReplaceIdentity: async () => true,
  stopIdentityRuntime: async () => {},
  startIdentityRuntime: async () => {},
  audit: async () => {},
  ...over,
});

describe('dweb transfer host selection', () => {
  test('Chrome uses the offscreen host and fails loudly on a bad reply', async () => {
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

  test('Firefox runs the same crypto through the direct preview client', async () => {
    const calls: any[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      offscreenAvailable: false,
      runCustodyOperation: async () => { throw new Error('offscreen relay must not run'); },
      loadDweb: async () => ({
        available: true,
        identityRecordExport: async (args: any) => {
          calls.push(args);
          return { did: 'did:key:zFirefox' };
        },
      }),
    }));
    expect(await transfer.exportRecord('backup-passphrase')).toEqual({
      identityRecord: { did: 'did:key:zFirefox' },
    });
    expect(calls).toEqual([{
      material: { v: 1, seed: 'seed', pub: 'pub' },
      passphrase: 'backup-passphrase',
    }]);
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
      runCustodyOperation: async () => ({
        adopted: true,
        material: JSON.stringify({ v: 1, seed: 'new', pub: 'new' }),
        did: 'did:key:zNew',
        existingDid: 'did:key:zOld',
        reason: 'replaced',
      }),
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
    expect(events).toEqual(['stop', 'write', 'audit', 'start']);
  });

  test('a stop failure prevents the custody write', async () => {
    let writes = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async () => ({ adopted: true, material, reason: 'replaced' }),
      stopIdentityRuntime: async () => { throw new IdentityTransferError('stop failed', 'stop-failed'); },
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

  test('the injected custody lane serializes concurrent adoptions', async () => {
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
    expect(peak).toBe(1);
  });

  test('backup export shares the custody lane with replacement', async () => {
    let concurrent = 0;
    let peak = 0;
    const transfer = makeDwebTransfer(baseDeps({
      runCustodyOperation: async (operation: string) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return operation === 'export'
          ? { did: 'did:key:zPortable' }
          : { adopted: false, reason: 'did-conflict' };
      },
    }));
    await Promise.all([
      transfer.exportRecord('backup-passphrase'),
      transfer.adoptRecord({}, 'backup-passphrase'),
    ]);
    expect(peak).toBe(1);
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
    expect({ stops, starts, writes }).toEqual({ stops: 1, starts: 1, writes: 0 });
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

  test('fresh recovery suspends before entering the custody lane, then resumes', async () => {
    const events: string[] = [];
    const transfer = makeDwebTransfer(baseDeps({
      withIdentityMutation: async (operation: () => Promise<any>) => {
        events.push('lane');
        return operation();
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
    expect(events).toEqual(['suspend', 'lane', 'write', 'resume']);
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
