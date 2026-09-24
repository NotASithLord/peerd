// @ts-check

/**
 * @typedef {{controller:AbortController,lease:unknown}} DocumentExtraction
 */

export const MAX_CONCURRENT_DOCUMENT_EXTRACTIONS = 4;

/**
 * @param {Map<string, DocumentExtraction>} extractions
 * @param {string} requestId
 * @param {unknown} lease
 * @returns {DocumentExtraction|null}
 */
export const beginDocumentExtraction = (extractions, requestId, lease) => {
  if (extractions.size >= MAX_CONCURRENT_DOCUMENT_EXTRACTIONS) return null;
  const entry = { controller: new AbortController(), lease };
  extractions.set(requestId, entry);
  return entry;
};

/**
 * @param {Map<string, DocumentExtraction>} extractions
 * @returns {number}
 */
export const stopDocumentExtractions = (extractions) => {
  const pending = [...extractions.values()];
  // why clear first: an abort continuation may settle synchronously, but no
  // revoked extraction may still look current once DOM-host teardown begins.
  extractions.clear();
  for (const entry of pending) {
    entry.controller.abort(new DOMException('Document extraction stopped.', 'AbortError'));
  }
  return pending.length;
};

/**
 * @param {Object} input
 * @param {(message:any, options:{signal:AbortSignal})=>Promise<any>} input.handle
 * @param {any} input.message
 * @param {DocumentExtraction} input.entry
 * @param {()=>boolean} input.isCurrent
 * @returns {Promise<any>}
 */
export const runLeasedDocumentExtraction = async ({
  handle, message, entry, isCurrent,
}) => {
  try {
    const result = await handle(message, { signal: entry.controller.signal });
    // Failures retain their exact document vocabulary. A success is authority-
    // bearing, so it must prove the same DOM-host generation at settlement.
    return result?.ok === true && isCurrent() !== true
      ? { ok: false, error: 'stale-document-extraction' }
      : result;
  } catch {
    // why stable: parser/stream exceptions are untrusted document detail and
    // the runtime message must always settle its request.
    return { ok: false, error: 'doc_extract_failed' };
  }
};
