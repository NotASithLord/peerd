import { describe, expect, test } from 'bun:test';
import {
  makeKernelAppActorChatRoutes,
  makeKernelAppCallRoutes,
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

  test('app/call binds a live run to the current App actor generation', async () => {
    const signal = new AbortController().signal;
    const calls: any[] = [];
    const routes = makeKernelAppCallRoutes({
      isRelay: (sender: any) => sender?.url === 'offscreen',
      vault: { isLocked: () => false },
      scriptRuns: {
        ownerFor: () => 'actor-1', allows: () => true, admitOp: () => true,
        signalFor: () => signal,
      },
      sessions: { get: async () => ({
        sessionId: 'actor-1', kind: 'actor', actorType: 'app', actorSurface: 'code',
        instanceId: 'app-1',
      }) },
      validateGeneration: async () => true,
      retireStale: async () => {},
      callApp: async (request: any) => { calls.push(request); return { ok: true, value: 1 }; },
    });
    const message = {
      ownerSessionId: 'actor-1', runId: 'run-1', method: 'read', args: { path: 'x' },
    };
    expect(await routes['app/call'](message, { url: 'other' }))
      .toEqual({ ok: false, error: 'app_call_unauthorized_relay' });
    expect(await routes['app/call'](message, { url: 'offscreen' }))
      .toEqual({ ok: true, value: 1 });
    expect(calls[0]).toMatchObject({
      sessionId: 'actor-1', appId: 'app-1', method: 'read', signal,
    });
  });

  test('stale generations refuse before dispatch and post-admission loss is unknown', async () => {
    let retired = 0;
    let calls = 0;
    const base = {
      isRelay: () => true,
      vault: { isLocked: () => false },
      scriptRuns: {
        ownerFor: () => 'actor-1', allows: () => true, admitOp: () => true,
        signalFor: () => new AbortController().signal,
      },
      sessions: { get: async () => ({
        kind: 'actor', actorType: 'app', actorSurface: 'code', instanceId: 'app-1',
      }) },
      retireStale: async () => { retired += 1; },
      callApp: async () => { calls += 1; return { ok: true }; },
    };
    const message = { ownerSessionId: 'actor-1', runId: 'run-1', method: 'write' };
    const stale = makeKernelAppCallRoutes({ ...base, validateGeneration: async () => false });
    expect(await stale['app/call'](message, {})).toMatchObject({
      ok: false, error: 'app_call_stale_actor_generation', outcomeKnown: true,
    });
    expect(retired).toBe(1);
    expect(calls).toBe(0);

    const lost = makeKernelAppCallRoutes({
      ...base, validateGeneration: async () => true,
      callApp: async () => { throw new Error('transport lost'); },
    });
    expect(await lost['app/call'](message, {})).toMatchObject({
      ok: false, code: 'app-call-outcome-unknown', outcomeKnown: false,
    });
  });
});
