// @ts-check

import {
  abortError, cancelBestEffort, readAbortableChunk, throwIfAborted,
} from '/shared/abort.js';

export class ResponseTooLargeError extends Error {
  /** @param {number} bytes @param {number} limit */
  constructor(bytes, limit) {
    super(`response too large: ${bytes} bytes (limit ${limit})`);
    this.name = 'ResponseTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Read a fetch response without first materializing an unbounded ArrayBuffer.
 * Chunks and the final contiguous buffer are both bounded by the same ceiling.
 *
 * @param {Response|any} response
 * @param {number} limit
 * @param {{signal?:AbortSignal}} [options]
 */
export const readBoundedResponseBytes = async (response, limit, { signal } = {}) => {
  throwIfAborted(signal, 'The response read was aborted.');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    cancelBestEffort(response.body);
    throw new ResponseTooLargeError(declared, limit);
  }
  if (response.body === null) return new Uint8Array();
  if (typeof response.body?.getReader !== 'function') {
    // why: arrayBuffer() would materialize attacker-sized input before the
    // post-read check. Real extension fetch Responses are stream-readable;
    // an exotic/nonconforming response fails closed instead.
    throw new TypeError('response body is not stream-readable');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readAbortableChunk(
        reader, signal, 'The response read was aborted.',
      );
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
      total += chunk.length;
      if (total > limit) {
        cancelBestEffort(reader);
        throw new ResponseTooLargeError(total, limit);
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
  if (signal?.aborted) throw abortError(signal, 'The response read was aborted.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};
