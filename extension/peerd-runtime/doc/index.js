// @ts-check
// peerd-runtime/doc — public surface of the document-reading subsystem.
//
// The sibling of peerd-runtime/pdf, for everything that ISN'T a PDF: the office
// and publishing formats an agent meets on the open web — Word, Excel,
// PowerPoint, OpenDocument, RTF, EPUB, and delimited text. One pipeline,
// modeled on Firecrawl's anydoc:
//
//     bytes → sniff → per-format parser → unified Document → GFM Markdown
//
// why the shared model in the middle (rather than a converter per format): it
// is what makes a table from a .docx and a table from a .xlsx come out
// identical, and it puts every escaping and truncation decision in one file
// instead of seven.
//
// Split across contexts, like pdf:
//   SW         — the read_doc tool dispatches to the offscreen client
//   offscreen  — fetches the bytes under the SSRF rules, runs the conversion
//
// The conversion core itself is PURE and context-agnostic — it needs only
// TextDecoder and DecompressionStream — so it is exercised from Bun in
// tests/doc/*.test.ts. Nothing here is vendored: DEFLATE is the platform's,
// and the ZIP/XML readers are small enough to own.

export { convertToDocument } from './convert.js';
export { formatDocBody, formatDocHead, formatHeader, DEFAULT_MAX_CHARS } from './format.js';
export { toMarkdown, renderInlines, renderTable } from './markdown.js';
export {
  sniffDocFormat, sniffZipFlavor, sniffDelimited, extensionOf,
  isConvertible, isLegacyBinary, CONVERTIBLE, LEGACY,
} from './sniff.js';
export { makeDocument, finalizeDocument, mergeInlines, compactBlocks } from './model.js';
export { readZipIndex, readZipEntry, readZipText } from './zip.js';
export { parseXml, findAll, find, elements, textOf, localName, decodeEntities } from './xml.js';
export {
  DocFetchError, DocParseError, UnsupportedDocFormatError, LegacyDocFormatError, ZipError,
} from './errors.js';
