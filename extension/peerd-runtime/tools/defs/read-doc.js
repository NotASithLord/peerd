// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// read_doc reads PDFs and structured document files through one content-
// detected surface.
//
// An ACTOR-ONLY tool (hidden from the main agent in exposure.js, in the web
// actor's toolset): its output is UNTRUSTED document content and must land in
// the web actor's context, never the main loop — the same boundary read_page
// sits on.
//
// Office-like files become Markdown; PDFs keep their pdf.js text-layer and
// optional OCR engine. The bytes decide which engine runs, because links and
// content types routinely lie. A missing URL uses the active PDF tab, closing
// the browser viewer gap without exposing a second model-facing tool.
//
// why one tool for eight formats rather than read_docx/read_xlsx/…: the agent
// usually does NOT know which one it has. Links lie, content-types lie, and a
// tool the agent must pick correctly BEFORE it can look is a tool it will pick
// wrong. read_doc sniffs the bytes and reports what it found.

import { wrapUntrusted } from '../prompt-wrap.js';
import { originOfUrl } from '../../tool-origin-policy.js';
import { requireEngine } from '../../pdf/engines.js';
import { formatPdfBody, DEFAULT_MAX_CHARS as DEFAULT_PDF_MAX_CHARS } from '../../pdf/extract-format.js';
import { formatDocBody, formatDocHead, DEFAULT_MAX_CHARS as DEFAULT_DOC_MAX_CHARS } from '../../doc/format.js';
import { toMarkdown } from '../../doc/markdown.js';
import { windowText, pagingFooter, excerptRelevant, excerptFooter } from '../web/spill.js';
import { MAX_SPILL_TEXT_CHARS } from '../result-store-policy.js';

// Keep the initial read below the loop's ordinary 8k persistence backstop,
// including the provenance fence and paging footer. Anything longer is
// retained behind read_result instead of being silently re-cut by the loop.
export const READ_DOC_PRESENTATION_MAX_CHARS = 6_000;

/** @param {unknown} value @param {number} fallback */
const presentationChars = (value, fallback) => Math.min(
  Number.isFinite(value) && /** @type {number} */ (value) > 0
    ? Math.floor(/** @type {number} */ (value))
    : fallback,
  READ_DOC_PRESENTATION_MAX_CHARS,
);

const boundedPdfPages = (/** @type {any[]} */ pages) => {
  const bounded = [];
  let remaining = MAX_SPILL_TEXT_CHARS;
  let capped = false;
  for (const page of Array.isArray(pages) ? pages : []) {
    if (remaining <= 0) { capped = true; break; }
    const source = typeof page?.text === 'string' ? page.text : String(page?.text ?? '');
    const text = source.slice(0, remaining);
    bounded.push({ ...page, text });
    remaining -= text.length;
    if (text.length < source.length) { capped = true; break; }
  }
  return { pages: bounded, capped };
};

const boundedPdfText = (/** @type {string} */ text, capped = false) => {
  if (!capped && text.length <= MAX_SPILL_TEXT_CHARS) return text;
  const note = '\n[note] PDF extraction stopped at its local safety cap; later PDF text was not stored.';
  return `${text.slice(0, Math.max(0, MAX_SPILL_TEXT_CHARS - note.length))}${note}`;
};

const boundedDocText = (/** @type {string} */ text) => {
  if (text.length <= MAX_SPILL_TEXT_CHARS) return { text, capped: false };
  const note = '\n\n_[note: document conversion stopped at its local safety cap; later text was not stored.]_';
  return {
    text: `${text.slice(0, Math.max(0, MAX_SPILL_TEXT_CHARS - note.length))}${note}`,
    capped: true,
  };
};

const DOCUMENT_FAILURE_GUIDANCE = Object.freeze({
  doc_reader_unavailable: 'Document conversion is not available in this browser build. If the document has an HTML version, read that instead.',
  legacy_binary_format: 'Legacy Office binary files are not supported. Ask for a modern .docx, .xlsx, or .pptx export, or convert the file in a WebVM.',
  unsupported_format: 'This file format is not supported by read_doc. Ask for a PDF or modern structured-document export.',
  unreadable_container: 'The document container is unreadable, encrypted, corrupt, or uses unsupported compression. Ask for an unencrypted modern export.',
  parse_failed: 'The recognized document could not be parsed. Try a fresh export or another copy.',
  fetch_failed: 'The document could not be fetched. Verify that the direct URL is reachable without a redirect or login wall.',
  is_web_content: 'The URL served a web page or plain text, not a document file. Use fetch_url or open it in a tab.',
  ocr_not_installed: 'OCR is not installed. Retry with the automatic or pdf.js engine, or install OCR support.',
  pdf_extract_failed: 'The PDF could not be parsed. Try another copy or a fresh PDF export.',
  doc_extract_aborted: 'Document extraction stopped.',
  doc_extract_failed: 'Document extraction failed before any readable content was returned.',
});

/** @param {unknown} value */
const stableDocumentFailure = (value) => {
  const raw = typeof value === 'string' ? value : '';
  const authorityCode = raw.startsWith('invalid_url') ? 'invalid_url'
    : raw.startsWith('unsupported_scheme') ? 'unsupported_scheme' : raw;
  if (!authorityCode || authorityCode === 'doc_read_failed') {
    return { error: 'doc_extract_failed', content: DOCUMENT_FAILURE_GUIDANCE.doc_extract_failed };
  }
  const code = authorityCode.startsWith('pdf_extract_failed') ? 'pdf_extract_failed'
    : authorityCode.startsWith('doc_extract_failed') ? 'doc_extract_failed' : authorityCode;
  const content = DOCUMENT_FAILURE_GUIDANCE[/** @type {keyof typeof DOCUMENT_FAILURE_GUIDANCE} */ (code)];
  return content ? { error: code, content } : { error: code };
};

