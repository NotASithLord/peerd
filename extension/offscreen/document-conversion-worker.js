// @ts-check
// One-operation pure document conversion realm. It receives bounded bytes and
// format hints only: no browser, network, storage, vault, or controller handle.

import {
  convertToDocument, DocParseError, UnsupportedDocFormatError,
  LegacyDocFormatError, ZipError,
} from '/peerd-runtime/document-conversion.js';
import {
  DOCUMENT_CONVERSION_PROTOCOL,
  DOCUMENT_CONVERSION_RESULT,
  MAX_DOCUMENT_CONVERSION_RESULT_CHARS,
  parseDocumentConversionRun,
} from './document-conversion-host.js';

/** @param {unknown} cause */
const stableFailure = (cause) => {
  const error = /** @type {{format?:unknown}} */ (cause);
  const format = typeof error?.format === 'string' && error.format.length <= 64
    ? error.format : undefined;
  if (cause instanceof LegacyDocFormatError) return { error: 'legacy_binary_format', format };
  if (cause instanceof UnsupportedDocFormatError) return { error: 'unsupported_format', format };
  if (cause instanceof ZipError) return { error: 'unreadable_container' };
  if (cause instanceof DocParseError) return { error: 'parse_failed', format };
  return { error: 'doc_extract_failed' };
};

self.onmessage = async (event) => {
  const request = parseDocumentConversionRun(event.data);
  if (!request) { self.close(); return; }
  try {
    const doc = await convertToDocument(new Uint8Array(request.bytes), request.hints);
    // Do the potentially expensive walk/stringification in this disposable
    // realm. The cap bounds the structured clone delivered to the event loop.
    const serialized = JSON.stringify(doc);
    if (serialized.length > MAX_DOCUMENT_CONVERSION_RESULT_CHARS) {
      throw new DocParseError('document conversion result exceeded its fixed limit', {
        format: doc.format,
      });
    }
    self.postMessage({
      protocol: DOCUMENT_CONVERSION_PROTOCOL,
      type: DOCUMENT_CONVERSION_RESULT,
      ok: true,
      doc,
    });
  } catch (cause) {
    self.postMessage({
      protocol: DOCUMENT_CONVERSION_PROTOCOL,
      type: DOCUMENT_CONVERSION_RESULT,
      ok: false,
      ...stableFailure(cause),
    });
  } finally {
    self.close();
  }
};
