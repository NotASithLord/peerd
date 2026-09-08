import { describe, expect, test } from 'bun:test';
import {
  CONTROLLER_LOCAL_TOOL_NAMES,
  controllerHostsLocalTool,
  executeControllerLocalTool,
} from '../../extension/peerd-runtime/controller-local-tools.js';

describe('controller-local tools', () => {
  test('owns a closed semantic-only set', () => {
    expect(CONTROLLER_LOCAL_TOOL_NAMES).toEqual(['now', 'complete_goal']);
    expect(controllerHostsLocalTool('now')).toBe(true);
    expect(controllerHostsLocalTool('complete_goal')).toBe(true);
    expect(controllerHostsLocalTool('read_memory')).toBe(false);
    expect(controllerHostsLocalTool('__proto__')).toBe(false);
  });

  test('executes now without an authority call', async () => {
    let authorityCalls = 0;
    const result = await executeControllerLocalTool('now', {}, {
      completeGoal: async () => { authorityCalls += 1; return {}; },
    });
    expect(authorityCalls).toBe(0);
    expect(JSON.parse(result.content)).toMatchObject({
      iso: expect.any(String), unixMs: expect.any(Number),
      timezone: expect.any(String), dayOfWeek: expect.any(String),
    });
  });

  test('uses only exact goal completion authority', async () => {
    const summaries: string[] = [];
    const result = await executeControllerLocalTool('complete_goal', {
      summary: '  done  ',
    }, {
      completeGoal: async (summary) => {
        summaries.push(summary);
        return { ok: true, outcomeKnown: true, value: { ended: true } };
      },
    });
    expect(summaries).toEqual(['done']);
    expect(result).toEqual({ ok: true, content: 'Goal run ended. Summary: done' });
  });
});
