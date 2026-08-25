import { describe, expect, test } from 'bun:test';
import {
  createKernelDenylistPolicy,
  kernelTabOrigin,
} from '../../extension/background/kernel-denylist-policy.js';
import { makeKernelComposerRoutes } from '../../extension/background/kernel-composer-routes.js';

const seed = {
  categories: { sensitive: ['bank.example', '*.health.example'] },
};

describe('lazy native-kernel denylist policy', () => {
  test('construction performs no fetch or storage read', () => {
    let reads = 0;
    let fetches = 0;
    const policy = createKernelDenylistPolicy({
      kv: {
        get: async () => { reads += 1; return null; },
        set: async () => {},
      },
      readSeed: async () => { fetches += 1; return seed; },
    });
    expect(reads).toBe(0);
    expect(fetches).toBe(0);
    expect(policy.isReady()).toBe(false);
    expect(policy.blocks('example.com')).toBe(true);
  });

  test('loads the packaged seed plus user overlay once and applies hostname boundaries', async () => {
    let fetches = 0;
    const policy = createKernelDenylistPolicy({
      kv: {
        get: async () => ({ added: ['private.example'], disabled: ['bank.example'] }),
        set: async () => {},
      },
      readSeed: async () => { fetches += 1; return seed; },
    });
    await expect(Promise.all([policy.ready(), policy.ready()]))
      .resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(policy.isReady()).toBe(true);
    expect(fetches).toBe(1);
    expect(policy.blocks('bank.example')).toBe(false);
    expect(policy.blocks('private.example')).toBe(true);
    expect(policy.blocks('a.health.example')).toBe(true);
    expect(policy.blocks('health.example')).toBe(false);
    expect(policy.blocks('evilhealth.example')).toBe(false);
    await expect(policy.snapshot()).resolves.toEqual({
      ok: true,
      patterns: ['*.health.example', 'private.example'],
      added: ['private.example'],
      disabled: ['bank.example'],
      categories: seed.categories,
    });
  });

  test('malformed or unavailable seed fails closed for every web origin', async () => {
    for (const readSeed of [
      async () => ({}),
      async () => { throw new Error('package missing'); },
    ]) {
      const policy = createKernelDenylistPolicy({
        kv: { get: async () => null, set: async () => {} }, readSeed,
      });
      expect(await policy.ready()).toMatchObject({ ok: false });
      expect(policy.blocks('example.com')).toBe(true);
    }
  });

  test('composer tabs preserve legacy projection while full URLs remain kernel-local', async () => {
    const queried = [{
      id: 1, title: 'Allowed', url: 'https://example.com/private?q=secret', active: true,
    }, {
      id: 2, title: 'Bank', url: 'https://bank.example/account', active: false,
    }, {
      id: 3, title: 'Browser', url: 'chrome://settings/privacy', active: false,
    }];
    const policy = createKernelDenylistPolicy({
      kv: { get: async () => null, set: async () => {} }, readSeed: async () => seed,
    });
    const routes = makeKernelComposerRoutes({
      browser: { tabs: { query: async () => queried } }, denylist: policy,
      kv: { list: async () => ({}) }, idb: { get: async () => null },
      sessionCache: { sessionGet: async () => null }, vault: { isLocked: () => false },
      commands: { list: async () => [] }, appFiles: { list: async () => [] },
    });
    const result = await routes['composer/tabs']();
    expect(result).toEqual({ ok: true, tabs: [
      { id: 1, title: 'Allowed', origin: 'https://example.com', active: true, blocked: false },
      { id: 2, title: 'Bank', origin: 'https://bank.example', active: false, blocked: true },
      { id: 3, title: 'Browser', origin: 'chrome://settings', active: false, blocked: true },
    ] });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('/account');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(kernelTabOrigin('about:config')).toBe('about://config');
    expect(kernelTabOrigin('not a url')).toBe('');
    await expect(routes['denylist/list']()).resolves.toEqual({
      ok: true,
      patterns: ['bank.example', '*.health.example'],
      added: [], disabled: [], categories: seed.categories,
    });
  });

  test('a seed failure leaves tabs visible but non-actionable instead of authorizing them', async () => {
    const policy = createKernelDenylistPolicy({
      kv: { get: async () => null, set: async () => {} },
      readSeed: async () => { throw new Error('seed unavailable'); },
    });
    const routes = makeKernelComposerRoutes({
      browser: { tabs: { query: async () => [{
        id: 1, title: 'Unknown', url: 'https://example.com/', active: true,
      }] } },
      denylist: policy,
      kv: { list: async () => ({}) }, idb: { get: async () => null },
      sessionCache: { sessionGet: async () => null }, vault: { isLocked: () => false },
      commands: { list: async () => [] }, appFiles: { list: async () => [] },
    });
    await expect(routes['composer/tabs']()).resolves.toEqual({ ok: true, tabs: [{
      id: 1, title: 'Unknown', origin: 'https://example.com', active: true, blocked: true,
    }] });
  });
});
