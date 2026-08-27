import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
import { makeOffscreenActorChannelClient } from '../../extension/background/offscreen-actor-channel-client.js';
import { bindActorChannel } from '../../extension/offscreen/actor-channel-host.js';
import { DWEB_INBOUND_TOOL_NAMES } from '../../extension/peerd-runtime/actor/capability-manifest.js';

const OFFSCREEN = { id: 'ext', url: 'chrome-extension://ext/offscreen/offscreen.html' };
const ENGINE_TAB = { id: 'ext', url: 'chrome-extension://ext/engine-tabs/vm-tab/vm-tab.html' };

const inferenceInput = (relayToken: string, over: Record<string, any> = {}) => ({
  relayToken,
  providerId: 'anthropic',
  modelId: 'model-1',
  nativeBody: {
    model: 'model-1', stream: true, messages: [], system: 'system', max_tokens: 128,
  },
  ...over,
});

const providerEgress = (over: Record<string, any> = {}) => ({
  openInference: async (input: any, grant: any) => grant.permits(
    input.providerId, input.modelId,
  ) ? {
      ok: true, outcomeKnown: true,
      value: { streamId: 'stream-1', status: 200, headers: {}, hasBody: true },
    } : { ok: false, error: 'model-egress-request-invalid', outcomeKnown: true },
  readInferenceChunk: async () => ({
    ok: true, outcomeKnown: true, value: { done: true },
  }),
  cancelInference: async () => ({ ok: true, outcomeKnown: true, value: null }),
  readModelContext: async () => ({ ok: true, value: { contextWindow: 100_000 } }),
  openLocalGeneration: async () => ({ ok: false, outcomeKnown: true }),
  readLocalGeneration: async () => ({ ok: false, outcomeKnown: true }),
  cancelLocalGeneration: async () => ({ ok: true, outcomeKnown: true }),
  closeOwner: async () => {},
  ...over,
});

const baseDeps = (over: Record<string, any> = {}) => ({
  ensureOffscreen: async () => {},
  isOffscreenSender: (sender: any) => sender?.url === OFFSCREEN.url,
  sendMessage: async () => ({ ok: true, started: true, finalText: '' }),
  providerEgress: providerEgress(),
  sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
  buildToolContext: async () => ({ session: { sessionId: 'actor-1', kind: 'actor' } }),
  prepareToolCall: async (call: any, ctx: any) => ({
    prepared: true, call, ctx, args: call.args,
  }),
  settleToolCall: async (_prepared: any, execution: any) => execution.result,
  pinActorCall: () => {},
  EXPOSURE_ACTOR: 'actor',
  inboundDwebToolNames: DWEB_INBOUND_TOOL_NAMES,
  ...over,
});

const clientWithRelay = (over: Record<string, any> = {}) => {
  let relay: ((token: string) => Promise<any>) | null = null;
  let captured: any = null;
  const client = makeOffscreenActorClient(baseDeps({
    ...over,
    sendMessage: async (message: any) => {
      if (message.type === 'actor/run' && relay) {
        captured = await relay(message.job.relayToken);
      }
      return { ok: true, started: true, finalText: '' };
    },
  }));
  return {
    client,
    during: async (
      fn: (token: string) => Promise<any>,
      actorSessionId = 'actor-1',
      job: Record<string, any> = {},
    ) => {
      relay = fn;
      await client.run({
        actorSessionId,
        message: 'm',
        systemPrompt: 's',
        provider: 'anthropic',
        model: 'model-1',
        maxOutputTokens: 4096,
        ...job,
      } as any);
      return captured;
    },
  };
};

describe('isolated actor run custody', () => {
  test('stamps an empty stopped turn as aborted', async () => {
    const controller = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') controller.abort();
        return { ok: true, started: true, finalText: '' };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  test('does not overwrite a raced real reply with abort state', async () => {
    const controller = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') controller.abort();
        return { ok: true, started: true, finalText: 'reply' };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    expect(result.finalText).toBe('reply');
    expect(result.aborted).toBeUndefined();
  });

  test('does not start the host after a pre-start abort', async () => {
    let started = false;
    const controller = new AbortController();
    controller.abort();
    const client = makeOffscreenActorClient(baseDeps({
      ensureOffscreen: async () => { started = true; },
    }));
    const result: any = await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(started).toBe(false);
  });
});

describe('isolated model egress authority', () => {
  test('pins provider, model, output cap, sender, and live run token', async () => {
    let opened: any = null;
    const { client, during } = clientWithRelay({
      providerEgress: providerEgress({
        openInference: async (input: any, grant: any) => {
          opened = {
            input,
            allowed: grant.permits(input.providerId, input.modelId),
            outputTokenLimit: grant.maxOutputTokens,
          };
          return opened.allowed
            ? { ok: true, value: { streamId: 's', status: 200, headers: {}, hasBody: true } }
            : { ok: false, error: 'refused', outcomeKnown: true };
        },
      }),
    });
    const result = await during(async (relayToken) => ({
      forgedSender: await client.routes['actor/model-open-inference'](
        inferenceInput(relayToken), ENGINE_TAB,
      ),
      forgedModel: await client.routes['actor/model-open-inference'](
        inferenceInput(relayToken, { modelId: 'other' }), OFFSCREEN,
      ),
      admitted: await client.routes['actor/model-open-inference'](
        inferenceInput(relayToken, {
          nativeBody: { model: 'model-1', stream: true, messages: [], max_tokens: 999_999 },
        }), OFFSCREEN,
      ),
    }));
    expect(result.forgedSender).toMatchObject({ ok: false });
    expect(result.forgedModel).toMatchObject({ ok: false });
    expect(result.admitted).toMatchObject({ ok: true });
    expect(opened.allowed).toBe(true);
    expect(opened.outputTokenLimit).toBe(4096);
  });

  test('spend refusal happens before provider custody opens', async () => {
    let opened = false;
    const { client, during } = clientWithRelay({
      spendRefusalFor: async () => 'limit reached',
      providerEgress: providerEgress({
        openInference: async () => { opened = true; return { ok: true }; },
      }),
    });
    const result = await during((relayToken) => client.routes[
      'actor/model-open-inference'
    ](inferenceInput(relayToken), OFFSCREEN));
    expect(result).toMatchObject({ ok: false });
    expect(opened).toBe(false);
  });

  test('a retired token cannot reopen model custody', async () => {
    let leaked = '';
    const { client, during } = clientWithRelay();
    await during(async (relayToken) => { leaked = relayToken; return null; });
    const replay = await client.routes['actor/model-open-inference'](
      inferenceInput(leaked), OFFSCREEN,
    );
    expect(replay).toEqual({
      ok: false, error: 'actor/model-open-inference: unauthorized relay',
    });
  });

  test('Stop closes a local generation that opens after the first owner cleanup', async () => {
    const controller = new AbortController();
    let markOpenStarted!: () => void;
    let releaseOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    let closes = 0;
    let observed: any = null;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      settlementCleanupMs: 10,
      providerEgress: providerEgress({
        openLocalGeneration: async () => {
          markOpenStarted();
          await openGate;
          return { ok: true, value: { streamId: 'late-local-stream' } };
        },
        closeOwner: async () => { closes += 1; return new Promise(() => {}); },
      }),
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        const opening = client.routes['actor/model-open-local']({
          relayToken: message.job.relayToken,
          providerId: 'anthropic', modelId: 'model-1',
          messages: [], system: '', tools: [], maxTokens: 128,
        }, OFFSCREEN);
        await openStarted;
        controller.abort();
        releaseOpen();
        observed = await opening;
        return { ok: false, started: true, finalText: '' };
      },
    }));
    const completed = await Promise.race([
      client.run({
        actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
        provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      } as any, { signal: controller.signal }).then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    expect(completed).toBe('completed');
    expect(observed).toEqual({ ok: false, error: 'aborted' });
    expect(closes).toBeGreaterThanOrEqual(2);
  });
});

