import { describe, expect, test } from 'bun:test';
import { createKernelDwebCustodyOwner } from '../../extension/background/kernel-preview-addon.js';
import { encodeDidKey } from '../../extension/peerd-distributed/identity/did.js';

const event = () => {
  const listeners: Function[] = [];
  return {
    addListener: (listener: Function) => { listeners.push(listener); },
    emit: (value?: any) => { for (const listener of listeners) listener(value); },
  };
};

const port = () => {
  const onMessage = event();
  const onDisconnect = event();
  let disconnected = 0;
  const sent: any[] = [];
  return {
    name: 'dweb-custody', sender: {}, onMessage, onDisconnect, sent,
    postMessage: (message: any) => { sent.push(message); },
    disconnect: () => { disconnected += 1; onDisconnect.emit(); },
    get disconnected() { return disconnected; },
  };
};
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const identityFixture = (marker = 7) => {
  const pub = new Uint8Array(32); pub[31] = marker;
  return {
    did: encodeDidKey(pub),
    material: JSON.stringify({
      v: 1, seed: btoa(String.fromCharCode(...new Uint8Array(32))),
      pub: btoa(String.fromCharCode(...pub)),
    }),
  };
};
const waitForPacket = async (live: ReturnType<typeof port>, type: string) => {
  for (let attempt = 0; attempt < 30
    && !live.sent.some((message) => message.type === type); attempt += 1) await nextTask();
  return live.sent.find((message) => message.type === type);
};

const owner = (overrides: Record<string, any> = {}) => {
  const secrets = new Map<string, string>();
  let sequence = 0;
  return createKernelDwebCustodyOwner({
    enabled: true,
    ensureDwebFeature: async () => {},
    active: () => true,
    vault: {
      isLocked: () => false,
      getSecret: async (name: string) => secrets.get(name) ?? null,
      setSecret: async (name: string, value: string) => { secrets.set(name, value); },
    },
    auditLog: { append: async () => {} },
    listApps: async () => [],
    newId: () => `id-${++sequence}`,
    ...overrides,
  });
};

