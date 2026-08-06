import { describe, expect, test } from 'bun:test';
import {
  makeDwebCustodyClient, makeRetryableCustodyReset,
} from '../../extension/background/dweb-custody-client.js';

const makeEvent = () => {
  const listeners: Array<(message?: any) => void> = [];
  return {
    addListener: (listener: (message?: any) => void) => { listeners.push(listener); },
    emit: (message?: any) => { for (const listener of listeners) listener(message); },
  };
};

const makePort = () => {
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
    disconnect: () => onDisconnect.emit(),
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
    const result = client.call('export', { passphrase: 'secret', material: { seed: 'root' } });
    await nextTask();
    expect(host.sent).toEqual([{
      type: 'custody/request', requestId: 'req-1', operation: 'export',
      args: { passphrase: 'secret', material: { seed: 'root' } },
    }]);
    host.reply({ type: 'custody/response', requestId: 'req-1', ok: true, result: { did: 'did:key:zA' } });
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
    await nextTask();
    expect(host.sent[0]).toMatchObject({ operation: 'reset', requestId: 'req-2' });
    host.reply({ type: 'custody/response', requestId: 'req-2', ok: true, result: { reset: true } });
    await expect(result).resolves.toEqual({ reset: true });
  });

  test('rejects in-flight custody work when the exact port disconnects', async () => {
    const host = makePort();
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {}, handleSecretRequest: async () => ({ ok: false }),
      timeoutMs: 100, newRequestId: () => 'req-3',
    });
    client.attach(host.port);
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
    const retried = client.call('reset');
    await nextTask();
    expect(host.sent[0]).toMatchObject({ requestId: 'timed-out', operation: 'reset' });
    host.reply({
      type: 'custody/response', requestId: 'timed-out', ok: true,
      result: { reset: true },
    });
    await expect(retried).resolves.toEqual({ reset: true });
  });

  test('serves identity reads and writes only through the attached verified port', async () => {
    const host = makePort();
    const handled: any[] = [];
    const client = makeDwebCustodyClient({
      ensureOffscreen: async () => {},
      handleSecretRequest: async (operation, args) => {
        handled.push({ operation, args });
        return operation === 'get' ? { ok: true, value: 'root' } : { ok: true };
      },
      timeoutMs: 100,
    });
    client.attach(host.port);
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
});
