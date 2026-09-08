// @ts-check
// background/offscreen-web-client.js — SW-side client for HTML → markdown
// extraction (fetch_url's clean-content path).
//
// fetch_url runs in the SW, but Readability/Turndown need a DOM Document that
// only the OFFSCREEN document can build (offscreen/web-extract.js). This
// client ensures the offscreen doc exists and dispatches the extraction.
// Dependencies are injected (ensureOffscreen + sendMessage) so it stays a
// pure, testable shell, with the same shape as the document client.

// Cap what crosses runtime.sendMessage: a multi-MB page is structured-cloned
// into the offscreen doc, and article content virtually always lives in the
// document's head. The extractor holds a second wall (MAX_HTML_CHARS there).
const MAX_SEND_CHARS = 2_000_000;

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen   create the offscreen doc if absent
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 */
export const makeOffscreenWebClient = ({ ensureOffscreen, sendMessage }) => ({
  /**
   * @param {{ html: string, url?: string }} source   the fetched page
   * @returns {Promise<{ readerable: boolean, markdown?: string, title?: string | null, byline?: string | null, htmlTruncated: boolean }>}
   */
  extractMarkdown: async ({ html, url }) => {
    await ensureOffscreen();
    const clipped = typeof html === 'string' && html.length > MAX_SEND_CHARS ? html.slice(0, MAX_SEND_CHARS) : html;
    const reply = await sendMessage({ type: 'web/extract', html: clipped, url });
    if (!reply?.ok) throw new Error(reply?.error ?? 'web extract failed');
    return reply.result;
  },
});
