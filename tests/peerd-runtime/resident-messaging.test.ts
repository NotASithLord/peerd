import { describe, test, expect } from 'bun:test';
import { makeResidentMessaging } from '../../extension/peerd-runtime/subagent/resident-messaging.js';

// A flush for the fire-and-forget runWhenIdle → runResidentTurn → deliver chain.
const tick = () => new Promise((r) => setTimeout(r, 0));

type Reenter = { userText: string; sessionId: string; synthetic: boolean };

const harness = (over: Partial<Parameters<typeof makeResidentMessaging>[0]> = {}) => {
  const reentries: Reenter[] = [];
  const turnsRun: Array<{ residentSessionId: string; message: string }> = [];
  const deps = {
    resolveResident: async (to: string) =>
      to === 'app-1'
        ? { instanceId: 'app-1', kind: 'app', residentSessionId: 'res-1', name: 'todo', tabId: 7 }
        : null,
    runResidentTurn: async (o: { residentSessionId: string; message: string }) => {
      turnsRun.push({ residentSessionId: o.residentSessionId, message: o.message });
      return { result: 'built the thing' };
    },
    reenter: async (r: Reenter) => { reentries.push(r); },
    // Run queued work immediately (no real slot in the test).
    turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => fn() },
    getActiveSessionId: async () => 'chat-1',
    isVaultLocked: () => false,
    wrapUntrusted: ({ origin, body }: { origin: string; body: string }) => `<u origin="${origin}">${body}</u>`,
    appendAudit: async () => {},
    now: () => 1000,
    log: () => {},
    ...over,
  } as Parameters<typeof makeResidentMessaging>[0];
  return { ...makeResidentMessaging(deps), reentries, turnsRun };
};

