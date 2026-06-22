// @ts-check
// Checkpoint manager — the imperative shell over the snapshot store.
//
// Bridges peerd's real browser-native workspaces (App OPFS subtrees,
// Notebook OPFS scratch) to content-addressed checkpoints. A checkpoint is
// "the state of one workspace after a turn". Snapshots exist for ONE
// consumer today: review's diffSince (the feature-08 `since` path). The
// capture chain stays cheap and parent-linked (see the `why` on capture)
// so a future rollback affordance could walk it.
//
// Workspace IO is injected as a `workspace` adapter so this stays
// testable and so a single shape covers App and Notebook alike:
//
//   workspace.readAll()                -> Promise<Record<path, content>>
//   workspace.writeFile(path, content) -> Promise<void>
//   workspace.deleteFile(path)         -> Promise<void>
//
// The SW binds these to appClient / jsClient for a given scope (see
// service-worker.js). The manager itself never imports OPFS.

/**
 * @typedef {Object} WorkspaceAdapter
 * @property {() => Promise<Record<string,string>>} readAll
 * @property {(path: string, content: string) => Promise<void>} writeFile
 * @property {(path: string) => Promise<void>} deleteFile
 */

/**
 * @param {Object} deps
 * @param {ReturnType<import('./snapshot-store.js').createSnapshotStore>} deps.store
 * @param {(scope: string) => WorkspaceAdapter | null} deps.workspaceFor
 *   Resolve a workspace adapter for a scope string (e.g. 'app:abc').
 *   Returns null for an unknown/unresolvable scope — both call sites here
 *   null-guard and degrade gracefully (capture returns null, diffSince
 *   returns an empty diff) rather than crashing on a missing workspace.
 * @param {() => number} [deps.now]
 */
export const createCheckpointManager = ({ store, workspaceFor, now = Date.now }) => {
  /**
   * Capture the current state of a scope's workspace as a new checkpoint,
   * chained to the scope's latest checkpoint as parent. Returns the
   * manifest, or null if the workspace adapter can't be resolved.
   *
   * why parent-chaining persists post-rollback-removal: each checkpoint
   * records its parent explicitly (timestamp ordering alone is ambiguous
   * — two captures in the same ms are possible), so history stays a
   * deterministic single-linked chain that a future rollback could walk.
   *
   * @param {Object} args
   * @param {string} args.scope
   * @param {string|null} [args.label]
   * @param {object} [args.meta]
   * @returns {Promise<import('./snapshot-store.js').Manifest|null>}
   */
  const capture = async ({ scope, label = null, meta = {} }) => {
    const ws = workspaceFor(scope);
    if (!ws) return null;
    const files = await ws.readAll();
    const [latest] = await store.list(scope);
    // why: skip a no-op capture. If nothing changed since the last
    // checkpoint, recording another identical manifest just clutters the
    // undo stack. We compare materialized content maps by file hash set.
    if (latest) {
      const prevFiles = latest.files;
      const sameKeys =
        Object.keys(prevFiles).length === Object.keys(files).length;
      if (sameKeys) {
        let identical = true;
        // Hash each current file once; cheap relative to a turn.
        for (const [path, content] of Object.entries(files)) {
          const h = await store.putBlob(content); // dedup: returns hash
          if (prevFiles[path] !== h) { identical = false; break; }
        }
        if (identical) return latest; // nothing to record
      }
    }
    return store.capture({
      scope,
      files,
      label,
      parentId: latest ? latest.id : null,
      meta: { ...meta, capturedAt: now() },
    });
  };

  /**
   * Files changed between a checkpoint and the CURRENT workspace state.
   * The feature-08 review adapter: requestReview's `since` path consumes
   * this shape directly (review/diff.js fromCheckpointDiff).
   *
   * `ref` optional — defaults to the scope's latest checkpoint. Returns
   * { files: [{ path, status, before?, after? }], ref? }; empty files when
   * there is no checkpoint or no workspace adapter (nothing to diff is a
   * benign no-review, not an error — the orchestrator short-circuits).
   *
   * @param {Object} args
   * @param {string|null} [args.scope]   required when ref is omitted
   * @param {string|null} [args.ref]     checkpoint id to diff FROM
   */
  const diffSince = async ({ scope = null, ref = null } = {}) => {
    const cp = ref
      ? await store.getCheckpoint(ref)
      : (scope ? (await store.list(scope))[0] ?? null : null);
    if (!cp) return { files: [] };
    const ws = workspaceFor(cp.scope);
    if (!ws) return { files: [] };
    const before = (await store.materialize(cp.id)) ?? {};
    const after = await ws.readAll();
    const files = [];
    for (const [path, content] of Object.entries(after)) {
      if (!(path in before)) files.push({ path, status: 'added', after: content });
      else if (before[path] !== content) {
        files.push({ path, status: 'modified', before: before[path], after: content });
      }
    }
    for (const [path, content] of Object.entries(before)) {
      if (!(path in after)) files.push({ path, status: 'deleted', before: content });
    }
    return { files, ref: cp.id };
  };

  return { capture, diffSince };
};
