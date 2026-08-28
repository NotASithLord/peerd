import { describe, expect, test } from 'bun:test';
import { createActorLiveProjection } from '../../extension/background/actor-live-projection.js';

describe('actor live projection', () => {
  test('scopes bound actors to their root and removes them on finish', () => {
    const live = createActorLiveProjection({ epoch: 'worker-a' });
    const card = {
      rootSessionId: 'root-a', parentSessionId: 'root-a', parentToolUseId: 'tu-a',
      sessionId: 'web-a', actorCorrelationId: 'delivery-a', kind: 'web', streaming: true,
    };
    expect(live.snapshot('root-a')).toMatchObject({
      actorProjectionEpoch: 'worker-a', actorProjectionRevision: 0,
    });
    expect(live.startBound(card)).toBe(true);
    expect(live.snapshot('root-a').actorProjectionRevision).toBe(1);
    expect(live.patchBound(card, { messages: [{ id: 'm1' }] })).toBe(true);
    expect(live.snapshot('root-a').actorProjectionRevision).toBe(2);
    expect(live.snapshot('root-a').actors['tu-a'].messages).toEqual([{ id: 'm1' }]);
    expect(live.snapshot('root-a').actors['tu-a'].actorCorrelationId).toBe('delivery-a');
    expect(live.snapshot('root-b').actors).toEqual({});
    expect(live.finishBound(card)).toBe(true);
    expect(live.snapshot('root-a').actorProjectionRevision).toBe(3);
    expect(live.snapshot('root-a').actors).toEqual({});
  });

  test('late reused-id patches and finishes cannot corrupt a newer occurrence', () => {
    const live = createActorLiveProjection({ epoch: 'worker-a' });
    const oldCard = {
      rootSessionId: 'root', parentSessionId: 'root', parentToolUseId: 'reused',
      sessionId: 'old', actorCorrelationId: 'old-correlation', streaming: true,
    };
    const newCard = {
      rootSessionId: 'root', parentSessionId: 'root', parentToolUseId: 'reused',
      sessionId: 'new', actorCorrelationId: 'new-correlation', streaming: true,
    };
    expect(live.startBound(oldCard)).toBe(true);
    expect(live.startBound(newCard)).toBe(true);
    expect(live.epoch()).toBe('worker-a');
    expect(live.revision()).toBe(2);

    expect(live.patchBound(oldCard, { error: 'late old failure', streaming: false })).toBe(false);
    expect(live.finishBound(oldCard)).toBe(false);
    expect(live.revision()).toBe(2);
    expect(live.snapshot('root').actors.reused).toMatchObject({
      sessionId: 'new', actorCorrelationId: 'new-correlation',
      streaming: true,
    });

    expect(live.patchBound(newCard, { messages: [{ id: 'new-state' }] })).toBe(true);
    expect(live.revision()).toBe(3);
    expect(live.snapshot('root').actors.reused.messages).toEqual([{ id: 'new-state' }]);
    expect(live.finishBound(newCard)).toBe(true);
    expect(live.revision()).toBe(4);
    expect(live.snapshot('root').actors).toEqual({});
  });

  test('replays spawned state to a newly connected view and removes settled leaves', () => {
    const live = createActorLiveProjection();
    const start = live.foldSpawned({
      type: 'actor-start', rootSessionId: 'root', parentSessionId: 'root',
      parentToolUseId: 'tu', sessionId: 'child', depth: 1, task: 'inspect',
      visibleTools: ['read_page'],
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
    expect(live.snapshot('root').asyncTasks).toEqual({});
  });

  test('enumerates every active root without merging their snapshots', () => {
    const live = createActorLiveProjection();
    live.startBound({
      rootSessionId: 'root-b', parentSessionId: 'root-b',
      parentToolUseId: 'tu-bound', sessionId: 'web-b', kind: 'web',
    });
    live.foldSpawned({
      type: 'actor-start', rootSessionId: 'root-a', parentSessionId: 'root-a',
      parentToolUseId: 'tu-spawn', sessionId: 'child-a', task: 'inspect',
    });
    live.setAsyncTasks('root-c', [{ taskId: 'as-c', task: 'compare', status: 'running' }]);

    expect(live.rootSessionIds()).toEqual(['root-a', 'root-b', 'root-c']);
    expect(Object.keys(live.snapshot('root-a').actors)).toEqual([]);
    expect(Object.keys(live.snapshot('root-b').actors)).toEqual(['tu-bound']);

    live.finishBound({ rootSessionId: 'root-b', parentToolUseId: 'tu-bound' });
    live.foldSpawned({ type: 'actor-stop', sessionId: 'child-a', parentToolUseId: 'tu-spawn' });
    live.setAsyncTasks('root-c', [{ taskId: 'as-c', task: 'compare', status: 'delivered' }]);
    expect(live.rootSessionIds()).toEqual([]);
  });

  test('counts live workers without serializing their metadata or double-counting async hydration', () => {
    const live = createActorLiveProjection();
    live.startBound({
      rootSessionId: 'root', parentSessionId: 'root', parentToolUseId: 'bound-tu',
      sessionId: 'bound', kind: 'web', streaming: true, task: 'private label',
    });
    live.foldSpawned({
      type: 'actor-start', rootSessionId: 'root', parentSessionId: 'root',
      parentToolUseId: 'spawn-tu', sessionId: 'child', task: 'private task',
    });
    live.setAsyncTasks('root', [
      { taskId: 'hydrated', childSessionId: 'child', status: 'running' },
      { taskId: 'pending', status: 'running' },
      { taskId: 'terminal', status: 'delivered' },
    ]);

    expect(live.activeActorCount()).toBe(3);
    expect(JSON.stringify(live.activeActorCount())).not.toContain('private');
  });
});
