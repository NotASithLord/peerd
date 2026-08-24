import { describe, expect, test } from 'bun:test';
import { scheduleListTool } from '../../../extension/peerd-runtime/tools/defs/schedule-list.js';

describe('schedule_list', () => {
  test('reports durable outcome uncertainty', async () => {
    const result = await scheduleListTool.execute({}, {
      scheduleList: () => [{
        id: 'routine-1', prompt: 'check', schedule: { kind: 'interval', everyMs: 3_600_000 }, mode: 'turn',
        enabled: true, nextRunAt: 2_000, lastRunAt: 1_000,
        lastOutcomeUnknownAt: 1_000, runCount: 1,
      }],
    } as any);
    expect(JSON.parse(result.content ?? '')[0]).toMatchObject({
      id: 'routine-1',
      lastOutcomeUnknownAt: new Date(1_000).toISOString(),
    });
  });
});
