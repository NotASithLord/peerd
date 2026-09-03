// @ts-check
// offscreen/doc-extract.js — convert an office/publishing document in the
// OFFSCREEN document. The controller-owned read_doc tool requests an exact
// extraction effect through background/offscreen-doc-client.js → a
// 'doc/extract' message → here.
//
// Why here and not the SW: not because the conversion needs a DOM (it does not
// — peerd-runtime/doc is pure and would run anywhere), but because of what
// happens BEFORE it. The bytes have to be fetched, and a document is routinely
// tens of megabytes; holding that in the service worker fights the MV3
// lifecycle, and it is exactly the buffer the SW should not be sitting on when
// it is also the context that holds the vault DK. The offscreen document is
// where peerd already puts untrusted heavy parsing. Structured conversion then
// enters a disposable Worker so a hostile .docx cannot stall this host's Stop
// route or feature-lease lifecycle.
//
// SECURITY: the bytes are UNTRUSTED web content, and the conversion is entirely
// declarative — a ZIP index read, an XML tokenizer, and string building. There
// is no eval, no scripting engine, no DOM insertion, and no external entity
// resolution (xml.js SKIPS doctypes and never resolves an entity it did not
// define — so XXE and billion-laughs have no surface here). A hostile document
// can at worst make the parse fail, which is surfaced as an error. The text
// crosses back as a raw bounded receipt; the sealed read_doc tool wraps it in
// <untrusted_web_content> before exposing it to the model.

import { base64ToBytes } from '/shared/util.js';
import {
  sniffDocFormat, DocFetchError,
} from '/peerd-runtime/offscreen.js';
import { extractPdfBytes } from './pdf-extract.js';
import { readBoundedResponseBytes, ResponseTooLargeError } from './bounded-response.js';
import {
  convertDocumentInWorker, MAX_DOCUMENT_CONVERSION_BYTES,
} from './document-conversion-host.js';
import { abortError, throwIfAborted } from '/shared/abort.js';

// Fetch far enough to preserve the PDF reader's existing ceiling, then apply
// the lower structured-document cap after content sniffing. A large PDF is
// often image data; a same-sized OOXML archive is overwhelmingly discarded
// media and makes the ZIP index needlessly expensive.
const MAX_FETCH_BYTES = 75 * 1024 * 1024;

/**
 * Fetch the document bytes. Mirrors offscreen/pdf-extract.js exactly, and the
 * redirect posture is the load-bearing part: the SW validated only the INITIAL
 * host (denylist + isPrivateOrLocalHost, in read-doc.js). A follow-mode fetch
 * would let a public host 302 this onto loopback / LAN / link-local / metadata
 * — the SSRF pivot webFetch closes by refusing 3xx (INV-7). So a redirect
 * becomes an opaqueredirect we reject rather than follow.
 *
 * @param {{ url?: string, bytesB64?: string }} source
 * @param {{signal?:AbortSignal,fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
 */
const fetchDocBytes = async ({ url, bytesB64 } = {}, { signal, fetchImpl = fetch } = {}) => {
  throwIfAborted(signal, 'Document extraction stopped.');
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
    res = await fetchImpl(url, { redirect: 'manual', signal });
  } catch (e) {
    if (signal?.aborted || (/** @type {{name?:string}} */ (e))?.name === 'AbortError') {
      throw abortError(signal, 'Document extraction stopped.');
    }
    throw new DocFetchError(`could not fetch the document: ${(/** @type {{ message?: string }} */ (e))?.message ?? e}`);
  }
  throwIfAborted(signal, 'Document extraction stopped.');
  if (res.type === 'opaqueredirect' || res.status === 0) {
    throw new DocFetchError('the URL redirected; redirects are refused to prevent SSRF to internal hosts');
  }
  if (!res.ok) throw new DocFetchError(`HTTP ${res.status} fetching the document`, { status: res.status });
  let bytes;
  try {
    bytes = await readBoundedResponseBytes(res, MAX_FETCH_BYTES, { signal });
  } catch (error) {
    if (signal?.aborted || (/** @type {{name?:string}} */ (error))?.name === 'AbortError') {
      throw abortError(signal, 'Document extraction stopped.');
    }
    if (error instanceof ResponseTooLargeError) {
      throw new DocFetchError(`document too large: ${error.bytes} bytes (limit ${MAX_FETCH_BYTES})`);
    }
    throw new DocFetchError(`could not read the document response: ${(/** @type {{message?:string}} */ (error))?.message ?? error}`);
  }
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
};

/**
 * @param {{ source: any, opts?: { maxChars?: number, format?: string, engine?: string, dev?: boolean } }} msg
 * @param {{signal?:AbortSignal,fetchImpl?:typeof fetch,createConversionWorker?:()=>Worker}} [options]
 */
export const handleDocExtract = async (
  { source, opts = {} },
  { signal, fetchImpl, createConversionWorker } = {},
) => {
  // Stage rides every failure so the returned error pinpoints WHERE it broke.
  let stage = 'fetch';
  const where = source?.url ? String(source.url).slice(0, 120) : '(inline bytes)';
  try {
    const { bytes, contentType } = await fetchDocBytes(source, { signal, fetchImpl });

    stage = 'sniff';
    throwIfAborted(signal, 'Document extraction stopped.');
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
        signal,
      });
      throwIfAborted(signal, 'Document extraction stopped.');
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
    if (bytes.length > MAX_DOCUMENT_CONVERSION_BYTES) {
      throw new DocFetchError(`document too large: ${bytes.length} bytes (limit ${MAX_DOCUMENT_CONVERSION_BYTES})`);
    }
    const byteLength = bytes.length;
    const converted = await convertDocumentInWorker(bytes, hints, {
      signal, createWorker: createConversionWorker,
    });
    throwIfAborted(signal, 'Document extraction stopped.');
    if ('ok' in converted && converted.ok === false) return converted;
    const doc = /** @type {import('/peerd-runtime/doc/model.js').Document} */ (converted);
    console.debug(`[offscreen/doc-extract] ${where}: ${doc.format}, ${doc.blocks.length} blocks, ${byteLength} bytes`);
    return { ok: true, result: { format: doc.format, doc, bytes: byteLength, sniffedVia: sniffed.via } };
  } catch (e) {
    const err = /** @type {{ name?: string, message?: string, format?: string }} */ (e);
    if (signal?.aborted || err?.name === 'AbortError') {
      return { ok: false, error: 'doc_extract_aborted', detail: 'Document extraction stopped.' };
    }
    console.error(`[offscreen/doc-extract] FAILED at stage=${stage} for ${where}:`, e);
    // why details do not cross the wire: archive member names and parser error
    // messages are producer-controlled. The controller maps these stable codes
    // to tool-authored recovery guidance outside the untrusted-content fence.
    if (e instanceof DocFetchError) return { ok: false, error: 'fetch_failed' };
    return { ok: false, error: 'doc_extract_failed' };
  }
};
