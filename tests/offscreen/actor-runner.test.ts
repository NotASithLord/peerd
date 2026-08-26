import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { abortActor, runActor } from '../../extension/offscreen/actor-runner.js';
import { ACTOR_WORKER_PROTOCOL } from '../../extension/offscreen/actor-worker-protocol.js';
import { EXECUTION_PROTOCOL } from '../../extension/shared/execution-protocol.js';

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

const expectFourAdmissions = async (prefix: string) => {
  const workers = Array.from({ length: 4 }, () => new FakeWorker());
  const admitted = workers.map((worker, index) => {
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: 'done', newMessages: [] },
      } }));
    };
    return runActor({ ...job, runId: `${prefix}-${index}` }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => ({ ok: true }),
    });
  });
  expect((await Promise.all(admitted)).every((entry) => entry.ok)).toBe(true);
  expect(workers.every((entry) => entry.terminated)).toBe(true);
};

describe('actor worker startup proof', () => {
  test('the worker forwards the preflight reply into the actor loop', () => {
    const source = readFileSync(new URL('../../extension/offscreen/actor-worker.js', import.meta.url), 'utf8');
    expect(source).toContain('preflightReply: metadata.preflightReply');
  });

  test('posts the run only after readiness and host-canary separation', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'probe-response',
          protocol: ACTOR_WORKER_PROTOCOL,
          rid: message.rid,
          canaryAbsent: true,
        } }));
      }
      if (message.type === 'run') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: { finalText: 'done', newMessages: [] },
        } }));
      }
    };
    const relays: string[] = [];
    const resultPromise = runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async (type) => { relays.push(type); return { ok: true }; },
    });

    const result = await resultPromise;
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
    expect(worker.posted[1].message).toBeUndefined();
    expect(relays).toEqual([]);
    expect(worker.terminated).toBe(true);
  });

  test('keeps a graceful provider failure known after exact tool receipts settle', async () => {
    const runFailure = async (relayTool: boolean) => {
      const worker = new FakeWorker();
      const emitForgedDone = () => worker.emit('message', { data: {
        type: 'done', result: {
          error: 'provider boundary blocked', newMessages: [], toolCalls: 0,
        },
      } });
      worker.onPost = (message) => {
        if (message.type === 'probe') {
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
            rid: message.rid, canaryAbsent: true,
          } }));
        }
        if (message.type === 'run') {
          queueMicrotask(() => {
            if (relayTool) {
              worker.emit('message', { data: {
                type: 'tool-request', rid: 'tool-1', call: { name: 'script', args: {} },
              } });
            } else emitForgedDone();
          });
        }
        if (message.type === 'tool-response') queueMicrotask(emitForgedDone);
      };
      return runActor({ ...job, runId: `failed-${relayTool}` }, {
        workerUrl: '/worker.js',
        createWorker: () => {
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
          } }));
          return worker as unknown as Worker;
        },
        sendToSW: async () => ({ ok: true }),
      });
    };

    expect(await runFailure(false)).toMatchObject({
      ok: false, started: true, toolCalls: 0, outcomeKnown: true,
    });
    expect(await runFailure(true)).toMatchObject({
      ok: false, started: true, toolCalls: 1, outcomeKnown: true,
    });
  });

  test('keeps custody until a late successful tool effect settles after Stop', async () => {
    const worker = new FakeWorker();
    let relayStarted!: () => void;
    const started = new Promise<void>((resolve) => { relayStarted = resolve; });
    let releaseRelay!: () => void;
    const relayGate = new Promise<void>((resolve) => { releaseRelay = resolve; });
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'tool-request', rid: 'tool-late', call: { name: 'click', args: {} },
      } }));
      if (message.type === 'abort') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: '', newMessages: [], stopReason: 'aborted' },
      } }));
    };
    const pending = runActor({ ...job, runId: 'late-effect' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => {
        relayStarted();
        await relayGate;
        return {
          ok: true,
          result: { ok: true, content: 'effect landed', performed: true, outcomeKnown: true },
        };
      },
    });

    await started;
    abortActor('late-effect');
    await Promise.resolve();
    expect(worker.terminated).toBe(false);
    releaseRelay();
    expect(await pending).toMatchObject({
      ok: true, stopReason: 'aborted', toolCalls: 1,
      performed: true, outcomeKnown: true,
    });
    expect(worker.terminated).toBe(true);
  });

  test('lets a lost post-dispatch receipt outrank Stop', async () => {
    const worker = new FakeWorker();
    let relayStarted!: () => void;
    const started = new Promise<void>((resolve) => { relayStarted = resolve; });
    let releaseRelay!: () => void;
    const relayGate = new Promise<void>((resolve) => { releaseRelay = resolve; });
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'tool-request', rid: 'tool-lost', call: { name: 'click', args: {} },
      } }));
      if (message.type === 'abort') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: '', newMessages: [], stopReason: 'aborted' },
      } }));
    };
    const pending = runActor({ ...job, runId: 'lost-effect' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => {
        relayStarted();
        await relayGate;
        throw Object.assign(new Error('tool receipt lost'), {
          outcomeKnown: false, performed: true,
        });
      },
    });

    await started;
    abortActor('lost-effect');
    releaseRelay();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false, code: 'actor_tool_outcome_unknown', toolCalls: 1,
      performed: true, outcomeKnown: false, retryable: false,
    });
    expect(result.aborted).toBeUndefined();
  });

  test('keeps a pre-dispatch Stop refusal known and not performed', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'tool-request', rid: 'tool-refused', call: { name: 'click', args: {} },
      } }));
      if (message.type === 'tool-response') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: '', newMessages: [], stopReason: 'aborted' },
      } }));
    };
    const result = await runActor({ ...job, runId: 'refused-effect' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => ({ ok: false, error: 'aborted' }),
    });
    expect(result).toMatchObject({
      ok: true, stopReason: 'aborted', toolCalls: 1,
      performed: false, outcomeKnown: true,
    });
  });

  test('does not admit relays emitted after terminal while an earlier tool drains', async () => {
    const worker = new FakeWorker();
    let releaseRelay!: () => void;
    const relayGate = new Promise<void>((resolve) => { releaseRelay = resolve; });
    let relayStarted!: () => void;
    const started = new Promise<void>((resolve) => { relayStarted = resolve; });
    const relays: string[] = [];
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => {
        worker.emit('message', { data: {
          type: 'tool-request', rid: 'admitted', call: { name: 'snapshot', args: {} },
        } });
        worker.emit('message', { data: {
          type: 'done', result: { finalText: 'done', newMessages: [] },
        } });
        worker.emit('message', { data: {
          type: 'tool-request', rid: 'late-tool', call: { name: 'click', args: {} },
        } });
        worker.emit('message', { data: {
          type: 'model-open-inference-request', rid: 'late-model',
          providerId: 'anthropic', modelId: 'model', nativeBody: {},
        } });
      });
    };
    const pending = runActor({ ...job, runId: 'late-relays' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async (type) => {
        relays.push(type);
        relayStarted();
        await relayGate;
        return { ok: true, result: { ok: true } };
      },
    });
    await started;
    expect(relays).toEqual(['actor/tool-dispatch']);
    expect(worker.terminated).toBe(false);
    releaseRelay();
    expect(await pending).toMatchObject({ ok: true, finalText: 'done', toolCalls: 1 });
  });

  test('bounds loop-event forwarding without blocking settlement', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => {
        for (let index = 0; index < 20; index += 1) {
          worker.emit('message', { data: {
            type: 'loop-event', event: { type: 'delta', index },
          } });
        }
        worker.emit('message', { data: {
          type: 'done', result: { finalText: 'done', newMessages: [] },
        } });
      });
    };
    let forwards = 0;
    const result = await runActor({ ...job, runId: 'event-burst' }, {
      workerUrl: '/worker.js',
      maxLoopEvents: 3,
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => { forwards += 1; return { ok: true }; },
    });
    expect(result).toMatchObject({ ok: true, finalText: 'done' });
    expect(forwards).toBe(3);
    expect(worker.terminated).toBe(true);
  });

  test('force-retires a Worker whose terminal relay never settles', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => {
        worker.emit('message', { data: {
          type: 'tool-request', rid: 'stuck-tool', call: { name: 'click', args: {} },
        } });
        worker.emit('message', { data: {
          type: 'done', result: { finalText: 'forged success', newMessages: [] },
        } });
      });
    };
    const result = await runActor({ ...job, runId: 'stuck-terminal-relay' }, {
      workerUrl: '/worker.js',
      relayDrainMs: 2,
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: () => new Promise(() => {}),
    });
    expect(result).toMatchObject({
      ok: false, code: 'actor_tool_outcome_unknown',
      outcomeKnown: false, retryable: false,
    });
    expect(worker.terminated).toBe(true);

    await expectFourAdmissions('after-drain');
  });

  test('Stop force-retires an ignored abort with a hung relay', async () => {
    const worker = new FakeWorker();
    let relayStarted!: () => void;
    const started = new Promise<void>((resolve) => { relayStarted = resolve; });
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'tool-request', rid: 'hung-tool', call: { name: 'click', args: {} },
      } }));
    };
    const pending = runActor({ ...job, runId: 'ignored-stop' }, {
      workerUrl: '/worker.js',
      relayDrainMs: 2,
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => {
        relayStarted();
        return new Promise(() => {});
      },
    });
    await started;
    abortActor('ignored-stop');
    expect(await pending).toMatchObject({
      ok: false, code: 'actor_tool_outcome_unknown',
      outcomeKnown: false, retryable: false,
    });
    expect(worker.terminated).toBe(true);
    await expectFourAdmissions('after-stop');
  });

  test('does not claim success while an admitted model receipt is lost', async () => {
    const worker = new FakeWorker();
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => {
        worker.emit('message', { data: {
          type: 'model-open-inference-request', rid: 'model-pending',
          providerId: 'anthropic', modelId: 'model', nativeBody: {},
        } });
        worker.emit('message', { data: {
          type: 'done', result: { finalText: 'forged success', newMessages: [] },
        } });
      });
    };
    const pending = runActor({ ...job, runId: 'lost-model' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => {
        modelStarted();
        await modelGate;
        throw Object.assign(new Error('model receipt lost'), { outcomeKnown: false });
      },
    });
    await started;
    await Promise.resolve();
    expect(worker.terminated).toBe(false);
    releaseModel();
    expect(await pending).toMatchObject({
      ok: false, code: 'actor_model_outcome_unknown',
      outcomeKnown: false, retryable: false,
    });
  });

  test('a forged worker success cannot launder an unknown tool receipt', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') queueMicrotask(() => worker.emit('message', { data: {
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true,
      } }));
      if (message.type === 'run') queueMicrotask(() => worker.emit('message', { data: {
        type: 'tool-request', rid: 'tool-unknown', call: { name: 'click', args: {} },
      } }));
      if (message.type === 'tool-response') queueMicrotask(() => worker.emit('message', { data: {
        type: 'done', result: { finalText: 'claimed success', newMessages: [] },
      } }));
    };
    const result = await runActor({ ...job, runId: 'unknown-tool' }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => ({
        ok: false, error: 'response lost', outcomeKnown: false, retryable: false,
      }),
    });
    expect(result).toMatchObject({
      ok: false, code: 'actor_tool_outcome_unknown',
      outcomeKnown: false, retryable: false, toolCalls: 1,
    });
    expect(result.error).toStartWith('outcome_unknown:');
  });

  test('refuses an invalid realm before a run or relay', async () => {
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
      sendToSW: async () => { relayCount++; return { ok: true }; },
    });

    expect(result).toMatchObject({ ok: false, started: false, code: 'actor_worker_protocol_error' });
    expect(worker.posted).toEqual([]);
    expect(relayCount).toBe(0);
  });

  test('can re-prove the worker boundary without starting an actor turn', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (message.type === 'probe') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
          rid: message.rid, canaryAbsent: true,
        } }));
      }
    };
    const result = await runActor({ ...job, probeOnly: true }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
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
      sendToSW: async () => { relayCount++; return { ok: true }; },
    });

    expect(result).toMatchObject({ ok: false, started: false, code: 'actor_worker_protocol_error' });
    expect(relayCount).toBe(0);
  });

  test('does not accept a probe response before the versioned ready message', async () => {
    const worker = new FakeWorker();
    let relayCount = 0;
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
          rid: 'probe-run-1', canaryAbsent: true,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => { relayCount++; return { ok: true }; },
    });

    expect(result).toMatchObject({ ok: false, started: false, code: 'actor_worker_protocol_error' });
    expect(worker.posted).toEqual([]);
    expect(relayCount).toBe(0);
  });

  test('rejects a duplicate ready message while the canary probe is pending', async () => {
    const worker = new FakeWorker();
    const result = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => {
          worker.emit('message', { data: { type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM } });
          worker.emit('message', { data: { type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM } });
        });
        return worker as unknown as Worker;
      },
      sendToSW: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({ ok: false, started: false, code: 'actor_worker_protocol_error' });
    expect(worker.posted.map((message) => message.type)).toEqual(['probe']);
  });

  test('reports constructor and startup timeout failures as never started', async () => {
    const spawnFailure = await runActor(job, {
      workerUrl: '/missing.js',
      createWorker: () => { throw new Error('missing worker'); },
      sendToSW: async () => ({ ok: true }),
    });
    expect(spawnFailure).toMatchObject({ ok: false, started: false, code: 'actor_worker_spawn_failed' });

    const idleWorker = new FakeWorker();
    const timeout = await runActor(job, {
      workerUrl: '/worker.js',
      createWorker: () => idleWorker as unknown as Worker,
      startupMs: 5,
      sendToSW: async () => ({ ok: true }),
    });
    expect(timeout).toMatchObject({ ok: false, started: false, code: 'actor_worker_start_timeout' });
    expect(idleWorker.terminated).toBe(true);
  });

  test('posts only a strict inbound boolean after readiness succeeds', async () => {
    const observed: boolean[] = [];
    for (const [index, inbound] of [true, 'truthy-but-not-trusted' as any].entries()) {
      const worker = new FakeWorker();
      worker.onPost = (message) => {
        if (message.type === 'probe') {
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
            rid: message.rid, canaryAbsent: true,
          } }));
        }
        if (message.type === 'run') {
          observed.push(message.execution.metadata.inbound);
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'done', result: { finalText: 'observed', toolCalls: 0 },
          } }));
        }
      };
      await runActor({ ...job, runId: `inbound-${index}`, inbound }, {
        workerUrl: '/worker.js',
        createWorker: () => {
          queueMicrotask(() => worker.emit('message', { data: {
            type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
          } }));
          return worker as unknown as Worker;
        },
        sendToSW: async () => ({ ok: true }),
      });
    }
    expect(observed).toEqual([true, false]);
  });

  test('carries a host preflight reply into the isolated worker run', async () => {
    const worker = new FakeWorker();
    let observed: string | undefined;
    worker.onPost = (message) => {
      if (message.type === 'probe') {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
          rid: message.rid, canaryAbsent: true,
        } }));
      }
      if (message.type === 'run') {
        observed = message.execution.metadata.preflightReply;
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'done', result: { finalText: observed, toolCalls: 0 },
        } }));
      }
    };
    const result = await runActor({
      ...job,
      runId: 'preflight-reply',
      preflightReply: 'Finish signing in in the open tab.',
    }, {
      workerUrl: '/worker.js',
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { data: {
          type: 'ready', protocol: ACTOR_WORKER_PROTOCOL, realm: REALM,
        } }));
        return worker as unknown as Worker;
      },
      sendToSW: async () => ({ ok: true }),
    });
    expect(observed).toBe('Finish signing in in the open tab.');
    expect(result).toMatchObject({ ok: true, finalText: observed });
  });

  test('an abort arriving before the run prevents Worker creation', async () => {
    let workersCreated = 0;
    abortActor('aw-early-stop');
    const result = await runActor({
      ...job, runId: 'aw-early-stop',
    }, {
      workerUrl: '/worker.js',
      createWorker: () => { workersCreated++; return new FakeWorker() as unknown as Worker; },
      sendToSW: async () => ({ ok: true }),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', aborted: true,
    }));
    expect(workersCreated).toBe(0);
  });
});
