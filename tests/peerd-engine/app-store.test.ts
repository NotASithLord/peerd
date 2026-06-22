import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';

let appStore: typeof import('../../extension/peerd-engine/app-store.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  appStore = await import('../../extension/peerd-engine/app-store.js');
});

// Each test resets the DB so state doesn't leak across cases. Done by
// dropping the IDB DB and re-importing so the cached open promise is
// fresh — simpler than threading a reset helper through the module.
beforeEach(async () => {
  globalThis.indexedDB.deleteDatabase('peerd-app-bodies');
});

describe('app body store', () => {
  test('put + get roundtrips', async () => {
    await appStore.putAppBody('app-1', '<p>hello</p>');
    expect(await appStore.getAppBody('app-1')).toBe('<p>hello</p>');
  });

  test('get returns null for unknown id', async () => {
    expect(await appStore.getAppBody('app-missing')).toBeNull();
  });

  test('put overwrites', async () => {
    await appStore.putAppBody('app-1', 'v1');
    await appStore.putAppBody('app-1', 'v2');
    expect(await appStore.getAppBody('app-1')).toBe('v2');
  });

  test('delete removes the body', async () => {
    await appStore.putAppBody('app-1', 'gone');
    await appStore.deleteAppBody('app-1');
    expect(await appStore.getAppBody('app-1')).toBeNull();
  });

  test('searchBodies finds substring matches with snippets', async () => {
    await appStore.putAppBody('app-a', '<p>Hello world from peerd</p>');
    await appStore.putAppBody('app-b', '<p>completely different</p>');
    const hits = await appStore.searchBodies('world');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('app-a');
    expect(hits[0].snippet.toLowerCase()).toContain('world');
  });

  test('searchBodies is case-insensitive', async () => {
    await appStore.putAppBody('app-a', 'CASE matters');
    const hits = await appStore.searchBodies('case');
    expect(hits).toHaveLength(1);
  });

  test('empty query returns empty array', async () => {
    await appStore.putAppBody('app-a', 'anything');
    expect(await appStore.searchBodies('')).toEqual([]);
  });
});
