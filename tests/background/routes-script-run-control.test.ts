import { describe, expect, test } from 'bun:test';
import { makeScriptRunControlRoutes } from '../../extension/background/routes/script-run-control.js';

describe('script-run/abort — settlement control plane', () => {
  const build = () => {
    const aborted: string[] = [];
    const route = makeScriptRunControlRoutes({
      scriptRuns: {
        ownerFor: (runId) => runId === 'live' ? 'owner-1' : null,
        abort: (runId) => { aborted.push(runId); },
      },
      isOffscreenSender: (sender) => sender?.offscreen === true,
    })['script-run/abort'];
    return { route, aborted };
  };

  test('only the exact offscreen host may abort an owner-matched live run', () => {
    const { route, aborted } = build();
    expect(route({ runId: 'live', ownerSessionId: 'owner-1' }, { offscreen: true })).toEqual({ ok: true });
    expect(aborted).toEqual(['live']);
  });

  test('a foreign sender, owner, unknown run, or missing identity fails closed', () => {
    const { route, aborted } = build();
    expect(route({ runId: 'live', ownerSessionId: 'owner-1' }, {} as any).ok).toBe(false);
    expect(route({ runId: 'live', ownerSessionId: 'owner-2' }, { offscreen: true }).ok).toBe(false);
    expect(route({ runId: 'finished', ownerSessionId: 'owner-1' }, { offscreen: true }).ok).toBe(false);
    expect(route({}, { offscreen: true }).ok).toBe(false);
    expect(aborted).toEqual([]);
  });
});
