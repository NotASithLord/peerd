import { describe, expect, test } from 'bun:test';
import {
  answerWithSessionConfirmGrant, cachedSessionConfirmAnswer, rememberSessionConfirmAnswer,
} from '../../extension/background/confirm-session-grants.js';

describe('one-shot confirmation grants', () => {
  test('same-tool repeats on different targets both require a direct prompt', async () => {
    const grants = new Map<string, Set<string>>([['chat-1', new Set(['submit_payment'])]]);
    const prompts = [
      { tool: 'submit_payment', origins: [], lifecycleTarget: 'https://a.example', oneShot: true },
      { tool: 'submit_payment', origins: [], lifecycleTarget: 'https://b.example', oneShot: true },
    ];
    let directPrompts = 0;

    for (const prompt of prompts) {
      const answer = await answerWithSessionConfirmGrant({
        prompt, sessionId: 'chat-1', ephemeral: false,
        grants,
        request: async () => { directPrompts += 1; return 'yes_session'; },
      });
      expect(answer).toBe('yes_once');
    }

    expect(directPrompts).toBe(2);
    expect(grants.get('chat-1')).toEqual(new Set(['submit_payment']));
  });

  test('ordinary confirmations retain session-grant behavior', async () => {
    const grants = new Map<string, Set<string>>();
    const prompt = { tool: 'click', origins: ['https://a.example'] };
    expect(rememberSessionConfirmAnswer({
      prompt, sessionId: 'chat-1', ephemeral: false,
      answer: 'yes_session', grants,
    })).toBe(true);
    expect(cachedSessionConfirmAnswer({
      prompt, sessionId: 'chat-1', ephemeral: false, grants,
    })).toBe('yes_session');
    let directPrompts = 0;
    expect(await answerWithSessionConfirmGrant({
      prompt, sessionId: 'chat-1', ephemeral: false, grants,
      request: async () => { directPrompts += 1; return 'no'; },
    })).toBe('yes_session');
    expect(directPrompts).toBe(0);
  });
});
