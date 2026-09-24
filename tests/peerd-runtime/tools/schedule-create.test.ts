import { describe, expect, test } from 'bun:test';
import { createScheduleToolAuthority } from '../../../extension/background/schedule-tool-authority.js';
import { makeScheduler } from '../../../extension/peerd-runtime/loop/scheduler.js';
import { scheduleCreateTool } from '../../../extension/peerd-runtime/tools/defs/schedule-create.js';

describe('schedule_create cancellation', () => {
  test('Stop during cold hydration cannot arm a confirmed routine', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const writes: unknown[] = [];
    const scheduler = makeScheduler({
      fireRoutine: async () => {},
      kv: {
        get: async () => { entered.resolve(); await releaseRead.promise; return {}; },
        set: async (_key, value) => { writes.push(value); },
      },
    });
    const args = { prompt: 'check releases', every: '1h' };
    const authority = createScheduleToolAuthority({
      operation: 'turn.schedule.arm-confirmed-routine', args,
      signal: controller.signal,
      ctx: {
        permission: { mode: 'act' },
        confirm: async () => true,
        scheduleAdd: (request: any) => scheduler.add(request),
      },
    });
    const pending = authority.armConfirmedRoutine({
      ...args, dailyAt: undefined, mode: undefined,
    });
    await entered.promise;
    controller.abort();
    releaseRead.resolve();
    expect(await pending).toMatchObject({ ok: false, error: 'schedule-aborted' });
    expect(scheduler.list()).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('Stop during forced confirmation cannot arm a routine after a late yes', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveConfirmation: (answer: 'yes_once') => void = () => {};
    let additions = 0;
    const args = { prompt: 'check releases', every: '1h' };
    const authority = createScheduleToolAuthority({
      operation: 'turn.schedule.arm-confirmed-routine', args,
      signal: controller.signal,
      ctx: {
      abortSignal: controller.signal,
      permission: { mode: 'act', confirmActions: false },
      session: { sessionId: 'chat-1' },
      confirm: async (_prompt: unknown, signal?: AbortSignal) => {
        seenSignal = signal;
        return await new Promise<'yes_once'>((resolve) => { resolveConfirmation = resolve; });
      },
      scheduleAdd: () => {
        additions += 1;
        return { ok: true, routine: {} };
      },
      },
    });
    const pending = authority.armConfirmedRoutine({
      prompt: 'check releases', every: '1h', dailyAt: undefined, mode: undefined,
    });

    await Promise.resolve();
    expect(seenSignal).toBe(controller.signal);
    controller.abort();
    resolveConfirmation('yes_once');

    expect(await pending).toMatchObject({ ok: false, error: 'schedule_aborted' });
    expect(additions).toBe(0);
  });

  test('Stop after durable admission preserves the armed receipt', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let seenSignal: AbortSignal | undefined;
    let stored: unknown;
    const scheduler = makeScheduler({
      fireRoutine: async () => {},
      kv: {
        get: async () => ({}),
        set: async (_key, value) => {
          started.resolve();
          await release.promise;
          stored = structuredClone(value);
        },
      },
    });
    const args = { prompt: 'check releases', every: '1h' };
    const authority = createScheduleToolAuthority({
      operation: 'turn.schedule.arm-confirmed-routine', args,
      signal: controller.signal,
      ctx: {
        permission: { mode: 'act' },
        confirm: async () => true,
        scheduleAdd: (request: any) => {
          seenSignal = request.signal;
          return scheduler.add(request);
        },
      },
    });
    const pending = scheduleCreateTool.execute(args, {
      abortSignal: controller.signal,
      scheduleAuthority: authority,
    } as any);
    await started.promise;
    controller.abort();
    release.resolve();

    expect(seenSignal).toBe(controller.signal);
    expect(await pending).toMatchObject({ ok: true });
    expect(scheduler.list()).toHaveLength(1);
    expect(Object.values(stored as Record<string, unknown>)).toHaveLength(1);
  });
});
