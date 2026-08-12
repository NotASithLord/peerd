import { describe, test, expect } from 'bun:test';
import { makeConfirmCoordinator } from '../../extension/peerd-egress/confirm/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claim = (prompt: any) => ({
  id: prompt.id,
  ownerSessionId: prompt.ownerSessionId ?? null,
  sessionId: prompt.sessionId ?? null,
  dispatchId: prompt.dispatchId ?? null,
});

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
    const p: Promise<string> = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(pushed?.id).toBeTruthy();
    c.resolve(claim(pushed), 'yes_once');
    expect(await p).toBe('yes_once');
  });

  test('a leaked UUID cannot approve a foreign owner, execution session, or dispatch', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (prompt) => { pushed = prompt; } });
    const pending = c.confirm({
      tool: 'click', description: 'x', origins: [], sideEffect: 'write',
      ownerSessionId: 'chat-a', sessionId: 'actor-a', dispatchId: 'tool-use-a',
    } as any);

    expect(c.resolve({ ...claim(pushed), ownerSessionId: 'chat-b' }, 'yes_once')).toBe(false);
    expect(c.resolve({ ...claim(pushed), sessionId: 'actor-b' }, 'yes_once')).toBe(false);
    expect(c.resolve({ ...claim(pushed), dispatchId: 'tool-use-b' }, 'yes_once')).toBe(false);
    expect(c.resolve(claim(pushed), 'approve' as any)).toBe(false);
    expect(c.getPendingForOwner('chat-a')?.id).toBe(pushed.id);

    expect(c.resolve(claim(pushed), 'no')).toBe(true);
    expect(await pending).toBe('no');
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
    expect(() => c.resolve(claim(pushed), 'yes_session')).not.toThrow(); // stale answer dropped
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
    c.resolve(claim(pushed), 'no');
    await p;
    expect(counts.at(-1)).toBe(0); // cleared on settle
  });

  test('reset clears pending + timers', async () => {
    const c = makeConfirmCoordinator({ notifySidePanel: () => {}, timeoutMs: 10 });
    const p = c.confirm({ tool: 'do', description: 'x', origins: [], sideEffect: 'write' } as any);
    expect(() => c.reset()).not.toThrow();
    expect(await p).toBe('no');
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
    const id1 = pushed.id; c.resolve(claim(pushed), 'yes_once'); await p1;
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

  // DESIGN-12: a surface opened AFTER a prompt was raised replays only the
  // prompt owned by the chat represented by its state snapshot.
  test('getPendingForOwner exposes a live prompt for scoped late-joiner replay', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p) => { pushed = p; } });
    expect(c.getPendingForOwner('chat-a')).toBe(null);
    const p = c.confirm({
      tool: 'do', description: 'x', origins: [], sideEffect: 'write',
      sessionId: 'chat-a', ownerSessionId: 'chat-a',
    } as any);
    expect(c.getPendingForOwner('chat-a')?.id).toBe(pushed.id);
    expect(c.getPendingForOwner('chat-b')).toBe(null);
    c.resolve(claim(pushed), 'no'); await p;
    expect(c.getPendingForOwner('chat-a')).toBe(null);
  });

  test('getPendingForOwner keeps actor execution custody separate from root-chat display', async () => {
    const pushed: any[] = [];
    const c = makeConfirmCoordinator({ notifySidePanel: (prompt) => { pushed.push(prompt); } });
    const p1 = c.confirm({
      tool: 'click', description: 'a', origins: [], sideEffect: 'write',
      sessionId: 'actor-a', ownerSessionId: 'chat-a',
    } as any);
    const p2 = c.confirm({
      tool: 'click', description: 'b', origins: [], sideEffect: 'write',
      sessionId: 'actor-b', ownerSessionId: 'chat-b',
    } as any);

    expect(c.getPendingForOwner('chat-a')?.sessionId).toBe('actor-a');
    expect(c.getPendingForOwner('chat-b')?.sessionId).toBe('actor-b');
    expect(c.getPendingForOwner('chat-c')).toBe(null);

    c.resolve(claim(pushed[0]), 'no');
    c.resolve(claim(pushed[1]), 'no');
    await Promise.all([p1, p2]);
  });

  test('settling the visible prompt resurfaces the next prompt for that owner', async () => {
    const pushed: any[] = [];
    const c = makeConfirmCoordinator({ notifySidePanel: (prompt) => { pushed.push(prompt); } });
    const first = c.confirm({
      tool: 'click', description: 'first', origins: [], sideEffect: 'write',
      sessionId: 'actor-1', ownerSessionId: 'chat-a',
    } as any);
    const second = c.confirm({
      tool: 'type', description: 'second', origins: [], sideEffect: 'write',
      sessionId: 'actor-2', ownerSessionId: 'chat-a',
    } as any);
    const firstId = pushed[0].id;
    const secondId = pushed[1].id;

    c.resolve(claim(pushed[1]), 'no');
    expect(await second).toBe('no');
    expect(pushed.at(-1)?.id).toBe(firstId);

    c.resolve(claim(pushed[0]), 'no');
    expect(await first).toBe('no');
  });
});

