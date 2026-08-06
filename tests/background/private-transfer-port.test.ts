import { describe, expect, test } from 'bun:test';
import { makePrivateTransferPort } from '../../extension/background/private-transfer-port.js';
import { makePrivateTransferClient } from '../../extension/options/private-transfer-client.js';

const makeEvent = () => {
  const listeners: Array<(message?: any) => void> = [];
  return {
    addListener: (listener: (message?: any) => void) => { listeners.push(listener); },
    emit: (message?: any) => { for (const listener of listeners) listener(message); },
  };
};

const makePortPair = () => {
  const clientMessage = makeEvent();
  const serverMessage = makeEvent();
  const disconnect = makeEvent();
  return {
    client: {
      onMessage: clientMessage, onDisconnect: disconnect,
      postMessage: (message: any) => serverMessage.emit(message),
    } as any,
    server: {
      onMessage: serverMessage, onDisconnect: disconnect,
      postMessage: (message: any) => clientMessage.emit(message),
    } as any,
    disconnect: () => disconnect.emit(),
  };
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('private transfer Port', () => {
  test('carries the password only to the attached handler with an unforgeable capability', async () => {
    const pair = makePortPair();
    const authorization = Symbol('transfer');
    const received: any[] = [];
    const server = makePrivateTransferPort({
      authorization,
      handlers: {
        'transfer/export': async (message) => {
          received.push(message);
          return { ok: true, payload: { version: 2 } };
        },
      },
    });
    server.attach(pair.server);
    const client = makePrivateTransferClient({
      connect: () => pair.client, newRequestId: () => 'request-1', timeoutMs: 100,
    });
    await expect(client.call({ type: 'transfer/export', passphrase: 'private password' }))
      .resolves.toEqual({ ok: true, payload: { version: 2 } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'transfer/export', passphrase: 'private password',
      privateTransferAuthorization: authorization,
    });
  });

  test('ignores non-transfer operations and rejects pending work on disconnect', async () => {
    const pair = makePortPair();
    const server = makePrivateTransferPort({ authorization: Symbol(), handlers: {} });
    server.attach(pair.server);
    const client = makePrivateTransferClient({
      connect: () => pair.client, newRequestId: () => 'request-2', timeoutMs: 100,
    });
    const pending = client.call({ type: 'vault/export', passphrase: 'nope' });
    await nextTask();
    pair.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'port-disconnected' });
  });
});
