import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  abortActor, actorWorkerMessageFits, runActor,
} from '../../extension/offscreen/actor-runner.js';
import {
  ACTOR_REALM_FACT_KEYS,
  ACTOR_WORKER_PROTOCOL,
} from '../../extension/offscreen/actor-worker-protocol.js';
import { EXECUTION_PROTOCOL } from '../../extension/shared/execution-protocol.js';
import { projectContributorSettlement } from '../../extension/peerd-runtime/controller-contributor.js';

const REALM = {
  dedicatedWorker: true,
  ...Object.fromEntries(ACTOR_REALM_FACT_KEYS.map((key) => [key, false])),
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
    rid: message.rid, canaryAbsent: true, realm: REALM,
    prototypeFetchBlocked: true, prototypeStorageBlocked: true,
  } }));
};

describe('actor worker startup proof', () => {
  test('bounds every Worker message before it can relay to the service worker', () => {
    expect(actorWorkerMessageFits({ type: 'loop-event', event: { text: 'ok' } })).toBe(true);
    expect(actorWorkerMessageFits({
      type: 'loop-event', event: { text: 'x'.repeat(64 * 1024) },
    })).toBe(false);
    const sparse: any[] = [];
    sparse.length = 1_000_000;
    expect(actorWorkerMessageFits({ type: 'loop-event', event: sparse })).toBe(false);
    const accessor: Record<string, unknown> = { type: 'loop-event' };
    Object.defineProperty(accessor, 'event', { get: () => ({ secret: true }) });
    expect(actorWorkerMessageFits(accessor)).toBe(false);
    expect(actorWorkerMessageFits({
      type: 'loop-event', event: new Uint8Array(new SharedArrayBuffer(8)),
    })).toBe(false);
  });

  test('retires an actor that sends an invalid message without relaying it', async () => {
    const worker = new FakeWorker();
    let relayCount = 0;
    worker.onPost = (message) => {
      answerProbe(worker, message);
      if (message.type === 'run') queueMicrotask(() => {
        const sparse: any[] = [];
        sparse.length = 1_000_000;
        worker.emit('message', { data: { type: 'loop-event', event: sparse } });
      });
    };
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => readyWorker(worker),
      sendToSW: async () => { relayCount += 1; return { ok: true }; },
    });
    expect(result).toMatchObject({
      ok: false, started: true, code: 'actor_worker_protocol_error',
    });
    expect(relayCount).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  test('the worker forwards the preflight reply into the actor loop', () => {
    const source = readFileSync(
      new URL('../../extension/offscreen/actor-worker-runtime.js', import.meta.url), 'utf8',
    );
    expect(source).toContain('preflightReply: metadata.preflightReply');
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

  test('never projects Contributor Metrics for API-Web, unclassified Web, or non-Web actors', async () => {
    for (const actor of [
      { actorType: 'web', backing: 'api' },
      { actorType: 'web', backing: undefined },
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
    const runtimeSource = readFileSync(
      new URL('../../extension/offscreen/actor-worker-runtime.js', import.meta.url), 'utf8',
    );
    expect(runnerSource).not.toContain('controller-contributor.js');
    expect(runnerSource).toContain('parseContributorProjection');
    expect(workerSource).toContain('projectContributorSettlement');
    expect(runtimeSource).not.toContain('contributor');
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
