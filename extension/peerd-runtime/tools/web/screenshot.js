// @ts-check
// capture — screenshot of the active tab.
//
// chrome.tabs.captureVisibleTab requires either the activeTab grant
// (which we have at session start) or <all_urls> host permission.
// V1 captures the active tab by default; explicit windowId is
// supported for multi-window setups.
//
// The result is a base64 data URL. We return it inline; downstream
// rendering (in the side panel chat view) detects the data URL and
// renders the image. For agent consumption, the model can include
// the image in a follow-up vision request — V1 doesn't push it
// directly into context because most provider adapters don't support
// inline base64 images at the schema layer yet.

import { captureVisible } from './primitives.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const captureTool = {
  name: 'capture',
  primitive: 'tab',
  description: [
    'Take a screenshot of the visible region of the active tab and show',
    'it to the USER inline in chat. IMPORTANT: you (the model) do NOT',
    'receive the image — its bytes are stripped from your context and',
    'only metadata (dimensions, origin) comes back to you. This is a',
    '"show the user a picture" tool, not a way for you to see the page.',
    'To READ or reason about page content, use read_page / query_dom /',
    'page_exec. Reach for capture only when the user explicitly wants to',
    'SEE something rendered.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      windowId: {
        type: 'integer',
        description: 'Optional window id; defaults to the current window.',
      },
    },
  },
  sideEffect: 'read',
  origins: (_args, ctx) => {
    return ctx?.activeTab?.origin ? [ctx.activeTab.origin] : [];
  },
  execute: async (args, ctx) => {
    try {
      const dataUrl = await captureVisible(args?.windowId, ctx);
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return { ok: false, error: 'capture_returned_unexpected_shape' };
      }
      return {
        ok: true,
        content: JSON.stringify({
          format: 'png',
          dataUrl,
          bytes: estimateBase64Bytes(dataUrl),
          origin: ctx?.activeTab?.origin ?? null,
          tabUrl: ctx?.activeTab?.url ?? null,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `capture_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
    }
  },
};

/**
 * Rough decode size from a "data:image/...;base64,XXXX" URL. Useful
 * for the side panel to decide whether to inline the image or show a
 * link.
 *
 * @param {string} dataUrl
 * @returns {number}
 */
const estimateBase64Bytes = (dataUrl) => {
  const idx = dataUrl.indexOf(',');
  if (idx < 0) return 0;
  const b64 = dataUrl.slice(idx + 1);
  // why: every 4 base64 chars = 3 bytes, modulo padding. Close enough
  // for a size hint.
  return Math.floor((b64.length * 3) / 4);
};
