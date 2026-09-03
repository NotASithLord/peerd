import { describe, expect, test } from 'bun:test';
import {
  DOCUMENT_CONVERSION_PROTOCOL,
  DOCUMENT_CONVERSION_RESULT,
  convertDocumentInWorker,
} from '../../extension/offscreen/document-conversion-host.js';

const timeout = <T>(promise: Promise<T>, milliseconds = 500) => Promise.race([
  promise,
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out')), milliseconds);
  }),
]);

describe('disposable structured-document conversion worker', () => {
  test('a posted Stop preempts CPU-blocked conversion and leaves the host responsive', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => { started = resolve; });
    const createWorker = () => {
      const worker = new Worker(
        new URL('./fixtures/cpu-blocked-document-worker.js', import.meta.url),
        { type: 'module' },
      );
      worker.addEventListener('message', (event) => {
        if (event.data?.type === 'test/document-conversion-started') started();
      });
      let messageHandler: Worker['onmessage'] = null;
      worker.addEventListener('message', (event) => {
        if (event.data?.type !== 'test/document-conversion-started') {
          messageHandler?.call(worker, event);
        }
      });
      return {
        set onmessage(value: Worker['onmessage']) { messageHandler = value; },
        set onerror(value: Worker['onerror']) { worker.onerror = value; },
        set onmessageerror(value: Worker['onmessageerror']) { worker.onmessageerror = value; },
        postMessage: (...args: Parameters<Worker['postMessage']>) => worker.postMessage(...args),
        terminate: () => worker.terminate(),
      } as unknown as Worker;
    };

    const conversion = convertDocumentInWorker(
      new TextEncoder().encode('a,b\n1,2'),
      { name: 'blocked.csv', format: 'csv' },
      { signal: controller.signal, createWorker },
    );
    await timeout(workerStarted);

    let hostTicked = false;
    const hostTick = new Promise<void>((resolve) => {
      setTimeout(() => { hostTicked = true; resolve(); }, 0);
    });
    controller.abort(new DOMException('stopped', 'AbortError'));

    await expect(timeout(conversion)).rejects.toMatchObject({ name: 'AbortError' });
    await timeout(hostTick);
    expect(hostTicked).toBe(true);
  });

  test('transfers only the visible bounded byte range and terminates after settlement', async () => {
    let posted: any = null;
    let transfer: Transferable[] = [];
    let terminations = 0;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      onmessageerror: null,
      postMessage(value: any, values: Transferable[]) {
        posted = value;
        transfer = values;
        queueMicrotask(() => this.onmessage?.({ data: {
          protocol: DOCUMENT_CONVERSION_PROTOCOL,
          type: DOCUMENT_CONVERSION_RESULT,
          ok: true,
          doc: { format: 'csv', title: null, meta: {}, blocks: [], notes: [] },
        } } as MessageEvent));
      },
      terminate() { terminations += 1; },
    };
    const backing = new Uint8Array([9, 9, 97, 44, 98, 9]);
    const visible = backing.subarray(2, 5);

    await expect(convertDocumentInWorker(
      visible,
      { name: 'bounded.csv', format: 'csv' },
      { createWorker: () => worker as unknown as Worker },
    )).resolves.toMatchObject({ format: 'csv' });

    expect(posted.bytes.byteLength).toBe(visible.byteLength);
    expect(new Uint8Array(posted.bytes)).toEqual(new Uint8Array([97, 44, 98]));
    expect(transfer).toEqual([posted.bytes]);
    expect(terminations).toBe(1);
    expect(backing).toEqual(new Uint8Array([9, 9, 97, 44, 98, 9]));
  });

  test('a malformed worker reply settles immediately with host-authored detail', async () => {
    let terminations = 0;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      onmessageerror: null,
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: { forged: 'detail' } } as MessageEvent));
      },
      terminate() { terminations += 1; },
    };

    await expect(convertDocumentInWorker(
      new TextEncoder().encode('a,b\n1,2'),
      { name: 'invalid.csv', format: 'csv' },
      { createWorker: () => worker as unknown as Worker },
    )).rejects.toThrow('document conversion worker reply was invalid');
    expect(terminations).toBe(1);
  });
});
