import { describe, expect, test } from 'bun:test';
import {
  CONTRIBUTOR_FEEDBACK_MAX_MESSAGES, CONTRIBUTOR_FEEDBACK_MAX_TOOL_USES,
  guardKernelContributorFeedback,
} from '../../extension/background/kernel-contributor-feedback-guard.js';

const messages = [{
  role: 'user', id: 'human', content: 'private prompt', synthetic: false,
}, {
  role: 'assistant', id: 'answer', content: 'private answer', stopReason: 'end_turn',
  toolUses: [{ id: 'tool', name: 'message_actor', input: { await: true, secret: 'drop' } }],
}];

const turn = ({ recovery = true, busy = false, inFlight = false,
  session = { kind: 'chat', messages }, onRead = () => {} }: {
  recovery?: boolean; busy?: boolean; inFlight?: boolean; session?: any; onRead?: () => void;
} = {}) => ({
  actorRecoveryReady: async () => recovery,
  turnSlots: { isBusy: () => busy },
  actorMessaging: { hasInFlightFor: () => inFlight },
  sessions: { get: async () => { onRead(); return session; } },
});

describe('kernel Contributor Metrics feedback guard', () => {
  test('fails closed during recovery, a live turn, or actor work', async () => {
    for (const live of [turn({ recovery: false }), turn({ busy: true }),
      turn({ inFlight: true })]) {
      expect(await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
        load: async () => live,
      })).toMatchObject({ ok: false, outcomeKnown: true });
    }
  });

  test('rechecks finality after the awaited session read', async () => {
    let inFlight = false;
    const live = turn({ onRead: () => { inFlight = true; } });
    live.actorMessaging.hasInFlightFor = () => inFlight;
    expect(await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
      load: async () => live,
    })).toEqual({ ok: false, error: 'invalid-feedback-target', outcomeKnown: true });
  });

  test('rejects actor sessions and projects no conversation content', async () => {
    expect(await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
      load: async () => turn({ session: { kind: 'actor', messages } }),
    })).toMatchObject({ ok: false });
    const result = await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
      load: async () => turn(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain('private prompt');
    expect(JSON.stringify(result)).not.toContain('private answer');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.messages?.[1]).toMatchObject({
      id: 'answer', content: 'present', stopReason: 'end_turn',
      toolUses: [{ id: 'tool', name: 'message_actor', input: { await: true } }],
    });
  });

  test('refuses oversized transcript graphs before they cross the private channel', async () => {
    const tooManyMessages = Array.from({ length: CONTRIBUTOR_FEEDBACK_MAX_MESSAGES + 1 },
      (_, index) => ({ role: 'assistant', id: `m-${index}`, content: 'x' }));
    expect(await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
      load: async () => turn({ session: { kind: 'chat', messages: tooManyMessages } }),
    })).toMatchObject({ ok: false, error: 'feedback-projection-too-large' });

    const tooManyTools = [{
      role: 'assistant', id: 'answer', content: 'done', stopReason: 'end_turn',
      toolUses: Array.from({ length: CONTRIBUTOR_FEEDBACK_MAX_TOOL_USES + 1 },
        (_, index) => ({ id: `tool-${index}`, name: 'message_actor', input: {} })),
    }];
    expect(await guardKernelContributorFeedback({ sessionId: 'chat', messageId: 'answer' }, {
      load: async () => turn({ session: { kind: 'chat', messages: tooManyTools } }),
    })).toMatchObject({ ok: false, error: 'feedback-projection-too-large' });
  });
});