describe('message_resident — the sender gate (fail closed)', () => {
  test('ALLOWS a first-party continuation in the active chat (not inbound)', async () => {
    // The trust marker (goal turn / resident reply-wake) folds to inbound:false,
    // so a synthetic-but-trusted turn in the active chat may delegate.
    const { messageResident, turnsRun } = harness();
    const r = await messageResident({ to: 'app-1', message: 'hi', senderSessionId: 'chat-1', inbound: false });
    expect(r.ok).toBe(true);
    await tick();
    expect(turnsRun.length).toBe(1);
  });
  test('refuses an INBOUND (untrusted-origin) sender even in the active chat', async () => {
    const { messageResident } = harness();
    const r = await messageResident({ to: 'app-1', message: 'hi', senderSessionId: 'chat-1', inbound: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('untrusted');
  });
  test('refuses a sender that is NOT the active chat (even if not inbound)', async () => {
    const { messageResident } = harness();
    const r = await messageResident({ to: 'app-1', message: 'hi', senderSessionId: 'chat-OTHER', inbound: false });
    expect(r.ok).toBe(false);
  });
  test('refuses a missing senderSessionId', async () => {
    const { messageResident } = harness();
    const r = await messageResident({ to: 'app-1', message: 'hi', senderSessionId: null, inbound: false });
    expect(r.ok).toBe(false);
  });
  test('refuses when the vault is locked', async () => {
    const { messageResident } = harness({ isVaultLocked: () => true });
    const r = await messageResident({ to: 'app-1', message: 'hi', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('vault');
  });
});

describe('message_resident — happy path + correlation', () => {
  test('runs the resident turn and re-enters the SENDER with a fenced synthetic reply', async () => {
    const { messageResident, reentries, turnsRun } = harness();
    const r = await messageResident({ to: 'app-1', message: 'build a todo app', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(true);
    await tick();
    // The resident turn ran against the RESIDENT session, with the message.
    expect(turnsRun).toEqual([{ residentSessionId: 'res-1', message: 'build a todo app' }]);
    // The reply re-entered the SENDER (not the resident), synthetic + fenced.
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
    expect(reentries[0].synthetic).toBe(true);
    expect(reentries[0].userText).toContain('<u origin="app-1">built the thing</u>');
  });
  test('an unknown instance id is refused (no reentry)', async () => {
    const { messageResident, reentries } = harness();
    const r = await messageResident({ to: 'nope-9', message: 'x', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(false);
    await tick();
    expect(reentries.length).toBe(0);
  });
});

describe('message_resident — error path still wakes the sender', () => {
  test('a thrown resident turn re-enters the sender with an error notice', async () => {
    const { messageResident, reentries } = harness({
      runResidentTurn: async () => { throw new Error('boom'); },
    });
    const r = await messageResident({ to: 'app-1', message: 'x', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(true);  // dispatched
    await tick();
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
    expect(reentries[0].synthetic).toBe(true);
    expect(reentries[0].userText).toContain('could not complete');
    expect(reentries[0].userText).toContain('boom');
  });
});

describe('message_resident — durable mailbox (persist + redrain)', () => {
  const makeMailbox = () => {
    const appended: any[] = [];
    const removed: string[] = [];
    let loadReturns: any[] = [];
    return {
      mailbox: {
        append: async (e: any) => { appended.push(e); },
        remove: async (id: string) => { removed.push(id); },
        load: async () => loadReturns,
      },
      appended, removed,
      setLoad: (arr: any[]) => { loadReturns = arr; },
    };
  };

  test('an ENGINE message persists on accept and clears on settle', async () => {
    const mb = makeMailbox();
    const { messageResident, reentries } = harness({ mailbox: mb.mailbox });
    await messageResident({ to: 'app-1', message: 'build', senderSessionId: 'chat-1' });
    expect(mb.appended.length).toBe(1);
    expect(mb.appended[0]).toMatchObject({ senderSessionId: 'chat-1', to: 'app-1', message: 'build' });
    await tick();
    // The reply delivered → the durable entry is cleared (same id).
    expect(reentries.length).toBe(1);
    expect(mb.removed).toEqual([mb.appended[0].id]);
  });

  test('a WEB message is NOT persisted (sync within one turn)', async () => {
    const mb = makeMailbox();
    const { messageResident } = harness({
      mailbox: mb.mailbox,
      resolveResident: async (to: string) =>
        to === '42' ? { instanceId: '42', kind: 'web', residentSessionId: 'web-1', tabId: 42 } : null,
    });
    await messageResident({ to: '42', message: 'click', senderSessionId: 'chat-1' });
    expect(mb.appended.length).toBe(0);
  });

  test('redrain re-queues a persisted engine message → resident runs, sender woken, entry cleared', async () => {
    const mb = makeMailbox();
    mb.setLoad([{ id: 'c1', senderSessionId: 'chat-1', to: 'app-1', message: 'resume me', createdAt: 1 }]);
    const { redrain, reentries, turnsRun } = harness({ mailbox: mb.mailbox });
    const r = await redrain();
    expect(r.redrained).toBe(1);
    await tick();
    expect(turnsRun).toEqual([{ residentSessionId: 'res-1', message: 'resume me' }]);
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
    expect(mb.removed).toEqual(['c1']);
  });

  test('redrain abandons an entry whose instance is gone — wakes the sender with a failure, clears it', async () => {
    const mb = makeMailbox();
    mb.setLoad([{ id: 'c2', senderSessionId: 'chat-1', to: 'gone-9', message: 'x', createdAt: 1 }]);
    const { redrain, reentries } = harness({ mailbox: mb.mailbox });
    const r = await redrain();
    expect(r.redrained).toBe(0);
    await tick();
    expect(reentries.length).toBe(1);
    expect(reentries[0].userText).toContain('could not be reached');
    expect(mb.removed).toEqual(['c2']);
  });

  test('redrain drops a malformed entry without crashing', async () => {
    const mb = makeMailbox();
    mb.setLoad([{ id: 'bad', senderSessionId: 'chat-1' /* no to/message */ }, null]);
    const { redrain } = harness({ mailbox: mb.mailbox });
    const r = await redrain();
    expect(r.redrained).toBe(0);
    expect(mb.removed).toContain('bad');
  });

  test('residentsFor tracks the in-flight resident sessions for a sender (Stop cascade)', async () => {
    const { messageResident, residentsFor } = harness({
      // Never resolves → the resident stays in flight.
      runResidentTurn: () => new Promise(() => {}) as Promise<{ result: string }>,
    });
    expect(residentsFor('chat-1')).toEqual([]);
    await messageResident({ to: 'app-1', message: 'x', senderSessionId: 'chat-1' });
    await tick();
    expect(residentsFor('chat-1')).toEqual(['res-1']);
  });

  test('residentsFor keeps a resident visible until ALL its in-flight messages settle (refcount)', async () => {
    // Two messages to the SAME resident. A Set would drop it the moment the FIRST
    // settled, so a Stop during the second would miss it. Refcount keeps it visible.
    const releases: Array<() => void> = [];
    const { messageResident, residentsFor } = harness({
      caps: { rateCap: 100, outstanding: 100 },
      runResidentTurn: () => new Promise<{ result: string }>((res) => releases.push(() => res({ result: 'done' }))),
    });
    await messageResident({ to: 'app-1', message: 'A', senderSessionId: 'chat-1' });
    await messageResident({ to: 'app-1', message: 'B', senderSessionId: 'chat-1' });
    await tick();
    expect(residentsFor('chat-1')).toEqual(['res-1']);   // both in flight to res-1
    releases[0]();                                       // first settles…
    await tick();
    expect(residentsFor('chat-1')).toEqual(['res-1']);   // …STILL visible (B in flight) — the fix
    releases[1]();
    await tick();
    expect(residentsFor('chat-1')).toEqual([]);
  });

  test('stopResidentsFor returns the in-flight residents AND makes a then-queued turn skip', async () => {
    const queue: Array<() => void> = [];
    const ran: string[] = [];
    const { messageResident, residentsFor, stopResidentsFor } = harness({
      caps: { rateCap: 100, outstanding: 100 },
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queue.push(fn); } }, // defer (don't run yet)
      runResidentTurn: async (o: { message: string }) => { ran.push(o.message); return { result: 'x' }; },
    });
    await messageResident({ to: 'app-1', message: 'A', senderSessionId: 'chat-1' });
    expect(residentsFor('chat-1')).toEqual(['res-1']);   // tracked at dispatch, before the turn runs
    const stopped = stopResidentsFor('chat-1');
    expect(stopped).toEqual(['res-1']);                  // the running/queued resident to abort
    queue.forEach((fn) => fn());                         // drain — A's queued turn fires post-Stop
    await tick();
    expect(ran).toEqual([]);                             // …and SKIPS (the generation advanced)
    expect(residentsFor('chat-1')).toEqual([]);          // bookkeeping cleared
  });
});

describe('message_resident — web resident (sync-await relay)', () => {
  // A harness whose resolveResident returns a WEB resident (kind 'web', the owned
  // tabId as instance). The web branch awaits the turn and returns content INLINE.
  const webHarness = (over: Partial<Parameters<typeof makeResidentMessaging>[0]> = {}) => harness({
    resolveResident: async (to: string) =>
      to === '42'
        ? { instanceId: '42', kind: 'web', residentSessionId: 'web-res-1', name: undefined, tabId: 42 }
        : null,
    ...over,
  });

  test('returns the reply SYNCHRONOUSLY in the tool result — no reentry wake', async () => {
    const { messageResident, reentries } = webHarness({
      runResidentTurn: async () => ({ result: 'clicked the button, page now shows success' }),
    });
    const r = await messageResident({ to: '42', message: 'click submit', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(true);
    // Content is inline (not a "reply arrives later" placeholder) — proves the turn ran.
    expect(r.content).toBe('clicked the button, page now shows success');
    await tick();
    // The engine-kind async-wake path is NOT taken for web.
    expect(reentries.length).toBe(0);
  });

  test('threads the owned tabId into the resident turn as residentTabId', async () => {
    let seenTabId: number | undefined = -1;
    const { messageResident } = webHarness({
      runResidentTurn: async (o: { residentTabId?: number }) => {
        seenTabId = o.residentTabId;
        return { result: 'ok' };
      },
    });
    await messageResident({ to: '42', message: 'x', senderSessionId: 'chat-1' });
    expect(seenTabId).toBe(42);
  });

  test('a thrown web turn returns ok:false INLINE (not a wake)', async () => {
    const { messageResident, reentries } = webHarness({
      runResidentTurn: async () => { throw new Error('tab closed'); },
    });
    const r = await messageResident({ to: '42', message: 'x', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('web resident turn failed');
    expect(r.error).toContain('tab closed');
    await tick();
    expect(reentries.length).toBe(0);
  });

  test('serializes concurrent messages to the SAME tab (never two turns at once)', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    // Each turn parks on its OWN gate (a queued resolver), so releasing one can't
    // accidentally free another — the test stays deterministic across microtasks.
    const releasers: Array<() => void> = [];
    const gate = () => new Promise<void>((res) => { releasers.push(res); });
    const { messageResident } = webHarness({
      caps: { rateCap: 100, outstanding: 100 },
      runResidentTurn: async (o: { message: string }) => {
        active++; maxActive = Math.max(maxActive, active);
        order.push(`start:${o.message}`);
        await gate();
        order.push(`end:${o.message}`);
        active--;
        return { result: o.message };
      },
    });
    // Wait (bounded) until exactly one turn is parked and waiting.
    const settle = async () => { for (let i = 0; i < 10 && releasers.length === 0; i++) await tick(); };
    // Fire two WITHOUT awaiting — they must queue, not overlap.
    const p1 = messageResident({ to: '42', message: 'A', senderSessionId: 'chat-1' });
    const p2 = messageResident({ to: '42', message: 'B', senderSessionId: 'chat-1' });
    await settle();
    expect(active).toBe(1);          // only A has started; B is queued behind the chain
    releasers.shift()?.();           // let A finish; B's turn then starts and re-gates
    await settle();
    expect(active).toBe(1);          // now only B is running — never both
    releasers.shift()?.();           // let B finish
    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });
});

describe('message_resident — runaway guard (per sender)', () => {
  test('refuses past the RATE cap within the window', async () => {
    // never-resolving turns keep nothing pending on the rate path; outstanding
    // is high so the rate cap is what trips.
    const { messageResident } = harness({
      runResidentTurn: () => new Promise(() => {}) as Promise<{ result: string }>,
      caps: { rateCap: 3, outstanding: 100 },
    });
    for (let i = 0; i < 3; i++) {
      expect((await messageResident({ to: 'app-1', message: `m${i}`, senderSessionId: 'chat-1' })).ok).toBe(true);
    }
    const r = await messageResident({ to: 'app-1', message: 'm4', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('runaway');
  });
  test('refuses past the OUTSTANDING cap (in-flight)', async () => {
    const { messageResident } = harness({
      runResidentTurn: () => new Promise(() => {}) as Promise<{ result: string }>,
      caps: { rateCap: 100, outstanding: 2 },
    });
    for (let i = 0; i < 2; i++) {
      expect((await messageResident({ to: 'app-1', message: `m${i}`, senderSessionId: 'chat-1' })).ok).toBe(true);
    }
    const r = await messageResident({ to: 'app-1', message: 'm3', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('in flight');
  });
});
