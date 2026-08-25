import { describe, expect, test } from 'bun:test';
import { createKernelDwebCustodyOwner } from '../../extension/background/kernel-preview-addon.js';

const event = () => {
  const listeners: Function[] = [];
  return {
    addListener: (listener: Function) => { listeners.push(listener); },
    emit: (value?: any) => { for (const listener of listeners) listener(value); },
  };
};

describe('kernel dweb custody runtime', () => {
  test('one exact client owns secret custody and identity transfer', async () => {
    const secrets = new Map<string, string>([[
      'distributed/identity/v1', JSON.stringify({ seed: 'seed', pub: 'pub' }),
    ]]);
    const sent: any[] = [];
    let featureAcquisitions = 0;
    const runtime = createKernelDwebCustodyOwner({
      enabled: true,
      ensureDwebFeature: async () => { featureAcquisitions += 1; },
      active: () => true,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => secrets.get(name) ?? null,
        setSecret: async (name: string, value: string) => { secrets.set(name, value); },
      },
      auditLog: { append: async () => {} },
      listApps: async () => [],
      newId: (() => { let id = 0; return () => `id-${++id}`; })(),
    });
    const onMessage = event();
    const onDisconnect = event();
    const port = {
      onMessage, onDisconnect,
      disconnect: () => onDisconnect.emit(),
      postMessage: (message: any) => {
        sent.push(message);
        if (message.type === 'custody/request' && message.operation === 'export') {
          queueMicrotask(() => onMessage.emit({
            type: 'custody/response',
            requestId: message.requestId,
            operationId: message.operationId,
            authorityId: 'authority-1',
            ok: true,
            result: { identityRecord: { capsule: 'encrypted' } },
          }));
        }
      },
    };
    runtime.attachDwebCustody(port);
    onMessage.emit({ type: 'custody/ready', authorityId: 'authority-1' });

    await expect((await runtime.getDwebTransfer())!.exportRecord('backup-passphrase')).resolves.toEqual({
      identityRecord: { capsule: 'encrypted' },
    });
    expect(featureAcquisitions).toBe(1);
    expect(sent.some((message) => message.type === 'custody/ack')).toBe(true);

    onMessage.emit({
      type: 'custody/effect-request', requestId: 'secret-request-1',
      operation: 'self/read', args: { name: 'distributed/device-key/v1' },
    });
    for (let attempt = 0; attempt < 20
      && !sent.some((message) => message.type === 'custody/effect-response'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(sent.find((message) => message.type === 'custody/effect-response'))
      .toMatchObject({ ok: true, result: { ok: true } });

    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const live = (await runtime.getDwebLive())!;
    const first = live.withIdentityMutation(async () => {
      order.push('first'); await held;
    });
    const second = live.withIdentityMutation(async () => { order.push('second'); });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  test('refuses disabled or incomplete runtime assembly', () => {
    expect(() => createKernelDwebCustodyOwner({ enabled: true } as any))
      .toThrow('kernel-dweb-custody-owner-config-invalid');
  });
});
