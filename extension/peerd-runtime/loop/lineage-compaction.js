// @ts-check
// Lineage-based body compaction — the functional core.
//
// In a long agentic session the BULK of the prompt is tool-result bodies
// (page snapshots, command stdout, search dumps). This shrinks OLD bodies
// to their dispatcher-lineage spine — what tool ran, on what primitive,
// touching what origin, with what outcome — keeping a faithful "what
// happened" record at ~1 line instead of ~2k tokens, while the full body
// stays in the at-rest session record (so /undo and the transcript are
// untouched; only what's SENT shrinks).
//
// It runs BEFORE the rolling summary (trim.js): deterministic and
// structure-safe, it usually brings the estimate under budget on its own,
// so the lossy model-written summary fires far less often. Three properties
// make it safe:
//   - structure-preserving — only block CONTENT shrinks; blocks never move
//     or drop, so the tool_use/tool_result pairing the provider 400s on is
//     preserved by construction (no boundary-snap needed).
//   - immutable — returns NEW message/block objects; the persisted record is
//     never mutated (same posture as trim.js).
//   - deterministic & monotonic-in-practice — recomputed each turn from the
//     full bodies; a block that's old enough to compact stays old, so its
//     spine bytes are stable across turns (cache-friendly).
//
// Recovery is "re-run the tool" (fresher than a stale snapshot anyway);
// there is deliberately no re-expansion tool or body store. The classifier
// keeps the results that are costly to re-run — writes, mutations, errors,
// expensive computes — uncompacted longest.

import { estimateMessagesTokens, estimateTextTokens } from './estimate.js';
import { extractInstanceHandle } from './instance-handle.js';

/** @typedef {import('../../peerd-provider/types.js').InternalMessage} InternalMessage */
/** @typedef {import('/shared/tool-types.js').ToolMeta} ToolMeta */

// Protect the most recent N messages' bodies — the agent's working set is
// never compacted. Well above one tool round so an in-flight task keeps its
// full results.
export const COMPACT_KEEP_RECENT = 8;
// Don't bother compacting a body smaller than this — the spine isn't a win.
export const COMPACT_MIN_BYTES = 400;
// Same trigger/target fractions as the trim (trim.js): compaction fires at
// TRIGGER × window and cuts toward TARGET × window, then the summary (if
// still over) is the deep backstop.
export const COMPACT_TRIGGER_FRACTION = 0.75;
export const COMPACT_TARGET_FRACTION = 0.55;
// A "read" whose execute() took longer than this is treated as costly to
// re-run (a long vm_exec / notebook compute), so it's compacted later — the
// classifier's stand-in for the cut re-expansion tool.
export const EXPENSIVE_MS = 5000;

// Priority sentinel: never body-compact this result (the summary backstop
// can still collapse it, but its body never becomes a spine).
const NEVER = Infinity;

// The marker every spine starts with — also how we detect an already-
// compacted block defensively (idempotence).
const SPINE_MARK = '‹elided›';

/**
 * True if a content string is already a rendered spine.
 * @param {unknown} content
 */
const isSpine = (content) => typeof content === 'string' && content.startsWith(SPINE_MARK);

/**
 * Bytes (chars) a block's content currently contributes.
 * @param {unknown} content
 */
const contentLen = (content) => (typeof content === 'string' ? content.length : 0);

/**
 * Render the durable instance handle into the spine's `id=…` form, so
 * compacting an engine result to a spine doesn't lose the one thing the
 * agent needs to reopen/act on it later. Extraction lives in the shared
 * instance-handle module (the trim summary harvests the same handles).
 * '' when there's nothing to carry.
 *
 * @param {Partial<ToolMeta>} meta
 * @param {unknown} content
 * @returns {string}
 */
const extractHandle = (meta, content) => {
  const handle = meta ? extractInstanceHandle(meta.primitive, content) : null;
  if (!handle) return '';
  return handle.name ? `id=${handle.id} "${handle.name}"` : `id=${handle.id}`;
};

/**
 * "312 chars" / "7.9k chars" — glanceable size for the spine.
 * @param {number} n
 */
const humanChars = (n) =>
  n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;

/**
 * First touched origin, scheme-stripped, with a `+N` when more than one —
 * the "where" half of the spine. Tolerates missing / malformed origins.
 * @param {unknown} origins
 * @returns {string}
 */
