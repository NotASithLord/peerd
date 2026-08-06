import { describe, expect, test } from 'bun:test';
import { listOffscreenContexts } from '../../extension/background/offscreen-contexts.js';

describe('offscreen context probe', () => {
  test('Firefox without the offscreen APIs has no live host', async () => {
    expect(await listOffscreenContexts({ runtime: {} })).toEqual([]);
  });

  test('does not call getContexts when offscreen document hosting is absent', async () => {
    let called = false;
    const contexts = await listOffscreenContexts({
      runtime: { getContexts: async () => { called = true; return [{}]; } },
    });
    expect(contexts).toEqual([]);
    expect(called).toBe(false);
  });

  test('Chrome probes only offscreen document contexts', async () => {
    let query: unknown = null;
    const contexts = await listOffscreenContexts({
      offscreen: { createDocument: () => {} },
      runtime: {
        getContexts: async (value: unknown) => { query = value; return [{ id: 1 }]; },
      },
    });
    expect(query).toEqual({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    expect(contexts).toEqual([{ id: 1 }]);
  });
});
