import { describe, expect, test } from 'bun:test';
import { createKernelConfirmation } from '../../extension/background/kernel-confirmation.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native kernel confirmation custody', () => {
  test('admits only the active owner and exact UI sender', async () => {
    const broadcasts: any[] = [];
    const badges: any[] = [];
    const confirmation = createKernelConfirmation({
      browser: { action: {
        setBadgeText: (value: any) => badges.push(value),
        setBadgeBackgroundColor: () => {},
      } },
      uiPorts: { size: 1, broadcast: (value: any) => broadcasts.push(value) },
      sessionCache: { sessionGet: async () => 'chat-a' },
      isSidepanelSender: (sender: any) => sender?.kind === 'sidepanel',
      isHomeSender: (sender: any) => sender?.kind === 'home',
    });
    const pending = confirmation.coordinator.confirm({
      sessionId: 'actor-a', ownerSessionId: 'chat-a', dispatchId: 'dispatch-a',
      toolName: 'write', description: 'write', origins: [], sideEffect: 'write',
    });
    await tick();
    const prompt = broadcasts.find((message) => message.type === 'confirm/request')?.prompt;
    expect(prompt?.id).toBeString();
    expect(await confirmation.routes['confirm/answer']({
      ...prompt, answer: 'yes_once', ownerSessionId: 'chat-a',
    }, { kind: 'foreign' })).toEqual({
      ok: false, error: 'confirm-answer-unauthorized-sender',
    });
    expect(await confirmation.routes['confirm/answer']({
      ...prompt, answer: 'yes_once', ownerSessionId: 'chat-b',
    }, { kind: 'sidepanel' })).toEqual({
      ok: false, error: 'confirm-answer-foreign-owner',
    });
    expect(await confirmation.routes['confirm/answer']({
      ...prompt, answer: 'yes_once', ownerSessionId: 'chat-a',
    }, { kind: 'home' })).toEqual({ ok: true });
    expect(await pending).toBe('yes_once');
    await tick();
    expect(broadcasts.some((message) => message.type === 'confirm/resolved')).toBe(true);
    expect(badges.at(-1)).toEqual({ text: '' });
  });
});
