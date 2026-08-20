import { describe, expect, test } from 'bun:test';
import { relayAppRuntimeCall } from '../../extension/background/app-runtime-deadline.js';

describe('App runtime SW deadline', () => {
  test('poisons and reloads a timed-out generation, then refuses overlap', async () => {
    const poisoned = new Set<number>();
    const reloads: number[] = [];
    const timers: Array<() => void> = [];
    const first = relayAppRuntimeCall({
      tabId: 7, message: {}, poisoned,
      send: async () => new Promise(() => {}),
      reload: async (tabId) => { reloads.push(tabId); },
      setTimer: (fn) => { timers.push(fn); return 1; },
    });
    timers[0]();
    expect(await first).toEqual({
      ok: false, error: 'app_runtime_call_timed_out_outcome_unknown',
      outcomeKnown: false, outcomeKind: 'transport-lost',
    });
    expect(poisoned.has(7)).toBe(true);
    await Promise.resolve();
    expect(reloads).toEqual([7]);

    let sent = false;
    expect(await relayAppRuntimeCall({
      tabId: 7, message: {}, poisoned,
      send: async () => { sent = true; }, reload: async () => {},
    })).toEqual({
      ok: false, error: 'app_runtime_generation_poisoned',
      outcomeKnown: false, outcomeKind: 'transport-lost',
    });
    expect(sent).toBe(false);
  });

  test('clears the deadline after a successful reply', async () => {
    const cleared: unknown[] = [];
    expect(await relayAppRuntimeCall({
      tabId: 2, message: { op: 'observe' }, poisoned: new Set(),
      send: async () => ({ ok: true }), reload: async () => {},
      setTimer: () => 42, clearTimer: (timer) => cleared.push(timer),
    })).toEqual({ ok: true });
    expect(cleared).toEqual([42]);
  });

  test('abort after dispatch poisons and reloads before another action can overlap', async () => {
    const controller = new AbortController();
    const poisoned = new Set<number>();
    const reloads: number[] = [];
    const call = relayAppRuntimeCall({
      tabId: 9, message: { op: 'act' }, poisoned, signal: controller.signal,
      send: async () => new Promise(() => {}),
      reload: async (tabId) => { reloads.push(tabId); },
    });
    controller.abort();
    expect(await call).toEqual({
      ok: false, error: 'app_runtime_call_aborted_outcome_unknown',
      outcomeKnown: false, outcomeKind: 'transport-lost',
    });
    expect(poisoned.has(9)).toBe(true);
    await Promise.resolve();
    expect(reloads).toEqual([9]);
  });
});
