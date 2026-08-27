// @ts-check
// offscreen/doc-extract.js — convert an office/publishing document in the
// OFFSCREEN document. The read_doc tool (SW) calls in via
// background/offscreen-doc-client.js → a 'doc/extract' message → here.
//
// Why here and not the SW: not because the conversion needs a DOM (it does not
// — peerd-runtime/doc is pure and would run anywhere), but because of what
// happens BEFORE it. The bytes have to be fetched, and a document is routinely
// tens of megabytes; holding that in the service worker fights the MV3
// lifecycle, and it is exactly the buffer the SW should not be sitting on when
// it is also the context that holds the vault DK. The offscreen document is
// where peerd already puts untrusted heavy parsing (pdf.js, Readability, the
// sealed worker), so a hostile .docx lands in the same place a hostile PDF does
// rather than in a new one.
//
// SECURITY: the bytes are UNTRUSTED web content, and the conversion is entirely
// declarative — a ZIP index read, an XML tokenizer, and string building. There
// is no eval, no scripting engine, no DOM insertion, and no external entity
// resolution (xml.js SKIPS doctypes and never resolves an entity it did not
// define — so XXE and billion-laughs have no surface here). A hostile document
// can at worst make the parse fail, which is surfaced as an error. The text
// crosses back wrapped in <untrusted_web_content> by the read_doc tool.

import { base64ToBytes } from '/shared/util.js';
import {
  convertToDocument, sniffDocFormat,
  DocFetchError, DocParseError, UnsupportedDocFormatError, LegacyDocFormatError, ZipError,
} from '/peerd-runtime/offscreen.js';
import { extractPdfBytes } from './pdf-extract.js';
import { readBoundedResponseBytes, ResponseTooLargeError } from './bounded-response.js';

// Fetch far enough to preserve the PDF reader's existing ceiling, then apply
// the lower structured-document cap after content sniffing. A large PDF is
// often image data; a same-sized OOXML archive is overwhelmingly discarded
// media and makes the ZIP index needlessly expensive.
const MAX_FETCH_BYTES = 75 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

/**
 * Fetch the document bytes. Mirrors offscreen/pdf-extract.js exactly, and the
 * redirect posture is the load-bearing part: the SW validated only the INITIAL
 * host (denylist + isPrivateOrLocalHost, in read-doc.js). A follow-mode fetch
 * would let a public host 302 this onto loopback / LAN / link-local / metadata
 * — the SSRF pivot webFetch closes by refusing 3xx (INV-7). So a redirect
 * becomes an opaqueredirect we reject rather than follow.
 *
 * @param {{ url?: string, bytesB64?: string }} source
 * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
 */
const fetchDocBytes = async ({ url, bytesB64 } = {}) => {
  if (bytesB64) {
    // Reject obviously oversized inline input before decoding creates another
    // large buffer. The post-decode check remains authoritative around base64
    // padding and any unusual encoder spelling.
    if (bytesB64.length > Math.ceil(MAX_FETCH_BYTES / 3) * 4 + 4) {
      throw new DocFetchError(`document too large (limit ${MAX_FETCH_BYTES} bytes)`);
    }
    const bytes = base64ToBytes(bytesB64);
    if (bytes.length > MAX_FETCH_BYTES) {
      throw new DocFetchError(`document too large: ${bytes.length} bytes (limit ${MAX_FETCH_BYTES})`);
    }
    return { bytes, contentType: '' };
  }
  if (!url || typeof url !== 'string') throw new DocFetchError('no document url provided');
  if (url.startsWith('blob:')) {
    throw new DocFetchError('blob: URLs are not reachable from the extension; use the document\'s http(s) URL');
  }
  let res;
  try {
    res = await fetch(url, { redirect: 'manual' });
  } catch (e) {
    throw new DocFetchError(`could not fetch the document: ${(/** @type {{ message?: string }} */ (e))?.message ?? e}`);
  }
  if (res.type === 'opaqueredirect' || res.status === 0) {
    throw new DocFetchError('the URL redirected; redirects are refused to prevent SSRF to internal hosts');
  }
  if (!res.ok) throw new DocFetchError(`HTTP ${res.status} fetching the document`, { status: res.status });
  let bytes;
  try {
    bytes = await readBoundedResponseBytes(res, MAX_FETCH_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new DocFetchError(`document too large: ${error.bytes} bytes (limit ${MAX_FETCH_BYTES})`);
    }
    throw new DocFetchError(`could not read the document response: ${(/** @type {{message?:string}} */ (error))?.message ?? error}`);
  }
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
};

