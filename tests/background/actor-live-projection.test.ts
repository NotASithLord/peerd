import { describe, expect, test } from 'bun:test';
import { createActorLiveProjection } from '../../extension/background/actor-live-projection.js';

describe('actor live projection', () => {
  test('scopes bound actors to their root and removes them on finish', () => {
    const live = createActorLiveProjection();
    const card = {
      rootSessionId: 'root-a', parentSessionId: 'root-a', parentToolUseId: 'tu-a',
      sessionId: 'web-a', kind: 'web', streaming: true,
    };
    expect(live.startBound(card)).toBe(true);
    expect(live.patchBound(card, { messages: [{ id: 'm1' }] })).toBe(true);
    expect(live.snapshot('root-a').actors['tu-a'].messages).toEqual([{ id: 'm1' }]);
    expect(live.snapshot('root-b').actors).toEqual({});
    expect(live.finishBound(card)).toBe(true);
    expect(live.snapshot('root-a').actors).toEqual({});
  });

  test('replays spawned state to a newly connected view and removes settled leaves', () => {
    const live = createActorLiveProjection();
    const start = live.foldSpawned({
      type: 'actor-start', rootSessionId: 'root', parentSessionId: 'root',
      parentToolUseId: 'tu', sessionId: 'child', depth: 1, task: 'inspect',
      grantedTools: ['read_page'],
    });
    expect(start).toMatchObject({ type: 'turn/spawned-start', rootSessionId: 'root' });
    live.foldSpawned({ type: 'state', session: { sessionId: 'child', messages: [{ id: 'm' }] } });
    expect(live.snapshot('root').spawned.sessions.child).toMatchObject({
      task: 'inspect', running: true, messages: [{ id: 'm' }],
    });
    live.foldSpawned({ type: 'actor-stop', sessionId: 'child', parentToolUseId: 'tu' });
    expect(live.snapshot('root').spawned.sessions).toEqual({});
  });

  test('keeps a settled lineage parent through async child hydration', () => {
    const live = createActorLiveProjection();
    live.foldSpawned({
      type: 'actor-start', rootSessionId: 'root', parentSessionId: 'root',
      parentToolUseId: 'parent-tu', sessionId: 'parent', task: 'coordinate',
    });
    live.setAsyncTasks('parent', [{
      taskId: 'as-1', childSessionId: 'late-child', task: 'continue', status: 'running',
    }]);
    live.foldSpawned({ type: 'actor-stop', sessionId: 'parent', parentToolUseId: 'parent-tu' });
    expect(live.snapshot('root').spawned.sessions.parent.running).toBe(false);
    expect(live.snapshot('root').asyncTasks.parent).toHaveLength(1);

    live.setAsyncTasks('parent', [{
      taskId: 'as-1', childSessionId: 'late-child', task: 'continue', status: 'delivered',
    }]);
    expect(live.snapshot('root').spawned.sessions).toEqual({});
  });
});
