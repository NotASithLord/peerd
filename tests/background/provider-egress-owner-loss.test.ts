import { describe, expect, test } from 'bun:test';
import {
  createProviderEgressAuthority,
} from '../../extension/background/provider-egress-authority.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let fail!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, rejectPromise) => {
    resolve = settle;
    fail = rejectPromise;
  });
  return { promise, resolve, fail };
};

const request = {
  providerId: 'anthropic', modelId: 'claude-test',
  nativeBody: {
    model: 'claude-test', stream: true, max_tokens: 64,
    system: '', messages: [{ role: 'user', content: 'hello' }],
  },
};

const grant = (owner: object, signal?: AbortSignal) => ({
  owner, signal, maxOutputTokens: 64,
  permits: (providerId: string, modelId: string) =>
    providerId === 'anthropic' && modelId === 'claude-test',
  redeemOpaque: () => null,
});

const fakeResponse = (reader: Record<string, any>) => ({
  status: 200, statusText: 'OK', headers: new Headers(),
  body: { getReader: () => reader, cancel: reader.cancel },
}) as unknown as Response;

describe('provider egress cleanup after controller loss', () => {
  test('an already-aborted grant never reads credentials or enters transport', async () => {
    let credentialReads = 0;
    let fetches = 0;
    const authority = createProviderEgressAuthority({
      safeFetch: async () => { fetches += 1; return new Response(); },
      vault: {
        getSecret: async () => { credentialReads += 1; return 'vault-key'; },
      },
      settingsStore: { get: () => ({}) },
    });
    const stop = new AbortController();
    stop.abort('controller-worker-already-lost');
    await expect(authority.openInference(
      request, grant({}, stop.signal),
    )).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    expect(credentialReads).toBe(0);
    expect(fetches).toBe(0);
    expect(authority.activeStreams()).toBe(0);
  });

  test('a response arriving after the connect fuse remains a timeout', async () => {
    const fetchEntered = deferred<void>();
    const releaseFetch = deferred<Response>();
    let transportSignal: AbortSignal | null = null;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler) => {
      queueMicrotask(() => {
        if (typeof handler === 'function') handler();
      });
      return 1;
    }) as typeof setTimeout;
    try {
      const authority = createProviderEgressAuthority({
        safeFetch: async (_resource, init) => {
          transportSignal = init?.signal as AbortSignal;
          fetchEntered.resolve();
          return releaseFetch.promise;
        },
        vault: { getSecret: async () => 'vault-key' },
        settingsStore: { get: () => ({}) },
      });
      const opened = authority.openInference(request, grant({}));
      await fetchEntered.promise;
      await Promise.resolve();
      expect((transportSignal as AbortSignal | null)?.aborted).toBe(true);
      releaseFetch.resolve(new Response('late-timeout-response'));
      await expect(opened).resolves.toMatchObject({
        ok: false, code: 'model-egress-connect-timeout', outcomeKnown: true,
      });
      expect(authority.activeStreams()).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('an abort-ignoring fetch cannot publish a stream after owner cleanup', async () => {
    const fetchEntered = deferred<void>();
    const releaseFetch = deferred<Response>();
    let transportSignal: AbortSignal | null = null;
    const authority = createProviderEgressAuthority({
      safeFetch: async (_resource, init) => {
        transportSignal = init?.signal as AbortSignal;
        fetchEntered.resolve();
        // Deliberately ignore the signal, as a buggy/mocked transport or a
        // late browser response can. Authority cleanup must still own the race.
        return releaseFetch.promise;
      },
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'late-stream',
    });
    const owner = {};
    const stop = new AbortController();
    const opened = authority.openInference(request, grant(owner, stop.signal));
    await fetchEntered.promise;
    stop.abort('controller-worker-lost');
    await authority.closeOwner(owner);
    expect((transportSignal as AbortSignal | null)?.aborted).toBe(true);
    releaseFetch.resolve(new Response('event: message_stop\ndata: {}\n\n'));

    await expect(opened).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
  });

  test('a late stream read cannot return bytes after its owner is retired', async () => {
    const readEntered = deferred<void>();
    const releaseRead = deferred<{ done: boolean; value: Uint8Array }>();
    const reader = {
      read: () => { readEntered.resolve(); return releaseRead.promise; },
      cancel: () => new Promise(() => {}),
    };
    const authority = createProviderEgressAuthority({
      safeFetch: async () => fakeResponse(reader),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'late-read-stream',
    });
    const owner = {};
    const opened = await authority.openInference(request, grant(owner));
    expect(opened).toMatchObject({ ok: true, value: { streamId: 'late-read-stream' } });
    const reading = authority.readInferenceChunk(
      { streamId: 'late-read-stream' }, { owner },
    );
    await readEntered.promise;
    await authority.closeOwner(owner);
    releaseRead.resolve({ done: false, value: new TextEncoder().encode('stale') });
    await expect(reading).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
  });

  test('a late stream rejection after owner retirement is known aborted', async () => {
    const readEntered = deferred<void>();
    const releaseRead = deferred<{ done: boolean; value: Uint8Array }>();
    const reader = {
      read: () => { readEntered.resolve(); return releaseRead.promise; },
      cancel: () => new Promise(() => {}),
    };
    const authority = createProviderEgressAuthority({
      safeFetch: async () => fakeResponse(reader),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'late-rejected-read',
    });
    const owner = {};
    await authority.openInference(request, grant(owner));
    const reading = authority.readInferenceChunk(
      { streamId: 'late-rejected-read' }, { owner },
    );
    await readEntered.promise;
    await authority.closeOwner(owner);
    releaseRead.fail(new Error('reader cancelled after owner retirement'));
    await expect(reading).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
  });

  test('a probe response that arrives after owner retirement is discarded', async () => {
    const fetchEntered = deferred<void>();
    const releaseFetch = deferred<Response>();
    let cancelled = false;
    const authority = createProviderEgressAuthority({
      safeFetch: async () => { fetchEntered.resolve(); return releaseFetch.promise; },
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
    });
    const owner = {};
    const probing = authority.readModelInventory({ providerId: 'openrouter' }, {
      owner, permitsProvider: (providerId: string) => providerId === 'openrouter',
    });
    await fetchEntered.promise;
    await authority.closeOwner(owner);
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    releaseFetch.resolve(new Response(body));
    await expect(probing).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test('a probe body read that settles late cannot escape owner retirement', async () => {
    const readEntered = deferred<void>();
    const releaseRead = deferred<{ done: boolean; value: Uint8Array }>();
    let cancelled = false;
    const reader = {
      read: () => { readEntered.resolve(); return releaseRead.promise; },
      cancel: () => { cancelled = true; return Promise.resolve(); },
    };
    const authority = createProviderEgressAuthority({
      safeFetch: async () => fakeResponse(reader),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
    });
    const owner = {};
    const probing = authority.readModelInventory({ providerId: 'openrouter' }, {
      owner, permitsProvider: (providerId: string) => providerId === 'openrouter',
    });
    await readEntered.promise;
    await authority.closeOwner(owner);
    releaseRead.resolve({ done: false, value: new TextEncoder().encode('stale-probe') });
    await expect(probing).resolves.toMatchObject({
      ok: false, code: 'model-egress-aborted', outcomeKnown: true,
    });
    expect(cancelled).toBe(true);
  });

  test('a duplicate generated stream id preserves the first stream', async () => {
    let fetches = 0;
    let collisionCancelled = false;
    const collisionBody = new ReadableStream({
      cancel: () => { collisionCancelled = true; },
    });
    const authority = createProviderEgressAuthority({
      safeFetch: async () => ++fetches === 1
        ? new Response('first-stream') : new Response(collisionBody),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'duplicate-stream',
    });
    const owner = {};
    expect(await authority.openInference(request, grant(owner)))
      .toMatchObject({ ok: true, value: { streamId: 'duplicate-stream' } });
    expect(await authority.openInference(request, grant(owner))).toMatchObject({
      ok: false, code: 'model-egress-stream-collision', outcomeKnown: true,
    });
    await Promise.resolve();
    expect(collisionCancelled).toBe(true);
    expect(authority.activeStreams()).toBe(1);
    const first = await authority.readInferenceChunk(
      { streamId: 'duplicate-stream' }, { owner },
    );
    expect(new TextDecoder().decode((first as any).value.chunk)).toBe('first-stream');
    await authority.cancelInference({ streamId: 'duplicate-stream' }, { owner });
    expect(authority.activeStreams()).toBe(0);
  });

  test('owner cleanup does not wait for a transport cancel promise', async () => {
    const authority = createProviderEgressAuthority({
      safeFetch: async () => fakeResponse({
        read: async () => new Promise(() => {}),
        cancel: () => new Promise(() => {}),
      }),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'uncancellable-stream',
    });
    const owner = {};
    expect(await authority.openInference(request, grant(owner)))
      .toMatchObject({ ok: true });
    const cleanup = authority.closeOwner(owner).then(() => 'closed');
    expect(await Promise.race([
      cleanup,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ])).toBe('closed');
    expect(authority.activeStreams()).toBe(0);
  });
});
