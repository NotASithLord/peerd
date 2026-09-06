// @ts-check

// view: SEE the visible region of the active tab as an image.
//
// The DOM tools (snapshot/read_page/query_dom) read a page's accessibility tree
// and text. They go BLIND on pages that render to a canvas or paint their own
// pixels: Figma, games, charts, p5.js sketches, image-only PDFs. `view`
// captures the visible region and hands the model the ACTUAL PIXELS as a vision
// input, so it can reason about (and then act on) content the DOM can't express.
//
// Unlike `capture` (a "show the USER a picture" tool whose bytes are stripped
// before the model sees them: loop/redact.js), `view` returns the image to the
// MODEL: it sets ToolResultBlock.images, which the agent loop delivers as a real
// image block on the next step (send-once-then-strip, like a user attachment :
// the bytes never persist or re-ship). content stays bytes-free metadata.
//
// CAPTURE THE GATED TAB, NOT THE FOREGROUND TAB. The runner drives ONE pinned
// tab, usually in the background. captureVisibleTab only ever grabs the window's
// foreground tab, so it is never a valid model-vision primitive: a tab switch can
// make it photograph unrelated private pixels after policy approved the pinned
// tab. `view` uses exact-tab capture only: CDP Page.captureScreenshot when wired,
// or Firefox tabs.captureTab(tabId). A browser without either path fails closed.
//
// Security: a screenshot is UNTRUSTED page content. Text painted into the image
// (a fake "system" banner, an "ignore your instructions" overlay) is an
// injection vector the model must not obey. `view` is actor-only (hidden from
// the main agent), so the same untrusted-content boundary that fences read_page
// output covers what it surfaces; the note in the result reinforces it.

import {
  BrowserAutomationPolicyError,
  browserDocumentIdentity,
  browserDocumentRefusalReceiptFrom,
  browserTargetRefusalReceipt,
  resolveTargetTab,
  unverifiedBrowserTargetVerdict,
} from '/peerd-runtime/browser-authority.js';
import { CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS } from '/shared/controller-kernel-quota.js';

/** @param {any} args @param {any} ctx */
export const captureOwnedTabPixelsAuthority = async (args, ctx) => {
    try {
      // Resolve + denylist-validate the REAL target (the pinned tab, or args.tabId).
      const tab = await resolveTargetTab(args, /** @type {any} */ (ctx));
      if (!tab || typeof tab.id !== 'number') {
        return { ok: false, error: 'view_no_target_tab: target tab is missing or denylisted' };
      }
      const expectedDocument = browserDocumentIdentity(tab);

      /** @type {{ captureScreenshot?: (id: number, o?: { format?: 'jpeg'|'png', quality?: number, expectedDocument?: ReturnType<typeof browserDocumentIdentity> }) => Promise<{ data: string, mediaType: string }> } | undefined} */
      const pool = /** @type {any} */ (ctx).debuggerPool;
      /** @type {{ captureTab?: (tabId: number, opts?: { format?: 'jpeg'|'png', quality?: number }) => Promise<string> } | undefined} */
      const tabs = /** @type {any} */ (ctx).tabs;

      let mediaType = 'image/jpeg';
      let data = '';
      if (pool && typeof pool.captureScreenshot === 'function') {
        // CDP binds the exact browser document before and after the protocol read.
        const shot = await pool.captureScreenshot(tab.id, {
          format: 'jpeg', quality: 70, expectedDocument,
        });
        data = shot?.data ?? '';
        mediaType = shot?.mediaType ?? 'image/jpeg';
      } else if (typeof tabs?.captureTab === 'function') {
        // Firefox captures this tab by id, including when it is backgrounded.
        const dataUrl = await tabs.captureTab(tab.id, { format: 'jpeg', quality: 70 });
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          return { ok: false, error: 'view_capture_unexpected_shape' };
        }
        const semi = dataUrl.indexOf(';');
        const comma = dataUrl.indexOf(',');
        mediaType = semi > 5 ? dataUrl.slice(5, semi) : 'image/jpeg';
        data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
      } else {
        return {
          ok: false,
          error: 'view_exact_tab_capture_unavailable: this browser cannot safely send tab pixels to the model because no exact-tab capture API is available. On Chrome, use a preview or dev build with Advanced automation. Otherwise use snapshot, read_page, or query_dom.',
        };
      }

      if (!data) return { ok: false, error: 'view_capture_empty' };
      const afterTab = await resolveTargetTab({ tabId: tab.id }, /** @type {any} */ (ctx));
      if (!sameDocument(afterTab, tab, expectedDocument)) {
        return browserTargetRefusalReceipt(unverifiedBrowserTargetVerdict({
          message: 'The page changed while peerd captured it. The screenshot was discarded.',
        }), { effectCompleted: false });
      }
      if (data.length > CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS) {
        return { ok: false, error: 'view_screenshot_too_large' };
      }

      return {
        ok: true,
        receipt: { mediaType, data, url: tab.url ?? '' },
      };
    } catch (e) {
      if (e instanceof BrowserAutomationPolicyError) {
        return browserTargetRefusalReceipt(e.structured, { effectCompleted: false });
      }
      const refusal = browserDocumentRefusalReceiptFrom(e);
      if (refusal) return refusal;
      return { ok: false, error: `view_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
    }
};

/**
 * @param {any} actual
 * @param {any} expectedTab
 * @param {ReturnType<typeof browserDocumentIdentity>} expectedDocument
 */
const sameDocument = (actual, expectedTab, expectedDocument) => {
  if (!actual || actual.id !== expectedTab.id) return false;
  try {
    const actualDocument = browserDocumentIdentity(actual);
    return actualDocument.origin === expectedDocument.origin
      && actualDocument.href === expectedDocument.href
      && actualDocument.documentId === expectedDocument.documentId
      && actualDocument.timeOrigin === expectedDocument.timeOrigin;
  } catch {
    return false;
  }
};
