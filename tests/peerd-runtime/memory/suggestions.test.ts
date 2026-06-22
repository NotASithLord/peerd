// Suggestion store — kv-backed pending pen for auto-memory proposals.

import { describe, test, expect } from 'bun:test';
import { createSuggestionStore, SUGGESTIONS_KEY } from '../../../extension/peerd-runtime/memory/suggestions.js';
import { MAX_PENDING_SUGGESTIONS } from '../../../extension/peerd-runtime/memory/auto-memory.js';

const makeKv = () => {
  const map = new Map<string, any>();
  return {
    map,
    async get(key: string) { return map.get(key); },
    async set(key: string, value: any) { map.set(key, structuredClone(value)); },
  };
};

const makeStore = () => {
  let n = 0;
  const kv = makeKv();
  const store = createSuggestionStore({ kv, now: () => 1000 + n, makeId: () => `id-${n++}` });
  return { kv, store };
};

describe('createSuggestionStore', () => {
  test('requires a kv adapter', () => {
    expect(() => createSuggestionStore({} as any)).toThrow(TypeError);
  });

  test('addMany stores records with source metadata; listPending returns them', async () => {
    const { store } = makeStore();
    const res = await store.addMany(['works at Hydra'], { sessionId: 's1', sessionTitle: 'GPU chat' });
    expect(res).toEqual({ added: 1, total: 1 });
    const pending = await store.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].text).toBe('works at Hydra');
    expect(pending[0].sessionId).toBe('s1');
    expect(pending[0].sessionTitle).toBe('GPU chat');
    expect(await store.count()).toBe(1);
  });

  test('dedupes against already-pending text (collapsed, case-insensitive)', async () => {
    const { store } = makeStore();
    await store.addMany(['Works at  Hydra'], {});
    const res = await store.addMany(['works at hydra', 'lives in Miami'], {});
    expect(res.added).toBe(1);
    expect(await store.count()).toBe(2);
  });

  test('caps pending at MAX_PENDING_SUGGESTIONS, pruning oldest', async () => {
    const { store } = makeStore();
    for (let i = 0; i < MAX_PENDING_SUGGESTIONS + 5; i++) {
      await store.addMany([`note number ${i}`], {});
    }
    const pending = await store.listPending();
    expect(pending.length).toBe(MAX_PENDING_SUGGESTIONS);
    expect(pending[0].text).toBe('note number 5'); // 0..4 pruned
  });

  test('resolve removes exactly one entry and returns it; missing id errors', async () => {
    const { store } = makeStore();
    await store.addMany(['a', 'b'], {});
    const pending = await store.listPending();
    const res = await store.resolve(pending[0].id);
    expect(res.ok).toBe(true);
    expect(res.suggestion!.text).toBe('a');
    expect(await store.count()).toBe(1);
    expect((await store.resolve('nope')).ok).toBe(false);
  });

  test('corrupt stored payloads read as empty, then heal on the next write', async () => {
    const { kv, store } = makeStore();
    kv.map.set(SUGGESTIONS_KEY, { pending: [{ bad: true }, null, { id: 'ok', text: 'real note' }] });
    const pending = await store.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].text).toBe('real note');
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
