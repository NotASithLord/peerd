// @ts-check
// Format detection — CONTENT first, name second.
//
// why content-first (the anydoc posture): the three signals disagree constantly
// in the wild. A .docx served as application/octet-stream, a "report.pdf" link
// that 200s to an HTML login page, a CSV export with no extension at all — the
// bytes are the only one of the three that cannot lie. So the magic number
// decides, and the filename/content-type are consulted only where the bytes are
// genuinely ambiguous (every OOXML/ODF/EPUB file is a ZIP, and text formats have
// no magic number at all).
//
// Pure: bytes in, a format tag out. No IO, no globals — bun-testable.

/**
 * @typedef {'docx'|'xlsx'|'pptx'|'odt'|'ods'|'odp'|'epub'|'rtf'|'csv'|'tsv'|'pdf'
 *           |'ole2'|'xlsb'|'html'|'text'|'zip'|'unknown'} DocFormat
 */

/** Formats this reader converts to Markdown itself. */
export const CONVERTIBLE = /** @type {const} */ ([
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'rtf', 'csv', 'tsv',
]);

/**
 * Recognized-but-not-convertible-here: the pre-2007 OLE2 compound binaries and
 * the binary workbook. Real parsers for these are a CFB reader plus per-app
 * record decoders — thousands of lines for formats that are ~all legacy. The
 * WebVM (a real Linux) is the honest escape hatch, so we name the format
 * precisely and hand the agent that route rather than pretending.
 */
export const LEGACY = /** @type {const} */ (['ole2', 'xlsb']);

const ascii = (/** @type {Uint8Array} */ b, /** @type {number} */ off, /** @type {number} */ len) => {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i += 1) s += String.fromCharCode(b[off + i]);
  return s;
};

/** @param {Uint8Array} bytes @param {number[]} sig @param {number} [off] */
const startsWith = (bytes, sig, off = 0) => sig.every((byte, i) => bytes[off + i] === byte);

// Extension → format, for the ambiguous cases only. Kept beside the sniffer
// because it is the SECOND opinion, never the first.
const BY_EXTENSION = /** @type {Record<string, DocFormat>} */ ({
  docx: 'docx', docm: 'docx', dotx: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', ppsx: 'pptx',
  odt: 'odt', ott: 'odt',
  ods: 'ods', ots: 'ods',
  odp: 'odp', otp: 'odp',
  epub: 'epub', rtf: 'rtf', csv: 'csv', tsv: 'tsv', tab: 'tsv',
  pdf: 'pdf', xlsb: 'xlsb',
  doc: 'ole2', xls: 'ole2', ppt: 'ole2',
});

const BY_MIME = /** @type {Array<[RegExp, DocFormat]>} */ ([
  [/wordprocessingml\.document|msword.*openxml/i, 'docx'],
  [/spreadsheetml\.sheet/i, 'xlsx'],
  [/presentationml\.presentation/i, 'pptx'],
  [/opendocument\.text/i, 'odt'],
  [/opendocument\.spreadsheet/i, 'ods'],
  [/opendocument\.presentation/i, 'odp'],
  [/epub\+zip/i, 'epub'],
  [/application\/rtf|text\/rtf/i, 'rtf'],
  [/text\/csv/i, 'csv'],
  [/text\/tab-separated/i, 'tsv'],
  [/application\/pdf/i, 'pdf'],
  [/ms-excel\.sheet\.binary/i, 'xlsb'],
  [/application\/msword|ms-excel|ms-powerpoint/i, 'ole2'],
]);

/**
 * The extension of a URL's path, lowercased, or ''. Query strings and
 * fragments are stripped first — `?download=1` is not an extension.
 * @param {string} [nameOrUrl]
 */
