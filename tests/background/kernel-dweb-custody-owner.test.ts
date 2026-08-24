import { describe, expect, test } from 'bun:test';
import { createKernelDwebCustodyOwner } from '../../extension/background/kernel-port-owners.js';

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

const transfer = {
  exportRecord: async () => null,
  prepareRecord: async () => ({}),
  adoptRecord: async () => ({}),
};
const mutation = async (operation: () => Promise<any>) => operation();

describe('kernel dweb custody owner', () => {
  test('takes the Port synchronously and replays frames after one bounded runtime load', async () => {
    let resolveLoad!: (value: any) => void;
    const loading = new Promise((resolve) => { resolveLoad = resolve; });
    const received: any[] = [];
    const owner = createKernelDwebCustodyOwner({
      enabled: true,
      load: async () => loading as any,
    });
    const live = port();
    expect(owner.attachDwebCustody(live)).toBeUndefined();
    live.onMessage.emit({ type: 'custody/secret-request', requestId: 'queued' });
    resolveLoad({
      dwebTransfer: transfer,
      withIdentityMutation: mutation,
      attachDwebCustody: (owned: any) => {
        owned.onMessage.addListener((message: any) => { received.push(message); });
      },
    });
    await expect(owner.getDwebTransfer()).resolves.toBe(transfer);
    await expect(owner.getDwebLive()).resolves.toMatchObject({
      dwebTransfer: transfer, withIdentityMutation: mutation,
    });
    await Promise.resolve();
    expect(received).toEqual([{ type: 'custody/secret-request', requestId: 'queued' }]);
    expect(live.disconnected).toBe(0);
  });

  test('replacement poisons the prior Port and late load binds only the current generation', async () => {
    let resolveLoad!: (value: any) => void;
    const loading = new Promise((resolve) => { resolveLoad = resolve; });
    const attached: any[] = [];
    const owner = createKernelDwebCustodyOwner({ enabled: true, load: async () => loading as any });
    const first = port(); const second = port();
    owner.attachDwebCustody(first);
    owner.attachDwebCustody(second);
    expect(first.disconnected).toBe(1);
    resolveLoad({
      dwebTransfer: transfer, withIdentityMutation: mutation,
      attachDwebCustody: (value: any) => attached.push(value),
    });
    await owner.getDwebTransfer();
    await Promise.resolve();
    expect(attached).toHaveLength(1);
    expect(attached[0].sender).toBe(second.sender);
  });

  test('disconnects on failed load and refuses disabled or malformed custody', async () => {
    const failed = createKernelDwebCustodyOwner({
      enabled: true, load: async () => { throw new Error('load failed'); },
    });
    const live = port();
    failed.attachDwebCustody(live);
    await expect(failed.getDwebTransfer()).rejects.toThrow();
    await Promise.resolve();
    expect(live.disconnected).toBe(1);

    const disabled = createKernelDwebCustodyOwner({ enabled: false, load: async () => null as any });
    await expect(disabled.getDwebTransfer()).resolves.toBeNull();
    expect(() => disabled.attachDwebCustody(port())).toThrow('kernel-dweb-custody-port-invalid');
    expect(() => createKernelDwebCustodyOwner({ enabled: true } as any))
      .toThrow('kernel-dweb-custody-owner-config-invalid');
  });

  test('bounded queue overflow drops a stalled host', () => {
    const owner = createKernelDwebCustodyOwner({
      enabled: true, load: async () => new Promise(() => {}) as any,
      timeoutMs: 60_000,
    });
    const live = port();
    owner.attachDwebCustody(live);
    for (let index = 0; index < 65; index += 1) live.onMessage.emit({ index });
    expect(live.disconnected).toBe(1);
  });

  test('a frozen runtime times out and releases Port custody', async () => {
    const owner = createKernelDwebCustodyOwner({
      enabled: true, load: async () => new Promise(() => {}) as any, timeoutMs: 2,
    });
    const live = port();
    owner.attachDwebCustody(live);
    await expect(owner.getDwebLive()).rejects.toMatchObject({
      code: 'kernel-dweb-custody-load-timeout', outcomeKnown: true, retryable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(live.disconnected).toBe(1);
  });
});
