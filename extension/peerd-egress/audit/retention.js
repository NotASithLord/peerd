// @ts-check
// Audit-log retention policy — the pure half of capped retention.
//
// The log stays append-only in SEMANTICS (entries are never updated,
// ids stay UUIDv7-chronological) but no longer unbounded in SIZE: once
// the store crosses the cap, the oldest entries are pruned. All the
// arithmetic lives here as values-in/values-out functions so Bun can
// exercise it; the IO (count / ranged delete) stays in audit/log.js.

// Why 20k: a long-lived install writes a handful of entries per tool
// call, so tens of thousands ≈ weeks-to-months of history — enough for
// the Logs view and inspect_audit_log (which cap reads at 500 anyway)
// while keeping getAll() on the Logs path comfortably fast. Defined
// here, next to the module's other defaults (DEFAULT_AUTO_LOCK_MS), and
// overridable per build via CHANNEL_DEFAULTS.auditLogMaxEntries.
export const DEFAULT_AUDIT_MAX_ENTRIES = 20_000;

// Why amortized: a count-then-prune on EVERY append would double the
// log's write cost for no benefit — overshoot between checks is bounded
// by this batch size (the store briefly holds at most max + 255
// entries), which is noise against a 20k cap. One cheap count() per 256
// appends is the entire steady-state overhead.
export const DEFAULT_PRUNE_CHECK_EVERY = 256;

/**
 * Coerce a configured cap to something safe. Anything that isn't a
 * positive finite number (absent build key, 0, NaN, negative) falls
 * back to the default — "no cap" is deliberately NOT expressible, since
 * unbounded growth is the failure mode this exists to fix.
 *
 * @param {unknown} value
 * @returns {number}
 */
export const normalizeMaxEntries = (value) =>
  (typeof value === 'number' && Number.isFinite(value) && value >= 1)
    ? Math.floor(value)
    : DEFAULT_AUDIT_MAX_ENTRIES;

/**
 * How many oldest entries to delete to get back under the cap.
 *
 * @param {number} total       current entry count
 * @param {number} maxEntries  retention cap
 * @returns {number}           0 when within the cap
 */
export const excessEntries = (total, maxEntries) =>
  Math.max(0, total - maxEntries);
