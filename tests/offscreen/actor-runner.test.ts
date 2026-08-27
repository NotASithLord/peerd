import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { abortActor, runActor } from '../../extension/offscreen/actor-runner.js';
import { ACTOR_WORKER_PROTOCOL } from '../../extension/offscreen/actor-worker-protocol.js';
import { EXECUTION_PROTOCOL } from '../../extension/shared/execution-protocol.js';
import { projectContributorSettlement } from '../../extension/peerd-runtime/controller-contributor.js';

const REALM = {
  dedicatedWorker: true,
  window: false,
  document: false,
  browser: false,
  chrome: false,
};

class FakeWorker {
  listeners = new Map<string, Array<(event: any) => void>>();
  posted: any[] = [];
  terminated = false;
  onPost: ((message: any) => void) | null = null;

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: any) {
    this.posted.push(message);
    this.onPost?.(message);
  }

  emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  terminate() { this.terminated = true; }
}

const job = {
  runId: 'run-1',
  actorSessionId: 'actor-1',
  message: 'inspect the page',
  systemPrompt: 'system',
  provider: 'anthropic',
  model: 'model',
  runtimeCapabilities: { readableHtml: { mode: 'raw' } },
};

const readyWorker = (worker: FakeWorker) => {
  queueMicrotask(() => worker.emit('message', { data: {
    type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
  } }));
  return worker as unknown as Worker;
};

const answerProbe = (worker: FakeWorker, message: any) => {
  if (message.type !== 'probe') return;
  queueMicrotask(() => worker.emit('message', { data: {
    type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
    rid: message.rid, canaryAbsent: true,
  } }));
};

