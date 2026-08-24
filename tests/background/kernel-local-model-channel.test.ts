import { describe, expect, test } from 'bun:test';
import { makeKernelLocalModelRoutes } from '../../extension/background/kernel-local-routes.js';
import {
  LOCAL_MODEL_CHANNEL_OFFER,
  LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT,
  parseLocalModelChannelOffer,
} from '../../extension/shared/feature-lease-protocol.js';
import { acceptLocalModelOffer } from '../../extension/offscreen/local-model.js';
import { admitLocalModelChannelOffer } from '../../extension/offscreen/supervisor-channels.js';

const lease = Object.freeze({
  scope: 'model-host', leaseId: 'model-lease', generation: 1,
  buildId: `0.7.0:${'a'.repeat(64)}`, kernelEpoch: 'model-kernel', hostEpoch: 'model-host',
});

const makeRoutes = (handle: (offer: any, port: MessagePort) => void, overrides: any = {}) => {
  const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
  const calls: string[] = [];
  const routes = makeKernelLocalModelRoutes({
    featureHost: { runtime: {
      runWithLease: async (scope: string, operation: any) => {
        calls.push(`bounded:${scope}`);
        return operation(lease);
      },
      acquire: async (scope: string) => {
        calls.push(`durable:${scope}`);
        return { ok: true, ...lease };
      },
    } },
    offscreenUrl,
    pushState: () => { calls.push('push'); },
    clientsApi: { matchAll: async () => [{
      url: offscreenUrl,
      postMessage: (offer: any, ports: MessagePort[]) => handle(offer, ports[0]),
    }] },
    timeoutMs: 20,
    newId: () => 'local-model-channel-1',
    ...overrides,
  });
  return { routes, calls };
};

describe('native local-model private channel', () => {
  test('binds each read to one exact model-host lease and strips the wire envelope', async () => {
    const offers: any[] = [];
    const { routes, calls } = makeRoutes((offer, port) => {
      offers.push(offer);
      port.start();
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_RESULT,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ok: true,
        model: 'gemma-4-e2b',
        downloaded: true,
        available: false,
        loading: false,
        outcomeKnown: true,
      });
    });
    expect(await routes['local-model/status']({
      model: 'gemma-4-e2b', includeSupport: true,
    })).toEqual({
      ok: true, model: 'gemma-4-e2b', downloaded: true,
      available: false, loading: false, outcomeKnown: true,
    });
    expect(parseLocalModelChannelOffer(offers[0])).toEqual(offers[0]);
    expect(offers[0]).toMatchObject({
      type: LOCAL_MODEL_CHANNEL_OFFER,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      method: 'status',
      args: { model: 'gemma-4-e2b', includeSupport: true },
      lease,
    });
    expect(calls).toEqual(['bounded:model-host', 'push']);
  });

  test('holds a durable model lease for init and classifies a lost receipt unknown', async () => {
    const { routes, calls } = makeRoutes((_offer, port) => { port.start(); });
    await expect(routes['local-model/init']({ model: 'gemma-4-e2b' }))
      .rejects.toMatchObject({
        code: 'local-model-host-timeout', outcomeKnown: false,
        outcomeKind: 'unknown', retryable: false,
      });
    expect(calls).toEqual(['durable:model-host']);
  });

  test('a missing exact offscreen owner is known-safe and Firefox refuses without host work', async () => {
    const base = makeRoutes(() => {}, {
      clientsApi: { matchAll: async () => [] },
    });
    await expect(base.routes['local-model/status']()).rejects.toMatchObject({
      code: 'local-model-host-unavailable', outcomeKnown: true,
    });
    const unsupported = makeRoutes(() => {}, { available: false });
    expect(await unsupported.routes['local-model/init']()).toMatchObject({
      ok: false, facility: 'localWebGpuHost', reasonCode: 'host_unsupported',
    });
    expect(unsupported.calls).toEqual([]);
  });

  test('the lazy host rechecks the exact lease and returns a bounded catalog', async () => {
    const channel = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port1.start();
    });
    const offer = {
      type: LOCAL_MODEL_CHANNEL_OFFER,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: 'local-model-host-test',
      method: 'catalog',
      args: { includeSupport: false },
      lease,
    };
    expect(acceptLocalModelOffer({ data: offer, ports: [channel.port2] }, {
      ownsLease: (candidate: any) => candidate === lease,
    })).toBe(true);
    const result = await reply;
    expect(result).toMatchObject({
      type: LOCAL_MODEL_CHANNEL_RESULT,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: true,
      outcomeKnown: true,
    });
    expect(Array.isArray(result.models)).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  test('rejects malformed operation names, model bounds, and missing leases', () => {
    const valid = {
      type: LOCAL_MODEL_CHANNEL_OFFER,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: 'local-model-channel',
      method: 'probe',
      args: {},
      lease,
    };
    expect(parseLocalModelChannelOffer(valid)).toEqual(valid);
    expect(parseLocalModelChannelOffer({ ...valid, method: 'generate' })).toBeNull();
    expect(parseLocalModelChannelOffer({ ...valid, args: { model: 'x'.repeat(129) } })).toBeNull();
    expect(parseLocalModelChannelOffer({ ...valid, lease: null })).toBeNull();
  });

  test('the cold supervisor requires trusted exact-worker provenance, one port, and the live lease', () => {
    const workerUrl = 'chrome-extension://id/background/vault-kernel.js';
    const event: any = {
      isTrusted: true, source: { scriptURL: workerUrl }, ports: [{}],
      data: {
        type: LOCAL_MODEL_CHANNEL_OFFER,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: 'local-model-channel', method: 'probe', args: {}, lease,
      },
    };
    expect(admitLocalModelChannelOffer(event, workerUrl, (candidate) => candidate === lease))
      .toMatchObject({ matched: true, ok: true });
    expect(admitLocalModelChannelOffer({ ...event, isTrusted: false }, workerUrl, () => true).ok)
      .toBe(false);
    expect(admitLocalModelChannelOffer({ ...event, ports: [{}, {}] }, workerUrl, () => true).ok)
      .toBe(false);
    expect(admitLocalModelChannelOffer(event, workerUrl, () => false).ok).toBe(false);
  });
});
