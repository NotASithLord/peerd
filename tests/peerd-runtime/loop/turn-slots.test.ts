import { describe, test, expect } from 'bun:test';
import { makeTurnSlots } from '../../../extension/peerd-runtime/loop/turn-slots.js';

// makeTurnSlots is the per-session concurrency contract for in-flight
// turns. The load-bearing rules (each was a real bug under the old
// global single-slot design, owner report 2026-06-12):
//   - claiming session B never aborts session A's turn (chatting in a
//     second conversation must not kill the first one's stream)
//   - claiming the SAME session aborts the prior turn (steer-live)
//   - release is self-scoped (a superseded turn can't free the slot
//     its replacement now owns)
//   - stop() is per-session (Stop never reaches across chats)

describe('makeTurnSlots', () => {
  test('claim gives a live controller and marks the session busy', () => {
    const slots = makeTurnSlots();
    const { controller } = slots.claim('a');
    expect(controller.signal.aborted).toBe(false);
    expect(slots.isBusy('a')).toBe(true);
    expect(slots.isBusy('b')).toBe(false);
  });

  test('claiming a DIFFERENT session leaves the first turn untouched', () => {
    const slots = makeTurnSlots();
    const a = slots.claim('a');
    slots.claim('b');
    expect(a.controller.signal.aborted).toBe(false);
    expect(slots.isBusy('a')).toBe(true);
    expect(slots.isBusy('b')).toBe(true);
  });

  test('claiming the SAME session aborts the prior turn (steer-live)', () => {
    const slots = makeTurnSlots();
    const first = slots.claim('a');
    const second = slots.claim('a');
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    expect(slots.isBusy('a')).toBe(true);
  });

  test('release frees the slot', () => {
    const slots = makeTurnSlots();
    const { release } = slots.claim('a');
    release();
    expect(slots.isBusy('a')).toBe(false);
  });

  test('a superseded turn releasing late cannot free its replacement', () => {
    const slots = makeTurnSlots();
    const first = slots.claim('a');
    slots.claim('a');               // steer replaces first
    first.release();                // old turn unwinds after the abort
    expect(slots.isBusy('a')).toBe(true);
  });

  test('release is idempotent and scoped across sessions', () => {
    const slots = makeTurnSlots();
    const a = slots.claim('a');
    slots.claim('b');
    a.release();
    a.release();
    expect(slots.isBusy('a')).toBe(false);
    expect(slots.isBusy('b')).toBe(true);
  });

  test('stop aborts only the named session and reports whether it did', () => {
    const slots = makeTurnSlots();
    const a = slots.claim('a');
    const b = slots.claim('b');
    expect(slots.stop('a')).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(false);
    expect(slots.stop('missing')).toBe(false);
  });

  // runWhenIdle — the async-subagent reintegration hook (DESIGN-11): wake
  // the parent without aborting its live turn. A wake is contracted to
  // start a turn (claim the slot), so wakes serialise via release.
  test('runWhenIdle runs immediately when the session is idle', () => {
    const slots = makeTurnSlots();
    let ran = false;
    slots.runWhenIdle('a', () => { ran = true; });
    expect(ran).toBe(true);
  });

  test('runWhenIdle defers a wake until the live turn releases (never aborts it)', () => {
    const slots = makeTurnSlots();
    const live = slots.claim('a');
    let ran = false;
    slots.runWhenIdle('a', () => { ran = true; });
    expect(ran).toBe(false);                       // deferred, not run
    expect(live.controller.signal.aborted).toBe(false); // live turn untouched
    live.release();
    expect(ran).toBe(true);                        // runs once the slot frees
  });

  test('a wake queued for A is NOT triggered by B releasing', () => {
    const slots = makeTurnSlots();
    slots.claim('a');
    const b = slots.claim('b');
    let ran = false;
    slots.runWhenIdle('a', () => { ran = true; });
    b.release();
    expect(ran).toBe(false);                       // A still busy
  });

  test('queued wakes serialise — each runs only after the prior turn releases', () => {
    const slots = makeTurnSlots();
    const live = slots.claim('a');                 // parent turn in flight
    const order: number[] = [];
    let wake1Turn: { release: () => void } | undefined;
    slots.runWhenIdle('a', () => { order.push(1); wake1Turn = slots.claim('a'); }); // wake 1 starts a turn
    slots.runWhenIdle('a', () => { order.push(2); });                               // wake 2
    expect(order).toEqual([]);                      // both deferred behind the live turn
    live.release();                                 // parent ends → wake 1 runs + claims the slot
    expect(order).toEqual([1]);                     // wake 2 still waiting (slot busy)
    expect(slots.isBusy('a')).toBe(true);
    wake1Turn!.release();                           // wake 1's turn ends → wake 2 runs
    expect(order).toEqual([1, 2]);
    expect(slots.isBusy('a')).toBe(false);
  });
});

describe('makeTurnSlots — onAbort (decline parked confirms on abort)', () => {
  test('steer-live supersede fires onAbort for that session', () => {
    const aborted: string[] = [];
    const slots = makeTurnSlots({ onAbort: (s) => aborted.push(s) });
    slots.claim('a');                 // first turn — nothing superseded
    expect(aborted).toEqual([]);
    slots.claim('a');                 // steer-live supersede → onAbort('a')
    expect(aborted).toEqual(['a']);
  });

  test('stop fires onAbort for that session', () => {
    const aborted: string[] = [];
    const slots = makeTurnSlots({ onAbort: (s) => aborted.push(s) });
    slots.claim('a');
    expect(slots.stop('a')).toBe(true);
    expect(aborted).toEqual(['a']);
  });

  test('claiming a DIFFERENT, fresh session does not fire onAbort', () => {
    const aborted: string[] = [];
    const slots = makeTurnSlots({ onAbort: (s) => aborted.push(s) });
    slots.claim('a');
    slots.claim('b');                 // no prior controller for b → nothing to decline
    expect(aborted).toEqual([]);
  });

  test('stopping an idle session is a no-op (no onAbort)', () => {
    const aborted: string[] = [];
    const slots = makeTurnSlots({ onAbort: (s) => aborted.push(s) });
    expect(slots.stop('a')).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('default (no onAbort) still supersedes without throwing', () => {
    const slots = makeTurnSlots();
    const first = slots.claim('a');
    slots.claim('a');
    expect(first.controller.signal.aborted).toBe(true);
    expect(slots.isBusy('a')).toBe(true);
  });
});
