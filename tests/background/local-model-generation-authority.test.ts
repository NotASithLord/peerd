import { describe, expect, test } from 'bun:test';
import { createLocalModelGenerationAuthority } from '../../extension/background/local-model-generation-authority.js';
import {
  LOCAL_MODEL_CHANNEL_CANCEL,
  LOCAL_MODEL_CHANNEL_CHUNK,
  LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT,
} from '../../extension/shared/feature-lease-protocol.js';

const request = {
  messages: [{ role: 'user', content: 'hello' }],
  system: 'system',
  tools: [],
  model: 'gemma-4-e2b',
  maxTokens: 32,
};

const makeAuthority = (host: (offer: any, port: MessagePort) => void) => {
  let sequence = 0;
  const client = {
    url: 'chrome-extension://fixture/offscreen/offscreen.html',
    postMessage: (offer: any, ports: MessagePort[]) => host(offer, ports[0]),
  };
  return createLocalModelGenerationAuthority({
    featureHost: {
      runtime: {
        runWithLease: async (_scope: string, operation: (lease: any) => Promise<any>) =>
          operation({ scope: 'model-host', leaseId: 'lease-1234' }),
      },
    },
    offscreenUrl: client.url,
    clientsApi: { matchAll: async () => [client] },
    newId: () => `local-channel-${++sequence}`,
  });
};

describe('local model generation authority', () => {
  test('owns the exact host channel and streams bounded tokens to one owner', async () => {
    const offers: any[] = [];
    const authority = makeAuthority((offer, port) => {
      offers.push(offer);
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_RESULT,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ok: true,
        started: true,
        outcomeKnown: true,
      });
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_CHUNK,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        token: 'hello',
      });
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_RESULT,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ok: true,
        done: true,
        outcomeKnown: true,
      });
    });
    const owner = {};
    const streamId = await authority.open(request, owner, undefined);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ method: 'generate', args: request });
    await expect(authority.read(streamId, {})).rejects.toMatchObject({
      code: 'local-model-stream-invalid', outcomeKnown: true,
    });
    expect(await authority.read(streamId, owner)).toEqual({ done: false, token: 'hello' });
    expect(await authority.read(streamId, owner)).toEqual({ done: true });
    expect(authority.activeStreams()).toBe(0);
  });

  test('sends one exact cancellation and retires all streams for an owner', async () => {
    const cancellations: any[] = [];
    const authority = makeAuthority((offer, port) => {
      port.onmessage = (event) => {
        if (event.data?.type === LOCAL_MODEL_CHANNEL_CANCEL) cancellations.push(event.data);
      };
      port.start();
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_RESULT,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ok: true,
        started: true,
        outcomeKnown: true,
      });
    });
    const owner = {};
    const streamId = await authority.open(request, owner, undefined);
    await authority.cancel(streamId, owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      type: LOCAL_MODEL_CHANNEL_CANCEL,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
    });
    expect(authority.activeStreams()).toBe(0);

    await authority.open(request, owner, undefined);
    await authority.closeOwner(owner);
    expect(authority.activeStreams()).toBe(0);
  });

  test('owner retirement rejects an open still waiting for host readiness', async () => {
    let offered!: () => void;
    const offerSeen = new Promise<void>((resolve) => { offered = resolve; });
    const hostPorts: MessagePort[] = [];
    const authority = makeAuthority((_offer, port) => {
      hostPorts.push(port);
      offered();
    });
    const owner = {};
    const opened = authority.open(request, owner, undefined);
    await offerSeen;

    await authority.closeOwner(owner);
    await expect(opened).rejects.toMatchObject({
      code: 'local-model-generation-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);

    hostPorts[0]?.postMessage({
      type: LOCAL_MODEL_CHANNEL_RESULT,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: 'late-readiness-cannot-reopen',
      ok: true,
      started: true,
      outcomeKnown: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authority.activeStreams()).toBe(0);
  });

  test('preserves a known host failure and refuses an invalid host topology', async () => {
    const authority = makeAuthority((offer, port) => {
      port.postMessage({
        type: LOCAL_MODEL_CHANNEL_RESULT,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ok: false,
        done: true,
        outcomeKnown: true,
        error: 'generation refused',
      });
    });
    await expect(authority.open(request, {}, undefined)).rejects.toMatchObject({
      code: 'local-model-generation-failed', outcomeKnown: true,
    });

    const unavailable = createLocalModelGenerationAuthority({
      featureHost: { runtime: { runWithLease: async (_scope: string, operation: any) =>
        operation({ scope: 'model-host' }) } },
      offscreenUrl: 'chrome-extension://fixture/offscreen/offscreen.html',
      clientsApi: { matchAll: async () => [] },
    });
    await expect(unavailable.open(request, {}, undefined)).rejects.toMatchObject({
      code: 'local-model-host-unavailable', outcomeKnown: true,
    });
  });
});
