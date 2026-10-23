import { describe, expect, test } from 'bun:test';
import { makeSpawnActor } from '../../../extension/peerd-runtime/actor/spawn.js';
import { makeAsyncActors } from '../../../extension/peerd-runtime/actor/async-actors.js';
import { makeInMemorySessions, runActorLoop } from '../../../extension/peerd-runtime/actor/actor-worker-core.js';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { makeTurnSlots } from '../../../extension/peerd-runtime/loop/turn-slots.js';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';
import { makeMockIdb } from '../../../extension/tests/mocks/idb.js';
import { wrapUntrusted } from '../../../extension/peerd-runtime/tools/prompt-wrap.js';

const scenario = async (ending: string) => {
  let sequence = 0, toolCalls = 0, childId = '', expire = () => {};
  let began = () => {}, terminal = () => {};
  const started = new Promise<void>((resolve) => { began = resolve; });
  const settled = new Promise<void>((resolve) => { terminal = resolve; });
  let actors: ReturnType<typeof makeAsyncActors>, childResult: any;
  const sessions = createSessionStore({
    idb: makeMockIdb(), makeId: () => `terminal-session-${++sequence}`,
    onMessageAppended: (sessionId, message: any) => {
      actors?.acknowledgeDelivery(sessionId, message.actorReply?.actorDeliveryId);
    },
  });
  const parent = await sessions.create(), other = await sessions.create();
  let currentSessionId = parent.sessionId;
  const slots = makeTurnSlots(), wakes: any[] = [], retries: unknown[] = [], audits: any[] = [];
  const spawn = makeSpawnActor({
    sessions, turnSlots: slots, appendAudit: async (entry) => { audits.push(entry); },
    setTimer: (callback) => { expire = callback; }, clearTimer: () => {},
    projectChildSurface: async () => ({
      tools: [{ name: 'read_result', description: 'Read a saved result.', schema: { type: 'object' } }], operations: [],
    }),
    renderSystemPromptForChild: () => 'Inspect the saved result.',
    runChildOffscreen: async (job: any, options: any) => {
      childId = job.sessionId;
      const memory = makeInMemorySessions({ sessionId: childId, provider: job.provider, model: job.model });
      let step = 0;
      const result = await runActorLoop({
        runUserTurn, sessions: memory,
        getSystemPrompt: () => job.systemPrompt, appendAudit: async () => {}, tools: job.tools,
        toolDispatch: async () => { toolCalls++; return { ok: true, content: 'Saved bytes read.' }; },
        onEvent: options.onEvent,
        callModel: async function* (request: any) {
          began();
          if (['stop-child', 'stop-parent', 'timeout'].includes(ending)) {
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new DOMException('stopped', 'AbortError');
          }
          step++;
          if (step === 1 || ending === 'steps') {
            if (['provider', 'known-host'].includes(ending)) yield { type: 'text-delta', text: 'RAW_CHILD_INTERMEDIATE' };
            yield { type: 'tool-use-start', id: `child-call-${step}`, name: 'read_result' };
            yield { type: 'tool-use-delta', id: `child-call-${step}`, partialJson: ending === 'cut' ? '{"key":' : '{"key":"saved"}' };
            if (ending !== 'cut') yield { type: 'tool-use-stop', id: `child-call-${step}` };
            yield { type: 'message-stop', stopReason: ending === 'cut' ? 'max_tokens' : 'tool_use' };
          } else {
            if (ending === 'normal') yield { type: 'text-delta', text: 'The saved result is ready.' };
            if (['provider', 'provider-tool'].includes(ending)) yield { type: 'error', error: 'RAW_PROVIDER_FAILURE' };
            yield { type: 'message-stop', stopReason: 'end_turn' };
          }
        },
      } as any, { sessionId: childId, userText: job.task, maxSteps: job.maxSteps, signal: options.signal });
      // why: mirror the existing host envelope at the injected worker boundary.
      return { ...result, ok: !['unknown', 'known-host'].includes(ending) && !result.error, started: true,
        ...(result.error ? { outcomeKnown: true } : {}),
        ...(ending === 'unknown' ? { error: 'worker reply lost after dispatch', outcomeKnown: false } : {}),
        ...(ending === 'known-host' ? { error: 'known provider failure after tool work', outcomeKnown: true } : {}),
        ...(options.signal.aborted && !result.finalText ? { aborted: true } : {}) };
    },
  });
  actors = makeAsyncActors({
    turnSlots: slots, stopSubtree: spawn.stopSubtree, wrapUntrusted,
    spawnActor: async (request) => {
      childResult = await spawn({ ...request, tools: ['read_result'], maxSteps: 2 } as any);
      return childResult;
    },
    getActiveSessionId: async () => currentSessionId, isVaultLocked: () => false,
    forwardEvent: () => {}, notify: () => {}, schedule: (fn) => retries.push(fn),
    onTasksChanged: () => {
      if (['delivered', 'cancelled'].includes(actors?.actorTasks(parent.sessionId)[0]?.status)) terminal();
    },
    reenter: async (request) => {
      wakes.push(request);
      for await (const _ of runUserTurn({
        ...request, sessions, preflightReply: 'The child terminal report was saved.',
        getSystemPrompt: async () => '', appendAudit: async () => {},
        getSecret: async () => { throw new Error('unexpected parent secret read'); },
        safeFetch: async () => { throw new Error('unexpected parent fetch'); },
        callModel: async function* () { throw new Error('unexpected parent inference'); },
      } as any)) { /* consume the real durable append */ }
    },
  });
  await actors.spawnActorAsync({ parentSessionId: parent.sessionId, parentToolUseId: 'parent-call-1', task: 'Inspect the saved result.' });
  currentSessionId = other.sessionId;
  await started;
  let newer: ReturnType<typeof slots.claim> | undefined;
  if (ending === 'timeout') expire();
  if (ending === 'stop-child') slots.stop(childId);
  if (ending === 'stop-parent') {
    slots.stop(parent.sessionId);
    spawn.stopSubtree(parent.sessionId);
    newer = slots.claim(parent.sessionId);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([settled, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('terminal delivery did not settle')), 1_000);
    })]);
    return { childResult, wakes, retries, toolCalls, audits, parent: await sessions.get(parent.sessionId),
      child: await sessions.get(childId), currentSessionId, expectedCurrent: other.sessionId,
      newerAborted: newer?.controller.signal.aborted };
  } finally { clearTimeout(timer); newer?.release(); }
};

