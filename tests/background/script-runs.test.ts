// The live registry of actors-enabled script runs — the Stop-plumbing crux.
// One abort (the run's own, or the outer dispatch signal chaining into it)
// must flip the signal every pending ask races against.

import { describe, test, expect } from 'bun:test';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';

const stubSignal = () => {
  const listeners: Array<() => void> = [];
  return {
    aborted: false,
    addEventListener: (_t: string, fn: () => void) => { listeners.push(fn); },
    removeEventListener: (_t: string, fn: () => void) => {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    },
    fire: () => { for (const fn of listeners) fn(); },
    _count: () => listeners.length,
  };
};

describe('createScriptRunRegistry', () => {
  test('mintRunId is collision-proof per registry', () => {
    const r = createScriptRunRegistry();
    expect(r.mintRunId('s1')).not.toBe(r.mintRunId('s1'));
  });

  test('register → signalFor is live; abort flips it; release drops it', () => {
    const r = createScriptRunRegistry();
    r.register('run-1');
    const sig = r.signalFor('run-1');
    expect(sig?.aborted).toBe(false);
    r.abort('run-1');
    expect(sig?.aborted).toBe(true);
    r.release('run-1');
    expect(r.signalFor('run-1')).toBe(null);
    expect(r._size()).toBe(0);
  });

  test('the OUTER dispatch signal (Stop) chains into the run signal', () => {
    const r = createScriptRunRegistry();
    const outer = stubSignal();
    r.register('run-2', outer);
    expect(r.signalFor('run-2')?.aborted).toBe(false);
    outer.fire();                                    // Stop pressed
    expect(r.signalFor('run-2')?.aborted).toBe(true);
  });

  test('an ALREADY-aborted outer signal aborts the run at registration (no race window)', () => {
    const r = createScriptRunRegistry();
    const outer = { ...stubSignal(), aborted: true };
    r.register('run-3', outer);
    expect(r.signalFor('run-3')?.aborted).toBe(true);
  });

  test('release detaches the outer listener — no dead handlers pile on a long-lived turn signal', () => {
    const r = createScriptRunRegistry();
    const outer = stubSignal();
    r.register('run-4', outer);
    expect(outer._count()).toBe(1);
    r.release('run-4');
    expect(outer._count()).toBe(0);
  });
});

// Design 5 — the sub-model lane's SW-side state: the owner binding the
// script/model-call relay checks, and the per-run quota meter (held here so the
// realm being metered never holds its own meter).
describe('createScriptRunRegistry — provider (sub-model) accounting', () => {
  test('ownerFor answers the registered owner, null for unknown or ownerless runs', () => {
    const r = createScriptRunRegistry();
    r.register('run-p1', undefined, 'chat-1');
    r.register('run-p2');
    expect(r.ownerFor('run-p1')).toBe('chat-1');
    expect(r.ownerFor('run-p2')).toBe(null);
    expect(r.ownerFor('nope')).toBe(null);
    r.release('run-p1');
    expect(r.ownerFor('run-p1')).toBe(null);   // a dead run buys nothing
  });

  test('the meter counts calls, RESERVES maxTokens at admission, and settles to the actual bill', () => {
    const r = createScriptRunRegistry();
    r.register('run-p3', undefined, 'chat-1');
    expect(r.providerUsageFor('run-p3')).toEqual({ calls: 0, outputTokens: 0 });
    // two concurrent admissions: the reservation is visible BEFORE either
    // settles — a fan-out cannot slip past the token ceiling on a stale read.
    r.recordProviderCall('run-p3', 1000);
    r.recordProviderCall('run-p3', 1000);
    expect(r.providerUsageFor('run-p3')).toEqual({ calls: 2, outputTokens: 2000 });
    r.settleProviderCall('run-p3', 1000, 100);
    r.settleProviderCall('run-p3', 1000, 50);
    expect(r.providerUsageFor('run-p3')).toEqual({ calls: 2, outputTokens: 150 });
  });

  test('a no-usage settle releases the whole reservation (an errored stream billed nothing)', () => {
    const r = createScriptRunRegistry();
    r.register('run-p5', undefined, 'chat-1');
    r.recordProviderCall('run-p5', 8192);
    expect(r.providerUsageFor('run-p5')).toEqual({ calls: 1, outputTokens: 8192 });
    r.settleProviderCall('run-p5', 8192, 0);
    expect(r.providerUsageFor('run-p5')).toEqual({ calls: 1, outputTokens: 0 });
  });

  test('bad token values and unknown runs are inert; providerUsageFor is null when unregistered', () => {
    const r = createScriptRunRegistry();
    r.register('run-p4', undefined, 'chat-1');
    r.recordProviderCall('run-p4', NaN);
    r.settleProviderCall('run-p4', -5, NaN);
    r.recordProviderCall('ghost');
    r.settleProviderCall('ghost', 10, 20);
    expect(r.providerUsageFor('run-p4')).toEqual({ calls: 1, outputTokens: 0 });
    expect(r.providerUsageFor('ghost')).toBe(null);
  });
});
