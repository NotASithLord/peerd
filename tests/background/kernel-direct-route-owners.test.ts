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
  test('App-native chat refuses provenance before loading', async () => {
    let loads = 0;
    const blocked = makeKernelAppActorChatRoutes({
      isAllowed: () => false,
      load: async () => { loads += 1; return {}; },
    });
    expect(await blocked['app/actor-chat']({ type: 'app/actor-chat' }, {}))
      .toEqual({ ok: false, error: 'app_actor_chat_unauthorized', outcomeKnown: true });
    expect(loads).toBe(0);
  });
  test('App-native chat fails closed when the loaded runtime omits its owner', async () => {
    const routes = makeKernelAppActorChatRoutes({
      isAllowed: () => true,
      load: async () => ({}),
    });
    await expect(routes['app/actor-chat']({}, {})).rejects.toMatchObject({
      code: 'kernel-route-owner-load-failed', outcomeKnown: true, phase: 'startup',
    });
  });
});
