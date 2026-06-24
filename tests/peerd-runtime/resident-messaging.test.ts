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
