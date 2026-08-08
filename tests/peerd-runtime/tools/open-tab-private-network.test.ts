import { describe, expect, test } from 'bun:test';
import { openTabTool } from '../../../extension/peerd-runtime/tools/defs/open-tab.js';

type HarnessOptions = {
  cleanupFails?: boolean;
  complete?: boolean;
  finalUrl?: string;
  guardFails?: boolean;
  withGuard?: boolean;
  denylist?: string[];
};

const openHarness = ({
  cleanupFails = false,
  complete = true,
  finalUrl = 'http://127.0.0.1/private',
  guardFails = false,
  withGuard = false,
  denylist = [],
}: HarnessOptions = {}) => {
  let listener: any = null;
  let currentUrl = 'about:blank';
  const creates: any[] = [];
  const updates: string[] = [];
  const noted: Array<[number | undefined, string | undefined]> = [];
  const hints: Array<[number | undefined, string]> = [];
  const order: string[] = [];
  const removed: number[] = [];
  const released: number[] = [];
  const guarded: Array<[number, string | undefined]> = [];
  const tabs: any = {
    onUpdated: {
      addListener: (next: any) => { listener = next; },
      removeListener: () => { listener = null; },
    },
    create: async (opts: any) => {
      creates.push(opts);
      return { id: 9, url: 'about:blank' };
    },
    get: async () => ({ id: 9, url: currentUrl }),
    remove: async (tabId: number) => { removed.push(tabId); },
    update: async (tabId: number, props: { url: string }) => {
      order.push('update');
      updates.push(props.url);
      if (props.url === 'about:blank') {
        if (cleanupFails) throw new Error('blank reset refused');
        currentUrl = 'about:blank';
      } else {
        currentUrl = finalUrl;
      }
      if (complete || props.url === 'about:blank') {
        queueMicrotask(() => {
          listener?.(tabId, { status: 'loading', url: props.url });
          listener?.(tabId, { status: 'complete' });
        });
      }
      return props.url === 'about:blank'
        ? { id: tabId, url: 'about:blank' }
        : { id: tabId, url: currentUrl, pendingUrl: props.url };
    },
  };
  const ctx: any = {
    tabs,
    denylist,
    navigationTimeoutMs: 5,
    noteTab: async (id: number | undefined, label: string | undefined) => { noted.push([id, label]); },
    hintPullIn: (id: number | undefined, url: string) => { hints.push([id, url]); },
    ...(withGuard ? {
      ensureBrowserNetworkGuard: async (tabId: number) => {
        order.push('guard');
        guarded.push([tabId, undefined]);
        return guardFails
          ? { ok: false, error: 'browser_network_guard_unavailable', outcomeKind: 'pre-effect-failure' }
          : { ok: true };
      },
      releaseBrowserNetworkGuard: async (tabId: number) => {
        order.push('release');
        released.push(tabId);
      },
    } : {}),
  };
  return { creates, ctx, guarded, hints, noted, order, released, removed, updates };
};

describe('open_tab committed target policy', () => {
  test('returns a structured refusal after a redirect onto a sensitive site', async () => {
    const { ctx, updates } = openHarness({
      finalUrl: 'https://accounts.example/private?token=secret',
      denylist: ['accounts.example'],
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'browser_sensitive_site_blocked',
      outcomeKind: 'effect-completed',
      structured: {
        reason: 'sensitive_site', retryable: false, neutralized: true,
      },
    });
    expect(result.content).toContain('verified blank page');
    expect(updates).toEqual(['https://public.example/start', 'about:blank']);
    expect(JSON.stringify(result)).not.toContain('accounts.example');
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  test('opens blank first and neutralizes a public redirect to private', async () => {
    const { creates, ctx, hints, noted, updates } = openHarness();
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected private redirect refusal');
    expect(result.structured).toMatchObject({
      reason: 'private_network',
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
    });
    expect(result.content).toContain('verified blank page');
    expect(creates).toEqual([{ active: false, url: 'about:blank' }]);
    expect(updates).toEqual(['https://public.example/start', 'about:blank']);
    expect(noted).toEqual([]);
    expect(hints).toEqual([]);
  });

  test('reports when a refused new tab cannot be reset', async () => {
    const { ctx, updates } = openHarness({ cleanupFails: true });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected private redirect refusal');
    expect(result.content).toContain('could not be reset');
    expect(updates).toEqual(['https://public.example/start', 'about:blank']);
  });

  test('classifies a private landing even when completion times out', async () => {
    const { ctx, updates } = openHarness({ complete: false });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected private redirect refusal');
    expect(result.structured).toMatchObject({
      reason: 'private_network', stage: 'committed_origin',
    });
    expect(updates).toEqual(['https://public.example/start', 'about:blank']);
  });

  test('announces the verified public landing rather than the requested URL', async () => {
    const finalUrl = 'https://public.example/landed';
    const { ctx, hints, noted, updates } = openHarness({ finalUrl });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected public open');
    expect(updates).toEqual(['https://public.example/start']);
    expect(noted).toEqual([[9, finalUrl]]);
    expect(hints).toEqual([[9, finalUrl]]);
    expect(JSON.parse(result.content ?? '{}')).toEqual({
      tabId: 9,
      url: finalUrl,
      networkGuard: {
        scope: 'tab',
        lifetime: 'until_tab_closed',
        blocks: ['private_network', 'sensitive_site_denylist'],
      },
    });
  });

  test('installs the tab-scoped network floor before starting navigation', async () => {
    const { ctx, guarded, order } = openHarness({
      finalUrl: 'https://public.example/landed',
      withGuard: true,
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['guard', 'update']);
    expect(guarded).toEqual([[9, undefined]]);
  });

  test('keeps an unbound blank tab guarded until browser close cleanup', async () => {
    const { ctx, order, released, updates } = openHarness({ withGuard: true });
    const result = await openTabTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['guard']);
    expect(released).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('closes the blank tab when the network floor cannot be installed', async () => {
    const { ctx, removed, updates } = openHarness({ guardFails: true, withGuard: true });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'browser_network_guard_unavailable',
      outcomeKind: 'pre-effect-failure',
    });
    expect(updates).toEqual([]);
    expect(removed).toEqual([9]);
  });
});