describe('isolated exact tool authority', () => {
  test('has no generic tool dispatch route', () => {
    const client = makeOffscreenActorClient(baseDeps());
    expect(Object.hasOwn(client.routes, 'actor/tool-dispatch')).toBe(false);
  });

  test('prepares, effects, and settles one exact actor operation', async () => {
    let cancelled = '';
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 2, kind: 'spawned' },
        actorAuthority: {
          cancelTask: async (taskId: string) => {
            cancelled = taskId;
            return { ok: true, content: `cancelled ${taskId}` };
          },
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const call = {
        id: 'call-1', name: 'actor_cancel', args: { taskId: 'task-7' },
      };
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor', call,
      }, OFFSCREEN);
      const effect = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-7',
      }, OFFSCREEN);
      const duplicate = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-7',
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken,
        executionId: prepared.executionId,
        result: { ok: true, content: effect.value.content },
      }, OFFSCREEN);
      return { prepared, effect, duplicate, settled };
    });
    expect(result.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'actor_cancel',
      projection: { sessionId: 'actor-1', sessionDepth: 2, sessionKind: 'spawned' },
    });
    expect(result.effect).toEqual({
      ok: true, value: { ok: true, content: 'cancelled task-7' },
    });
    expect(result.duplicate).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.settled).toEqual({
      ok: true, result: { ok: true, content: 'cancelled task-7' },
    });
    expect(cancelled).toBe('task-7');
  });

  test('host custody overrides retryable failures after commit and resource effects', async () => {
    const performed: string[] = [];
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 1, kind: 'actor' },
        actorAuthority: {
          spawnAsync: async () => {
            performed.push('commit');
            return { taskId: 'spawned-1' };
          },
        },
        webFetch: async (url: string) => {
          performed.push('resource');
          return {
            status: 200, url, headers: new Headers(), text: async () => 'ok',
          };
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const commit: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'commit-effect', name: 'actor_create', args: {
          task: 'spawn once', sync: false, allowRecursion: false,
        } },
      }, OFFSCREEN);
      await client.routes['actor/spawn-async']({
        relayToken, executionId: commit.executionId,
        task: 'spawn once', allowRecursion: false,
      }, OFFSCREEN);
      const commitSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: commit.executionId,
        result: {
          ok: false, error: 'pretend the spawn did not happen',
          outcomeKnown: true, retryable: true, outcomeKind: 'pre-effect-failure',
        },
      }, OFFSCREEN);

      const resource: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        call: { id: 'resource-effect', name: 'fetch_url', args: {
          url: 'https://example.com/data', method: 'GET',
        } },
      }, OFFSCREEN);
      await client.routes['resource/request-web-text']({
        relayToken, executionId: resource.executionId,
        url: 'https://example.com/data', method: 'GET', headers: {}, body: undefined,
      }, OFFSCREEN);
      const resourceSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: resource.executionId,
        result: {
          ok: false, error: 'pretend the request never completed',
          outcomeKnown: true, retryable: true, outcomeKind: 'pre-effect-failure',
        },
      }, OFFSCREEN);
      return { commitSettlement, resourceSettlement };
    });
    for (const settlement of [result.commitSettlement, result.resourceSettlement]) {
      expect(settlement).toMatchObject({
        ok: true,
        result: {
          ok: false, outcomeKnown: true, retryable: false,
          effectEntered: true, performed: true, outcomeKind: 'effect-completed',
        },
      });
    }
    expect(performed).toEqual(['commit', 'resource']);
  });

  test('host verdict distinguishes completed schedules from refused effects', async () => {
    const exercise = async (scheduleResult: any, reported: any) => {
      let durableResult: any = null;
      const { client, during } = clientWithRelay({
        buildToolContext: async () => ({
          session: { sessionId: 'actor-1', kind: 'actor' },
          permission: { confirmActions: true },
          scheduleAdd: async () => scheduleResult,
        }),
        settleToolCall: async (_prepared: any, execution: any) => {
          durableResult = execution.result;
          return execution.result;
        },
      });
      const observed = await during(async (relayToken) => {
        const prepared: any = await client.routes['actor/tool-prepare']({
          relayToken, authorityClass: 'schedule',
          call: { id: 'schedule-verdict', name: 'schedule_create', args: {
            prompt: 'check once', every: '1h', dailyAt: undefined, mode: 'goal',
          } },
        }, OFFSCREEN);
        const effect = await client.routes['schedule/arm-confirmed-routine']({
          relayToken, executionId: prepared.executionId,
          prompt: 'check once', every: '1h', dailyAt: undefined, mode: 'goal',
        }, OFFSCREEN);
        const settlement = await client.routes['actor/tool-settle']({
          relayToken, executionId: prepared.executionId, result: reported,
        }, OFFSCREEN);
        return { effect, settlement };
      }, 'actor-1', { tools: [{ name: 'schedule_create' }] });
      return { ...observed, durableResult };
    };

    const completed = await exercise({
      ok: true,
      routine: {
        id: 'routine-1', prompt: 'check once', schedule: { kind: 'interval', everyMs: 3_600_000 },
        mode: 'goal', nextRunAt: 1_700_000_000_000,
      },
    }, {
      ok: false, error: 'pretend the routine was not armed', outcomeKnown: true,
      retryable: true, performed: false, outcomeKind: 'pre-effect-failure',
    });
    expect(completed.effect).toMatchObject({ ok: true, value: { ok: true } });
    expect(completed.durableResult).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: true, performed: true,
      retryable: false, outcomeKind: 'effect-completed',
    });

    const refused = await exercise({ ok: false, error: 'invalid-schedule' }, {
      ok: false, error: 'forge a completed mutation', outcomeKnown: true,
      retryable: false, performed: true, outcomeKind: 'effect-completed',
    });
    expect(refused.effect).toMatchObject({
      ok: true, value: { ok: false, error: 'invalid-schedule' },
    });
    expect(refused.durableResult).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: true, performed: false,
      outcomeKind: 'pre-effect-failure',
    });

    const uncertain = await exercise({
      ok: false, error: 'schedule-storage-response-lost', outcomeKnown: false,
    }, { ok: true, performed: false });
    expect(uncertain.effect).toMatchObject({
      ok: true,
      value: { ok: false, error: 'schedule-storage-response-lost', outcomeKnown: false },
    });
    expect(uncertain.durableResult).toMatchObject({
      ok: false, outcomeKnown: false, retryable: false, outcomeKind: 'host-lost',
    });
    expect(uncertain.durableResult.performed).toBeUndefined();
  });

  test('a declined web-write confirmation cannot be forged into a performed effect', async () => {
    let durableResult: any = null;
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        confirm: async () => 'no_once',
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        durableResult = execution.result;
        return execution.result;
      },
    });
    const observed = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        call: { id: 'confirmation-verdict', name: 'fetch_url', args: {
          url: 'https://example.com/write', method: 'POST', body: 'payload',
        } },
      }, OFFSCREEN);
      const confirmation = await client.routes['resource/confirm-web-write']({
        relayToken, executionId: prepared.executionId,
        url: 'https://example.com/write', method: 'POST',
      }, OFFSCREEN);
      await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: {
          ok: false, error: 'declined', outcomeKnown: true, retryable: false,
          performed: true, outcomeKind: 'effect-completed',
        },
      }, OFFSCREEN);
      return confirmation;
    }, 'actor-1', { tools: [{ name: 'fetch_url' }] });
    expect(observed).toEqual({ ok: true, value: 'no_once', outcomeKnown: true });
    expect(durableResult).toMatchObject({
      ok: false, error: 'declined', outcomeKnown: true,
      effectEntered: true, performed: false, outcomeKind: 'pre-effect-failure',
    });
  });

  test('a fulfilled persistence no-op and its retired grant cannot be forged', async () => {
    let durableResult: any = null;
    let writes = 0;
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        memory: {
          writeWithConfirm: async () => {
            writes += 1;
            return { ok: true, op: 'noop', id: 'memory-1' };
          },
        },
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        durableResult = execution.result;
        return execution.result;
      },
    });
    const observed = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'persistence',
        call: { id: 'memory-noop', name: 'remember', args: {
          scope: 'global', body: 'already present',
        } },
      }, OFFSCREEN);
      const effect = await client.routes['memory/write']({
        relayToken, executionId: prepared.executionId,
        scope: { kind: 'global', workspace: '' }, body: 'already present',
      }, OFFSCREEN);
      const settlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: {
          ok: false, error: 'forge a completed write', outcomeKnown: true,
          performed: true, effectEntered: true, outcomeKind: 'effect-completed',
        },
      }, OFFSCREEN);
      const replay = await client.routes['memory/write']({
        relayToken, executionId: prepared.executionId,
        scope: { kind: 'global', workspace: '' }, body: 'already present',
      }, OFFSCREEN);
      return { relayToken, prepared, effect, settlement, replay };
    }, 'actor-1', { tools: [{ name: 'remember' }] });
    expect(observed.effect).toMatchObject({
      ok: true, value: { ok: true, op: 'noop' },
    });
    expect(observed.replay).toMatchObject({ ok: false, outcomeKnown: true });
    expect(durableResult).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: true,
      performed: false, outcomeKind: 'pre-effect-failure',
    });
    const stale = await client.routes['memory/write']({
      relayToken: observed.relayToken, executionId: observed.prepared.executionId,
      scope: { kind: 'global', workspace: '' }, body: 'already present',
    }, OFFSCREEN);
    expect(stale).toMatchObject({ ok: false, outcomeKnown: true });
    expect(writes).toBe(1);
  });

  test('the worker cannot claim an effect without entering exact authority', async () => {
    let durableResult: any = null;
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        durableResult = execution.result;
        return execution.result;
      },
    });
    await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'unentered-effect', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      return client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: {
          ok: false, error: 'forge completion', outcomeKnown: true,
          performed: true, effectEntered: true, outcomeKind: 'effect-completed',
        },
      }, OFFSCREEN);
    }, 'actor-1', { tools: [{ name: 'actor_cancel' }] });
    expect(durableResult).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: false,
      performed: false, outcomeKind: 'pre-effect-failure',
    });
  });

  test('the Chrome bound relay preserves irreversible host custody', async () => {
    let spawns = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 1, kind: 'actor' },
        actorAuthority: {
          spawnAsync: async () => {
            spawns += 1;
            return { taskId: 'spawned-channel' };
          },
        },
      }),
      runOnChannel: async (_job: any, { relay }: any) => {
        const prepared = await relay('actor/tool-prepare', {
          authorityClass: 'actor',
          call: { id: 'channel-commit', name: 'actor_create', args: {
            task: 'spawn once', sync: false, allowRecursion: false,
          } },
        });
        await relay('actor/spawn-async', {
          executionId: prepared.executionId,
          task: 'spawn once', allowRecursion: false,
        });
        return relay('actor/tool-settle', {
          executionId: prepared.executionId,
          result: {
            ok: false, error: 'pretend the bound relay did not commit',
            outcomeKnown: true, retryable: true, outcomeKind: 'pre-effect-failure',
          },
        });
      },
    }));
    const result = await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      tools: [{ name: 'actor_create' }],
    } as any);
    expect(result).toMatchObject({
      ok: true,
      result: {
        ok: false, outcomeKnown: true, retryable: false,
        effectEntered: true, performed: true, outcomeKind: 'effect-completed',
      },
    });
    expect(spawns).toBe(1);
  });

  test('the real Chrome MessageChannel rejects shared settlement memory', async () => {
    const channel = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      newChannelId: () => 'shared-memory-channel',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindActorChannel({
          port: transfer[0] as MessagePort,
          channelId: offer.channelId,
          workerUrl: '/offscreen/actor-worker.js',
          abort: () => {},
          run: async (_job, { sendToSW }) => {
            const prepared = await sendToSW('actor/tool-prepare', {
              authorityClass: 'actor',
              call: {
                id: 'shared-channel-result', name: 'actor_cancel',
                args: { taskId: 'task-1' },
              },
            });
            return sendToSW('actor/tool-settle', {
              executionId: prepared.executionId,
              result: { ok: true, content: new DataView(new SharedArrayBuffer(16)) },
            });
          },
        }),
      }),
    });
    const client = makeOffscreenActorClient(baseDeps({
      runOnChannel: (job: any, options: any) => channel.run(job, {
        ...options, lease: Object.freeze({ scope: 'controller', leaseId: 'security-test' }),
      }),
    }));
    const result = await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      tools: [{ name: 'actor_cancel' }],
    } as any);
    expect(result).toMatchObject({
      ok: false, error: 'actor/tool-settle: authority mismatch', outcomeKnown: true,
    });
  });

  test('rejects altered arguments before an exact effect', async () => {
    let cancelled = false;
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => { cancelled = true; return { ok: true }; },
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        authorityClass: 'actor',
        call: { id: 'call-1', name: 'actor_cancel', args: { taskId: 'approved' } },
      }, OFFSCREEN);
      return client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'altered',
      }, OFFSCREEN);
    });
    expect(result).toMatchObject({ ok: false, outcomeKnown: true });
    expect(cancelled).toBe(false);
  });

  test('binds actor authority to post-hook arguments', async () => {
    let cancelled = '';
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async (taskId: string) => {
            cancelled = taskId;
            return { ok: true, content: `cancelled ${taskId}` };
          },
        },
      }),
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: { taskId: 'hook-task' },
      }),
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'call-hook', name: 'actor_cancel', args: { taskId: 'model-task' } },
      }, OFFSCREEN);
      const original = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'model-task',
      }, OFFSCREEN);
      const modified = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'hook-task',
      }, OFFSCREEN);
      return { prepared, original, modified };
    });
    expect(result.prepared.args).toEqual({ taskId: 'hook-task' });
    expect(result.original).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.modified).toMatchObject({ ok: true });
    expect(cancelled).toBe('hook-task');
  });

  test('binds actor creation and messaging to their post-hook arguments', async () => {
    const effects: any[] = [];
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor', depth: 0 },
        inbound: false,
        actorAuthority: {
          spawnSync: async (request: any) => { effects.push(['spawn', request]); return 'done'; },
          deliverMessage: async (request: any) => { effects.push(['message', request]); return 'sent'; },
        },
      }),
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx,
        args: call.name === 'actor_create' ? {
          task: 'hook task', sync: true, allowRecursion: true, tools: ['now'],
          maxSteps: 4, maxDepth: 2,
        } : {
          to: 'hook actor', message: 'hook message', oneShot: true, await: true,
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const create: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'create-1', name: 'actor_create', args: {
          task: 'model task', sync: true, allowRecursion: false,
        } },
      }, OFFSCREEN);
      const rejectedCreate = await client.routes['actor/spawn-sync']({
        relayToken, executionId: create.executionId, task: 'model task',
        allowRecursion: false,
      }, OFFSCREEN);
      const acceptedCreate = await client.routes['actor/spawn-sync']({
        relayToken, executionId: create.executionId, task: 'hook task',
        allowRecursion: true, tools: ['now'], maxSteps: 4, maxDepth: 2,
      }, OFFSCREEN);
      const message: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'message-1', name: 'message_actor', args: {
          to: 'model actor', message: 'model message', oneShot: false, await: false,
        } },
      }, OFFSCREEN);
      const rejectedMessage = await client.routes['actor/message-deliver']({
        relayToken, executionId: message.executionId,
        to: 'model actor', message: 'model message', oneShot: false,
        awaitReply: false, degradeToAsync: false, awaitCapMs: 1000,
      }, OFFSCREEN);
      const acceptedMessage = await client.routes['actor/message-deliver']({
        relayToken, executionId: message.executionId,
        to: 'hook actor', message: 'hook message', oneShot: true,
        awaitReply: true, degradeToAsync: true, awaitCapMs: 1000,
      }, OFFSCREEN);
      return { create, rejectedCreate, acceptedCreate, message, rejectedMessage, acceptedMessage };
    });
    expect(result.create.args.task).toBe('hook task');
    expect(result.rejectedCreate).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.acceptedCreate).toMatchObject({ ok: true, value: 'done' });
    expect(result.message.args.to).toBe('hook actor');
    expect(result.rejectedMessage).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.acceptedMessage).toMatchObject({ ok: true, value: 'sent' });
    expect(effects.map(([kind]) => kind)).toEqual(['spawn', 'message']);
  });

  test('keeps actor settlement retryable until durable settlement succeeds', async () => {
    let settlements = 0;
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        if (settlements === 1) throw new Error('temporary settlement failure');
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'call-settle', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const message = {
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'known failure' },
      };
      const first = await client.routes['actor/tool-settle'](message, OFFSCREEN);
      const second = await client.routes['actor/tool-settle'](message, OFFSCREEN);
      const replay = await client.routes['actor/tool-settle'](message, OFFSCREEN);
      return { first, second, replay };
    });
    expect(result.first).toMatchObject({
      ok: false, error: 'temporary settlement failure', outcomeKnown: true,
    });
    expect(result.second).toMatchObject({ ok: true });
    expect(result.replay).toMatchObject({ ok: false, outcomeKnown: true });
    expect(settlements).toBe(2);
  });

  test('freezes an explicit null settlement across a failed durable attempt', async () => {
    let settlements = 0;
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        if (settlements === 1) throw new Error('temporary settlement failure');
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'call-null-settle', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const first = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: null,
      }, OFFSCREEN);
      const changed = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: { ok: true },
      }, OFFSCREEN);
      const retry = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: null,
      }, OFFSCREEN);
      return { first, changed, retry };
    });
    expect(result.first).toMatchObject({
      ok: false, error: 'temporary settlement failure', outcomeKnown: true,
    });
    expect(result.changed).toMatchObject({
      ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true,
    });
    expect(result.retry).toEqual({ ok: true, result: null });
    expect(settlements).toBe(2);
  });

  test('rejects a structured-clone array whose sparse or named fields change on retry', async () => {
    let settlements = 0;
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        if (settlements === 1) throw new Error('temporary settlement failure');
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'array-settle', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const first: any[] & { label?: string } = [];
      first.length = 2;
      first[1] = undefined;
      first.label = 'first';
      const changed: any[] & { label?: string } = [undefined, undefined];
      changed.label = 'changed';
      const initial = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: first,
      }, OFFSCREEN);
      const retry = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: changed,
      }, OFFSCREEN);
      return { initial, retry, settlementsAfterRetry: settlements };
    });
    expect(result.initial).toMatchObject({ ok: false, error: 'temporary settlement failure' });
    expect(result.retry).toMatchObject({
      ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true,
    });
    expect(result.settlementsAfterRetry).toBe(1);
    expect(settlements).toBe(2);
  });

  test('rejects pathological sparse and shared-memory settlement payloads', async () => {
    const { client, during } = clientWithRelay();
    const result = await during(async (relayToken) => {
      const prepare = (id: string) => client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id, name: 'actor_cancel', args: { taskId: id } },
      }, OFFSCREEN);
      const sparseEntry: any = await prepare('sparse-result');
      const sparse: unknown[] = [];
      sparse.length = 1_000_000_000;
      const sparseReply = await client.routes['actor/tool-settle']({
        relayToken, executionId: sparseEntry.executionId,
        result: { ok: true, content: sparse },
      }, OFFSCREEN);

      const shared = new SharedArrayBuffer(16);
      const typedEntry: any = await prepare('shared-typed-result');
      const typedReply = await client.routes['actor/tool-settle']({
        relayToken, executionId: typedEntry.executionId,
        result: { ok: true, content: new Uint8Array(shared) },
      }, OFFSCREEN);
      const viewEntry: any = await prepare('shared-view-result');
      const viewReply = await client.routes['actor/tool-settle']({
        relayToken, executionId: viewEntry.executionId,
        result: { ok: true, content: new DataView(shared) },
      }, OFFSCREEN);
      return { sparseReply, typedReply, viewReply };
    });
    for (const reply of [result.sparseReply, result.typedReply, result.viewReply]) {
      expect(reply).toMatchObject({
        ok: false, error: 'actor/tool-settle: authority mismatch', outcomeKnown: true,
      });
    }
  });

  test('ordinary typed and DataView settlements are copied before retry', async () => {
    const attempts = new Map<string, number>();
    const { client, during } = clientWithRelay({
      settleToolCall: async (prepared: any, execution: any) => {
        const next = (attempts.get(prepared.call.id) ?? 0) + 1;
        attempts.set(prepared.call.id, next);
        if (next === 1) throw new Error('temporary settlement failure');
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const exercise = async (id: string, view: Uint8Array | DataView) => {
        const prepared: any = await client.routes['actor/tool-prepare']({
          relayToken, authorityClass: 'actor',
          call: { id, name: 'actor_cancel', args: { taskId: id } },
        }, OFFSCREEN);
        const originalBytes = [...new Uint8Array(view.buffer, view.byteOffset, view.byteLength)];
        const first = await client.routes['actor/tool-settle']({
          relayToken, executionId: prepared.executionId,
          result: { ok: true, content: view },
        }, OFFSCREEN);
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[0] = 99;
        const changed = await client.routes['actor/tool-settle']({
          relayToken, executionId: prepared.executionId,
          result: { ok: true, content: view },
        }, OFFSCREEN);
        const retryBuffer = new ArrayBuffer(originalBytes.length);
        new Uint8Array(retryBuffer).set(originalBytes);
        const retryView = view instanceof DataView
          ? new DataView(retryBuffer) : new Uint8Array(retryBuffer);
        const retry = await client.routes['actor/tool-settle']({
          relayToken, executionId: prepared.executionId,
          result: { ok: true, content: retryView },
        }, OFFSCREEN);
        return { first, changed, retry };
      };
      const typedBuffer = new ArrayBuffer(4);
      new Uint8Array(typedBuffer).set([1, 2, 3, 4]);
      const dataBuffer = new ArrayBuffer(4);
      new Uint8Array(dataBuffer).set([5, 6, 7, 8]);
      return {
        typed: await exercise('typed-copy', new Uint8Array(typedBuffer)),
        data: await exercise('data-copy', new DataView(dataBuffer)),
      };
    });
    for (const exercise of [result.typed, result.data]) {
      expect(exercise.first).toMatchObject({
        ok: false, error: 'temporary settlement failure',
      });
      expect(exercise.changed).toMatchObject({
        ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true,
      });
      expect(exercise.retry).toMatchObject({ ok: true, result: { ok: true } });
    }
    expect([...new Uint8Array(result.typed.retry.result.content.buffer)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(result.data.retry.result.content.buffer)]).toEqual([5, 6, 7, 8]);
  });

  test('closes direct effect authority before settlement and only retries its frozen result', async () => {
    let markStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let settlements = 0;
    let cancellations = 0;
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => { cancellations += 1; return { ok: true }; },
        },
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        if (settlements === 1) {
          markStarted();
          await firstGate;
          throw new Error('temporary settlement failure');
        }
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'settlement-closes-effects', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const frozen = { ok: false, error: 'known failure' };
      const settling = client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: frozen,
      }, OFFSCREEN);
      await started;
      const duringSettlement = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-1',
      }, OFFSCREEN);
      releaseFirst();
      const first = await settling;
      const afterFailure = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-1',
      }, OFFSCREEN);
      const changed = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'known failure', extra: undefined },
      }, OFFSCREEN);
      const retry = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { error: 'known failure', ok: false },
      }, OFFSCREEN);
      return { duringSettlement, first, afterFailure, changed, retry };
    });
    expect(result.duringSettlement).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.first).toMatchObject({ ok: false, error: 'temporary settlement failure' });
    expect(result.afterFailure).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.changed).toMatchObject({
      ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true,
    });
    expect(result.retry).toEqual({ ok: true, result: { ok: false, error: 'known failure' } });
    expect(cancellations).toBe(0);
    expect(settlements).toBe(2);
  });

  test('closes shared named-domain authority before settlement starts its hooks', async () => {
    let markStarted!: () => void;
    let releaseSettlement!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        markStarted();
        await gate;
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'page-settlement', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const settling = client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: { ok: true },
      }, OFFSCREEN);
      await started;
      const effect = await client.routes['page/read']({
        relayToken, executionId: prepared.executionId,
      }, OFFSCREEN);
      const nested = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: prepared.executionId,
        call: { id: 'late-nested', name: 'fetch_url', args: { url: 'https://example.com' } },
      }, OFFSCREEN);
      releaseSettlement();
      await settling;
      return { effect, nested };
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result.effect).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.nested).toMatchObject({ ok: false });
  });

  test('reports an unknown result when direct actor settlement races an in-flight effect', async () => {
    let markEffectStarted!: () => void;
    let releaseEffect!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => {
            markEffectStarted();
            await effectGate;
            return { ok: true };
          },
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'pending-direct', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const effect = client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-1',
      }, OFFSCREEN);
      await effectStarted;
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: { ok: true },
      }, OFFSCREEN);
      releaseEffect();
      await effect;
      return settled;
    });
    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: 'Tool execution settled while exact authority remained active.',
        code: 'actor-tool-effect-pending',
        outcomeKnown: false,
        retryable: false,
        outcomeKind: 'host-lost',
      },
    });
  });

  test('retries a pending-effect settlement against the frozen reported result', async () => {
    let markEffectStarted!: () => void;
    let releaseEffect!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let settlements = 0;
    const durableResults: any[] = [];
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => {
            markEffectStarted();
            await effectGate;
            return { ok: true };
          },
        },
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        durableResults.push(execution.result);
        if (settlements === 1) throw new Error('temporary settlement failure');
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'pending-retry', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const effect = client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-1',
      }, OFFSCREEN);
      await effectStarted;
      const reported = { ok: true, cancelled: 'task-1' };
      const first = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: reported,
      }, OFFSCREEN);
      releaseEffect();
      await effect;
      const changed = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: true, cancelled: 'other' },
      }, OFFSCREEN);
      const retry = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: reported,
      }, OFFSCREEN);
      return { first, changed, retry };
    });
    expect(result.first).toMatchObject({
      ok: false, error: 'temporary settlement failure', outcomeKnown: false,
      retryable: false,
    });
    expect(result.changed).toMatchObject({
      ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true,
    });
    expect(result.retry.result).toMatchObject({
      ok: false, code: 'actor-tool-effect-pending', outcomeKnown: false,
    });
    expect(durableResults).toHaveLength(2);
    expect(durableResults[1]).toEqual(durableResults[0]);
  });

  test('reports an unknown result when named-domain settlement races an in-flight effect', async () => {
    let markEffectStarted!: () => void;
    let releaseEffect!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const { client, during } = clientWithRelay({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        resultStore: {
          get: async () => {
            markEffectStarted();
            await effectGate;
            return { text: 'late' };
          },
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        call: { id: 'pending-domain', name: 'read_result', args: { key: 'result-1' } },
      }, OFFSCREEN);
      const effect = client.routes['resource/read-result']({
        relayToken, executionId: prepared.executionId, key: 'result-1',
      }, OFFSCREEN);
      await effectStarted;
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId, result: { ok: true },
      }, OFFSCREEN);
      releaseEffect();
      await effect;
      return settled;
    });
    expect(result.result).toMatchObject({
      ok: false, code: 'actor-tool-effect-pending',
      outcomeKnown: false, retryable: false,
    });
  });

  test('parent settlement closes a child prepared by page program authority', async () => {
    let reads = 0;
    const { client, during } = clientWithRelay({
      pageProgramToolDescriptors: [{ name: 'read_result', primitive: 'web' }],
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        resultStore: {
          get: async () => { reads += 1; return { text: 'must not run' }; },
        },
      }),
    });
    const result = await during(async (relayToken) => {
      const parent: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'parent-page', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const child: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: parent.executionId,
        call: { id: 'child-result', name: 'read_result', args: { key: 'result-1' } },
      }, OFFSCREEN);
      const parentSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: parent.executionId, result: { ok: true },
      }, OFFSCREEN);
      const lateChildEffect = await client.routes['resource/read-result']({
        relayToken, executionId: child.executionId, key: 'result-1',
      }, OFFSCREEN);
      return { parentSettlement, lateChildEffect };
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result.parentSettlement.result).toMatchObject({
      ok: false, code: 'actor-tool-effect-pending', outcomeKnown: false,
    });
    expect(result.lateChildEffect).toMatchObject({ ok: false, outcomeKnown: true });
    expect(reads).toBe(0);
  });

  test('a durably settled page-program child unlinks before its parent settles', async () => {
    const { client, during } = clientWithRelay({
      pageProgramToolDescriptors: [{ name: 'read_result', primitive: 'web' }],
    });
    const result = await during(async (relayToken) => {
      const parent: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'parent-normal', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const child: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: parent.executionId,
        call: { id: 'child-normal', name: 'read_result', args: { key: 'result-1' } },
      }, OFFSCREEN);
      const childSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: child.executionId, result: { ok: true },
      }, OFFSCREEN);
      const parentSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: parent.executionId, result: { ok: true },
      }, OFFSCREEN);
      return { childSettlement, parentSettlement };
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result.childSettlement).toEqual({ ok: true, result: { ok: true } });
    expect(result.parentSettlement).toEqual({ ok: true, result: { ok: true } });
  });

  test('a settled irreversible child leaves sticky custody on its parent', async () => {
    const { client, during } = clientWithRelay({
      pageProgramToolDescriptors: [{ name: 'fetch_url', primitive: 'web' }],
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        webFetch: async (url: string) => ({
          status: 200, url, headers: new Headers(), text: async () => 'done',
        }),
      }),
    });
    const result = await during(async (relayToken) => {
      const parent: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'parent-sticky', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const child: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: parent.executionId,
        call: { id: 'child-sticky', name: 'fetch_url', args: {
          url: 'https://example.com/data', method: 'GET',
        } },
      }, OFFSCREEN);
      await client.routes['resource/request-web-text']({
        relayToken, executionId: child.executionId,
        url: 'https://example.com/data', method: 'GET', headers: {}, body: undefined,
      }, OFFSCREEN);
      const childSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: child.executionId, result: { ok: true },
      }, OFFSCREEN);
      const parentSettlement = await client.routes['actor/tool-settle']({
        relayToken, executionId: parent.executionId,
        result: {
          ok: false, error: 'pretend no child effect happened',
          outcomeKnown: true, retryable: true, outcomeKind: 'pre-effect-failure',
        },
      }, OFFSCREEN);
      return { childSettlement, parentSettlement };
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result.childSettlement.result).toMatchObject({
      ok: true, performed: true, effectEntered: true,
    });
    expect(result.parentSettlement.result).toMatchObject({
      ok: false, outcomeKnown: true, retryable: false,
      performed: true, effectEntered: true, outcomeKind: 'effect-completed',
    });
  });

  test('parent settlement wins an already-started nested preparation', async () => {
    let releaseChildPrepare!: () => void;
    let markChildPrepare!: () => void;
    const childPrepareStarted = new Promise<void>((resolve) => { markChildPrepare = resolve; });
    const childPrepareGate = new Promise<void>((resolve) => { releaseChildPrepare = resolve; });
    let retiredPreparations = 0;
    const { client, during } = clientWithRelay({
      pageProgramToolDescriptors: [{ name: 'read_result', primitive: 'web' }],
      prepareToolCall: async (call: any, ctx: any) => {
        if (call.name === 'read_result') {
          markChildPrepare();
          await childPrepareGate;
        }
        return { prepared: true, call, ctx, args: call.args };
      },
      settleToolCall: async (_prepared: any, execution: any) => {
        if (execution.result?.code === 'actor-tool-prepare-aborted') retiredPreparations += 1;
        return execution.result;
      },
    });
    const result = await during(async (relayToken) => {
      const parent: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'parent-race', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const child = client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: parent.executionId,
        call: { id: 'child-race', name: 'read_result', args: { key: 'result-1' } },
      }, OFFSCREEN);
      await childPrepareStarted;
      await client.routes['actor/tool-settle']({
        relayToken, executionId: parent.executionId, result: { ok: true },
      }, OFFSCREEN);
      releaseChildPrepare();
      const prepared = await child;
      await Promise.resolve();
      return prepared;
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result).toMatchObject({
      ok: false, error: 'actor/tool-prepare: parent authority retired',
    });
    expect(retiredPreparations).toBe(1);
  });

  test('run teardown joins an in-flight durable settlement without duplicating it', async () => {
    let releaseSettlement!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    let settlements = 0;
    const { client, during } = clientWithRelay({
      settleToolCall: async (_prepared: any, execution: any) => {
        settlements += 1;
        markStarted();
        await gate;
        return execution.result;
      },
    });
    const run = during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'actor',
        call: { id: 'settle-race', name: 'actor_cancel', args: { taskId: 'task-1' } },
      }, OFFSCREEN);
      const settling = client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'known failure' },
      }, OFFSCREEN);
      await started;
      return { settling };
    });
    await started;
    await Promise.resolve();
    expect(settlements).toBe(1);
    releaseSettlement();
    const result = await run;
    await expect(result.settling).resolves.toMatchObject({ ok: true });
    expect(settlements).toBe(1);
  });

  test('Stop retires provider and relay custody when durable settlement never returns', async () => {
    const controller = new AbortController();
    let leakedToken = '';
    let settlements = 0;
    let providerCloses = 0;
    let stoppedEffect: any = null;
    let cancellations = 0;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      settlementCleanupMs: 10,
      providerEgress: providerEgress({
        closeOwner: async () => { providerCloses += 1; },
      }),
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => { cancellations += 1; return { ok: true }; },
        },
      }),
      settleToolCall: async () => {
        settlements += 1;
        return new Promise(() => {});
      },
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        leakedToken = message.job.relayToken;
        const prepared: any = await client.routes['actor/tool-prepare']({
          relayToken: leakedToken, authorityClass: 'actor',
          call: { id: 'hung-settlement', name: 'actor_cancel', args: { taskId: 'task-1' } },
        }, OFFSCREEN);
        controller.abort();
        stoppedEffect = await client.routes['actor/task-cancel']({
          relayToken: leakedToken, executionId: prepared.executionId, taskId: 'task-1',
        }, OFFSCREEN);
        return { ok: false, started: true, finalText: '' };
      },
    }));
    const run = client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    const completed = await Promise.race([
      run.then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    const replay = await client.routes['actor/model-open-inference'](
      inferenceInput(leakedToken), OFFSCREEN,
    );
    expect(completed).toBe('completed');
    expect(settlements).toBe(1);
    expect(providerCloses).toBeGreaterThan(0);
    expect(stoppedEffect).toMatchObject({ ok: false, outcomeKnown: true });
    expect(cancellations).toBe(0);
    expect(replay).toEqual({
      ok: false, error: 'actor/model-open-inference: unauthorized relay',
    });
  });

  test('Stop after a completed exact effect preserves the host performed verdict', async () => {
    const controller = new AbortController();
    let spawns = 0;
    let durableResult: any = null;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 1, kind: 'actor' },
        actorAuthority: {
          spawnAsync: async () => {
            spawns += 1;
            return { taskId: 'spawned-before-stop' };
          },
        },
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        durableResult = execution.result;
        return execution.result;
      },
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        const prepared: any = await client.routes['actor/tool-prepare']({
          relayToken: message.job.relayToken, authorityClass: 'actor',
          call: { id: 'effect-before-stop', name: 'actor_create', args: {
            task: 'spawn once', sync: false, allowRecursion: false,
          } },
        }, OFFSCREEN);
        await client.routes['actor/spawn-async']({
          relayToken: message.job.relayToken, executionId: prepared.executionId,
          task: 'spawn once', allowRecursion: false,
        }, OFFSCREEN);
        controller.abort();
        return { ok: false, started: true, finalText: '' };
      },
    }));
    await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
      tools: [{ name: 'actor_create' }],
    } as any, { signal: controller.signal });
    expect(spawns).toBe(1);
    expect(durableResult).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: true, performed: true,
      retryable: false, outcomeKind: 'effect-completed',
    });
  });

  test('Stop during preparation cannot mint late direct actor authority', async () => {
    const controller = new AbortController();
    let releasePrepare!: () => void;
    let markPrepare!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { markPrepare = resolve; });
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let cancellations = 0;
    let retiredPreparations = 0;
    let observed: any = null;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          cancelTask: async () => { cancellations += 1; return { ok: true }; },
        },
      }),
      prepareToolCall: async (call: any, ctx: any) => {
        markPrepare();
        await prepareGate;
        return { prepared: true, call, ctx, args: call.args };
      },
      settleToolCall: async (_prepared: any, execution: any) => {
        if (execution.result?.code === 'actor-tool-prepare-aborted') retiredPreparations += 1;
        return execution.result;
      },
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        const relayToken = message.job.relayToken;
        const pending = client.routes['actor/tool-prepare']({
          relayToken, authorityClass: 'actor',
          call: { id: 'stop-prepare', name: 'actor_cancel', args: { taskId: 'task-1' } },
        }, OFFSCREEN);
        await prepareStarted;
        controller.abort();
        releasePrepare();
        const prepared: any = await pending;
        const effect = await client.routes['actor/task-cancel']({
          relayToken, executionId: prepared.executionId ?? 'not-minted', taskId: 'task-1',
        }, OFFSCREEN);
        observed = { prepared, effect };
        return { ok: false, started: true, finalText: '' };
      },
    }));
    await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    await Promise.resolve();
    expect(observed.prepared).toMatchObject({ ok: false, error: 'aborted' });
    expect(observed.effect).toMatchObject({ ok: false, outcomeKnown: true });
    expect(cancellations).toBe(0);
    expect(retiredPreparations).toBe(1);
  });

  test('Stop closes every pre-prepared direct actor route before it can enter', async () => {
    const controller = new AbortController();
    const effects: string[] = [];
    let observed: any = null;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorAuthority: {
          spawnSync: async () => { effects.push('spawn-sync'); },
          spawnAsync: async () => { effects.push('spawn-async'); },
          listTasks: async () => { effects.push('tasks-read'); },
          cancelTask: async () => { effects.push('task-cancel'); },
          deliverMessage: async () => { effects.push('message-deliver'); },
        },
      }),
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        const relayToken = message.job.relayToken;
        const prepare = (id: string, name: string, args: any) =>
          client.routes['actor/tool-prepare']({
            relayToken, authorityClass: 'actor', call: { id, name, args },
          }, OFFSCREEN);
        const sync: any = await prepare('stop-sync', 'actor_create', {
          task: 'sync', sync: true, allowRecursion: false,
        });
        const asyncEntry: any = await prepare('stop-async', 'actor_create', {
          task: 'async', sync: false, allowRecursion: false,
        });
        const tasks: any = await prepare('stop-tasks', 'actor_tasks', {});
        const cancel: any = await prepare('stop-cancel', 'actor_cancel', { taskId: 'task-1' });
        const deliver: any = await prepare('stop-message', 'message_actor', {
          to: 'actor-2', message: 'hello', oneShot: false, await: false,
        });
        controller.abort();
        observed = await Promise.all([
          client.routes['actor/spawn-sync']({
            relayToken, executionId: sync.executionId,
            task: 'sync', allowRecursion: false,
          }, OFFSCREEN),
          client.routes['actor/spawn-async']({
            relayToken, executionId: asyncEntry.executionId,
            task: 'async', allowRecursion: false,
          }, OFFSCREEN),
          client.routes['actor/tasks-read']({
            relayToken, executionId: tasks.executionId,
          }, OFFSCREEN),
          client.routes['actor/task-cancel']({
            relayToken, executionId: cancel.executionId, taskId: 'task-1',
          }, OFFSCREEN),
          client.routes['actor/message-deliver']({
            relayToken, executionId: deliver.executionId,
            to: 'actor-2', message: 'hello', oneShot: false,
            awaitReply: false, degradeToAsync: false, awaitCapMs: 1000,
          }, OFFSCREEN),
        ]);
        return { ok: false, started: true, finalText: '' };
      },
    }));
    await client.run({
      actorSessionId: 'actor-1', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    expect(observed).toHaveLength(5);
    for (const refusal of observed) {
      expect(refusal).toMatchObject({ ok: false, outcomeKnown: true });
    }
    expect(effects).toEqual([]);
  });

  test('retires prepared custody when post-hook arguments cannot be admitted', async () => {
    let retired = 0;
    const { client, during } = clientWithRelay({
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: { hidden: () => 'not cloneable' },
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        if (execution.result?.code === 'actor-tool-prepare-aborted') retired += 1;
        return execution.result;
      },
    });
    const result = await during((relayToken) => client.routes['actor/tool-prepare']({
      relayToken, authorityClass: 'actor',
      call: { id: 'invalid-post-hook', name: 'actor_cancel', args: { taskId: 'task-1' } },
    }, OFFSCREEN));
    await Promise.resolve();
    expect(result).toMatchObject({
      ok: false, error: 'actor/tool-prepare: semantic arguments exceed authority limits',
    });
    expect(retired).toBe(1);
  });

  test('Stop retires relay metadata even when provider cleanup never returns', async () => {
    let leakedToken = '';
    const { client, during } = clientWithRelay({
      settlementCleanupMs: 10,
      providerEgress: providerEgress({ closeOwner: async () => new Promise(() => {}) }),
    });
    const completed = await Promise.race([
      during(async (relayToken) => { leakedToken = relayToken; return null; })
        .then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    const replay = await client.routes['actor/model-open-inference'](
      inferenceInput(leakedToken), OFFSCREEN,
    );
    expect(completed).toBe('completed');
    expect(replay).toEqual({
      ok: false, error: 'actor/model-open-inference: unauthorized relay',
    });
  });

  test('enforces actor grants before semantic preparation', async () => {
    let prepared = false;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({
        kind: 'spawned', grantedTools: ['now'], parentSessionId: 'root', depth: 1,
      }) },
      restrictCtxCapabilities: (ctx: any) => ctx,
      prepareToolCall: async (call: any, ctx: any) => {
        prepared = true;
        return { prepared: true, call, ctx, args: call.args };
      },
    });
    const result = await during((relayToken) => client.routes['actor/tool-prepare']({
      relayToken,
      authorityClass: 'actor',
      call: { id: 'call-1', name: 'actor_cancel', args: { taskId: 'task-1' } },
    }, OFFSCREEN));
    expect(result).toMatchObject({ ok: false });
    expect(prepared).toBe(false);
  });

  test('admits only fixed page-program semantics under a live page_code execution', async () => {
    const contexts: any[] = [];
    const descriptors: any[] = [];
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({
        kind: 'actor', actorType: 'web', backing: 'tab', instanceId: 'tab-7',
      }) },
      ownedTabFor: () => 7,
      pageProgramToolDescriptors: [{ name: 'fetch_url', primitive: 'web' }],
      buildToolContext: async (input: any) => {
        contexts.push(input);
        return { session: { sessionId: 'actor-1', kind: 'actor' } };
      },
      prepareToolCall: async (call: any, ctx: any, descriptor: any) => {
        descriptors.push(descriptor);
        return { prepared: true, call, ctx, args: call.args };
      },
    });
    const result = await during(async (relayToken) => {
      const outer: any = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'page',
        call: { id: 'page-1', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const nested = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: outer.executionId,
        call: { id: 'nested-1', name: 'fetch_url', args: { url: 'https://example.com' } },
      }, OFFSCREEN);
      const forged = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'resource',
        pageProgramParentExecutionId: 'not-live',
        call: { id: 'nested-2', name: 'read_doc', args: {} },
      }, OFFSCREEN);
      return { outer, nested, forged };
    }, 'actor-1', {
      actorType: 'web', backing: 'tab', actorSurface: 'code',
      tools: [{ name: 'page_code', primitive: 'web' }],
    });
    expect(result.outer).toMatchObject({ ok: true, mode: 'execute', toolName: 'page_code' });
    expect(result.nested).toMatchObject({ ok: true, mode: 'execute', toolName: 'fetch_url' });
    expect(result.forged).toMatchObject({ ok: false });
    expect(contexts.at(-1)?.actorSurface).toBe('tools');
    expect(descriptors.at(-1)).toEqual({ name: 'fetch_url', primitive: 'web' });
  });

  test('bounds the exact preparation relay count', async () => {
    const { client, during } = clientWithRelay({ maxToolRelaysPerRun: 1 });
    const result = await during(async (relayToken) => {
      const call = { id: 'call-1', name: 'now', args: {} };
      const first = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'local', call,
      }, OFFSCREEN);
      const second = await client.routes['actor/tool-prepare']({
        relayToken, authorityClass: 'local', call: { ...call, id: 'call-2' },
      }, OFFSCREEN);
      return { first, second };
    });
    expect(result.first).toMatchObject({ ok: true, mode: 'execute' });
    expect(result.second).toMatchObject({
      ok: false, code: 'actor_tool_relay_limit', outcomeKnown: true,
    });
  });
});

describe('inbound actor authority', () => {
  test('advertises only the positive dweb read/moderation set', async () => {
    let sentJob: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') sentJob = message.job;
        return { ok: true, started: true, finalText: '' };
      },
    }));
    await client.run({
      actorSessionId: 'dweb', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', inbound: true, actorType: 'dweb',
      tools: [
        { name: 'dweb_peers' }, { name: 'dweb_share' }, { name: 'a2a_run' },
        { name: 'message_actor' },
      ],
    } as any);
    expect(sentJob.tools.map((tool: any) => tool.name)).toEqual(['dweb_peers']);
  });

  test('refuses exact preparation when the inbound capability is absent', async () => {
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'dweb', instanceId: 'dweb' }) },
      restrictCtxCapabilities: (ctx: any) => ctx,
    });
    const result = await during((relayToken) => client.routes['actor/tool-prepare']({
      relayToken,
      authorityClass: 'dweb',
      call: { id: 'call-1', name: 'a2a_run', args: { code: 'return 1' } },
    }, OFFSCREEN), 'dweb', {
      inbound: true, actorType: 'dweb', tools: [{ name: 'a2a_run' }],
    });
    expect(result).toMatchObject({ ok: false });
  });
});
