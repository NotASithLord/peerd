import { describe, expect, test } from 'bun:test';
import {
  readBoundedResponseBytes, ResponseTooLargeError,
} from '../../extension/offscreen/bounded-response.js';

const response = (chunks: Uint8Array[], declared: string | null = null) => {
  let index = 0;
  let cancelled = false;
  return {
    headers: { get: () => declared },
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
      cancel: async () => { cancelled = true; },
    },
    cancelled: () => cancelled,
  };
};

describe('bounded offscreen response reader', () => {
  test('assembles streaming chunks within the limit', async () => {
    const source = response([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(await readBoundedResponseBytes(source, 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(source.cancelled()).toBe(false);
  });

  test('cancels as soon as streamed bytes cross the limit', async () => {
    const source = response([new Uint8Array(4), new Uint8Array(4)]);
    await expect(readBoundedResponseBytes(source, 6)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(source.cancelled()).toBe(true);
  });

  test('refuses an oversized declared body before reading a chunk', async () => {
    const source = response([new Uint8Array(1)], '100');
    await expect(readBoundedResponseBytes(source, 10)).rejects.toMatchObject({ bytes: 100, limit: 10 });
    expect(source.cancelled()).toBe(true);
  });
});
