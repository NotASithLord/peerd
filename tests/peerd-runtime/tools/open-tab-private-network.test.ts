import { describe, expect, test } from 'bun:test';
import { openProtectedBackgroundTabAuthority } from '../../../extension/background/page-authority/open-tab.js';
import { HOST_EFFECT_OUTCOME } from '../../../extension/background/host-effect-verdict.js';
import { openTabTool as controllerOpenTabTool } from '../../../extension/peerd-runtime/tools/defs/open-tab.js';

const fencedJson = (content: string) => JSON.parse(
  content.slice(content.indexOf('\n') + 1, content.lastIndexOf('\n</untrusted_web_content>')),
);

const openTabTool = { execute: (args: any, ctx: any) => controllerOpenTabTool.execute(args, {
  ...ctx,
  pageAuthority: {
    openProtectedBackgroundTab: () => openProtectedBackgroundTabAuthority(args, ctx),
  },
}) };

type HarnessOptions = {
  cleanupFails?: boolean;
  complete?: boolean;
  finalUrl?: string;
  guardFails?: boolean;
  originGuardFails?: boolean;
  withGuard?: boolean;
  withQuarantine?: boolean;
  denylist?: string[];
};

const openHarness = ({
  cleanupFails = false,
  complete = true,
  finalUrl = 'http://127.0.0.1/private',
  guardFails = false,
  originGuardFails = false,
  withGuard = false,
  withQuarantine = false,
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
  const reconciled: Array<[number, string | undefined]> = [];
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
      ensureBrowserNetworkGuard: async (tabId: number, targetUrl?: string) => {
        order.push('guard');
        guarded.push([tabId, targetUrl]);
        return guardFails
          ? { ok: false, error: 'browser_network_guard_unavailable', outcomeKind: 'pre-effect-failure' }
          : { ok: true };
      },
      updateBrowserNetworkGuardOrigin: async (tabId: number, targetUrl?: string) => {
        order.push('origin');
        reconciled.push([tabId, targetUrl]);
        return originGuardFails
          ? {
            ok: false,
            error: 'browser_network_guard_unavailable',
            outcomeKind: 'pre-effect-failure',
            structured: { reason: 'network_guard_install_failed' },
          }
          : { ok: true };
      },
      releaseBrowserNetworkGuard: async (tabId: number) => {
        order.push('release');
        released.push(tabId);
      },
    } : {}),
    ...(withQuarantine ? {
      armBrowserChildQuarantine: async () => {
        order.push('quarantine');
        return { ok: true };
      },
    } : {}),
  };
  return { creates, ctx, guarded, hints, noted, order, reconciled, released, removed, updates };
};

