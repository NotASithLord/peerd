// @ts-check
// background/offscreen-doc-client.js — SW-side client for document conversion.
//
// The sealed controller's read_doc tool requests this exact SW-custodied
// extraction effect; bytes are fetched and converted in the offscreen document
// (offscreen/doc-extract.js). This client ensures the offscreen document exists
// and dispatches the job. Dependencies are injected
// (ensureOffscreen + sendMessage) so it stays a pure, testable shell — the
// PDF and structured-document engines remain separate behind this exact route;
// the offscreen handler selects one only after sniffing the fetched bytes.
//
// why the error is REPACKED rather than thrown as a string: the stable code is
// the API. Parser messages may contain producer-controlled archive/PDF strings,
// so only the controller turns the code into tool-authored recovery guidance.

import { abortError } from '../shared/abort.js';

const DOCUMENT_ERROR_CODES = new Set([
  'doc_extract_aborted', 'legacy_binary_format', 'unsupported_format',
  'unreadable_container', 'parse_failed', 'fetch_failed', 'is_web_content',
  'ocr_not_installed', 'pdf_extract_failed', 'doc_extract_failed',
]);

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen   create the offscreen doc if absent
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 * @param {() => string} [deps.newRequestId]
 */
export const makeOffscreenDocClient = ({
  ensureOffscreen, sendMessage, newRequestId = () => crypto.randomUUID(),
}) => ({
  /**
   * @param {{ url?: string, bytesB64?: string, name?: string, contentType?: string }} source
   * @param {{ format?: string, engine?: string }} [opts]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ format: string, doc?: import('/peerd-runtime/doc/model.js').Document, pdf?: { engine: string, pages: {page:number,text:string}[], pageCount: number, info: object, scanned: boolean, ocrUsed: boolean, ocrAvailable: boolean, textCapped: boolean }, bytes: number, sniffedVia: string }>}
  */
  extract: async (source, opts = {}, { signal } = {}) => {
    const aborted = () => abortError(signal, 'Document extraction stopped.');
    if (signal?.aborted) throw aborted();
    await ensureOffscreen();
    if (signal?.aborted) throw aborted();

    const requestId = newRequestId();
    // Invoke before installing the abort listener. There is no await between
    // these statements, so an abort cannot overtake registration in the
    // offscreen listener and leave an unmatched early-abort tombstone.
    const extraction = Promise.resolve(sendMessage({ type: 'doc/extract', requestId, source, opts }));
    /** @type {Promise<void>|null} */
    let abortRequest = null;
    const onAbort = () => {
      abortRequest ??= Promise.resolve()
        .then(() => sendMessage({ type: 'doc/abort', requestId }))
        .then(() => undefined, () => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    let reply;
    let failure;
    try {
      reply = await extraction;
    } catch (cause) {
      failure = cause;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    // why await both: the extraction message owns the DOM-host lease. Returning
    // from a Stop race before that exact operation settles could tear down its
    // parser underneath cleanup, while returning its eventual result would let
    // stopped work re-enter the turn.
    if (abortRequest) await abortRequest;
    if (signal?.aborted) throw aborted();
    if (failure) throw failure;
    if (!reply?.ok) {
      const rawCode = typeof reply?.error === 'string' ? reply.error : '';
      const code = DOCUMENT_ERROR_CODES.has(rawCode) ? rawCode : 'doc_extract_failed';
      const error = /** @type {Error & { code?: string, detail?: string, format?: string }} */ (
        new Error('Document extraction failed.'));
      error.code = code;
      error.format = reply?.format;
      throw error;
    }
    return reply.result;
  },
});
