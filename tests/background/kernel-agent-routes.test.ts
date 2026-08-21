import { describe, expect, test } from 'bun:test';
import {
  makeAgentSendCustody,
} from '../../extension/peerd-egress/storage/session-cache.js';
import { makeKernelAgentRoutes } from '../../extension/background/kernel-agent-routes.js';

const sendId = (suffix: string) => `send.${Date.now().toString(36)}.${suffix.padEnd(8, 'x')}`;
const until = async (predicate: () => boolean) => {
  for (let index = 0; index < 100 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
};

const harness = (overrides: Record<string, any> = {}) => {
  const stored: Record<string, any> = {};
  const cache = overrides.sessionCache ?? {
    sessionGet: async (key: string) => key === 'currentSessionId' ? 'chat-a' : stored[key],
    sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
  };
  const calls = { prepare: 0, execute: 0, stop: [] as any[], audit: [] as any[], lifetime: 0 };
  const routes = makeKernelAgentRoutes({
    custody: makeAgentSendCustody(cache),
    vault: overrides.vault ?? { isLocked: () => false },
    sessionCache: cache,
    prepare: overrides.prepare ?? (async (input: any) => {
      calls.prepare += 1;
      return { ok: true, authority: input.sessionId };
    }),
    execute: overrides.execute ?? (async () => { calls.execute += 1; }),
    stop: overrides.stop ?? (async (sessionId: string | null) => { calls.stop.push(sessionId); }),
    auditLog: overrides.auditLog ?? { append: async (entry: any) => { calls.audit.push(entry); } },
    withLifetime: overrides.withLifetime ?? (async (operation: () => Promise<any>) => {
      calls.lifetime += 1;
      return operation();
    }),
  });
  return { routes, stored, calls, cache };
};

describe('native kernel agent custody', () => {
  test('validates authority before committing a Class-E receipt', async () => {
    const { routes, stored, calls } = harness({
      prepare: async () => ({ ok: false, error: 'provider-key-missing', outcomeKnown: true }),
    });
    const operationId = sendId('precommit');
    expect(await routes['agent/send']({
      text: 'use git', sessionId: 'chat-a', operationId,
    })).toEqual({ ok: false, error: 'provider-key-missing', outcomeKnown: true });
    expect(stored['agentSendReceipts.v1']).toBeUndefined();
    expect(calls.execute).toBe(0);
  });

  test('returns after acceptance, retains Firefox lifetime, and settles exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ execute: async () => { h.calls.execute += 1; await gate; } });
    const operationId = sendId('settle');
    await expect(h.routes['agent/send']({
      text: 'continue', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: true, operationId });
    expect(h.stored['agentSendReceipts.v1'][operationId].status).toBe('accepted');
    expect(h.calls.lifetime).toBe(1);
    await expect(h.routes['agent/send']({
      text: 'continue', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(h.calls.execute).toBe(1);
    release();
    await until(() => h.stored['agentSendReceipts.v1'][operationId].status === 'settled');
    await expect(h.routes['agent/send']({
      checkOnly: true, sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: true, duplicate: true, operationId });
  });

  test('post-commit loss is unknown and never replayed by a successor', async () => {
    const operationId = sendId('lost');
    const first = harness({ execute: async () => { throw new Error('worker lost'); } });
    await expect(first.routes['agent/send']({
      text: 'push it', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: true, operationId });
    await until(() => first.stored['agentSendReceipts.v1'][operationId].status === 'unknown');
    const successor = harness({ sessionCache: first.cache });
    await expect(successor.routes['agent/send']({
      text: 'push it', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(successor.calls.execute).toBe(0);
  });

  test('a resolved controller unknown is fenced exactly like transport loss', async () => {
    const operationId = sendId('unknown-result');
    const first = harness({ execute: async () => ({
      ok: false, code: 'controller-channel-lost', outcomeKnown: false,
    }) });
    await expect(first.routes['agent/send']({
      text: 'commit it', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: true, operationId });
    await until(() => first.stored['agentSendReceipts.v1'][operationId].status === 'unknown');
    await expect(first.routes['agent/send']({
      text: 'commit it', sessionId: 'chat-a', operationId,
    })).resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(first.calls.execute).toBe(0);
  });

  test('Stop aborts only the current session and awaits durable owner cleanup', async () => {
    let observedAbort = false;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const h = harness({
      execute: async (_prepared: any, input: any) => new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => { observedAbort = true; resolve(); });
      }),
      stop: async (sessionId: string | null) => { h.calls.stop.push(sessionId); await stopGate; },
    });
    const sent = h.routes['agent/send']({ text: 'run', sessionId: 'chat-a' });
    await until(() => h.routes.activeCount() === 1);
    const stopped = h.routes['agent/stop']();
    await until(() => observedAbort);
    expect(h.calls.stop).toEqual(['chat-a']);
    releaseStop();
    await expect(stopped).resolves.toEqual({ ok: true });
    await expect(sent).resolves.toEqual({ ok: true });
  });

  test('locked and stale-session requests never prepare or commit', async () => {
    const locked = harness({ vault: { isLocked: () => true } });
    expect(await locked.routes['agent/send']({ text: 'hello' }))
      .toEqual({ ok: false, error: 'locked', outcomeKnown: true });
    expect(locked.calls.prepare).toBe(0);
    const stale = harness();
    expect(await stale.routes['agent/send']({
      text: 'hello', sessionId: 'chat-b', operationId: sendId('stale'),
    })).toMatchObject({ ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true });
    expect(stale.calls.prepare).toBe(0);
  });
});
