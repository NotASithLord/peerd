import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../../extension/shared/kernel-feature-route-inventory.js';
import {
  createKernelExecutableControl,
  createKernelExecutableOwner,
  makeKernelDwebAdmission,
  makeKernelExecutableAdmission,
} from '../../extension/background/kernel-executable-owner.js';

const runtimeModule = (onTransfer = (_authorization: symbol) => {}) => ({
  createKernelExecutableRuntime: () => ({
    routes: Object.fromEntries(KERNEL_EXECUTABLE_ROUTE_NAMES.map((name) => [name,
      (message: any, sender: any) => ({ ok: true, name, message, sender })])),
    makeTransferRoutes: (authorization: symbol) => {
      onTransfer(authorization);
      return Object.fromEntries(KERNEL_TRANSFER_ROUTE_NAMES.map((name) => [name,
        (message: any) => ({ ok: true, name, authorization: message.privateTransferAuthorization })]));
    },
  }),
});
const runtimeFactory = (onTransfer = (_authorization: symbol) => {}) =>
  runtimeModule(onTransfer).createKernelExecutableRuntime;
const liveLoaders = () => ({
  loadEngineLive: async () => ({}),
  loadActorChatRelays: async () => ({}),
  loadAppRuntimeRelays: async () => ({}),
  loadRelayRoutes: async () => ({}),
  loadTransferLive: async () => ({}),
  loadDwebRoutes: async () => ({}),
});

