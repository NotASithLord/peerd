import { describe, expect, test } from 'bun:test';
import { createKernelBrowserEventOwners } from '../../extension/background/kernel-tab-events.js';
import { attachKernelLifecycleEvents } from '../../extension/background/kernel-lifecycle-events.js';
import { attachKernelTabEvents } from '../../extension/background/kernel-tab-events.js';
import { createKernelColdReceipts } from '../../extension/background/kernel-cold-receipts.js';

const rawEvent = () => {
  const listeners: Array<(...args: any[]) => any> = [];
  return {
    listeners,
    registrations: [] as any[],
    addListener(listener: (...args: any[]) => any, ...options: any[]) {
      listeners.push(listener);
      this.registrations.push([listener, ...options]);
    },
    emit(...args: any[]) { return listeners.map((listener) => listener(...args)); },
  };
};

const makeBrowser = () => ({
  runtime: { onStartup: rawEvent() },
  alarms: { onAlarm: rawEvent() },
  tabs: {
    onCreated: rawEvent(), onUpdated: rawEvent(), onRemoved: rawEvent(),
    onActivated: rawEvent(),
  },
  webNavigation: { onCreatedNavigationTarget: rawEvent() },
  webRequest: { onBeforeRequest: rawEvent() },
});

const identity = (suffix: string) => ({
  schema: 1 as const,
  buildId: `browser-owner:${suffix}`,
  bootId: `boot-${suffix}`,
  kernelEpoch: `epoch-${suffix}`,
});

const memoryStore = () => {
  let value: any;
  return {
    get: async () => value == null ? value : structuredClone(value),
    set: async (_key: string, next: any) => { value = structuredClone(next); },
  };
};

const recoveryRegistry = () => ({ registerRecovery: () => {} });

const makeCustody = (calls: any[], overrides: Record<string, any> = {}) => ({
  onCreated: (...args: any[]) => calls.push(['created', ...args]),
  onUpdated: (...args: any[]) => calls.push(['updated', ...args]),
  onRemoved: (...args: any[]) => calls.push(['removed', ...args]),
  onActivated: (...args: any[]) => calls.push(['activated', ...args]),
  onNavigationTarget: (...args: any[]) => calls.push(['navigation', ...args]),
  onBeforeRequest: () => ({}),
  reconcile: () => { calls.push(['reconcile']); },
  ...overrides,
});

