import { describe, expect, test } from 'bun:test';
import { createKernelConfirmation } from '../../extension/background/kernel-confirmation.js';
import { createKernelTurnCustody } from '../../extension/background/kernel-turn-custody.js';
import { makeUiPorts } from '../../extension/background/ui-ports.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native kernel confirmation custody', () => {
  test('real slot completion and watchdog release clear work with no UI ports', async () => {
    const badges: string[] = [];
    const uiPorts = makeUiPorts({ onBroadcast: (message: any) => {
      if (message.type === 'turn/streaming') void confirmation.refreshBadge();
    } });
    const slots = createKernelTurnCustody({
      browser: { tabs: {} }, idb: { get: async () => undefined }, kv: {}, sessionCache: {}, vault: {}, auditLog: {}, settingsStore: {}, uiPorts,
      turnForceReleaseMs: 1,
      makePageActivity: () => ({ markedTabs: () => [], release: async () => {} }),
    }).shared.turnSlots;
    const confirmation = createKernelConfirmation({
      browser: { action: { setBadgeText: ({ text }: { text: string }) => badges.push(text) } },
      uiPorts, sessionCache: {}, isSidepanelSender: () => false, isHomeSender: () => false,
      readStreaming: async () => slots.isBusy('chat-a'),
    });
    for (const watchdog of [false, true]) {
      const turn = slots.claim('chat-a');
      await confirmation.refreshBadge();
      expect(badges.at(-1)).toBe('…');
      expect(uiPorts.size).toBe(0);
      if (watchdog) slots.stop('chat-a'); else turn.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(slots.isBusy('chat-a')).toBe(false);
      expect(badges.at(-1)).toBe('');
    }
  });

  test('the one badge shows work, gives approval priority, and returns to work after rejection', async () => {
    const badges: string[] = [];
    const broadcasts: any[] = [];
    let working = true;
    const confirmation = createKernelConfirmation({
      browser: { action: { setBadgeText: ({ text }: { text: string }) => badges.push(text) } },
      uiPorts: { size: 1, broadcast: (message: any) => broadcasts.push(message) },
      sessionCache: { sessionGet: async () => 'chat-a' },
      readStreaming: async () => working,
      isSidepanelSender: () => true, isHomeSender: () => false,
    });
    await confirmation.refreshBadge();
    expect(badges.at(-1)).toBe('…');
    const pending = confirmation.coordinator.confirm({
      sessionId: 'chat-a', ownerSessionId: 'chat-a', dispatchId: 'write-a',
      toolName: 'write', description: 'write', origins: [], sideEffect: 'write',
    });
    await tick();
    expect(badges.at(-1)).toBe('1');
    await confirmation.refreshBadge();
    expect(badges.at(-1)).toBe('1');
    const prompt = broadcasts.find((message) => message.type === 'confirm/request').prompt;
    await confirmation.routes['confirm/answer']({ ...prompt, answer: 'no' }, {});
    await pending;
    await tick();
    expect(badges.at(-1)).toBe('…');
    working = false;
    await confirmation.refreshBadge();
    expect(badges.at(-1)).toBe('');
  });

  test('an unavailable working read clears the old work badge', async () => {
    const badges: string[] = [];
    let fails = false;
    const confirmation = createKernelConfirmation({
      browser: { action: { setBadgeText: ({ text }: { text: string }) => badges.push(text) } },
      uiPorts: { size: 0 }, sessionCache: {}, isSidepanelSender: () => false, isHomeSender: () => false,
      readStreaming: async () => { if (fails) throw new Error('storage unavailable'); return true; },
    });
    await confirmation.refreshBadge();
    expect(badges.at(-1)).toBe('…');
    fails = true;
    await confirmation.refreshBadge();
    expect(badges.at(-1)).toBe('');
  });

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
