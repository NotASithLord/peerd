import { describe, expect, test } from 'bun:test';
import { createBrowserOriginCustody } from '../../extension/background/browser-origin-custody.js';

describe('browser origin custody', () => {
  test('projects guarded HTTP origins to stable canonical domains', async () => {
    const guarded = new Set([7, 8]);
    const custody = createBrowserOriginCustody({ isGuarded: (tabId) => guarded.has(tabId) });

    expect(await custody.retain(7, 'HTTPS://Shop.Example./orders')).toEqual({
      tabId: 7, domain: 'shop.example', added: true,
    });
    expect(await custody.retain(8, 'https://shop.example:8443/other')).toEqual({
      tabId: 8, domain: 'shop.example', added: true,
    });
    expect(custody.domains()).toEqual(['shop.example']);
  });

  test('ignores unguarded tabs and non-web navigation without releasing visited origins', async () => {
    const guarded = new Set([3]);
    const custody = createBrowserOriginCustody({ isGuarded: (tabId) => guarded.has(tabId) });

    expect(await custody.retain(4, 'https://other.example/')).toBeNull();
    await custody.retain(3, 'https://owned.example/');
    expect(await custody.retain(3, 'about:blank')).toBeNull();
    expect(custody.domains()).toEqual(['owned.example']);
  });

  test('ignores URLs rejected by the browser automation target policy', async () => {
    const custody = createBrowserOriginCustody({
      isGuarded: () => true,
      allowUrl: (rawUrl) => !rawUrl.includes('127.0.0.1'),
    });
    await custody.retain(3, 'https://public.example/');
    expect(await custody.retain(3, 'http://127.0.0.1/')).toBeNull();
    expect(custody.domains()).toEqual(['public.example']);
  });

  test('navigation retains visited domains until the owning tab closes', async () => {
    const guarded = new Set([1, 2]);
    const custody = createBrowserOriginCustody({ isGuarded: (tabId) => guarded.has(tabId) });
    await custody.retain(1, 'https://a.example/');
    await custody.retain(2, 'https://a.example/');
    await custody.retain(1, 'https://b.example/');
    expect(custody.domains()).toEqual(['a.example', 'b.example']);
    await custody.close(2);
    expect(custody.domains()).toEqual(['a.example', 'b.example']);
    await custody.close(1);
    expect(custody.domains()).toEqual([]);
  });

  test('rollback removes only a domain newly staged by a failed rule update', async () => {
    const custody = createBrowserOriginCustody({ isGuarded: () => true });
    const first = await custody.retain(1, 'https://stable.example/');
    const repeated = await custody.retain(1, 'https://stable.example/');
    const staged = await custody.retain(1, 'https://new.example/');

    expect(await custody.rollback(repeated)).toBe(false);
    expect(await custody.rollback(staged)).toBe(true);
    expect(custody.domains()).toEqual(['stable.example']);
    expect(await custody.rollback(first)).toBe(true);
    expect(custody.domains()).toEqual([]);
  });

  test('tab authority loss prunes stale rows without a lifecycle callback', async () => {
    const guarded = new Set([9]);
    const custody = createBrowserOriginCustody({ isGuarded: (tabId) => guarded.has(tabId) });
    await custody.retain(9, 'https://stale.example/');
    guarded.delete(9);
    expect(custody.domains()).toEqual([]);
    guarded.add(9);
    expect(custody.domainsForTab(9)).toEqual([]);
  });

  test('persists and restores every visited domain for a live guarded tab', async () => {
    let stored: readonly (readonly [number, readonly string[]])[] = [];
    const first = createBrowserOriginCustody({
      isGuarded: (tabId) => tabId === 5,
      persist: async (rows) => { stored = structuredClone(rows); },
    });
    await first.hydrate([]);
    await first.retain(5, 'https://a.example/');
    await first.retain(5, 'https://b.example/');

    const restored = createBrowserOriginCustody({
      isGuarded: (tabId) => tabId === 5,
      persist: async (rows) => { stored = structuredClone(rows); },
    });
    await restored.hydrate(stored);
    expect(restored.domains()).toEqual(['a.example', 'b.example']);
  });

  test('a failed persistence write rolls back the new domain and rejects', async () => {
    let writes = 0;
    const custody = createBrowserOriginCustody({
      isGuarded: () => true,
      persist: async () => {
        writes += 1;
        if (writes === 1) throw new Error('session storage unavailable');
      },
    });
    await expect(custody.retain(5, 'https://new.example/'))
      .rejects.toThrow('session storage unavailable');
    expect(custody.domains()).toEqual([]);
    expect(writes).toBe(2);
  });

  test('retaining an existing domain does not require another persistence write', async () => {
    let writes = 0;
    const custody = createBrowserOriginCustody({
      isGuarded: () => true,
      persist: async () => { writes += 1; },
    });
    await custody.retain(5, 'https://stable.example/');
    await custody.retain(5, 'https://stable.example/path');
    expect(writes).toBe(1);
  });

  test('a live-navigation write failure keeps volatile custody until persistence recovers', async () => {
    let failing = true;
    let stored: readonly (readonly [number, readonly string[]])[] = [];
    const custody = createBrowserOriginCustody({
      isGuarded: () => true,
      persist: async (rows) => {
        if (failing) throw new Error('session storage unavailable');
        stored = structuredClone(rows);
      },
    });
    await expect(custody.retain(5, 'https://live.example/', {
      keepOnPersistFailure: true,
    })).rejects.toThrow('session storage unavailable');
    expect(custody.domains()).toEqual(['live.example']);
    await expect(custody.retain(5, 'https://live.example/'))
      .rejects.toThrow('session storage unavailable');
    expect(custody.domains()).toEqual(['live.example']);
    failing = false;
    expect(await custody.retain(5, 'https://live.example/')).toEqual({
      tabId: 5, domain: 'live.example', added: false,
    });
    expect(stored).toEqual([[5, ['live.example']]]);
  });

  test('a close before hydration cannot resurrect stale visited domains', async () => {
    let stored: readonly (readonly [number, readonly string[]])[] = [[6, ['old.example']]];
    const custody = createBrowserOriginCustody({
      isGuarded: () => true,
      persist: async (rows) => { stored = structuredClone(rows); },
    });
    await custody.close(6);
    await custody.hydrate(stored);
    expect(custody.domains()).toEqual([]);
    expect(stored).toEqual([]);
  });

  test('a retain racing delayed hydration cannot overwrite older visited domains', async () => {
    let stored: readonly (readonly [number, readonly string[]])[] = [
      [5, ['old-a.example', 'old-b.example']],
    ];
    const custody = createBrowserOriginCustody({
      isGuarded: (tabId) => tabId === 5,
      deferUntilHydrated: true,
      persist: async (rows) => { stored = structuredClone(rows); },
    });
    const pendingRetain = custody.retain(5, 'https://current.example/');
    await Promise.resolve();
    expect(stored).toEqual([[5, ['old-a.example', 'old-b.example']]]);
    await custody.hydrate(stored);
    await pendingRetain;
    expect(custody.domains()).toEqual([
      'current.example', 'old-a.example', 'old-b.example',
    ]);
    expect(stored).toEqual([[
      5, ['current.example', 'old-a.example', 'old-b.example'],
    ]]);
  });

  test('a partial snapshot rejects atomically instead of accepting surviving rows', async () => {
    const custody = createBrowserOriginCustody({ isGuarded: () => true });
    await expect(custody.hydrate([
      [5, ['valid.example']],
      [6] as any,
    ])).rejects.toThrow('browser-origin-custody-snapshot-invalid');
    expect(custody.domains()).toEqual([]);
  });
});
