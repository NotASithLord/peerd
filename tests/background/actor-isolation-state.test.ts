import { describe, expect, test } from 'bun:test';
import {
  actorIsolationFailureKey, makeActorIsolationStateStore,
} from '../../extension/background/actor-isolation-state.js';

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
