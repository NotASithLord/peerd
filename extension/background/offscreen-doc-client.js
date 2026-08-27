// @ts-check
// background/offscreen-doc-client.js — SW-side client for document conversion.
//
// The read_doc tool runs in the SW; the bytes are fetched and converted in the
// offscreen document (offscreen/doc-extract.js). This client ensures the
// offscreen doc exists and dispatches the job. Dependencies are injected
// (ensureOffscreen + sendMessage) so it stays a pure, testable shell — the
// PDF and structured-document engines remain separate behind this exact route;
// the offscreen handler selects one only after sniffing the fetched bytes.
//
// why the error is REPACKED rather than thrown as a string: the conversion's
// failures are the interesting part of its API (a legacy .doc, a PDF behind a
// document link, an encrypted archive) and each has a different next move. The
// tool turns `code` into that sentence, so the code must survive the hop.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen   create the offscreen doc if absent
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 */
export const makeOffscreenDocClient = ({ ensureOffscreen, sendMessage }) => ({
  /**
   * @param {{ url?: string, bytesB64?: string, name?: string, contentType?: string }} source
   * @param {{ format?: string, engine?: string }} [opts]
   * @returns {Promise<{ format: string, doc?: import('/peerd-runtime/doc/model.js').Document, pdf?: { engine: string, pages: {page:number,text:string}[], pageCount: number, info: object, scanned: boolean, ocrUsed: boolean, ocrAvailable: boolean, textCapped: boolean }, bytes: number, sniffedVia: string }>}
   */
  extract: async (source, opts = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({ type: 'doc/extract', source, opts });
    if (!reply?.ok) {
      const error = /** @type {Error & { code?: string, detail?: string, format?: string }} */ (
        new Error(reply?.detail ?? reply?.error ?? 'document conversion failed'));
      error.code = reply?.error ?? 'doc_extract_failed';
      error.format = reply?.format;
      throw error;
    }
    return reply.result;
  },
});
