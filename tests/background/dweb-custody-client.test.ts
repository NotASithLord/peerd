import { describe, expect, test } from 'bun:test';
import {
  makeDwebCustodyClient, makeRetryableCustodyReset,
} from '../../extension/background/dweb-custody-client.js';
import { makeDwebCustodyHost } from '../../extension/offscreen/dweb-custody-host.js';
import { coldPortNamesFor } from '../../extension/background/cold-kernel-inventory.js';

const makeEvent = () => {
  const listeners: Array<(message?: any) => void> = [];
  return {
    addListener: (listener: (message?: any) => void) => { listeners.push(listener); },
    emit: (message?: any) => { for (const listener of listeners) listener(message); },
  };
};

const makePort = (authorityId = 'authority:test') => {
  const onMessage = makeEvent();
  const onDisconnect = makeEvent();
  const sent: any[] = [];
  return {
    port: {
      onMessage,
      onDisconnect,
      postMessage: (message: any) => { sent.push(message); },
      disconnect: () => onDisconnect.emit(),
    } as any,
    sent,
    reply: (message: any) => onMessage.emit(message),
    ready: () => onMessage.emit({ type: 'custody/ready', authorityId }),
    disconnect: () => onDisconnect.emit(),
    authorityId,
  };
};

const makePortPair = () => {
  const clientMessage = makeEvent();
  const clientDisconnect = makeEvent();
  const hostMessage = makeEvent();
  const hostDisconnect = makeEvent();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clientDisconnect.emit();
    hostDisconnect.emit();
  };
  return {
    client: {
      onMessage: clientMessage,
      onDisconnect: clientDisconnect,
      postMessage: (message: any) => {
        if (closed) throw new Error('port-closed');
        queueMicrotask(() => { if (!closed) hostMessage.emit(message); });
      },
      disconnect: close,
    } as any,
    host: {
      onMessage: hostMessage,
      onDisconnect: hostDisconnect,
      postMessage: (message: any) => {
        if (closed) throw new Error('port-closed');
        queueMicrotask(() => { if (!closed) clientMessage.emit(message); });
      },
      disconnect: close,
    } as any,
  };
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dweb custody port client', () => {
  test('carries a custody request and response only on the attached port', async () => {
    let ensured = 0;
    const host = makePort();
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => { ensured++; },
      handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 100,
      newRequestId: () => 'req-1',
    });
    client.attach(host.port);
    host.ready();
    const result = client.call('export', { passphrase: 'secret', material: { seed: 'root' } });
    await nextTask();
    expect(host.sent[0]).toMatchObject({
      type: 'custody/request', requestId: 'req-1', operation: 'export',
      args: { passphrase: 'secret', material: { seed: 'root' } },
    });
    host.reply({
      type: 'custody/response', requestId: 'req-1',
      operationId: host.sent[0].operationId, authorityId: host.authorityId,
      ok: true, result: { did: 'did:key:zA' },
    });
    expect(await result).toEqual({ did: 'did:key:zA' });
    expect(ensured).toBe(0);
  });

  test('waits for the verified host port after ensuring the offscreen document', async () => {
    const host = makePort();
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {},
      handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 100,
      newRequestId: () => 'req-2',
    });
    const result = client.call('reset');
    await nextTask();
    client.attach(host.port);
    host.ready();
    await nextTask();
    expect(host.sent[0]).toMatchObject({ operation: 'reset', requestId: 'req-2' });
    host.reply({
      type: 'custody/response', requestId: 'req-2',
      operationId: host.sent[0].operationId, authorityId: host.authorityId,
      ok: true, result: { reset: true },
    });
    await expect(result).resolves.toEqual({ reset: true });
  });

  test('rejects in-flight custody work when the exact port disconnects', async () => {
    const host = makePort();
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 100, newRequestId: () => 'req-3',
    });
    client.attach(host.port);
    host.ready();
    const result = client.call('adopt', {});
    await nextTask();
    host.disconnect();
    await expect(result).rejects.toMatchObject({
      name: 'DwebCustodyPortError', code: 'port-disconnected',
    });
  });

  test('retries cleanly after the initial port wait times out and a host reconnects', async () => {
    const ids = ['timed-out', 'after-reconnect'];
    const host = makePort();
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 5, newRequestId: () => ids.shift() ?? 'extra',
    });
    await expect(client.call('reset')).rejects.toMatchObject({ code: 'port-timeout' });
    client.attach(host.port);
    host.ready();
    const retried = client.call('reset');
    await nextTask();
    expect(host.sent[0]).toMatchObject({ type: 'custody/request', operation: 'reset' });
    host.reply({
      type: 'custody/response', requestId: host.sent[0].requestId,
      operationId: host.sent[0].operationId, authorityId: host.authorityId, ok: true,
      result: { reset: true },
    });
    await expect(retried).resolves.toEqual({ reset: true });
  });

  test('serves identity reads and writes only through the attached verified port', async () => {
    const host = makePort();
    const handled: any[] = [];
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {},
      handleSecretRequest: async (
        operation: 'get'|'set'|'self-get'|'self-set', args: any,
      ) => {
        handled.push({ operation, args });
        return operation === 'get' ? { ok: true, value: 'root' } : { ok: true };
      },
      timeoutMs: 100,
    });
    client.attach(host.port);
    host.ready();
    host.reply({
      type: 'custody/secret-request', requestId: 'secret-1', operation: 'get', args: {},
    });
    await nextTask();
    expect(handled).toEqual([{ operation: 'get', args: {} }]);
    expect(host.sent).toContainEqual({
      type: 'custody/secret-response', requestId: 'secret-1', ok: true,
      result: { ok: true, value: 'root' },
    });
  });

  test('a failed boot reset is retryable and concurrent callers share one attempt', async () => {
    let attempts = 0;
    let release = () => {};
    const reset = makeRetryableCustodyReset({
      enabled: true,
      hostAvailable: true,
      reset: async () => {
        attempts++;
        if (attempts === 1) throw new Error('port-timeout');
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    await expect(reset.ensure()).rejects.toThrow('port-timeout');
    const first = reset.ensure();
    const second = reset.ensure();
    await nextTask();
    expect(attempts).toBe(2);
    release();
    await Promise.all([first, second]);
    await reset.ensure();
    expect(attempts).toBe(2);
  });

  test('does not contact the custody host when dweb or the host is unavailable', async () => {
    let attempts = 0;
    const reset = async () => { attempts++; };
    const disabled = makeRetryableCustodyReset({
      enabled: false, hostAvailable: true, reset,
    });
    const hostless = makeRetryableCustodyReset({
      enabled: true, hostAvailable: false, reset,
    });
    await disabled.ensure();
    await hostless.ensure();
    expect(attempts).toBe(0);
  });

  test('retires a timed-out authority and recovers its late receipt without replay', async () => {
    let release = (value: any) => {};
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:stable',
      readState: () => ({ suspensionOwner: null }),
      runOperation: async () => {
        runs += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 10, newRequestId: () => 'request:reset',
      newOperationId: () => 'operation:reset', newStatusId: () => 'receipt:reset',
    });
    const first = makePortPair();
    client.attach(first.client);
    host.attach(first.host);
    const attempted = client.call('reset');
    await expect(attempted).rejects.toMatchObject({
      code: 'operation-timeout', outcomeKnown: false,
    });
    release({ reset: true });
    await nextTask();

    const second = makePortPair();
    client.attach(second.client);
    host.attach(second.host);
    await expect(client.call('reset')).resolves.toEqual({ reset: true });
    expect(runs).toBe(1);
  });

  test('a poisoned predecessor late reply is inert', async () => {
    const first = makePort('authority:old-late');
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({}),
      timeoutMs: 5, newRequestId: () => 'request:late',
    });
    client.attach(first.port);
    first.ready();
    await expect(client.call('reset')).rejects.toMatchObject({
      code: 'operation-timeout', outcomeKnown: false,
    });
    const dispatched = first.sent.find((message) => message.type === 'custody/request');
    first.reply({
      type: 'custody/response', requestId: dispatched.requestId,
      operationId: dispatched.operationId, authorityId: first.authorityId,
      ok: true, result: { reset: true },
    });

    const successor = makePort('authority:new-after-late');
    client.attach(successor.port);
    successor.ready();
    const retried = client.call('reset');
    await nextTask();
    const retryRequest = successor.sent.find((message) => message.type === 'custody/request');
    expect(retryRequest.operationId).toBe(dispatched.operationId);
    successor.reply({
      type: 'custody/response', requestId: retryRequest.requestId,
      operationId: retryRequest.operationId, authorityId: successor.authorityId,
      ok: true, result: { reset: true },
    });
    await expect(retried).resolves.toEqual({ reset: true });
  });

  test('reconciles a landed suspension from host state after host recycle', async () => {
    let release = (value: any) => {};
    let firstRuns = 0;
    const oldHost = makeDwebCustodyHost({
      authorityId: 'authority:old', readState: () => ({ suspensionOwner: null }),
      runOperation: async () => {
        firstRuns += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 10, newRequestId: () => 'request:suspend',
      newStatusId: () => 'receipt:suspend',
    });
    const first = makePortPair();
    client.attach(first.client);
    oldHost.attach(first.host);
    await expect(client.call('suspend', { leaseId: 'lease:one' }))
      .rejects.toMatchObject({ code: 'operation-timeout', outcomeKnown: false });
    release({ suspended: true });
    await nextTask();

    let replacementRuns = 0;
    const replacement = makeDwebCustodyHost({
      authorityId: 'authority:new', readState: () => ({ suspensionOwner: 'lease:one' }),
      runOperation: async () => { replacementRuns += 1; return { suspended: true }; },
    });
    const second = makePortPair();
    client.attach(second.client);
    replacement.attach(second.host);
    await expect(client.call('suspend', { leaseId: 'lease:one' }))
      .resolves.toEqual({ suspended: true });
    expect(firstRuns).toBe(1);
    expect(replacementRuns).toBe(0);
  });

  test('a successor service worker reuses the stable lease receipt', async () => {
    let release = (value: any) => {};
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:survivor', readState: () => ({ suspensionOwner: null }),
      runOperation: async () => {
        runs += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const firstPair = makePortPair();
    const firstClient = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({}), timeoutMs: 5,
    });
    firstClient.attach(firstPair.client);
    // Drop the first response after the host has durably retained its receipt.
    host.attach(firstPair.host);
    await expect(firstClient.call('suspend', { leaseId: 'lease:sw' }))
      .rejects.toMatchObject({ code: 'operation-timeout' });
    release({ suspended: true });
    await nextTask();

    const secondPair = makePortPair();
    const successor = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({}), timeoutMs: 100,
    });
    successor.attach(secondPair.client);
    host.attach(secondPair.host);
    await expect(successor.call('suspend', { leaseId: 'lease:sw' }))
      .resolves.toEqual({ suspended: true });
    expect(runs).toBe(1);
  });

  test('dweb custody remains Preview-only in the native Port inventory', () => {
    expect(coldPortNamesFor()).not.toContain('dweb-custody');
    expect(coldPortNamesFor({ firefox: true })).not.toContain('dweb-custody');
    expect(coldPortNamesFor({ dweb: true })).toContain('dweb-custody');
  });
});
