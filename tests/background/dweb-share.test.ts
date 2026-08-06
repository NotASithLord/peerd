import { describe, expect, test } from 'bun:test';
import { makeDwebShare } from '../../extension/background/dweb-share.js';

const makeLane = () => {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>) => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
};

describe('identity-bound dweb share', () => {
  test('publish and complete identity metadata persistence stay in the custody lane', async () => {
    const events: string[] = [];
    const lane = makeLane();
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    let publishStarted!: () => void;
    const published = new Promise<void>((resolve) => { publishStarted = resolve; });
    let persisted: any;
    const share = makeDwebShare({
      enabled: true, active: () => true, withIdentityMutation: lane,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async (_id, patch) => { events.push('persist'); persisted = patch; return { id: 'app-1' }; },
      },
      opfsHelpers: () => ({ list: async () => [{ path: '/index.html' }], read: async () => '<h1>App</h1>' }),
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async () => {
        events.push('publish');
        publishStarted();
        await publishGate;
        return { ok: true, uri: 'peerd://bundle', publisher: 'did:key:zOld', hash: 'hash', slug: 'app', dwapp_id: 'dwapp', seq: 7 };
      },
    });

    const sharing = share('app-1', 'app');
    await published;
    const replacing = lane(async () => { events.push('replace'); });
    expect(events).toEqual(['publish']);
    releasePublish();
    await Promise.all([sharing, replacing]);
    expect(events).toEqual(['publish', 'persist', 'replace']);
    expect(persisted).toEqual({
      shared: true,
      dweb: {
        uri: 'peerd://bundle', publisher: 'did:key:zOld', hash: 'hash', version_id: 'hash',
        slug: 'app', dwapp_id: 'dwapp', seq: 7, local: true,
      },
    });
  });

  test('metadata failure rolls back the published share and reports failure', async () => {
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withIdentityMutation: makeLane(),
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => { throw new Error('disk'); },
      },
      opfsHelpers: () => ({ list: async () => [], read: async () => '' }),
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        return message.type.endsWith('unshare-app')
          ? { ok: true }
          : { ok: true, publisher: 'did:key:zOld', hash: 'hash', slug: 'custom-slug' };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({ ok: false, error: 'share-metadata-store-failed' });
    expect(messages.map((message) => message.type)).toEqual([
      'dweb/base-host/share-app', 'dweb/base-host/unshare-app',
    ]);
    expect(messages[1].slug).toBe('custom-slug');
  });

  test('cold runtime preparation completes before the share takes the custody lane', async () => {
    const events: string[] = [];
    const lane = makeLane();
    const share = makeDwebShare({
      enabled: true, active: () => true, withIdentityMutation: lane,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { local: false } }),
        update: async (_id, patch) => { events.push('persist'); return { id: 'app-1', ...patch }; },
      },
      opfsHelpers: () => ({ list: async () => [], read: async () => '' }),
      prepareRuntime: () => lane(async () => { events.push('mint'); return { ok: true }; }),
      sendMessage: async () => {
        events.push('publish');
        return { ok: true, uri: 'peerd://bundle', publisher: 'did:key:zLocal', hash: 'hash', slug: 'app', dwapp_id: 'dwapp', seq: 1 };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({ ok: true });
    expect(events).toEqual(['mint', 'publish', 'persist']);
  });

  test('a concurrent deletion is a persistence failure and rolls back', async () => {
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withIdentityMutation: makeLane(),
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => null,
      },
      opfsHelpers: () => ({ list: async () => [], read: async () => '' }),
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        return message.type.endsWith('unshare-app')
          ? { ok: true }
          : { ok: true, publisher: 'did:key:zOld', hash: 'hash', slug: 'app' };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-metadata-store-failed',
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'dweb/base-host/unshare-app', slug: 'app',
    });
  });
});
