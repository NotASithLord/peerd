import { describe, expect, test } from 'bun:test';
import { createWasmerWorkerProxy, wasmerThreadPayload } from '../../../extension/engine-tabs/pod-tab/wasmer-worker-proxy.js';

const workerUrl = 'chrome-extension://peerd/vendor/wasmer/dist/browser-worker.js';

describe('Wasmer thread relay', () => {
  test('exposes an init inside the SDK dispatch envelope to admission checks', () => {
    const init = { type: 'init', sdkUrl: 'https://example.com/untrusted.js' };
    expect(wasmerThreadPayload(init)).toBe(init);
    expect(wasmerThreadPayload({ type: 'wasmer-dispatch', capiObjects: [], payload: init })).toBe(init);
  });

  test('unwraps exactly the envelope shape that the SDK unwraps', () => {
    const init = { type: 'init', sdkUrl: 'https://example.com/untrusted.js' };
    for (const envelope of [
      { type: 'wasmer-dispatch', payload: init },
      { type: 'wasmer-dispatch', capiObjects: {}, payload: init },
      { type: 'wasmer-capi-dispatch', capiObjects: [], payload: init },
    ]) {
      expect(wasmerThreadPayload(envelope)).toBe(envelope);
    }
    const inner = { type: 'wasmer-dispatch', capiObjects: [], payload: init };
    expect(wasmerThreadPayload({ type: 'wasmer-dispatch', capiObjects: [], payload: inner })).toBe(inner);
    expect(wasmerThreadPayload(null)).toBeNull();
  });

  test('refuses all worker URLs except the packaged module', () => {
    const sent: object[] = [];
    const relay = createWasmerWorkerProxy((message) => sent.push(message), workerUrl);
    for (const url of ['https://example.com/worker.js', 'blob:example', `${workerUrl}?changed`, '']) {
      expect(() => new relay.Worker(url, { type: 'module' })).toThrow('sealed SDK threads');
    }
    expect(() => new relay.Worker(workerUrl, { type: 'classic' })).toThrow('sealed SDK threads');
    expect(sent).toHaveLength(0);
  });

  test('routes by worker id and ignores replies after termination', () => {
    const sent: object[] = [];
    const relay = createWasmerWorkerProxy((message) => sent.push(message), workerUrl);
    const first = new relay.Worker(workerUrl, { type: 'module' });
    const second = new relay.Worker(workerUrl, { type: 'module' });
    const received: unknown[] = [];
    first.onmessage = (event) => received.push(event.data);
    first.postMessage({ type: 'init' });
    relay.receive({ type: 'wasmer-thread-event', id: 2, event: 'message', data: 'other thread' });
    relay.receive({ type: 'wasmer-thread-event', id: 1, event: 'message', data: 'ready' });
    first.terminate();
    first.terminate();
    first.postMessage({ type: 'task' });
    relay.receive({ type: 'wasmer-thread-event', id: 1, event: 'message', data: 'late' });
    relay.close();
    second.terminate();
    expect(received).toEqual(['ready']);
    expect(sent).toEqual([
      { type: 'wasmer-thread-create', id: 1, url: workerUrl, options: { type: 'module' } },
      { type: 'wasmer-thread-create', id: 2, url: workerUrl, options: { type: 'module' } },
      { type: 'wasmer-thread-post', id: 1, data: { type: 'init' } },
      { type: 'wasmer-thread-terminate', id: 1 },
      { type: 'wasmer-thread-terminate', id: 2 },
    ]);
  });
});
