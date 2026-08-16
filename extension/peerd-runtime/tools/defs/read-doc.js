// @ts-check
// read_doc — read a Word / Excel / PowerPoint / OpenDocument / RTF / EPUB /
// CSV file as Markdown.
//
// An ACTOR-ONLY tool (hidden from the main agent in exposure.js, in the web
// actor's toolset): its output is UNTRUSTED document content and must land in
// the web actor's context, never the main loop — the same boundary read_page
// and read_pdf sit on.
//
// The gap it closes: an office document is not a web page and not a PDF. The
// browser does not render one — clicking the link downloads it — so snapshot
// and read_page see nothing, and fetch_url (which decodes every response as
// text) returns a screenful of mojibake that costs real context and says
// nothing. Before this tool the honest answer to "read this .xlsx" was "I
// can't"; the model instead tended to guess from the URL. read_doc converts the
// bytes to Markdown in the offscreen document and returns the text.
//
// why one tool for eight formats rather than read_docx/read_xlsx/…: the agent
// usually does NOT know which one it has. Links lie, content-types lie, and a
// tool the agent must pick correctly BEFORE it can look is a tool it will pick
// wrong. read_doc sniffs the bytes and reports what it found.

import { wrapUntrusted } from '../prompt-wrap.js';
import { originOfUrl, isDenylistedTab } from './dom-helpers.js';
import { formatDocBody, formatDocHead, DEFAULT_MAX_CHARS } from '../../doc/format.js';
import { toMarkdown } from '../../doc/markdown.js';
import { CONVERTIBLE } from '../../doc/sniff.js';
import { windowText, pagingFooter, excerptRelevant, excerptFooter } from '../web/spill.js';
// read_doc re-fetches bytes offscreen, so it applies the same shared lexical
// private-network refusal as open-web egress. The denylist alone does not cover
// loopback, LAN, or metadata targets.
import { isPrivateOrLocalHost } from '../../../shared/private-network.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readDocTool = {
  name: 'read_doc',
  primitive: 'web',
  description: [
    'Read a DOCUMENT FILE as Markdown: Word (.docx), Excel (.xlsx), PowerPoint (.pptx),',
    'OpenDocument (.odt/.ods/.odp), RTF, EPUB, and CSV/TSV. Use it whenever a link points',
    'at one of those — the browser downloads such files instead of rendering them, so',
    'navigate/snapshot show you nothing and fetch_url returns unreadable binary.',
    'Structure is preserved: headings, lists, tables, and links come back as Markdown;',
    'spreadsheets come back as one table per sheet, decks as one section per slide with',
    'speaker notes. You do NOT need to know the format in advance — it is detected from',
    'the bytes, and reported back. For a PDF use read_pdf; for an HTML page use fetch_url',
    'or open a tab. Long documents are stored whole and paged: pass a query to get the',
    'matching passages, and follow the [paging] footer to read any other part.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL of the document file.' },
      maxChars: { type: 'integer', description: `Cap on the returned Markdown (default ${DEFAULT_MAX_CHARS}). Raise it to read a long document whole.` },
      query: { type: 'string', description: 'What you are looking for in this document (a few keywords). When it is too long to show whole, the most relevant passages are surfaced (BM25) instead of a blind head+tail window — so an answer in an appendix is not missed. Omit to get the head+tail window.' },
      format: {
        type: 'string',
        enum: [...CONVERTIBLE],
        description: 'Force a format instead of detecting one. Only needed when detection got it wrong — normally omit.',
      },
    },
  },
  sideEffect: 'read',
  origins: (args) => {
    const o = originOfUrl(args?.url);
    return o ? [o] : [];
  },

  execute: async (args, ctx) => {
    // why: docOffscreenClient is injected into the tool context by the SW
    // (background/offscreen-doc-client.js) but isn't part of the shared
    // ToolContext typedef; narrow it locally to the surface this tool uses.
    const docClient = /** @type {{ extract: (source: { url: string }, opts: { format?: string }) => Promise<{ doc: any, bytes: number, sniffedVia: string }> } | undefined} */ (
      /** @type {any} */ (ctx).docOffscreenClient);
    if (!docClient || typeof docClient.extract !== 'function') {
      // Firefox has no offscreen-document API, so the converter has nowhere to
      // run (read_pdf is unavailable there for the same reason). Say so — an
      // opaque code reads as "this document is broken" and invites a retry.
      return {
        ok: false,
        error: 'doc_reader_unavailable',
        content: 'Document conversion is not available in this browser build. '
          + 'If the document has an HTML version, read that instead.',
      };
    }

    if (typeof args?.url !== 'string' || !args.url) return { ok: false, error: 'url_required' };
    let parsed;
    try { parsed = new URL(args.url); }
    catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };

    // The same two gates read_pdf applies to its url override: the denylist,
    // and the SSRF refusal (read_doc issues a NEW fetch offscreen, so a
    // private/LAN/metadata host must be refused exactly like open-web egress).
    if (isDenylistedTab(args.url, ctx.denylist)) return { ok: false, error: 'denylisted_target' };
    if (isPrivateOrLocalHost(parsed.hostname)) return { ok: false, error: 'private_or_local_target_blocked' };

    let result;
    try {
      result = await docClient.extract({ url: args.url }, { format: args.format });
    } catch (e) {
      const err = /** @type {{ code?: string, message?: string }} */ (e);
      // The failures ARE the API here: each names the tool that will work
      // instead, so a wrong first guess costs one turn rather than a dead end.
      // The message already carries the specifics (from peerd-runtime/doc's
      // typed errors); the code is what the agent can branch on.
      return { ok: false, error: err?.code ?? 'doc_read_failed', content: err?.message ?? String(e) };
    }
    if (!result?.doc) return { ok: false, error: 'doc_read_failed', content: 'empty conversion result' };

    const maxChars = Number.isFinite(args?.maxChars) && args.maxChars > 0
      ? Math.floor(args.maxChars) : DEFAULT_MAX_CHARS;

    // SPILL-AND-PAGE, exactly as fetch_url does it. A document is the case
    // where a silent truncation hurts most — the answer is as likely to be in
    // an appendix as in the intro, and unlike a web page there is no second
    // way to reach the tail. So the FULL markdown is stored locally and the
    // model gets a window plus the read_web_cache call that pages the rest;
    // with a query it gets the passages that MATCH instead of a blind
    // head+tail. Same idiom, same pager, same footer the actor already knows.
    const markdown = toMarkdown(result.doc);
    const head = formatDocHead({ doc: result.doc, source: args.url });
    const webCache = /** @type {{ key?: () => string, put?: (r: object) => Promise<void> } | undefined} */ (
      /** @type {any} */ (ctx).webCache);

    if (!webCache?.key || !webCache?.put) {
      // No spill capability → the plain capped render (which announces its cut).
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(args.url),
          tool: 'read_doc',
          body: formatDocBody({ doc: result.doc, maxChars, source: args.url }),
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
      const cacheKey = webCache.key();
      try {
        // ownerSessionId stamps the OWNER — the spill store is one SW-level map
        // keyed by an opaque handle, so without it any actor holding a key could
        // page back a document a different actor fetched.
        await webCache.put({
          key: cacheKey, url: args.url, format: 'markdown', text: markdown,
          ownerSessionId: ctx.session?.sessionId ?? null,
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
      origin: originOfUrl(args.url),
      tool: 'read_doc',
      body: `${head}\n\n${text}`,
    });
    return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
  },
};
