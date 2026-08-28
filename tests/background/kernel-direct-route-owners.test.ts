import { describe, expect, test } from 'bun:test';
import {
  makeKernelAppActorChatRoutes,
} from '../../extension/background/kernel-direct-route-owners.js';

describe('kernel direct route owners', () => {
  test('accepts the controller-owned App chat relay without rebuilding actor custody', async () => {
    const seen: any[] = [];
    const routes = makeKernelAppActorChatRoutes({
      isAllowed: () => true,
      load: async () => ({
        appActorChat: async (message: any, sender: any) => {
          seen.push({ message, sender });
          return { ok: true };
        },
      }),
    });
    const sender = { tab: { id: 3 } };
    expect(await routes['app/actor-chat']({ appId: 'app-1' }, sender))
      .toEqual({ ok: true });
    expect(seen).toHaveLength(1);
  });
  test('App-native chat refuses provenance before loading and preserves exact tab ownership', async () => {
    let loads = 0;
    const blocked = makeKernelAppActorChatRoutes({
      isAllowed: () => false,
      load: async () => { loads += 1; return {}; },
    });
    expect(await blocked['app/actor-chat']({ type: 'app/actor-chat' }, {}))
      .toEqual({ ok: false, error: 'app_actor_chat_unauthorized', outcomeKnown: true });
    expect(loads).toBe(0);

    const sender = { tab: { id: 7, url: 'app://owned' } };
    const delivered: any[] = [];
    const routes = makeKernelAppActorChatRoutes({
      isAllowed: (candidate: any) => candidate === sender,
      isTrustedSender: (candidate: any) => candidate === sender,
      appTabTracker: {
        parseIdFromUrl: () => 'app-1', parseOwnerFromUrl: () => 'root-1',
        getTabId: () => 7, getOwnedTabId: () => 7,
      },
      ensureAppActorBinding: async () => 'actor-1',
      sessions: { get: async () => ({ parentSessionId: 'root-1' }) },
      messageActor: async (request: any) => { delivered.push(request); return { ok: true }; },
    });
    expect(await routes['app/actor-chat']({
      type: 'app/actor-chat', appId: 'app-1', message: ' help ',
    }, sender)).toEqual({ ok: true });
    expect(delivered[0]).toMatchObject({
      to: 'app-1', message: 'help', senderSessionId: 'root-1', trustedAppTab: true,
    });
  });
});
