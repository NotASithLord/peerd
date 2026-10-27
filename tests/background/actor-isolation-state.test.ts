import { describe, expect, test } from 'bun:test';
import {
  actorIsolationFailureKey, makeActorIsolationStateStore, readColdActorIsolation,
} from '../../extension/background/actor-isolation-state.js';
import { ACTOR_WORKER_PROTOCOL } from '../../extension/shared/actor-worker-protocol.js';

const capability = { host: 'background-page-worker' };

const memoryStorage = () => {
  const values: Record<string, any> = {};
  return {
    values,
    storage: {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (items: Record<string, any>) => { Object.assign(values, items); },
      remove: async (key: string) => { delete values[key]; },
    },
  };
};

describe('actor isolation failure state', () => {
  test('persists a retryable failure for the exact host and protocol', async () => {
    const memory = memoryStorage();
    const store = makeActorIsolationStateStore({ storage: memory.storage, protocol: 3, now: () => 42 });

    await store.markUnavailable(capability, 'worker import failed', 'actor_worker_crashed');

    expect(await store.load(capability)).toEqual({
      status: 'temporarily_unavailable',
      host: 'background-page-worker',
      reason: 'worker import failed',
      retryable: true,
    });
    expect(memory.values[actorIsolationFailureKey(capability, 3)]).toMatchObject({
      protocol: 3, code: 'actor_worker_crashed', recordedAt: 42,
    });
  });

  test('a protocol or host change does not inherit a stale failure', async () => {
    const memory = memoryStorage();
    const oldStore = makeActorIsolationStateStore({ storage: memory.storage, protocol: 2 });
    await oldStore.markUnavailable(capability, 'old failure', 'actor_worker_crashed');

    const currentStore = makeActorIsolationStateStore({ storage: memory.storage, protocol: 3 });
    expect(await currentStore.load(capability)).toBeNull();
    expect(await oldStore.load({ host: 'offscreen-document-worker' })).toBeNull();
  });

  test('only an explicit clear removes the matching failure', async () => {
    const memory = memoryStorage();
    const store = makeActorIsolationStateStore({ storage: memory.storage, protocol: 3 });
    await store.markUnavailable(capability, 'failed', 'actor_worker_crashed');

    expect(await store.load(capability)).not.toBeNull();
    await store.clear(capability);
    expect(await store.load(capability)).toBeNull();
  });
});


describe('cold actor isolation projection', () => {
  test.each(['background-page-worker', 'offscreen-document-worker'])('keeps an absent %s record neutral without changing storage', async (host) => {
    const memory = memoryStorage();
    const reads: string[] = [];
    const store = makeActorIsolationStateStore({
      storage: { ...memory.storage, get: async (key) => {
        reads.push(key); return memory.storage.get(key);
      } },
      protocol: ACTOR_WORKER_PROTOCOL,
    });
    expect(await readColdActorIsolation(store, host)).toEqual({
      status: 'not-started', host, reason: null, retryable: false,
    });
    expect(reads).toEqual([actorIsolationFailureKey({ host }, ACTOR_WORKER_PROTOCOL)]);
    expect(memory.values).toEqual({});
  });

  test.each(['background-page-worker', 'offscreen-document-worker'])('keeps the exact stored %s failure across a cold read', async (host) => {
    const memory = memoryStorage();
    const store = makeActorIsolationStateStore({ storage: memory.storage, protocol: ACTOR_WORKER_PROTOCOL });
    await store.markUnavailable({ host }, 'worker startup failed', 'actor_worker_crashed');
    const before = structuredClone(memory.values);
    expect(await readColdActorIsolation(store, host)).toEqual({
      status: 'temporarily_unavailable', host, reason: 'worker startup failed', retryable: true,
    });
    expect(memory.values).toEqual(before);
    expect(await readColdActorIsolation(makeActorIsolationStateStore({
      storage: memory.storage, protocol: ACTOR_WORKER_PROTOCOL + 1,
    }), host)).toMatchObject({ status: 'not-started', retryable: false });
  });

  test.each([new TypeError('storage is unavailable'), 'storage refused'])('fails closed when a cold failure read rejects with %s', async (cause) => {
    const memory = memoryStorage();
    const store = makeActorIsolationStateStore({
      storage: { ...memory.storage, get: async () => { throw cause; } },
      protocol: ACTOR_WORKER_PROTOCOL,
    });
    expect(await readColdActorIsolation(store, capability.host)).toEqual({
      status: 'temporarily_unavailable', host: capability.host, retryable: true,
      reason: cause instanceof Error ? cause.message : cause,
    });
    expect(memory.values).toEqual({});
  });
});
