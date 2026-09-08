import { describe, expect, test } from 'bun:test';
import { makeAppActorAttachRecovery } from '../../extension/engine-tabs/app-tab/actor-attach-recovery.js';
import { makeUiRuntimeClient } from '../../extension/shared/ui-runtime-client.js';

describe('trusted App actor attachment recovery', () => {
  test('a received refusal uses the explicit fresh retry operation', async () => {
    const operations: string[] = [];
    const recovery = makeAppActorAttachRecovery({
      request: async (operation) => {
        operations.push(operation);
        return operation === 'app/tab-ready'
          ? { ok: false, actorRequired: true, retryable: true, outcomeKnown: true }
          : { ok: true, actorSessionId: 'actor-1' };
      },
    });

    expect((await recovery.start()).ok).toBe(false);
    expect(recovery.nextOperation()).toBe('app/actor-retry');
    expect((await recovery.retry()).ok).toBe(true);
    expect(operations).toEqual(['app/tab-ready', 'app/actor-retry']);
  });

  test('a lost post-dispatch receipt repeats the exact operation without duplicating its binding', async () => {
    const operations: string[] = [];
    let bindingCreates = 0;
    let bound = false;
    let loseFirstReceipt = true;
    const recovery = makeAppActorAttachRecovery({
      request: async (operation) => {
        operations.push(operation);
        if (!bound) { bound = true; bindingCreates += 1; }
        if (loseFirstReceipt) {
          loseFirstReceipt = false;
          throw Object.assign(new Error('worker recycled after dispatch'), {
            outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
          });
        }
        return { ok: true, actorSessionId: 'actor-1' };
      },
    });

    const unknown = await recovery.start();
    expect(unknown).toMatchObject({
      ok: false, outcomeKnown: false, retryable: true,
      attachOperation: 'app/tab-ready',
    });
    expect(recovery.nextOperation()).toBe('app/tab-ready');
    expect((await recovery.retry()).ok).toBe(true);
    expect(operations).toEqual(['app/tab-ready', 'app/tab-ready']);
    expect(bindingCreates).toBe(1);
  });

  test('an explicit unknown receipt remains retryable and repeats actor-retry exactly', async () => {
    const operations: string[] = [];
    const recovery = makeAppActorAttachRecovery({
      request: async (operation) => {
        operations.push(operation);
        if (operations.length === 1) {
          return { ok: false, actorRequired: true, retryable: true, outcomeKnown: true };
        }
        if (operations.length === 2) return { ok: false, outcomeKnown: false };
        return { ok: true, actorSessionId: 'actor-1' };
      },
    });

    await recovery.start();
    expect(await recovery.retry()).toMatchObject({
      ok: false, outcomeKnown: false, actorRequired: true, retryable: true,
      attachOperation: 'app/actor-retry',
    });
    expect(recovery.nextOperation()).toBe('app/actor-retry');
    expect((await recovery.retry()).ok).toBe(true);
    expect(operations).toEqual(['app/tab-ready', 'app/actor-retry', 'app/actor-retry']);
  });

  test('double retry shares one in-flight exact handshake', async () => {
    let release: ((value: any) => void) | null = null;
    let calls = 0;
    const recovery = makeAppActorAttachRecovery({
      request: async () => {
        calls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });

    const first = recovery.start();
    const duplicate = recovery.retry();
    expect(recovery.pending()).toBe(true);
    expect(first).toBe(duplicate);
    expect(calls).toBe(1);
    (release as ((value: any) => void) | null)?.({ ok: true });
    await expect(first).resolves.toMatchObject({ ok: true, attachOperation: 'app/tab-ready' });
    expect(recovery.pending()).toBe(false);
  });

  test('a never-settling worker request becomes visible unknown state, then the same operation recovers', async () => {
    let calls = 0;
    const browser = {
      runtime: {
        sendMessage: async () => {
          calls += 1;
          if (calls === 1) return new Promise(() => {});
          return { ok: true, actorSessionId: 'actor-after-recycle' };
        },
      },
    };
    const runtime = makeUiRuntimeClient({
      browser: browser as any,
      readTimeoutMs: 5,
      effectTimeoutMs: 5,
      longEffectTimeoutMs: 5,
    });
    const recovery = makeAppActorAttachRecovery({
      request: (operation) => runtime.send({ type: operation, appId: 'app-1', ownerSessionId: 'chat-1' }),
    });

    await expect(recovery.start()).resolves.toMatchObject({
      ok: false, outcomeKnown: false, attachOperation: 'app/tab-ready',
    });
    expect(recovery.pending()).toBe(false);
    expect(recovery.nextOperation()).toBe('app/tab-ready');
    await expect(recovery.retry()).resolves.toMatchObject({
      ok: true, actorSessionId: 'actor-after-recycle', attachOperation: 'app/tab-ready',
    });
    expect(calls).toBe(2);
  });

  test('a renderer replacement reclaims the same durable binding with tab-ready', async () => {
    let bound = false;
    let bindingCreates = 0;
    const request = async () => {
      if (!bound) { bound = true; bindingCreates += 1; }
      return { ok: true, actorSessionId: 'actor-1' };
    };

    const beforeRecycle = makeAppActorAttachRecovery({ request });
    expect((await beforeRecycle.start()).ok).toBe(true);
    // A renderer reload has no trusted in-memory recovery state. Its first and
    // only authority claim is the same exact tab-ready handshake.
    const afterRecycle = makeAppActorAttachRecovery({ request });
    const result = await afterRecycle.start();
    expect(result).toMatchObject({ ok: true, attachOperation: 'app/tab-ready' });
    expect(bindingCreates).toBe(1);
  });
});