export const extensionOf = (nameOrUrl) => {
  if (typeof nameOrUrl !== 'string' || !nameOrUrl) return '';
  const path = nameOrUrl.split(/[?#]/, 1)[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/**
 * Which OOXML/ODF/EPUB flavor is this ZIP? Every one of them is a ZIP, so the
 * container magic gets us only as far as "a zip"; the flavor lives in a member
 * name. Cheap and allocation-free: we scan the raw bytes for the marker names
 * rather than inflating the archive, because at this point we have not even
 * decided the file is a document.
 *
 * ODF and EPUB both declare themselves properly — an uncompressed `mimetype`
 * member stored FIRST, by spec, so its value sits in plain sight near byte 38.
 * OOXML does not, so we look for the part paths its central directory must
 * contain.
 *
 * @param {Uint8Array} bytes
 * @returns {DocFormat}
 */
export const sniffZipFlavor = (bytes) => {
  // Everything below searches the buffer as latin-1 rather than seeking to
  // byte offsets. why: member names and the ODF/EPUB media type are ASCII and
  // appear verbatim (local headers and the central directory are never
  // compressed), whereas OFFSETS shift the moment the caller hands us a head
  // that has been through a lossy decode — which is exactly what fetch_url has.
  const flat = ascii(bytes, 0, bytes.length);
  // ODF and EPUB declare themselves in a `mimetype` member the spec requires be
  // STORED, so the media type sits in the archive as plain text.
  if (flat.includes('mimetype')) {
    if (flat.includes('application/epub+zip')) return 'epub';
    if (flat.includes('application/vnd.oasis.opendocument.text')) return 'odt';
    if (flat.includes('application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
    if (flat.includes('application/vnd.oasis.opendocument.presentation')) return 'odp';
  }
  // OOXML has no mimetype member, so identify by the part paths it must carry.
  if (flat.includes('word/document.xml')) return 'docx';
  if (flat.includes('xl/workbook.xml')) return 'xlsx';
  if (flat.includes('ppt/presentation.xml')) return 'pptx';
  // An EPUB whose mimetype member was (wrongly) deflated still has this.
  if (flat.includes('META-INF/container.xml')) return 'epub';
  return 'zip';
};

/**
 * Does this text look like delimiter-separated values? Only asked of bytes
 * that are already known to be plain text with no magic number, and only to
 * separate "a table" from "prose in a .txt". Conservative on purpose: a false
 * positive renders someone's log file as a mangled Markdown table.
 *
 * @param {string} text
 * @returns {'csv'|'tsv'|null}
 */
export const sniffDelimited = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.length < 2) return null;
  for (const [delimiter, format] of /** @type {Array<[string, 'csv'|'tsv']>} */ ([['\t', 'tsv'], [',', 'csv']])) {
    const counts = lines.map((l) => l.split(delimiter).length - 1);
    // Every line must carry the delimiter, and the column count must be stable
    // — that consistency is what distinguishes a table from prose containing
    // commas. (Quoted fields can hold a delimiter, so allow a ±1 wobble.)
    if (counts.some((c) => c < 1)) continue;
    const first = counts[0];
    if (counts.every((c) => Math.abs(c - first) <= 1)) return format;
  }
  return null;
};

/**
 * Identify a document from its bytes, with the filename/URL and content-type
 * as tiebreakers. Returns the format plus HOW it was decided, because the tool
 * surfaces that: "I read this as .xlsx because the bytes said so" is a very
 * different claim from "because the URL ended in .xlsx".
 *
 * @param {Uint8Array} bytes
 * @param {{ name?: string, contentType?: string }} [hints]
 * @returns {{ format: DocFormat, via: 'magic'|'zip-member'|'extension'|'content-type'|'heuristic'|'none' }}
 */
export const sniffDocFormat = (bytes, hints = {}) => {
  const ext = extensionOf(hints.name);
  const ct = (hints.contentType ?? '').toLowerCase();

  if (bytes && bytes.length >= 4) {
    // Unambiguous magic numbers first.
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { format: 'pdf', via: 'magic' };        // %PDF
    if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74])) return { format: 'rtf', via: 'magic' };        // {\rt(f)
    // OLE2 / CFB compound file: .doc, .xls, .ppt — and, confusingly, some
    // encrypted OOXML. Either way we cannot open it here.
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      // The extension is the only hint about WHICH legacy app wrote it; it
      // does not change the outcome, only the message.
      return { format: 'ole2', via: 'magic' };
    }
    // ZIP: PK\x03\x04 (normal) or PK\x05\x06 (empty archive).
    if (startsWith(bytes, [0x50, 0x4b]) && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) {
      const flavor = sniffZipFlavor(bytes);
      if (flavor !== 'zip') return { format: flavor, via: 'zip-member' };
      // A plain ZIP whose members we could not identify — .xlsb is a ZIP too
      // (binary parts inside), so let the name break the tie.
      if (ext === 'xlsb') return { format: 'xlsb', via: 'extension' };
      const named = BY_EXTENSION[ext];
      if (named && named !== 'ole2') return { format: named, via: 'extension' };
      return { format: 'zip', via: 'magic' };
    }
  }

  // No magic number: text-ish formats. Decode a leading slice to look at.
  const head = new TextDecoder('utf-8', { fatal: false }).decode((bytes ?? new Uint8Array()).slice(0, 8192));
  if (/^\s*(<!doctype html|<html[\s>])/i.test(head)) return { format: 'html', via: 'magic' };

  for (const [re, format] of BY_MIME) {
    if (re.test(ct)) return { format, via: 'content-type' };
  }
  const named = BY_EXTENSION[ext];
  if (named) return { format: named, via: 'extension' };

  const delimited = sniffDelimited(head);
  if (delimited) return { format: delimited, via: 'heuristic' };

  if (bytes?.length) {
    // A NUL byte in the first 8k is the classic "this is binary" tell.
    if (bytes.slice(0, 8192).includes(0)) return { format: 'unknown', via: 'none' };
    return { format: 'text', via: 'heuristic' };
  }
  return { format: 'unknown', via: 'none' };
};