describe('open_tab committed target policy', () => {
  test('arms child quarantine before loading the initial public HTML', async () => {
    const { ctx, order } = openHarness({
      finalUrl: 'https://public.example/start', withGuard: true, withQuarantine: true,
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(true);
    expect(order.indexOf('quarantine')).toBeGreaterThan(order.indexOf('guard'));
    expect(order.indexOf('quarantine')).toBeLessThan(order.indexOf('update'));
  });
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

  test('refuses an unverified committed URL before origin reconciliation', async () => {
    const { ctx, reconciled, updates } = openHarness({
      finalUrl: 'https://public.example/landed',
      withGuard: true,
    });
    const originalGet = ctx.tabs.get;
    let reads = 0;
    ctx.tabs.get = async () => {
      reads += 1;
      return reads === 1 ? { id: 9 } : originalGet();
    };
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      outcomeKind: 'effect-completed',
      structured: { stage: 'committed_origin', neutralized: true },
    });
    expect(reconciled).toEqual([]);
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
    expect(fencedJson(result.content ?? '')).toEqual({
      tabId: 9,
      url: finalUrl,
      networkGuard: {
        scope: 'tab_and_visited_origin_workers',
        lifetime: 'until_tab_closed',
        blocks: ['private_network', 'sensitive_site_denylist'],
        workerScope: 'private_network_fetch',
        chromeWorkerWebSocket: 'not_covered_by_dnr',
      },
    });
  });

  test('Stop while the network guard arms closes the new tab before navigation', async () => {
    let guardStarted!: () => void;
    let releaseGuard!: () => void;
    const started = new Promise<void>((resolve) => { guardStarted = resolve; });
    const wait = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const controller = new AbortController();
    const { ctx, removed, updates } = openHarness();
    ctx.abortSignal = controller.signal;
    ctx.ensureBrowserNetworkGuard = async () => {
      guardStarted();
      await wait;
      return { ok: true };
    };
    const pending = openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    await started;
    controller.abort();
    releaseGuard();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'pre-effect-failure',
    });
    expect(updates).toEqual([]);
    expect(removed).toEqual([9]);
  });

  test('Stop reports a performed effect when the new tab cannot be closed', async () => {
    let guardStarted!: () => void;
    let releaseGuard!: () => void;
    const started = new Promise<void>((resolve) => { guardStarted = resolve; });
    const wait = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const controller = new AbortController();
    const { ctx, updates } = openHarness();
    ctx.abortSignal = controller.signal;
    ctx.tabs.remove = async () => { throw new Error('tab close refused'); };
    ctx.ensureBrowserNetworkGuard = async () => {
      guardStarted();
      await wait;
      return { ok: true };
    };
    const pending = openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    await started;
    controller.abort();
    releaseGuard();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'effect-completed',
    });
    expect(updates).toEqual([]);
  });

  test('installs the tab-scoped network floor before starting navigation', async () => {
    const { ctx, guarded, order, reconciled } = openHarness({
      finalUrl: 'https://public.example/landed',
      withGuard: true,
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['guard', 'update', 'origin']);
    expect(guarded).toEqual([[9, 'https://public.example/start']]);
    expect(reconciled).toEqual([[9, 'https://public.example/landed']]);
  });

  test('keeps an unbound blank tab guarded until browser close cleanup', async () => {
    const { ctx, order, released, updates } = openHarness({ withGuard: true });
    const result = await openTabTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['guard']);
    expect(released).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('reports a committed effect and closes the tab when origin protection fails', async () => {
    const { ctx, noted, hints, removed, updates } = openHarness({
      finalUrl: 'https://public.example/landed',
      originGuardFails: true,
      withGuard: true,
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'browser_network_guard_unavailable',
      outcomeKind: 'effect-completed',
      structured: {
        reason: 'network_guard_install_failed',
        stage: 'committed_origin',
        outcome: 'page_loaded_not_automated',
        neutralized: true,
      },
    });
    expect(result.content).toContain('The new tab was closed.');
    expect(updates).toEqual(['https://public.example/start']);
    expect(removed).toEqual([9]);
    expect(noted).toEqual([]);
    expect(hints).toEqual([]);
  });

  test('does not claim cleanup when the committed tab cannot be closed', async () => {
    const { ctx, removed } = openHarness({
      finalUrl: 'https://public.example/landed',
      originGuardFails: true,
      withGuard: true,
    });
    ctx.tabs.remove = async () => { throw new Error('tab close refused'); };
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      outcomeKind: 'effect-completed',
      structured: { neutralized: false },
    });
    expect(result.content).toContain('could not be closed');
    expect(removed).toEqual([]);
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

  test('records tab creation when generic guard startup fails and close is refused', async () => {
    const { ctx, updates } = openHarness({ withGuard: true });
    ctx.ensureBrowserNetworkGuard = async () => ({
      ok: false,
      code: 'kernel-browser-network-ensure-load-timeout',
      outcomeKnown: true,
      retryable: true,
      phase: 'startup',
    });
    ctx.tabs.remove = async () => { throw new Error('tab close refused'); };
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'kernel-browser-network-ensure-load-timeout',
      outcomeKind: 'effect-completed',
      performed: true,
    });
    expect(updates).toEqual([]);
  });

  test('preserves an unknown network-host outcome through the open-tab receipt', async () => {
    const { ctx, removed, updates } = openHarness({ withGuard: true });
    ctx.ensureBrowserNetworkGuard = async () => ({
      ok: false,
      error: 'browser network host timed out',
      code: 'kernel-browser-network-ensure-load-timeout',
      outcomeKnown: false,
      retryable: false,
      phase: 'run',
    });
    const result = await openTabTool.execute({ url: 'https://public.example/start' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      code: 'kernel-browser-network-ensure-load-timeout',
      outcomeKnown: false,
      retryable: false,
      phase: 'run',
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(result)).toBe('unknown');
    expect(updates).toEqual([]);
    expect(removed).toEqual([9]);
  });
});
