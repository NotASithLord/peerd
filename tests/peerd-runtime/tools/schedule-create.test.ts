import { describe, expect, test } from 'bun:test';
import { createScheduleToolAuthority } from '../../../extension/background/schedule-tool-authority.js';

describe('schedule_create cancellation', () => {
  test('Stop during forced confirmation cannot arm a routine after a late yes', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveConfirmation: (answer: 'yes_once') => void = () => {};
    let additions = 0;
    const args = { prompt: 'check releases', every: '1h' };
    const authority = createScheduleToolAuthority({
      call: { name: 'schedule_create', args },
      signal: controller.signal,
      ctx: {
      abortSignal: controller.signal,
      permission: { confirmActions: false },
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
});
