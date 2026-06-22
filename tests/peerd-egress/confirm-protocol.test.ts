import { describe, test, expect } from 'bun:test';
import { makeConfirmCoordinator } from '../../extension/peerd-egress/confirm/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('confirm coordinator — hang protection', () => {
  test('broken channel → auto-denies immediately, never notifies the panel', async () => {
    let notified = 0;
    const c = makeConfirmCoordinator({
      notifySidePanel: () => { notified++; },
      isChannelOpen: () => false, // side panel gone
    });
    const answer = await c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(answer).toBe('no');
    expect(notified).toBe(0); // didn't even try to render it
  });

  test('open channel → resolves with the user answer', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p) => { pushed = p; } });
    // Promise<string>: the coordinator passes answers through unvalidated, and
    // this test resolves with a sentinel outside the ConfirmAnswer union.
    const p: Promise<string> = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(pushed?.id).toBeTruthy();
    c.resolve(pushed.id, 'yes-once' as any);
    expect(await p).toBe('yes-once');
  });

  test('open but UNANSWERED → auto-denies after the timeout (no hang)', async () => {
    const c = makeConfirmCoordinator({ notifySidePanel: () => {}, timeoutMs: 25 });
    const answer = await c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(answer).toBe('no');
  });

  test('a late answer after timeout is dropped (no double-settle)', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p) => { pushed = p; }, timeoutMs: 15 });
    const answer = await c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(answer).toBe('no'); // timed out
    expect(() => c.resolve(pushed.id, 'yes-session' as any)).not.toThrow(); // stale answer dropped
  });

  test('onPendingChange tracks the waiting count (badge signal)', async () => {
    const counts: number[] = [];
    let pushed: any = null;
    const c = makeConfirmCoordinator({
      notifySidePanel: (p) => { pushed = p; },
      onPendingChange: (n) => counts.push(n),
    });
    const p = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(counts.at(-1)).toBe(1); // raised while pending
    c.resolve(pushed.id, 'no' as any);
    await p;
    expect(counts.at(-1)).toBe(0); // cleared on settle
  });

  test('reset clears pending + timers', async () => {
    const c = makeConfirmCoordinator({ notifySidePanel: () => {}, timeoutMs: 10 });
    const p = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    // not awaited; reset should not leave it pending forever (the Promise stays
    // unsettled, but the timer is cleared so no leak). Just assert no throw.
    expect(() => c.reset()).not.toThrow();
    await sleep(20); // past the (now-cleared) timeout — nothing should fire/throw
  });

  // DESIGN-12: onSettled lets the SW broadcast confirm/resolved so EVERY open
  // surface dismisses the modal — on answer, timeout, AND reset.
  test('onSettled fires once per prompt on answer, timeout, and reset', async () => {
    const settled: string[] = [];
    let pushed: any = null;
    const c = makeConfirmCoordinator({
      notifySidePanel: (p) => { pushed = p; },
      onSettled: (id) => settled.push(id),
      timeoutMs: 15,
    });
    // (a) user answer
    const p1 = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    const id1 = pushed.id; c.resolve(id1, 'yes-once' as any); await p1;
    // (b) timeout auto-deny
    const p2 = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    const id2 = pushed.id; await p2;
    // (c) reset (session end)
    c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    const id3 = pushed.id; c.reset();

    expect(settled).toContain(id1);
    expect(settled).toContain(id2);
    expect(settled).toContain(id3);
    // exactly once each — no double-fire
    expect(settled.filter((s) => s === id1)).toHaveLength(1);
  });

  // DESIGN-12: a surface opened AFTER a prompt was raised replays it via getPending.
  test('getPending exposes the live prompt for late-joiner replay; null once settled', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p) => { pushed = p; } });
    expect(c.getPending()).toBe(null);
    const p = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(c.getPending()?.id).toBe(pushed.id); // a late surface can fetch + render it
    c.resolve(pushed.id, 'no' as any); await p;
    expect(c.getPending()).toBe(null);
  });
});
