// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// read_web_cache — page through a spilled fetch_url body.
//
// When fetch_url's text overflows its budget, the FULL text is spilled to the
// local web_extract_cache store and the model sees a head+tail window plus a
// footer naming this tool (tools/web/spill.js). This is the read side: an
// offset/limit slice of that stored text. Web-actor-only, same exposure as
// fetch_url itself — the cache holds fetched page content, which is the web
// actor's tier (the main agent delegates via message_actor).
//
// The slice is STILL untrusted page content — it goes back out wrapped in the
// same fence fetch_url uses; only the tool-authored paging status rides
// outside it.

import { wrapUntrusted } from '../prompt-wrap.js';
import { originOfUrl } from './dom-helpers.js';
import { buildPagedResult, clampPageLimit, pageStatusLine } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readWebCacheTool = composeTool("read_web_cache", {
  execute: async (args, ctx) => {
    if (typeof args?.key !== 'string' || !args.key) return { ok: false, error: 'key_required' };
    const webCache = /** @type {{ get?: (key: string) => Promise<{ key: string, url?: string, format?: string, text: string, ownerSessionId?: string | null } | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).webCache);
    if (!webCache?.get) return { ok: false, error: 'web_cache_unavailable' };
    const rec = await webCache.get(args.key).catch(() => undefined);
    // The key is the ONLY thing standing between a caller and these bytes, and the
    // store is global to the service worker - so a key that leaked into another
    // actor's context (a reply, a shared transcript) would hand it a credentialed
    // fetch from an origin its own lock refuses. Scope the read to whoever spilled
    // it. why not fail-closed on an UNSTAMPED record: entries written before this
    // check exist in live profiles and page-out within 40 spills; refusing them
    // would break paging mid-turn on upgrade for no attacker-reachable gain.
    if (rec && rec.ownerSessionId != null && rec.ownerSessionId !== (ctx.session?.sessionId ?? null)) {
      return { ok: false, error: `not_your_cache_entry: ${args.key} was spilled by a different actor. Re-run the read yourself (fetch_url) rather than paging someone else's fetch.` };
    }
    if (!rec || typeof rec.text !== 'string') {
      return { ok: false, error: `no_such_key: ${args.key} — the cache entry may have been evicted; re-run the read that produced it (fetch_url, or read_page mode:'content' for a tab you've already rendered — don't fetch_url a page you can still see).` };
    }
    // buildPagedResult fits the FRAMED slice under the paged ceiling (the JSON
    // envelope escapes newline/quote-dense bodies past the raw cap) so the slice
    // the model asked for survives redaction intact. `paged` routes it to that
    // larger ceiling, not the 8k backstop.
    return buildPagedResult({
      text: rec.text,
      offset: typeof args.offset === 'number' ? args.offset : 0,
      limit: clampPageLimit(args.limit),
      frame: (page) => {
        // The slice is fetched page content — fenced exactly like the fetch that
        // produced it. The paging status is tool-authored → outside the fence.
        const fenced = wrapUntrusted({
          origin: originOfUrl(rec.url ?? '') ?? 'cache',
          tool: 'read_web_cache',
          body: JSON.stringify({
            key: rec.key,
            url: rec.url ?? null,
            format: rec.format ?? 'raw',
            offset: page.offset,
            end: page.end,
            total: page.total,
            body: page.slice,
          }, null, 2),
        });
        const status = pageStatusLine({ page, nextArgs: `{ "key": "${rec.key}", "offset": ${page.end} }` });
        return `${fenced}\n${status}`;
      },
    });
  },
});
