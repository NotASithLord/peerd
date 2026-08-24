import { describe, expect, test } from 'bun:test';
import {
  createKernelColdReceipts,
  KERNEL_COLD_RECEIPTS_KEY,
} from '../../extension/background/kernel-cold-receipts.js';
import {
  coldEventKeysFor,
  LEGACY_COLD_EVENTS,
} from '../../extension/background/cold-kernel-inventory.js';
import { attachKernelLifecycleEvents } from '../../extension/background/kernel-lifecycle-events.js';

const identity = (suffix: string) => ({
  schema: 1 as const,
  buildId: '1.0.0:test-build',
  bootId: `boot-${suffix}`,
  kernelEpoch: `epoch-${suffix}`,
});

const memoryStore = () => {
  let value: any;
  return {
    get: async (_key: string) => value == null ? value : structuredClone(value),
    set: async (key: string, next: any) => {
      expect(key).toBe(KERNEL_COLD_RECEIPTS_KEY);
      value = structuredClone(next);
    },
  };
};

const rawEvent = () => {
  let listener: Function | null = null;
  let options: any[] = [];
  return {
    addListener(next: Function, ...nextOptions: any[]) {
      expect(listener).toBeNull();
      listener = next;
      options = nextOptions;
    },
    removeListener(next: Function) {
      if (listener === next) listener = null;
    },
    emit: (...args: any[]) => listener?.(...args),
    options: () => options,
    hasListener: () => listener !== null,
  };
};

const waitForCount = async (receipts: any, count: number) => {
  for (let index = 0; index < 50; index += 1) {
    const snapshot = await receipts.snapshot();
    if (snapshot.entries.length === count) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`receipt count did not settle at ${count}`);
};

const recoverable = new Set(LEGACY_COLD_EVENTS.filter(({ placement }) =>
  placement === 'durable-hint' || placement === 'kernel-authority').map(({ key }) => key));

const registerRequiredRecoveries = (
  receipts: any,
  overrides: Record<string, (notice: any) => unknown> = {},
) => {
  for (const event of receipts.required.filter((key: string) => recoverable.has(key))) {
    receipts.registerRecovery({
      event, owner: `owner:${event}`, reconcile: overrides[event] ?? (() => {}),
    });
  }
};

describe('native kernel cold receipts', () => {
  test('settles unrelated alarms but retains the exact schedule wake on owner failure', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('schedule-filter'),
    });
    const browser = {
      runtime: { onStartup: rawEvent() },
      alarms: { onAlarm: rawEvent() },
    };
    attachKernelLifecycleEvents({
      browser, registry: receipts,
      alarmName: 'peerd-schedule',
      onStartup: () => {},
      onAlarm: async () => { throw new Error('schedule owner unavailable'); },
    });

    expect(browser.alarms.onAlarm.emit({ name: 'another-feature' })).toBeUndefined();
    await waitForCount(receipts, 0);
    await expect(browser.alarms.onAlarm.emit({ name: 'peerd-schedule' }))
      .rejects.toThrow('schedule owner unavailable');
    const retained = await waitForCount(receipts, 1);
    expect(retained.entries[0]).toMatchObject({
      event: 'alarms.onAlarm', payload: { name: 'peerd-schedule' },
    });
  });

  test('persists only a fixed secretless hint and recovers it in a successor kernel', async () => {
    const store = memoryStore();
    const first = createKernelColdReceipts({
      store, identity: identity('one'), firefox: true,
    });
    const changed = rawEvent();
    const held = new Promise(() => {});
    first.event('storage.session.onChanged', changed, 'firefox-session-owner')
      ?.addListener(() => held);
    changed.emit({
      'vault.session.dk': { oldValue: 'secret-one', newValue: 'secret-two' },
      ordinary: { newValue: { token: 'also-secret' } },
    }, 'session');
    const snapshot = await waitForCount(first, 1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].payload).toEqual({
      keys: ['vault.session.dk', 'ordinary'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-one');
    expect(JSON.stringify(snapshot)).not.toContain('secret-two');
    expect(JSON.stringify(snapshot)).not.toContain('also-secret');

    const second = createKernelColdReceipts({ store, identity: identity('two') });
    const recovered: any[] = [];
    second.registerRecovery({
      event: 'storage.session.onChanged', owner: 'firefox-session-owner',
      reconcile: (input: any) => { recovered.push(input); },
    });
    await second.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual({
      event: 'storage.session.onChanged', count: 1,
      fullReconcile: false, entries: [],
    });
    expect((await second.snapshot()).entries).toEqual([]);
  });

  test('preserves the synchronous Firefox blocking decision and exact options', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('firefox'), firefox: true,
    });
    const request = rawEvent();
    receipts.event('webRequest.onBeforeRequest', request, 'firefox-request-owner')?.addListener(
      () => ({ cancel: true }),
      { urls: ['<all_urls>'] },
      ['blocking'],
    );
    expect(request.options()).toEqual([{ urls: ['<all_urls>'] }, ['blocking']]);
    expect(request.emit({ tabId: 7, url: 'http://127.0.0.1/' }))
      .toEqual({ cancel: true });
    await waitForCount(receipts, 0);
  });

  test('overflow forces full current-state reconciliation and never replays raw arguments', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('overflow'), max: 2,
    });
    const removed = rawEvent();
    const held = new Promise(() => {});
    receipts.event('tabs.onRemoved', removed, 'tab-owner')?.addListener(() => held);
    removed.emit(1, { windowId: 4, isWindowClosing: false, secret: 'one' });
    removed.emit(2, { windowId: 4, isWindowClosing: false, secret: 'two' });
    removed.emit(3, { windowId: 4, isWindowClosing: false, secret: 'three' });
    const snapshot = await waitForCount(receipts, 2);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0].event).toBe('kernel.queueOverflow');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    let recovery: any;
    registerRequiredRecoveries(receipts, {
      'tabs.onRemoved': (input) => { recovery = input; },
    });
    await receipts.recover();
    expect(recovery.fullReconcile).toBe(true);
    expect(recovery).toMatchObject({
      event: 'tabs.onRemoved', count: 1, entries: [],
    });
  });

  test('a missing recovery owner leaves the durable receipt for a later kernel', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('unowned'), selfHostedChrome: true,
    });
    const update = rawEvent();
    receipts.event('runtime.onUpdateAvailable', update, 'update-custody')
      ?.addListener(() => new Promise(() => {}));
    update.emit({ version: '9.9.9' });
    await waitForCount(receipts, 1);
    await expect(receipts.recover())
      .rejects.toThrow('kernel-recovery-owner-missing:runtime.onUpdateAvailable');
    expect((await receipts.snapshot()).entries).toHaveLength(1);
  });
});