/**
 * Does this HTTP response look like a document FILE rather than a web page?
 *
 * why this exists separately from sniffDocFormat: fetch_url never holds bytes
 * — its primitive decodes every response with `Response.text()` — so by the
 * time it could ask, a .docx is already a string of mojibake. This works on
 * what fetch_url actually has: the content-type, the URL, and the decoded
 * head. That is enough, because the ZIP/PDF/RTF signatures are ASCII and
 * survive a UTF-8 decode intact.
 *
 * Returns the format plus the tool that WILL read it, so the caller can hand
 * the agent a route instead of 16k characters of garbage.
 *
 * @param {{ contentType?: string, url?: string, bodyHead?: string }} input
 * @returns {{ format: DocFormat, tool: 'read_doc'|'read_pdf' } | null}
 */
export const sniffResponseAsDocument = ({ contentType = '', url = '', bodyHead = '' }) => {
  // Signatures first — they beat a wrong content-type, which is the common case
  // (S3 and most CDNs serve application/octet-stream for everything).
  if (bodyHead.startsWith('%PDF')) return { format: 'pdf', tool: 'read_pdf' };
  if (bodyHead.startsWith('{\\rt')) return { format: 'rtf', tool: 'read_doc' };
  if (bodyHead.startsWith('PK')) {
    // A ZIP. Only claim it when we can say WHICH document it is — a plain
    // .zip download is not something read_doc can open either.
    const flavor = sniffZipFlavor(new TextEncoder().encode(bodyHead.slice(0, 4096)));
    if (flavor !== 'zip') return { format: flavor, tool: 'read_doc' };
    const named = BY_EXTENSION[extensionOf(url)];
    return named && isConvertible(named) ? { format: named, tool: 'read_doc' } : null;
  }
  // No signature in the head: fall back to the declared type, then the name.
  // CSV/TSV are deliberately NOT included — they decode to perfectly readable
  // text, so fetch_url's own output is fine and a redirect would be noise.
  for (const [re, format] of BY_MIME) {
    if (!re.test(contentType.toLowerCase())) continue;
    if (format === 'pdf') return { format, tool: 'read_pdf' };
    if (isConvertible(format) && format !== 'csv' && format !== 'tsv') return { format, tool: 'read_doc' };
  }
  return null;
};

/** @param {DocFormat} format */
export const isConvertible = (format) => /** @type {readonly string[]} */ (CONVERTIBLE).includes(format);

/** @param {DocFormat} format */
export const isLegacyBinary = (format) => /** @type {readonly string[]} */ (LEGACY).includes(format);
