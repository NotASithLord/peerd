import { describe, expect, test } from 'bun:test';
import { opfsHelpers } from '../../extension/peerd-engine/opfs.js';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('opfsHelpers — abortable mutation commit points', () => {
  test('an abort during writable IO aborts the stream and never closes it', async () => {
    const write = deferred<void>();
    const started = deferred<void>();
    let abortCalls = 0;
    let closeCalls = 0;
    const writable = {
      write: () => { started.resolve(); return write.promise; },
      close: async () => { closeCalls += 1; },
      abort: async () => {
        abortCalls += 1;
        write.reject(new DOMException('aborted', 'AbortError'));
      },
    };
    const file = { createWritable: async () => writable };
    const leafDir = { getFileHandle: async () => file };
    const root = { getDirectoryHandle: async () => leafDir };
    const opfs = opfsHelpers(['root'], {
      getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
    });
    const controller = new AbortController();
    const pending = opfs.write('file.txt', 'replacement', { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortCalls).toBeGreaterThan(0);
    expect(closeCalls).toBe(0);
  });

  test('an abort while resolving a delete path refuses removeEntry', async () => {
    const child = deferred<FileSystemDirectoryHandle>();
    let removes = 0;
    const leafDir = { removeEntry: async () => { removes += 1; } };
    const mounted = {
      getDirectoryHandle: async () => child.promise,
    };
    const root = {
      getDirectoryHandle: async () => mounted,
    };
    const opfs = opfsHelpers(['root'], {
      getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
    });
    const controller = new AbortController();
    const pending = opfs.delete('nested/file.txt', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    child.resolve(leafDir as unknown as FileSystemDirectoryHandle);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removes).toBe(0);
  });
});
