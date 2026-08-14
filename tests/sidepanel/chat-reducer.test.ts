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
  test('the client becomes hydrated only after an authoritative state snapshot', () => {
    expect(INITIAL_STATE.hydrated).toBe(false);
    const hydrated = reduceChat(INITIAL_STATE, {
      type: 'state',
      state: { vault: { initialized: false, locked: true } },
    });
    expect(hydrated.hydrated).toBe(true);
  });

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

  test('a scoped system note appears only in its owning session', () => {
    const viewed = withSession('viewed');
    const matching = reduceChat(viewed, {
      type: 'turn/system-note', sessionId: 'viewed', text: 'Recovery for submit_form: Check the target.',
    });
    expect(matching.notices).toHaveLength(1);
    expect(matching.notices[0].text).toContain('submit_form');
    expect(matching.notices[0].sessionId).toBe('viewed');

    const switched = reduceChat(matching, {
      type: 'state', state: { session: { sessionId: 'other', messages: [] } },
    });
    expect(switched.notices).toHaveLength(0);

    const foreign = reduceChat(viewed, {
      type: 'turn/system-note', sessionId: 'other', text: 'Private recovery note',
    });
    expect(foreign).toBe(viewed);
    expect(foreign.notices).toHaveLength(0);

    // A targeted note racing the initial state snapshot must not stick and
    // later appear in whichever chat the surface adopts.
    expect(reduceChat(INITIAL_STATE, {
      type: 'turn/system-note', sessionId: 'other', text: 'Private recovery note',
    })).toBe(INITIAL_STATE);
  });

  test('an unscoped system note remains visible for current-chat UI feedback', () => {
    const viewed = withSession('viewed');
    const next = reduceChat(viewed, { type: 'turn/system-note', text: 'Settings saved.' });
    expect(next.notices[0].text).toBe('Settings saved.');
    const switched = reduceChat(next, {
      type: 'state', state: { session: { sessionId: 'other', messages: [] } },
    });
    expect(switched.notices[0].text).toBe('Settings saved.');
  });

  test('confirm/request stores the prompt; confirm/resolved dismisses only the matching id', () => {
    const asked = reduceChat(INITIAL_STATE, { type: 'confirm/request', prompt: { id: 'c1', text: 'ok?' } });
    expect(asked.pendingConfirm).toEqual({ id: 'c1', text: 'ok?' });
    // a stale id leaves it alone (same ref)
    expect(reduceChat(asked, { type: 'confirm/resolved', id: 'cZ' })).toBe(asked);
    // the matching id clears it
    expect(reduceChat(asked, { type: 'confirm/resolved', id: 'c1' }).pendingConfirm).toBe(null);
  });

  test('a confirmation is visible only in its owning root chat', () => {
    const viewed = withSession('chat-a');
    const prompt = { id: 'c1', sessionId: 'actor-a', ownerSessionId: 'chat-a', text: 'ok?' };
    const asked = reduceChat(viewed, { type: 'confirm/request', prompt });
    expect(asked.pendingConfirm).toEqual(prompt);

    const foreign = withSession('chat-b');
    expect(reduceChat(foreign, { type: 'confirm/request', prompt })).toBe(foreign);
  });

  test('a session switch clears the old prompt and adopts a pending prompt owned by the new chat', () => {
    const asked = {
      ...withSession('chat-a'),
      pendingConfirm: { id: 'old', ownerSessionId: 'chat-a' },
    };
    const pending = { id: 'new', sessionId: 'actor-b', ownerSessionId: 'chat-b' };
    const switched = reduceChat(asked, { type: 'state', state: {
      session: { sessionId: 'chat-b', messages: [] },
      pendingConfirm: pending,
    } });
    expect(switched.pendingConfirm).toEqual(pending);

    const noPending = reduceChat(asked, { type: 'state', state: {
      session: { sessionId: 'chat-b', messages: [] },
      pendingConfirm: null,
    } });
    expect(noPending.pendingConfirm).toBe(null);
  });

  test('a scoped replay resurfaces a prompt that raced with its owner chat switch', () => {
    const viewed = withSession('chat-a');
    const prompt = { id: 'new', sessionId: 'actor-b', ownerSessionId: 'chat-b' };
    // The live request can arrive while the panel still identifies as chat A.
    const rejected = reduceChat(viewed, { type: 'confirm/request', prompt });
    expect(rejected).toBe(viewed);
    // A snapshot captured just before the request changes the viewed chat but
    // cannot contain it. pushState follows this message with a scoped replay.
    const switched = reduceChat(rejected, { type: 'state', state: {
      session: { sessionId: 'chat-b', messages: [] }, pendingConfirm: null,
    } });
    expect(switched.pendingConfirm).toBe(null);
    expect(reduceChat(switched, { type: 'confirm/request', prompt }).pendingConfirm)
      .toEqual(prompt);
  });

  // DESIGN-12 critical fix: a same-session state snapshot must NOT wipe a live
  // prompt that raced in over the confirm channel.
  test('a state snapshot does NOT wipe a live pendingConfirm', () => {
    const asked = reduceChat(withSession('s1'), { type: 'confirm/request', prompt: { id: 'c1', text: 'ok?' } });
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

  test('spawned lifecycle keeps live parentage + server-resolved grants through state, then settles', () => {
    const seeded = reduceChat(INITIAL_STATE, {
      type: 'turn/spawned-start', sessionId: 'c1', parentSessionId: 'root',
      depth: 1, task: 'research', grantedTools: ['script'],
    });
    expect(seeded.spawned.sessions.c1).toMatchObject({
      task: 'research', parentSessionId: 'root', grantedTools: ['script'], running: true,
    });
    const folded = reduceChat(seeded, { type: 'turn/spawned-state', session: { sessionId: 'c1', messages: [{ id: 'x' }] } });
    expect(folded.spawned.sessions.c1.messages).toHaveLength(1);
    expect(folded.spawned.sessions.c1).toMatchObject({
      parentSessionId: 'root', grantedTools: ['script'], running: true,
    });
    const done = reduceChat(folded, { type: 'turn/spawned-done', sessionId: 'c1' });
    expect(done.spawned.sessions.c1.running).toBe(false);
  });

  test('foreign actor lifecycle events never enter the viewed chat', () => {
    const viewingB: any = { ...INITIAL_STATE, session: { sessionId: 'chat-B', messages: [], cost: null } };
    const spawned = reduceChat(viewingB, {
      type: 'turn/spawned-start', rootSessionId: 'chat-A', parentSessionId: 'chat-A',
      sessionId: 'private-child', task: 'private A task',
    });
    const bound = reduceChat(viewingB, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentSessionId: 'chat-A',
      parentToolUseId: 'private-tool', sessionId: 'private-actor', fromIndex: 0,
    });
    expect(spawned).toBe(viewingB);
    expect(bound).toBe(viewingB);
    expect(reduceChat(viewingB, {
      type: 'async-tasks/update', parentSessionId: 'chat-A',
      tasks: [{ taskId: 'private', task: 'private pending task' }],
    })).toBe(viewingB);
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

  test('late reused-id live events cannot mutate the newer actor occurrence', () => {
    const oldStarted = reduceChat(INITIAL_STATE, {
      type: 'turn/actor-start', parentToolUseId: 'reused-live', sessionId: 'old-actor',
      actorCorrelationId: 'old-correlation', actorProjectionEpoch: 'worker-a',
      actorProjectionRevision: 1,
      fromIndex: 0, kind: 'web',
    });
    const newStarted = reduceChat(oldStarted, {
      type: 'turn/actor-start', parentToolUseId: 'reused-live', sessionId: 'new-actor',
      actorCorrelationId: 'new-correlation', actorProjectionEpoch: 'worker-a',
      actorProjectionRevision: 2,
      fromIndex: 0, kind: 'web',
    });
    const oldBase = {
      parentToolUseId: 'reused-live', actorCorrelationId: 'old-correlation',
      actorProjectionEpoch: 'worker-a', actorProjectionRevision: 1,
    };

    expect(reduceChat(newStarted, {
      type: 'turn/actor-state', ...oldBase,
      session: { messages: [{ id: 'late-old-state' }] },
    })).toBe(newStarted);
    expect(reduceChat(newStarted, {
      type: 'turn/actor-error', ...oldBase, error: 'late old failure',
    })).toBe(newStarted);
    expect(reduceChat(newStarted, {
      type: 'turn/actor-done', ...oldBase, ok: false,
    })).toBe(newStarted);
    expect(reduceChat(newStarted, {
      type: 'turn/actor-cost', ...oldBase, cost: { cost: 99 },
    })).toBe(newStarted);

    const matched = reduceChat(newStarted, {
      type: 'turn/actor-state', parentToolUseId: 'reused-live',
      actorCorrelationId: 'new-correlation', actorProjectionEpoch: 'worker-a',
      actorProjectionRevision: 3,
      session: { messages: [{ id: 'new-state' }] },
    });
    expect(matched.actors['reused-live']).toMatchObject({
      sessionId: 'new-actor', actorCorrelationId: 'new-correlation', streaming: true,
      messages: [{ id: 'new-state' }],
    });
    expect(matched.actorProjectionRevision).toBe(3);
  });

  test('a known pre-effect live error carries Not run custody onto the actor card', () => {
    const started = reduceChat(INITIAL_STATE, {
      type: 'turn/actor-start', parentToolUseId: 'known-pre-effect', sessionId: 'actor-1',
      actorCorrelationId: 'known-correlation', actorProjectionEpoch: 'worker-a',
      actorProjectionRevision: 1,
      fromIndex: 0, kind: 'web',
    });
    const failed = reduceChat(started, {
      type: 'turn/actor-error', parentToolUseId: 'known-pre-effect',
      actorCorrelationId: 'known-correlation', actorProjectionEpoch: 'worker-a',
      actorProjectionRevision: 2,
      error: 'actor-provider-boundary-blocked: the model request was not run',
      outcomeKnown: true, performed: false,
    });
    expect(failed.actors['known-pre-effect']).toMatchObject({
      streaming: false, outcomeKnown: true, performed: false,
      error: 'actor-provider-boundary-blocked: the model request was not run',
    });

    const reconciled = reduceChat(failed, {
      type: 'turn/state',
      session: {
        sessionId: null,
        messages: [
          { role: 'assistant', id: 'known-call', toolUses: [{
            id: 'known-pre-effect', name: 'message_actor',
            input: { to: 'web', message: 'inspect it' },
          }] },
          { role: 'user', id: 'known-ack', toolResults: [{
            tool_use_id: 'known-pre-effect', is_error: false,
            content: 'accepted', actorCorrelationId: 'known-correlation', actorTerminal: false,
          }] },
          { role: 'user', id: 'known-receipt', synthetic: true, actorReply: {
            kind: 'web', instanceId: 'web', parentToolUseId: 'known-pre-effect',
            actorDeliveryId: 'known-correlation', failed: true,
            outcomeKnown: true, performed: false,
          }, content: 'fenced receipt' },
        ],
      },
    });
    expect(reconciled.actors['known-pre-effect']).toMatchObject({
      streaming: false, outcomeKnown: true, performed: false,
      error: 'the actor request was not run',
    });
  });

  test('a delayed older full snapshot cannot overwrite a newer actor start', () => {
    const viewing = withSession('chat-A');
    const newStarted = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-snapshot',
      sessionId: 'new-actor', actorCorrelationId: 'new-correlation',
      actorProjectionEpoch: 'worker-a', actorProjectionRevision: 2,
      fromIndex: 0, kind: 'web',
    });
    const delayed = reduceChat(newStarted, {
      type: 'state',
      state: {
        session: { sessionId: 'chat-A', messages: [] },
        actorProjectionEpoch: 'worker-a',
        actorProjectionRevision: 1,
        actors: {
          'reused-snapshot': {
            sessionId: 'old-actor', actorCorrelationId: 'old-correlation',
            streaming: true, fromIndex: 0,
          },
        },
      },
    });
    expect(delayed.actorProjectionRevision).toBe(2);
    expect(delayed.actors['reused-snapshot']).toMatchObject({
      sessionId: 'new-actor', actorCorrelationId: 'new-correlation', streaming: true,
    });
  });

  test('a fresh worker epoch is accepted after disconnect and fences delayed old-worker data', () => {
    const oldStarted = reduceChat(withSession('chat-A'), {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'restart-id',
      sessionId: 'old-actor', actorCorrelationId: 'old-correlation',
      actorProjectionEpoch: 'worker-old', actorProjectionRevision: 50,
      fromIndex: 0, kind: 'web',
    });
    const disconnected = {
      ...oldStarted,
      actors: INITIAL_STATE.actors,
      actorProjectionEpoch: INITIAL_STATE.actorProjectionEpoch,
      actorProjectionRevision: INITIAL_STATE.actorProjectionRevision,
    };
    const freshSnapshot = reduceChat(disconnected, {
      type: 'state', state: {
        session: { sessionId: 'chat-A', messages: [] },
        actors: {}, actorProjectionEpoch: 'worker-new', actorProjectionRevision: 0,
      },
    });
    expect(freshSnapshot.actorProjectionEpoch).toBe('worker-new');
    expect(freshSnapshot.actorProjectionRevision).toBe(0);
    expect(freshSnapshot.actors).toEqual({});

    const newStarted = reduceChat(freshSnapshot, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'restart-id',
      sessionId: 'new-actor', actorCorrelationId: 'new-correlation',
      actorProjectionEpoch: 'worker-new', actorProjectionRevision: 1,
      fromIndex: 0, kind: 'web',
    });
    expect(newStarted.actors['restart-id']).toMatchObject({
      sessionId: 'new-actor', actorCorrelationId: 'new-correlation', streaming: true,
    });

    const delayedOldSnapshot = reduceChat(newStarted, {
      type: 'state', state: {
        session: { sessionId: 'chat-A', messages: [] },
        actorProjectionEpoch: 'worker-old', actorProjectionRevision: 51,
        actors: { 'restart-id': {
          sessionId: 'old-actor', actorCorrelationId: 'old-correlation', streaming: true,
        } },
      },
    });
    expect(delayedOldSnapshot.actorProjectionEpoch).toBe('worker-new');
    expect(delayedOldSnapshot.actors['restart-id'].sessionId).toBe('new-actor');
    expect(reduceChat(delayedOldSnapshot, {
      type: 'turn/actor-done', rootSessionId: 'chat-A', parentToolUseId: 'restart-id',
      actorCorrelationId: 'old-correlation', actorProjectionEpoch: 'worker-old',
      actorProjectionRevision: 52, ok: false,
    })).toBe(delayedOldSnapshot);
  });

  test('a durable actor reply settles a card when the live done pulse was missed', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'tu-stale',
      sessionId: 'actor-web', fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const receipt = {
      id: 'actor-reply-1', role: 'user', synthetic: true,
      actorReply: {
        kind: 'web', instanceId: 'web', parentToolUseId: 'tu-stale',
        actorDeliveryId: 'delivery-stale', failed: true, outcomeKnown: false,
      },
      content: 'fenced actor failure',
    };
    const call = {
      id: 'assistant-call', role: 'assistant',
      toolUses: [{ id: 'tu-stale', name: 'message_actor', input: { to: 'web' } }],
    };
    const accepted = {
      id: 'tool-result', role: 'user',
      toolResults: [{ tool_use_id: 'tu-stale', is_error: false, content: 'accepted', actorCorrelationId: 'delivery-stale' }],
    };

    const untrustedShape = reduceChat(started, {
      type: 'turn/state', session: {
        sessionId: 'chat-A',
        messages: [call, accepted, { ...receipt, id: 'not-a-receipt', role: 'assistant', synthetic: false }],
      },
    });
    expect(untrustedShape.actors['tu-stale'].streaming).toBe(true);

    const settled = reduceChat(started, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages: [call, accepted, receipt] },
    });

    expect(settled.actors['tu-stale']).toMatchObject({
      streaming: false, outcomeKnown: false,
      error: 'the actor turn ended with an unknown outcome',
    });
  });

  test('a correlated synthetic reply settles a unique call when its immediate result is missing', () => {
    const started = reduceChat(withSession('chat-A'), {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'missing-result',
      sessionId: 'actor-web', actorCorrelationId: 'delivery-only',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const settled = reduceChat(started, {
      type: 'turn/state',
      session: {
        sessionId: 'chat-A',
        messages: [
          { id: 'call', role: 'assistant', toolUses: [{
            id: 'missing-result', name: 'message_actor', input: { to: 'web' },
          }] },
          { id: 'receipt', role: 'user', synthetic: true, content: 'fenced reply', actorReply: {
            kind: 'web', instanceId: 'web', parentToolUseId: 'missing-result',
            actorDeliveryId: 'delivery-only', failed: false, outcomeKnown: true, performed: true,
          } },
        ],
      },
    });
    expect(settled.actors['missing-result']).toMatchObject({
      actorCorrelationId: 'delivery-only', streaming: false, error: null, outcomeKnown: true,
    });
  });

  test('a durable failure overrides an earlier aborted pulse', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'tu-aborted',
      sessionId: 'actor-web', fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const aborted = reduceChat(started, {
      type: 'turn/actor-done', rootSessionId: 'chat-A', parentToolUseId: 'tu-aborted',
      ok: true, aborted: true,
    });
    const messages = [
      { id: 'call', role: 'assistant', toolUses: [{
        id: 'tu-aborted', name: 'message_actor', input: { to: 'web' },
      }] },
      { id: 'accepted', role: 'user', toolResults: [{
        tool_use_id: 'tu-aborted', is_error: false, content: 'accepted', actorCorrelationId: 'delivery-aborted',
      }] },
      { id: 'receipt', role: 'user', synthetic: true, content: 'fenced failure', actorReply: {
        kind: 'web', instanceId: 'web', parentToolUseId: 'tu-aborted',
        actorDeliveryId: 'delivery-aborted', failed: true, outcomeKnown: false,
      } },
    ];

    const settled = reduceChat(aborted, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages },
    });
    expect(settled.actors['tu-aborted']).toMatchObject({
      streaming: false, aborted: false, outcomeKnown: false,
      error: 'the actor turn ended with an unknown outcome',
    });
  });

  test('a failed receipt is known unless the host explicitly marks it unknown', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'tu-known-failure',
      sessionId: 'actor-web', fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const messages = [
      { id: 'call', role: 'assistant', toolUses: [{
        id: 'tu-known-failure', name: 'message_actor', input: { to: 'web' },
      }] },
      { id: 'accepted', role: 'user', toolResults: [{
        tool_use_id: 'tu-known-failure', is_error: false, content: 'accepted',
        actorCorrelationId: 'delivery-known-failure',
      }] },
      { id: 'receipt', role: 'user', synthetic: true, content: 'fenced failure', actorReply: {
        kind: 'web', instanceId: 'web', parentToolUseId: 'tu-known-failure',
        actorDeliveryId: 'delivery-known-failure', failed: true,
      } },
    ];

    const settled = reduceChat(started, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages },
    });
    expect(settled.actors['tu-known-failure']).toMatchObject({
      streaming: false, outcomeKnown: true, error: 'the actor turn did not complete',
    });
  });

  test('an old receipt cannot settle a newer call when a provider reuses a tool-use id', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-id',
      sessionId: 'new-actor-turn', fromIndex: 4, kind: 'web', instanceId: 'web',
    });
    const oldTranscript = [
      { id: 'old-call', role: 'assistant', toolUses: [{
        id: 'reused-id', name: 'message_actor', input: { to: 'web' },
      }] },
      { id: 'old-result', role: 'user', toolResults: [{
        tool_use_id: 'reused-id', is_error: false, content: 'accepted', actorCorrelationId: 'delivery-old',
      }] },
      { id: 'new-call', role: 'assistant', toolUses: [{
        id: 'reused-id', name: 'message_actor', input: { to: 'web' },
      }] },
      { id: 'new-result', role: 'user', toolResults: [{
        tool_use_id: 'reused-id', is_error: false, content: 'accepted', actorCorrelationId: 'delivery-new',
      }] },
      // The older actor can reply late, after the provider has reused its tool id.
      { id: 'old-receipt', role: 'user', synthetic: true, content: 'old fenced reply', actorReply: {
        kind: 'web', instanceId: 'web', parentToolUseId: 'reused-id',
        actorDeliveryId: 'delivery-old', failed: false,
      } },
    ];

    const stillLive = reduceChat(started, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages: oldTranscript },
    });
    expect(stillLive.actors['reused-id'].streaming).toBe(true);

    const settled = reduceChat(stillLive, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages: [
        ...oldTranscript,
        { id: 'new-receipt', role: 'user', synthetic: true, content: 'new fenced reply', actorReply: {
          kind: 'web', instanceId: 'web', parentToolUseId: 'reused-id',
          actorDeliveryId: 'delivery-new', failed: false,
        } },
      ] },
    });
    expect(settled.actors['reused-id']).toMatchObject({ streaming: false, aborted: false, error: null });
  });

  test('awaited tool results settle stale cards, except the explicit async handoff', () => {
    const viewing = withSession('chat-A');
    const ids = [
      'await-ok', 'await-failed', 'await-unknown', 'await-cancelled',
      'await-cancelled-unknown', 'await-handoff',
    ];
    const started = ids.reduce((state, id) => reduceChat(state, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: id,
      sessionId: `actor-${id}`, fromIndex: 0, kind: 'web', instanceId: 'web',
    }), viewing);
    const messages = [
      { id: 'await-calls', role: 'assistant', toolUses: ids.map((id) => ({
        id, name: 'message_actor', input: { to: 'web', await: true },
      })) },
      { id: 'await-results', role: 'user', toolResults: [
        { tool_use_id: 'await-ok', is_error: false, content: 'outcome_unknown: not run',
          actorTerminal: true, actorOutcomeKnown: true, actorPerformed: true },
        { tool_use_id: 'await-failed', is_error: true, content: 'outcome_unknown: not run',
          actorTerminal: true, actorOutcomeKnown: true, actorPerformed: true },
        { tool_use_id: 'await-unknown', is_error: true, content: 'canonical failure',
          actorTerminal: true, actorOutcomeKnown: false, actorPerformed: true },
        { tool_use_id: 'await-cancelled', is_error: true, content: 'aborted by the user',
          actorTerminal: true, actorOutcomeKnown: true, actorAborted: true },
        { tool_use_id: 'await-cancelled-unknown', is_error: true, content: 'aborted after dispatch',
          actorTerminal: true, actorOutcomeKnown: false, actorPerformed: true, actorAborted: true },
        { tool_use_id: 'await-handoff', is_error: false,
          content: 'The actor is still working; its reply will arrive as a fenced note on a later turn.',
          actorTerminal: false },
      ] },
    ];

    const reconciled = reduceChat(started, {
      type: 'turn/state', session: { sessionId: 'chat-A', messages },
    });
    expect(reconciled.actors['await-ok']).toMatchObject({ streaming: false, error: null, outcomeKnown: true });
    expect(reconciled.actors['await-failed']).toMatchObject({
      streaming: false, error: 'the actor turn did not complete', outcomeKnown: true, performed: true,
    });
    expect(reconciled.actors['await-unknown']).toMatchObject({
      streaming: false, error: 'the actor turn ended with an unknown outcome', outcomeKnown: false,
    });
    expect(reconciled.actors['await-cancelled']).toMatchObject({
      streaming: false, aborted: true, error: null, outcomeKnown: true,
    });
    expect(reconciled.actors['await-cancelled-unknown']).toMatchObject({
      streaming: false, aborted: false,
      error: 'the actor turn ended with an unknown outcome', outcomeKnown: false,
    });
    expect(reconciled.actors['await-handoff'].streaming).toBe(true);
  });

  test('a default-async refusal cannot settle an older live card with a reused tool id', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-id',
      sessionId: 'old-actor', actorCorrelationId: 'old-correlation',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const reconciled = reduceChat(started, {
      type: 'turn/state',
      session: {
        sessionId: 'chat-A',
        messages: [
          { id: 'old-call', role: 'assistant', toolUses: [{
            id: 'reused-id', name: 'message_actor', input: { to: 'web', message: 'old work' },
          }] },
          { id: 'old-result', role: 'user', toolResults: [{
            tool_use_id: 'reused-id', is_error: false, content: 'accepted',
            actorCorrelationId: 'old-correlation', actorTerminal: false,
          }] },
          { id: 'new-call', role: 'assistant', toolUses: [{
            id: 'reused-id', name: 'message_actor', input: { to: '42', message: 'inspect it' },
          }] },
          { id: 'new-result', role: 'user', toolResults: [{
            tool_use_id: 'reused-id', is_error: true,
            content: 'page-authored prose must not decide custody',
            actorTerminal: true, actorOutcomeKnown: true, actorPerformed: false,
          }] },
        ],
      },
    });
    expect(reconciled.actors['reused-id']).toMatchObject({
      sessionId: 'old-actor', actorCorrelationId: 'old-correlation',
      streaming: true, error: null,
    });
  });

  test('an older correlated actor receipt still settles after a newer same-id pre-effect refusal', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-receipt',
      sessionId: 'old-actor', actorCorrelationId: 'old-delivery',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const prefix = [
      { id: 'old-call', role: 'assistant', toolUses: [{
        id: 'reused-receipt', name: 'message_actor', input: { to: 'web', message: 'old work' },
      }] },
      { id: 'old-result', role: 'user', toolResults: [{
        tool_use_id: 'reused-receipt', is_error: false, content: 'accepted',
        actorCorrelationId: 'old-delivery', actorTerminal: false,
      }] },
      { id: 'new-call', role: 'assistant', toolUses: [{
        id: 'reused-receipt', name: 'message_actor', input: { to: '42', message: 'inspect it' },
      }] },
      { id: 'new-result', role: 'user', toolResults: [{
        tool_use_id: 'reused-receipt', is_error: true, content: 'numeric tab refused',
        actorTerminal: true, actorOutcomeKnown: true, actorPerformed: false,
      }] },
    ];

    for (const failed of [false, true]) {
      const settled = reduceChat(started, {
        type: 'turn/state',
        session: {
          sessionId: 'chat-A',
          messages: [...prefix, {
            id: `old-receipt-${failed}`, role: 'user', synthetic: true, content: 'fenced reply',
            actorReply: {
              kind: 'web', instanceId: 'web', parentToolUseId: 'reused-receipt',
              actorDeliveryId: 'old-delivery', failed, outcomeKnown: true, performed: true,
            },
          }],
        },
      });
      expect(settled.actors['reused-receipt']).toMatchObject({
        actorCorrelationId: 'old-delivery', streaming: false, outcomeKnown: true,
        error: failed ? 'the actor turn did not complete' : null,
      });
    }
  });

  test('a correlated receipt survives both a missing acknowledgement and later tool-id reuse', () => {
    const started = reduceChat(withSession('chat-A'), {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-missing',
      sessionId: 'old-actor', actorCorrelationId: 'old-delivery',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const prefix = [
      { id: 'old-call', role: 'assistant', toolUses: [{
        id: 'reused-missing', name: 'message_actor', input: { to: 'web', message: 'old work' },
      }] },
      { id: 'new-call', role: 'assistant', toolUses: [{
        id: 'reused-missing', name: 'message_actor', input: { to: '42', message: 'inspect it' },
      }] },
      { id: 'new-result', role: 'user', toolResults: [{
        tool_use_id: 'reused-missing', is_error: true, content: 'numeric tab refused',
        actorTerminal: true, actorOutcomeKnown: true, actorPerformed: false,
      }] },
    ];

    for (const failed of [false, true]) {
      const settled = reduceChat(started, {
        type: 'turn/state',
        session: {
          sessionId: 'chat-A',
          messages: [...prefix, {
            id: `old-receipt-missing-${failed}`, role: 'user', synthetic: true,
            content: 'fenced reply', actorReply: {
              kind: 'web', instanceId: 'web', parentToolUseId: 'reused-missing',
              actorDeliveryId: 'old-delivery', failed, outcomeKnown: true, performed: true,
            },
          }],
        },
      });
      expect(settled.actors['reused-missing']).toMatchObject({
        actorCorrelationId: 'old-delivery', streaming: false, outcomeKnown: true,
        error: failed ? 'the actor turn did not complete' : null,
      });
    }
  });

  test('an older correlated awaited result settles after a newer same-id pre-effect refusal', () => {
    const started = reduceChat(withSession('chat-A'), {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'reused-awaited',
      sessionId: 'old-actor', actorCorrelationId: 'old-awaited',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const cases = [
      { name: 'success', is_error: false, outcomeKnown: true, performed: true, error: null },
      {
        name: 'failure', is_error: true, outcomeKnown: true, performed: true,
        error: 'the actor turn did not complete',
      },
      {
        name: 'unknown', is_error: true, outcomeKnown: false, performed: true,
        error: 'the actor turn ended with an unknown outcome',
      },
    ];

    for (const item of cases) {
      const settled = reduceChat(started, {
        type: 'turn/state',
        session: {
          sessionId: 'chat-A',
          messages: [
            { id: 'old-call', role: 'assistant', toolUses: [{
              id: 'reused-awaited', name: 'message_actor',
              input: { to: 'web', message: 'old work', await: true },
            }] },
            { id: `old-result-${item.name}`, role: 'user', toolResults: [{
              tool_use_id: 'reused-awaited', is_error: item.is_error,
              actorCorrelationId: 'old-awaited', actorTerminal: true,
              actorOutcomeKnown: item.outcomeKnown, actorPerformed: item.performed,
              content: item.name,
            }] },
            { id: 'new-call', role: 'assistant', toolUses: [{
              id: 'reused-awaited', name: 'message_actor',
              input: { to: '42', message: 'inspect it' },
            }] },
            { id: 'new-result', role: 'user', toolResults: [{
              tool_use_id: 'reused-awaited', is_error: true, content: 'numeric tab refused',
              actorTerminal: true, actorOutcomeKnown: true, actorPerformed: false,
            }] },
          ],
        },
      });
      expect(settled.actors['reused-awaited']).toMatchObject({
        actorCorrelationId: 'old-awaited', streaming: false,
        outcomeKnown: item.outcomeKnown, error: item.error,
      });
    }
  });

  test('a correlated awaited pre-effect failure settles a missed live done pulse', () => {
    const viewing = withSession('chat-A');
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'chat-A', parentToolUseId: 'failed-start',
      sessionId: 'actor-failed-start', actorCorrelationId: 'current-correlation',
      fromIndex: 0, kind: 'web', instanceId: 'web',
    });
    const reconciled = reduceChat(started, {
      type: 'turn/state',
      session: {
        sessionId: 'chat-A',
        messages: [
          { id: 'call', role: 'assistant', toolUses: [{
            id: 'failed-start', name: 'message_actor',
            input: { to: 'web', message: 'inspect it', await: true },
          }] },
          { id: 'result', role: 'user', toolResults: [{
            tool_use_id: 'failed-start', is_error: true,
            actorCorrelationId: 'current-correlation', actorTerminal: true,
            actorOutcomeKnown: true, actorPerformed: false,
            content: 'the isolated actor worker did not start',
          }] },
        ],
      },
    });
    expect(reconciled.actors['failed-start']).toMatchObject({
      actorCorrelationId: 'current-correlation', streaming: false, aborted: false,
      error: 'the actor request was not run', outcomeKnown: true, performed: false,
    });
  });

  test('a state snapshot cannot revive a card with a durable actor receipt', () => {
    const receipt = {
      id: 'actor-reply-2', role: 'user', synthetic: true,
      actorReply: {
        kind: 'web', instanceId: 'web', parentToolUseId: 'tu-a',
        actorDeliveryId: 'delivery-a', failed: false,
      },
      content: 'fenced actor reply',
    };
    const messages = [
      { id: 'call-a', role: 'assistant', toolUses: [{
        id: 'tu-a', name: 'message_actor', input: { to: 'web' },
      }] },
      { id: 'result-a', role: 'user', toolResults: [{
        tool_use_id: 'tu-a', is_error: false, content: 'accepted', actorCorrelationId: 'delivery-a',
      }] },
      receipt,
    ];
    const viewing = withSession('chat-A');
    const replayed = reduceChat(viewing, {
      type: 'state',
      state: {
        session: { sessionId: 'chat-A', messages },
        actors: {
          'tu-a': { sessionId: 'actor-a', streaming: true },
        },
      },
    });

    expect(replayed.actors['tu-a'].streaming).toBe(false);
  });

  test('actor done: an abort renders cancelled; an ok:false failure marks failed; churn is short-circuited', () => {
    const started = reduceChat(INITIAL_STATE, { type: 'turn/actor-start', parentToolUseId: 'tu-a', sessionId: 'r', fromIndex: 0 });
    const aborted = reduceChat(started, { type: 'turn/actor-done', parentToolUseId: 'tu-a', ok: true, aborted: true });
    expect(aborted.actors['tu-a']).toMatchObject({ streaming: false, aborted: true });
    const restarted = reduceChat(aborted, {
      type: 'turn/actor-start', parentToolUseId: 'tu-a', sessionId: 'r-new', fromIndex: 5,
    });
    expect(restarted.actors['tu-a']).toMatchObject({
      sessionId: 'r-new', streaming: true, aborted: false, error: null,
    });
    expect(restarted.actors['tu-a'].outcomeKnown).toBeUndefined();
    expect(restarted.actors['tu-a'].performed).toBeUndefined();
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

  test('turn/actor-cost only UPDATES an existing card — never self-seeds a premature "ok" card (#9)', () => {
    // A cost event before turn/actor-start (panel connected mid-turn) must NOT
    // create a card: a streaming-less {cost} card renders a premature green 'ok'
    // and then blocks turn/actor-state's `existing ? {} : seed` from applying
    // streaming/kind/name. onCost fires on every usage event, so this is real.
    const costOnly = reduceChat(INITIAL_STATE, { type: 'turn/actor-cost', parentToolUseId: 'tu-x', cost: { cost: 0.05 } });
    expect(costOnly).toBe(INITIAL_STATE);                       // no card, same state object
    expect(costOnly.actors['tu-x']).toBeUndefined();
    // After a real start, cost folds in and the card stays streaming:true.
    const started = reduceChat(INITIAL_STATE, { type: 'turn/actor-start', parentToolUseId: 'tu-x', sessionId: 'r', fromIndex: 0 });
    const costed = reduceChat(started, { type: 'turn/actor-cost', parentToolUseId: 'tu-x', cost: { cost: 0.05 } });
    expect(costed.actors['tu-x']).toMatchObject({ streaming: true, cost: { cost: 0.05 } });
  });

  test('a session SWITCH prunes the orchestrator projections; a same-session state push keeps them (#10)', () => {
    const a0 = reduceChat({ ...INITIAL_STATE, session: { sessionId: 'A', messages: [], cost: null } },
      { type: 'turn/actor-start', parentToolUseId: 'tu-1', sessionId: 'r', fromIndex: 0 });
    expect(a0.actors['tu-1']).toBeDefined();
    // Same-session 'state' push (Plan/Act toggle, /system, settings) must NOT wipe a live card.
    const sameSession = reduceChat(a0, { type: 'state', state: { session: { sessionId: 'A', messages: [] } } });
    expect(sameSession.actors['tu-1']).toBeDefined();
    // An ACTUAL switch to B prunes actors/spawned/asyncTasks (they belong to A's transcript).
    const switched = reduceChat(a0, { type: 'state', state: { session: { sessionId: 'B', messages: [] } } });
    expect(switched.session.sessionId).toBe('B');
    expect(switched.actors).toEqual({});
    expect(switched.spawned).toEqual(INITIAL_STATE.spawned);
    expect(switched.asyncTasks).toEqual(INITIAL_STATE.asyncTasks);

    const replayed = reduceChat(a0, {
      type: 'state',
      state: {
        session: { sessionId: 'B', messages: [] },
        actors: { live: { sessionId: 'actor-B', streaming: true } },
        spawned: { byToolUse: {}, sessions: { child: { sessionId: 'child', messages: [] } } },
        asyncTasks: { B: [{ taskId: 'task-B', status: 'running' }] },
      },
    });
    expect(replayed.actors.live.sessionId).toBe('actor-B');
    expect(replayed.spawned.sessions.child.sessionId).toBe('child');
    expect(replayed.asyncTasks.B).toHaveLength(1);
  });

  test('a same-session live snapshot settles but preserves terminal actor evidence', () => {
    const viewing: any = { ...INITIAL_STATE, session: { sessionId: 'A', messages: [], cost: null } };
    const started = reduceChat(viewing, {
      type: 'turn/actor-start', rootSessionId: 'A', parentSessionId: 'A',
      parentToolUseId: 'tu-1', sessionId: 'actor-a', fromIndex: 0,
      task: 'inspect', grantedTools: ['read_page'],
    });
    const withActivity = reduceChat(started, {
      type: 'turn/actor-state', rootSessionId: 'A', parentToolUseId: 'tu-1', fromIndex: 0,
      session: { sessionId: 'actor-a', messages: [{ id: 'reply' }] },
    });
    const snap = reduceChat(withActivity, {
      type: 'state', state: {
        session: { sessionId: 'A', messages: [] }, actors: {},
        spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
      },
    });
    expect(snap.actors['tu-1']).toMatchObject({
      sessionId: 'actor-a', task: 'inspect', grantedTools: ['read_page'],
      streaming: false, messages: [{ id: 'reply' }],
    });
  });

  test('a same-session live snapshot preserves a completed spawned transcript and card mapping', () => {
    const viewing: any = { ...INITIAL_STATE, session: { sessionId: 'A', messages: [], cost: null } };
    const started = reduceChat(viewing, {
      type: 'turn/spawned-start', rootSessionId: 'A', parentSessionId: 'A',
      parentToolUseId: 'tu-spawn', sessionId: 'child-a', task: 'research',
    });
    const hydrated = reduceChat(started, {
      type: 'turn/spawned-state', rootSessionId: 'A',
      session: { sessionId: 'child-a', messages: [{ id: 'answer', content: 'done' }] },
    });
    const done = reduceChat(hydrated, {
      type: 'turn/spawned-done', rootSessionId: 'A', sessionId: 'child-a',
    });
    const snap = reduceChat(done, {
      type: 'state', state: {
        session: { sessionId: 'A', messages: [] }, actors: {},
        spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
      },
    });
    expect(snap.spawned.byToolUse['tu-spawn']).toBe('child-a');
    expect(snap.spawned.sessions['child-a']).toMatchObject({
      running: false, messages: [{ id: 'answer', content: 'done' }],
    });
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

  test('script operation Stop stays cancelled instead of becoming a failure', () => {
    const started = reduceChat(withSession('s1'), {
      type: 'script/op', sessionId: 's1', toolUseId: 'tu-1', seq: 1,
      method: 'call', to: 'vm-1', goalPreview: 'long task', phase: 'sent',
    });
    expect(started.scriptOps['tu-1'][0]).toMatchObject({
      phase: 'sent', cancelled: false, failed: false,
    });

    const stopped = reduceChat(started, {
      type: 'script/op', sessionId: 's1', toolUseId: 'tu-1', seq: 1,
      method: 'call', phase: 'cancelled', cancelled: true,
      error: 'aborted', ms: 12,
    });
    expect(stopped.scriptOps['tu-1'][0]).toMatchObject({
      phase: 'cancelled', cancelled: true, failed: false,
      ms: 12, to: 'vm-1', goalPreview: 'long task',
    });
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

  test('carries and refreshes an unconfirmed blank-child state into the rendered event', () => {
    const first = reduceChat(convo(), tab({ protected: false, parentToolUseId: 'tu-vm-1' }));
    expect(first.agentTabEvents[0]).toMatchObject({ turnId: 'u1', protected: false });

    const refreshed = reduceChat(first, tab({ protected: true, parentToolUseId: 'tu-vm-1' }));
    expect(refreshed.agentTabEvents[0]).toMatchObject({ turnId: 'u1', protected: true });
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
