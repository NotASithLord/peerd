// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_read_file — read a single file from an App's OPFS subtree.
//
// Fenced like js_read_file: an App's files can embed data its actor pulled
// from the owning actor's files (Apps have no ambient fetch), so
// an unfenced global read would launder untrusted bytes into the
// orchestrator's trusted context. Reads stay global; the fence pays for it.

import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appReadFileTool = composeTool("app_read_file", {

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
      if (args.query !== undefined) {
        if (typeof args.query !== 'string' || !args.query || args.query.length > 500) {
          return { ok: false, error: 'query_must_be_1_to_500_characters' };
        }
        const startAt = Math.max(0, Math.min(content.length, Math.trunc(Number(args.offset) || 0)));
        const matches = [];
        let cursor = startAt;
        while (matches.length < 20) {
          const found = content.indexOf(args.query, cursor);
          if (found < 0) break;
          const before = Math.max(0, found - 240);
          const after = Math.min(content.length, found + args.query.length + 240);
          matches.push({
            offset: found,
            snippet: `${before > 0 ? '…' : ''}${content.slice(before, after)}${after < content.length ? '…' : ''}`,
          });
          cursor = found + Math.max(1, args.query.length);
        }
        const more = matches.length === 20 && content.indexOf(args.query, cursor) >= 0;
        return {
          ok: true,
          content: wrapUntrusted({
            origin: `app:${args.appId ?? 'current'}/${args.path}`,
            tool: 'app_read_file',
            body: JSON.stringify({
              query: args.query,
              matches,
              ...(more ? { nextOffset: cursor } : {}),
            }, null, 2),
          }),
        };
      }
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
      const detail = /** @type {{ message?: string, code?: string }} */ (e);
      return {
        ok: false,
        ...(detail?.code ? { code: detail.code } : {}),
        error: `app_read_file_failed: ${detail?.message ?? String(e)}`,
      };
    }
  },
});