describe('kernel executable owner', () => {
  test('has no physical rich-owner dependency', () => {
    const background = join(import.meta.dir, '../../extension/background');
    const owner = readFileSync(join(background, 'kernel-executable-owner.js'), 'utf8');
    const demand = readFileSync(join(background, 'kernel-demand-plane.js'), 'utf8');
    expect(owner).not.toContain('loadRich');
    for (const loader of [
      'loadEngineLive', 'loadActorChatRelays', 'loadAppRuntimeRelays',
      'loadRelayRoutes', 'loadTransferLive', 'loadDwebRoutes',
    ]) expect(demand).toContain(`${loader}:`);
  });

  test('requires exact live loaders instead of a rich aggregate', () => {
    expect(() => createKernelExecutableControl({
      loadRich: async () => ({}),
    })).toThrow('kernel-executable-control-config-invalid');
  });

  test('keeps exact live loaders independently lazy, cached, and bounded', async () => {
    const relaySender = {};
    const homeSender = {};
    const calls: string[] = [];
    let engineLoads = 0;
    let runtimeDeps: any;
    const control = createKernelExecutableControl({
      runtimeId: 'runtime', firefox: false, dweb: true, privateTransfer: false,
      liveLoadTimeoutMs: 1,
      createRuntime: (deps: any) => {
        runtimeDeps = deps;
        return runtimeFactory()();
      },
      loadEngineLive: () => {
        engineLoads += 1;
        return engineLoads === 1 ? new Promise(() => {}) : Promise.resolve({});
      },
      loadActorChatRelays: async () => { calls.push('actor-chat'); return {}; },
      loadAppRuntimeRelays: async () => { calls.push('app-runtime'); return {}; },
      loadRelayRoutes: async () => { calls.push('relay'); return {}; },
      loadTransferLive: async () => { calls.push('transfer'); return {}; },
      loadDwebRoutes: async () => {
        calls.push('dweb');
        return Object.fromEntries(KERNEL_DWEB_ROUTE_NAMES.map((name) => [
          name, () => ({ ok: true, name }),
        ]));
      },
      owns: {
        home: (sender: any) => sender === homeSender,
        options: () => false,
        offscreen: (sender: any) => sender === relaySender,
        app: () => false,
      },
      paths: {
        app: 'chrome-extension://runtime/engine-tabs/app-tab/app-tab.html',
        notebook: 'chrome-extension://runtime/engine-tabs/notebook-tab/notebook-tab.html',
        vm: 'chrome-extension://runtime/engine-tabs/vm-tab/vm-tab.html',
        pod: 'chrome-extension://runtime/engine-tabs/pod-tab/pod-tab.html',
        options: 'chrome-extension://runtime/options/options.html',
      },
    });
    expect(await control.routes['app-code/observe']({}, relaySender)).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    await runtimeDeps.actorChat.load();
    await runtimeDeps.appRuntime.load();
    await runtimeDeps.relay.load();
    await runtimeDeps.transfer.load();
    await runtimeDeps.actorChat.load();
    expect(calls).toEqual(['actor-chat', 'app-runtime', 'relay', 'transfer']);
    expect(await control.routes['dweb/base/start']({}, homeSender))
      .toMatchObject({ ok: true, name: 'dweb/base/start' });
    expect(calls).toEqual(['actor-chat', 'app-runtime', 'relay', 'transfer', 'dweb']);
    const frozen = await runtimeDeps.engine.load().catch((cause: unknown) => cause);
    expect(frozen).toMatchObject({
      code: 'kernel-executable-engine-live-load-timeout',
      outcomeKnown: true, phase: 'startup', retryable: true,
    });
    expect(await runtimeDeps.engine.load()).toEqual({});
    expect(engineLoads).toBe(2);
  });

  test('assigns every executable surface to one exact provenance gate', () => {
    const sender = {};
    const called: string[] = [];
    const gate = (name: string) => () => { called.push(name); return true; };
    const admit = makeKernelExecutableAdmission({
      pod: gate('pod'), webFetch: gate('webFetch'), artifactExport: gate('artifactExport'),
      options: gate('options'), home: gate('home'), app: gate('app'), relay: gate('relay'),
      engine: gate('engine'),
    });
    const expected = new Map([
      ['pod/cancel-io', 'pod'], ['pod/get-meta', 'pod'], ['pod/git', 'pod'],
      ['pod/web-fetch', 'pod'], ['sw/web-fetch', 'webFetch'],
      ['sw/web-fetch-abort', 'webFetch'], ['export/artifact', 'artifactExport'],
      ['import/inspect', 'options'], ['import/apply', 'options'], ['apps/delete', 'home'],
      ['app/actor-chat', 'app'], ['app-code/observe', 'relay'],
      ['app-code/act', 'relay'], ['actors/call', 'relay'],
      ['page/call', 'relay'], ['site-fetch/call', 'relay'], ['script/model-call', 'relay'],
      ['script-run/abort', 'relay'], ['a2a/call', 'relay'],
      ['vm/tab-ready', 'engine'], ['js/tab-ready', 'engine'],
      ['pod/tab-adopt', 'engine'], ['app/tab-ready', 'engine'],
      ['app/actor-retry', 'engine'],
    ]);
    for (const [route, owner] of expected) {
      called.length = 0;
      expect(admit(route, {}, sender)).toBe(true);
      expect(called).toEqual([owner]);
    }
    expect(admit('review/run', {}, sender)).toBe(false);
    expect(admit('actor/spawn', {}, sender)).toBe(false);
  });

  test('dweb storage, app bridge, and human controls have disjoint custody', () => {
    const sender = {};
    const called: string[] = [];
    const gate = (name: string) => () => { called.push(name); return true; };
    const admit = makeKernelDwebAdmission({
      offscreen: gate('offscreen'), app: gate('app'), home: gate('home'),
      notebook: gate('notebook'),
    });
    for (const route of [
      'dweb/app-install', 'dweb/app-record-served', 'dweb/app-snapshot',
      'dweb/app-update', 'dweb/meta-admit', 'dweb/self-apply-surface',
      'dweb/self-prepare-offer', 'dweb/self-read-surface',
    ]) {
      called.length = 0;
      expect(admit(route, {}, sender)).toBe(true);
      expect(called).toEqual(['offscreen']);
    }
    for (const route of ['dweb/audit', 'dweb/base/room']) {
      called.length = 0;
      expect(admit(route, {}, sender)).toBe(true);
      expect(called).toEqual(['app']);
    }
    called.length = 0;
    expect(admit('dweb/distributed/info', {}, sender)).toBe(true);
    expect(called).toEqual(['home']);
    called.length = 0;
    expect(admit('dweb/base/start', {}, sender)).toBe(true);
    expect(called).toEqual(['home']);
    const notebookOnly = makeKernelDwebAdmission({
      offscreen: () => false, app: () => false, home: () => false, notebook: () => true,
    });
    expect(notebookOnly('dweb/distributed/info', {}, sender)).toBe(true);
    expect(notebookOnly('dweb/base/start', {}, sender)).toBe(false);
    const appOnly = makeKernelDwebAdmission({
      offscreen: () => false, app: () => true, home: () => false, notebook: () => false,
    });
    expect(appOnly('dweb/audit', {}, sender)).toBe(true);
    expect(appOnly('dweb/base/start', {}, sender)).toBe(false);
    expect(admit('review/run', {}, sender)).toBe(false);
  });

  test('refuses provenance before loading and demand-loads one exact runtime', async () => {
    let loads = 0;
    const owner = createKernelExecutableOwner({
      admit: (_route: string, _message: any, sender: any) => sender === 'trusted',
      runtime: {},
      createRuntime: () => { loads += 1; return runtimeFactory()(); },
    });
    expect(await owner.routes['pod/get-meta']({}, 'forged')).toEqual({
      ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true,
    });
    expect(loads).toBe(0);
    expect(await owner.routes['pod/get-meta']({ podId: 'pod-1' }, 'trusted'))
      .toMatchObject({ ok: true, name: 'pod/get-meta', sender: 'trusted' });
    expect(await owner.routes['app-code/observe']({}, 'trusted'))
      .toMatchObject({ ok: true, name: 'app-code/observe' });
    expect(loads).toBe(1);
  });

  test('loads the live dependency bag only after exact provenance', async () => {
    let dependencyLoads = 0;
    const owner = createKernelExecutableOwner({
      admit: (_route: string, _message: any, sender: any) => sender === 'trusted',
      loadRuntimeDeps: async () => {
        dependencyLoads += 1;
        return {};
      },
      createRuntime: runtimeFactory(),
    });
    await owner.routes['pod/get-meta']({}, 'forged');
    expect(dependencyLoads).toBe(0);
    await owner.routes['pod/get-meta']({}, 'trusted');
    expect(dependencyLoads).toBe(1);
    await owner.routes['app-code/act']({}, 'trusted');
    expect(dependencyLoads).toBe(1);
  });

  test('engine attach messages require the exact engine document and instance', async () => {
    const url = (kind: string, id: string) =>
      `chrome-extension://runtime/engine-tabs/${kind}-tab/${kind}-tab.html#${id}`;
    const sender = (kind: string, id: string) => ({
      id: 'runtime', url: url(kind, id), tab: { id: 7, url: url(kind, id) },
    });
    let loads = 0;
    const control = createKernelExecutableControl({
      runtimeId: 'runtime', firefox: false, dweb: false,
      createRuntime: () => { loads += 1; return runtimeFactory()(); },
      ...liveLoaders(),
      owns: {
        home: () => false, options: () => false, offscreen: () => false,
        app: (value: any, appId: string) => value === 'app-sender' && appId === 'app-1',
      },
      paths: {
        app: 'chrome-extension://runtime/engine-tabs/app-tab/app-tab.html',
        notebook: 'chrome-extension://runtime/engine-tabs/notebook-tab/notebook-tab.html',
        vm: 'chrome-extension://runtime/engine-tabs/vm-tab/vm-tab.html',
        pod: 'chrome-extension://runtime/engine-tabs/pod-tab/pod-tab.html',
        options: 'chrome-extension://runtime/options/options.html',
      },
    });
    expect(await control.routes['vm/tab-ready']({ vmId: 'vm-1' }, sender('vm', 'vm-2')))
      .toMatchObject({ ok: false, error: 'kernel-route-unauthorized' });
    expect(await control.routes['js/tab-ready'](
      { notebookId: 'notebook-1' }, sender('notebook', 'notebook-2'),
    )).toMatchObject({ ok: false, error: 'kernel-route-unauthorized' });
    expect(await control.routes['pod/tab-adopt'](
      { podId: 'pod-1' }, sender('pod', 'pod-2'),
    )).toMatchObject({ ok: false, error: 'kernel-route-unauthorized' });
    expect(await control.routes['app/tab-ready']({ appId: 'app-2' }, 'app-sender'))
      .toMatchObject({ ok: false, error: 'kernel-route-unauthorized' });
    expect(loads).toBe(0);

    expect(await control.routes['vm/tab-ready']({ vmId: 'vm-1' }, sender('vm', 'vm-1')))
      .toMatchObject({ ok: true, name: 'vm/tab-ready' });
    expect(await control.routes['js/tab-ready'](
      { notebookId: 'notebook-1' }, sender('notebook', 'notebook-1'),
    )).toMatchObject({ ok: true, name: 'js/tab-ready' });
    expect(await control.routes['pod/tab-adopt'](
      { podId: 'pod-1' }, sender('pod', 'pod-1'),
    )).toMatchObject({ ok: true, name: 'pod/tab-adopt' });
    expect(await control.routes['app/actor-retry']({ appId: 'app-1' }, 'app-sender'))
      .toMatchObject({ ok: true, name: 'app/actor-retry' });
    expect(loads).toBe(1);
  });

  test('a frozen runtime settles as a known startup failure', async () => {
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {}, loadTimeoutMs: 1,
      createRuntime: () => new Promise(() => {}),
    });
    expect(await owner.routes['import/apply']({}, {})).toMatchObject({
      ok: false, error: 'Temporarily unavailable. Try again.',
      code: 'kernel-executable-runtime-load-timeout', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });
  });

  test('an asynchronous route failure never masquerades as a safe retry', async () => {
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {},
      createRuntime: async () => ({
        routes: Object.fromEntries(KERNEL_EXECUTABLE_ROUTE_NAMES.map((name) => [name,
          async () => { throw Object.assign(new Error('lost reply'), { phase: 'startup' }); }])),
        makeTransferRoutes: () => ({}),
      }),
    });
    expect(await owner.routes['import/apply']()).toMatchObject({
      ok: false, code: 'kernel-executable-dispatch-failed',
      outcomeKnown: false, retryable: false,
    });
  });

  test('Firefox transfer Port loads only after exact options custody', async () => {
    const optionsSender = {};
    let loads = 0;
    let transferAuthorization: symbol | null = null;
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {},
      createRuntime: () => {
        loads += 1;
        return runtimeFactory((authorization) => { transferAuthorization = authorization; })();
      },
      privateTransfer: { isOptionsSender: (sender: any) => sender === optionsSender },
    });
    expect(owner.routes['private-transfer/open']).toBeUndefined();
    let disconnected = 0;
    expect(owner.attachPrivateTransfer?.({
      sender: {}, disconnect: () => { disconnected += 1; },
    })).toBe(false);
    expect({ disconnected, loads }).toEqual({ disconnected: 1, loads: 0 });

    const listeners: Array<(message: any) => void> = [];
    const replies: any[] = [];
    const port: any = {
      sender: optionsSender,
      onMessage: { addListener: (listener: (message: any) => void) => listeners.push(listener) },
      onDisconnect: { addListener: () => {} },
      postMessage: (message: any) => replies.push(message),
    };
    expect(owner.attachPrivateTransfer?.(port)).toBe(true);
    expect(loads).toBe(0);
    listeners[0]({
      type: 'private-transfer/request', requestId: 'request-1',
      message: { type: 'transfer/import' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toBe(1);
    expect(typeof transferAuthorization).toBe('symbol');
    expect(replies[0]).toMatchObject({
      type: 'private-transfer/response', requestId: 'request-1', ok: true,
      reply: { ok: true, name: 'transfer/import' },
    });
    expect(replies[0].reply.authorization).toBe(transferAuthorization);
  });

  test('Chrome channel creation refuses forged senders before client lookup', async () => {
    const optionsSender = { url: 'chrome-extension://peerd/options.html' };
    let lookups = 0;
    const channel = new MessageChannel();
    const offers: any[] = [];
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {},
      createRuntime: runtimeFactory(),
      privateTransfer: {
        isOptionsSender: (sender: any) => sender === optionsSender,
        listWindowClients: async () => {
          lookups += 1;
          return [{
            url: optionsSender.url,
            postMessage: (message: any, transfer: any[]) => offers.push({ message, transfer }),
          }];
        },
        optionsUrl: optionsSender.url,
        createChannel: () => channel,
      },
    });
    const open = owner.routes['private-transfer/open'];
    expect(await open({ requestId: 'request-1' }, { url: optionsSender.url }))
      .toEqual({ ok: false, error: 'private-transfer-channel-refused' });
    expect(lookups).toBe(0);
    expect(await open({ requestId: 'request-1' }, optionsSender)).toEqual({ ok: true });
    expect(offers[0]).toMatchObject({
      message: { type: 'private-transfer/channel', requestId: 'request-1' },
    });
    expect(offers[0].transfer[0]).toBe(channel.port2);
    channel.port1.close();
    channel.port2.close();
  });
});
