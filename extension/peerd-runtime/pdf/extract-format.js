// @ts-check
// PDF text assembly + model-facing formatting — PURE.
//
// The offscreen extractor (offscreen/pdf-extract.js) returns STRUCTURED page
// data: [{ page, text }], plus document info and the engine that ran. This
// module turns that into the capped plain-text body the read_pdf tool hands
// back (wrapped in <untrusted_web_content> by the tool, never here). Pure so
// the pagination + cap + header logic is unit-tested without pdf.js.

// Default output cap. PDFs can be enormous; the runner ingests this into a
// throwaway context, but it still must not blow the window. ~50k chars ≈ 12k
// tokens — generous for a document read, far below pathological. Overridable
// per call (read_pdf's maxChars arg).
export const DEFAULT_MAX_CHARS = 50_000;

/**
 * Normalize one page's extracted text: collapse runs of whitespace, trim. pdf.js
 * emits text-item fragments that the offscreen joins with spaces/newlines; this
 * just tidies the seams. Pure.
 *
 * @param {string} text
 * @returns {string}
 */
export const tidyPageText = (text) =>
  String(text ?? '')
    .replace(/[ \t ]+/g, ' ')      // horizontal runs → single space
    .replace(/ *\n */g, '\n')            // trim around newlines
    .replace(/\n{3,}/g, '\n\n')          // cap blank-line runs
    .trim();

/**
 * Assemble per-page texts into one body, each page prefixed with a
 * `[page N]` marker so the model can cite locations. Caps the total at
 * maxChars, stopping at a page boundary when possible (a half-page tail is
 * useless to cite). Pure.
 *
 * @param {Array<{ page: number, text: string }>} pages
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ body: string, charsTotal: number, charsEmitted: number, pagesEmitted: number, truncated: boolean }}
 */
export const assemblePages = (pages, { maxChars = DEFAULT_MAX_CHARS } = {}) => {
  const list = Array.isArray(pages) ? pages : [];
  const chunks = [];
  let charsTotal = 0;
  let charsEmitted = 0;
  let pagesEmitted = 0;
  let truncated = false;

  for (const p of list) {
    const tidied = tidyPageText(p?.text);
    charsTotal += tidied.length;
    if (truncated) continue;              // keep summing charsTotal, stop emitting

    const marker = `[page ${p?.page ?? pagesEmitted + 1}]`;
    const block = tidied ? `${marker}\n${tidied}` : `${marker}\n(no text on this page)`;
    const addedLen = block.length + (chunks.length ? 2 : 0); // +2 for the joiner

    if (charsEmitted + addedLen > maxChars && chunks.length > 0) {
      truncated = true;
      continue;
    }
    chunks.push(block);
    charsEmitted += addedLen;
    pagesEmitted += 1;
  }

  return {
    body: chunks.join('\n\n'),
    charsTotal,
    charsEmitted,
    pagesEmitted,
    truncated,
  };
};

/**
 * Build the final model-facing body for read_pdf. A short provenance header
 * (engine, page count, title) then the assembled page text. The tool wraps
 * the WHOLE thing in <untrusted_web_content> — do not add trust language here.
 *
 * @param {Object} args
 * @param {Array<{ page: number, text: string }>} args.pages
 * @param {string} args.engine            'pdfjs' | 'ocr'
 * @param {number} args.pageCount         total pages in the document
 * @param {{ title?: string, author?: string }} [args.info]
 * @param {boolean} [args.ocrUsed]        whether OCR actually ran
 * @param {boolean} [args.scanned]        pdf.js found ~no text layer
 * @param {boolean} [args.ocrAvailable]   is OCR installed (for the hint)
 * @param {number} [args.maxChars]
 * @returns {string}
 */
export const formatPdfBody = ({
  pages, engine, pageCount, info = {}, ocrUsed = false,
  scanned = false, ocrAvailable = false, maxChars = DEFAULT_MAX_CHARS,
}) => {
  const { body, charsTotal, pagesEmitted, truncated } = assemblePages(pages, { maxChars });

  const header = [`PDF — ${pageCount} page${pageCount === 1 ? '' : 's'}`];
  if (info.title) header.push(`title: ${info.title}`);
  if (info.author) header.push(`author: ${info.author}`);
  header.push(`engine: ${engine}${ocrUsed ? ' (OCR)' : ''}`);

  const lines = [header.join(' · ')];

  // Scanned-but-no-OCR: be explicit so the agent reports the gap rather than
  // concluding "the PDF is empty".
  if (scanned && !ocrUsed) {
    lines.push(
      ocrAvailable
        ? '[note] This PDF has little or no embedded text (likely scanned); OCR did not recover more.'
        : '[note] This PDF has little or no embedded text — it looks scanned/image-only. '
          + 'On-device OCR is available but not installed (Settings → Voice & OCR).',
    );
  }
  if (truncated) {
    lines.push(`[note] Output truncated at ~${maxChars} chars (${pagesEmitted} of ${pageCount} pages shown; ${charsTotal} chars total).`);
  }
  lines.push('', body || '(no extractable text)');
  return lines.join('\n');
};
