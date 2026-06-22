// @ts-check
// background/offscreen-pdf-client.js — SW-side client for PDF text extraction.
//
// The read_pdf tool runs in the SW, but pdf.js parses in a Worker that only
// the OFFSCREEN document can host (offscreen/pdf-extract.js). This client
// ensures the offscreen doc exists and dispatches the extract job. Dependencies
// are injected (ensureOffscreen + sendMessage) so it stays a pure, testable
// shell — the same shape as offscreen-js-client.js.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen   create the offscreen doc if absent
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 */
export const makeOffscreenPdfClient = ({ ensureOffscreen, sendMessage }) => ({
  /**
   * @param {{ url?: string, bytesB64?: string }} source   where to read the PDF
   * @param {{ engine?: string, dev?: boolean }} [opts]
   * @returns {Promise<{ engine: string, pages: {page:number,text:string}[], pageCount: number, info: object, scanned: boolean, ocrUsed: boolean, ocrAvailable: boolean }>}
   */
  extract: async (source, opts = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({ type: 'pdf/extract', source, opts });
    if (!reply?.ok) throw new Error(reply?.error ?? 'pdf extract failed');
    return reply.result;
  },
});
