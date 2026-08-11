import { describe, expect, test } from 'bun:test';
import { scheduleCreateTool } from '../../../extension/peerd-runtime/tools/defs/schedule-create.js';

describe('schedule_create cancellation', () => {
  test('Stop during forced confirmation cannot arm a routine after a late yes', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveConfirmation: (answer: 'yes_once') => void = () => {};
    let additions = 0;
    const pending = scheduleCreateTool.execute({ prompt: 'check releases', every: '1h' }, {
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
    } as any);

    await Promise.resolve();
    expect(seenSignal).toBe(controller.signal);
    controller.abort();
    resolveConfirmation('yes_once');

    expect(await pending).toMatchObject({ ok: false, error: 'schedule_aborted' });
    expect(additions).toBe(0);
  });
});
