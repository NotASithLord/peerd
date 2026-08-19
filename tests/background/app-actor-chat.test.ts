import { describe, expect, test } from 'bun:test';
import { makeAppActorChatHandler } from '../../extension/background/app-actor-chat.js';

const makeHarness = (over: Record<string, unknown> = {}) => {
  const calls: any[] = [];
  const handler = makeAppActorChatHandler({
    isTrustedSender: () => true,
    appTabTracker: {
      parseIdFromUrl: () => 'app-1',
      parseOwnerFromUrl: () => 'owner-claim',
      getTabId: () => 7,
      getOwnedTabId: (_appId: string, root: string) => root === 'owner-root' ? 7 : null,
    },
    ensureAppActorBinding: async () => 'actor-1',
    sessions: { get: async () => ({ parentSessionId: 'owner-root' }) },
    messageActor: async (request: any) => { calls.push(request); return { ok: true, content: 'done' }; },
    timeoutMs: 1000,
    ...over,
  } as any);
  const sender = { tab: { id: 7, url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-1?owner=owner-claim' } };
  return { handler, calls, sender };
};

describe('App-native actor chat route', () => {
  test('pins the trusted parent tab and owner before a direct conversational delivery', async () => {
    const { handler, calls, sender } = makeHarness();
    const result = await handler({ type: 'app/actor-chat', appId: 'app-1', message: '  help me edit  ' }, sender);
    expect(result).toEqual({ ok: true, content: 'done' });
    expect(calls).toEqual([{
      to: 'app-1', message: 'help me edit', senderSessionId: 'owner-root', inbound: false,
      awaitReply: true, bareReply: true, trustedAppTab: true,
      via: 'app-native', awaitSignal: expect.any(AbortSignal),
    }]);
  });

  test('rejects extension-page, App-id, live-tab, and owner-root mismatches', async () => {
    const unauthorized = makeHarness({ isTrustedSender: () => false });
    expect(await unauthorized.handler({ type: 'app/actor-chat', appId: 'app-1', message: 'x' }, unauthorized.sender))
      .toMatchObject({ ok: false, error: 'app_actor_chat_unauthorized' });

    const idMismatch = makeHarness();
    expect(await idMismatch.handler({ type: 'app/actor-chat', appId: 'app-2', message: 'x' }, idMismatch.sender))
      .toMatchObject({ ok: false, error: 'app_actor_chat_tab_mismatch' });

    const ownerMismatch = makeHarness({
      appTabTracker: {
        parseIdFromUrl: () => 'app-1', parseOwnerFromUrl: () => 'owner-claim',
        getTabId: () => 7, getOwnedTabId: () => null,
      },
    });
    expect(await ownerMismatch.handler({ type: 'app/actor-chat', appId: 'app-1', message: 'x' }, ownerMismatch.sender))
      .toMatchObject({ ok: false, error: 'app_actor_chat_owner_mismatch' });
    expect(unauthorized.calls).toEqual([]);
    expect(idMismatch.calls).toEqual([]);
    expect(ownerMismatch.calls).toEqual([]);
  });

  test('bounds host input before actor work', async () => {
    const { handler, calls, sender } = makeHarness({ messageChars: 4 });
    expect(await handler({ type: 'app/actor-chat', appId: 'app-1', message: '12345' }, sender))
      .toMatchObject({ ok: false, error: 'app_actor_chat_message_too_large' });
    expect(calls).toEqual([]);
  });
});
