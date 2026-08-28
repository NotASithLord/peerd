import { describe, expect, test } from 'bun:test';
import { createColdKernelCapture } from '../../extension/background/cold-kernel-capture.js';
import {
  coldEventKeysFor,
  KERNEL_COLD_EVENTS,
} from '../../extension/background/cold-kernel-inventory.js';

type Listener = (...args: any[]) => any;
const makeEvent = () => {
  const listeners: Listener[] = [];
  const registrations: any[] = [];
  return {
    listeners,
    registrations,
    addListener(listener: Listener, ...args: any[]) {
      listeners.push(listener);
      registrations.push([listener, ...args]);
    },
    removeListener(listener: Listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args: any[]) { return listeners.map((listener) => listener(...args)); },
  };
};

const makeBrowser = () => ({
  runtime: {
    onMessage: makeEvent(), onConnect: makeEvent(), onStartup: makeEvent(),
    onInstalled: makeEvent(), onUpdateAvailable: makeEvent(),
  },
  alarms: { onAlarm: makeEvent() },
  storage: { session: { onChanged: makeEvent() } },
  tabs: {
    onCreated: makeEvent(), onUpdated: makeEvent(), onRemoved: makeEvent(),
    onActivated: makeEvent(),
  },
  windows: { onFocusChanged: makeEvent() },
  webNavigation: { onCreatedNavigationTarget: makeEvent() },
  webRequest: { onBeforeRequest: makeEvent() },
  action: { onClicked: makeEvent() },
  commands: { onCommand: makeEvent() },
});

const makeStore = () => {
  const values = new Map<string, any>();
  return {
    values,
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
  };
};

const authorityFor = (calls: string[] = []) => Object.fromEntries(
  KERNEL_COLD_EVENTS.filter((entry) =>
    entry.placement === 'kernel-authority' || entry.placement === 'kernel-immediate')
    .map((entry) => [entry.key, () => { calls.push(entry.key); return {}; }]),
);

const ids = (...values: string[]) => {
  const queue = [...values];
  let fallback = 0;
  return () => queue.shift() ?? `generated-${++fallback}`;
};

