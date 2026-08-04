// @ts-check
// bytes → Document. The one entry point that decides WHICH parser runs.
//
// Everything reachable from here is pure (the parsers, the ZIP reader, the XML
// reader) — the only platform primitives are TextDecoder and
// DecompressionStream, both of which exist in the service worker, a worker, the
// offscreen document, and Bun. So the whole conversion is context-agnostic and
// testable from the terminal; the impure part (getting the bytes) stays in the
// caller.

import { sniffDocFormat, isConvertible, isLegacyBinary } from './sniff.js';
import { UnsupportedDocFormatError, LegacyDocFormatError } from './errors.js';
import { parseCsv } from './parse/csv.js';
import { parseRtf } from './parse/rtf.js';
import { parseDocx } from './parse/docx.js';
import { parseXlsx } from './parse/xlsx.js';
import { parsePptx } from './parse/pptx.js';
import { parseOdf } from './parse/odf.js';
import { parseEpub } from './parse/epub.js';

/** Which app wrote a legacy OLE2 file, guessed from the name, for the message only. */
const legacyHint = (/** @type {string} */ name) => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'doc') return 'Word 97-2003 (.doc)';
  if (ext === 'xls') return 'Excel 97-2003 (.xls)';
  if (ext === 'ppt') return 'PowerPoint 97-2003 (.ppt)';
  return 'a pre-2007 Microsoft Office binary';
};

/**
 * Convert document bytes to the unified model.
 *
 * @param {Uint8Array} bytes
 * @param {{ name?: string, contentType?: string, format?: string }} [hints]
 * @returns {Promise<import('./model.js').Document>}
 */
export const convertToDocument = async (bytes, hints = {}) => {
  // An explicit format overrides the sniffer — the caller may know something
  // the bytes cannot say (a part extracted from a bigger container).
  const sniffed = sniffDocFormat(bytes, hints);
  const format = /** @type {import('./sniff.js').DocFormat} */ (hints.format ?? sniffed.format);

  if (isLegacyBinary(format)) {
    throw new LegacyDocFormatError(
      `${legacyHint(hints.name ?? '')} is a binary format this reader cannot open. `
      + 'Ask the owner for a modern equivalent (.docx / .xlsx / .pptx), or convert it in a WebVM sandbox '
      + '(vm_import the file, then `libreoffice --headless --convert-to docx`).',
      { format },
    );
  }
  if (!isConvertible(format)) {
    throw new UnsupportedDocFormatError(
      `this reader does not handle ${format === 'unknown' ? 'these bytes' : `.${format} files`}`,
      { format },
    );
  }

  const decodeText = () => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  /** @type {import('./model.js').Document} */
  let doc;
  switch (format) {
    case 'csv': case 'tsv':
      doc = parseCsv(decodeText(), { format, name: hints.name });
      break;
    case 'rtf': doc = parseRtf(decodeText(), { name: hints.name }); break;
    case 'docx': doc = await parseDocx(bytes); break;
    case 'xlsx': doc = await parseXlsx(bytes); break;
    case 'pptx': doc = await parsePptx(bytes); break;
    case 'odt': case 'ods': case 'odp': doc = await parseOdf(bytes, format); break;
    case 'epub': doc = await parseEpub(bytes); break;
    default:
      // Unreachable — isConvertible already gated the set. Kept so adding a
      // format to CONVERTIBLE without wiring it here fails loudly.
      throw new UnsupportedDocFormatError(`no parser wired for .${format}`, { format });
  }

  // Surface a LOW-CONFIDENCE identification. When the bytes themselves named
  // the format there is nothing to say; when we went on the filename or the
  // content-type, the reader should know that a wrong guess is possible.
  if (!hints.format && (sniffed.via === 'extension' || sniffed.via === 'heuristic')) {
    doc.notes.push(`Format was inferred from the ${sniffed.via === 'extension' ? 'file name' : 'content'}, not from a format signature.`);
  }
  return doc;
};
