// @ts-check
// Shared, pure extraction of a durable engine-instance handle (an App /
// Notebook / WebVM id, plus its name when present) from a tool-result body.
//
// why a shared module: handle retention is a load-bearing capability promise
// — "if a session creates an app or workbook it retains where that is even
// after summarization/trim." Two awareness carriers keep that promise and
// must agree on what a handle IS: the lineage spine (lineage-compaction.js)
// that survives body-compaction, and the trim summary's mechanical handle
// harvest (rolling-summary.js) that survives a deep trim. One definition,
// two readers — pushed DOWN the graph so neither reaches sideways.

/** @typedef {import('/shared/tool-types.js').ToolMeta} ToolMeta */

// Engine-instance primitives — results from these carry a DURABLE handle
// (an App / Notebook / WebVM id) the agent may need to reference later. A
// stray `"id":` in a web/page result must NOT be mined as a handle, so the
// extractor is scoped to exactly these.
export const ENGINE_PRIMITIVES = new Set(['app', 'notebook', 'webvm']);

/**
 * Pull a durable instance id (+ name when present) out of an engine-instance
 * result body. Handles BOTH forms the body takes across the pipeline:
 *   - the RAW create body, JSON-then-notes: `{"id":"app-7f3a","name":"…"}…`
 *     (a full JSON.parse would throw on the trailing notes, so a cheap,
 *     anchored regex reads the leading object's fields).
 *   - an already-rendered lineage SPINE: `… · id=app-7f3a "dashboard" · …`
 *     (compaction runs before trim, so the harvester often sees the spine,
 *     not the original body).
 * The id pattern is anchored and length-bounded so a crafted `name` can't
 * smuggle a second `"id":` past the FIRST (real) one. Returns null when
 * there's nothing durable to carry.
 *
 * @param {string|undefined} primitive   the result's engine primitive
 * @param {unknown} content              the result body (raw or spine)
 * @returns {{ id: string, name: string } | null}
 */
export const extractInstanceHandle = (primitive, content) => {
  if (typeof primitive !== 'string' || !ENGINE_PRIMITIVES.has(primitive)
    || typeof content !== 'string') return null;
  // Raw create body — the FIRST "id"/"name" wins (the real fields lead).
  let id = content.match(/"id"\s*:\s*"([\w:.\-]{1,80})"/)?.[1];
  let name = content.match(/"name"\s*:\s*"([^"]{1,80})"/)?.[1] ?? '';
  if (!id) {
    // Already a spine (id=app-7f3a "dashboard"): read the handle back out.
    const m = content.match(/\bid=([\w:.\-]{1,80})(?:\s+"([^"]{1,80})")?/);
    if (m) { id = m[1]; name = m[2] ?? ''; }
  }
  return id ? { id, name } : null;
};

/**
 * A glanceable one-line handle for the trim summary's "Artifacts / handles"
 * section — `app app-7f3a "dashboard"` (name dropped when absent). Distinct
 * from the spine's `id=…` rendering: this line stands alone in the summary,
 * so it leads with the primitive for context.
 *
 * @param {string} primitive
 * @param {{ id: string, name: string }} handle
 * @returns {string}
 */
export const renderHandleLine = (primitive, { id, name }) =>
  name ? `${primitive} ${id} "${name}"` : `${primitive} ${id}`;
