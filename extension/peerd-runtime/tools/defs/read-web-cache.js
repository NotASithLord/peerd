// @ts-check
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
import { pageSlice, pageStatusLine, SPILL_PAGE_CHARS } from '../web/spill.js';

// Same per-call ceiling as fetch_url's body budget — one page of cache reads
// like one fetch — and the ONE shared paging slice size (web/spill.js).
const MAX_SLICE_CHARS = SPILL_PAGE_CHARS;

/** @type {import('/shared/tool-types.js').Tool} */
export const readWebCacheTool = {
  name: 'read_web_cache',
  primitive: 'web',
  description: [
    'Read a slice of a spilled fetch_url / read_page body. When a read overflows its',
    'budget the full text is stored locally and the result names the cache key — page',
    'through it here with { key, offset, limit }. Offsets are character positions into',
    'the stored text; the result reports what remains after the slice. Page',
    'DELIBERATELY: the head+tail window you already saw usually carries the answer —',
    'one or two targeted slices should settle it. Do not walk the whole document.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['key'],
    properties: {
      key: { type: 'string', description: 'The cache key from the fetch_url paging note.' },
      offset: { type: 'number', description: 'Start character offset. Default 0.' },
      limit: { type: 'number', description: `Max characters to return (capped at ${MAX_SLICE_CHARS}). Default the cap.` },
    },
  },
  sideEffect: 'read',
  // The cache is local — no network origin is touched by a page read.
  origins: () => [],
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
    const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : MAX_SLICE_CHARS, MAX_SLICE_CHARS);
    const page = pageSlice(rec.text, typeof args.offset === 'number' ? args.offset : 0, limit);
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
    // paged: the loop redacts this at PAGED_MAX_CHARS, not the 8k backstop — the
    // slice the model asked for survives intact (else half of every page is lost).
    return { ok: true, content: `${fenced}\n${status}`, paged: true };
  },
};
