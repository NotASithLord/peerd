import { describe, test, expect } from 'bun:test';
import { INITIAL_STATE, reduceChat as reduceChatRaw } from '../../extension/sidepanel/chat-reducer.js';

// reduceChat returns the loose `object` type (the no-build extension has no
// named State type); cast through a thin wrapper so the tests can read the
// folded properties without per-line casts.
const reduceChat = (state: any, msg: any): any => reduceChatRaw(state, msg);

// DESIGN-12: this pure reducer is the shared chat brain — both the side panel
// and home fold SW pushes through it. These pin the contract the surfaces rely
// on: correct folds, the per-session guards, confirm dismiss, and the
// "unchanged → same ref" rule each surface uses to skip a redraw.

const withSession = (sessionId: string, messages: any[] = []) =>
  ({ ...INITIAL_STATE, session: { sessionId, messages, cost: null } });

describe('reduceChat', () => {
  test('unhandled / voice / malformed → returns the SAME ref (surface skips redraw)', () => {
    expect(reduceChat(INITIAL_STATE, { type: 'voice/chunk' })).toBe(INITIAL_STATE);
    expect(reduceChat(INITIAL_STATE, { type: 'totally/unknown' })).toBe(INITIAL_STATE);
    expect(reduceChat(INITIAL_STATE, {} as any)).toBe(INITIAL_STATE);
  });

  test('turn/delta appends streaming text to the matching message', () => {
    const s0 = withSession('s1', [{ id: 'm1', role: 'assistant', content: 'He', streaming: true }]);
    const s1 = reduceChat(s0, { type: 'turn/delta', sessionId: 's1', messageId: 'm1', text: 'llo' });
    expect(s1.session.messages[0].content).toBe('Hello');
    expect(s1).not.toBe(s0); // new ref
  });

  test('per-session guard: a BACKGROUND session delta does not touch the viewed chat', () => {
    const s0 = withSession('viewed', [{ id: 'm1', content: 'x' }]);
    const s1 = reduceChat(s0, { type: 'turn/delta', sessionId: 'other', messageId: 'm1', text: '!' });
    expect(s1).toBe(s0); // guarded out → same ref
  });

  test('turn/state adopts the session; turn/streaming + cost guard by session', () => {
    const adopted = reduceChat(INITIAL_STATE, { type: 'turn/state', session: { sessionId: 's1', messages: [{ id: 'm1' }] } });
    expect(adopted.session.sessionId).toBe('s1');
    expect(adopted.session.messages).toHaveLength(1);

    const streamingOn = reduceChat(adopted, { type: 'turn/streaming', sessionId: 's1', streaming: true });
    expect(streamingOn.streaming).toBe(true);
    // a different session's pulse must not flip the viewed chat
    expect(reduceChat(streamingOn, { type: 'turn/streaming', sessionId: 'bg', streaming: false })).toBe(streamingOn);
  });

  test('confirm/request stores the prompt; confirm/resolved dismisses only the matching id', () => {
    const asked = reduceChat(INITIAL_STATE, { type: 'confirm/request', prompt: { id: 'c1', text: 'ok?' } });
    expect(asked.pendingConfirm).toEqual({ id: 'c1', text: 'ok?' });
    // a stale id leaves it alone (same ref)
    expect(reduceChat(asked, { type: 'confirm/resolved', id: 'cZ' })).toBe(asked);
    // the matching id clears it
    expect(reduceChat(asked, { type: 'confirm/resolved', id: 'c1' }).pendingConfirm).toBe(null);
  });

  // DESIGN-12 critical fix: a 'state' snapshot (which carries pendingConfirm:null)
  // must NOT wipe a live prompt — confirm state flows on its own channel.
  test('a state snapshot does NOT wipe a live pendingConfirm', () => {
    const asked = reduceChat(INITIAL_STATE, { type: 'confirm/request', prompt: { id: 'c1', text: 'ok?' } });
    const after = reduceChat(asked, { type: 'state', state: {
      session: { sessionId: 's1', messages: [] },
      vault: { initialized: true, locked: false },
      pendingConfirm: null,
    } });
    expect(after.pendingConfirm).toEqual({ id: 'c1', text: 'ok?' }); // preserved
    expect(after.session.sessionId).toBe('s1');                       // snapshot still applied
  });

  test('async-tasks/update keys the snapshot by parent session', () => {
    const s1 = reduceChat(INITIAL_STATE, { type: 'async-tasks/update', parentSessionId: 'p1', tasks: [{ taskId: 'as-1' }] });
    expect(s1.asyncTasks.p1).toEqual([{ taskId: 'as-1' }]);
  });

  test('subagent-start seeds a shell; subagent-state folds the authoritative session', () => {
    const seeded = reduceChat(INITIAL_STATE, { type: 'turn/subagent-start', sessionId: 'c1', depth: 1, task: 'research' });
    expect(seeded.subagents.sessions.c1.task).toBe('research');
    const folded = reduceChat(seeded, { type: 'turn/subagent-state', session: { sessionId: 'c1', messages: [{ id: 'x' }] } });
    expect(folded.subagents.sessions.c1.messages).toHaveLength(1);
  });

  test('goal/state tracks a run per session, and a terminal phase clears it', () => {
    const running: any = reduceChat(INITIAL_STATE, {
      type: 'goal/state', sessionId: 's1', phase: 'running', iteration: 3, maxIterations: 40, goal: 'ship it', summary: null,
    });
    expect(running.goalRuns.s1).toMatchObject({ active: true, iteration: 3, goal: 'ship it' });
    // A different session's run is independent.
    const two: any = reduceChat(running, {
      type: 'goal/state', sessionId: 's2', phase: 'running', iteration: 1, maxIterations: 40, goal: 'other', summary: null,
    });
    expect(Object.keys(two.goalRuns).sort()).toEqual(['s1', 's2']);
    // Terminal phase removes only that session's entry.
    const done: any = reduceChat(two, { type: 'goal/state', sessionId: 's1', phase: 'done', summary: 'shipped' });
    expect(done.goalRuns.s1).toBeUndefined();
    expect(done.goalRuns.s2).toBeDefined();
  });
});
