import { describe, expect, test } from 'bun:test';
import {
  contributorFeedbackContextKey, contributorFeedbackTargets,
} from '../../extension/peerd-runtime/observability/contributor-feedback.js';

const human = (id: string, content = id) => ({ role: 'user', id, content, toolResults: [] });
const terminal = (id: string, content = id) => ({
  role: 'assistant', id, content, toolUses: [], stopReason: 'end_turn',
});

describe('Contributor Metrics task feedback attribution', () => {
  test('a reused tab actor settles against the current chat, not its original parent', () => {
    const actorRecord = { parentSessionId: 'chat-that-minted-the-tab' };
    const currentChat = 'chat-that-issued-this-turn';
    expect(contributorFeedbackContextKey(currentChat, 'tool-current')).toBe(
      'chat-that-issued-this-turn:tool-current',
    );
    expect(contributorFeedbackContextKey(currentChat, 'tool-current')).not.toContain(
      actorRecord.parentSessionId,
    );
  });

  test('ordinary completed answers remain attributable to their human turns', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'), terminal('answer-a'), human('user-b'), terminal('answer-b'),
    ]);
    expect(targets.get('answer-a')).toEqual({ humanMessageId: 'user-a', toolUseIds: [] });
    expect(targets.get('answer-b')).toEqual({ humanMessageId: 'user-b', toolUseIds: [] });
  });

  test('an async actor acknowledgement is not a terminal task answer', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'dispatch-a', content: 'Delegating.', stopReason: 'tool_use',
        toolUses: [{ id: 'actor-tool-a', name: 'message_actor', input: { to: 'web' } }],
      },
      terminal('ack-a', 'The reply will arrive later.'),
    ]);
    expect(targets.has('ack-a')).toBe(false);
  });

  test('an async actor_create acknowledgement is not a terminal task answer', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'dispatch-a', content: 'Spawning.', stopReason: 'tool_use',
        toolUses: [{ id: 'spawn-tool-a', name: 'actor_create', input: { task: 'research' } }],
      },
      terminal('ack-a', 'The actor will report later.'),
    ]);
    expect(targets.has('ack-a')).toBe(false);
  });

  test('a late correlated actor reply returns to task A after task B', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'dispatch-a', content: 'Delegating.', stopReason: 'tool_use',
        toolUses: [{ id: 'actor-tool-a', name: 'message_actor', input: { to: 'web' } }],
      },
      terminal('ack-a', 'The reply will arrive later.'),
      human('user-b'), terminal('answer-b'),
      {
        role: 'user', id: 'reply-a', content: 'Actor replied.', synthetic: true,
        actorReply: { kind: 'web', instanceId: 'web', parentToolUseId: 'actor-tool-a' },
      },
      terminal('answer-a-final', 'Task A is now complete.'),
    ]);

    expect(targets.has('ack-a')).toBe(false);
    expect(targets.get('answer-b')).toEqual({ humanMessageId: 'user-b', toolUseIds: [] });
    expect(targets.get('answer-a-final')).toEqual({
      humanMessageId: 'user-a', toolUseIds: ['actor-tool-a'],
    });
  });

  test('an uncorrelated legacy actor receipt fails closed instead of guessing', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'), terminal('answer-a'),
      {
        role: 'user', id: 'legacy-reply', content: 'Actor replied.', synthetic: true,
        actorReply: { kind: 'app', instanceId: 'app-1' },
      },
      terminal('legacy-followup'),
    ]);
    expect([...targets.keys()]).toEqual([]);
  });

  test('a late spawned-actor receipt returns to task A after task B', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'spawn-a', content: 'Spawning.', stopReason: 'tool_use',
        toolUses: [{ id: 'spawn-tool-a', name: 'actor_create', input: { task: 'A' } }],
      },
      terminal('ack-a'),
      human('user-b'), terminal('answer-b'),
      {
        role: 'user', id: 'spawn-reply-a', content: 'Actor A replied.', synthetic: true,
        actorReply: {
          kind: 'spawned', instanceId: 'spawned', parentToolUseId: 'spawn-tool-a',
          parentToolUseIds: ['spawn-tool-a'],
        },
      },
      terminal('answer-a-final'),
    ]);
    expect(targets.has('ack-a')).toBe(false);
    expect(targets.get('answer-b')).toEqual({ humanMessageId: 'user-b', toolUseIds: [] });
    expect(targets.get('answer-a-final')).toEqual({
      humanMessageId: 'user-a', toolUseIds: ['spawn-tool-a'],
    });
  });

  test('coalesced spawned replies from different human tasks fail closed', () => {
    const spawn = (id: string) => ({
      role: 'assistant', id: `spawn-${id}`, content: 'Spawning.', stopReason: 'tool_use',
      toolUses: [{ id: `spawn-tool-${id}`, name: 'actor_create', input: { task: id } }],
    });
    const targets = contributorFeedbackTargets([
      human('user-a'), spawn('a'), terminal('ack-a'),
      human('user-b'), spawn('b'), terminal('ack-b'),
      {
        role: 'user', id: 'coalesced', content: 'Both actors replied.', synthetic: true,
        actorReply: {
          kind: 'spawned', instanceId: 'spawned',
          parentToolUseIds: ['spawn-tool-a', 'spawn-tool-b'],
        },
      },
      terminal('ambiguous-followup'),
    ]);
    expect([...targets.keys()]).toEqual([]);
  });

  test('coalesced spawned replies from one task settle every pending actor', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'spawn-batch', content: 'Spawning.', stopReason: 'tool_use',
        toolUses: [
          { id: 'spawn-tool-a1', name: 'actor_create', input: { task: 'A1' } },
          { id: 'spawn-tool-a2', name: 'actor_create', input: { task: 'A2' } },
        ],
      },
      terminal('ack-a'),
      {
        role: 'user', id: 'coalesced', content: 'Both actors replied.', synthetic: true,
        actorReply: {
          kind: 'spawned', instanceId: 'spawned',
          parentToolUseIds: ['spawn-tool-a1', 'spawn-tool-a2'],
        },
      },
      terminal('answer-a-final'),
    ]);
    expect(targets.get('answer-a-final')).toEqual({
      humanMessageId: 'user-a', toolUseIds: ['spawn-tool-a1', 'spawn-tool-a2'],
    });
  });

  test('a cross-task tool-use id collision is ambiguous and fails closed', () => {
    const dispatch = (id: string) => ({
      role: 'assistant', id: `dispatch-${id}`, content: 'Delegating.', stopReason: 'tool_use',
      toolUses: [{ id: 'duplicate-tool-id', name: 'message_actor', input: {} }],
    });
    const targets = contributorFeedbackTargets([
      human('user-a'), dispatch('a'), terminal('ack-a'),
      human('user-b'), dispatch('b'), terminal('ack-b'),
      {
        role: 'user', id: 'reply-ambiguous', content: 'Actor replied.', synthetic: true,
        actorReply: {
          kind: 'web', instanceId: 'web', parentToolUseId: 'duplicate-tool-id',
        },
      },
      terminal('ambiguous-followup'),
    ]);
    expect([...targets.keys()]).toEqual([]);
  });

  test('an explicitly awaited actor call remains part of the same completed turn', () => {
    const targets = contributorFeedbackTargets([
      human('user-a'),
      {
        role: 'assistant', id: 'await-a', content: 'Waiting.', stopReason: 'tool_use',
        toolUses: [{ id: 'actor-tool-a', name: 'message_actor', input: { to: 'web', await: true } }],
      },
      terminal('answer-a'),
    ]);
    expect(targets.get('answer-a')).toEqual({
      humanMessageId: 'user-a', toolUseIds: ['actor-tool-a'],
    });
  });
});
