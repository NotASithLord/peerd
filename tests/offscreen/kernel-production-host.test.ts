import { describe, expect, test } from 'bun:test';
import { createKernelProductionHost } from '../../extension/offscreen/kernel-production-host.js';
import { CHANNEL_DEFAULTS } from '../../extension/shared/build-config.js';

describe('controller production projection', () => {
  test('requires a full snapshot before applying exact deltas', async () => {
    const host = createKernelProductionHost();
    await expect(host.events['production/tabs-created']({ tab: { id: 2 } }, {}))
      .rejects.toThrow('production-reconcile-required');
    expect(host.read().reconciled).toBe(false);
    await expect(host.events['production/reconcile']({
      tabs: [{ id: 1, url: 'https://example.test/' }],
      tabsComplete: true,
      activeTabId: 1,
      settings: { ...CHANNEL_DEFAULTS },
      uiConnected: true,
    }, {})).resolves.toMatchObject({ accepted: true, reconciled: true });
    await host.events['production/tabs-updated']({
      tabId: 1,
      change: { status: 'complete' },
      tab: { id: 1, status: 'complete', url: 'https://example.test/' },
    }, {});
    await host.events['production/tabs-created']({ tab: { id: 3 } }, {});
    await host.events['production/tabs-removed']({ tabId: 1 }, {});
    await host.events['production/tabs-activated']({ tabId: 3, windowId: 7 }, {});
    await host.events['production/settings-changed']({ patch: { devMode: true } }, {});
    expect(host.read()).toMatchObject({
      tabs: [{ id: 3 }], activeTabId: 3,
      settings: { devMode: true }, uiConnected: true, reconciled: true,
    });
  });

  test('rejects malformed projections and notifies subscribers in order', async () => {
    const host = createKernelProductionHost();
    const seen: string[] = [];
    const unsubscribe = host.subscribe((event) => { seen.push(event); });
    await expect(host.events['production/reconcile']({
      tabs: [], tabsComplete: true, activeTabId: null,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    }, {})).resolves.toMatchObject({ accepted: true, reconciled: true });
    await host.events['production/ui-connect']({}, {});
    await host.events['production/ui-quiet']({}, {});
    await host.events['production/schedules-resume']({}, {});
    await host.events['production/navigation-target']({ sourceTabId: 1, tabId: 2 }, {});
    await expect(host.events['production/tabs-created']({ tab: { id: -1 } }, {}))
      .rejects.toThrow('production-tab-created-invalid');
    await expect(host.events['production/settings-changed']({ patch: { forged: true } }, {}))
      .rejects.toThrow('production-settings-invalid');
    unsubscribe();
    expect(seen).toEqual([
      'production/reconcile', 'production/ui-connect', 'production/ui-quiet',
      'production/schedules-resume', 'production/navigation-target',
    ]);
  });

  test('requires one exact settings and tab snapshot', async () => {
    const host = createKernelProductionHost();
    await expect(host.events['production/reconcile']({
      tabs: [{ id: 1 }, { id: 1 }], activeTabId: 1,
      tabsComplete: true,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    }, {})).rejects.toThrow('production-reconcile-invalid');
    await expect(host.events['production/reconcile']({
      tabs: [{ id: 1 }], activeTabId: 2,
      tabsComplete: true,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    }, {})).rejects.toThrow('production-reconcile-invalid');
    const { devMode: _missing, ...truncated } = CHANNEL_DEFAULTS;
    await expect(host.events['production/reconcile']({
      tabs: [], tabsComplete: true, activeTabId: null,
      settings: truncated, uiConnected: false,
    }, {})).rejects.toThrow('production-reconcile-invalid');
  });

  test('deduplicates each subscriber after a partial retry', async () => {
    const host = createKernelProductionHost();
    let first = 0;
    let second = 0;
    let fail = true;
    host.subscribe(() => { first += 1; });
    host.subscribe(() => {
      second += 1;
      if (fail) { fail = false; throw new Error('retry'); }
    });
    const identity = {
      bootId: 'boot-subscriber-1', kernelEpoch: 'epoch-subscriber-1',
      eventId: 'event-subscriber-1', sequence: 1,
    };
    const snapshot = {
      tabs: [], tabsComplete: true, activeTabId: null,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    };
    await expect(host.events['production/reconcile'](snapshot, { identity }))
      .rejects.toThrow('production listener incomplete');
    await expect(host.events['production/reconcile'](snapshot, { identity }))
      .resolves.toMatchObject({ accepted: true });
    expect({ first, second }).toEqual({ first: 1, second: 2 });
  });

  test('keeps completed subscribers exactly once when a partial response is lost', async () => {
    const host = createKernelProductionHost();
    let first = 0;
    let second = 0;
    host.subscribe((event) => { if (event === 'production/navigation-target') first += 1; });
    host.subscribe((event) => {
      if (event !== 'production/navigation-target') return;
      second += 1;
      throw new Error('listener failed');
    });
    const snapshot = {
      tabs: [{ id: 1 }, { id: 2 }], tabsComplete: true, activeTabId: 1,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    };
    await host.events['production/reconcile'](snapshot, { identity: {
      bootId: 'boot-lost-partial', kernelEpoch: 'epoch-lost-partial',
      eventId: 'reconcile-lost-partial', sequence: 1,
    } });
    await expect(host.events['production/navigation-target']({ sourceTabId: 1, tabId: 2 }, {
      identity: {
        bootId: 'boot-lost-partial', kernelEpoch: 'epoch-lost-partial',
        eventId: 'navigation-lost-partial', sequence: 2,
      },
    })).rejects.toMatchObject({
      code: 'production-listener-incomplete', outcomeKnown: true, retryable: true,
    });
    expect({ first, second }).toEqual({ first: 1, second: 1 });
  });

  test('rejects noncanonical settings, unknown tab activation, and broad changes', async () => {
    const reconcile = (settings: Record<string, any>) => createKernelProductionHost()
      .events['production/reconcile']({
        tabs: [], tabsComplete: true, activeTabId: null,
        settings, uiConnected: false,
      }, {});
    for (const patch of [
      { voiceSilenceMs: 249 },
      { vaultAutoLockMs: 59_999 },
      { auditLogMaxEntries: 1_000_001 },
      { spendLimitUsd: 100_001 },
      { providerName: 'forged' },
      { providerFallbacks: ['openai', 'openai'] },
      { openrouterModels: [' model'] },
      { ollamaHost: 'http://user:pass@localhost:11434/path' },
    ]) {
      await expect(reconcile({ ...CHANNEL_DEFAULTS, ...patch }))
        .rejects.toThrow('production-reconcile-invalid');
    }
    const host = createKernelProductionHost();
    await host.events['production/reconcile']({
      tabs: [{ id: 1 }], tabsComplete: true, activeTabId: 1,
      settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
    }, {});
    await expect(host.events['production/tabs-activated']({ tabId: 2, windowId: 1 }, {}))
      .rejects.toThrow('production-tab-activated-invalid');
    await expect(host.events['production/tabs-updated']({
      tabId: 1, change: { title: 'unbounded' }, tab: { id: 1 },
    }, {})).rejects.toThrow('production-tab-updated-invalid');
  });

  test('deep-freezes the projected settings snapshot', async () => {
    const host = createKernelProductionHost();
    await host.events['production/reconcile']({
      tabs: [], tabsComplete: true, activeTabId: null,
      settings: {
        ...CHANNEL_DEFAULTS,
        openrouterModels: ['model-one'],
        providerFallbacks: ['openai'],
        pricingOverrides: { 'model-one': { input: 1 } },
      },
      uiConnected: false,
    }, {});
    const projected: any = host.read().settings;
    expect(() => projected.openrouterModels.push('forged')).toThrow();
    expect(() => { projected.pricingOverrides['model-one'].input = 99; }).toThrow();
    expect(host.read().settings).toMatchObject({
      openrouterModels: ['model-one'],
      providerFallbacks: ['openai'],
      pricingOverrides: { 'model-one': { input: 1 } },
    });
  });
});
