import { describe, test, expect } from 'bun:test';
import { raceTabReply } from '../../extension/background/engine-process.js';

describe('engine tab round-trip', () => {
  test('returns the raw reply, whatever it says', async () => {
    const reply = { ok: false, error: 'tab-side failure' };
    expect(await raceTabReply(async () => reply, {
      timeoutMs: 1_000, timeoutError: () => new Error('timeout'),
    })).toBe(reply);
  });

  test('a page that never answers rejects with the kind-specific timeout error', async () => {
    const error = Object.assign(new Error('unresponsive'), { vmUnresponsive: true });
    await expect(raceTabReply(() => new Promise(() => {}), {
      timeoutMs: 5, timeoutError: () => error,
    })).rejects.toBe(error);
  });

  test('a dispatch failure propagates unchanged', async () => {
    await expect(raceTabReply(async () => { throw new Error('no receiver'); }, {
      timeoutMs: 1_000, timeoutError: () => new Error('timeout'),
    })).rejects.toThrow('no receiver');
  });

  test('the timer is cleared once the reply settles', async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const handle = realSet(fn, ms); live.add(handle); return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: any) => { live.delete(handle); realClear(handle); }) as typeof clearTimeout;
    try {
      await raceTabReply(async () => ({ ok: true }), { timeoutMs: 60_000, timeoutError: () => new Error('t') });
      await raceTabReply(async () => { throw new Error('x'); }, { timeoutMs: 60_000, timeoutError: () => new Error('t') })
        .catch(() => {});
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test('the dispatch runs exactly once', async () => {
    let calls = 0;
    await raceTabReply(async () => { calls += 1; return 'ok'; }, {
      timeoutMs: 1_000, timeoutError: () => new Error('t'),
    });
    expect(calls).toBe(1);
  });

  test('a throwing timeout factory still settles the race', async () => {
    const thrown = new Error('factory failed');
    await expect(raceTabReply(() => new Promise(() => {}), {
      timeoutMs: 5, timeoutError: () => { throw thrown; },
    })).rejects.toBe(thrown);
  });
});