const firstOrigin = (origins) => {
  if (!Array.isArray(origins)) return '';
  const clean = origins.filter((o) => typeof o === 'string' && o.length > 0);
  if (clean.length === 0) return '';
  const head = clean[0].replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  return clean.length > 1 ? `${head} +${clean.length - 1}` : head;
};

/**
 * Render one tool-result block to its lineage spine. Pure: block in, string
 * out — no model, no network. Defensive about missing meta (a block from an
 * older session, or a non-result, still renders a minimal line).
 *
 * `‹elided› {tool} · {primitive}/{origin} · {ok|error} · {N chars}`
 *
 * @param {{ content?: unknown, is_error?: boolean, meta?: Partial<ToolMeta> }} block
 * @returns {string}
 */
export const renderLineageLine = (block) => {
  const meta = (block && typeof block.meta === 'object' && block.meta) || {};
  const tool = typeof meta.toolName === 'string' && meta.toolName ? meta.toolName : 'tool';
  const primitive = typeof meta.primitive === 'string' ? meta.primitive : '';
  const origin = firstOrigin(meta.origins);
  const where = primitive
    ? (origin ? `${primitive}/${origin}` : primitive)
    : origin;
  const outcome = block && block.is_error ? 'error' : 'ok';
  // why: a created App/Notebook/WebVM's id is the durable handle — keep it
  // in the spine so a long, compacted session can still reopen or act on the
  // instance (it persists in the engine registry) instead of recreating it.
  const handle = extractHandle(meta, block && block.content);
  const parts = [SPINE_MARK, tool];
  if (where) parts.push(`· ${where}`);
  parts.push(`· ${outcome}`);
  if (handle) parts.push(`· ${handle}`);
  parts.push(`· ${humanChars(contentLen(block && block.content))}`);
  return parts.join(' ');
};

/**
 * Default lineage classifier: lower number → compact sooner; NEVER → never
 * body-compact. Keys off the spine's `sideEffect` + outcome + cost so the
 * cheapest, most-recoverable bulk goes first and decision-bearing /
 * expensive results are protected longest (the cut re-expansion tool's job).
 *
 * @param {{ is_error?: boolean, meta?: Partial<ToolMeta> }} block
 * @returns {number}
 */
export const defaultClassify = (block) => {
  const meta = (block && typeof block.meta === 'object' && block.meta) || {};
  const se = meta.sideEffect;
  // Decisions & receipts (forms submitted, files deleted) — never compacted
  // to a spine; often non-idempotent to re-run.
  if (se === 'mutate_external' || se === 'destructive') return NEVER;
  // Errors carry the cause needed to recover — keep longer than clean reads.
  if (block && block.is_error) return 3;
  // State changes the agent may reference back.
  if (se === 'write') return 2;
  // read + ok: cheap to re-run goes first; an expensive compute goes later.
  const expensive = typeof meta.durationMs === 'number' && meta.durationMs > EXPENSIVE_MS;
  return expensive ? 2 : 1;
};

/**
 * Plan a body-compaction pass over the in-flight history. Pure: returns NEW
 * messages with eligible tool-result bodies shrunk to their spine; the input
 * (and the persisted record) are not mutated.
 *
 * No-op unless `contextWindow > 0` AND the estimate exceeds
 * `triggerFraction × contextWindow`. When it fires, compacts eligible blocks
 * in classifier-priority order (cheapest first), biggest-within-priority
 * first, until the estimate falls under `targetFraction × contextWindow`
 * (or the eligible set is exhausted).
 *
 * Eligible = a tool-result block in the messages BEFORE the protected tail
 * (`keepRecent`), with a string body ≥ `minBytes`, not already a spine, and
 * not classified NEVER.
 *
 * @param {readonly InternalMessage[]} messages
 * @param {Object} [opts]
 * @param {number} [opts.contextWindow]   active model's window; 0/absent → no-op
 * @param {number} [opts.keepRecent]      protect the last N messages' bodies (default 8)
 * @param {number} [opts.minBytes]        skip bodies smaller than this (default 400)
 * @param {number} [opts.triggerFraction] fraction of the window that fires compaction (default 0.75)
 * @param {number} [opts.targetFraction]  fraction to cut toward (default 0.55)
 * @param {string} [opts.system]          system prompt, counted toward the estimate
 * @param {(messages: readonly InternalMessage[], system?: string) => number} [opts.estimateTokens]
 * @param {(block: object) => number} [opts.classify]   lineage classifier (default defaultClassify)
 * @returns {{ messages: InternalMessage[], didCompact: boolean, compactedCount: number }}
 */
