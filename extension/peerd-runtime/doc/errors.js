// @ts-check
// Named error subclasses for the document-reading subsystem.
//
// House rule (CLAUDE.md): named subclasses, never a bare Error with a message.
// Each maps to a distinct thing the AGENT should do next, which is why they are
// separate types rather than one DocError with a code — the read_doc tool turns
// the type into the "what to try instead" sentence.

/** The bytes could not be fetched (network, HTTP status, refused redirect). */
export class DocFetchError extends Error {
  /** @param {string} message @param {{ status?: number }} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DocFetchError';
    this.status = meta.status ?? 0;
  }
}

/** The bytes are not a format this reader knows how to open at all. */
export class UnsupportedDocFormatError extends Error {
  /** @param {string} message @param {{ format?: string }} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'UnsupportedDocFormatError';
    this.format = meta.format ?? 'unknown';
  }
}

/**
 * The format IS recognized but this build cannot convert it in-browser — the
 * legacy OLE2 binaries (.doc/.xls/.ppt) and .xlsb. Distinct from Unsupported
 * because the answer is different: those have a real escape hatch (convert in
 * the WebVM), so the tool names it instead of just saying no.
 */
export class LegacyDocFormatError extends Error {
  /** @param {string} message @param {{ format?: string }} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegacyDocFormatError';
    this.format = meta.format ?? 'unknown';
  }
}

/** The container/markup was recognized but malformed past the point of reading. */
export class DocParseError extends Error {
  /** @param {string} message @param {{ format?: string }} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DocParseError';
    this.format = meta.format ?? 'unknown';
  }
}

/** A ZIP container that is encrypted, truncated, or uses an unsupported method. */
export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}
