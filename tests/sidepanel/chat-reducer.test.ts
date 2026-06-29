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

  // A 'state' snapshot (session switch / settings push) must clear the previous
  // chat's transient rate-limit banner — the snapshot carries no rateLimit
  // field, so an omitted reset bleeds the "⏳ Rate limited" banner into the
  // switched-to (idle) chat.
  test('a state snapshot clears a stale rate-limit banner (no cross-session bleed)', () => {
    const paused = reduceChat(withSession('A'), {
      type: 'turn/rate-limit-pause', sessionId: 'A', attempt: 2, retryAfterMs: 5000,
    });
    expect(paused.rateLimit).toEqual({ attempt: 2, retryAfterMs: 5000 });
    const switched = reduceChat(paused, { type: 'state', state: { session: { sessionId: 'B', messages: [] } } });
    expect(switched.session.sessionId).toBe('B');
    expect(switched.rateLimit).toBe(null);
  });

  // The spend-limit halt ("raise your limit to continue") is a per-SESSION
  // state, not a per-push one: a 'state' push from a Plan/Act toggle or
  // /system must NOT erase it while the same session is still halted — but a
  // switch to a different session clears it.
  test('a same-session state push preserves the spend-limit halt; a session switch clears it', () => {
    const halted = reduceChat(withSession('A'), { type: 'turn/spend-limit-reached', sessionId: 'A', limitUsd: 5 });
    expect(halted.cost.limitReached).toBe(true);
    expect(halted.lastError).toBe('spend-limit-reached');

    // same session (e.g. a settings / mode-toggle push) → halt preserved
    const sameSession = reduceChat(halted, { type: 'state', state: { session: { sessionId: 'A', messages: [] } } });
    expect(sameSession.cost.limitReached).toBe(true);
    expect(sameSession.lastError).toBe('spend-limit-reached');

    // switching to a different session → halt cleared
    const switched = reduceChat(halted, { type: 'state', state: { session: { sessionId: 'B', messages: [] } } });
    expect(switched.cost.limitReached).toBe(false);
    expect(switched.lastError).toBe(null);
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

  test('actor display card: start seeds, state slices to fromIndex, done stops streaming', () => {
    // DESIGN-17 P1 glass pane. An actor is long-lived; the card shows only THIS
    // exchange (messages from fromIndex), not the actor's whole history.
    const started = reduceChat(INITIAL_STATE, {
      type: 'turn/actor-start', parentToolUseId: 'tu-1', sessionId: 'res-1',
      fromIndex: 2, kind: 'app', instanceId: 'app-9', name: 'todo',
    });
    expect(started.actors['tu-1']).toMatchObject({ sessionId: 'res-1', kind: 'app', fromIndex: 2, streaming: true });
    // A full actor-session snapshot (4 msgs) → the card keeps only msgs 2..end.
    const stateMsg = { type: 'turn/actor-state', parentToolUseId: 'tu-1',
      session: { sessionId: 'res-1', messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] } };
    const filled = reduceChat(started, stateMsg);
    expect(filled.actors['tu-1'].messages.map((m: any) => m.id)).toEqual(['c', 'd']);
    const done = reduceChat(filled, { type: 'turn/actor-done', parentToolUseId: 'tu-1', ok: true });
    expect(done.actors['tu-1'].streaming).toBe(false);
  });

  test('actor done: an abort renders cancelled; an ok:false failure marks failed; churn is short-circuited', () => {
    const started = reduceChat(INITIAL_STATE, { type: 'turn/actor-start', parentToolUseId: 'tu-a', sessionId: 'r', fromIndex: 0 });
    const aborted = reduceChat(started, { type: 'turn/actor-done', parentToolUseId: 'tu-a', ok: true, aborted: true });
    expect(aborted.actors['tu-a']).toMatchObject({ streaming: false, aborted: true });
    // A done after a card is already terminal (error folded first) is a no-op (no churn).
    const erroredThenDone = reduceChat(
      reduceChat(started, { type: 'turn/actor-error', parentToolUseId: 'tu-a', error: 'boom' }),
      { type: 'turn/actor-done', parentToolUseId: 'tu-a', ok: false });
    expect(reduceChat(erroredThenDone, { type: 'turn/actor-done', parentToolUseId: 'tu-a', ok: false })).toBe(erroredThenDone);
    // ok:false with no prior error → marked failed.
    const s2 = reduceChat(INITIAL_STATE, { type: 'turn/actor-start', parentToolUseId: 'tu-b', sessionId: 'r2', fromIndex: 0 });
    expect(reduceChat(s2, { type: 'turn/actor-done', parentToolUseId: 'tu-b', ok: false }).actors['tu-b'].error).toBeTruthy();
  });

  test('actor card self-seeds from a state push when start was missed (mid-turn reconnect)', () => {
    const seeded = reduceChat(INITIAL_STATE, {
      type: 'turn/actor-state', parentToolUseId: 'tu-c', fromIndex: 1, kind: 'app',
      session: { messages: [{ id: 'a' }, { id: 'b' }] },
    });
    expect(seeded.actors['tu-c']).toMatchObject({ kind: 'app', fromIndex: 1, streaming: true });
    expect(seeded.actors['tu-c'].messages.map((m: any) => m.id)).toEqual(['b']);
    // A state push with no fromIndex and no existing card can't be placed → dropped.
    expect(reduceChat(INITIAL_STATE, { type: 'turn/actor-state', parentToolUseId: 'x', session: { messages: [] } })).toBe(INITIAL_STATE);
  });

  test('actor card error + cost fold; a state push for an unknown card is a no-op', () => {
    const started = reduceChat(INITIAL_STATE, { type: 'turn/actor-start', parentToolUseId: 'tu-2', sessionId: 'res-2', fromIndex: 0 });
    const errored = reduceChat(started, { type: 'turn/actor-error', parentToolUseId: 'tu-2', error: 'tab closed' });
    expect(errored.actors['tu-2']).toMatchObject({ error: 'tab closed', streaming: false });
    const costed = reduceChat(errored, { type: 'turn/actor-cost', parentToolUseId: 'tu-2', cost: { cost: 0.0123 } });
    expect(costed.actors['tu-2'].cost.cost).toBe(0.0123);
    // A state push for a card that was never started is dropped (no crash).
    expect(reduceChat(costed, { type: 'turn/actor-state', parentToolUseId: 'nope', session: { messages: [] } })).toBe(costed);
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

// DESIGN-18: an agent-tab notice anchors to the message_actor turn DRIVING its actor
// (tab.parentToolUseId), not the wall-clock-latest user message — so a card flows to its
// actor's most-recent message turn and resurfaces there when re-messaged, instead of all
// cards clumping at the chat's end (async actor work fires tab touches during later turns).
describe('reduceChat — agent-tab anchoring by message_actor turn', () => {
  // turn 1 (install) → vm delegation tu-vm-1; turn 2 (search) → web tu-web-1;
  // turn 3 (clone+run) → vm RE-delegation tu-vm-2.
  const convo = () => withSession('s1', [
    { id: 'u1', role: 'user', content: 'install cowpy' },
    { id: 'a1', role: 'assistant', toolUses: [{ id: 'tu-vm-1', name: 'message_actor' }] },
    { id: 'u2', role: 'user', content: 'search for a node app' },
    { id: 'a2', role: 'assistant', toolUses: [{ id: 'tu-web-1', name: 'message_actor' }] },
    { id: 'u3', role: 'user', content: 'clone + run it on the vm' },
    { id: 'a3', role: 'assistant', toolUses: [{ id: 'tu-vm-2', name: 'message_actor' }] },
  ]);
  const tab = (over: any) => ({ type: 'agent/tab', tab: { tabId: 100, opened: true, noted: true, ...over } });

  test('anchors to the INVOKING turn, not the wall-clock-latest user message', () => {
    // The VM tab physically opens during turn 3 (async), but it was invoked in turn 1.
    const s = reduceChat(convo(), tab({ parentToolUseId: 'tu-vm-1' }));
    expect(s.agentTabEvents).toHaveLength(1);
    expect(s.agentTabEvents[0].turnId).toBe('u1');   // turn 1, NOT u3 (latest)
  });

  test('resurfaces to the newer turn when the SAME actor is re-messaged', () => {
    const s1 = reduceChat(convo(), tab({ parentToolUseId: 'tu-vm-1' }));      // anchored turn 1
    const s2 = reduceChat(s1, tab({ parentToolUseId: 'tu-vm-2' }));           // re-messaged turn 3
    expect(s2.agentTabEvents).toHaveLength(1);                                // same notice
    expect(s2.agentTabEvents[0].turnId).toBe('u3');                           // moved to turn 3
  });

  test('a DIFFERENT actor anchors to ITS own turn (cards do not clump)', () => {
    let s = reduceChat(convo(), tab({ tabId: 100, parentToolUseId: 'tu-vm-2' }));   // vm → turn 3
    s = reduceChat(s, tab({ tabId: 200, parentToolUseId: 'tu-web-1' }));            // web → turn 2
    const byTab = Object.fromEntries(s.agentTabEvents.map((e: any) => [e.tabId, e.turnId]));
    expect(byTab[100]).toBe('u3');   // vm at its latest message turn
    expect(byTab[200]).toBe('u2');   // web at its own turn — not pulled to the end
  });

  test('an orchestrator-opened tab (no parentToolUseId) keeps the wall-clock anchor', () => {
    const s = reduceChat(convo(), tab({ tabId: 300 }));   // open_tab, no driving actor
    expect(s.agentTabEvents[0].turnId).toBe('u3');        // latest user message (synchronous)
  });

  test('an unknown/late parentToolUseId falls back to wall-clock (no crash)', () => {
    const s = reduceChat(convo(), tab({ parentToolUseId: 'tu-not-in-view-yet' }));
    expect(s.agentTabEvents[0].turnId).toBe('u3');        // graceful fallback
  });
});
