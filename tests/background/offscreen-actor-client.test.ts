import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
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
