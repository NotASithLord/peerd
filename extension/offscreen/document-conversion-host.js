// @ts-check
// Lightweight supervisor for structured-document conversion. Each operation
// gets a fresh Worker so synchronous XML/RTF/CSV parsing cannot stall the
// offscreen event loop that receives Stop and owns feature leases.

import { abortError, throwIfAborted } from '/shared/abort.js';

export const DOCUMENT_CONVERSION_PROTOCOL = 1;
export const DOCUMENT_CONVERSION_RUN = 'peerd/document-conversion/run';
export const DOCUMENT_CONVERSION_RESULT = 'peerd/document-conversion/result';
export const MAX_DOCUMENT_CONVERSION_BYTES = 40 * 1024 * 1024;
// The tool retains at most 2M rendered characters. This wider wire ceiling
// preserves structural overhead without allowing a compact archive to clone an
// unbounded object graph back onto the responsive host.
export const MAX_DOCUMENT_CONVERSION_RESULT_CHARS = 16 * 1024 * 1024;

const DOCUMENT_CONVERSION_ERRORS = new Set([
  'legacy_binary_format', 'unsupported_format', 'unreadable_container',
  'parse_failed', 'doc_extract_failed',
]);

/** @param {unknown} value */
export const documentConversionHintsAllowed = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hints = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(hints);
  if (keys.some((key) => !['name', 'contentType', 'format'].includes(key))) return false;
  return keys.every((key) => typeof hints[key] === 'string' && String(hints[key]).length <= 4096);
};

/** @param {unknown} value */
export const parseDocumentConversionRun = (value) => {
  if (!value || typeof value !== 'object') return null;
  const request = /** @type {Record<string, unknown>} */ (value);
  if (request.protocol !== DOCUMENT_CONVERSION_PROTOCOL
      || request.type !== DOCUMENT_CONVERSION_RUN
      || Object.keys(request).length !== 4
      || !(request.bytes instanceof ArrayBuffer)
      || request.bytes.byteLength > MAX_DOCUMENT_CONVERSION_BYTES
      || !documentConversionHintsAllowed(request.hints)) return null;
  return /** @type {{protocol:number,type:string,bytes:ArrayBuffer,hints:{name?:string,contentType?:string,format?:string}}} */ (request);
};

/** @param {unknown} value */
const documentShapeAllowed = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = /** @type {Record<string, unknown>} */ (value);
  return typeof doc.format === 'string'
    && (doc.title === null || typeof doc.title === 'string')
    && !!doc.meta && typeof doc.meta === 'object' && !Array.isArray(doc.meta)
    && Array.isArray(doc.blocks) && Array.isArray(doc.notes);
};

/** @param {unknown} value */
export const parseDocumentConversionResult = (value) => {
  if (!value || typeof value !== 'object') return null;
  const reply = /** @type {Record<string, unknown>} */ (value);
  if (reply.protocol !== DOCUMENT_CONVERSION_PROTOCOL
      || reply.type !== DOCUMENT_CONVERSION_RESULT
      || typeof reply.ok !== 'boolean') return null;
  if (reply.ok === true) {
    if (Object.keys(reply).length !== 4 || !documentShapeAllowed(reply.doc)) return null;
    return /** @type {{ok:true,doc:import('/peerd-runtime/doc/model.js').Document}} */ (reply);
  }
  if (Object.keys(reply).some((key) => !['protocol', 'type', 'ok', 'error', 'format'].includes(key))
      || !DOCUMENT_CONVERSION_ERRORS.has(/** @type {string} */ (reply.error))
      || (reply.format !== undefined
        && (typeof reply.format !== 'string' || reply.format.length > 64))) return null;
  return /** @type {{ok:false,error:string,format?:string}} */ (reply);
};

/** @returns {Worker} */
const createDocumentConversionWorker = () => new Worker(
  new URL('./document-conversion-worker.js', import.meta.url),
  { type: 'module', name: 'peerd-document-conversion' },
);

/**
 * @param {Uint8Array} bytes
 * @param {{name?:string,contentType?:string,format?:string}} hints
 * @param {{signal?:AbortSignal,createWorker?:()=>Worker}} [options]
 */
export const convertDocumentInWorker = (
  bytes,
  hints,
  { signal, createWorker = createDocumentConversionWorker } = {},
) => {
  throwIfAborted(signal, 'Document extraction stopped.');
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteLength > MAX_DOCUMENT_CONVERSION_BYTES
      || !documentConversionHintsAllowed(hints)) {
    return Promise.reject(new TypeError('invalid document conversion request'));
  }
  const worker = createWorker();
  // Transfer only the visible byte range. Fetch/base64 normally produce an
  // exact buffer, while callers cannot smuggle a larger backing allocation.
  const ownedBytes = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes : bytes.slice();
  let settled = false;
  /** @type {(cause?:unknown)=>void} */
  let rejectRun = () => {};
  const finish = (/** @type {()=>void} */ settle) => {
    if (settled) return false;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    settle();
    return true;
  };
  const onAbort = () => finish(() => {
    try { worker.terminate(); } catch { /* already stopped */ }
    rejectRun(abortError(signal, 'Document extraction stopped.'));
  });
  const promise = new Promise((resolve, reject) => {
    rejectRun = reject;
    worker.onmessage = (event) => {
      const reply = parseDocumentConversionResult(event.data);
      if (!reply) {
        finish(() => reject(new Error('document conversion worker reply was invalid')));
        return;
      }
      finish(() => reply.ok
        ? resolve(reply.doc)
        : resolve({ ok: false, error: reply.error, ...(reply.format ? { format: reply.format } : {}) }));
    };
    worker.onerror = (event) => finish(() => reject(
      new Error(event.message || 'document conversion worker failed'),
    ));
    worker.onmessageerror = () => finish(() => reject(
      new Error('document conversion worker reply was invalid'),
    ));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      worker.postMessage({
        protocol: DOCUMENT_CONVERSION_PROTOCOL,
        type: DOCUMENT_CONVERSION_RUN,
        bytes: ownedBytes.buffer,
        hints,
      }, [ownedBytes.buffer]);
    } catch (cause) {
      finish(() => reject(cause));
    }
  }).finally(() => { try { worker.terminate(); } catch { /* already stopped */ } });
  return promise;
};