describe('confirm coordinator — declineSession (turn aborted: Stop / steer)', () => {
  test('a run AbortSignal immediately declines and dismisses its own pending prompt', async () => {
    const settled: string[] = [];
    const controller = new AbortController();
    let pushed: any = null;
    const c = makeConfirmCoordinator({
      notifySidePanel: (prompt) => { pushed = prompt; },
      onSettled: (id) => settled.push(id),
    });
    const pending = c.confirm({
      tool: 'click', description: 'x', origins: [], sideEffect: 'write',
      sessionId: 's1', ownerSessionId: 's1',
    } as any, controller.signal);
    expect(c.getPendingForOwner('s1')?.id).toBe(pushed.id);
    controller.abort();
    expect(await pending).toBe('no');
    expect(c.getPendingForOwner('s1')).toBe(null);
    expect(settled).toEqual([pushed.id]);
  });

  test('an already-aborted operation never raises a confirmation card', async () => {
    let notified = 0;
    const controller = new AbortController();
    controller.abort();
    const c = makeConfirmCoordinator({ notifySidePanel: () => { notified++; } });
    expect(await c.confirm({
      tool: 'click', description: 'x', origins: [], sideEffect: 'write',
      sessionId: 's1', ownerSessionId: 's1',
    } as any, controller.signal)).toBe('no');
    expect(notified).toBe(0);
    expect(c.getPendingForOwner('s1')).toBe(null);
  });

  test('declines pending prompts for that session → the await resolves to "no"', async () => {
    const c = makeConfirmCoordinator({ notifySidePanel: () => {} });
    const p = c.confirm({ tool: 'click', description: 'x', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    c.declineSession('s1');
    expect(await p).toBe('no'); // unblocked into a decline — the cancelled side-effect won't run
  });

  test('only the matching session is declined; another chat is untouched', async () => {
    let s2Pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p: any) => { if (p.sessionId === 's2') s2Pushed = p; } });
    const p1 = c.confirm({ tool: 'click', description: 'x', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    const p2 = c.confirm({ tool: 'click', description: 'y', origins: [], sideEffect: 'write', sessionId: 's2' } as any);
    c.declineSession('s1');
    expect(await p1).toBe('no');
    c.resolve(claim(s2Pushed), 'yes_once'); // s2 is still live, so a real answer flows
    expect(await p2).toBe('yes_once');
  });

  test('first-settle-wins: a user "yes" that already landed is honored; a later decline no-ops', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p: any) => { pushed = p; } });
    const p = c.confirm({ tool: 'click', description: 'x', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    c.resolve(claim(pushed), 'yes_session'); // approved first
    c.declineSession('s1');                      // abort lands after — must not override
    expect(await p).toBe('yes_session');
  });

  test('declineSession(null/undefined) is a no-op (prompt stays pending)', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p: any) => { pushed = p; } });
    const p = c.confirm({
      tool: 'click', description: 'x', origins: [], sideEffect: 'write',
      sessionId: 's1', ownerSessionId: 's1',
    } as any);
    c.declineSession(null as any);
    c.declineSession(undefined as any);
    expect(c.getPendingForOwner('s1')?.id).toBe(pushed.id); // still pending, not declined
    c.resolve(claim(pushed), 'yes_once');
    expect(await p).toBe('yes_once');
  });
});

describe('confirm coordinator - settle outcomes (§4e)', () => {
  test('a user answer carries cause answer + the answering surface', async () => {
    const outcomes: any[] = [];
    let pushed: any = null;
    const c = makeConfirmCoordinator({
      notifySidePanel: (p) => { pushed = p; },
      onSettled: (_id, _prompt, outcome) => outcomes.push(outcome),
    });
    const p = c.confirm({ tool: 'click', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    c.resolve({ id: pushed.id, sessionId: 's1' }, 'yes_once' as any, 'home');
    expect(await p).toBe('yes_once');
    expect(outcomes).toEqual([{ answer: 'yes_once', cause: 'answer', via: 'home', sessionId: 's1' }]);
  });

  test('the deadline settle is cause timeout', async () => {
    const outcomes: any[] = [];
    const c = makeConfirmCoordinator({
      notifySidePanel: () => {},
      timeoutMs: 10,
      onSettled: (_id, _prompt, outcome) => outcomes.push(outcome),
    });
    const p = c.confirm({ tool: 'click', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    expect(await p).toBe('no');
    expect(outcomes[0]?.cause).toBe('timeout');
    expect(outcomes[0]?.via).toBe(null);
  });

  test('declineSession (Stop) is cause stop; an operation abort is cause abort', async () => {
    const outcomes: any[] = [];
    const controller = new AbortController();
    const c = makeConfirmCoordinator({
      notifySidePanel: () => {},
      onSettled: (_id, _prompt, outcome) => outcomes.push(outcome),
    });
    const p1 = c.confirm({ tool: 'click', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    c.declineSession('s1');
    expect(await p1).toBe('no');
    const p2 = c.confirm({ tool: 'click', origins: [], sideEffect: 'write', sessionId: 's2' } as any, controller.signal);
    controller.abort();
    expect(await p2).toBe('no');
    expect(outcomes.map((o) => o.cause)).toEqual(['stop', 'abort']);
  });

  test('the prompt is stamped raisedAt so a surface can time the 90s hint', async () => {
    let pushed: any = null;
    const c = makeConfirmCoordinator({ notifySidePanel: (p) => { pushed = p; } });
    const before = Date.now();
    const p = c.confirm({ tool: 'click', origins: [], sideEffect: 'write', sessionId: 's1' } as any);
    expect(typeof pushed.raisedAt).toBe('number');
    expect(pushed.raisedAt).toBeGreaterThanOrEqual(before);
    c.resolve({ id: pushed.id, sessionId: 's1' }, 'no' as any);
    expect(await p).toBe('no');
  });
});
