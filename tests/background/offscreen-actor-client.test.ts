import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
import { makeOffscreenActorChannelClient } from '../../extension/background/offscreen-actor-channel-client.js';
import { bindActorChannel } from '../../extension/offscreen/actor-channel-host.js';
import { DWEB_INBOUND_TOOL_NAMES } from '../../extension/peerd-runtime/actor/capability-manifest.js';
import { nestedActorProgramCallId } from '../../extension/shared/actor-channel-protocol.js';
import { createReadOnlyOperationGrant } from '../../extension/background/controller-turn-authority-scope.js';

const OFFSCREEN = { id: 'ext', url: 'chrome-extension://ext/offscreen/offscreen.html' };
const ENGINE_TAB = { id: 'ext', url: 'chrome-extension://ext/engine-tabs/vm-tab/vm-tab.html' };
const durableMessages = (...callIds: string[]) => [{
  role: 'assistant', content: '',
  toolUses: callIds.map((id) => ({ id, name: 'fixture_tool', input: {} })),
}, {
  role: 'user', content: '',
  toolResults: callIds.map((tool_use_id) => ({
    tool_use_id, content: 'semantic result', is_error: false,
  })),
}];

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
  sessions: { get: async () => ({
    kind: 'actor', sessionId: 'actor-1', actorType: 'webvm', instanceId: 'vm-1',
  }) },
  buildToolContext: async () => ({ session: { sessionId: 'actor-1', kind: 'actor' } }),
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
        actorType: 'webvm',
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
  test('keeps the actor operation grant live while exposing no mutation surface', () => {
    const membership = new Set(['turn.execution.run-script']);
    const grant = createReadOnlyOperationGrant(membership);
    expect(grant instanceof Set).toBe(true);
    expect(grant.has('turn.execution.run-script')).toBe(true);
    expect((grant as any).add).toBeUndefined();
    expect((grant as any).delete).toBeUndefined();
    expect((grant as any).clear).toBeUndefined();
    expect(() => Set.prototype.add.call(grant, 'turn.actor.message')).toThrow();
    expect(membership.has('turn.actor.message')).toBe(false);
    membership.delete('turn.execution.run-script');
    expect(grant.has('turn.execution.run-script')).toBe(false);
  });

  test('cannot widen actor authority by mutating the projected job after admission', async () => {
    const spawned = {
      kind: 'spawned', sessionId: 'actor-grant-child', parentSessionId: 'chat-root',
      spawnedTrusted: true,
      grantedOperations: ['turn.execution.run-script', 'turn.actor.message'],
    };
    const executionOptions: any[] = [];
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async (id: string) => id === spawned.sessionId
        ? structuredClone(spawned)
        : id === 'chat-root' ? { kind: 'chat', sessionId: 'chat-root' } : null },
      buildToolContext: async () => ({
        session: { sessionId: spawned.sessionId, kind: 'spawned', depth: 1 },
        messageActor: async () => ({ ok: true }),
        jsOffscreenClient: {
          execHeadless: async (_code: string, options: any) => {
            executionOptions.push(options);
            return { value: null, durationMs: 1, error: null };
          },
        },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        job.allowedOperations.push('turn.actor.message');
        const callId = 'actor-grant-script';
        const effect = await relay('execution/run-script', {
          operation: 'turn.execution.run-script', callId,
          effectId: `${callId}:1`, effectSequence: 1,
          turnGeneration: job.turnGeneration,
          code: 'return actors;', actors: true, provider: false,
          workspace: false, timeoutMs: null,
        });
        const completion = await relay('actor/call-complete', {
          callId, turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'done' },
        });
        return { effect, completion, newMessages: durableMessages(callId) };
      },
    }));
    const allowedOperations = ['turn.execution.run-script'];
    const result: any = await client.run({
      actorSessionId: spawned.sessionId, message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', tools: [{ name: 'script' }],
      allowedOperations,
    } as any);
    expect(result.effect).toMatchObject({ ok: true });
    expect(allowedOperations).toContain('turn.actor.message');
    expect(executionOptions[0]?.actors).toBeUndefined();
    expect(executionOptions[0]?.caps).toEqual({ subagent: false });
  });

  test.each([
    'api.example.test',
    'https://api.example.test/path',
    'HTTPS://API.EXAMPLE.TEST',
    'http://localhost',
    'https://api.example.test@evil.test',
  ])('refuses a corrupted noncanonical API actor identity before opening any host edge: %s', async (instanceId) => {
    let hostStarts = 0;
    let contexts = 0;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({
        kind: 'actor', sessionId: 'api-actor', actorType: 'web', backing: 'api', instanceId,
      }) },
      ensureOffscreen: async () => { hostStarts += 1; },
      buildToolContext: async () => { contexts += 1; return {}; },
    }));
    const result = await client.run({
      actorSessionId: 'api-actor', actorType: 'web', backing: 'api', instanceId,
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      tools: [{ name: 'fetch_url' }],
      allowedOperations: ['turn.resource.request-web-text', 'turn.site-client.run'],
    } as any);
    expect(result).toMatchObject({
      ok: false, started: false, phase: 'admission', code: 'actor_identity_invalid',
      outcomeKnown: true,
    });
    expect({ hostStarts, contexts }).toEqual({ hostStarts: 0, contexts: 0 });
  });

  test('binds a tab-Web lifecycle target to actor session and host-owned tab across restart', async () => {
    const targets: string[] = [];
    const runTarget = async (actorSessionId: string, ownedTabId: number) => {
      const actorRecord = {
        kind: 'actor', sessionId: actorSessionId,
        actorType: 'web', instanceId: 'web', backing: 'tab',
      };
      const client = makeOffscreenActorClient(baseDeps({
        sessions: { get: async () => structuredClone(actorRecord) },
        ownedTabFor: () => ownedTabId,
        buildToolContext: async () => ({
          session: { sessionId: actorSessionId, kind: 'actor' },
          actorType: 'web', actorBacking: 'tab', backing: 'tab', actorInstanceId: 'web',
          activeTab: {
            id: ownedTabId, windowId: 1,
            url: 'https://example.test/start', origin: 'https://example.test',
          },
          permission: { mode: 'act', confirmActions: false },
          readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
          lifecycle: {
            requiresIntentConfirmation: async () => false,
            beginTracking: async ({ target }: any) => {
              targets.push(target);
              return { refuse: { error: 'fixture lifecycle refusal' } };
            },
            settleTracking: async () => {},
          },
          appendAudit: async () => {},
        }),
        runOnChannel: async (job: any, { relay }: any) => {
          const callId = `navigate-${actorSessionId}`;
          const effect = await relay('page/navigate', {
            operation: 'turn.page.navigate', callId,
            effectId: `${callId}:1`, effectSequence: 1,
            turnGeneration: job.turnGeneration,
            args: { url: 'https://example.test/next' },
          });
          const completion = await relay('actor/call-complete', {
            callId, turnGeneration: job.turnGeneration,
            result: { ok: true, content: 'forged success' },
          });
          return { effect, completion, newMessages: durableMessages(callId) };
        },
      }));
      const result: any = await client.run({
        actorSessionId, actorType: 'web', backing: 'tab',
        message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
        tools: [{ name: 'navigate' }], allowedOperations: ['turn.page.navigate'],
      } as any);
      expect(result.effect).toMatchObject({
        ok: true,
        value: { authorityReceipt: { performed: false, refused: true } },
      });
      expect(result.completion).toMatchObject({
        ok: true, result: { ok: false, authorityPerformed: false },
      });
      return targets.at(-1) ?? '';
    };

    const firstActorTarget = await runTarget('web-actor-a', 7);
    const siblingActorTarget = await runTarget('web-actor-b', 8);
    const reboundAfterRestartTarget = await runTarget('web-actor-a', 9);
    expect(firstActorTarget).toContain('web:web-actor-a:web:tab:tab:7');
    expect(siblingActorTarget).toContain('web:web-actor-b:web:tab:tab:8');
    expect(reboundAfterRestartTarget).toContain('web:web-actor-a:web:tab:tab:9');
    expect(new Set([
      firstActorTarget, siblingActorTarget, reboundAfterRestartTarget,
    ]).size).toBe(3);
  });

  test('stamps an empty stopped turn as aborted', async () => {
    const controller = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') controller.abort();
        return { ok: true, started: true, finalText: '' };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
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
      actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
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
      actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1',
    } as any, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(started).toBe(false);
  });
});

