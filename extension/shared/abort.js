// @ts-check

/** @param {AbortSignal|undefined} signal @param {string} fallback */
export const abortError = (signal, fallback) => {
  const reason = /** @type {{name?:string,message?:string}|undefined} */ (signal?.reason);
  return reason?.name === 'AbortError' && signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(reason?.message ?? fallback, 'AbortError');
};

/** @param {AbortSignal|undefined} signal @param {string} fallback */
export const throwIfAborted = (signal, fallback) => {
  if (signal?.aborted) throw abortError(signal, fallback);
};

/**
 * Start cancellation without letting a hostile/nonconforming stream delay the
 * caller's own refusal. Cleanup is observed but never owns lifecycle settlement.
 * @param {{cancel?:(reason?:unknown)=>unknown}|null|undefined} target
 * @param {unknown} [reason]
 */
export const cancelBestEffort = (target, reason) => {
  try { Promise.resolve(target?.cancel?.(reason)).catch(() => {}); }
  catch { /* cancellation is observation-only */ }
};

/**
 * Reject a blocked stream read immediately while observing late read/cancel
 * outcomes so they cannot re-enter the settled operation.
 * @param {any} reader
 * @param {AbortSignal|undefined} signal
 * @param {string} fallback
 */
export const readAbortableChunk = (reader, signal, fallback) => {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError(signal, fallback));
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {(value:any)=>void} finish @param {any} value */
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    const onAbort = () => {
      settle(reject, abortError(signal, fallback));
      cancelBestEffort(reader, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve(reader.read()).then(
      (value) => settle(resolve, value),
      (cause) => settle(reject, cause),
    );
  });
};

export class ResponseTooLargeError extends Error {
  /** @param {number} bytes @param {number} limit */
  constructor(bytes, limit) {
    super(`response too large: ${bytes} bytes (limit ${limit})`);
    this.name = 'ResponseTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** @param {Uint8Array} head @param {string} contentType */
export const responseTextDecoder = (head, contentType) => {
  // why: a BOM wins over HTTP metadata. Markup needs its own HTML parser.
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return new TextDecoder();
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be');
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le');
  const parameter = [...contentType.matchAll(/;([^;=]+)=[ \t]*(?:"((?:\\.|[^"\\])*)\\?(?:"|$)|([^;]*))/g)]
    .find(([, name, quoted, value]) => name.trim().toLowerCase() === 'charset' && (quoted !== undefined || /[^ \t\r\n]/.test(value)));
  try { return new TextDecoder(parameter?.[2]?.replace(/\\(.)/g, '$1') ?? parameter?.[3] ?? 'utf-8'); } catch { return new TextDecoder(); }
};

const readBoundedResponse = async (
  /** @type {Response|any} */ response, /** @type {number} */ limit,
  /** @type {AbortSignal|undefined} */ signal, /** @type {boolean} */ asText,
) => {
  if (signal?.aborted) {
    cancelBestEffort(response.body, signal.reason);
    throw abortError(signal, 'The response read was aborted.');
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (!asText && Number.isFinite(declared) && declared > limit) {
    cancelBestEffort(response.body);
    throw new ResponseTooLargeError(declared, limit);
  }
  if (response.body === null) {
    return asText ? { text: '', truncated: false } : new Uint8Array();
  }
  if (typeof response.body?.getReader !== 'function') {
    // why: text()/arrayBuffer() would materialize attacker-sized input before
    // the caller's cap. Real extension fetch Responses are stream-readable.
    throw new TypeError('response body is not stream-readable');
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  /** @type {TextDecoder|null} */ let decoder = null;
  let text = '';
  let total = 0;
  let truncated = false;
  try {
    // Text observes one extra decoded code unit before cancellation so an
    // exactly-sized response is not falsely reported as truncated.
    while (!truncated) {
      const { done, value } = await readAbortableChunk(
        reader, signal, 'The response read was aborted.',
      );
      if (done && !asText) break;
      let chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
      if (asText) {
        // why: the BOM can span chunks. Empty chunks do not choose the decoder.
        if (!decoder && (total || chunk.length < 3)) {
          if (chunk.length) chunks.push(chunk);
          total += chunk.length;
          chunk = new Uint8Array(total);
          let offset = 0;
          for (const part of chunks) { chunk.set(part, offset); offset += part.length; }
          if (!done && (!total || total === 1 && [0xef, 0xfe, 0xff].includes(chunk[0]) || total === 2 && chunk[0] === 0xef && chunk[1] === 0xbb)) continue;
          chunks.length = 0;
        }
        decoder ??= responseTextDecoder(chunk, response.headers?.get?.('content-type') ?? '');
        const decoded = decoder.decode(chunk, { stream: !done });
        const remaining = Math.max(0, limit - text.length);
        text += decoded.slice(0, remaining);
        truncated = decoded.length > remaining;
        if (done) break;
      } else {
        total += chunk.length;
        if (total > limit) {
          cancelBestEffort(reader);
          throw new ResponseTooLargeError(total, limit);
        }
        chunks.push(chunk);
      }
    }
    if (truncated) cancelBestEffort(reader);
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
  if (signal?.aborted) throw abortError(signal, 'The response read was aborted.');
  if (asText) return { text, truncated };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** @param {Response|any} response @param {number} limit
 * @param {{signal?:AbortSignal}} [options] */
export const readBoundedResponseBytes = (response, limit, { signal } = {}) =>
  /** @type {Promise<Uint8Array>} */ (readBoundedResponse(response, limit, signal, false));

/** @param {Response|any} response @param {number} limit
 * @param {{signal?:AbortSignal}} [options]
 * @returns {Promise<{text:string,truncated:boolean}>} */
export const readBoundedResponseText = (response, limit, { signal } = {}) =>
  /** @type {Promise<{text:string,truncated:boolean}>} */ (
    readBoundedResponse(response, limit, signal, true)
  );