/** @type {import('/shared/tool-types.js').Tool} */
export const readDocTool = composeTool("read_doc", {

  execute: async (args, ctx) => {
    const authority = /** @type {{extractDocument?:(request:{url:string|null,format?:string,engine:string})=>Promise<{ok:boolean,target?:string,result?:any,error?:string,content?:string}>,spillResult?:(record:Record<string,unknown>)=>Promise<string|null>}|undefined} */ (
      /** @type {any} */ (ctx).resourceAuthority);
    if (!authority?.extractDocument) return { ok: false, error: 'doc_reader_unavailable' };

    const explicitUrl = typeof args?.url === 'string' && args.url ? args.url : null;
    let engine = 'auto';
    if (args?.engine && args.engine !== 'auto') {
      try { engine = requireEngine(args.engine); }
      catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    }

    let extracted;
    try {
      extracted = await authority.extractDocument({
        url: explicitUrl, format: args.format, engine,
      });
    } catch (e) {
      const err = /** @type {{ code?: string, message?: string }} */ (e);
      return { ok: false, ...stableDocumentFailure(err?.code) };
    }
    if (extracted?.ok !== true) {
      return { ok: false, ...stableDocumentFailure(extracted?.error) };
    }
    const target = extracted.target;
    const result = extracted.result;
    if (typeof target !== 'string' || !target) return { ok: false, error: 'no_document_url' };
    if (result?.pdf) {
      const maxChars = presentationChars(args?.maxChars, DEFAULT_PDF_MAX_CHARS);
      const pdf = result.pdf;
      const source = boundedPdfPages(pdf.pages);
      const textCapped = pdf.textCapped === true || source.capped;
      const text = boundedPdfText(formatPdfBody({
        ...pdf, pages: source.pages, maxChars: MAX_SPILL_TEXT_CHARS,
      }), textCapped);
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const ex = query ? excerptRelevant(text, query, maxChars) : null;
      const win = windowText(text, maxChars);
      const shown = ex ? ex.excerpt : win.window;
      const truncated = ex ? ex.excerpted : win.windowed;
      let footer = null;
      if (truncated && authority.spillResult) {
        try {
          const cacheKey = await authority.spillResult({
            url: target, format: 'pdf-text', text,
            producer: 'read_doc', fenced: true, originLabel: originOfUrl(target),
          });
          if (cacheKey) {
            footer = ex
              ? excerptFooter({
                key: cacheKey, total: ex.total, passagesShown: ex.passagesShown,
                passagesTotal: ex.passagesTotal, query, retainedPrefix: textCapped,
              })
              : pagingFooter({
                key: cacheKey, total: win.total,
                headChars: win.headChars, tailChars: win.tailChars,
                retainedPrefix: textCapped,
              });
          }
        } catch { /* the bounded window still returns if best-effort spill fails */ }
      }
      const fenced = wrapUntrusted({
        origin: originOfUrl(target), tool: 'read_doc', body: shown,
      });
      return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
    }
    if (!result?.doc) return { ok: false, error: 'doc_read_failed', content: 'empty conversion result' };

    const maxChars = presentationChars(args?.maxChars, DEFAULT_DOC_MAX_CHARS);

    // SPILL-AND-PAGE, exactly as fetch_url does it. A document is the case
    // where a silent truncation hurts most — the answer is as likely to be in
    // an appendix as in the intro, and unlike a web page there is no second
    // way to reach the tail. So markdown up to the shared local safety cap is
    // stored and the model gets a window plus read_result to page the retained text;
    // with a query it gets the passages that MATCH instead of a blind
    // head+tail. Same idiom, same pager, same footer the actor already knows.
    const source = boundedDocText(toMarkdown(result.doc));
    const markdown = source.text;
    const head = formatDocHead({ doc: result.doc, source: target });
    if (!authority.spillResult) {
      // No spill capability → the plain capped render (which announces its cut).
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(target),
          tool: 'read_doc',
          body: formatDocBody({ doc: result.doc, maxChars, source: target }),
        }),
      };
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const ex = query ? excerptRelevant(markdown, query, maxChars) : null;
    const win = windowText(markdown, maxChars);
    const text = ex ? ex.excerpt : win.window;
    const truncated = ex ? ex.excerpted : win.windowed;

    /** @type {string | null} */
    let footer = null;
    if (truncated) {
      try {
        // ownerSessionId stamps the OWNER — the spill store is one SW-level map
        // keyed by an opaque handle, so without it any actor holding a key could
        // page back a document a different actor fetched.
        const cacheKey = await authority.spillResult({
          url: target, format: 'markdown', text: markdown,
          producer: 'read_doc', fenced: true, originLabel: originOfUrl(target),
        });
        if (cacheKey) {
          footer = ex
            ? excerptFooter({
              key: cacheKey, total: ex.total, passagesShown: ex.passagesShown,
              passagesTotal: ex.passagesTotal, query, retainedPrefix: source.capped,
            })
            : pagingFooter({
              key: cacheKey, total: win.total, headChars: win.headChars,
              tailChars: win.tailChars, retainedPrefix: source.capped,
            });
        }
      } catch { /* spill failed — the window still ships, with its elision markers */ }
    }

    // The footer is TOOL-AUTHORED (caller-computed values only, never document
    // bytes) and rides OUTSIDE the fence — document content must never be able
    // to forge or suppress it.
    const fenced = wrapUntrusted({
      origin: originOfUrl(target),
      tool: 'read_doc',
      body: `${head}\n\n${text}`,
    });
    return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
  },
});
