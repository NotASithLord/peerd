// @ts-check

/**
 * Read pdf.js text streams into one aggregate-bounded page list. The bound is
 * enforced while chunks arrive, before the result can become a large pages
 * array or cross a MessagePort structured-clone boundary.
 *
 * @param {any} pdf
 * @param {{maxPages:number,maxChars:number}} limits
 * @returns {Promise<{pages:Array<{page:number,text:string}>,pageCount:number,info:object,chars:number,textCapped:boolean}>}
 */
export const extractBoundedPdfTextLayer = async (pdf, { maxPages, maxChars }) => {
  const pageCount = Number(pdf?.numPages) || 0;
  const limit = Math.min(pageCount, maxPages);
  const pages = [];
  let chars = 0;
  let textCapped = pageCount > limit;
  let aggregateLimitReached = false;

  for (let n = 1; n <= limit && !aggregateLimitReached; n += 1) {
    const page = await pdf.getPage(n);
    const reader = page.streamTextContent().getReader();
    let text = '';
    try {
      let stop = false;
      while (!stop) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const items = Array.isArray(chunk.value?.items) ? chunk.value.items : [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          const piece = `${typeof item?.str === 'string' ? item.str : ''}${item?.hasEOL ? '\n' : ''}`;
          if (!piece) continue;
          const remaining = maxChars - chars;
          if (piece.length > remaining) {
            text += piece.slice(0, Math.max(0, remaining));
            chars = maxChars;
            textCapped = true;
            aggregateLimitReached = true;
            stop = true;
            break;
          }
          text += piece;
          chars += piece.length;
          if (chars === maxChars && (index < items.length - 1 || n < pageCount)) {
            textCapped = true;
            aggregateLimitReached = true;
            stop = true;
            break;
          }
        }
      }
      if (aggregateLimitReached) await reader.cancel().catch(() => {});
    } finally {
      try { reader.releaseLock(); } catch { /* released */ }
      page.cleanup();
    }
    pages.push({ page: n, text });
  }

  const meta = await pdf.getMetadata().catch(() => null);
  return {
    pages,
    pageCount,
    info: { title: meta?.info?.Title || '', author: meta?.info?.Author || '' },
    chars,
    textCapped,
  };
};
