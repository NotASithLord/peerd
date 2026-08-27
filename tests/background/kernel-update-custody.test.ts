import { describe, expect, test } from 'bun:test';
import {
  createKernelUpdateCustody,
  KERNEL_UPDATE_CUSTODY_KEY,
} from '../../extension/background/kernel-preview-addon.js';

const harness = (overrides: Record<string, any> = {}) => {
  const values = new Map<string, any>();
  const calls = {
    reload: 0, checks: 0, notifications: [] as string[], retries: [] as any[], cancelled: 0,
  };
  let busy = overrides.busy ?? false;
  let windows = overrides.windows ?? [];
  let enabled = overrides.enabled ?? true;
  let now = overrides.now ?? 1_000_000;
  let currentVersion = overrides.currentVersion ?? '0.0.0';
  const custody = createKernelUpdateCustody({
    runtime: {
      reload: () => { calls.reload += 1; },
      getManifest: () => ({ version: currentVersion }),
      requestUpdateCheck: async () => { calls.checks += 1; },
    },
    session: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
    },
    ready: async () => {},
    isEnabled: () => enabled,
    isBusy: () => busy,
    listWindowClients: async () => windows,
    isBlockingWindow: (client: any) => client.url !== 'chrome-extension://id/offscreen/offscreen.html',
    notify: (text: string) => { calls.notifications.push(text); return true; },
    now: () => now,
    scheduleRetry: (fn: () => void, delay: number) => {
      const handle = { fn, delay };
      calls.retries.push(handle);
      return handle;
    },
    cancelRetry: () => { calls.cancelled += 1; },
    ...overrides.deps,
  });
  return {
    custody, calls, values,
    setBusy: (value: boolean) => { busy = value; },
    setWindows: (value: any[]) => { windows = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setNow: (value: number) => { now = value; },
    setCurrentVersion: (value: string) => { currentVersion = value; },
  };
};