describe('production kernel browser event owners', () => {
  test('keeps live browser identity and coalesces startup/alarm work behind readiness', async () => {
    const browser = makeBrowser();
    const calls: any[] = [];
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    let releaseSchedules!: () => void;
    const schedulesHeld = new Promise<void>((resolve) => { releaseSchedules = resolve; });
    const owners = createKernelBrowserEventOwners({
      ready,
      resumeSchedules: async () => {
        calls.push(['schedules']);
        await schedulesHeld;
      },
      tabCustody: makeCustody(calls),
      receipts: recoveryRegistry(),
    });
    const registry = {
      event: (_key: string, event: any) => event,
    };
    attachKernelLifecycleEvents({
      browser, registry,
      onStartup: owners.lifecycle.onStartup,
      alarmName: 'peerd-schedule',
      onAlarm: owners.lifecycle.onAlarm,
    });
    attachKernelTabEvents({
      browser, registry,
      onCreated: owners.tabs.onCreated,
      onUpdated: owners.tabs.onUpdated,
      onRemoved: owners.tabs.onRemoved,
      onActivated: owners.tabs.onActivated,
      onNavigationTarget: owners.tabs.onNavigationTarget,
    });

    const tab = { id: 7, pendingUrl: 'https://live.example/private' };
    browser.tabs.onCreated.emit(tab);
    expect(calls).toEqual([['created', tab]]);
    const wakes = [
      ...browser.runtime.onStartup.emit(),
      ...browser.alarms.onAlarm.emit({ name: 'peerd-schedule' }),
    ];
    await Promise.resolve();
    expect(calls).toEqual([['created', tab]]);
    releaseReady();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter(([name]) => name === 'schedules')).toHaveLength(1);
    releaseSchedules();
    await Promise.all(wakes);
  });

  test('recovery re-reads current state and never receives stored event arguments', async () => {
    const browser = makeBrowser();
    const calls: any[] = [];
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('recovery'),
    });
    const owners = createKernelBrowserEventOwners({
      ready: Promise.resolve(),
      resumeSchedules: () => { calls.push(['schedules']); },
      tabCustody: makeCustody(calls, {
        onUpdated: () => new Promise(() => {}),
        reconcile: (...args: any[]) => { calls.push(['reconcile', ...args]); },
      }),
      receipts,
    });
    attachKernelLifecycleEvents({
      browser, registry: receipts,
      onStartup: owners.lifecycle.onStartup,
      alarmName: 'peerd-schedule', onAlarm: owners.lifecycle.onAlarm,
    });
    attachKernelTabEvents({
      browser, registry: receipts,
      onCreated: owners.tabs.onCreated,
      onUpdated: owners.tabs.onUpdated,
      onRemoved: owners.tabs.onRemoved,
      onActivated: owners.tabs.onActivated,
      onNavigationTarget: owners.tabs.onNavigationTarget,
    });
    browser.tabs.onUpdated.emit(4, {
      status: 'loading', url: 'https://must-not-replay.example/secret',
    }, { id: 4 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await receipts.snapshot()).entries.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await receipts.recover();
    expect(calls).toEqual([['reconcile']]);
    expect(JSON.stringify(calls)).not.toContain('must-not-replay');
  });

  test('Firefox request authority preserves and validates blocking promises', async () => {
    for (const result of [
      () => { throw new Error('guard unavailable'); },
      () => null,
      () => ({ redirectUrl: 'https://unsafe.example/' }),
    ]) {
      const owners = createKernelBrowserEventOwners({
        ready: Promise.resolve(), firefox: true,
        resumeSchedules: () => {},
        tabCustody: makeCustody([], { onBeforeRequest: result }),
        receipts: recoveryRegistry(),
      });
      expect(owners.tabs.onBeforeRequest?.({
        tabId: 1, url: 'http://127.0.0.1/',
      })).toEqual({ cancel: true });
    }
    for (const [result, expected] of [
      [() => Promise.resolve({}), {}],
      [() => Promise.resolve({ redirectUrl: 'https://unsafe.example/' }), { cancel: true }],
      [() => Promise.reject(new Error('guard unavailable')), { cancel: true }],
    ] as const) {
      const owners = createKernelBrowserEventOwners({
        ready: Promise.resolve(), firefox: true,
        resumeSchedules: () => {},
        tabCustody: makeCustody([], { onBeforeRequest: result }),
        receipts: recoveryRegistry(),
      });
      const decision = owners.tabs.onBeforeRequest?.({
        tabId: 1, url: 'https://example.com/',
      });
      expect(decision).toBeInstanceOf(Promise);
      await expect(decision).resolves.toEqual(expected);
    }
    const owners = createKernelBrowserEventOwners({
      ready: Promise.resolve(), firefox: true,
      resumeSchedules: () => {},
      tabCustody: makeCustody([], { onBeforeRequest: () => ({}) }),
      receipts: recoveryRegistry(),
    });
    expect(owners.tabs.onBeforeRequest?.({ tabId: 1, url: 'https://example.com/' }))
      .toEqual({});
  });

  test('refuses incomplete custody before any readiness can be claimed', () => {
    expect(() => createKernelBrowserEventOwners({
      ready: Promise.resolve(), resumeSchedules: () => {},
      tabCustody: { reconcile: () => {} } as any,
      receipts: recoveryRegistry(),
    })).toThrow('kernel-browser-event-owners-config-invalid');
    expect(() => createKernelBrowserEventOwners({
      ready: Promise.resolve(), firefox: true, resumeSchedules: () => {},
      tabCustody: makeCustody([], { onBeforeRequest: undefined }),
      receipts: recoveryRegistry(),
    })).toThrow('kernel-browser-event-owners-config-invalid');
    expect(() => createKernelBrowserEventOwners({
      ready: Promise.resolve(), resumeSchedules: () => {},
      tabCustody: makeCustody([]),
    } as any)).toThrow('kernel-browser-event-owners-config-invalid');
  });
});
