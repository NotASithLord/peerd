// @ts-check

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
 */
export const readBoundedResponseBytes = async (response, limit) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel?.(); } catch { /* best-effort */ }
    throw new ResponseTooLargeError(declared, limit);
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new ResponseTooLargeError(bytes.length, limit);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
      total += chunk.length;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new ResponseTooLargeError(total, limit);
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};
