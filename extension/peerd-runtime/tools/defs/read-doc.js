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
import { resolveTargetTab, originOfUrl, isDenylistedTab } from '../../browser-authority/dom-helpers.js';
import { requireEngine } from '../../pdf/engines.js';
import { formatPdfBody, DEFAULT_MAX_CHARS as DEFAULT_PDF_MAX_CHARS } from '../../pdf/extract-format.js';
import { formatDocBody, formatDocHead, DEFAULT_MAX_CHARS as DEFAULT_DOC_MAX_CHARS } from '../../doc/format.js';
import { toMarkdown } from '../../doc/markdown.js';
import { windowText, pagingFooter, excerptRelevant, excerptFooter } from '../web/spill.js';
// read_doc re-fetches bytes offscreen, so it applies the same shared lexical
// private-network refusal as open-web egress. The denylist alone does not cover
// loopback, LAN, or metadata targets.
import { isPrivateOrLocalHost } from '../../../shared/private-network.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readDocTool = composeTool("read_doc", {

  execute: async (args, ctx) => {
    // why: docOffscreenClient is injected into the tool context by the SW
    // (background/offscreen-doc-client.js) but isn't part of the shared
    // ToolContext typedef; narrow it locally to the surface this tool uses.
    const docClient = /** @type {{ extract: (source: { url: string }, opts: { format?: string, engine?: string }) => Promise<{ format: string, doc?: any, pdf?: any, bytes: number, sniffedVia: string }> } | undefined} */ (
      /** @type {any} */ (ctx).docOffscreenClient);
    if (!docClient || typeof docClient.extract !== 'function') {
      // Firefox has no offscreen-document API, so the converters have nowhere
      // to run. Say so explicitly because an
      // opaque code reads as "this document is broken" and invites a retry.
      return {
        ok: false,
        error: 'doc_reader_unavailable',
        content: 'Document conversion is not available in this browser build. '
          + 'If the document has an HTML version, read that instead.',
      };
    }

    const explicitUrl = typeof args?.url === 'string' && args.url ? args.url : null;
    let target = explicitUrl;
    if (!target) {
      const tab = await resolveTargetTab(args, ctx);
      if (!tab?.id) return { ok: false, error: 'no_target_tab' };
      target = typeof tab.url === 'string' ? tab.url : null;
      if (!target) return { ok: false, error: 'no_document_url' };
    }

    let parsed;
    try { parsed = new URL(target); }
    catch { return { ok: false, error: `invalid_url: ${target}` }; }
    if (!/^(https?|data):$/.test(parsed.protocol)) {
      return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };
    }

    // These gates cover the exact target, whether explicit or active-tab. The
    // offscreen reader issues a new fetch, so private/LAN/metadata hosts must
    // be refused exactly like open-web egress.
    if (isDenylistedTab(target, ctx.denylist)) return { ok: false, error: 'denylisted_target' };
    if (isPrivateOrLocalHost(parsed.hostname)) return { ok: false, error: 'private_or_local_target_blocked' };

    let engine = 'auto';
    if (args?.engine && args.engine !== 'auto') {
      try { engine = requireEngine(args.engine); }
      catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    }

    let result;
    try {
      result = await docClient.extract({ url: target }, { format: args.format, engine });
    } catch (e) {
      const err = /** @type {{ code?: string, message?: string }} */ (e);
      // The failures ARE the API here: each names the tool that will work
      // instead, so a wrong first guess costs one turn rather than a dead end.
      // The message already carries the specifics (from peerd-runtime/doc's
      // typed errors); the code is what the agent can branch on.
      return { ok: false, error: err?.code ?? 'doc_read_failed', content: err?.message ?? String(e) };
    }
    if (result?.pdf) {
      const maxChars = Number.isFinite(args?.maxChars) && args.maxChars > 0
        ? Math.floor(args.maxChars) : DEFAULT_PDF_MAX_CHARS;
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(target),
          tool: 'read_doc',
          body: formatPdfBody({
            pages: result.pdf.pages,
            engine: result.pdf.engine,
            pageCount: result.pdf.pageCount,
            info: result.pdf.info,
            ocrUsed: result.pdf.ocrUsed,
            scanned: result.pdf.scanned,
            ocrAvailable: result.pdf.ocrAvailable,
            maxChars,
          }),
        }),
      };
    }
    if (!result?.doc) return { ok: false, error: 'doc_read_failed', content: 'empty conversion result' };

    const maxChars = Number.isFinite(args?.maxChars) && args.maxChars > 0
      ? Math.floor(args.maxChars) : DEFAULT_DOC_MAX_CHARS;

    // SPILL-AND-PAGE, exactly as fetch_url does it. A document is the case
    // where a silent truncation hurts most — the answer is as likely to be in
    // an appendix as in the intro, and unlike a web page there is no second
    // way to reach the tail. So the FULL markdown is stored locally and the
    // model gets a window plus the read_result call that pages the rest;
    // with a query it gets the passages that MATCH instead of a blind
    // head+tail. Same idiom, same pager, same footer the actor already knows.
    const markdown = toMarkdown(result.doc);
    const head = formatDocHead({ doc: result.doc, source: target });
    const resultStore = /** @type {{ key?: () => string, put?: (r: object) => Promise<void> } | undefined} */ (
      /** @type {any} */ (ctx).resultStore);

    if (!resultStore?.key || !resultStore?.put) {
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
      const cacheKey = resultStore.key();
      try {
        // ownerSessionId stamps the OWNER — the spill store is one SW-level map
        // keyed by an opaque handle, so without it any actor holding a key could
        // page back a document a different actor fetched.
        await resultStore.put({
          key: cacheKey, url: target, format: 'markdown', text: markdown,
          ownerSessionId: ctx.session?.sessionId ?? null,
          producer: 'read_doc', fenced: true, originLabel: originOfUrl(target),
        });
        footer = ex
          ? excerptFooter({ key: cacheKey, total: ex.total, passagesShown: ex.passagesShown, passagesTotal: ex.passagesTotal, query })
          : pagingFooter({ key: cacheKey, total: win.total, headChars: win.headChars, tailChars: win.tailChars });
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
