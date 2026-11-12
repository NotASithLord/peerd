import { describe, test, expect } from 'bun:test';
import { startActorWorker } from '../../extension/offscreen/actor-worker-runtime.js';
import { describeActorExecution } from '../../extension/offscreen/actor-runner.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

// End to end through the real actor worker runtime: a bound Pod actor is shown
// the sandbox_* verbs, its sandbox_write call reaches the SW as the canonical
// Pod write operation, and a verb its kind does not have is refused.

type ToolCall = { id: string; name: string; args?: Record<string, unknown> };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scriptedModel = (batches: ToolCall[][]) => {
  let round = 0;
  return async function* () {
    const calls = batches[round++] ?? [];
    if (calls.length === 0) {
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
      return;
    }
    for (const call of calls) {
      yield { type: 'tool-use-start', id: call.id, name: call.name };
      yield { type: 'tool-use-delta', id: call.id, partialJson: JSON.stringify(call.args ?? {}) };
      yield { type: 'tool-use-stop', id: call.id };
    }
    yield { type: 'message-stop', stopReason: 'tool_use' };
  };
};

class WorkerGlobal {
  listener: ((event: MessageEvent) => void | Promise<void>) | null = null;
  events: any[] = [];
  relayed: any[] = [];
  offeredTools: string[][] = [];
  replayedToolUses: string[][] = [];
  provider: ReturnType<typeof makeScriptedProviderAuthority>;
  grant = {
    owner: {}, signal: new AbortController().signal,
    permits: (providerId: string, modelId: string) =>
      providerId === 'anthropic' && modelId === 'claude-sonnet-4-6',
  };
  done!: (value: any) => void;
  completion = new Promise((resolve) => { this.done = resolve; });

  constructor(batches: ToolCall[][]) {
    const model = scriptedModel(batches);
    this.provider = makeScriptedProviderAuthority(() => model, (request) => {
      const body = typeof request.nativeBody === 'string' ? JSON.parse(request.nativeBody) : request.nativeBody;
      this.offeredTools.push((body?.tools ?? []).map((tool: any) => tool.name));
      this.replayedToolUses.push((body?.messages ?? []).flatMap((entry: any) => Array.isArray(entry.content)
        ? entry.content.filter((block: any) => block?.type === 'tool_use').map((block: any) => block.name) : []));
    });
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void | Promise<void>) {
    if (type === 'message') this.listener = listener;
  }

  dispatch(data: any) {
    queueMicrotask(() => { void this.listener?.({ data } as MessageEvent); });
  }

  postMessage(message: any) {
    if (message.type === 'loop-event') this.events.push(message.event);
    if (message.type === 'done' || message.type === 'error') this.done(message);
    const reply = (type: string, pending: Promise<any>) => {
      void pending.then((value) => this.dispatch({ type, rid: message.rid, reply: value }));
    };
    if (message.type === 'model-read-context-request') {
      this.dispatch({ type: 'model-read-context-response', rid: message.rid, reply: { ok: true, outcomeKnown: true, value: null } });
    } else if (message.type === 'model-open-inference-request') {
      reply('model-open-inference-response', this.provider.openInference(message, this.grant));
    } else if (message.type === 'model-read-inference-chunk-request') {
      reply('model-read-inference-chunk-response', this.provider.readInferenceChunk(message, this.grant));
    } else if (message.type === 'model-cancel-inference-request') {
      reply('model-cancel-inference-response', this.provider.cancelInference(message, this.grant));
    } else if (message.type === 'actor-call-complete-request') {
      this.dispatch({ type: 'actor-call-complete-response', rid: message.rid, reply: { ok: true, result: message.result } });
    } else if (typeof message.type === 'string' && message.type.startsWith('pod-') && message.type.endsWith('-request')) {
      this.relayed.push(message);
      const operation = message.type.slice(0, -'-request'.length);
      const authorityValue = operation === 'pod-resolve' ? 'pod-1'
        : operation === 'pod-write-file' ? 'pod-1' : null;
      this.dispatch({
        type: `${operation}-response`, rid: message.rid,
        reply: {
          ok: true, outcomeKnown: true,
          value: {
            authorityValue,
            authorityReceipt: { operation, outcome: 'performed', outcomeKnown: true, performed: true },
          },
        },
      });
    }
  }
}

