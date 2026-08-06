import { describe, expect, test } from 'bun:test';
import { makeReseedSharedApps } from '../../extension/background/dweb-reseed.js';

const sharedApp = {
  id: 'app-1', name: 'App', entryFile: 'index.html', shared: true,
  dweb: { local: true, slug: 'app', manifest_created: 1, hash: 'hash', seq: 2 },
};

describe('dweb restart reseed', () => {
  test('re-reads inside the App lane and does not resurrect a deleted candidate', async () => {
    const messages: any[] = [];
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => true,
      locked: () => false,
      appRegistry: { list: async () => [sharedApp], get: async () => null },
      withDwebPublication: async (operation) => operation(() => true),
      withAppLifecycle: async (_id, operation) => operation(),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(messages).toEqual([]);
  });

  test('holds the App lifecycle lane through the host publication', async () => {
    const events: string[] = [];
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => true,
      locked: () => false,
      appRegistry: { list: async () => [sharedApp], get: async () => sharedApp },
      withDwebPublication: async (operation) => {
        events.push('enter:dweb');
        const result = await operation(() => true);
        events.push('exit:dweb');
        return result;
      },
      withAppLifecycle: async (id, operation) => {
        events.push(`enter:${id}`);
        const result = await operation();
        events.push(`exit:${id}`);
        return result;
      },
      sendMessage: async (message) => { events.push(message.type); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(events).toEqual([
      'enter:dweb', 'enter:app-1', 'dweb/base-host/share-app', 'exit:app-1', 'exit:dweb',
    ]);
  });

  test('rechecks master state and vault lock after waiting for lifecycle lanes', async () => {
    const messages: any[] = [];
    let active = true;
    let locked = false;
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => active,
      locked: () => locked,
      appRegistry: { list: async () => [sharedApp], get: async () => sharedApp },
      withDwebPublication: async (operation) => {
        active = false;
        locked = true;
        return operation(() => false);
      },
      withAppLifecycle: async (_id, operation) => operation(),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(messages).toEqual([]);
  });
});
