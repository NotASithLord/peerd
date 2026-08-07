import { describe, expect, test } from 'bun:test';
import {
  actorDeliveryIdsFromMessage,
  makeActorRecoveryGate,
} from '../../extension/background/actor-recovery-gate.js';

describe('actor delivery custody', () => {
  test('collects live and script delivery ids once from committed user messages', () => {
    expect(actorDeliveryIdsFromMessage({
      role: 'user',
      actorReply: { actorDeliveryId: 'live-1' },
      toolResults: [
        { actorDeliveryId: 'awaited-1' },
        { actorDeliveryIds: ['script-1', 'live-1', '', 42] },
      ],
    })).toEqual(['live-1', 'awaited-1', 'script-1']);
  });

  test('ignores non-user messages and invalid or oversized ids', () => {
    expect(actorDeliveryIdsFromMessage({
      role: 'assistant', actorReply: { actorDeliveryId: 'not-committed-here' },
    })).toEqual([]);
    expect(actorDeliveryIdsFromMessage({
      role: 'user',
      toolResults: [{ actorDeliveryIds: ['x'.repeat(513), null] }],
    })).toEqual([]);
  });
});

describe('actor recovery gate', () => {
  test('automatic work waits until passive recovery has committed', async () => {
    let release = () => {};
    const recovery = new Promise<{ redrained: number; retained: number }>((resolve) => {
      release = () => resolve({ redrained: 0, retained: 0 });
    });
    const events: string[] = [];
    const gate = makeActorRecoveryGate({
      redrain: async () => {
        events.push('recovery-started');
        return recovery;
      },
    });

    const running = gate.runWhenReady('model-work', () => { events.push('model-work'); });
    await Promise.resolve();
    expect(events).toEqual(['recovery-started']);
    release();
    expect(await running).toBe(true);
    expect(events).toEqual(['recovery-started', 'model-work']);
  });

  test('a retained receipt blocks work and schedules a same-lifetime retry', async () => {
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const events: string[] = [];
    const gate = makeActorRecoveryGate({
      redrain: async () => ({ redrained: 0, retained: ++attempts === 1 ? 1 : 0 }),
      schedule: (fn) => { scheduled.push(fn); },
    });

    expect(await gate.runWhenReady('model-work', () => { events.push('model-work'); })).toBe(false);
    expect(events).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(events).toEqual(['model-work']);
  });

  test('repeated blocked nudges collapse to one pending action', async () => {
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const events: string[] = [];
    const gate = makeActorRecoveryGate({
      redrain: async () => ({ redrained: 0, retained: ++attempts < 3 ? 1 : 0 }),
      schedule: (fn) => { scheduled.push(fn); },
    });

    expect(await gate.runWhenReady('schedules', () => { events.push('old'); })).toBe(false);
    expect(await gate.runWhenReady('schedules', () => { events.push('latest'); })).toBe(false);
    expect(events).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['latest']);
  });

  test('ready reports recovery state without queueing user work', async () => {
    const scheduled: Array<() => void> = [];
    const gate = makeActorRecoveryGate({
      redrain: async () => ({ redrained: 0, retained: 1 }),
      schedule: (fn) => { scheduled.push(fn); },
    });

    expect(await gate.ready()).toBe(false);
    expect(scheduled).toHaveLength(1);
  });

  test('a recovery exception fails closed and remains retryable', async () => {
    const scheduled: Array<() => void> = [];
    const logs: unknown[] = [];
    const gate = makeActorRecoveryGate({
      redrain: async () => { throw new Error('storage unavailable'); },
      schedule: (fn) => { scheduled.push(fn); },
      log: (error) => { logs.push(error); },
    });

    expect(await gate.runWhenReady('model-work', () => { throw new Error('must not run'); })).toBe(false);
    expect(logs).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });
});