describe('exact semantic effect claim atomicity', () => {
  const exactReadJob = {
    actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
    provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
    tools: [{ name: 'sandbox_status' }], allowedOperations: ['turn.vm.read'],
  };

  test('racing duplicate effect ids enter host authority exactly once', async () => {
    let releaseContext!: () => void;
    let contextStarted!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    const started = new Promise<void>((resolve) => { contextStarted = resolve; });
    let reads = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => {
        contextStarted();
        await contextGate;
        return {
          session: { sessionId: 'actor-1', kind: 'actor' },
          actorType: 'webvm', actorInstanceId: 'vm-1',
          vmRegistry: { get: async () => {
            reads += 1;
            return { id: 'vm-1', name: 'one', pinned: false };
          } },
        };
      },
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = {
          operation: 'turn.vm.read', callId: 'duplicate-call',
          effectId: 'duplicate-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, vmId: 'vm-1',
        };
        const first = relay('vm/read', effect);
        await started;
        const duplicate = relay('vm/read', { ...effect });
        releaseContext();
        const replies = await Promise.all([first, duplicate]);
        const complete = await relay('actor/call-complete', {
          callId: 'duplicate-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'worker result' },
        });
        return { replies, complete, newMessages: durableMessages('duplicate-call') };
      },
    }));
    const result: any = await client.run(exactReadJob as any);
    expect(result.replies.filter((reply: any) => reply.ok === true)).toHaveLength(1);
    expect(result.replies.filter((reply: any) => reply.ok === false)).toHaveLength(1);
    expect(result.complete).toMatchObject({ ok: true, result: { ok: true } });
    expect(reads).toBe(1);
  });

  test('call completion closes and drains a claim paused in context lookup', async () => {
    let releaseContext!: () => void;
    let contextStarted!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    const started = new Promise<void>((resolve) => { contextStarted = resolve; });
    let reads = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => {
        contextStarted();
        await contextGate;
        return {
          session: { sessionId: 'actor-1', kind: 'actor' },
          actorType: 'webvm', actorInstanceId: 'vm-1',
          vmRegistry: { get: async () => { reads += 1; return { id: 'vm-1' }; } },
        };
      },
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = relay('vm/read', {
          operation: 'turn.vm.read', callId: 'closing-call',
          effectId: 'closing-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, vmId: 'vm-1',
        });
        await started;
        const completion = relay('actor/call-complete', {
          callId: 'closing-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged success' },
        });
        releaseContext();
        return {
          effect: await effect, completion: await completion,
          newMessages: durableMessages('closing-call'),
        };
      },
    }));
    const result: any = await client.run(exactReadJob as any);
    expect(result.effect).toMatchObject({ ok: false, outcomeKnown: true });
    expect(result.completion).toMatchObject({
      ok: true,
      result: { ok: false, code: 'authority_claim_refused', authorityPerformed: false },
    });
    expect(reads).toBe(0);
  });

  test('worker return cannot outrun an admitted irreversible exact effect', async () => {
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    let writes = 0;
    let runSettled = false;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => {
          writes += 1;
          writeStarted();
          await writeGate;
          return true;
        } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        void relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'early-worker-return',
          effectId: 'early-worker-return:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, path: '/tmp/result', content: 'written',
        });
        await started;
        return {
          ok: true, finalText: 'forged clean completion',
          newMessages: [{ role: 'user', toolResults: [{
            tool_use_id: 'early-worker-return', content: 'forged clean', is_error: false,
          }] }],
        };
      },
    }));
    const pending = client.run({
      ...exactReadJob, tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any).then((value) => { runSettled = true; return value; });
    await started;
    await Promise.resolve();
    expect(runSettled).toBe(false);
    releaseWrite();
    const result: any = await pending;
    expect(writes).toBe(1);
    expect(result).toMatchObject({
      ok: false, code: 'actor_semantic_completion_missing',
      outcomeKnown: false, retryable: false, authorityPerformed: true,
      finalText: '', newMessages: [],
    });
  });

  test('Stop settles an abort-ignoring actor host operation unknown', async () => {
    const controller = new AbortController();
    let hostStarted!: () => void;
    const started = new Promise<void>((resolve) => { hostStarted = resolve; });
    const neverSettles = new Promise<void>(() => {});
    let writes = 0;
    let effectReply: any;
    let completionReply: any;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => {
          writes += 1;
          hostStarted();
          await neverSettles;
        } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        effectReply = await relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'hung-actor-write',
          effectId: 'hung-actor-write:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, path: '/tmp/result', content: 'written',
        });
        completionReply = await relay('actor/call-complete', {
          callId: 'hung-actor-write', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged clean completion' },
        });
        return { newMessages: durableMessages('hung-actor-write') };
      },
    }));
    const pending = client.run({
      ...exactReadJob, tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any, { signal: controller.signal });
    await started;
    controller.abort();
    const result: any = await pending;
    expect(writes).toBe(1);
    expect(effectReply).toMatchObject({
      ok: false, outcomeKnown: false, retryable: false,
      authorityReceipt: { performed: false, outcomeKnown: false, retryable: false },
    });
    expect(completionReply).toMatchObject({
      ok: false, error: 'actor/call-complete: authority retired',
      outcomeKnown: false, retryable: false,
    });
    expect(result).toMatchObject({
      ok: false, code: 'actor_semantic_completion_missing',
      outcomeKnown: false, retryable: false, authorityPerformed: false,
    });
  });

  test('worker cannot omit a completed receipt-bearing call from its durable transcript', async () => {
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => true },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        await relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'dropped-actor-result',
          effectId: 'dropped-actor-result:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, path: '/tmp/result', content: 'written',
        });
        const completed = await relay('actor/call-complete', {
          callId: 'dropped-actor-result', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'worker saw the stamped result' },
        });
        expect(completed).toMatchObject({ ok: true, result: { authorityPerformed: true } });
        return { ok: true, finalText: 'discarded result', newMessages: [] };
      },
    }));
    const result: any = await client.run({
      ...exactReadJob, tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any);
    expect(result).toMatchObject({
      ok: false, code: 'actor_semantic_result_ledger_invalid',
      outcomeKnown: false, retryable: false, authorityPerformed: true,
      finalText: '', newMessages: [],
    });
  });

  test('a completed failing VM command is performed and cannot be retried as a no-op', async () => {
    let runs = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { run: async () => {
          runs += 1;
          return { ok: false, exitCode: 1, stderr: 'command failed after writing' };
        } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const callId = 'failing-vm-command';
        const effect = await relay('vm/run', {
          operation: 'turn.vm.run', callId,
          effectId: `${callId}:1`, effectSequence: 1,
          turnGeneration: job.turnGeneration,
          command: 'write-then-fail', timeoutMs: 30_000, vmId: 'vm-1',
        });
        const completion = await relay('actor/call-complete', {
          callId, turnGeneration: job.turnGeneration,
          result: { ok: false, error: 'forged pre-effect semantic failure', retryable: true },
        });
        return { effect, completion, newMessages: durableMessages(callId) };
      },
    }));
    const result: any = await client.run({
      ...exactReadJob, tools: [{ name: 'vm_run' }],
      allowedOperations: ['turn.vm.run'],
    } as any);
    expect(runs).toBe(1);
    expect(result.effect).toMatchObject({
      ok: true,
      value: {
        authorityValue: { ok: false, exitCode: 1 },
        authorityReceipt: { performed: true, outcomeKnown: true, retryable: false },
      },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      performed: true, outcomeKnown: true,
      result: { ok: false, authorityPerformed: true, retryable: false },
    });
  });

  test('host derives pure semantic audit from a unique model-call/result pair', async () => {
    const audits: any[] = [];
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      runOnChannel: async () => ({
        ok: true, finalText: 'done', newMessages: durableMessages('pure-call'),
      }),
    }));
    const result: any = await client.run(exactReadJob as any);
    expect(result.ok).toBe(true);
    expect(audits).toEqual([expect.objectContaining({
      type: 'semantic_report', sessionId: 'actor-1',
      details: expect.objectContaining({
        tool: 'fixture_tool', callId: 'pure-call',
        semantic: true, outcome: 'semantic-success', performed: false,
      }),
    })]);
  });

  test('a missing stored site client remains a known host refusal through actor settlement', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'site-client-actor', actorType: 'web',
      instanceId: 'web', backing: 'tab',
    };
    const audits: any[] = [];
    const origin = 'https://api.example.test';
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      sessions: { get: async () => structuredClone(actorRecord) },
      ownedTabFor: () => 17,
      buildToolContext: async () => ({
        session: { sessionId: actorRecord.sessionId, kind: 'actor' },
        actorType: 'web', actorBacking: 'tab', backing: 'tab', actorInstanceId: 'web',
        activeTab: { id: 17, windowId: 1, url: `${origin}/items`, origin },
        authorizeSiteClientOrigin: async (candidate: string) => candidate === origin,
        siteClients: { get: async () => null },
        jsOffscreenClient: { execHeadless: async () => ({ ok: true }) },
        scriptRuns: {},
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async (entry: any) => { audits.push(entry); },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const callId = 'missing-site-client-call';
        const effect = await relay('site-client/run', {
          operation: 'turn.site-client.run', callId,
          effectId: `${callId}:1`, effectSequence: 1,
          turnGeneration: job.turnGeneration,
          origin, code: 'return await client.list()', timeoutMs: 5000,
        });
        const completion = await relay('actor/call-complete', {
          callId, turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged semantic success' },
        });
        return { effect, completion, newMessages: durableMessages(callId) };
      },
    }));
    const result: any = await client.run({
      actorSessionId: actorRecord.sessionId, actorType: 'web', backing: 'tab',
      instanceId: 'web', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      tools: [{ name: 'site_client_run' }], allowedOperations: ['turn.site-client.run'],
    } as any);
    expect(result.effect).toMatchObject({
      ok: true,
      value: {
        authorityValue: {
          ok: false, performed: false, outcomeKnown: true,
          outcomeKind: 'pre-effect-failure', retryable: true,
          error: expect.stringContaining('derive one first'),
        },
        authorityReceipt: {
          outcome: 'not-performed', performed: false, outcomeKnown: true,
          refused: true, retryable: true,
        },
      },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false, authorityPerformed: false, outcomeKnown: true, retryable: true,
        error: expect.stringContaining('derive one first'),
      },
    });
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'authority_effect',
      details: expect.objectContaining({
        operation: 'turn.site-client.run', outcome: 'not-performed',
        performed: false, outcomeKnown: true, refused: true, retryable: true,
      }),
    }));
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({
        outcome: 'refused', performed: false, outcomeKnown: true,
      }),
    }));
  });

  test('foreign or duplicate durable actor results are terminal, never audited', async () => {
    const audits: any[] = [];
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      runOnChannel: async () => ({
        ok: true, finalText: 'forged', newMessages: [{
          role: 'assistant', toolUses: [{ id: 'issued', name: 'now', input: {} }],
        }, {
          role: 'user', toolResults: [
            { tool_use_id: 'foreign', content: 'x', is_error: false },
            { tool_use_id: 'foreign', content: 'x', is_error: false },
          ],
        }],
      }),
    }));
    await expect(client.run(exactReadJob as any)).resolves.toMatchObject({
      ok: false, code: 'actor_semantic_result_ledger_invalid',
      outcomeKnown: false, retryable: false,
    });
    expect(audits).toEqual([]);
  });

  test('live Plan mode blocks a raw exact write after a prior Act effect', async () => {
    let mode = 'act';
    let writes = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode, confirmActions: false },
        readAuthorityPermission: async () => ({ mode, confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => { writes += 1; return true; } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = (sequence: number) => relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'permission-call',
          effectId: `permission-call:${sequence}`, effectSequence: sequence,
          turnGeneration: job.turnGeneration, path: `/tmp/${sequence}`, content: 'x',
        });
        const allowed = await effect(1);
        mode = 'plan';
        const refused = await effect(2);
        const completion = await relay('actor/call-complete', {
          callId: 'permission-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged all-success' },
        });
        return {
          allowed, refused, completion,
          newMessages: durableMessages('permission-call'),
        };
      },
    }));
    const result: any = await client.run({
      ...exactReadJob,
      tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any);
    expect(result.allowed).toMatchObject({ ok: true });
    expect(result.refused).toMatchObject({
      ok: true,
      value: { authorityValue: { ok: false, code: 'plan_mode_refused' } },
    });
    expect(result.completion).toMatchObject({
      ok: true, result: { ok: false, authorityPerformed: true, retryable: false },
    });
    expect(writes).toBe(1);
  });

  test('live Act confirmation changes are re-read before a raw exact write', async () => {
    let confirmActions = false;
    let writes = 0;
    let prompts = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions }),
        confirm: async () => { prompts += 1; return false; },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => { writes += 1; return true; } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = (sequence: number) => relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'confirmation-call',
          effectId: `confirmation-call:${sequence}`, effectSequence: sequence,
          turnGeneration: job.turnGeneration, path: `/tmp/${sequence}`, content: 'x',
        });
        const auto = await effect(1);
        confirmActions = true;
        const declined = await effect(2);
        const completion = await relay('actor/call-complete', {
          callId: 'confirmation-call', turnGeneration: job.turnGeneration,
          result: { ok: false, error: 'declined', retryable: false },
        });
        return {
          auto, declined, completion,
          newMessages: durableMessages('confirmation-call'),
        };
      },
    }));
    const result: any = await client.run({
      ...exactReadJob,
      tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any);
    expect(result.auto).toMatchObject({ ok: true });
    expect(result.declined).toMatchObject({
      ok: true,
      value: { authorityValue: { ok: false, error: 'declined', retryable: false } },
    });
    expect({ writes, prompts }).toEqual({ writes: 1, prompts: 1 });
  });

  test('a declined self-confirmation overrides forged semantic success', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'api-actor', actorType: 'web',
      instanceId: 'https://api.example.test', backing: 'api',
    };
    let prompts = 0;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: 'api-actor', kind: 'actor' },
        actorType: 'web', backing: 'api', actorInstanceId: 'https://api.example.test',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        confirm: async () => { prompts += 1; return false; },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const declined = await relay('resource/confirm-web-write', {
          operation: 'turn.resource.confirm-web-write', callId: 'confirm-call',
          effectId: 'confirm-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration,
          url: 'https://api.example.test/write', method: 'POST', headers: {}, body: 'x',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'confirm-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged success after denial' },
        });
        return {
          declined, completion, newMessages: durableMessages('confirm-call'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'api-actor', actorType: 'web', backing: 'api',
      instanceId: 'https://api.example.test',
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      maxOutputTokens: 4096, tools: [{ name: 'fetch_url' }],
      allowedOperations: ['turn.resource.confirm-web-write'],
    } as any);
    expect(result.declined).toMatchObject({
      ok: true,
      value: {
        authorityValue: false,
        authorityReceipt: {
          outcome: 'not-performed', performed: false, refused: true,
          code: 'confirmation_declined', retryable: false,
        },
      },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false, code: 'confirmation_declined',
        authorityPerformed: false, retryable: false,
      },
    });
    expect(prompts).toBe(1);
  });

  test('an accepted claim without a host receipt settles unknown despite forged success', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'app-actor', actorType: 'app', instanceId: 'app-1',
    };
    let actions = 0;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: 'app-actor', kind: 'actor' },
        actorType: 'app', actorInstanceId: 'app-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        appClient: { act: async () => { actions += 1; return { ok: true }; } },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const shared = { value: 1 };
        const effect = await relay('app/act', {
          operation: 'turn.app.act', callId: 'missing-receipt-call',
          effectId: 'missing-receipt-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration,
          action: 'move', params: { first: shared, second: shared },
        });
        const completion = await relay('actor/call-complete', {
          callId: 'missing-receipt-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged success without host receipt' },
        });
        return {
          ok: true, effect, completion,
          newMessages: durableMessages('missing-receipt-call'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'app-actor', actorType: 'app', instanceId: 'app-1',
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      maxOutputTokens: 4096, tools: [{ name: 'app_act' }],
      allowedOperations: ['turn.app.act'],
    } as any);
    expect(actions).toBe(0);
    expect(result.effect).toMatchObject({
      ok: false, error: 'turn.app.act: authority arguments are invalid',
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false,
        outcomeKnown: false, retryable: false,
        authorityReceipts: [{ code: 'authority_receipt_missing' }],
      },
    });
    expect(result).toMatchObject({
      ok: false, code: 'actor_authority_outcome_unknown',
      outcomeKnown: false, retryable: false,
    });
  });

  for (const change of ['plan', 'confirm'] as const) {
    test(`a queued exact write rechecks live ${change} policy at the physical edge`, async () => {
      let mode = 'act';
      let confirmActions = false;
      let writes = 0;
      let trackingCount = 0;
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      let secondTracked!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      const secondPrepared = new Promise<void>((resolve) => { secondTracked = resolve; });
      const client = makeOffscreenActorClient(baseDeps({
        buildToolContext: async () => ({
          session: { sessionId: 'actor-1', kind: 'actor' },
          actorType: 'webvm', actorInstanceId: 'vm-1',
          permission: { mode: 'act', confirmActions: false },
          readAuthorityPermission: async () => ({ mode, confirmActions }),
          confirm: async () => false,
          lifecycle: {
            requiresIntentConfirmation: async () => false,
            beginTracking: async () => {
              trackingCount += 1;
              if (trackingCount === 2) secondTracked();
              return { handle: {} };
            },
            settleTracking: async () => {},
          },
          appendAudit: async () => {},
          vm: {
            writeFile: async () => {
              writes += 1;
              if (writes === 1) {
                firstEntered();
                await firstGate;
              }
              return true;
            },
          },
        }),
        runOnChannel: async (job: any, { relay }: any) => {
          const effect = (sequence: number) => relay('vm/write-text-file', {
            operation: 'turn.vm.write-text-file', callId: 'queued-policy-call',
            effectId: `queued-policy-call:${sequence}`, effectSequence: sequence,
            turnGeneration: job.turnGeneration, path: `/tmp/${sequence}`, content: 'x',
          });
          const first = effect(1);
          await firstStarted;
          const second = effect(2);
          await secondPrepared;
          if (change === 'plan') mode = 'plan';
          else confirmActions = true;
          releaseFirst();
          const results = { first: await first, second: await second };
          const completion = await relay('actor/call-complete', {
            callId: 'queued-policy-call', turnGeneration: job.turnGeneration,
            result: { ok: false, error: 'policy changed', retryable: false },
          });
          return {
            ...results, completion,
            newMessages: durableMessages('queued-policy-call'),
          };
        },
      }));
      const result: any = await client.run({
        ...exactReadJob,
        tools: [{ name: 'vm_write_file' }],
        allowedOperations: ['turn.vm.write-text-file'],
      } as any);
      expect(result.first).toMatchObject({ ok: true });
      expect(result.second).toMatchObject({ ok: false, outcomeKnown: true });
      expect(writes).toBe(1);
    });
  }

  test('nested page-program completion does not wait on its active parent call', async () => {
    const listeners = new Set<(tabId: number, change: any) => void>();
    let currentUrl = 'https://www.wikipedia.org/';
    let channelRelay: any = null;
    let currentParentEffect = '';
    let nestedCompleted = false;
    let confirmations = 0;
    const spilled: any[] = [];
    const tabs = {
      get: async () => ({ id: 7, windowId: 1, url: currentUrl }),
      update: async (tabId: number, update: { url: string }) => {
        currentUrl = update.url;
        queueMicrotask(() => {
          for (const listener of listeners) listener(tabId, { url: update.url });
          for (const listener of listeners) listener(tabId, { status: 'complete' });
        });
        return { id: tabId, url: update.url };
      },
      onUpdated: {
        addListener: (listener: any) => listeners.add(listener),
        removeListener: (listener: any) => listeners.delete(listener),
      },
    };
    const actorRecord = {
      kind: 'actor', sessionId: 'web-actor', actorType: 'web',
      instanceId: 'web', backing: 'tab',
    };
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      ownedTabFor: () => 7,
      buildToolContext: async () => ({
        session: { sessionId: 'web-actor', kind: 'actor' },
        actorType: 'web', actorBacking: 'tab', backing: 'tab', actorInstanceId: 'web',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        activeTab: { id: 7, windowId: 1, url: currentUrl, origin: new URL(currentUrl).origin },
        tabs, denylist: [],
        scripting: {
          executeScript: async ({ target, args }: any) => target.documentIds && args
            ? [{
                documentId: `document:${currentUrl}`,
                result: { ok: true, clicked: true, tag: 'BUTTON', text: 'Continue', matchedCount: 1 },
              }]
            : target.documentIds
              ? [{ documentId: `document:${currentUrl}`, result: { has: false, capped: false } }]
              : [{
                  documentId: `document:${currentUrl}`,
                  result: {
                    origin: new URL(currentUrl).origin, href: currentUrl, timeOrigin: 1,
                  },
                }],
        },
        ensureBrowserNetworkGuard: async () => ({ ok: true }),
        armBrowserChildQuarantine: async () => ({ ok: true }),
        updateBrowserNetworkGuardOrigin: async () => ({ ok: true }),
        judgeLanding: async () => ({ action: 'continue' }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        confirm: async () => { confirmations += 1; return true; },
        webFetch: async (url: string) => ({
          status: 200, url,
          headers: { forEach: (fn: (value: string, name: string) => void) => fn('text/html', 'content-type') },
          text: async () => '<main><h1>Nested result</h1></main>',
        }),
        webOffscreenClient: {
          extractMarkdown: async () => ({ readerable: true, markdown: '# Nested result' }),
        },
        resultStore: {
          key: () => 'result:nested',
          put: async (record: any) => { spilled.push(record); },
        },
        scriptRuns: {
          mintRunId: () => 'page-program-run', register: () => {}, release: () => {},
        },
        jsOffscreenClient: {
          execHeadless: async () => {
            const nestedPageCall = nestedActorProgramCallId(
              'aw-1-1', currentParentEffect, 'page-semantic-1',
            );
            const nested = await channelRelay('page/navigate', {
              operation: 'turn.page.navigate', callId: nestedPageCall,
              effectId: `${nestedPageCall}:1`, effectSequence: 1,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              args: { url: 'https://www.wikipedia.org/wiki/Test' },
            });
            expect(nested).toMatchObject({ ok: true });
            const completion = await channelRelay('actor/call-complete', {
              callId: nestedPageCall, turnGeneration: 'aw-1-1:1',
              result: { ok: true, content: 'nested complete' },
            });
            expect(completion).toMatchObject({ ok: true, result: { ok: true } });
            const nestedClickCall = nestedActorProgramCallId(
              'aw-1-1', currentParentEffect, 'page-semantic-2',
            );
            const clicked = await channelRelay('page/click', {
              operation: 'turn.page.click', callId: nestedClickCall,
              effectId: `${nestedClickCall}:1`, effectSequence: 1,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              args: { selector: '#continue' },
            });
            expect(clicked).toMatchObject({
              ok: true,
              value: { authorityValue: { ok: true } },
            });
            const clickedCompletion = await channelRelay('actor/call-complete', {
              callId: nestedClickCall, turnGeneration: 'aw-1-1:1',
              result: { ok: true, content: 'nested click complete' },
            });
            expect(clickedCompletion).toMatchObject({ ok: true, result: { ok: true } });
            const webRequest = {
              url: 'https://www.wikipedia.org/api/save', method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}',
            };
            const nestedFetchCall = nestedActorProgramCallId(
              'aw-1-1', currentParentEffect, 'page-semantic-3',
            );
            const confirmed = await channelRelay('resource/confirm-web-write', {
              operation: 'turn.resource.confirm-web-write', callId: nestedFetchCall,
              effectId: `${nestedFetchCall}:1`, effectSequence: 1,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              ...webRequest,
            });
            expect(confirmed).toMatchObject({ ok: true, value: { authorityValue: true } });
            const fetched = await channelRelay('resource/request-web-text', {
              operation: 'turn.resource.request-web-text', callId: nestedFetchCall,
              effectId: `${nestedFetchCall}:2`, effectSequence: 2,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              ...webRequest,
            });
            expect(fetched).toMatchObject({ ok: true });
            const extracted = await channelRelay('resource/extract-markdown', {
              operation: 'turn.resource.extract-markdown', callId: nestedFetchCall,
              effectId: `${nestedFetchCall}:3`, effectSequence: 3,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              html: '<main><h1>Nested result</h1></main>', url: webRequest.url,
            });
            expect(extracted).toMatchObject({ ok: true });
            const spill = await channelRelay('resource/spill-result', {
              operation: 'turn.resource.spill-result', callId: nestedFetchCall,
              effectId: `${nestedFetchCall}:4`, effectSequence: 4,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              url: webRequest.url, format: 'markdown', text: '# Nested result',
              producer: 'fetch_url', fenced: true,
              originLabel: 'https://www.wikipedia.org',
            });
            expect(spill).toMatchObject({ ok: true, value: { authorityValue: 'result:nested' } });
            const fetchCompletion = await channelRelay('actor/call-complete', {
              callId: nestedFetchCall, turnGeneration: 'aw-1-1:1',
              result: { ok: true, content: 'nested fetch complete' },
            });
            expect(fetchCompletion).toMatchObject({ ok: true, result: { ok: true } });
            nestedCompleted = true;
            return { ok: true, content: 'program complete' };
          },
        },
      }),
      now: () => 1,
      runOnChannel: async (job: any, { relay }: any) => {
        channelRelay = relay;
        const reply: any[] = [];
        const completion: any[] = [];
        for (const suffix of ['a', 'b']) {
          const callId = `outer-page-call-${suffix}`;
          currentParentEffect = `${callId}:1`;
          const outer = relay('page/run-program', {
            operation: 'turn.page.run-program', callId,
            effectId: currentParentEffect, effectSequence: 1,
            turnGeneration: job.turnGeneration,
            args: { code: 'await page.goto("https://www.wikipedia.org/wiki/Test")' },
            pageProgramSemanticToken: `page-token-${suffix}`,
          });
          reply.push(await Promise.race([
            outer,
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 100)),
          ]));
          completion.push(await relay('actor/call-complete', {
            callId, turnGeneration: job.turnGeneration,
            result: { ok: true, content: 'outer complete' },
          }));
        }
        return {
          reply, completion,
          newMessages: durableMessages('outer-page-call-a', 'outer-page-call-b'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'web-actor', actorType: 'web', backing: 'tab', actorSurface: 'code',
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      maxOutputTokens: 4096, tools: [{ name: 'page_code' }],
      allowedOperations: ['turn.page.run-program'],
      programTools: [{ name: 'navigate' }, { name: 'click' }, { name: 'fetch_url' }],
      programOperations: [
        'turn.page.navigate', 'turn.page.click',
        'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
        'turn.resource.extract-markdown', 'turn.resource.spill-result',
      ],
    } as any);
    expect(result.reply).toHaveLength(2);
    expect(result.reply.every((entry: any) => entry.ok === true
      && entry.timeout === undefined)).toBe(true);
    expect(result.completion).toHaveLength(2);
    expect(result.completion.every((entry: any) => entry.ok === true
      && entry.result?.ok === true)).toBe(true);
    expect({ nestedCompleted, currentUrl }).toEqual({
      nestedCompleted: true, currentUrl: 'https://www.wikipedia.org/wiki/Test',
    });
    expect(confirmations).toBe(2);
    expect(spilled).toHaveLength(2);
  });

  test('nested app program observe and act use the exact parent-bound authority path', async () => {
    let channelRelay: any = null;
    let currentParentEffect = '';
    const hostCalls: any[] = [];
    const actorRecord = {
      kind: 'actor', sessionId: 'app-actor', actorType: 'app',
      instanceId: 'app-1', actorSurface: 'code',
    };
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: 'app-actor', kind: 'actor' },
        actorType: 'app', actorInstanceId: 'app-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        appAgentCall: async (method: string, args: any) => {
          hostCalls.push({ method, args });
          return method === 'observe'
            ? { ok: true, value: { screen: 'game' } }
            : { ok: true, value: { accepted: true } };
        },
        scriptRuns: {
          mintRunId: () => 'app-program-run', register: () => {}, release: () => {},
        },
        jsOffscreenClient: {
          execHeadless: async () => {
            const observedCallId = nestedActorProgramCallId(
              'aw-1-1', currentParentEffect, 'app-semantic-1',
            );
            const observed = await channelRelay('app/observe', {
              operation: 'turn.app.observe', callId: observedCallId,
              effectId: `${observedCallId}:1`, effectSequence: 1,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
            });
            expect(observed).toMatchObject({ ok: true });
            const observedCompletion = await channelRelay('actor/call-complete', {
              callId: observedCallId, turnGeneration: 'aw-1-1:1',
              result: { ok: true, structured: { value: { screen: 'game' } } },
            });
            expect(observedCompletion).toMatchObject({ ok: true });
            const actedCallId = nestedActorProgramCallId(
              'aw-1-1', currentParentEffect, 'app-semantic-2',
            );
            const acted = await channelRelay('app/act', {
              operation: 'turn.app.act', callId: actedCallId,
              effectId: `${actedCallId}:1`, effectSequence: 1,
              turnGeneration: 'aw-1-1:1', parentCallId: currentParentEffect,
              action: 'move', params: { x: 1 },
            });
            expect(acted).toMatchObject({ ok: true });
            const actedCompletion = await channelRelay('actor/call-complete', {
              callId: actedCallId, turnGeneration: 'aw-1-1:1',
              result: { ok: true, structured: { value: { accepted: true } } },
            });
            expect(actedCompletion).toMatchObject({ ok: true });
            return { value: { screen: 'game' }, consoleOutput: [], durationMs: 1, error: null };
          },
        },
      }),
      now: () => 1,
      runOnChannel: async (job: any, { relay }: any) => {
        channelRelay = relay;
        const outer: any[] = [];
        const completion: any[] = [];
        for (const suffix of ['a', 'b']) {
          const callId = `outer-app-call-${suffix}`;
          currentParentEffect = `${callId}:1`;
          outer.push(await relay('app/run-code', {
            operation: 'turn.app.run-code', callId,
            effectId: currentParentEffect, effectSequence: 1,
            turnGeneration: job.turnGeneration,
            code: 'const before = await app.observe(); await app.act("move", {x:1}); return before;',
            timeoutMs: 5000, appProgramSemanticToken: `app-program-token-${suffix}`,
          }));
          completion.push(await relay('actor/call-complete', {
            callId, turnGeneration: job.turnGeneration,
            result: { ok: true, content: 'app program complete' },
          }));
        }
        return {
          outer, completion,
          newMessages: durableMessages('outer-app-call-a', 'outer-app-call-b'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'app-actor', actorType: 'app', instanceId: 'app-1',
      actorSurface: 'code', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      tools: [{ name: 'app_code' }], allowedOperations: ['turn.app.run-code'],
      programTools: [{ name: 'app_observe' }, { name: 'app_act' }],
      programOperations: ['turn.app.observe', 'turn.app.act'],
    } as any);
    expect(result.outer).toHaveLength(2);
    expect(result.outer.every((entry: any) => entry.ok === true)).toBe(true);
    expect(result.completion).toHaveLength(2);
    expect(result.completion.every((entry: any) => entry.ok === true
      && entry.result?.ok === true)).toBe(true);
    expect(hostCalls).toEqual([
      { method: 'observe', args: {} },
      { method: 'act', args: { action: 'move', params: { x: 1 } } },
      { method: 'observe', args: {} },
      { method: 'act', args: { action: 'move', params: { x: 1 } } },
    ]);
  });

  test('stamps a clean repository checkpoint as a known no-op', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'notebook-actor', actorType: 'notebook', instanceId: 'nb-1',
    };
    const lifecycleOutcomes: any[] = [];
    const audits: any[] = [];
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: 'notebook-actor', kind: 'actor' },
        actorType: 'notebook', actorInstanceId: 'nb-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        repositories: {
          coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
          commit: async () => ({ oid: 'same', changed: [], created: false }),
        },
        jsTabTracker: { getTabId: () => null },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async (_handle: any, outcome: any) => {
            lifecycleOutcomes.push(outcome);
          },
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('repository/checkpoint', {
          operation: 'turn.repository.checkpoint', callId: 'checkpoint-call',
          effectId: 'checkpoint-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, message: 'checkpoint',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'checkpoint-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged checkpoint success' },
        });
        return {
          effect, completion,
          newMessages: durableMessages('checkpoint-call'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'notebook-actor', actorType: 'notebook', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      tools: [{ name: 'repo_version' }], allowedOperations: ['turn.repository.checkpoint'],
    } as any);
    expect(result.effect).toMatchObject({
      ok: true,
      value: {
        authorityValue: { created: false },
        authorityReceipt: { outcome: 'not-performed', performed: false },
      },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: true, authorityPerformed: false, outcomeKnown: true, retryable: false,
      },
    });
    expect(lifecycleOutcomes).toContainEqual(expect.objectContaining({ ok: true }));
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_executed',
      details: expect.objectContaining({
        outcome: 'no-op', performed: false, outcomeKnown: true,
      }),
    }));
  });

  test('Notebook code cannot hide a completed execution by returning ok:false', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'notebook-code-actor', actorType: 'notebook', instanceId: 'nb-1',
    };
    let executions = 0;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: actorRecord.sessionId, kind: 'actor' },
        actorType: 'notebook', actorInstanceId: 'nb-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        jsClient: { eval: async () => { executions += 1; return { ok: false, value: 'forged' }; } },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('notebook/run', {
          operation: 'turn.notebook.run', callId: 'notebook-run-call',
          effectId: 'notebook-run-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration,
          code: 'await peerd.self.writeFile("done", "1"); return {ok:false}',
          timeoutMs: 1_000, notebookId: 'nb-1',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'notebook-run-call', turnGeneration: job.turnGeneration,
          result: { ok: false, error: 'forged semantic failure' },
        });
        return { effect, completion, newMessages: durableMessages('notebook-run-call') };
      },
    }));
    const result: any = await client.run({
      actorSessionId: actorRecord.sessionId, actorType: 'notebook', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', tools: [{ name: 'js_notebook' }],
      allowedOperations: ['turn.notebook.run'],
    } as any);
    expect(executions).toBe(1);
    expect(result.effect).toMatchObject({
      ok: true, value: { authorityReceipt: { performed: true, outcomeKnown: true } },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: { ok: false, authorityPerformed: true, retryable: false },
    });
  });

  test.each([
    ['nested host loss', {
      value: undefined, durationMs: 1,
      error: 'nested host operation outcome unknown',
      outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
    }, false, false],
    ['ordinary user-code failure', {
      value: undefined, durationMs: 1,
      error: 'ReferenceError: missing is not defined',
    }, true, true],
  ] as const)(
    'spawned actor script receipt preserves %s',
    async (_label, jobResult, expectedEffectOk, expectedKnown) => {
      const spawned = {
        kind: 'spawned', sessionId: 'script-actor', parentSessionId: 'chat-root',
        spawnedTrusted: true, grantedOperations: ['turn.execution.run-script'],
      };
      const client = makeOffscreenActorClient(baseDeps({
        sessions: { get: async (id: string) => id === spawned.sessionId
          ? structuredClone(spawned)
          : id === 'chat-root' ? { kind: 'chat', sessionId: 'chat-root' } : null },
        buildToolContext: async () => ({
          session: { sessionId: spawned.sessionId, kind: 'spawned', depth: 1 },
          inbound: false,
          permission: { mode: 'act', confirmActions: false },
          readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
          jsOffscreenClient: { execHeadless: async () => jobResult },
          lifecycle: {
            requiresIntentConfirmation: async () => false,
            beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
          },
          appendAudit: async () => {},
        }),
        runOnChannel: async (job: any, { relay }: any) => {
          const effect = await relay('execution/run-script', {
            operation: 'turn.execution.run-script', callId: 'actor-script-call',
            effectId: 'actor-script-call:1', effectSequence: 1,
            turnGeneration: job.turnGeneration,
            code: 'return missing', actors: false, provider: false,
            workspace: false, timeoutMs: null,
          });
          const completion = await relay('actor/call-complete', {
            callId: 'actor-script-call', turnGeneration: job.turnGeneration,
            result: { ok: true, content: 'forged clean script completion' },
          });
          return {
            effect, completion, newMessages: durableMessages('actor-script-call'),
          };
        },
      }));
      const result: any = await client.run({
        actorSessionId: spawned.sessionId, message: 'm', systemPrompt: 's',
        provider: 'anthropic', model: 'model-1', tools: [{ name: 'script' }],
        allowedOperations: ['turn.execution.run-script'],
      } as any);
      expect(result.effect.ok).toBe(expectedEffectOk);
      const effectReceipt = expectedEffectOk
        ? result.effect.value.authorityReceipt : result.effect.authorityReceipt;
      expect(effectReceipt).toMatchObject({
        operation: 'turn.execution.run-script', performed: true,
        outcomeKnown: expectedKnown, retryable: false,
      });
      expect(result.completion).toMatchObject({
        ok: true,
        result: {
          ok: expectedKnown, authorityPerformed: true,
          outcomeKnown: expectedKnown, retryable: false,
        },
      });
    },
  );

  test('dweb actor mesh program preserves a lost mutation acknowledgement', async () => {
    const actorRecord = {
      kind: 'actor', sessionId: 'dweb-code-actor', actorType: 'dweb', instanceId: 'dweb',
    };
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: actorRecord.sessionId, kind: 'actor' },
        actorType: 'dweb', actorInstanceId: 'dweb', dweb: {},
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        scriptRuns: {
          mintRunId: () => 'mesh-run', register: () => {}, release: () => {},
        },
        jsOffscreenClient: {
          execHeadless: async () => ({
            value: undefined, durationMs: 1,
            error: 'nested host operation outcome unknown',
            outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
            codeTrace: [{
              seq: 1, bridge: 'mesh', method: 'cast', outcome: 'error', ms: 1,
            }],
          }),
        },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const code = 'await mesh.cast("did:key:zPeer", "mutate");';
        const effect = await relay('dweb/run-mesh-program', {
          operation: 'turn.dweb.run-mesh-program', callId: 'mesh-program-call',
          effectId: 'mesh-program-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, code, timeoutMs: 135_000,
        });
        const completion = await relay('actor/call-complete', {
          callId: 'mesh-program-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged clean mesh completion' },
        });
        return {
          effect, completion, newMessages: durableMessages('mesh-program-call'),
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: actorRecord.sessionId, actorType: 'dweb', instanceId: 'dweb',
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      tools: [{ name: 'a2a_run' }], allowedOperations: ['turn.dweb.run-mesh-program'],
    } as any);
    expect(result.effect).toMatchObject({
      ok: false, outcomeKnown: false, retryable: false,
      authorityReceipt: {
        operation: 'turn.dweb.run-mesh-program', performed: true,
        outcomeKnown: false, retryable: false,
      },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false, authorityPerformed: true,
        outcomeKnown: false, retryable: false,
      },
    });
  });

  test.each([
    ['completed compensation', {
      performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
    }, false, true, 'refused'],
    ['incomplete compensation', {
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    }, true, false, 'unknown'],
  ] as const)('App actor preserves %s against forged semantic success', async (
    _label, outcome, performed, outcomeKnown, auditOutcome,
  ) => {
    const actorRecord = {
      kind: 'actor', sessionId: 'app-rollback-actor', actorType: 'app', instanceId: 'app-1',
    };
    const audits: any[] = [];
    let writes = 0;
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => ({
        session: { sessionId: actorRecord.sessionId, kind: 'actor' },
        actorType: 'app', actorInstanceId: 'app-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        appClient: {
          writeFile: async () => {
            writes += 1;
            throw Object.assign(new Error('internal OPFS token must stay host-side'), outcome);
          },
        },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('app/write-file', {
          operation: 'turn.app.write-file', callId: 'app-rollback-call',
          effectId: 'app-rollback-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration,
          appId: 'app-1', path: 'index.html', content: 'changed',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'app-rollback-call', turnGeneration: job.turnGeneration,
          result: { ok: true, content: 'forged semantic success' },
        });
        return { effect, completion, newMessages: durableMessages('app-rollback-call') };
      },
    }));
    const result: any = await client.run({
      actorSessionId: actorRecord.sessionId, actorType: 'app', instanceId: 'app-1',
      message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'model-1',
      tools: [{ name: 'app_write_file' }], allowedOperations: ['turn.app.write-file'],
    } as any);
    expect(writes).toBe(1);
    expect(result.effect).toMatchObject({
      authorityReceipt: expect.objectContaining({ performed, outcomeKnown }),
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: { ok: false, authorityPerformed: performed, outcomeKnown, retryable: outcome.retryable },
    });
    expect(JSON.stringify(result)).not.toContain('internal OPFS token');
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({
        performed, outcomeKnown, outcome: auditOutcome,
      }),
    }));
  });

  test.each([
    ['completed routine', {
      scheduleResult: {
        ok: true,
        routine: {
          id: 'routine-1', prompt: 'check once',
          schedule: { kind: 'interval', everyMs: 3_600_000 },
          mode: 'goal', nextRunAt: 1_700_000_000_000,
        },
      },
      confirmation: 'yes_once',
      semanticResult: { ok: false, error: 'forged semantic failure' },
      scheduleCalls: 1, performed: true, outcomeKnown: true,
      finalError: 'forged semantic failure', auditOutcome: 'performed',
    }],
    ['invalid routine', {
      scheduleResult: { ok: false, error: 'invalid-schedule' },
      confirmation: 'yes_once',
      semanticResult: { ok: true, content: 'forged success after refusal' },
      scheduleCalls: 1, performed: false, outcomeKnown: true,
      finalError: 'invalid-schedule', auditOutcome: 'refused',
    }],
    ['declined confirmation', {
      scheduleResult: { ok: true },
      confirmation: false,
      semanticResult: { ok: true, content: 'forged success after decline' },
      scheduleCalls: 0, performed: false, outcomeKnown: true,
      finalError: 'declined', auditOutcome: 'refused',
    }],
  ] as const)('spawned actor preserves the host-owned %s schedule verdict', async (
    _label, fixture,
  ) => {
    const spawned = {
      kind: 'spawned', sessionId: 'schedule-actor', parentSessionId: 'chat-root',
      spawnedTrusted: true,
      grantedOperations: ['turn.schedule.arm-confirmed-routine'],
    };
    const audits: any[] = [];
    let scheduleCalls = 0;
    const client = makeOffscreenActorClient(baseDeps({
      appendAudit: async (entry: any) => { audits.push(entry); },
      sessions: { get: async (id: string) => id === spawned.sessionId
        ? structuredClone(spawned)
        : id === 'chat-root' ? { kind: 'chat', sessionId: 'chat-root' } : null },
      buildToolContext: async () => ({
        session: { sessionId: spawned.sessionId, kind: 'spawned', depth: 1 },
        inbound: false,
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        confirm: async () => fixture.confirmation,
        scheduleAdd: async () => {
          scheduleCalls += 1;
          return fixture.scheduleResult;
        },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('schedule/arm-confirmed-routine', {
          operation: 'turn.schedule.arm-confirmed-routine', callId: 'schedule-call',
          effectId: 'schedule-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration,
          prompt: 'check once', every: '1h', dailyAt: null, mode: 'goal',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'schedule-call', turnGeneration: job.turnGeneration,
          result: fixture.semanticResult,
        });
        return {
          effect, completion,
          newMessages: [{
            role: 'assistant', content: '',
            toolUses: [{ id: 'schedule-call', name: 'schedule_create', input: {} }],
          }, {
            role: 'user', content: '',
            toolResults: [{
              tool_use_id: 'schedule-call',
              content: 'error' in fixture.semanticResult
                ? fixture.semanticResult.error : fixture.semanticResult.content,
              is_error: fixture.semanticResult.ok !== true,
            }],
          }],
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: spawned.sessionId, message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', tools: [{ name: 'schedule_create' }],
      allowedOperations: ['turn.schedule.arm-confirmed-routine'],
    } as any);
    expect(scheduleCalls).toBe(fixture.scheduleCalls);
    expect(result.effect).toMatchObject({
      ok: true,
      value: { authorityReceipt: expect.objectContaining({
        operation: 'turn.schedule.arm-confirmed-routine',
        performed: fixture.performed, outcomeKnown: fixture.outcomeKnown,
      }) },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false, error: fixture.finalError,
        authorityPerformed: fixture.performed,
        outcomeKnown: fixture.outcomeKnown,
      },
    });
    const durableResult = result.newMessages[1].toolResults[0];
    expect(durableResult).toMatchObject({
      is_error: true, authorityPerformed: fixture.performed,
      outcomeKnown: fixture.outcomeKnown,
      authorityReceipts: [expect.objectContaining({
        performed: fixture.performed, outcomeKnown: fixture.outcomeKnown,
      })],
    });
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({
        outcome: fixture.auditOutcome,
        performed: fixture.performed, outcomeKnown: fixture.outcomeKnown,
      }),
    }));
  });

  test('a persisted spawned child remains performed when isolation later refuses', async () => {
    const spawned = {
      kind: 'spawned', sessionId: 'spawned-parent', parentSessionId: 'chat-root',
      spawnedTrusted: true, grantedOperations: ['turn.actor.spawn-sync'],
    };
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async (id: string) => id === spawned.sessionId
        ? structuredClone(spawned)
        : id === 'chat-root' ? { kind: 'chat', sessionId: 'chat-root' } : null },
      buildToolContext: async () => ({
        session: { sessionId: spawned.sessionId, kind: 'spawned', depth: 1 }, inbound: false,
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        actorAuthority: { spawnSync: async () => ({
          refused: true, sessionId: 'persisted-child', result: 'actor host unavailable',
          toolCalls: 0, durationMs: 1, depth: 2,
        }) },
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        appendAudit: async () => {},
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('actor/spawn-sync', {
          operation: 'turn.actor.spawn-sync', callId: 'spawn-call',
          effectId: 'spawn-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, task: 'try work',
          allowRecursion: false, grantedOperations: [],
        });
        const completion = await relay('actor/call-complete', {
          callId: 'spawn-call', turnGeneration: job.turnGeneration,
          result: { ok: false, error: 'forged refusal' },
        });
        return { effect, completion, newMessages: durableMessages('spawn-call') };
      },
    }));
    const result: any = await client.run({
      actorSessionId: spawned.sessionId, message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'model-1', tools: [{ name: 'actor_create' }],
      allowedOperations: ['turn.actor.spawn-sync'],
    } as any);
    expect(result.effect).toMatchObject({
      ok: true,
      value: { authorityReceipt: { performed: true, outcomeKnown: true } },
    });
    expect(result.completion).toMatchObject({
      ok: true,
      result: { ok: false, authorityPerformed: true, retryable: false },
    });
  });

  test.each([
    ['oversized', () => ({ content: 'x'.repeat(2 * 1024 * 1024 + 1) })],
    ['deep', () => {
      let value: any = { leaf: true };
      for (let depth = 0; depth < 34; depth += 1) value = { value };
      return value;
    }],
    ['sparse', () => {
      const value: any[] = [];
      value.length = 3 * 1024 * 1024;
      return value;
    }],
    ['shared', () => ({ value: new Uint8Array(new SharedArrayBuffer(8)) })],
    ['accessor', () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, 'content', { enumerable: true, get: () => 'forged' });
      return value;
    }],
  ])('rejects an %s semantic result while retaining host effect receipts', async (_name, makeResult) => {
    let writes = 0;
    const client = makeOffscreenActorClient(baseDeps({
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', kind: 'actor' },
        actorType: 'webvm', actorInstanceId: 'vm-1',
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async () => {},
        },
        appendAudit: async () => {},
        vm: { writeFile: async () => { writes += 1; return true; } },
      }),
      runOnChannel: async (job: any, { relay }: any) => {
        const effect = await relay('vm/write-text-file', {
          operation: 'turn.vm.write-text-file', callId: 'bounded-result-call',
          effectId: 'bounded-result-call:1', effectSequence: 1,
          turnGeneration: job.turnGeneration, path: '/tmp/result', content: 'x',
        });
        const completion = await relay('actor/call-complete', {
          callId: 'bounded-result-call', turnGeneration: job.turnGeneration,
          result: makeResult(),
        });
        return {
          effect, completion,
          newMessages: durableMessages('bounded-result-call'),
        };
      },
    }));
    const result: any = await client.run({
      ...exactReadJob,
      tools: [{ name: 'vm_write_file' }],
      allowedOperations: ['turn.vm.write-text-file'],
    } as any);
    expect(result.effect).toMatchObject({ ok: true });
    expect(result.completion).toMatchObject({
      ok: true,
      result: {
        ok: false,
        code: 'actor_semantic_result_invalid',
        authorityPerformed: true,
        retryable: false,
      },
      performed: true,
    });
    expect(writes).toBe(1);
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
        actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
        provider: 'anthropic', model: 'model-1', maxOutputTokens: 4096,
      } as any, { signal: controller.signal }).then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    expect(completed).toBe('completed');
    expect(observed).toEqual({ ok: false, error: 'aborted' });
    expect(closes).toBeGreaterThanOrEqual(2);
  });
});