describe('native preview update custody', () => {
  test('persists before acknowledgement and reloads only after exact quiet state', async () => {
    const h = harness({ busy: true });
    await expect(h.custody.onUpdateAvailable({ version: '1.2.3' })).resolves.toBe(true);
    expect(h.calls.reload).toBe(0);
    expect(h.calls.notifications).toEqual([
      'peerd v1.2.3 is downloaded - it installs when peerd goes quiet or the browser restarts.',
    ]);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('1.2.3');

    h.setBusy(false);
    h.setWindows([{ url: 'chrome-extension://id/home/home.html' }]);
    await h.custody.onQuiet();
    expect(h.calls.reload).toBe(0);
    expect(h.calls.notifications).toHaveLength(1);

    h.setWindows([{ url: 'chrome-extension://id/offscreen/offscreen.html' }]);
    await h.custody.onQuiet();
    expect(h.calls.reload).toBe(1);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('1.2.3');
    expect(h.calls.cancelled).toBe(1);
    h.setCurrentVersion('1.2.3');
    await h.custody.start();
    expect(h.calls.reload).toBe(1);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBeNull();
  });

  test('rechecks work after the asynchronous window oracle before reload', async () => {
    let resolveWindows!: (value: any[]) => void;
    const windowGate = new Promise<any[]>((resolve) => { resolveWindows = resolve; });
    let busy = false;
    const h = harness({
      deps: {
        isBusy: () => busy,
        listWindowClients: () => windowGate,
      },
    });
    const capture = h.custody.onUpdateAvailable({ version: '2.0.0' });
    busy = true;
    resolveWindows([]);
    await capture;
    expect(h.calls.reload).toBe(0);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('2.0.0');
  });

  test('captures before readiness but cannot reload a surviving realm before reconciliation', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const h = harness({ deps: { ready: () => ready } });
    const capture = h.custody.onUpdateAvailable({ version: '2.1.0' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('2.1.0');
    expect(h.calls.reload).toBe(0);
    h.setBusy(true);
    releaseReady();
    await capture;
    expect(h.calls.reload).toBe(0);
    expect(h.calls.retries).toHaveLength(1);
  });

  test('a failed durable write rejects the handler and cannot reload', async () => {
    const h = harness({
      deps: {
        session: {
          get: async () => null,
          set: async () => { throw new Error('session write lost'); },
        },
      },
    });
    await expect(h.custody.onUpdateAvailable({ version: '3.0.0' }))
      .rejects.toThrow('session write lost');
    expect(h.calls.reload).toBe(0);
  });

  test('recovery replays only bounded update evidence and keeps the newest version', async () => {
    const h = harness({ busy: true });
    await h.custody.recover({ entries: [
      { event: 'runtime.onUpdateAvailable', payload: { version: '4.1.0' } },
      { event: 'tabs.onUpdated', payload: { version: '99.0.0' } },
      { event: 'runtime.onUpdateAvailable', payload: { version: '4.2.0' } },
      { event: 'runtime.onUpdateAvailable', payload: { version: '<script>' } },
    ] });
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('4.2.0');
    expect(h.calls.reload).toBe(0);
  });

  test('a stale receipt for the already-installed build clears without a reload loop', async () => {
    const h = harness({ currentVersion: '6.0.0' });
    await h.custody.recover({ entries: [
      { event: 'runtime.onUpdateAvailable', payload: { version: '6.0.0' } },
    ] });
    expect(h.calls.reload).toBe(0);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBeNull();
  });

  test('compares large numeric version segments without Number precision loss', async () => {
    const h = harness({ currentVersion: '7.9007199254740992' });
    await h.custody.onUpdateAvailable({ version: '7.9007199254740993' });
    expect(h.calls.reload).toBe(1);
  });

  test('checkNow is enabled, coalesced, and starts its throttle only after success', async () => {
    const h = harness();
    await Promise.all([h.custody.checkNow(), h.custody.checkNow()]);
    expect(h.calls.checks).toBe(1);
    await h.custody.checkNow();
    expect(h.calls.checks).toBe(1);
    h.setNow(1_000_000 + 6 * 60 * 60 * 1000);
    await h.custody.checkNow();
    expect(h.calls.checks).toBe(2);
    h.setEnabled(false);
    h.setNow(99_000_000);
    await h.custody.checkNow();
    expect(h.calls.checks).toBe(2);
  });

  test('invalid browser details settle as ignored and never create state', async () => {
    const h = harness();
    await expect(h.custody.onUpdateAvailable({ version: '../bad' })).resolves.toBe(false);
    expect(h.values.has(KERNEL_UPDATE_CUSTODY_KEY)).toBe(false);
    expect(h.calls.reload).toBe(0);
  });

  test('fails closed when the window oracle is unavailable and retries boundedly', async () => {
    const h = harness({
      deps: { listWindowClients: async () => { throw new Error('clients unavailable'); } },
    });
    await h.custody.onUpdateAvailable({ version: '5.0.0' });
    expect(h.calls.reload).toBe(0);
    expect(h.calls.retries).toHaveLength(1);
    expect((h.values.get(KERNEL_UPDATE_CUSTODY_KEY) as any).pendingVersion).toBe('5.0.0');
  });

  test('a hung window oracle cannot pin later update application', async () => {
    let calls = 0;
    const h = harness({
      deps: {
        operationTimeoutMs: 5,
        listWindowClients: async () => ++calls === 1 ? new Promise(() => {}) : [],
      },
    });
    await expect(h.custody.onUpdateAvailable({ version: '5.1.0' })).resolves.toBe(true);
    expect(h.calls.reload).toBe(0);
    await expect(h.custody.onQuiet()).resolves.toBe(true);
    expect({ calls, reloads: h.calls.reload }).toEqual({ calls: 2, reloads: 1 });
  });

  test('a hung update check cannot pin a later check', async () => {
    let checks = 0;
    const h = harness({
      deps: {
        operationTimeoutMs: 5,
        runtime: {
          reload: () => {},
          getManifest: () => ({ version: '0.0.0' }),
          requestUpdateCheck: async () => {
            checks += 1;
            return checks === 1 ? new Promise(() => {}) : undefined;
          },
        },
      },
    });
    await expect(h.custody.checkNow()).resolves.toBe(false);
    await expect(h.custody.checkNow()).resolves.toBe(true);
    expect(checks).toBe(2);
  });

  test('keeps one capped quiet retry alive until a downloaded update can apply', async () => {
    const h = harness();
    h.setBusy(true);
    await h.custody.onUpdateAvailable({ version: '8.0.0' });
    expect(h.calls.retries).toHaveLength(1);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const retry = h.calls.retries.shift();
      expect(retry).toBeDefined();
      retry?.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.calls.retries).toHaveLength(1);
      expect(h.calls.retries[0].delay).toBeLessThanOrEqual(120_000);
    }

    h.setBusy(false);
    await h.custody.onQuiet();
    expect(h.calls.reload).toBe(1);
    expect(h.calls.retries).toHaveLength(1);
    expect(h.calls.cancelled).toBe(1);
  });
});
