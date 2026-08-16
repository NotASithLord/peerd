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

import browser from '/vendor/browser-polyfill.js';
import { base64ToBytes } from '/shared/util.js';
import { isTrustedSender } from '/shared/messaging.js';
import {
  convertToDocument, sniffDocFormat,
  DocFetchError, DocParseError, UnsupportedDocFormatError, LegacyDocFormatError, ZipError,
} from '/peerd-runtime/offscreen.js';

// A hard ceiling on the bytes we will pull. Lower than the PDF reader's 75MB:
// a PDF is often a scan whose size is pixels, whereas a .docx or .xlsx that
// large is overwhelmingly embedded media we are going to discard anyway, and
// the ZIP index read touches the whole buffer.
const MAX_BYTES = 40 * 1024 * 1024;

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
  if (bytesB64) return { bytes: base64ToBytes(bytesB64), contentType: '' };
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
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new DocFetchError(`document too large: ${buf.byteLength} bytes (limit ${MAX_BYTES})`);
  }
  return { bytes: new Uint8Array(buf), contentType: res.headers.get('content-type') ?? '' };
};

/**
 * @param {{ source: any, opts?: { maxChars?: number, format?: string } }} msg
 */
const extractDoc = async ({ source, opts = {} }) => {
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

    // These two redirects are DETECTION-driven, so an explicit opts.format
    // skips them: overriding a wrong detection is the only reason that
    // parameter exists, and refusing on the detected format would make the
    // override unreachable in exactly the case it is for.
    //
    // PDF has a BETTER reader in this build (pdf.js text layer + opt-in OCR),
    // so read_doc refuses it by NAME rather than by failure — the agent gets a
    // route, not a dead end. Same for a URL that served HTML: that is the
    // ordinary web path, and fetch_url/read_page do it far better.
    if (!opts.format && sniffed.format === 'pdf') {
      return { ok: false, error: 'is_pdf', detail: 'This is a PDF. Use read_pdf, which has a text layer and OCR.' };
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
    const doc = await convertToDocument(bytes, hints);
    console.debug(`[offscreen/doc-extract] ${where}: ${doc.format}, ${doc.blocks.length} blocks, ${bytes.length} bytes`);
    return { ok: true, result: { doc, bytes: bytes.length, sniffedVia: sniffed.via } };
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

// Message route: SW → offscreen. Gated on isTrustedSender like every sibling
// handler (pdf/extract, job/run, voice) — fail-closed: externally_connectable
// is unset today, so this is defense-in-depth, but the gate is what keeps this
// from being an open fetch proxy if it is ever enabled.
// why cast: the polyfill's OnMessageListener return type is stricter than this
// fire-and-respond handler (mirrors the pdf/extract listener).
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ msg, /** @type {any} */ sender, /** @type {any} */ sendResponse) => {
  if (msg?.type !== 'doc/extract') return undefined;
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  extractDoc(msg)
    .then((out) => sendResponse(out))
    .catch((e) => sendResponse({ ok: false, error: e?.name ? `${e.name}: ${e.message}` : (e?.message ?? String(e)) }));
  return true;     // async sendResponse contract
}));
