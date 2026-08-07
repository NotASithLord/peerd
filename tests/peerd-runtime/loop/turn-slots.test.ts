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

  test('only explicit Stop advances the per-session generation', () => {
    const slots = makeTurnSlots();
    expect(slots.generation('a')).toBe(0);
    slots.claim('a');
    slots.claim('a'); // steer-live is not an explicit Stop
    expect(slots.generation('a')).toBe(0);
    expect(slots.stop('a')).toBe(true);
    expect(slots.generation('a')).toBe(1);
    expect(slots.stop('a')).toBe(true);
    expect(slots.generation('a')).toBe(2);
    expect(slots.generation('b')).toBe(0);
  });

  test('a queued claimed wake can reject a stale pre-Stop generation', () => {
    const slots = makeTurnSlots();
    const live = slots.claim('a');
    const generationAtQueue = slots.generation('a');
    let started = false;
    slots.runWhenIdleClaimed('a', (lease) => {
      if (slots.generation('a') !== generationAtQueue) {
        lease.release();
        return;
      }
      started = true;
    });

    expect(slots.stop('a')).toBe(true);
    live.release();
    expect(started).toBe(false);
    expect(slots.isBusy('a')).toBe(false);
  });

  // runWhenIdle — the async-actor reintegration hook (DESIGN-11): wake
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

  // advanceQueue — a wake that DECLINES to start a turn (the post-Stop gen-skip
  // in actor-messaging) hands the idle slot on, so the queue behind it doesn't
  // strand. Without this, a skipped wake never claims/releases and every wake
  // queued behind it waits for an unrelated future turn.
  test('advanceQueue drains the next wake when a wake DECLINES to start a turn', () => {
    const slots = makeTurnSlots();
    const live = slots.claim('a');                 // an actor turn in flight
    const order: number[] = [];
    slots.runWhenIdle('a', () => { order.push(1); slots.advanceQueue('a'); }); // declines → advances
    slots.runWhenIdle('a', () => { order.push(2); });                          // must still run
    expect(order).toEqual([]);                      // both deferred behind the live turn
    live.release();                                 // live ends → wake 1 declines + advances
    expect(order).toEqual([1, 2]);                  // wake 2 drained though wake 1 never claimed
    expect(slots.isBusy('a')).toBe(false);
  });

  test('a chain of consecutive decliners all drain, stopping at the first that starts a turn', () => {
    const slots = makeTurnSlots();
    const live = slots.claim('a');
    const order: number[] = [];
    let realTurn: { release: () => void } | undefined;
    slots.runWhenIdle('a', () => { order.push(1); slots.advanceQueue('a'); });        // decline
    slots.runWhenIdle('a', () => { order.push(2); slots.advanceQueue('a'); });        // decline
    slots.runWhenIdle('a', () => { order.push(3); realTurn = slots.claim('a'); });    // starts a turn
    slots.runWhenIdle('a', () => { order.push(4); });                                 // waits behind it
    live.release();
    expect(order).toEqual([1, 2, 3]);               // 1,2 declined; 3 claimed → 4 held
    expect(slots.isBusy('a')).toBe(true);
    realTurn!.release();
    expect(order).toEqual([1, 2, 3, 4]);            // 3's turn ends → 4 drains
  });

  test('advanceQueue is a no-op while a turn holds the slot (never jumps the queue)', () => {
    const slots = makeTurnSlots();
    slots.claim('a');
    let ran = false;
    slots.runWhenIdle('a', () => { ran = true; });
    slots.advanceQueue('a');                         // slot held → must not run the queued wake
    expect(ran).toBe(false);
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

// The abort watchdog (issue #176): stop() on a turn parked on an
// abort-ignoring await must eventually free the slot, or the session reads
// busy forever and queued wakes never drain.
describe('makeTurnSlots — stop watchdog (force-release a hung turn)', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('a hung turn (never releases after abort) is force-released after the grace', async () => {
    const slots = makeTurnSlots({ forceReleaseMs: 10 });
    slots.claim('a');                                // the turn never release()s
    let woke = false;
    expect(slots.stop('a')).toBe(true);
    slots.runWhenIdle('a', () => { woke = true; });  // queued behind the zombie
    expect(slots.isBusy('a')).toBe(true);            // still pinned pre-watchdog
    await tick(30);
    expect(slots.isBusy('a')).toBe(false);           // watchdog reaped the slot
    expect(woke).toBe(true);                         // and drained the queue
  });

  test('a well-behaved turn that unwinds in time is NOT double-released onto a successor', async () => {
    const slots = makeTurnSlots({ forceReleaseMs: 10 });
    const first = slots.claim('a');
    slots.stop('a');
    first.release();                                 // unwinds promptly, as normal
    const second = slots.claim('a');                 // a new turn claims before the grace fires
    await tick(30);
    // The watchdog is controller-scoped: it must not free the NEW turn's claim.
    expect(slots.isBusy('a')).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
  });
});
