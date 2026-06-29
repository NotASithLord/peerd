// @ts-check
// columnar.js — lossless densification of uniform record lists.
//
// why: the catalog/inspect tools (actor_list, inspect_session_access,
// app_list_files, app_search) each serialize an
// ARRAY OF IDENTICALLY-SHAPED record objects. Pretty-printed JSON repeats
// every key name AND its indentation once PER record — a 30-VM list prints
// the same seven keys thirty times. That blob is persisted in message
// history and re-shipped to the model on every subsequent turn, so the
// waste compounds across the whole session and counts against the
// rate-limit and spend budget.
//
// The fix is the classic columnar transpose: name the keys ONCE, then emit
// one positional row per record. It stays valid JSON — every value keeps
// its type, and nested arrays/objects ride along as whole cells — so it is
// exactly lossless, and a modern model reads "columns + rows" without help.
// The redactor (loop/redact.js) truncates oversized results head/tail
// (lossy); shrinking the blob here means fewer lists reach that cliff.
//
// Deliberately NOT wired into inspect_audit_log: its entries carry an
// arbitrary nested `details` object and an optional field, so they're often
// non-uniform — the guard below would silently fall back run-to-run, and an
// audit surface should serialize predictably, not shape-shift.

// Below this many records the column header costs more than the repeated
// keys it saves, so we leave the list in its original form. Matches the
// >=5 gate the reference implementation settled on.
const MIN_ROWS = 5;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Transpose a uniform array of plain-object records into { columns, rows }.
 *
 * Returns null when the array isn't worth — or isn't safe — to densify:
 *   - not an array, or fewer than MIN_ROWS records
 *   - any element isn't a plain object (arrays/scalars/null)
 *   - the records don't all share one identical key SET. A non-uniform list
 *     would need per-row key bookkeeping that erases the savings and risks
 *     conflating "key absent" with "value null"; falling back keeps it
 *     lossless.
 *
 * Pure. Reads values by column NAME, so record key ORDER is irrelevant.
 *
 * @param {unknown} records
 * @returns {{ columns: string[], rows: unknown[][] } | null}
 */
export const columnarize = (records) => {
  if (!Array.isArray(records) || records.length < MIN_ROWS) return null;
  if (!records.every(isPlainObject)) return null;

  const columns = Object.keys(records[0]);
  if (columns.length === 0) return null;

  // why: identical key SET, not just count — same size AND every column
  // present in every record means the sets are equal (subset + equal size).
  const uniform = records.every((r) => {
    const keys = Object.keys(r);
    return keys.length === columns.length && columns.every((c) => Object.hasOwn(r, c));
  });
  if (!uniform) return null;

  const rows = records.map((r) => columns.map((c) => r[c]));
  return { columns, rows };
};

/**
 * Serialize a tool-result wrapper of shape { ...scalars, [listKey]: Record[] }.
 *
 * When the list densifies, the array is replaced by a positional
 * `<listKey>_columns` / `<listKey>_rows` pair (plus a one-line
 * `<listKey>_format` legend so the reader knows rows align to columns by
 * index) and the whole object is emitted COMPACT — the column encoding is
 * the savings; re-adding pretty-print indentation would hand some of it
 * straight back. When it doesn't densify, the wrapper is emitted unchanged
 * as pretty JSON, byte-for-byte identical to the pre-densifier output.
 *
 * Pure.
 *
 * @param {Record<string, unknown>} wrapper
 * @param {string} listKey   the wrapper key holding the record array
 * @returns {string}
 */
export const serializeListResult = (wrapper, listKey) => {
  const cols = columnarize(wrapper?.[listKey]);
  if (!cols) return JSON.stringify(wrapper, null, 2);

  const { [listKey]: _omitted, ...rest } = wrapper;
  return JSON.stringify({
    ...rest,
    [`${listKey}_format`]: `columnar — each row in ${listKey}_rows aligns by index to ${listKey}_columns`,
    [`${listKey}_columns`]: cols.columns,
    [`${listKey}_rows`]: cols.rows,
  });
};
