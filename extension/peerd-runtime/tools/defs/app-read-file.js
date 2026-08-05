// @ts-check
// app_read_file — read a single file from an App's OPFS subtree.
//
// Fenced like js_read_file: an App's files can embed data its actor pulled
// from the owning actor's files (Apps have no ambient fetch), so
// an unfenced global read would launder untrusted bytes into the
// orchestrator's trusted context. Reads stay global; the fence pays for it.

import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine, SPILL_PAGE_CHARS } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appReadFileTool = {
  name: 'app_read_file',
  primitive: 'app',
  description: [
    'Read a single file from an App\'s OPFS subtree. Returns UTF-8 text.',
    'Use to inspect current content before patching. A large file returns a',
    'bounded slice plus a paging note — re-call with offset to read on (no',
    're-truncation). Without `appId`, targets the chat\'s current app.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      path: { type: 'string' },
      offset: { type: 'number', description: 'Start character offset. Default 0.' },
      limit: { type: 'number', description: `Max characters to return (capped at ${SPILL_PAGE_CHARS}). Default the cap.` },
    },
    required: ['path'],
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ readFile?: (opts: { appId?: string, path: string, sessionId?: string }) => Promise<string> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.readFile) return { ok: false, error: 'app_not_available' };
    try {
      const content = await appClient.readFile({
        appId: args.appId,
        path: args.path,
        sessionId: ctx.session?.sessionId,
      });
      // Self-paging (the infinite-reread fix, mirroring js_read_file): the OPFS
      // file is the durable backing, so a big read returns a bounded slice and
      // the footer re-calls THIS tool at a new offset — no spill store, no
      // main-agent reader the app actor could not reach (off the actor tier).
      // buildPagedResult flags `paged` and fits the framed slice under the paged
      // ceiling so the requested page survives redaction intact.
      return buildPagedResult({
        text: content,
        offset: typeof args.offset === 'number' ? args.offset : 0,
        limit: clampPageLimit(args.limit),
        // nextArgs is JSON.stringify'd so an appId/path with a quote/backslash
        // stays a valid next-call hint.
        frame: (page) => {
          const shown = wrapUntrusted({
            origin: `app:${args.appId ?? 'current'}/${args.path}`,
            tool: 'app_read_file',
            body: page.slice,
          });
          const nextArgs = JSON.stringify({
            ...(args.appId ? { appId: args.appId } : {}),
            path: args.path,
            offset: page.end,
          });
          const footer = (page.remaining > 0 || page.offset > 0)
            ? `\n${pageStatusLine({ page, nextArgs })}`
            : '';
          return `${shown}${footer}`;
        },
      });
    } catch (e) {
      return { ok: false, error: `app_read_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
