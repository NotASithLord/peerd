import { describe, test, expect } from 'bun:test';
import { abortActor, runActor } from '../../extension/offscreen/actor-runner.js';

describe('runActor — inbound provenance hop', () => {
  test('posts only a strict inbound boolean into the dedicated Worker', async () => {
    const originalWorker = globalThis.Worker;
    const posted: any[] = [];

    class FakeWorker {
      listeners = new Map<string, (event: any) => void>();

      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, listener);
      }

      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'run') {
          queueMicrotask(() => this.listeners.get('message')?.({
            data: { type: 'done', result: { finalText: 'observed', toolCalls: 0 } },
          }));
        }
      }

      terminate() {}
    }

    globalThis.Worker = FakeWorker as any;
    try {
      const base = {
        actorSessionId: 'dweb', message: 'peer bytes', systemPrompt: 's',
        provider: 'anthropic', model: 'm', actorType: 'dweb',
      };
      await runActor({ ...base, inbound: true }, {
        workerUrl: '/offscreen/actor-worker.js',
        sendToSW: async () => ({ ok: true }),
      });
      await runActor({ ...base, inbound: 'truthy-but-not-trusted' as any }, {
        workerUrl: '/offscreen/actor-worker.js',
        sendToSW: async () => ({ ok: true }),
      });
    } finally {
      globalThis.Worker = originalWorker;
    }

    const runMessages = posted.filter((message) => message.type === 'run');
    expect(runMessages.map((message) => message.inbound)).toEqual([true, false]);
  });
});

describe('runActor — Stop ordering', () => {
  test('an actor/abort arriving before actor/run prevents Worker creation', async () => {
    const originalWorker = globalThis.Worker;
    let workersCreated = 0;
    class FakeWorker {
      constructor() { workersCreated += 1; }
    }
    globalThis.Worker = FakeWorker as any;
    try {
      abortActor('aw-early-stop');
      const result = await runActor({
        runId: 'aw-early-stop', actorSessionId: 'a', message: 'm', systemPrompt: 's',
        provider: 'anthropic', model: 'm',
      }, {
        workerUrl: '/offscreen/actor-worker.js',
        sendToSW: async () => ({ ok: true }),
      });
      expect(result).toEqual(expect.objectContaining({ ok: false, started: true, aborted: true }));
      expect(workersCreated).toBe(0);
    } finally {
      globalThis.Worker = originalWorker;
    }
  });
});
