import { describe, expect, test } from 'bun:test';
import {
  createLocalModelGenerationAuthority,
} from '../../extension/background/local-model-generation-authority.js';
import {
  LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT,
} from '../../extension/shared/feature-lease-protocol.js';

const request = {
  messages: [{ role: 'user', content: 'hello' }], system: '', tools: [],
  model: 'gemma-test', maxTokens: 16,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

const authorityWithHost = ({
  ids = ['stream-1', 'channel-1'], host,
}: {
  ids?: string[];
  host: (offer: any, port: MessagePort) => void;
}) => {
  const queue = [...ids];
  const client = {
    url: 'chrome-extension://fixture/offscreen/offscreen.html',
    postMessage: (offer: any, ports: MessagePort[]) => host(offer, ports[0]),
  };
  return createLocalModelGenerationAuthority({
    featureHost: { runtime: { runWithLease: async (
      _scope: string, operation: (lease: any) => Promise<any>,
    ) => operation({ scope: 'model-host', leaseId: 'lease-local' }) } },
    offscreenUrl: client.url,
    clientsApi: { matchAll: async () => [client] },
    newId: () => queue.shift() ?? crypto.randomUUID(),
  });
};

describe('local model ownership after controller loss', () => {
  test('an initially aborted owner never dispatches a local generation', async () => {
    let leases = 0;
    const stop = new AbortController();
    stop.abort('controller-worker-lost');
    const authority = createLocalModelGenerationAuthority({
      featureHost: { runtime: { runWithLease: async () => { leases += 1; } } } as any,
      offscreenUrl: 'chrome-extension://fixture/offscreen/offscreen.html',
      clientsApi: { matchAll: async () => [] },
      newId: () => 'never-dispatched',
    });
    await expect(authority.open(request, {}, stop.signal)).rejects.toMatchObject({
      code: 'local-model-generation-aborted', outcomeKnown: true,
    });
    expect(leases).toBe(0);
    expect(authority.activeStreams()).toBe(0);
  });

  test('owner cleanup settles a pre-ready open even if the host never replies', async () => {
    const dispatched = deferred<void>();
    const authority = authorityWithHost({
      host: () => { dispatched.resolve(); },
    });
    const owner = {};
    const opening = authority.open(request, owner, undefined).then(
      () => ({ code: 'unexpected-success' }),
      (error) => error,
    );
    await dispatched.promise;
    await authority.closeOwner(owner);
    const outcome = await Promise.race([
      opening,
      new Promise((resolve) => setTimeout(() => resolve({ code: 'still-pending' }), 50)),
    ]);
    expect(outcome).toMatchObject({
      code: 'local-model-generation-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
  });

  test('late host readiness cannot resurrect a retired local stream', async () => {
    const dispatched = deferred<{ offer: any; port: MessagePort }>();
    const authority = authorityWithHost({
      host: (offer, port) => { dispatched.resolve({ offer, port }); },
    });
    const owner = {};
    const opening = authority.open(request, owner, undefined);
    const { offer, port } = await dispatched.promise;
    await authority.closeOwner(owner);
    port.postMessage({
      type: LOCAL_MODEL_CHANNEL_RESULT,
      protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: true, started: true, outcomeKnown: true,
    });
    await expect(opening).rejects.toMatchObject({
      code: 'local-model-generation-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
  });

  test('a duplicate local stream id preserves the first generation', async () => {
    let hosts = 0;
    const authority = authorityWithHost({
      ids: ['duplicate-local', 'channel-first', 'duplicate-local'],
      host: (offer, port) => {
        hosts += 1;
        port.postMessage({
          type: LOCAL_MODEL_CHANNEL_RESULT,
          protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
          channelId: offer.channelId,
          ok: true, started: true, outcomeKnown: true,
        });
      },
    });
    const owner = {};
    const first = await authority.open(request, owner, undefined);
    expect(first).toBe('duplicate-local');
    await expect(authority.open(request, owner, undefined)).rejects.toMatchObject({
      code: 'local-model-stream-collision', outcomeKnown: true,
    });
    expect(hosts).toBe(1);
    expect(authority.activeStreams()).toBe(1);
    await authority.cancel(first, owner);
    expect(authority.activeStreams()).toBe(0);
  });
});
