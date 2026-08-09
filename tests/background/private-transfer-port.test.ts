import { describe, expect, test } from 'bun:test';
import {
  makePrivateTransferOpenRoute, makePrivateTransferPort,
} from '../../extension/background/private-transfer-port.js';
import { makePrivateTransferClient } from '../../extension/options/private-transfer-client.js';

describe('private transfer MessageChannel', () => {
  test('offers a channel only to the exact requesting options WindowClient', async () => {
    const offers: any[] = [];
    let attached = 0;
    const route = makePrivateTransferOpenRoute({
      isOptionsSender: (sender: any) => sender?.url === 'chrome-extension://id/options/options.html',
      optionsUrl: 'chrome-extension://id/options/options.html',
      attach: () => { attached += 1; },
      listWindowClients: async () => [
        {
          id: 'options-document', url: 'chrome-extension://id/options/options.html#!/transfer',
          postMessage: (message, transfer) => offers.push({ message, transfer }),
        },
        {
          id: 'engine-document', url: 'chrome-extension://id/engine-tabs/app-tab/index.html',
          postMessage: () => { throw new Error('engine must not receive a channel'); },
        },
      ],
    });
    await expect(route(
      { requestId: 'offer-1' },
      { url: 'chrome-extension://id/options/options.html', documentId: 'options-document' },
    )).resolves.toEqual({ ok: true });
    expect(attached).toBe(1);
    expect(offers).toHaveLength(1);
    expect(offers[0].message).toMatchObject({
      type: 'private-transfer/channel', requestId: 'offer-1',
    });
    expect(offers[0].transfer).toHaveLength(1);

    await expect(route(
      { requestId: 'forged' },
      { url: 'chrome-extension://id/engine-tabs/app-tab/index.html', documentId: 'engine-document' },
    )).resolves.toEqual({ ok: false, error: 'private-transfer-channel-refused' });
    expect(attached).toBe(1);
  });

  test('refuses an ambiguous or query-bearing options WindowClient', async () => {
    const route = makePrivateTransferOpenRoute({
      isOptionsSender: () => true,
      optionsUrl: 'chrome-extension://id/options/options.html',
      attach: () => { throw new Error('must not attach'); },
      listWindowClients: async () => [
        { url: 'chrome-extension://id/options/options.html#!/transfer', postMessage: () => {} },
        { url: 'chrome-extension://id/options/options.html#!/security', postMessage: () => {} },
        { url: 'chrome-extension://id/options/options.html?forged=1', postMessage: () => {} },
      ],
    });
    await expect(route({ requestId: 'ambiguous' }, {
      url: 'chrome-extension://id/options/options.html', documentId: 'undocumented-id',
    })).resolves.toEqual({ ok: false, error: 'private-transfer-channel-target-missing' });
  });

  test('carries the password only to the attached handler with an unforgeable capability', async () => {
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
    let client: ReturnType<typeof makePrivateTransferClient>;
    client = makePrivateTransferClient({
      requestChannel: (requestId) => {
        const channel = new MessageChannel();
        server.attach(channel.port1);
        client.acceptChannel(requestId, channel.port2);
      },
      newRequestId: (() => { let sequence = 0; return () => `request-${++sequence}`; })(),
      timeoutMs: 100,
    });
    await expect(client.call({ type: 'transfer/export', passphrase: 'private password' }))
      .resolves.toEqual({ ok: true, payload: { version: 2 } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'transfer/export', passphrase: 'private password',
      privateTransferAuthorization: authorization,
    });
  });

  test('uses a fresh channel for the next completed operation', async () => {
    let offers = 0;
    const server = makePrivateTransferPort({
      authorization: Symbol('transfer'),
      handlers: { 'transfer/export': async () => ({ ok: true }) },
    });
    let client: ReturnType<typeof makePrivateTransferClient>;
    client = makePrivateTransferClient({
      requestChannel: (requestId) => {
        offers += 1;
        const channel = new MessageChannel();
        server.attach(channel.port1);
        client.acceptChannel(requestId, channel.port2);
      },
      timeoutMs: 100,
    });
    await expect(client.call({ type: 'transfer/export' })).resolves.toEqual({ ok: true });
    await expect(client.call({ type: 'transfer/export' })).resolves.toEqual({ ok: true });
    expect(offers).toBe(2);
  });

  test('ignores non-transfer operations and resets the channel after timeout', async () => {
    const server = makePrivateTransferPort({ authorization: Symbol(), handlers: {} });
    let offers = 0;
    let client: ReturnType<typeof makePrivateTransferClient>;
    client = makePrivateTransferClient({
      requestChannel: (requestId) => {
        offers += 1;
        const channel = new MessageChannel();
        server.attach(channel.port1);
        client.acceptChannel(requestId, channel.port2);
      },
      newRequestId: (() => { let sequence = 0; return () => `timeout-${++sequence}`; })(),
      timeoutMs: 5,
    });
    await expect(client.call({ type: 'vault/export', passphrase: 'nope' }))
      .rejects.toMatchObject({ code: 'timeout' });
    await expect(client.call({ type: 'vault/export', passphrase: 'nope' }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(offers).toBe(2);
  });

  test('fails an open-route refusal immediately instead of waiting for timeout', async () => {
    const client = makePrivateTransferClient({
      requestChannel: async () => { throw new Error('private-transfer-channel-target-missing'); },
      timeoutMs: 1_000,
    });
    const started = Date.now();
    await expect(client.call({ type: 'transfer/export' }))
      .rejects.toMatchObject({ code: 'channel-request-failed' });
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('drops a dead channel after postMessage throws and reconnects', async () => {
    let offers = 0;
    let client: ReturnType<typeof makePrivateTransferClient>;
    client = makePrivateTransferClient({
      requestChannel: (requestId) => {
        offers += 1;
        const fakePort: any = {
          onmessage: null, onmessageerror: null,
          start() {
            queueMicrotask(() => this.onmessage?.({ data: { type: 'private-transfer/ready' } }));
          },
          addEventListener: () => {}, close: () => {},
          postMessage: () => { throw new Error('closed'); },
        };
        client.acceptChannel(requestId, fakePort);
      },
      timeoutMs: 100,
    });
    await expect(client.call({ type: 'transfer/export' }))
      .rejects.toMatchObject({ code: 'post-failed' });
    await expect(client.call({ type: 'transfer/export' }))
      .rejects.toMatchObject({ code: 'post-failed' });
    expect(offers).toBe(2);
  });

  test('supports the Firefox exact-options runtime Port fallback', async () => {
    const listeners: Array<(message: any) => void> = [];
    const disconnects: Array<() => void> = [];
    const server = makePrivateTransferPort({
      authorization: Symbol('firefox-transfer'),
      handlers: { 'transfer/export': async () => ({ ok: true, browser: 'firefox' }) },
    });
    const runtimePort: any = {
      onMessage: { addListener: (listener: (message: any) => void) => listeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
      postMessage(message: any) {
        if (message.type === 'private-transfer/request') serverPort.onMessage.emit(message);
        else for (const listener of listeners) listener(message);
      },
      disconnect() { for (const listener of disconnects) listener(); },
    };
    const serverPort: any = {
      onMessage: { listener: null as null | ((message: any) => void), addListener(listener: (message: any) => void) { this.listener = listener; }, emit(message: any) { this.listener?.(message); } },
      onDisconnect: { addListener: () => {} },
      postMessage: (message: any) => runtimePort.postMessage(message),
    };
    server.attach(serverPort);
    const client = makePrivateTransferClient({ connect: () => runtimePort, timeoutMs: 100 });
    await expect(client.call({ type: 'transfer/export', passphrase: 'secret' }))
      .resolves.toEqual({ ok: true, browser: 'firefox' });
  });
});
