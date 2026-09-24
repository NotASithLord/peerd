import { beforeAll, describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';
import {
  createResultStore,
  MAX_SPILL_TEXT_CHARS,
} from '../../../extension/peerd-runtime/tools/result-store.js';

beforeAll(async () => { await useFakeIndexedDB(); });

let dbSequence = 0;
const makeStore = (now?: () => number, dbName?: string) =>
  createResultStore({ now, dbName: dbName ?? `result-store-test-${++dbSequence}` });

const record = (overrides: Record<string, unknown> = {}) => ({
  key: 'result:opaque-1',
  ownerSessionId: 'chat-1',
  producer: 'script' as const,
  fenced: true,
  originLabel: 'script (fetched web content)',
  text: 'x'.repeat(100),
  ...overrides,
});

describe('createResultStore', () => {
  test('uses opaque handles that reveal no producer or owner', () => {
    const key = makeStore().key();
    expect(key).toMatch(/^result:[0-9a-f-]+$/);
    expect(key).not.toContain('chat-1');
    expect(key).not.toContain('script');
  });

  test('round-trips provenance, ownership, trust, and creation time', async () => {
    const store = makeStore(() => 1_000);
    await store.put(record());
    expect(await store.get('result:opaque-1')).toMatchObject({
      key: 'result:opaque-1',
      ownerSessionId: 'chat-1',
      producer: 'script',
      fenced: true,
      originLabel: 'script (fetched web content)',
      createdAt: 1_000,
    });
  });

  test('evicts the oldest entries by creation time', async () => {
    let clock = 0;
    const store = makeStore(() => ++clock);
    await store.put(record({ key: 'result:oldest' }));
    for (let index = 0; index < 40; index++) {
      await store.put(record({ key: `result:new-${String(index).padStart(2, '0')}` }));
    }
    expect(await store.get('result:oldest')).toBeUndefined();
    expect(await store.get('result:new-00')).toBeDefined();
    expect(await store.get('result:new-39')).toBeDefined();
  });

  test('caps pathological values and survives a new store instance', async () => {
    const dbName = `result-store-shared-${++dbSequence}`;
    await makeStore(() => 5, dbName).put(record({
      key: 'result:persisted',
      text: 'h'.repeat(MAX_SPILL_TEXT_CHARS + 5),
    }));
    const persisted = await makeStore(() => 6, dbName).get('result:persisted');
    expect(persisted?.text.length).toBe(MAX_SPILL_TEXT_CHARS);
    expect(persisted?.ownerSessionId).toBe('chat-1');
  });
});