export const planBodyCompaction = (messages, opts = {}) => {
  const keepRecent = opts.keepRecent ?? COMPACT_KEEP_RECENT;
  const minBytes = opts.minBytes ?? COMPACT_MIN_BYTES;
  const contextWindow = opts.contextWindow ?? 0;
  const triggerFraction = opts.triggerFraction ?? COMPACT_TRIGGER_FRACTION;
  const targetFraction = opts.targetFraction ?? COMPACT_TARGET_FRACTION;
  const estimate = opts.estimateTokens ?? estimateMessagesTokens;
  const classify = opts.classify ?? defaultClassify;
  const system = opts.system ?? '';
  const noop = () => ({
    messages: Array.isArray(messages) ? [...messages] : [],
    didCompact: false,
    compactedCount: 0,
  });
  if (!Array.isArray(messages) || contextWindow <= 0) return noop();

  const total = estimate(messages, system);
  if (total <= triggerFraction * contextWindow) return noop();
  const target = targetFraction * contextWindow;

  // Gather eligible blocks from the un-protected prefix. (Tool results live on
  // the loop's `toolResults` array shape; the converter's block form appears
  // only downstream of this point, so we key off `toolResults`.)
  const cutoff = Math.max(0, messages.length - keepRecent);
  /** @type {{ mi: number, bi: number, prio: number, len: number, spine: string }[]} */
  const eligible = [];
  for (const [mi, msg] of messages.entries()) {
    if (mi >= cutoff) break; // prefix only — early-exit past the protected tail
    const results = msg && Array.isArray(msg.toolResults) ? msg.toolResults : null;
    if (!results) continue;
    for (const [bi, block] of results.entries()) {
      if (!block || typeof block.content !== 'string') continue;
      if (block.content.length < minBytes || isSpine(block.content)) continue;
      const prio = classify(block);
      if (!Number.isFinite(prio)) continue; // NEVER (or garbage) → skip
      eligible.push({ mi, bi, prio, len: block.content.length, spine: renderLineageLine(block) });
    }
  }
  if (eligible.length === 0) return noop();

  // Cheapest/least-valuable first; within a priority, biggest body first
  // (most savings per compaction). Tie-break by position for determinism.
  eligible.sort((a, b) => a.prio - b.prio || b.len - a.len || a.mi - b.mi || a.bi - b.bi);

  // Greedily compact until the estimate falls under target.
  const toCompact = new Map(); // `${mi}:${bi}` → spine
  let running = total;
  for (const e of eligible) {
    if (running <= target) break;
    const saved = estimateTextTokens(messages[e.mi].toolResults[e.bi].content) - estimateTextTokens(e.spine);
    if (saved <= 0) continue; // spine somehow not smaller — leave it
    toCompact.set(`${e.mi}:${e.bi}`, e.spine);
    running -= saved;
  }
  if (toCompact.size === 0) return noop();

  // Rebuild immutably: new objects only where a block actually changes.
  const out = messages.map((msg, mi) => {
    if (mi >= cutoff || !msg || !Array.isArray(msg.toolResults)) return msg;
    let changed = false;
    /** @type {import('../../peerd-provider/types.js').ToolResultBlock[]} */
    const results = msg.toolResults;
    const newResults = results.map((block, bi) => {
      const spine = toCompact.get(`${mi}:${bi}`);
      if (spine === undefined) return block;
      changed = true;
      // why no `compacted` marker: nothing reads it (idempotence is detected
      // by the ‹elided› content prefix, isSpine), and an asymmetric field on
      // some result blocks but not others is forward-fragile for any future
      // block-equality / cache-key logic. The spine content is the signal.
      return { ...block, content: spine };
    });
    return changed ? { ...msg, toolResults: newResults } : msg;
  });
  return { messages: out, didCompact: true, compactedCount: toCompact.size };
};