/**
 * @param {{ source: any, opts?: { maxChars?: number, format?: string, engine?: string, dev?: boolean } }} msg
 */
export const handleDocExtract = async ({ source, opts = {} }) => {
  // Stage rides every failure so the returned error pinpoints WHERE it broke.
  let stage = 'fetch';
  const where = source?.url ? String(source.url).slice(0, 120) : '(inline bytes)';
  try {
    const { bytes, contentType } = await fetchDocBytes(source);

    stage = 'sniff';
    const hints = {
      name: source?.name || source?.url || '',
      // An explicit content-type from the response beats the caller's guess.
      contentType: contentType || source?.contentType || '',
      ...(opts.format ? { format: opts.format } : {}),
    };
    const sniffed = sniffDocFormat(bytes, hints);

    // Detection selects the internal engine. An explicit structured-document
    // format still overrides a mistaken sniff, but PDF needs no public sibling:
    // it continues through the dedicated pdf.js/OCR engine behind read_doc.
    if (!opts.format && sniffed.format === 'pdf') {
      const extracted = await extractPdfBytes(bytes, {
        engine: opts.engine,
        dev: opts.dev,
        sourceLabel: where,
      });
      if (!extracted.ok) return extracted;
      return {
        ok: true,
        result: {
          format: 'pdf', pdf: extracted.result, bytes: bytes.length, sniffedVia: sniffed.via,
        },
      };
    }
    if (!opts.format && (sniffed.format === 'html' || sniffed.format === 'text')) {
      return {
        ok: false,
        error: 'is_web_content',
        detail: `This URL served ${sniffed.format === 'html' ? 'an HTML page' : 'plain text'}, not a document file. `
          + 'Read it with fetch_url, or open it in a tab. (A login wall commonly does this to a document link.)',
      };
    }

    stage = 'convert';
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      throw new DocFetchError(`document too large: ${bytes.length} bytes (limit ${MAX_DOCUMENT_BYTES})`);
    }
    const doc = await convertToDocument(bytes, hints);
    console.debug(`[offscreen/doc-extract] ${where}: ${doc.format}, ${doc.blocks.length} blocks, ${bytes.length} bytes`);
    return { ok: true, result: { format: doc.format, doc, bytes: bytes.length, sniffedVia: sniffed.via } };
  } catch (e) {
    const err = /** @type {{ name?: string, message?: string, format?: string }} */ (e);
    console.error(`[offscreen/doc-extract] FAILED at stage=${stage} for ${where}:`, e);
    // The typed errors carry the agent's next move, so they cross the wire as
    // themselves rather than collapsing into one opaque failure string.
    if (e instanceof LegacyDocFormatError) return { ok: false, error: 'legacy_binary_format', detail: err.message, format: err.format };
    if (e instanceof UnsupportedDocFormatError) return { ok: false, error: 'unsupported_format', detail: err.message, format: err.format };
    if (e instanceof ZipError) return { ok: false, error: 'unreadable_container', detail: err.message };
    if (e instanceof DocParseError) return { ok: false, error: 'parse_failed', detail: err.message, format: err.format };
    if (e instanceof DocFetchError) return { ok: false, error: 'fetch_failed', detail: err.message };
    return { ok: false, error: `doc_extract_failed[${stage}]`, detail: `${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
  }
};