describe('kernel dweb custody owner', () => {
  test('takes the verified Port synchronously and exposes a stable transfer facade', async () => {
    const runtime = owner();
    const live = port();
    expect(runtime.attachDwebCustody(live)).toBeUndefined();
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:one' });
    const pending = (await runtime.getDwebTransfer())!.exportRecord('backup-passphrase');
    await nextTask();
    const request = live.sent.find((message) => message.type === 'custody/request');
    expect(request).toMatchObject({ operation: 'export', args: { passphrase: 'backup-passphrase' } });
    live.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:one',
      ok: true, result: { identityRecord: { did: 'did:key:zA' } },
    });
    await expect(pending).resolves.toEqual({ identityRecord: { did: 'did:key:zA' } });
    expect(live.sent).toContainEqual({ type: 'custody/ack', operationId: request.operationId });
  });

  test('replacement poisons the prior Port and only the current authority can settle', async () => {
    const runtime = owner();
    const first = port();
    const second = port();
    runtime.attachDwebCustody(first);
    runtime.attachDwebCustody(second);
    expect(first.disconnected).toBe(1);
    second.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:new' });
    const pending = (await runtime.getDwebTransfer())!.exportRecord('passphrase');
    await nextTask();
    const request = second.sent.find((message) => message.type === 'custody/request');
    first.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:old', ok: true, result: {},
    });
    second.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:new', ok: true, result: null,
    });
    await expect(pending).resolves.toBeNull();
  });

  test('admits the exact host identity read without granting a forged transfer parent', async () => {
    const runtime = owner({
      vault: {
        isLocked: () => false,
        getSecret: async () => 'stored-identity',
        setSecret: async () => {},
      },
    });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:base' });
    live.onMessage.emit({
      type: 'custody/effect-request', requestId: 'base-read',
      operation: 'identity/read', args: {},
    });
    live.onMessage.emit({
      type: 'custody/effect-request', requestId: 'forged-read',
      parentOperationId: 'operation:forged', operation: 'identity/read', args: {},
    });
    await nextTask();
    expect(live.sent.find((message) => message.requestId === 'base-read'))
      .toMatchObject({ result: { ok: true, value: 'stored-identity' } });
    expect(live.sent.find((message) => message.requestId === 'forged-read'))
      .toMatchObject({ result: { ok: false, error: 'identity-grant-invalid' } });
  });

  test('the outer transfer request is the only identity grant and holds local mutation', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:lane' });
    const transfer = (await runtime.getDwebTransfer())!.exportRecord('passphrase');
    const request = await waitForPacket(live, 'custody/request');

    live.onMessage.emit({
      type: 'custody/effect-request', requestId: 'orphan-read',
      parentOperationId: 'operation:forged', operation: 'identity/read', args: {},
    });
    await nextTask();
    expect(live.sent.find((message) => message.requestId === 'orphan-read'))
      .toMatchObject({ result: { ok: false, error: 'identity-grant-invalid' } });
    let ran = false;
    const local = (await runtime.getDwebLive())!.withIdentityMutation(async () => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false);
    live.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:lane', ok: true, result: null,
    });
    await transfer;
    await local;
    expect(ran).toBe(true);
  });

  test('disconnect releases a transfer with no issued effect', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:disconnect' });
    const transfer = (await runtime.getDwebTransfer())!.exportRecord('passphrase');
    await waitForPacket(live, 'custody/request');
    let ran = false;
    const local = (await runtime.getDwebLive())!.withIdentityMutation(async () => { ran = true; });
    live.disconnect();
    await expect(transfer).rejects.toMatchObject({ code: 'dweb-custody-port-disconnected' });
    await local;
    expect(ran).toBe(true);
  });

  test('read-only host timeouts are known and release their receipts', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:read-timeout' });
    const transfer = (await runtime.getDwebTransfer())!;
    for (const [operation, pending] of [
      ['export', transfer.exportRecord('passphrase')],
      ['prepare', transfer.prepareRecord({}, 'passphrase')],
    ] as const) {
      await nextTask();
      const request = live.sent.find((message) => message.type === 'custody/request'
        && message.operation === operation);
      live.onMessage.emit({
        type: 'custody/response', requestId: request.requestId,
        operationId: request.operationId, authorityId: 'authority:read-timeout',
        ok: false, error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'inspection',
      });
      await expect(pending).rejects.toMatchObject({
        code: 'identity-custody-operation-timeout', outcomeKnown: true,
      });
      expect(live.sent).toContainEqual({
        type: 'custody/ack', operationId: request.operationId,
      });
    }
  });

  test('an adoption inspection timeout is known before commit dispatch', async () => {
    let retirements = 0;
    const runtime = owner({ retireDwebHost: async () => { retirements += 1; } });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:inspect-timeout' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:inspect-timeout',
      receipt: { state: 'missing' },
    });
    const request = await waitForPacket(live, 'custody/request');
    live.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:inspect-timeout',
      ok: false, error: 'identity-custody-operation-timeout', outcomeKnown: false,
      phase: 'inspection',
    });
    await expect(pending).rejects.toMatchObject({
      code: 'identity-custody-operation-timeout', outcomeKnown: true,
    });
    expect(live.sent).toContainEqual({
      type: 'custody/ack', operationId: request.operationId,
    });
    expect(retirements).toBe(1);
  });

  test('a wedged host is retired when the kernel times out before commit', async () => {
    let runtime: ReturnType<typeof owner>;
    let retirements = 0;
    const first = port();
    const successor = port();
    runtime = owner({
      timeoutMs: 10,
      retireDwebHost: async () => {
        retirements += 1;
        runtime.attachDwebCustody(successor);
        successor.onMessage.emit({
          type: 'custody/ready', authorityId: 'authority:unwedged',
        });
      },
    });
    runtime.attachDwebCustody(first);
    first.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:wedged' });
    const transfer = (await runtime.getDwebTransfer())!;
    const firstAttempt = transfer.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const firstStatus = await waitForPacket(first, 'custody/status');
    first.onMessage.emit({
      type: 'custody/status-response', requestId: firstStatus.requestId,
      operationId: firstStatus.operationId, authorityId: 'authority:wedged',
      receipt: { state: 'missing' },
    });
    await waitForPacket(first, 'custody/request');
    await expect(firstAttempt).rejects.toMatchObject({
      code: 'dweb-custody-operation-timeout', outcomeKnown: true,
    });
    expect(retirements).toBe(1);

    const retry = transfer.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const nextStatus = await waitForPacket(successor, 'custody/status');
    successor.onMessage.emit({
      type: 'custody/status-response', requestId: nextStatus.requestId,
      operationId: nextStatus.operationId, authorityId: 'authority:unwedged',
      receipt: { state: 'missing' },
    });
    const request = await waitForPacket(successor, 'custody/request');
    successor.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:unwedged',
      ok: true, result: { adopted: true, did: 'did:key:zIncoming', reason: 'recovered' },
    });
    await expect(retry).resolves.toMatchObject({ adopted: true });
  });

  test('a dispatched commit timeout stays unknown and retains its receipt', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:commit-timeout' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:commit-timeout',
      receipt: { state: 'missing' },
    });
    const request = await waitForPacket(live, 'custody/request');
    live.onMessage.emit({
      type: 'custody/effect-request', requestId: 'commit:timeout',
      parentOperationId: request.operationId, operation: 'identity/commit',
      args: {
        value: '{}', incomingDid: 'did:key:zIncoming', expectedExistingDid: null,
      },
    });
    live.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:commit-timeout',
      ok: false, error: 'identity-custody-operation-timeout', outcomeKnown: false,
      phase: 'commit-dispatched',
    });
    await expect(pending).rejects.toMatchObject({
      code: 'identity-custody-operation-timeout', outcomeKnown: false,
    });
    expect(live.sent).not.toContainEqual({
      type: 'custody/ack', operationId: request.operationId,
    });
  });

  test('a successor reconciles by exact host receipt without a passphrase verifier id', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:successor' });
    const args = {
      record: { did: 'did:key:zIncoming', capsule: { ciphertext: 'sealed' } },
      passphrase: 'backup-passphrase',
      options: {
        replaceExisting: true, expectedExistingRevision: 'a'.repeat(64),
        expectedIncomingDid: 'did:key:zIncoming',
      },
    };
    const pending = (await runtime.getDwebTransfer())!.adoptRecord(
      args.record, args.passphrase, args.options,
    );
    const status = await waitForPacket(live, 'custody/status');
    expect(status).toMatchObject({ operation: 'adopt', args });
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:successor',
      receipt: {
        state: 'succeeded', operationId: 'receipt:prior',
        result: { adopted: true, did: 'did:key:zIncoming' },
      },
    });
    await expect(pending).resolves.toMatchObject({ adopted: true });
    expect(live.sent).toContainEqual({ type: 'custody/ack', operationId: 'receipt:prior' });
    expect(live.sent.some((message) => message.type === 'custody/request')).toBe(false);
  });

  test('reconciliation clears known failures but retains failed recovery', async () => {
    for (const [phase, outcomeKnown] of [
      ['inspection', true],
      ['commit-dispatched', false],
    ] as const) {
      const runtime = owner();
      const live = port();
      runtime.attachDwebCustody(live);
      live.onMessage.emit({ type: 'custody/ready', authorityId: `authority:${phase}` });
      const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
        expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
      });
      const status = await waitForPacket(live, 'custody/status');
      live.onMessage.emit({
        type: 'custody/status-response', requestId: status.requestId,
        operationId: status.operationId, authorityId: `authority:${phase}`,
        receipt: {
          state: 'failed', operationId: `receipt:${phase}`,
          error: phase === 'inspection' ? 'bad-passphrase' : 'identity-custody-operation-timeout',
          outcomeKnown: phase === 'inspection', phase,
        },
      });
      if (phase === 'commit-dispatched') {
        const recover = await waitForPacket(live, 'custody/recover');
        live.onMessage.emit({
          type: 'custody/recover-response', requestId: recover.requestId,
          operationId: recover.operationId, authorityId: `authority:${phase}`,
          ok: false, error: 'custody-recovery-failed', outcomeKnown: false,
        });
      }
      await expect(pending).rejects.toMatchObject({
        code: phase === 'inspection'
          ? 'bad-passphrase' : 'custody-recovery-failed',
        outcomeKnown,
      });
      expect(live.sent.some((message) => message.type === 'custody/request')).toBe(false);
      expect(live.sent.some((message) => message.type === 'custody/ack'
        && message.operationId === `receipt:${phase}`)).toBe(outcomeKnown);
    }
  });

  test('a successor claims an applied commit, releases its lease, and returns success', async () => {
    const identity = identityFixture();
    const runtime = owner({
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1'
          ? identity.material : null,
        setSecret: async () => {},
      },
    });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:claim-applied' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: identity.did,
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:claim-applied',
      receipt: {
        state: 'failed', operationId: 'receipt:claim-applied',
        error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'commit-dispatched',
      },
    });
    const recover = await waitForPacket(live, 'custody/recover');
    live.onMessage.emit({
      type: 'custody/recover-response', requestId: recover.requestId,
      operationId: recover.operationId, authorityId: 'authority:claim-applied',
      ok: true, result: { active: false },
    });
    await expect(pending).resolves.toMatchObject({
      adopted: true, did: identity.did, reason: 'recovered', runtimeRecoveryPending: true,
    });
    expect(live.sent).toContainEqual({
      type: 'custody/ack', operationId: 'receipt:claim-applied',
    });
    expect(live.sent.some((message) => message.type === 'custody/request')).toBe(false);
  });

  test('an applied commit remains successful when runtime recovery fails', async () => {
    const identity = identityFixture();
    let retirements = 0;
    const runtime = owner({
      retireDwebHost: async () => { retirements += 1; },
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1'
          ? identity.material : null,
        setSecret: async () => {},
      },
    });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:applied-recovery-failed' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: identity.did,
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:applied-recovery-failed',
      receipt: {
        state: 'failed', operationId: 'receipt:applied-recovery-failed',
        error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'recovering',
      },
    });
    const recover = await waitForPacket(live, 'custody/recover');
    live.onMessage.emit({
      type: 'custody/recover-response', requestId: recover.requestId,
      operationId: recover.operationId, authorityId: 'authority:applied-recovery-failed',
      ok: false, error: 'custody-recovery-failed', outcomeKnown: false,
    });
    await expect(pending).resolves.toMatchObject({
      adopted: true, did: identity.did, runtimeRecoveryPending: true,
    });
    expect(retirements).toBe(1);
    expect(live.sent).not.toContainEqual({
      type: 'custody/ack', operationId: 'receipt:applied-recovery-failed',
    });
  });

  test('a successor claims a non-applied commit before one exact retry', async () => {
    const runtime = owner();
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:claim-retry' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:claim-retry',
      receipt: {
        state: 'failed', operationId: 'receipt:claim-retry',
        error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'commit-dispatched',
      },
    });
    const recover = await waitForPacket(live, 'custody/recover');
    expect(recover).toMatchObject({ operation: 'adopt', args: { passphrase: 'passphrase' } });
    live.onMessage.emit({
      type: 'custody/recover-response', requestId: recover.requestId,
      operationId: recover.operationId, authorityId: 'authority:claim-retry',
      ok: true, result: { active: false },
    });
    const request = await waitForPacket(live, 'custody/request');
    live.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:claim-retry',
      ok: true, result: { adopted: true, did: 'did:key:zIncoming', reason: 'recovered' },
    });
    await expect(pending).resolves.toMatchObject({ adopted: true });
    expect(live.sent).toContainEqual({
      type: 'custody/ack', operationId: 'receipt:claim-retry',
    });
  });

  test('a successor claims a conflicting identity without retrying the write', async () => {
    const current = identityFixture(9);
    const runtime = owner({
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1'
          ? current.material : null,
        setSecret: async () => {},
      },
    });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:claim-conflict' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: identityFixture().did,
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:claim-conflict',
      receipt: {
        state: 'failed', operationId: 'receipt:claim-conflict',
        error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'recovering',
      },
    });
    const recover = await waitForPacket(live, 'custody/recover');
    live.onMessage.emit({
      type: 'custody/recover-response', requestId: recover.requestId,
      operationId: recover.operationId, authorityId: 'authority:claim-conflict',
      ok: true, result: { active: true },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'identity-changed', outcomeKnown: true,
    });
    expect(live.sent).toContainEqual({
      type: 'custody/ack', operationId: 'receipt:claim-conflict',
    });
    expect(live.sent.some((message) => message.type === 'custody/request')).toBe(false);
  });

  test('a suspending predecessor is retired before an exact fresh request', async () => {
    let runtime: ReturnType<typeof owner>;
    const oldPort = port();
    const nextPort = port();
    runtime = owner({
      retireDwebHost: async () => {
        oldPort.disconnect();
        runtime.attachDwebCustody(nextPort);
        nextPort.onMessage.emit({
          type: 'custody/ready', authorityId: 'authority:after-retirement',
        });
      },
    });
    runtime.attachDwebCustody(oldPort);
    oldPort.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:before-retirement' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: 'did:key:zIncoming',
    });
    const status = await waitForPacket(oldPort, 'custody/status');
    oldPort.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId, authorityId: 'authority:before-retirement',
      receipt: {
        state: 'failed', operationId: 'receipt:suspending',
        error: 'identity-custody-operation-timeout', outcomeKnown: false,
        phase: 'suspending',
      },
    });
    const request = await waitForPacket(nextPort, 'custody/request');
    expect(request.operation).toBe('adopt');
    oldPort.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:before-retirement',
      ok: true, result: { adopted: false },
    });
    nextPort.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:after-retirement',
      ok: true, result: { adopted: true, did: 'did:key:zIncoming', reason: 'recovered' },
    });
    await expect(pending).resolves.toMatchObject({ adopted: true });
    expect(oldPort.sent.some((message) => message.type === 'custody/ack'
      && message.operationId === 'receipt:suspending')).toBe(false);
  });

  test('a silent status host is retired before one fresh adoption request', async () => {
    const existing = identityFixture(6);
    const incoming = identityFixture(7);
    const oldPort = port();
    const nextPort = port();
    let runtime: ReturnType<typeof owner>;
    let retired = 0;
    runtime = owner({
      timeoutMs: 5,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) =>
          name === 'distributed/identity/v1' ? existing.material : null,
        setSecret: async () => {},
      },
      retireDwebHost: async () => {
        retired += 1;
        oldPort.disconnect();
        runtime.attachDwebCustody(nextPort);
        nextPort.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:fresh' });
      },
    });
    runtime.attachDwebCustody(oldPort);
    oldPort.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:silent' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: existing.did, expectedIncomingDid: incoming.did,
    });
    await waitForPacket(oldPort, 'custody/status');
    const request = await waitForPacket(nextPort, 'custody/request');
    expect(request.operation).toBe('adopt');
    nextPort.onMessage.emit({
      type: 'custody/response', requestId: request.requestId,
      operationId: request.operationId, authorityId: 'authority:fresh',
      ok: true, result: { adopted: true, did: incoming.did, reason: 'replaced' },
    });
    await expect(pending).resolves.toMatchObject({ adopted: true, did: incoming.did });
    expect(retired).toBe(1);
    expect(oldPort.sent.some((message) => message.type === 'custody/request')).toBe(false);
  });

  test('a silent status host is retired after its landed identity is reconciled', async () => {
    const incoming = identityFixture(8);
    const live = port();
    let retired = 0;
    let writes = 0;
    const runtime = owner({
      timeoutMs: 5,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) =>
          name === 'distributed/identity/v1' ? incoming.material : null,
        setSecret: async () => { writes += 1; },
      },
      retireDwebHost: async () => { retired += 1; live.disconnect(); },
    });
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:landed' });
    const pending = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: incoming.did,
    });
    await waitForPacket(live, 'custody/status');
    await expect(pending).resolves.toMatchObject({
      adopted: true, did: incoming.did, runtimeRecoveryPending: true,
    });
    expect({ retired, writes }).toEqual({ retired: 1, writes: 0 });
    expect(live.sent.some((message) => message.type === 'custody/request')).toBe(false);
  });

  test('an unresolved commit blocks newer identity mutations until it settles', async () => {
    const { did: incomingDid, material } = identityFixture();
    let stored: string | null = null;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const runtime = owner({
      timeoutMs: 15,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1' ? stored : null,
        setSecret: async (_name: string, value: string) => {
          writeStarted(); await held; stored = value;
        },
      },
    });
    const live = port();
    runtime.attachDwebCustody(live);
    live.onMessage.emit({ type: 'custody/ready', authorityId: 'authority:recovery' });
    const transfer = (await runtime.getDwebTransfer())!.adoptRecord({}, 'passphrase', {
      expectedExistingDid: null, expectedIncomingDid: incomingDid,
    });
    const status = await waitForPacket(live, 'custody/status');
    live.onMessage.emit({
      type: 'custody/status-response', requestId: status.requestId,
      operationId: status.operationId,
      authorityId: 'authority:recovery', receipt: { state: 'missing' },
    });
    const request = await waitForPacket(live, 'custody/request');
    live.onMessage.emit({
      type: 'custody/effect-request', requestId: 'commit:one',
      parentOperationId: request.operationId, operation: 'identity/commit',
      args: { value: material, incomingDid, expectedExistingDid: null },
    });
    await started;
    await expect(transfer).rejects.toMatchObject({
      code: 'dweb-custody-operation-timeout', outcomeKnown: false,
    });
    await nextTask();
    await expect((await runtime.getDwebLive())!.withIdentityMutation(async () => {}))
      .rejects.toMatchObject({ code: 'identity-recovery-pending', outcomeKnown: false });
    releaseWrite();
    for (let attempt = 0; attempt < 30 && stored !== material; attempt += 1) await nextTask();
    await nextTask();
    await expect((await runtime.getDwebLive())!.withIdentityMutation(async () => 'next'))
      .resolves.toBe('next');
    expect(stored as string | null).toBe(material);
  });

  test('refuses disabled or malformed custody', async () => {
    const disabled = createKernelDwebCustodyOwner({ enabled: false });
    await expect(disabled.getDwebTransfer()).resolves.toBeNull();
    expect(() => disabled.attachDwebCustody(port())).toThrow('kernel-dweb-custody-port-invalid');
    expect(() => createKernelDwebCustodyOwner({ enabled: true } as any))
      .toThrow('kernel-dweb-custody-owner-config-invalid');
  });
});
