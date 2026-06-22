// @ts-check
// peerd-runtime/dom — element ref registry (DOM nav, Phase 1).
//
// Harness-owned map of opaque element refs (@e<n>) → the DOM node they
// point at. The model picks a ref out of a snapshot; an action resolves
// that ref back to a backendDOMNodeId for CDP dispatch. Keeping the
// ref→node mapping on OUR side (never the model's) is what makes refs
// robust where CSS selectors are fragile.
//
// Lifecycle (Phase 1): refs are PER-SNAPSHOT. Taking a new snapshot of a
// tab replaces that tab's ref set and bumps its generation; a resolve
// against a stale ref returns null and the tool tells the model to
// re-snapshot. Phase 2 will carry stable attributes so refs survive
// mutations between snapshots (and the MutationObserver re-bases them).
//
// Stateful object, but the logic is small and unit-testable without a
// browser. One instance lives in the SW (see buildToolContext: ctx.domRefs).

export const createRefRegistry = () => {
  /**
   * @typedef {{ ref: string, backendDOMNodeId: number|null, walkId?: number|null, role?: string, name?: string }} SnapshotRef
   * @typedef {{ backendDOMNodeId: number|null, walkId: number|null, role: string, name: string }} RefEntry
   * @typedef {{ gen: number, byRef: Map<string, RefEntry>, list: SnapshotRef[] }} TabRefs
   */
  /** @type {Map<number, TabRefs>} */
  const tabs = new Map();

  /**
   * Replace a tab's ref set from a fresh snapshot. Returns the count.
   * @param {number} tabId
   * @param {SnapshotRef[]} refs
   */
  const setSnapshot = (tabId, refs) => {
    const list = (refs ?? []).filter((r) => r && typeof r.ref === 'string');
    /** @type {Map<string, RefEntry>} */
    const byRef = new Map();
    for (const r of list) {
      byRef.set(r.ref, {
        backendDOMNodeId: r.backendDOMNodeId ?? null,
        // DOM-walk pseudo-snapshot identity (Firefox / advanced
        // automation off) — resolved page-side instead of via CDP.
        walkId: r.walkId ?? null,
        role: r.role ?? '',
        name: r.name ?? '',
      });
    }
    const prev = tabs.get(tabId);
    // Retain the full ref list (incl. desc) so the NEXT snapshot can diff
    // against it by backendDOMNodeId.
    tabs.set(tabId, { gen: (prev?.gen ?? 0) + 1, byRef, list });
    return byRef.size;
  };

  /**
   * Resolve a ref to its node entry, or null if unknown/stale.
   * @param {number} tabId
   * @param {string} ref
   */
  const resolve = (tabId, ref) => tabs.get(tabId)?.byRef.get(ref) ?? null;

  /**
   * The current snapshot's full ref list (with desc), for diffing.
   * @param {number} tabId
   */
  const getRefs = (tabId) => tabs.get(tabId)?.list ?? [];

  /**
   * Drop a tab's refs (e.g. on navigation or tab close).
   * @param {number} tabId
   */
  const clear = (tabId) => { tabs.delete(tabId); };

  /**
   * Live ref count for a tab — used by the dom-walk in-browser suite.
   * @param {number} tabId
   */
  const size = (tabId) => tabs.get(tabId)?.byRef.size ?? 0;

  /**
   * Monotonic per-tab snapshot counter — used to detect staleness.
   * @param {number} tabId
   */
  const generation = (tabId) => tabs.get(tabId)?.gen ?? 0;

  return { setSnapshot, resolve, getRefs, clear, size, generation };
};
