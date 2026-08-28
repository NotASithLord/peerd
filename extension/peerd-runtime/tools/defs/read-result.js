// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// read_result: page any oversized result emitted by a supported producer.
//
// One session-owned opaque store serves fetch_url, read_doc, read_page, and
// script. The stored record:not the caller:decides the source label, metadata,
// and whether the page must re-enter fenced.
//
// Two refusals, both fail-closed:
//   • OWNERSHIP: the record is stamped with the session whose run spilled;
//     another session's key is refused (the same containment the web-cache
//     design leans on: no cross-session laundering through a shared cache).
//   • FENCE: CONDITIONAL, decided by the record's stored `fenced` flag, never
//     re-derived here: a value from an egress/actors/workspace run re-enters
//     wrapped under the run's own origin label; a pure-compute value is the
//     agent's own bytes and re-enters raw.

import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readResultTool = composeTool('read_result', {
  execute: async (args, ctx) => {
    if (typeof args?.key !== 'string' || !args.key) return { ok: false, error: 'key_required' };
    const authority = /** @type {{readResult?:(key:string)=>Promise<{ok:boolean,record?:import('../result-store.js').ResultSpillRecord,error?:string}>}|undefined} */ (
      /** @type {any} */ (ctx).resourceAuthority);
    if (!authority?.readResult) return { ok: false, error: 'result_store_unavailable' };
    const read = /** @type {{ok:boolean,record?:import('../result-store.js').ResultSpillRecord,error?:string}} */ (
      await authority.readResult(args.key).catch(() => ({ ok: false })));
    if (read?.ok !== true && read?.error) return { ok: false, error: read.error };
    const rec = read?.record;
    if (!rec || typeof rec.text !== 'string') {
      return { ok: false, error: `no_such_result: ${args.key}: the spill may have been evicted; re-run the producing tool.` };
    }
    // buildPagedResult fits the FRAMED slice under the paged ceiling (the JSON
    // envelope escapes quote/backslash-dense values well past the raw cap) so the
    // slice the model asked for survives redaction intact: else the loop re-cuts
    // its middle. `paged` routes it to that larger ceiling, not the 8k backstop.
    return buildPagedResult({
      text: rec.text,
      offset: typeof args.offset === 'number' ? args.offset : 0,
      limit: clampPageLimit(args.limit),
      frame: (page) => {
        const body = JSON.stringify({
          key: rec.key,
          producer: rec.producer,
          origin: rec.originLabel,
          ...(rec.url ? { url: rec.url } : {}),
          ...(rec.format ? { format: rec.format } : {}),
          offset: page.offset,
          end: page.end,
          total: page.total,
          body: page.slice,
        }, null, 2);
        const status = pageStatusLine({ page, nextArgs: `{ "key": "${rec.key}", "offset": ${page.end} }` });
        // Fence exactly as the run's own output was fenced: the stored flag, not
        // a re-derivation. The paging status is tool-authored → outside the fence.
        const shown = rec.fenced
          ? wrapUntrusted({ origin: rec.originLabel || rec.producer, tool: 'read_result', body })
          : body;
        return `${shown}\n${status}`;
      },
    });
  },
});
