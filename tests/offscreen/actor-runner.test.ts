import { describe, test, expect } from 'bun:test';
import { abortActor, runActor } from '../../extension/offscreen/actor-runner.js';
import { ACTOR_WORKER_PROTOCOL } from '../../extension/offscreen/actor-worker-protocol.js';

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
};

describe('actor worker startup proof', () => {
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
    expect(relays).toEqual([]);
    expect(worker.terminated).toBe(true);
  });

  test('classifies a graceful provider failure by whether a tool request began', async () => {
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
      ok: false, started: true, toolCalls: 1, outcomeKnown: false,
    });
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
          type: 'model-request', rid: 'forged', args: {},
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
          observed.push(message.inbound);
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
