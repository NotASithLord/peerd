import { describe, expect, test } from 'bun:test';
import { makeDwebCustodyHost } from '../../extension/offscreen/dweb-custody-host.js';
import { makeDwebTransferHost } from '../../extension/offscreen/dweb-transfer-host.js';

const port = () => {
  const listeners: Array<(message: any) => void> = [];
  const sent: any[] = [];
  return {
    value: {
      onMessage: { addListener: (listener: (message: any) => void) => listeners.push(listener) },
      postMessage: (message: any) => { sent.push(message); },
    } as any,
    receive: (message: any) => listeners.forEach((listener) => listener(message)),
    sent,
  };
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitForPacket = async (sent: any[], requestId: string) => {
  for (let attempt = 0; attempt < 30
    && !sent.some((message) => message.requestId === requestId); attempt += 1) await nextTask();
  return sent.find((message) => message.requestId === requestId);
};
const fingerprintOperation = async (operation: string, args: any) => {
  const bytes = new TextEncoder().encode(JSON.stringify([operation, args]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  bytes.fill(0);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('dweb custody receipt host', () => {
  test('reconciles exact arguments across Port replacement, then acknowledges by receipt id', async () => {
    let release = (value: any) => {};
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:receipt', fingerprintOperation,
      readState: () => ({ suspensionOwner: null }),
      runOperation: async () => {
        runs += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const first = port();
    host.attach(first.value);
    first.receive({
      type: 'custody/request', requestId: 'request:first',
      operationId: 'operation:one', operation: 'export', args: { passphrase: 'secret' },
    });
    await nextTask();
    release({ identityRecord: { did: 'did:key:zA' } });
    await nextTask();

    const successor = port();
    host.attach(successor.value);
    successor.receive({
      type: 'custody/status', requestId: 'status:first', operationId: 'operation:query',
      operation: 'export', args: { passphrase: 'secret' },
    });
    await nextTask();
    expect(successor.sent.at(-1)).toMatchObject({
      type: 'custody/status-response', authorityId: 'authority:receipt',
      operationId: 'operation:query',
      receipt: {
        operationId: 'operation:one', state: 'succeeded',
        result: { identityRecord: { did: 'did:key:zA' } },
      },
    });
    successor.receive({
      type: 'custody/request', requestId: 'request:duplicate',
      operationId: 'operation:one', operation: 'export', args: { passphrase: 'secret' },
    });
    await nextTask();
    expect(successor.sent.at(-1)).toMatchObject({
      type: 'custody/response', requestId: 'request:duplicate', ok: true,
      result: { identityRecord: { did: 'did:key:zA' } },
    });
    expect(runs).toBe(1);

    successor.receive({ type: 'custody/ack', operationId: 'operation:one' });
    successor.receive({
      type: 'custody/status', requestId: 'status:after-ack', operationId: 'operation:next',
      operation: 'export', args: { passphrase: 'secret' },
    });
    await nextTask();
    expect(successor.sent.at(-1)).toMatchObject({ receipt: { state: 'missing' } });
    expect(JSON.stringify(successor.sent)).not.toContain('secret');
  });

  test('an operation id cannot be reused for different arguments or an operation', async () => {
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:conflict', fingerprintOperation,
      readState: () => ({}),
      runOperation: async () => { runs += 1; return null; },
    });
    const connected = port();
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:export',
      operationId: 'operation:shared', operation: 'export', args: { passphrase: 'one' },
    });
    await nextTask();
    connected.receive({
      type: 'custody/request', requestId: 'request:args',
      operationId: 'operation:shared', operation: 'export', args: { passphrase: 'two' },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:args', ok: false, error: 'operation-id-conflict',
    });
    connected.receive({
      type: 'custody/request', requestId: 'request:adopt',
      operationId: 'operation:shared', operation: 'adopt', args: { passphrase: 'one' },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:adopt', ok: false, error: 'operation-id-conflict',
    });
    expect(runs).toBe(1);
  });

  test('canonical fingerprints preserve reserved object keys', async () => {
    const host = makeDwebCustodyHost({
      authorityId: 'authority:reserved-keys',
      readState: () => ({}),
      runOperation: async () => ({ adopted: false }),
    });
    const connected = port();
    const args = Object.create(null);
    Object.defineProperty(args, '__proto__', {
      value: { marker: 'present' }, enumerable: true,
    });
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:reserved',
      operationId: 'operation:reserved', operation: 'adopt', args,
    });
    await nextTask();
    connected.receive({
      type: 'custody/status', requestId: 'status:plain', operationId: 'operation:plain',
      operation: 'adopt', args: {},
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({ receipt: { state: 'missing' } });
    connected.receive({
      type: 'custody/status', requestId: 'status:reserved', operationId: 'operation:query',
      operation: 'adopt', args,
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      receipt: { operationId: 'operation:reserved', state: 'succeeded' },
    });
  });

  test('times out and aborts a hung operation without poisoning later work', async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:timeout', fingerprintOperation, operationTimeoutMs: 5,
      readState: () => ({}),
      runOperation: async (_operation, _args, context) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = context.signal;
          return new Promise(() => {});
        }
        return { adopted: false, reason: 'already-present' };
      },
    });
    const connected = port();
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:hung',
      operationId: 'operation:hung', operation: 'adopt', args: { passphrase: 'one' },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(firstSignal?.aborted).toBe(true);
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:hung', ok: false,
      error: 'identity-custody-operation-timeout', outcomeKnown: true,
      phase: 'inspection',
    });

    connected.receive({ type: 'custody/ack', operationId: 'operation:hung' });
    connected.receive({
      type: 'custody/request', requestId: 'request:next',
      operationId: 'operation:next', operation: 'adopt', args: { passphrase: 'one' },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:next', ok: true,
      result: { adopted: false, reason: 'already-present' },
    });
  });

  test('a hung adoption times out before the live runtime is suspended', async () => {
    let releaseStart = () => {};
    let firstSignal: AbortSignal | undefined;
    let cryptoCalls = 0;
    let stops = 0;
    let starts = 0;
    const transfer = makeDwebTransferHost({
      callEffect: async (operation) => {
        if (operation === 'identity/read') return { ok: true, value: null };
        if (operation === 'identity/policy') return { ok: true, allowed: true };
        if (operation === 'identity/commit') return { ok: true, committed: true };
        return { ok: false, error: 'effect-unknown' };
      },
      runCrypto: async (_operation, args, context) => {
        cryptoCalls += 1;
        if (cryptoCalls === 1) {
          firstSignal = context.signal;
          releaseStart();
          return new Promise(() => {});
        }
        return {
          adopted: true,
          material: JSON.stringify({ v: 1, seed: args.passphrase }),
          did: 'did:key:zIncoming', incomingDid: 'did:key:zIncoming', existingDid: null,
        };
      },
      stopIdentityRuntime: async () => { stops += 1; },
      startIdentityRuntime: async () => { starts += 1; },
    });
    const host = makeDwebCustodyHost({
      authorityId: 'authority:integrated-timeout', operationTimeoutMs: 5,
      readState: () => ({}),
      runOperation: (_operation, args, context) => transfer.adoptRecord(
        args.record, args.passphrase, args.options, context,
      ),
    });
    const connected = port();
    host.attach(connected.value);
    const entered = new Promise<void>((resolve) => { releaseStart = resolve; });
    connected.receive({
      type: 'custody/request', requestId: 'request:integrated-hung',
      operationId: 'operation:integrated-hung', operation: 'adopt',
      args: { record: {}, passphrase: 'hung', options: { replaceExisting: true } },
    });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(firstSignal?.aborted).toBe(true);
    expect(stops).toBe(0);
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:integrated-hung', ok: false,
      error: 'identity-custody-operation-timeout', outcomeKnown: true,
      phase: 'inspection',
    });

    connected.receive({
      type: 'custody/request', requestId: 'request:integrated-next',
      operationId: 'operation:integrated-next', operation: 'adopt',
      args: { record: {}, passphrase: 'next', options: { replaceExisting: true } },
    });
    expect(await waitForPacket(connected.sent, 'request:integrated-next')).toMatchObject({
      requestId: 'request:integrated-next', ok: true,
      result: { adopted: true, incomingDid: 'did:key:zIncoming' },
    });
    expect({ stops, starts }).toEqual({ stops: 1, starts: 1 });
  });

  test('read-only timeouts cannot exhaust receipt capacity', async () => {
    const host = makeDwebCustodyHost({
      authorityId: 'authority:read-capacity', operationTimeoutMs: 5, maxReceipts: 4,
      fingerprintOperation: async (operation, args) => `${operation}:${args.index}`,
      readState: () => ({}),
      runOperation: async () => new Promise(() => {}),
    });
    const connected = port();
    host.attach(connected.value);
    for (let index = 0; index < 5; index += 1) {
      const requestId = `request:read:${index}`;
      connected.receive({
        type: 'custody/request', requestId,
        operationId: `operation:read:${index}`, operation: 'export', args: { index },
      });
      expect(await waitForPacket(connected.sent, requestId)).toMatchObject({
        requestId, operationId: `operation:read:${index}`,
        ok: false, error: 'identity-custody-operation-timeout', outcomeKnown: true,
      });
    }
  });

  test('recovery is bound to the exact unknown adoption receipt and arguments', async () => {
    const recovered: string[] = [];
    const host = makeDwebCustodyHost({
      authorityId: 'authority:recovery-binding', operationTimeoutMs: 5,
      readState: () => ({}),
      runOperation: async (_operation, _args, context) => {
        context.setPhase('commit-dispatched');
        return new Promise(() => {});
      },
      recoverOperation: async (operationId) => { recovered.push(operationId); },
    });
    const connected = port();
    const args = { record: { sealed: true }, passphrase: 'secret', options: {} };
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:recoverable',
      operationId: 'operation:recoverable', operation: 'adopt', args,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(connected.sent.at(-1)).toMatchObject({
      outcomeKnown: false, phase: 'commit-dispatched',
    });
    connected.receive({
      type: 'custody/recover', requestId: 'recover:wrong',
      operationId: 'operation:recoverable', operation: 'adopt', args: { ...args, passphrase: 'wrong' },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'recover:wrong', ok: false, error: 'custody-recovery-invalid',
    });
    expect(recovered).toHaveLength(0);
    connected.receive({
      type: 'custody/recover', requestId: 'recover:exact',
      operationId: 'operation:recoverable', operation: 'adopt', args,
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({ requestId: 'recover:exact', ok: true });
    expect(recovered).toEqual(['operation:recoverable']);
    expect(JSON.stringify(connected.sent)).not.toContain('secret');
  });

  test('a late local settlement upgrades reconciliation without a duplicate response', async () => {
    let release = (value: any) => {};
    const host = makeDwebCustodyHost({
      authorityId: 'authority:late', fingerprintOperation, operationTimeoutMs: 5,
      readState: () => ({}),
      runOperation: async () => new Promise((resolve) => { release = resolve; }),
    });
    const connected = port();
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:late',
      operationId: 'operation:late', operation: 'adopt', args: { record: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(connected.sent.filter((message) => message.requestId === 'request:late')).toHaveLength(1);
    release({ adopted: true });
    await nextTask();
    expect(connected.sent.filter((message) => message.requestId === 'request:late')).toHaveLength(1);
    connected.receive({
      type: 'custody/status', requestId: 'status:late', operationId: 'operation:query',
      operation: 'adopt', args: { record: 1 },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      receipt: { operationId: 'operation:late', state: 'succeeded', result: { adopted: true } },
    });
  });

  test('retains bounded unknown evidence until an exact retry claims it', async () => {
    let recover = false;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:bounded', fingerprintOperation, maxReceipts: 4,
      readState: () => ({}),
      runOperation: async () => {
        if (recover) return { adopted: true };
        throw Object.assign(new Error('identity-store-outcome-unknown'), {
          code: 'identity-store-outcome-unknown', outcomeKnown: false,
        });
      },
    });
    const connected = port();
    host.attach(connected.value);
    for (let index = 0; index < 4; index += 1) {
      connected.receive({
        type: 'custody/request', requestId: `request:${index}`,
        operationId: `operation:${index}`, operation: 'adopt', args: { record: index },
      });
    }
    await nextTask();
    connected.receive({
      type: 'custody/request', requestId: 'request:full',
      operationId: 'operation:full', operation: 'adopt', args: { record: 5 },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:full', ok: false, error: 'custody-receipts-full',
    });

    connected.receive({
      type: 'custody/status', requestId: 'status:exact', operationId: 'operation:query',
      operation: 'adopt', args: { record: 0 },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      receipt: {
        operationId: 'operation:0', state: 'failed',
        error: 'identity-store-outcome-unknown', outcomeKnown: false,
      },
    });
    connected.receive({ type: 'custody/ack', operationId: 'operation:0' });
    recover = true;
    connected.receive({
      type: 'custody/request', requestId: 'request:retry',
      operationId: 'operation:retry', operation: 'adopt', args: { record: 0 },
    });
    await nextTask();
    expect(connected.sent.at(-1)).toMatchObject({
      requestId: 'request:retry', ok: true, result: { adopted: true },
    });
  });
});