describe('actor worker startup proof', () => {
  test('the worker forwards the preflight reply into the actor loop', () => {
    const source = readFileSync(
      new URL('../../extension/offscreen/actor-worker.js', import.meta.url), 'utf8',
    );
    expect(source).toContain('preflightReply: metadata.preflightReply');
  });

  test('relays tools only through prepare, exact effect, and settle', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      answerProbe(worker, message);
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'actor-tool-prepare-request', rid: 'prepare-1',
        authorityClass: 'actor',
        call: { id: 'call-1', name: 'actor_tasks', args: {} },
      } }));
      if (message.type === 'actor-tool-prepare-response') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'actor-tasks-read-request', rid: 'read-1', executionId: 'exec-1',
        } }));
      }
      if (message.type === 'actor-tasks-read-response') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'actor-tool-settle-request', rid: 'settle-1', executionId: 'exec-1',
          result: { ok: true, content: 'No async actors.' },
        } }));
      }
      if (message.type === 'actor-tool-settle-response') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: { ok: true, finalText: 'done', newMessages: [] },
        } }));
      }
    };
    const relays: string[] = [];
    const result = await runActor({ ...job, runId: 'exact-tool' }, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async (type) => {
        relays.push(type);
        if (type === 'actor/tool-prepare') return {
          ok: true, mode: 'execute', executionId: 'exec-1',
          toolName: 'actor_tasks', callId: 'call-1', args: {}, projection: {},
        };
        if (type === 'actor/tasks-read') return { ok: true, value: [] };
        if (type === 'actor/tool-settle') return {
          ok: true, result: { ok: true, content: 'No async actors.' },
        };
        return { ok: false, outcomeKnown: true };
      },
    });
    expect(relays).toEqual([
      'actor/tool-prepare', 'actor/tasks-read', 'actor/tool-settle',
    ]);
    expect(relays).not.toContain('actor/tool-dispatch');
    expect(result).toMatchObject({ ok: true, finalText: 'done', toolCalls: 1 });
  });

  test('an unknown exact-effect receipt cannot be laundered by worker success', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      answerProbe(worker, message);
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'actor-tool-prepare-request', rid: 'prepare-1',
        authorityClass: 'actor',
        call: { id: 'call-1', name: 'actor_cancel', args: { taskId: 'task-1' } },
      } }));
      if (message.type === 'actor-tool-prepare-response') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'actor-task-cancel-request', rid: 'cancel-1',
          executionId: 'exec-1', taskId: 'task-1',
        } }));
      }
      if (message.type === 'actor-task-cancel-response') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: { ok: true, finalText: 'claimed success', newMessages: [] },
        } }));
      }
    };
    const result = await runActor({ ...job, runId: 'unknown-exact-tool' }, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async (type) => {
        if (type === 'actor/tool-prepare') return {
          ok: true, mode: 'execute', executionId: 'exec-1',
          toolName: 'actor_cancel', callId: 'call-1',
          args: { taskId: 'task-1' }, projection: {},
        };
        return {
          ok: false, error: 'response lost', outcomeKnown: false, retryable: false,
        };
      },
    });
    expect(result).toMatchObject({
      ok: false, code: 'actor_tool_outcome_unknown',
      outcomeKnown: false, retryable: false, toolCalls: 1,
    });
  });

  test('posts the run only after realm proof', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      answerProbe(worker, message);
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: 'done', newMessages: [] },
      } }));
    };
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({ ok: true, started: true, finalText: 'done' });
    expect(worker.posted.map((message) => message.type)).toEqual(['probe', 'run']);
    expect(worker.posted[1]).toMatchObject({
      runtimeCapabilities: job.runtimeCapabilities,
      execution: {
        protocol: EXECUTION_PROTOCOL,
        id: 'run-1',
        program: { kind: 'agent' },
        input: 'inspect the page',
        metadata: { sessionId: 'actor-1' },
      },
    });
    expect(worker.terminated).toBe(true);
  });

  test('projects only fixed Contributor Metrics facts for a tab-Web actor', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      answerProbe(worker, message);
      if (message.type === 'run') {
        const actorResult = {
          error: 'Provider secret detail HTTP 429 should not cross the metrics boundary',
          finalText: '', stopReason: 'max_tokens',
          newMessages: [{
            role: 'assistant', error: 'Provider secret detail HTTP 429 should not cross',
            stopReason: 'max_tokens', toolUses: [{ name: 'snapshot' }],
          }],
        };
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: {
            ...actorResult,
            contributor: projectContributorSettlement(actorResult, 'anthropic', 'model'),
          },
        } }));
      }
    };
    const result = await runActor({ ...job, actorType: 'web', backing: 'tab' }, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async () => ({ ok: true }),
    });
    expect(result.contributor).toEqual({
      providerCode: 0, modelFamilyCode: 18,
      outcome: 'error', failure: 'limits', actions: ['page_action'],
    });
    expect(JSON.stringify(result.contributor)).not.toContain('secret detail');
  });

  test('never projects Contributor Metrics for API-Web or non-Web actors', async () => {
    for (const actor of [
      { actorType: 'web', backing: 'api' },
      { actorType: 'app', backing: 'tab' },
    ]) {
      const worker = new FakeWorker();
      worker.onPost = (message) => {
        answerProbe(worker, message);
        if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: {
            ok: true, finalText: 'done', newMessages: [{
              role: 'assistant', toolUses: [{ name: 'snapshot' }],
            }],
            contributor: {
              providerCode: 0, modelFamilyCode: 18,
              outcome: 'completed', failure: 'none', actions: ['page_action'],
            },
          },
        } }));
      };
      const result = await runActor({ ...job, ...actor, runId: `negative-${actor.actorType}-${actor.backing}` }, {
        workerUrl: '/worker.js', createWorker: () => readyWorker(worker),
        sendToSW: async () => ({ ok: true }),
      });
      expect(result.contributor).toBeUndefined();
    }
  });

  test('keeps provider/model classification in the dedicated semantic Worker', () => {
    const runnerSource = readFileSync(
      new URL('../../extension/offscreen/actor-runner.js', import.meta.url), 'utf8',
    );
    const workerSource = readFileSync(
      new URL('../../extension/offscreen/actor-worker.js', import.meta.url), 'utf8',
    );
    expect(runnerSource).not.toContain('controller-contributor.js');
    expect(runnerSource).toContain('parseContributorProjection');
    expect(workerSource).toContain('projectContributorSettlement');
  });

  test('refuses an invalid realm before run or relay', async () => {
    const worker = new FakeWorker();
    let relayCount = 0;
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL,
          realm: { ...REALM, browser: true },
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => { relayCount += 1; return { ok: true }; },
    });
    expect(result).toMatchObject({
      ok: false, started: false, code: 'actor_worker_protocol_error',
    });
    expect(worker.posted).toEqual([]);
    expect(relayCount).toBe(0);
  });

  test('can re-prove the boundary without starting a turn', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => answerProbe(worker, message);
    const result = await runActor({ ...job, probeOnly: true }, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async () => { throw new Error('probe must not relay'); },
    });
    expect(result).toMatchObject({
      ok: true, started: false, code: 'actor_worker_ready', realmVerified: true,
    });
    expect(worker.posted.map((message) => message.type)).toEqual(['probe']);
  });

  test('treats a pre-proof model request as a protocol failure', async () => {
    const worker = new FakeWorker();
    let relayCount = 0;
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'model-open-inference-request', rid: 'forged',
          providerId: 'anthropic', modelId: 'model', nativeBody: {},
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => { relayCount += 1; return { ok: true }; },
    });
    expect(result).toMatchObject({
      ok: false, started: false, code: 'actor_worker_protocol_error',
    });
    expect(relayCount).toBe(0);
  });

  test('reports constructor and startup timeout failures as never started', async () => {
    const spawnFailure = await runActor(job, {
      workerUrl: '/missing.js',
      createWorker: () => { throw new Error('missing worker'); },
      sendToSW: async () => ({ ok: true }),
    });
    expect(spawnFailure).toMatchObject({
      ok: false, started: false, code: 'actor_worker_spawn_failed',
    });

    const idleWorker = new FakeWorker();
    const timeout = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => idleWorker as unknown as Worker,
      startupMs: 5,
      sendToSW: async () => ({ ok: true }),
    });
    expect(timeout).toMatchObject({
      ok: false, started: false, code: 'actor_worker_start_timeout',
    });
    expect(idleWorker.terminated).toBe(true);
  });

  test('carries strict inbound state and preflight reply into the worker', async () => {
    const observed: any[] = [];
    for (const [index, inbound] of [true, 'truthy' as any].entries()) {
      const worker = new FakeWorker();
      worker.onPost = (message) => {
        answerProbe(worker, message);
        if (message.type === 'run') {
          observed.push({
            inbound: message.execution.metadata.inbound,
            preflightReply: message.execution.metadata.preflightReply,
          });
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'done', result: { finalText: 'done', toolCalls: 0 },
          } }));
        }
      };
      await runActor({
        ...job, runId: `inbound-${index}`, inbound,
        preflightReply: 'Finish signing in.',
      }, {
        workerUrl: '/worker.js',
        createWorker: () => readyWorker(worker),
        sendToSW: async () => ({ ok: true }),
      });
    }
    expect(observed).toEqual([
      { inbound: true, preflightReply: 'Finish signing in.' },
      { inbound: false, preflightReply: 'Finish signing in.' },
    ]);
  });

  test('an abort before start prevents Worker creation', async () => {
    let workersCreated = 0;
    abortActor('aw-early-stop');
    const result = await runActor({ ...job, runId: 'aw-early-stop' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        workersCreated += 1;
        return new FakeWorker() as unknown as Worker;
      },
      sendToSW: async () => ({ ok: true }),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', aborted: true,
    }));
    expect(workersCreated).toBe(0);
  });
});
