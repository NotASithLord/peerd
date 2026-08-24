import { describe, expect, test } from 'bun:test';
import {
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../../extension/background/kernel-executable-inventory.js';
import {
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

describe('kernel executable owner', () => {
  test('assigns every executable surface to one exact provenance gate', () => {
    const sender = {};
    const called: string[] = [];
    const gate = (name: string) => () => { called.push(name); return true; };
    const admit = makeKernelExecutableAdmission({
      pod: gate('pod'), webFetch: gate('webFetch'), artifactExport: gate('artifactExport'),
      options: gate('options'), home: gate('home'), app: gate('app'), relay: gate('relay'),
    });
    const expected = new Map([
      ['pod/cancel-io', 'pod'], ['pod/get-meta', 'pod'], ['pod/git', 'pod'],
      ['pod/web-fetch', 'pod'], ['sw/web-fetch', 'webFetch'],
      ['sw/web-fetch-abort', 'webFetch'], ['export/artifact', 'artifactExport'],
      ['import/inspect', 'options'], ['import/apply', 'options'], ['apps/delete', 'home'],
      ['app/actor-chat', 'app'], ['app/call', 'relay'], ['actors/call', 'relay'],
      ['page/call', 'relay'], ['site-fetch/call', 'relay'], ['script/model-call', 'relay'],
      ['script-run/abort', 'relay'], ['a2a/call', 'relay'],
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
    expect(admit('review/run', {}, sender)).toBe(false);
  });

  test('refuses provenance before loading and demand-loads one exact runtime', async () => {
    let loads = 0;
    const owner = createKernelExecutableOwner({
      admit: (_route: string, _message: any, sender: any) => sender === 'trusted',
      runtime: {},
      importRuntime: async () => { loads += 1; return runtimeModule(); },
    });
    expect(await owner.routes['pod/get-meta']({}, 'forged')).toEqual({
      ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true,
    });
    expect(loads).toBe(0);
    expect(await owner.routes['pod/get-meta']({ podId: 'pod-1' }, 'trusted'))
      .toMatchObject({ ok: true, name: 'pod/get-meta', sender: 'trusted' });
    expect(await owner.routes['app/call']({}, 'trusted'))
      .toMatchObject({ ok: true, name: 'app/call' });
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
      importRuntime: async () => runtimeModule(),
    });
    await owner.routes['pod/get-meta']({}, 'forged');
    expect(dependencyLoads).toBe(0);
    await owner.routes['pod/get-meta']({}, 'trusted');
    expect(dependencyLoads).toBe(1);
    await owner.routes['app/call']({}, 'trusted');
    expect(dependencyLoads).toBe(1);
  });

  test('a frozen runtime settles as a known startup failure', async () => {
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {}, loadTimeoutMs: 1,
      importRuntime: () => new Promise(() => {}),
    });
    expect(await owner.routes['import/apply']({}, {})).toMatchObject({
      ok: false, error: 'Temporarily unavailable. Try again.',
      code: 'kernel-executable-runtime-load-timeout', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });
  });

  test('Firefox transfer Port loads only after exact options custody', async () => {
    const optionsSender = {};
    let loads = 0;
    let transferAuthorization: symbol | null = null;
    const owner = createKernelExecutableOwner({
      admit: () => true,
      runtime: {},
      importRuntime: async () => {
        loads += 1;
        return runtimeModule((authorization) => { transferAuthorization = authorization; });
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
});
