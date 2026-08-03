// @ts-check
// read_run_cache — page through a spilled `script` [VALUE].
//
// read_web_cache's twin, one tier down: when a run's serialized value
// overflows the [VALUE] cap, the FULL text is spilled to the runCache store
// (tools/run-cache.js) and the result footer names this tool. Main-agent
// (script is a main-agent tool), unlike read_web_cache: the cache holds the
// agent's own run output, not fetched page content.
//
// Two refusals, both fail-closed:
//   • OWNERSHIP — the record is stamped with the session whose run spilled;
//     another session's key is refused (the same containment the web-cache
//     design leans on: no cross-session laundering through a shared cache).
//   • FENCE — CONDITIONAL, decided by the record's stored `fenced` flag, never
//     re-derived here: a value from an egress/actors/workspace run re-enters
//     wrapped under the run's own origin label; a pure-compute value is the
//     agent's own bytes and re-enters raw.

import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine, SPILL_PAGE_CHARS } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readRunCacheTool = {
  name: 'read_run_cache',
  primitive: 'notebook',
  description: [
    'Read a slice of a spilled script [VALUE]. When a run\'s returned value overflows',
    'its cap the full text is stored locally and the result names the cache key — page',
    'through it here with { key, offset, limit }. Offsets are character positions into',
    'the stored text; the result reports what remains. Page DELIBERATELY: prefer',
    're-running the script to return a compact aggregate over walking a huge blob.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['key'],
    properties: {
      key: { type: 'string', description: 'The cache key from the script paging note.' },
      offset: { type: 'number', description: 'Start character offset. Default 0.' },
      limit: { type: 'number', description: `Max characters to return (capped at ${SPILL_PAGE_CHARS}). Default the cap.` },
    },
  },
  sideEffect: 'read',
  // The cache is local — no network origin is touched by a page read.
  origins: () => [],
  execute: async (args, ctx) => {
    if (typeof args?.key !== 'string' || !args.key) return { ok: false, error: 'key_required' };
    const runCache = /** @type {{ get?: (key: string) => Promise<import('../run-cache.js').RunCacheRecord | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).runCache);
    if (!runCache?.get) return { ok: false, error: 'run_cache_unavailable' };
    const rec = await runCache.get(args.key).catch(() => undefined);
    // Ownership BEFORE existence (read_web_cache's ordering): a spilled value
    // belongs to the session whose run produced it, so a foreign key is refused
    // as not_your_key before we reveal whether it holds text — the refusal can't
    // double as an existence probe. Fail closed on ANY mismatch (including a
    // missing session); a missing record still falls through to no_such_key.
    const sid = ctx.session?.sessionId ?? '';
    if (rec && (!sid || rec.ownerSessionId !== sid)) {
      return { ok: false, error: `not_your_key: ${args.key} was spilled by another session.` };
    }
    if (!rec || typeof rec.text !== 'string') {
      return { ok: false, error: `no_such_key: ${args.key} — the cache entry may have been evicted; re-run the script that produced it (and return a more compact value if you can).` };
    }
    // buildPagedResult fits the FRAMED slice under the paged ceiling (the JSON
    // envelope escapes quote/backslash-dense values well past the raw cap) so the
    // slice the model asked for survives redaction intact — else the loop re-cuts
    // its middle. `paged` routes it to that larger ceiling, not the 8k backstop.
    return buildPagedResult({
      text: rec.text,
      offset: typeof args.offset === 'number' ? args.offset : 0,
      limit: clampPageLimit(args.limit),
      frame: (page) => {
        const body = JSON.stringify({
          key: rec.key,
          offset: page.offset,
          end: page.end,
          total: page.total,
          value: page.slice,
        }, null, 2);
        const status = pageStatusLine({ page, nextArgs: `{ "key": "${rec.key}", "offset": ${page.end} }` });
        // Fence exactly as the run's own output was fenced — the stored flag, not
        // a re-derivation. The paging status is tool-authored → outside the fence.
        const shown = rec.fenced
          ? wrapUntrusted({ origin: rec.originLabel || 'script', tool: 'read_run_cache', body })
          : body;
        return `${shown}\n${status}`;
      },
    });
  },
};