const runBoundActor = async (actorType: string, toolNames: string[], batches: ToolCall[][], priorMessages: any[] = []) => {
  const projection: any = projectControllerToolSurface({ surface: 'selection', toolNames });
  const worker = new WorkerGlobal(batches);
  const previousSelf = globalThis.self;
  Object.defineProperty(globalThis, 'self', { value: worker, configurable: true });
  try {
    startActorWorker();
    worker.dispatch({
      type: 'run',
      execution: describeActorExecution({
        actorSessionId: `actor-${actorType}`, message: 'do the work',
        systemPrompt: 'PINNED', provider: 'anthropic', model: 'claude-sonnet-4-6',
        maxSteps: batches.length + 1, maxOutputTokens: 256,
        tools: projection.tools, priorMessages, recordKind: 'actor', depth: 1,
        actorType, instanceId: `${actorType}-1`,
        turnGeneration: 'sandbox-verb-generation',
      }, `sandbox-verb-run-${actorType}`),
      tools: projection.tools, programTools: [], runtimeCapabilities: null,
      semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
    });
    const done: any = await Promise.race([
      worker.completion,
      sleep(5_000).then(() => ({ type: 'error', error: 'actor runtime timed out' })),
    ]);
    return { worker, done };
  } finally {
    if (previousSelf === undefined) delete (globalThis as any).self;
    else Object.defineProperty(globalThis, 'self', { value: previousSelf, configurable: true });
  }
};

describe('sandbox verbs through the actor worker runtime', () => {
  test('a Pod actor is offered the verbs and its sandbox_write reaches the canonical Pod write', async () => {
    const { worker, done } = await runBoundActor('pod', ['pod_write', 'pod_status'], [
      [{ id: 'w1', name: 'sandbox_write', args: { path: 'notes.txt', content: 'hello' } }],
    ]);
    expect(done).toMatchObject({ type: 'done' });
    expect(worker.offeredTools[0]).toEqual(expect.arrayContaining(['sandbox_write', 'pod_status']));
    expect(worker.offeredTools[0]).not.toContain('pod_write');
    const writes = worker.relayed.filter((message) => message.type === 'pod-write-file-request');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'notes.txt', content: 'hello' });
    const results = worker.events.filter((event) => event.type === 'tool-result');
    expect(results.map((event) => event.result?.ok)).toEqual([true]);
    // Nothing leaving the worker carries the verb: events and the transcript
    // are canonical, so persistence, audit labels and the UI are unchanged.
    expect(worker.events.filter((event) => event.type === 'tool-use').map((event) => event.name))
      .toEqual(['pod_write']);
    expect(JSON.stringify(worker.events)).not.toContain('sandbox_write');
    expect(done.result.newMessages.flatMap((message: any) => (message.toolUses ?? []).map((use: any) => use.name)))
      .toEqual(['pod_write']);
  });

  test('a verb the kind does not have is refused without any relay', async () => {
    const { worker, done } = await runBoundActor('webvm', ['vm_write_file'], [
      [{ id: 'r1', name: 'sandbox_read', args: { path: '/etc/hostname' } }],
    ]);
    expect(done).toMatchObject({ type: 'done' });
    expect(worker.offeredTools[0]).toEqual(['sandbox_write']);
    expect(worker.relayed).toEqual([]);
    const results = worker.events.filter((event) => event.type === 'tool-result');
    expect(results).toHaveLength(1);
    expect(results[0].result?.ok).toBe(false);
    expect(results[0].result?.error).toBe('unknown_tool: sandbox_read is not available to this webvm actor');
  });

  test('prior turns recorded under canonical names are replayed with the verbs', async () => {
    const prior = [
      { role: 'user', content: 'earlier', id: 'u0' },
      { role: 'assistant', content: '', id: 'a0', toolUses: [{ id: 'old', name: 'pod_write', input: { path: 'a', content: 'b' } }] },
      { role: 'user', content: '', id: 'u1', toolResults: [{ tool_use_id: 'old', content: 'ok' }] },
      { role: 'assistant', content: 'wrote it', id: 'a1' },
    ];
    const { worker, done } = await runBoundActor('pod', ['pod_write'], [[]], prior);
    expect(done).toMatchObject({ type: 'done' });
    expect(worker.offeredTools[0]).toEqual(['sandbox_write']);
    expect(worker.replayedToolUses[0]).toEqual(['sandbox_write']);
  });
});