describe('spawned terminal delivery through the real loop', () => {
  test.each(['cut', 'steps', 'empty', 'provider', 'provider-tool', 'known-host'])('%s reaches the original parent once as a bounded partial report', async (ending) => {
    const result = await scenario(ending);
    expect(result.wakes).toHaveLength(1);
    expect(result.retries).toEqual([]);
    expect(result.childResult).toMatchObject({ incomplete: true });
    if (!['provider-tool', 'known-host'].includes(ending)) expect(result.childResult.stopped).not.toBe(true);
    expect(result.wakes[0].actorReply).toMatchObject({
      failed: true, parentToolUseId: 'parent-call-1', parentToolUseIds: ['parent-call-1'],
    });
    expect(result.parent!.messages[0]).toMatchObject({ id: result.wakes[0].actorReply.actorDeliveryId,
      actorReply: result.wakes[0].actorReply });
    expect(result.currentSessionId).toBe(result.expectedCurrent);
    expect(result.wakes[0].userText.length).toBeLessThan(2_000);
    expect(result.wakes[0].userText).not.toMatch(/has finished|RAW_CHILD_INTERMEDIATE|RAW_PROVIDER_FAILURE/);
    expect(result.toolCalls).toBe(ending === 'cut' ? 0 : ending === 'steps' ? 2 : 1);
    if (ending === 'steps') expect(result.childResult.exceeded).toBe(true);
    if (['provider-tool', 'known-host'].includes(ending)) {
      expect(result.childResult).toMatchObject({ executionFailed: true, outcomeKnown: true });
      const failure = result.audits.find((entry) => entry.type === 'actor_isolated_error');
      expect(failure.details.outcomeKnown).toBe(true);
      expect(failure.details).not.toHaveProperty('performed');
      expect(result.wakes[0].userText).not.toContain('failed before target work ran');
    }
    if (['provider', 'provider-tool'].includes(ending)) {
      expect(JSON.stringify(result.child)).toContain('RAW_PROVIDER_FAILURE');
      expect(result.wakes[0].userText).not.toContain('failed before target work ran');
    }
  });

  test.each(['normal', 'timeout', 'unknown'])('%s retains its terminal distinction and correlation', async (ending) => {
    const result = await scenario(ending);
    expect(result.wakes).toHaveLength(1);
    expect(result.wakes[0].actorReply.parentToolUseId).toBe('parent-call-1');
    if (ending === 'normal') {
      expect(result.wakes[0].actorReply.failed).toBe(false);
      expect(result.wakes[0].userText).toContain('The saved result is ready.');
    }
    if (ending === 'timeout') {
      expect(result.childResult.timedOut).toBe(true);
      expect(result.wakes[0].userText).toContain('wall-clock timeout');
    }
    if (ending === 'unknown') {
      expect(result.wakes[0].actorReply).toMatchObject({ failed: true, outcomeKnown: false });
      expect(result.wakes[0].userText).toContain('Do not retry automatically');
      expect(result.audits.find((entry) => entry.type === 'actor_isolated_error').details).toMatchObject({ performed: true, outcomeKnown: false });
      expect(result.child!.messages).toContainEqual(expect.objectContaining({
        toolUses: [{ id: 'child-call-1', name: 'read_result', input: { key: 'saved' } }],
      }));
    }
  });

  test.each(['stop-child', 'stop-parent'])('%s prevents a later wake', async (ending) => {
    const result = await scenario(ending);
    expect(result.wakes).toEqual([]);
    expect(result.childResult.stopped).toBe(true);
    if (ending === 'stop-parent') expect(result.newerAborted).toBe(false);
  });
});
