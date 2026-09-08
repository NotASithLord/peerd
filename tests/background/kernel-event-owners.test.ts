import { describe, expect, test } from 'bun:test';
import { attachKernelLifecycleEvents } from '../../extension/background/kernel-tab-events.js';
import { attachKernelTabEvents } from '../../extension/background/kernel-tab-events.js';
import { createKernelColdReceipts } from '../../extension/background/kernel-cold-receipts.js';

const rawEvent = () => {
  const listeners: Array<(...args: any[]) => any> = [];
  const registrations: any[] = [];
  return {
    listeners, registrations,
    addListener(listener: (...args: any[]) => any, ...options: any[]) {
      listeners.push(listener); registrations.push([listener, ...options]);
    },
    removeListener() {},
    emit(...args: any[]) { return listeners.map((listener) => listener(...args)); },
  };
};

const makeBrowser = () => ({
  runtime: { onStartup: rawEvent(), onUpdateAvailable: rawEvent() },
  alarms: { onAlarm: rawEvent() },
  storage: { session: { onChanged: rawEvent() } },
  tabs: {
    onCreated: rawEvent(), onUpdated: rawEvent(), onRemoved: rawEvent(),
    onActivated: rawEvent(),
  },
  webNavigation: { onCreatedNavigationTarget: rawEvent() },
  webRequest: { onBeforeRequest: rawEvent() },
});

let registrySequence = 0;
const makeRegistry = (target: { firefox?: boolean; selfHostedChrome?: boolean } = {}) => {
  let stored: any;
  registrySequence += 1;
  return createKernelColdReceipts({
    store: {
      get: async () => stored == null ? stored : structuredClone(stored),
      set: async (_key, value) => { stored = structuredClone(value); },
    },
    identity: {
      schema: 1, buildId: 'event-owner-test',
      bootId: `event-owner-boot-${registrySequence}`,
      kernelEpoch: `event-owner-epoch-${registrySequence}`,
    },
    ...target,
  });
};

describe('modular native-kernel browser event owners', () => {
  test('tab owner keeps every authority callback synchronous and Firefox blocking exact', () => {
    const browser = makeBrowser();
    const registry = makeRegistry({ firefox: true });
    const calls: any[] = [];
    const owner = attachKernelTabEvents({
      browser, registry, firefox: true,
      onCreated: (...args) => calls.push(['created', ...args]),
      onUpdated: (...args) => calls.push(['updated', ...args]),
      onRemoved: (...args) => calls.push(['removed', ...args]),
      onActivated: (...args) => calls.push(['activated', ...args]),
      onNavigationTarget: (...args) => calls.push(['navigation', ...args]),
      onBeforeRequest: (details) => ({ cancel: details.url === 'http://127.0.0.1/' }),
    });
    expect(owner.owner).toBe('kernel-tab-custody');
    browser.tabs.onCreated.emit({ id: 1 });
    browser.tabs.onUpdated.emit(1, { status: 'loading' }, { id: 1 });
    browser.tabs.onRemoved.emit(1, { windowId: 2 });
    browser.tabs.onActivated.emit({ tabId: 2 });
    browser.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 2, tabId: 3 });
    expect(calls.map((row) => row[0])).toEqual([
      'created', 'updated', 'removed', 'activated', 'navigation',
    ]);
    expect(browser.webRequest.onBeforeRequest.emit({ url: 'http://127.0.0.1/' }))
      .toEqual([{ cancel: true }]);
    expect(browser.webRequest.onBeforeRequest.registrations[0].slice(1)).toEqual([
      { urls: ['<all_urls>'] }, ['blocking'],
    ]);
  });

  test('lifecycle owner registers only target-present wake paths and returns handler promises', async () => {
    const browser = makeBrowser();
    const registry = makeRegistry({ firefox: true, selfHostedChrome: true });
    const calls: string[] = [];
    attachKernelLifecycleEvents({
      browser, registry, firefox: true, selfHostedChrome: true,
      onStartup: async () => { calls.push('startup'); },
      alarmName: 'peerd-schedule',
      onAlarm: async () => { calls.push('alarm'); },
      onSessionChanged: async () => { calls.push('session'); },
      onUpdateAvailable: async () => { calls.push('update'); },
    });
    expect(browser.alarms.onAlarm.emit({ name: 'some-other-feature' })).toEqual([undefined]);
    const results = [
      ...browser.runtime.onStartup.emit(),
      ...browser.alarms.onAlarm.emit({ name: 'peerd-schedule' }),
      ...browser.storage.session.onChanged.emit({}, 'session'),
      ...browser.runtime.onUpdateAvailable.emit({ version: '1.2.3' }),
    ];
    expect(results.every((result) => result instanceof Promise)).toBe(true);
    await Promise.all(results);
    expect(calls).toEqual(['startup', 'alarm', 'session', 'update']);
  });

  test('missing synchronous owners fail before a browser listener is added', () => {
    const browser = makeBrowser();
    const registry = makeRegistry({ firefox: true });
    expect(() => attachKernelTabEvents({
      browser, registry, firefox: true,
      onCreated: () => {}, onUpdated: () => {}, onRemoved: () => {},
      onActivated: () => {}, onNavigationTarget: () => {},
    })).toThrow('kernel-tab-events-config-invalid');
    expect(browser.tabs.onCreated.listeners).toHaveLength(0);
    expect(() => attachKernelLifecycleEvents({
      browser, registry, firefox: true, onStartup: () => {}, alarmName: '', onAlarm: () => {},
    })).toThrow('kernel-lifecycle-events-config-invalid');
    expect(browser.runtime.onStartup.listeners).toHaveLength(0);
  });

  test('Firefox fails closed when its blocking child-request event is absent', () => {
    const browser = makeBrowser() as any;
    browser.webRequest.onBeforeRequest = undefined;
    expect(() => attachKernelTabEvents({
      browser, registry: makeRegistry({ firefox: true }), firefox: true,
      onCreated: () => {}, onUpdated: () => {}, onRemoved: () => {},
      onActivated: () => {}, onNavigationTarget: () => {}, onBeforeRequest: () => ({}),
    })).toThrow('kernel-firefox-child-request-guard-unavailable');
  });

  test('Firefox storage lifetime may own its event outside lifecycle custody', () => {
    const browser = makeBrowser();
    const registry = makeRegistry({ firefox: true });
    attachKernelLifecycleEvents({
      browser, registry, firefox: true,
      onStartup: () => {}, alarmName: 'peerd-schedule', onAlarm: () => {},
    });
    expect(browser.storage.session.onChanged.listeners).toHaveLength(0);
  });
});
