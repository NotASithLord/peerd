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
