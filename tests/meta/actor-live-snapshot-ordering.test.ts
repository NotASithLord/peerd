import { describe, expect, test } from 'bun:test';
import {
  INITIAL_STATE, resetChatAfterRuntimeLoss,
} from '../../extension/sidepanel/chat-reducer.js';

describe('actor live snapshot ordering', () => {
  test('disconnect reset drops worker-owned live projections and keeps durable posture', () => {
    const prior = {
      ...INITIAL_STATE,
      hydrated: true,
      projection: { authorityEpoch: 'old', generation: 9 },
      vault: { ...INITIAL_STATE.vault, initialized: true, locked: false, unlockedAt: 42 },
      providers: { ...INITIAL_STATE.providers, current: 'openai', hasKey: true },
      pendingConfirm: { id: 'stale' },
      streaming: true,
      actorProjectionEpoch: 'actor-old',
      actorProjectionRevision: 17,
      actors: { stale: { streaming: true } },
      spawned: { byToolUse: { stale: 'child' }, sessions: {} },
      asyncTasks: { stale: { status: 'running' } },
    } as any;
    const reset = resetChatAfterRuntimeLoss(prior) as any;
    expect(reset).toMatchObject({
      hydrated: false,
      projection: null,
      vault: { initialized: true, locked: true, unlockedAt: 0 },
      providers: { current: 'openai', hasKey: false },
      pendingConfirm: null,
      streaming: false,
      actorProjectionEpoch: INITIAL_STATE.actorProjectionEpoch,
      actorProjectionRevision: INITIAL_STATE.actorProjectionRevision,
    });
    expect(reset.actors).toBe(INITIAL_STATE.actors);
    expect(reset.spawned).toBe(INITIAL_STATE.spawned);
    expect(reset.asyncTasks).toBe(INITIAL_STATE.asyncTasks);
  });
});
