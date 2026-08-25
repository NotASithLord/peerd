// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// read_pdf — extract the text of a PDF loaded in a tab.
//
// An ACTOR-ONLY tool (hidden from the main agent in exposure.js, in the web
// actor's DOM toolset): like every page-content reader, its output is
// UNTRUSTED and must land in the web actor's context, never the main loop.
// The main agent reaches the page by messaging the tab's actor.
//
// Chrome renders PDFs in a built-in viewer that the DOM tools can't read
// (it's an embedded plugin, not scriptable HTML), so snapshot/read_page come
// back empty on a PDF tab. read_pdf closes that gap: it parses the PDF bytes
// with pdf.js in the offscreen document and returns the text layer, wrapped in
// <untrusted_web_content>. Born-digital PDFs work out of the box; scanned PDFs
// need the opt-in OCR engine (Settings → Voice & OCR) and are flagged when it
// isn't installed.

import { wrapUntrusted } from '../prompt-wrap.js';
import { resolveTargetTab, originOfUrl, isDenylistedTab } from './dom-helpers.js';
import { requireEngine } from '../../pdf/engines.js';
import { formatPdfBody, DEFAULT_MAX_CHARS } from '../../pdf/extract-format.js';
// read_pdf re-fetches bytes offscreen, so it applies the same shared lexical
// private-network refusal as open-web egress. The denylist alone does not cover
// loopback, LAN, or metadata targets.
import { isPrivateOrLocalHost } from '../../../shared/private-network.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readPdfTool = composeTool("read_pdf", {

  execute: async (args, ctx) => {
    // why: pdfOffscreenClient is injected into the tool context by the SW
    // (background/offscreen-pdf-client.js) but isn't part of the shared
    // ToolContext typedef; narrow it locally to the surface this tool uses.
    const pdfClient = /** @type {{ extract: (source: { url: string }, opts: { engine: string }) => Promise<{ pages: Array<{page:number,text:string}>, engine: string, pageCount: number, info: object, ocrUsed: boolean, scanned: boolean, ocrAvailable: boolean } | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).pdfOffscreenClient);
    if (!pdfClient || typeof pdfClient.extract !== 'function') {
      return { ok: false, error: 'pdf_reader_unavailable' };
    }
    // Resolve the tab (also enforces the denylist on the resolved tab).
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // An explicit url override gets its OWN denylist check (resolveTargetTab
    // only vetted the tab) — never read a PDF from a denylisted host.
    const target = (typeof args?.url === 'string' && args.url) ? args.url : tab.url;
    if (!target) return { ok: false, error: 'no_pdf_url' };
    if (args?.url && isDenylistedTab(args.url, ctx.denylist)) {
      return { ok: false, error: 'denylisted_target' };
    }
    // SSRF refusal: read_pdf issues a NEW fetch for the bytes (offscreen), so it
    // must refuse loopback / LAN / link-local / metadata targets exactly like
    // open-web egress does — for the tab URL too, not just an explicit url arg
    // (a page can sit the tab on a private host). data:/blob: have no hostname.
    let targetHost = '';
    try { targetHost = new URL(target).hostname; } catch { /* data:/opaque — no host */ }
    if (targetHost && isPrivateOrLocalHost(targetHost)) {
      return { ok: false, error: 'private_or_local_target_blocked' };
    }

    let engineArg = 'auto';
    if (args?.engine && args.engine !== 'auto') {
      try { engineArg = requireEngine(args.engine); }
      catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
    }

    let result;
    try {
      result = await pdfClient.extract({ url: target }, { engine: engineArg });
    } catch (e) {
      return { ok: false, error: `pdf_read_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (result === undefined) return { ok: false, error: 'pdf_read_failed: empty result' };

    const maxChars = Number.isFinite(args?.maxChars) && args.maxChars > 0
      ? Math.floor(args.maxChars) : DEFAULT_MAX_CHARS;

    const body = formatPdfBody({
      pages: result.pages,
      engine: result.engine,
      pageCount: result.pageCount,
      info: result.info,
      ocrUsed: result.ocrUsed,
      scanned: result.scanned,
      ocrAvailable: result.ocrAvailable,
      maxChars,
    });

    return {
      ok: true,
      content: wrapUntrusted({ origin: originOfUrl(target), tool: 'read_pdf', body }),
    };
  },
});
