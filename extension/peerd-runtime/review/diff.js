// @ts-check
// Diff sourcing + rendering for the reviewer.
//
// The reviewer reviews a CHANGESET. Where does the changeset come from?
// Feature 02 (search/replace edits + checkpoints) is the real source:
//   `checkpoints.diffSince(ref)` → a structured changeset. We DON'T import
// feature 02 (it builds in parallel); instead we define the thin shape we
// expect and a standalone synthesizer so feature 08 works on its own.
//
// Two ways to get a changeset, both producing the SAME {files:[...]} shape:
//   1. fromCheckpointDiff(raw) — adapt feature 02's diffSince() output.
//   2. synthesizeDiff(before, after) — compare two App/Notebook file-tree
//      snapshots ourselves (the standalone path the integrator can drop).
//
// renderDiffForReview() turns a changeset into the text block the reviewer
// sees. Pure throughout — snapshots in, strings out.

/**
 * @typedef {Object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted'} status
 * @property {string} [before]   prior content (modified/deleted)
 * @property {string} [after]    new content (added/modified)
 */

/** @typedef {{ files: FileChange[], ref?: string }} Changeset */

/**
 * Adapt feature 02's `checkpoints.diffSince(ref)` output into our
 * Changeset. Feature 02 is expected to return either our shape already, or
 * a list of {path, status, before, after} — we normalize defensively so a
 * minor interface drift on their side doesn't break us.
 *
 * @param {any} raw
 * @returns {Changeset}
 */
export const fromCheckpointDiff = (raw) => {
  if (!raw) return { files: [] };
  /** @type {any[]} */
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.files) ? raw.files : [];
  /** @type {FileChange[]} */
  const files = list
    .filter((f) => f && typeof f.path === 'string')
    .map((f) => ({
      path: f.path,
      status: /** @type {FileChange['status']} */ (
        ['added', 'modified', 'deleted'].includes(f.status) ? f.status : 'modified'
      ),
      ...(typeof f.before === 'string' ? { before: f.before } : {}),
      ...(typeof f.after === 'string' ? { after: f.after } : {}),
    }));
  return { files, ...(raw.ref ? { ref: raw.ref } : {}) };
};

/**
 * Standalone diff: compare two flat {path -> content} snapshots. This is
 * the path that makes feature 08 usable WITHOUT feature 02 — snapshot an
 * App's files before the writer runs, snapshot after, synthesize the diff.
 *
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 * @returns {Changeset}
 */
export const synthesizeDiff = (before = {}, after = {}) => {
  /** @type {FileChange[]} */
  const files = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of [...paths].sort()) {
    const had = Object.hasOwn(before, path);
    const has = Object.hasOwn(after, path);
    if (had && has) {
      if (before[path] !== after[path]) {
        files.push({ path, status: 'modified', before: before[path], after: after[path] });
      }
    } else if (has) {
      files.push({ path, status: 'added', after: after[path] });
    } else {
      files.push({ path, status: 'deleted', before: before[path] });
    }
  }
  return { files };
};

// why: a runaway diff would blow the reviewer's context + the parent's
// rate budget. Cap per-file rendered content; the reviewer is told when a
// file was truncated so it doesn't over-confidently approve unseen code.
const MAX_FILE_CHARS = 24 * 1024;

/** @param {string} s */
const clip = (s) => (s.length > MAX_FILE_CHARS
  ? `${s.slice(0, MAX_FILE_CHARS)}\n…[truncated ${s.length - MAX_FILE_CHARS} chars]`
  : s);

/**
 * Render a changeset into the text the reviewer reads. We emit a simple,
 * model-legible block per file (status header + before/after) rather than
 * a unified-diff hunk format — language models reason better over full
 * before/after than over hunk markers, and we're not constrained by terminal
 * width here.
 *
 * @param {Changeset} changeset
 * @returns {string}
 */
export const renderDiffForReview = (changeset) => {
  const files = changeset?.files ?? [];
  if (files.length === 0) return '(empty changeset — no files changed)';

  const parts = [`${files.length} file(s) changed:`, ''];
  for (const f of files) {
    parts.push(`### ${f.status.toUpperCase()}: ${f.path}`);
    if (f.status === 'deleted') {
      parts.push('--- removed content ---');
      parts.push(clip(f.before ?? ''));
    } else if (f.status === 'added') {
      parts.push('+++ new content +++');
      parts.push(clip(f.after ?? ''));
    } else {
      parts.push('--- before ---');
      parts.push(clip(f.before ?? ''));
      parts.push('+++ after +++');
      parts.push(clip(f.after ?? ''));
    }
    parts.push('');
  }
  return parts.join('\n');
};