const firstParty = { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' };
const makeKernel = ({
  browser = makeBrowser(),
  store = makeStore(),
  calls = [] as string[],
  newId = ids('kernel-one', 'delivery-one', 'delivery-two'),
  rpcDeadlineMs = 30_000,
  firefox = false,
} = {}) => ({
  browser,
  store,
  calls,
  kernel: createColdKernelCapture({
    browser,
    queueStore: store,
    authority: authorityFor(calls),
    isFirstPartySender: (sender) => sender?.id === 'extension-id'
      && String(sender?.url).startsWith('chrome-extension://extension-id/'),
    isFirstPartyPort: (port) => port?.sender?.id === 'extension-id'
      && String(port?.sender?.url).startsWith('chrome-extension://extension-id/'),
    newId,
    rpcDeadlineMs,
    firefox,
    now: () => 123,
  }),
});

const send = (browser: ReturnType<typeof makeBrowser>, message: any, sender = firstParty) =>
  new Promise<any>((resolve, reject) => {
    const listener = browser.runtime.onMessage.listeners[0];
    if (!listener) return reject(new Error('runtime listener absent'));
    try { listener(message, sender, resolve); } catch (error) { reject(error); }
  });

describe('cold-listener inventory differential', () => {
  test('target filters preserve the Firefox blocker and preview update event', () => {
    expect(coldEventKeysFor()).not.toContain('webRequest.onBeforeRequest');
    expect(coldEventKeysFor()).not.toContain('storage.session.onChanged');
    expect(coldEventKeysFor()).not.toContain('runtime.onUpdateAvailable');
    expect(coldEventKeysFor({ firefox: true })).toContain('webRequest.onBeforeRequest');
    expect(coldEventKeysFor({ firefox: true })).toContain('storage.session.onChanged');
    expect(coldEventKeysFor({ selfHostedChrome: true })).toContain('runtime.onUpdateAvailable');
  });
});

describe('cold kernel durable capture and epochs', () => {
  test('injected identity owns capture, host attachment, and acknowledgements without epoch minting', async () => {
    const browser = makeBrowser();
    const store = makeStore();
    const identity = Object.freeze({
      schema: 1 as const,
      buildId: `0.7.0:${'a'.repeat(64)}`,
      bootId: 'boot-cold-capture',
      kernelEpoch: 'kernel-cold-capture',
    });
    const generated: string[] = [];
    const capture = createColdKernelCapture({
      browser,
      queueStore: store,
      authority: authorityFor(),
      isFirstPartySender: () => true,
      isFirstPartyPort: () => true,
      kernelIdentity: identity,
      newId: () => {
        const value = `delivery-${generated.length + 1}`;
        generated.push(value);
        return value;
      },
      now: () => 123,
    });
    await capture.ready();
    expect(capture.kernelEpoch).toBe(identity.kernelEpoch);
    expect(capture.kernelIdentity).toEqual(identity);
    expect(generated).toEqual([]);
    expect(store.values.get('cold-kernel.queue.v1')).toMatchObject({
      ownerEpoch: identity.kernelEpoch,
      ownerIdentity: identity,
    });

    const host = (kernelIdentity: any) => ({
      epoch: 'host-cold-capture', kernelIdentity,
      dispatchMessage: async () => ({ ok: true }),
      adoptPort: () => {}, retire: () => {},
    });
    expect(capture.attachHost(host({ ...identity, kernelEpoch: 'kernel-cold-forged' })))
      .toBe(false);
    expect(capture.attachHost(host(identity))).toBe(true);
    await capture.captureEvent('runtime.onStartup', []);
    const delivery = await capture.claim('host-cold-capture');
    expect(delivery).toMatchObject({
      kernelEpoch: identity.kernelEpoch,
      kernelIdentity: identity,
      deliveryId: 'delivery-1',
    });
    expect(await capture.acknowledge({
      ...delivery,
      kernelIdentity: { ...identity, bootId: 'boot-cold-forged' },
      ids: delivery!.entries.map((entry: any) => entry.id),
    })).toBe(false);
    expect(await capture.acknowledge({
      kernelEpoch: identity.kernelEpoch,
      kernelIdentity: identity,
      hostEpoch: 'host-cold-capture',
      deliveryId: delivery!.deliveryId,
      ids: delivery!.entries.map((entry: any) => entry.id),
    })).toBe(true);
  });

  test('registers one synchronous listener per Store Chrome cold event', async () => {
    const { browser, kernel } = makeKernel();
    expect(kernel.registered).toEqual(coldEventKeysFor());
    for (const key of coldEventKeysFor()) {
      const event = key.split('.').reduce((value: any, part) => value?.[part], browser);
      expect(event.listeners, key).toHaveLength(1);
    }
    await kernel.ready();
  });

  test('Firefox blocking and self-hosted update listeners retain target semantics', async () => {
    const firefoxBrowser = makeBrowser();
    const firefox = createColdKernelCapture({
      browser: firefoxBrowser, queueStore: makeStore(), authority: authorityFor(),
      isFirstPartySender: () => true, isFirstPartyPort: () => true,
      firefox: true, newId: ids('kernel-firefox'),
    });
    await firefox.ready();
    expect(firefox.registered).toContain('webRequest.onBeforeRequest');
    expect(firefoxBrowser.webRequest.onBeforeRequest.registrations[0].slice(1)).toEqual([
      { urls: ['<all_urls>'] }, ['blocking'],
    ]);

    const previewBrowser = makeBrowser();
    const preview = createColdKernelCapture({
      browser: previewBrowser, queueStore: makeStore(), authority: authorityFor(),
      isFirstPartySender: () => true, isFirstPartyPort: () => true,
      selfHostedChrome: true, newId: ids('kernel-preview'),
    });
    await preview.ready();
    expect(preview.registered).toContain('runtime.onUpdateAvailable');
  });

  test('authority runs synchronously while persisted hints contain no URLs or storage values', async () => {
    const { browser, kernel, calls } = makeKernel({ firefox: true });
    const secret = { newValue: { dk: 'must-not-copy' } };
    browser.webNavigation.onCreatedNavigationTarget.emit({
      sourceTabId: 1, sourceFrameId: 0, tabId: 2, url: 'https://secret.example/private',
    });
    expect(calls).toEqual(['webNavigation.onCreatedNavigationTarget']);
    browser.storage.session.onChanged.emit({ 'vault.session.dk': secret }, 'session');
    browser.tabs.onUpdated.emit(2, { status: 'loading', url: 'https://secret.example/next' });
    const host = {
      epoch: 'host-one', dispatchMessage: async () => ({ ok: true }),
      adoptPort() {}, retire() {},
    };
    expect(kernel.attachHost(host)).toBe(true);
    const delivery = await kernel.claim(host.epoch);
    expect(delivery.entries.map((entry: any) => entry.event)).toEqual([
      'webNavigation.onCreatedNavigationTarget',
      'storage.session.onChanged',
      'tabs.onUpdated',
    ]);
    const serialized = JSON.stringify(delivery);
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('must-not-copy');
    expect(serialized).toContain('vault.session.dk');
  });

  test('exact delivery and host epochs prevent stale or invented acknowledgements', async () => {
    const { browser, kernel } = makeKernel();
    browser.alarms.onAlarm.emit({ name: 'schedule:r1', scheduledTime: 10 });
    const hostA = { epoch: 'host-a', dispatchMessage: async () => ({}), adoptPort() {}, retire() {} };
    const hostB = { epoch: 'host-b', dispatchMessage: async () => ({}), adoptPort() {}, retire() {} };
    kernel.attachHost(hostA);
    const first = await kernel.claim(hostA.epoch);
    expect(first.entries).toHaveLength(1);
    const originalEntries = structuredClone(first.entries);
    first.entries[0].payload.name = 'host-mutation-must-not-land';
    expect((await kernel.claim(hostA.epoch)).entries).toEqual(originalEntries);
    expect(await kernel.acknowledge({
      kernelEpoch: kernel.kernelEpoch, hostEpoch: hostA.epoch,
      deliveryId: 'invented', ids: originalEntries.map((entry: any) => entry.id),
    })).toBe(false);
    kernel.attachHost(hostB);
    expect(await kernel.acknowledge({
      kernelEpoch: kernel.kernelEpoch, hostEpoch: hostA.epoch,
      deliveryId: first.deliveryId, ids: originalEntries.map((entry: any) => entry.id),
    })).toBe(false);
    const replacement = await kernel.claim(hostB.epoch);
    expect(replacement.entries).toEqual(originalEntries);
    expect(await kernel.acknowledge({
      kernelEpoch: kernel.kernelEpoch, hostEpoch: hostB.epoch,
      deliveryId: replacement.deliveryId,
      ids: replacement.entries.map((entry: any) => entry.id),
    })).toBe(true);
    expect((await kernel.claim(hostB.epoch)).entries).toEqual([]);
  });

  test('a replacement kernel owner rejects the old generation late ack', async () => {
    const store = makeStore();
    const first = makeKernel({ store, newId: ids('kernel-a', 'delivery-a') });
    await first.kernel.ready();
    first.browser.alarms.onAlarm.emit({ name: 'schedule:r2' });
    const hostA = { epoch: 'host-a', dispatchMessage: async () => ({}), adoptPort() {}, retire() {} };
    first.kernel.attachHost(hostA);
    const deliveryA = await first.kernel.claim(hostA.epoch);

    const second = makeKernel({ store, newId: ids('kernel-b', 'delivery-b') });
    await second.kernel.ready();
    await expect(first.kernel.acknowledge({
      kernelEpoch: first.kernel.kernelEpoch, hostEpoch: hostA.epoch,
      deliveryId: deliveryA.deliveryId,
      ids: deliveryA.entries.map((entry: any) => entry.id),
    })).rejects.toThrow('cold-kernel-epoch-retired');
    const hostB = { epoch: 'host-b', dispatchMessage: async () => ({}), adoptPort() {}, retire() {} };
    second.kernel.attachHost(hostB);
    expect((await second.kernel.claim(hostB.epoch)).entries).toEqual(deliveryA.entries);
  });
});

describe('cold kernel transient routes and ports', () => {
  test('pre-host RPC is known-safe; post-dispatch deadline is outcome unknown', async () => {
    const setup = makeKernel({ rpcDeadlineMs: 5 });
    const retireReasons: string[] = [];
    await setup.kernel.ready();
    expect(await send(setup.browser, { type: 'vault/lock' })).toMatchObject({
      ok: false, error: 'kernel-host-unavailable', outcomeKnown: true,
    });
    setup.kernel.attachHost({
      epoch: 'host-timeout',
      dispatchMessage: async (_message, _sender, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('host aborted')), { once: true });
      }),
      adoptPort() {}, retire(reason) { retireReasons.push(reason); },
    });
    expect(await send(setup.browser, { type: 'vault/lock' })).toMatchObject({
      ok: false, outcomeKnown: false,
    });
    expect(retireReasons).toEqual(['deadline']);
    expect(setup.kernel.attachHost({
      epoch: 'host-timeout', dispatchMessage: async () => ({}), adoptPort() {}, retire() {},
    })).toBe(false);
    expect(setup.kernel.attachHost({
      epoch: 'host-fresh', dispatchMessage: async () => ({ ok: true }), adoptPort() {}, retire() {},
    })).toBe(true);
  });

  test('oversized transient message is refused before host dispatch', async () => {
    const setup = makeKernel();
    await setup.kernel.ready();
    let dispatched = 0;
    setup.kernel.attachHost({
      epoch: 'host-size',
      dispatchMessage: async () => { dispatched += 1; return { ok: true }; },
      adoptPort() {}, retire() {},
    });
    expect(await send(setup.browser, {
      type: 'agent/send', userText: 'x'.repeat(300 * 1024),
    })).toEqual({ ok: false, error: 'kernel-message-too-large', outcomeKnown: true });
    expect(dispatched).toBe(0);
  });

  test('binary structured-clone bytes cannot bypass the transient route cap', async () => {
    const setup = makeKernel();
    await setup.kernel.ready();
    let dispatched = 0;
    setup.kernel.attachHost({
      epoch: 'host-binary-size',
      dispatchMessage: async () => { dispatched += 1; return { ok: true }; },
      adoptPort() {}, retire() {},
    });
    expect(await send(setup.browser, {
      type: 'agent/send', attachment: new ArrayBuffer(100 * 1024 * 1024),
    })).toEqual({ ok: false, error: 'kernel-message-too-large', outcomeKnown: true });
    expect(dispatched).toBe(0);
  });

  test('secret-bearing port fails closed while UI port is bounded and adopted', async () => {
    const { browser, kernel } = makeKernel();
    await kernel.ready();
    const port = (name: string) => {
      let disconnected = false;
      const messages: any[] = [];
      return {
        name, sender: firstParty, messages,
        get disconnected() { return disconnected; },
        disconnect() { disconnected = true; },
        postMessage(message: any) { messages.push(message); },
        onDisconnect: makeEvent(),
      };
    };
    const secret = port('private-transfer');
    browser.runtime.onConnect.emit(secret);
    expect(secret.disconnected).toBe(true);
    const ui = port('sidepanel');
    browser.runtime.onConnect.emit(ui);
    expect(ui.messages[0]).toMatchObject({ type: 'kernel/waiting', kernelEpoch: kernel.kernelEpoch });
    const adopted: any[] = [];
    kernel.attachHost({
      epoch: 'host-port', dispatchMessage: async () => ({}),
      adoptPort(value) { adopted.push(value); }, retire() {},
    });
    expect(adopted).toEqual([ui]);
  });

  test('missing synchronous authority refuses registration', () => {
    expect(() => createColdKernelCapture({
      browser: makeBrowser(), queueStore: makeStore(), authority: {},
      isFirstPartySender: () => true, isFirstPartyPort: () => true,
    })).toThrow('cold kernel missing synchronous authority: runtime.onInstalled');
  });
});