describe('combined native kernel event and recovery custody', () => {
  test('records one live owner, preserves removal, and refuses competing claims', () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('event-owner'),
    });
    const raw = rawEvent();
    const listener = () => 'handled';
    const facade = receipts.event(
      'runtime.onMessage', raw, 'kernel-message-router',
    );
    facade?.addListener(listener);
    expect(receipts.owners()).toEqual({ 'runtime.onMessage': 'kernel-message-router' });
    expect(raw.emit()).toBe('handled');
    expect(() => receipts.event('runtime.onMessage', raw, 'semantic-host'))
      .toThrow('kernel-event-owner-conflict:runtime.onMessage');
    expect(() => receipts.event('runtime.onMessage', rawEvent(), 'kernel-message-router'))
      .toThrow('kernel-event-owner-conflict:runtime.onMessage');
    expect(() => receipts.event('runtime.onMessage', raw, 'x'))
      .toThrow('kernel-event-owner-invalid');
    facade?.removeListener(listener);
    expect(raw.hasListener()).toBe(false);
    expect(receipts.owners()).toEqual({});
    expect(receipts.missing()).toContain('runtime.onMessage');
  });

  test('target-pruned events cannot bypass custody and completeness is executable', () => {
    const store = createKernelColdReceipts({
      store: memoryStore(), identity: identity('store-target'),
    });
    const firefox = createKernelColdReceipts({
      store: memoryStore(), identity: identity('firefox-target'), firefox: true,
    });
    const update = rawEvent();
    expect(store.event('runtime.onUpdateAvailable', update, 'update-custody'))
      .toBeUndefined();
    expect(update.hasListener()).toBe(false);
    expect(firefox.required).toEqual(coldEventKeysFor({ firefox: true }));
    expect(firefox.required).toContain('webRequest.onBeforeRequest');
    expect(store.complete()).toBe(false);
    for (const key of store.required) {
      store.event(key, rawEvent(), `owner:${key}`)?.addListener(() => {});
    }
    expect(store.missing()).toEqual([]);
    expect(store.complete()).toBe(true);
    expect(Object.keys(store.owners())).toHaveLength(store.required.length);
  });

  test('folds receipts into current-state notices without replaying payloads', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('fold'),
    });
    const updated = rawEvent();
    const held = new Promise(() => {});
    receipts.event('tabs.onUpdated', updated, 'tab-custody')?.addListener(() => held);
    updated.emit(7, { status: 'loading', url: 'https://never-forward.test' });
    updated.emit(8, { status: 'complete' });
    await waitForCount(receipts, 2);
    const seen: any[] = [];
    receipts.registerRecovery({
      event: 'tabs.onUpdated', owner: 'tab-custody',
      reconcile: (notice: any) => { seen.push(notice); },
    });
    await expect(receipts.recover()).resolves.toHaveLength(2);
    expect(seen).toEqual([{
      event: 'tabs.onUpdated', count: 2, fullReconcile: false, entries: [],
    }]);
    expect(JSON.stringify(seen)).not.toContain('never-forward');
  });

  test('overflow invokes registered owners in inventory order', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('recovery-order'), max: 2,
    });
    const removed = rawEvent();
    const held = new Promise(() => {});
    receipts.event('tabs.onRemoved', removed, 'tab-custody')?.addListener(() => held);
    removed.emit(1, {}); removed.emit(2, {}); removed.emit(3, {});
    await waitForCount(receipts, 2);
    const seen: string[] = [];
    registerRequiredRecoveries(receipts, {
      'alarms.onAlarm': ({ event, count, fullReconcile }) => {
        seen.push(`${event}:${count}:${fullReconcile}`);
      },
      'tabs.onRemoved': ({ event, count, fullReconcile }) => {
        seen.push(`${event}:${count}:${fullReconcile}`);
      },
    });
    await receipts.recover();
    expect(seen).toEqual([
      'alarms.onAlarm:0:true', 'tabs.onRemoved:1:true',
    ]);
  });

  test('recovery owners are exact and update version is the sole replayable hint', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('update-recovery'), selfHostedChrome: true,
    });
    expect(() => receipts.registerRecovery({
      event: 'invented.event', owner: 'invented', reconcile: () => {},
    })).toThrow('kernel-recovery-event-unknown:invented.event');
    const notices: any[] = [];
    receipts.registerRecovery({
      event: 'runtime.onUpdateAvailable', owner: 'update-custody',
      reconcile: (notice: any) => { notices.push(notice); },
    });
    expect(() => receipts.registerRecovery({
      event: 'runtime.onUpdateAvailable', owner: 'semantic-host', reconcile: () => {},
    })).toThrow('kernel-recovery-owner-conflict:runtime.onUpdateAvailable');
    expect(receipts.recoveryOwners())
      .toEqual({ 'runtime.onUpdateAvailable': 'update-custody' });
    const update = rawEvent();
    receipts.event('runtime.onUpdateAvailable', update, 'update-event-owner')
      ?.addListener(() => new Promise(() => {}));
    update.emit({ version: '9.9.9' });
    await waitForCount(receipts, 1);
    await receipts.recover();
    expect(notices).toEqual([{
      event: 'runtime.onUpdateAvailable', count: 1, fullReconcile: false,
      entries: [{
        event: 'runtime.onUpdateAvailable', payload: { version: '9.9.9' },
      }],
    }]);
  });

  test('overflow requires every target recovery owner before acknowledging receipts', async () => {
    const receipts = createKernelColdReceipts({
      store: memoryStore(), identity: identity('required-recovery'), max: 2,
    });
    const removed = rawEvent();
    receipts.event('tabs.onRemoved', removed, 'tab-custody')
      ?.addListener(() => new Promise(() => {}));
    removed.emit(1, {}); removed.emit(2, {}); removed.emit(3, {});
    await waitForCount(receipts, 2);
    const required = receipts.required.filter((key: string) => recoverable.has(key));
    receipts.registerRecovery({
      event: required[0], owner: 'first-required-owner', reconcile: () => {},
    });
    await expect(receipts.recover())
      .rejects.toThrow(`kernel-recovery-owner-missing:${required[1]}`);
    expect((await receipts.snapshot()).entries).toHaveLength(2);
  });

  test('a retired kernel cannot acknowledge a successor-owned receipt', async () => {
    const store = memoryStore();
    let release!: () => void;
    const handler = new Promise<void>((resolve) => { release = resolve; });
    const first = createKernelColdReceipts({ store, identity: identity('retired-first') });
    const startup = rawEvent();
    first.event('runtime.onStartup', startup, 'lifecycle-owner')?.addListener(() => handler);
    startup.emit();
    await waitForCount(first, 1);

    const successor = createKernelColdReceipts({
      store, identity: identity('retired-successor'),
    });
    await successor.ready();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await successor.snapshot()).entries).toHaveLength(1);
    successor.registerRecovery({
      event: 'runtime.onStartup', owner: 'lifecycle-owner', reconcile: () => {},
    });
    await successor.recover();
    expect((await successor.snapshot()).entries).toEqual([]);
  });
});
