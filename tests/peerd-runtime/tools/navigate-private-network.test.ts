import { describe, expect, test } from 'bun:test';
import { navigateOwnedTabAuthority } from '../../../extension/background/page-authority/navigate.js';
import { HOST_EFFECT_OUTCOME } from '../../../extension/background/host-effect-verdict.js';
import { navigateTool as controllerNavigateTool } from '../../../extension/peerd-runtime/tools/defs/navigate.js';

const navigateTool = { execute: (args: any, ctx: any) => controllerNavigateTool.execute(args, {
  ...ctx, pageAuthority: { navigateOwnedTab: () => navigateOwnedTabAuthority(args, ctx) },
}) };
import { browserProbeResult } from '../../helpers/browser-scripting.ts';

const directRefusalContext = () => {
  const calls = { get: 0, update: 0, adopt: 0, query: 0 };
  const ctx: any = {
    actorType: 'web',
    tabs: {
      get: async () => { calls.get += 1; return { id: 7, url: 'https://example.com' }; },
      update: async () => { calls.update += 1; },
      query: async () => { calls.query += 1; return []; },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    adoptWebTab: async () => { calls.adopt += 1; return { tabId: 7 }; },
  };
  return { calls, ctx };
};

type RedirectHarnessOptions = {
  adopt?: boolean;
  cleanupFails?: boolean;
  denylist?: string[];
  landingUrl?: string;
  landingAction?: 'continue' | 'wait' | 'end';
  releaseFails?: boolean;
};

const redirectContext = ({
  adopt = false,
  cleanupFails = false,
  denylist = [],
  landingUrl = 'http://127.0.0.1/private?q=token#fragment',
  landingAction = 'continue',
  releaseFails = false,
}: RedirectHarnessOptions = {}) => {
  const publicUrl = 'https://example.com/start';
  const privateUrl = landingUrl;
  const pin = { id: 7, url: publicUrl, origin: 'https://example.com' };
  const updates: string[] = [];
  const judged: string[] = [];
  const released: number[] = [];
  let listener: any = null;
  let currentUrl = publicUrl;
  const tabs = {
    onUpdated: {
      addListener: (next: any) => { listener = next; },
      removeListener: () => { listener = null; },
    },
    get: async (tabId: number) => {
      return { id: tabId, url: currentUrl };
    },
    update: async (tabId: number, props: { url: string }) => {
      updates.push(props.url);
      if (props.url === 'about:blank') {
        if (cleanupFails) throw new Error('tab update refused');
        currentUrl = 'about:blank';
      } else {
        currentUrl = privateUrl;
      }
      queueMicrotask(() => {
        listener?.(tabId, { status: 'loading', url: props.url });
        listener?.(tabId, { status: 'complete' });
      });
      return props.url === 'about:blank'
        ? { id: tabId, url: 'about:blank' }
        : { id: tabId, url: currentUrl, pendingUrl: props.url };
    },
  };
  const ctx: any = {
    actorType: 'web',
    denylist,
    ...(adopt ? {} : { activeTab: pin }),
    tabs,
    scripting: {
      executeScript: async (request: any) => browserProbeResult(request, { url: currentUrl }),
    },
    judgeLanding: async (url: string) => {
      judged.push(url);
      return { action: url === landingUrl ? landingAction : 'continue' };
    },
  };
  if (adopt) {
    ctx.adoptWebTab = async () => ({ tabId: 7, windowId: 1 });
    ctx.releaseAdoptedWebTab = async (tabId: number) => {
      released.push(tabId);
      return !releaseFails;
    };
    ctx.repinActiveTab = (next: any) => { ctx.activeTab = next; };
  }
  return { ctx, judged, pin, privateUrl, publicUrl, released, updates };
};

describe('navigate private-network policy', () => {
  test('Stop while the network guard arms prevents tab navigation', async () => {
    let guardStarted!: () => void;
    let releaseGuard!: () => void;
    const started = new Promise<void>((resolve) => { guardStarted = resolve; });
    const wait = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const controller = new AbortController();
    const { ctx, publicUrl, updates } = redirectContext({ landingUrl: 'https://example.com/start' });
    ctx.abortSignal = controller.signal;
    ctx.ensureBrowserNetworkGuard = async () => {
      guardStarted();
      await wait;
      return { ok: true };
    };
    const pending = navigateTool.execute({ url: publicUrl }, ctx);
    await started;
    controller.abort();
    releaseGuard();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'pre-effect-failure',
    });
    expect(updates).toEqual([]);
  });

  test('Stop while the network guard arms releases a newly adopted tab', async () => {
    let guardStarted!: () => void;
    let releaseGuard!: () => void;
    const started = new Promise<void>((resolve) => { guardStarted = resolve; });
    const wait = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const controller = new AbortController();
    const { ctx, publicUrl, released, updates } = redirectContext({
      adopt: true, landingUrl: 'https://example.com/start',
    });
    ctx.abortSignal = controller.signal;
    ctx.ensureBrowserNetworkGuard = async () => {
      guardStarted();
      await wait;
      return { ok: true };
    };
    const pending = navigateTool.execute({ url: publicUrl }, ctx);
    await started;
    controller.abort();
    releaseGuard();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'pre-effect-failure',
    });
    expect(released).toEqual([7]);
    expect(ctx.activeTab).toBeNull();
    expect(updates).toEqual([]);
  });

  test('Stop reports a performed effect when an adopted tab cannot be released', async () => {
    let guardStarted!: () => void;
    let releaseGuard!: () => void;
    const started = new Promise<void>((resolve) => { guardStarted = resolve; });
    const wait = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const controller = new AbortController();
    const { ctx, publicUrl, released, updates } = redirectContext({
      adopt: true, landingUrl: 'https://example.com/start', releaseFails: true,
    });
    ctx.abortSignal = controller.signal;
    ctx.ensureBrowserNetworkGuard = async () => {
      guardStarted();
      await wait;
      return { ok: true };
    };
    const pending = navigateTool.execute({ url: publicUrl }, ctx);
    await started;
    controller.abort();
    releaseGuard();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'effect-completed',
    });
    expect(released).toEqual([7]);
    expect(ctx.activeTab).toMatchObject({ id: 7 });
    expect(updates).toEqual([]);
  });

  test('arms child quarantine before loading the next public HTML', async () => {
    const { ctx, publicUrl, updates } = redirectContext({ landingUrl: 'https://example.com/start' });
    const order: string[] = [];
    ctx.ensureBrowserNetworkGuard = async () => { order.push('guard'); return { ok: true }; };
    ctx.armBrowserChildQuarantine = async () => { order.push('quarantine'); return { ok: true }; };
    const originalUpdate = ctx.tabs.update;
    ctx.tabs.update = async (...args: any[]) => {
      order.push('update');
      return originalUpdate(...args);
    };
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result.ok).toBe(true);
    expect(order.indexOf('quarantine')).toBeGreaterThan(order.indexOf('guard'));
    expect(order.indexOf('quarantine')).toBeLessThan(order.indexOf('update'));
    expect(updates).toEqual([publicUrl]);
  });
  test('a confirmed provider landing returns a stable user-wait result', async () => {
    const landingUrl = 'https://accounts.google.com/signin';
    const { ctx, publicUrl } = redirectContext({ landingUrl, landingAction: 'wait' });
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result).toEqual({
      ok: false,
      error: 'auth_waiting_for_user',
      content: 'Finish signing in in the open tab. peerd is paused and cannot read or act there. When the tab returns to its site, tell peerd to continue.',
      outcomeKind: 'effect-completed',
      endTurn: true,
    });
  });

  test('returns a structured refusal after a redirect onto a sensitive site', async () => {
    const landingUrl = 'https://accounts.example/private?token=secret';
    const { ctx, pin, publicUrl, updates } = redirectContext({
      denylist: ['accounts.example'],
      landingUrl,
    });
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'browser_sensitive_site_blocked',
      outcomeKind: 'effect-completed',
      structured: {
        reason: 'sensitive_site', retryable: false, neutralized: true,
      },
    });
    expect(result.content).toContain('verified blank page');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(pin).toEqual({ id: 7, url: 'about:blank', origin: '' });
    expect(JSON.stringify(result)).not.toContain('accounts.example');
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  test('a direct private target is refused before tab lookup, adoption, or update', async () => {
    const { calls, ctx } = directRefusalContext();
    const result = await navigateTool.execute({
      url: 'http://user:pass@127.0.0.1:8080/secret?q=token#fragment',
    }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected direct target to be refused');
    expect(result.error).toBe('browser_private_network_blocked');
    expect(result.outcomeKind).toBe('pre-effect-failure');
    expect(result.structured).toMatchObject({
      reason: 'private_network', stage: 'pre_navigation', outcome: 'not_run',
    });
    expect(calls).toEqual({ get: 0, update: 0, adopt: 0, query: 0 });
    expect(JSON.stringify(result)).not.toContain('/secret');
    expect(JSON.stringify(result)).not.toContain('user:pass');
    expect(JSON.stringify(result)).not.toContain('q=token');
  });

  test('a direct metadata target is refused with the same no-effect contract', async () => {
    const { calls, ctx } = directRefusalContext();
    const result = await navigateTool.execute({
      url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/secret-role',
    }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected metadata target to be refused');
    expect(result.structured).toMatchObject({ reason: 'cloud_metadata', outcome: 'not_run' });
    expect(result.outcomeKind).toBe('pre-effect-failure');
    expect(calls).toEqual({ get: 0, update: 0, adopt: 0, query: 0 });
    expect(JSON.stringify(result)).not.toContain('secret-role');
  });

  test('a public redirect to private is refused before further page work and reset', async () => {
    const { ctx, judged, privateUrl, publicUrl, updates } = redirectContext({ adopt: true });
    let decorated = 0;
    ctx.noteTab = () => { decorated += 1; };
    ctx.hintPullIn = () => { decorated += 1; };
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected redirect to be refused');
    expect(result.error).toBe('browser_private_network_blocked');
    expect(result.outcomeKind).toBe('effect-completed');
    expect(result.structured).toMatchObject({
      reason: 'private_network',
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
    });
    expect(result.content).toContain('reset to a blank page');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(judged).toEqual([privateUrl]);
    expect(ctx.activeTab).toEqual({ id: 7, windowId: 1, url: 'about:blank', origin: '' });
    expect(decorated).toBe(0);
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('q=token');
  });

  test('a failed reset leaves the pin on the known private landing', async () => {
    const { ctx, pin, privateUrl, publicUrl, updates } = redirectContext({ cleanupFails: true });
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected redirect to be refused');
    expect(result.outcomeKind).toBe('effect-completed');
    expect(result.content).toContain('could not be reset');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(pin).toEqual({ id: 7, url: privateUrl, origin: 'http://127.0.0.1' });
  });

  test('reports a committed effect and resets the tab when origin protection fails', async () => {
    const landingUrl = 'https://public.example/landed';
    const { ctx, pin, publicUrl, updates } = redirectContext({ landingUrl });
    ctx.updateBrowserNetworkGuardOrigin = async () => ({
      ok: false,
      error: 'browser_network_guard_unavailable',
      outcomeKind: 'pre-effect-failure',
      structured: { reason: 'network_guard_install_failed' },
    });
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
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
    expect(result.content).toContain('verified blank page');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(pin).toEqual({ id: 7, url: 'about:blank', origin: '' });
  });

  test('a timed-out navigation still classifies and resets a private landing', async () => {
    const publicUrl = 'https://example.com/start';
    const privateUrl = 'http://127.0.0.1/private';
    const pin = { id: 7, url: publicUrl, origin: 'https://example.com' };
    let listener: any = null;
    let currentUrl = publicUrl;
    const updates: string[] = [];
    const ctx: any = {
      actorType: 'web',
      activeTab: pin,
      navigationTimeoutMs: 5,
      tabs: {
        onUpdated: {
          addListener: (next: any) => { listener = next; },
          removeListener: () => { listener = null; },
        },
        get: async (tabId: number) => ({ id: tabId, url: currentUrl }),
        update: async (tabId: number, props: { url: string }) => {
          updates.push(props.url);
          if (props.url === 'about:blank') {
            currentUrl = 'about:blank';
            queueMicrotask(() => {
              listener?.(tabId, { status: 'loading', url: props.url });
              listener?.(tabId, { status: 'complete' });
            });
            return { id: tabId, url: 'about:blank' };
          }
          currentUrl = privateUrl;
          return { id: tabId, pendingUrl: props.url, url: privateUrl };
        },
      },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, { url: currentUrl }),
      },
    };

    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected private landing refusal');
    expect(result.structured).toMatchObject({
      reason: 'private_network', stage: 'committed_origin',
    });
    expect(result.content).toContain('reset to a blank page');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(pin).toEqual({ id: 7, url: 'about:blank', origin: '' });
  });

  test('an update rejection still classifies and resets a private landing', async () => {
    const publicUrl = 'https://example.com/start';
    const privateUrl = 'http://169.254.169.254/latest/meta-data/';
    const pin = { id: 7, url: publicUrl, origin: 'https://example.com' };
    let listener: any = null;
    let currentUrl = publicUrl;
    const updates: string[] = [];
    const ctx: any = {
      actorType: 'web',
      activeTab: pin,
      navigationTimeoutMs: 10,
      tabs: {
        onUpdated: {
          addListener: (next: any) => { listener = next; },
          removeListener: () => { listener = null; },
        },
        get: async (tabId: number) => ({ id: tabId, url: currentUrl }),
        update: async (tabId: number, props: { url: string }) => {
          updates.push(props.url);
          if (props.url === 'about:blank') {
            currentUrl = 'about:blank';
            queueMicrotask(() => {
              listener?.(tabId, { status: 'loading', url: props.url });
              listener?.(tabId, { status: 'complete' });
            });
            return { id: tabId, url: 'about:blank' };
          }
          currentUrl = privateUrl;
          throw new Error('navigation channel closed');
        },
      },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, { url: currentUrl }),
      },
    };

    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected metadata landing refusal');
    expect(result.structured).toMatchObject({
      reason: 'cloud_metadata', stage: 'committed_origin',
    });
    expect(result.content).toContain('reset to a blank page');
    expect(updates).toEqual([publicUrl, 'about:blank']);
    expect(pin).toEqual({ id: 7, url: 'about:blank', origin: '' });
  });

  test('refuses before tabs.update when the tab-scoped network floor is unavailable', async () => {
    const { ctx, publicUrl, updates } = redirectContext();
    const guarded: Array<[number, string | undefined]> = [];
    ctx.ensureBrowserNetworkGuard = async (tabId: number, targetUrl?: string) => {
      guarded.push([tabId, targetUrl]);
      if (guarded.length === 1) return { ok: true };
      return {
        ok: false,
        error: 'browser_network_guard_unavailable',
        outcomeKind: 'pre-effect-failure',
      };
    };
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result).toMatchObject({
      error: 'browser_network_guard_unavailable',
      outcomeKind: 'pre-effect-failure',
    });
    expect(guarded).toEqual([
      [7, publicUrl],
      [7, publicUrl],
    ]);
    expect(updates).toEqual([]);
  });

  test('records adoption when generic guard startup fails and release is refused', async () => {
    const { ctx, publicUrl, released, updates } = redirectContext({
      adopt: true,
      landingUrl: 'https://example.com/start',
      releaseFails: true,
    });
    ctx.ensureBrowserNetworkGuard = async () => ({
      ok: false,
      code: 'kernel-browser-network-ensure-load-timeout',
      outcomeKnown: true,
      retryable: true,
      phase: 'startup',
    });
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'kernel-browser-network-ensure-load-timeout',
      outcomeKind: 'effect-completed',
      performed: true,
    });
    expect(released).toEqual([7]);
    expect(updates).toEqual([]);
  });

  test('preserves an unknown network-host outcome through the navigation receipt', async () => {
    const { ctx, publicUrl, updates } = redirectContext();
    let calls = 0;
    ctx.ensureBrowserNetworkGuard = async () => {
      calls += 1;
      return calls === 1 ? { ok: true } : {
        ok: false,
        error: 'browser network host timed out',
        code: 'kernel-browser-network-ensure-load-timeout',
        outcomeKnown: false,
        retryable: false,
        phase: 'run',
      };
    };
    const result = await navigateTool.execute({ url: publicUrl }, ctx);
    expect(result).toMatchObject({
      ok: false,
      code: 'kernel-browser-network-ensure-load-timeout',
      outcomeKnown: false,
      retryable: false,
      phase: 'run',
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(result)).toBe('unknown');
    expect(updates).toEqual([]);
  });
});
