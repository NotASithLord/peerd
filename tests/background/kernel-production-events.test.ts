import { describe, expect, test } from 'bun:test';
import { createKernelFeatureControl } from '../../extension/background/kernel-feature-control.js';
import { createKernelProductionEvents } from '../../extension/background/kernel-production-events.js';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import { createKernelProductionHost } from '../../extension/offscreen/kernel-production-host.js';
import { KERNEL_FEATURE_EVENT_CAPABILITY } from '../../extension/shared/kernel-feature-policy.js';
import { CHANNEL_DEFAULTS } from '../../extension/shared/build-config.js';
import { controllerPayloadBytes } from '../../extension/shared/structured-clone-size.js';

describe('kernel production event projection', () => {
  test('stays dormant without a run, reconciles first, and recovers a controller generation', async () => {
    let tabs = [{ id: 1, url: 'https://one.test/' }];
    let controller = createKernelProductionHost();
    let featureHost = createKernelFeatureHost({ events: controller.events });
    let control!: ReturnType<typeof createKernelFeatureControl>;
    let calls = 0;
    control = createKernelFeatureControl({
      call: async (capability, payload) => {
        calls += 1;
        return featureHost.event(payload, {
          signal: new AbortController().signal,
          authority: control.authorize(capability, payload),
          deadlineAt: Date.now() + 5_000,
        });
      },
    });
    const events = createKernelProductionEvents({
      identity: { bootId: 'boot-production-1', kernelEpoch: 'epoch-production-1' },
      send: (event, envelope) => control.event(event, envelope),
      readSnapshot: () => ({
        tabs, activeTabId: tabs[0]?.id ?? null,
        settings: { ...CHANNEL_DEFAULTS }, uiConnected: true,
      }),
      withRun: (operation) => operation(),
    });
    expect(await events.emit('production/tabs-created', { tab: { id: 2 } }))
      .toMatchObject({ value: { accepted: false, inactive: true } });
    expect(calls).toBe(0);
    await events.run(async () => {
      expect(controller.read()).toMatchObject({ reconciled: true, tabs });
      tabs = [...tabs, { id: 2, url: 'https://two.test/' }];
      await events.emit('production/tabs-created', { tab: tabs[1] });
      expect(controller.read().tabs).toHaveLength(2);

      controller = createKernelProductionHost();
      featureHost = createKernelFeatureHost({ events: controller.events });
      tabs = [...tabs, { id: 3, url: 'https://three.test/' }];
      await events.emit('production/tabs-created', { tab: tabs[2] });
      expect(controller.read()).toMatchObject({ reconciled: true, tabs });
    });
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  test('serializes deltas and never offers event reverse authority', async () => {
    const seen: number[] = [];
    let control!: ReturnType<typeof createKernelFeatureControl>;
    control = createKernelFeatureControl({
      call: async (capability, payload) => {
        expect(capability).toBe(KERNEL_FEATURE_EVENT_CAPABILITY);
        expect(await control.handleKernelCall('forged.effect', {}, {
          capability, authority: control.authorize(capability, payload),
        })).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
        const sequence = (payload as any).payload.sequence;
        await Promise.resolve();
        seen.push(sequence);
        return { ok: true, outcomeKnown: true, value: { accepted: true } };
      },
    });
    const events = createKernelProductionEvents({
      identity: { bootId: 'boot-production-2', kernelEpoch: 'epoch-production-2' },
      send: (event, envelope) => control.event(event, envelope),
      readSnapshot: () => ({
        tabs: [], activeTabId: null, settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
      }),
      withRun: (operation) => operation(),
    });
    await events.run(async () => {
      await Promise.all([
        events.emit('production/ui-connect'),
        events.emit('production/ui-quiet'),
      ]);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  test('never replays a transient action after an unknown delivery', async () => {
    const applied: string[] = [];
    const events = createKernelProductionEvents({
      identity: { bootId: 'boot-production-3', kernelEpoch: 'epoch-production-3' },
      send: async (event) => {
        if (event === 'production/reconcile') {
          return { ok: true, outcomeKnown: true, value: { accepted: true } };
        }
        applied.push(event);
        return { ok: false, code: 'response-lost', outcomeKnown: false };
      },
      readSnapshot: () => ({
        tabs: [], activeTabId: null, settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
      }),
      withRun: (operation) => operation(),
    });
    await events.run(async () => {
      await expect(events.emit('production/navigation-target', {
        sourceTabId: 1, tabId: 2,
      })).resolves.toMatchObject({ outcomeKnown: false });
      await expect(events.emit('production/schedules-resume'))
        .resolves.toMatchObject({ outcomeKnown: false });
    });
    expect(applied).toEqual([
      'production/navigation-target', 'production/schedules-resume',
    ]);
  });

  test('keeps one logical event id across a known retry and reconciles every run', async () => {
    const deliveries: any[] = [];
    let fail = true;
    const events = createKernelProductionEvents({
      identity: { bootId: 'boot-production-4', kernelEpoch: 'epoch-production-4' },
      newId: (() => { let id = 0; return () => `logical-event-${++id}`; })(),
      send: async (event, envelope) => {
        deliveries.push({ event, envelope });
        if (event === 'production/ui-connect' && fail) {
          fail = false;
          return {
            ok: false, code: 'production-listener-incomplete',
            outcomeKnown: true, retryable: true,
          };
        }
        return { ok: true, outcomeKnown: true, value: { accepted: true } };
      },
      readSnapshot: () => ({
        tabs: [], activeTabId: null, settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
      }),
      withRun: (operation) => operation(),
    });
    await events.run(async () => { await events.emit('production/ui-connect'); });
    await events.run(async () => {});
    const delta = deliveries.filter((delivery) => delivery.event === 'production/ui-connect');
    expect(delta).toHaveLength(2);
    expect(delta[0].envelope.eventId).toBe(delta[1].envelope.eventId);
    expect(delta[0].envelope.sequence).not.toBe(delta[1].envelope.sequence);
    expect(deliveries.filter((delivery) => delivery.event === 'production/reconcile'))
      .toHaveLength(3);
  });

  test('bounds a high-cardinality snapshot and omits one oversized URL', async () => {
    let snapshot: any;
    const tabs = Array.from({ length: 10_000 }, (_, id) => ({
      id,
      url: id === 9_999 ? `data:text/plain,${'x'.repeat(300_000)}` : `https://t${id}.test/`,
    }));
    const events = createKernelProductionEvents({
      identity: { bootId: 'boot-production-5', kernelEpoch: 'epoch-production-5' },
      send: async (event, envelope) => {
        if (event === 'production/reconcile') snapshot = envelope.value;
        return { ok: true, outcomeKnown: true, value: { accepted: true } };
      },
      readSnapshot: () => ({
        tabs, activeTabId: 9_999, settings: { ...CHANNEL_DEFAULTS }, uiConnected: false,
      }),
      withRun: (operation) => operation(),
    });
    await events.run(async () => {});
    expect(controllerPayloadBytes(snapshot, { maxNodes: 250_000 })).toBeLessThan(256 * 1024);
    expect(snapshot.tabsComplete).toBe(false);
    expect(snapshot.tabs).toHaveLength(8_192);
    expect(snapshot.tabs.find((tab: any) => tab.id === 9_999)).toEqual({ id: 9_999 });
  });
});
