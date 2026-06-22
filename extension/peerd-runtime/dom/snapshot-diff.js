// @ts-check
// peerd-runtime/dom — snapshot diff (DOM nav, Phase 2).
//
// Diff two a11y snapshots and emit only what CHANGED, so the model's
// context grows with actions, not page size. Refs (@e<n>) reallocate on
// every snapshot, so we diff by the STABLE backendDOMNodeId instead:
//
//   added   — a node present in `next` but not `prev`     → `+ @e5 button "Send"`
//   removed — a node present in `prev` but not `next`     → `- button "Cancel"`
//   changed — same node, different descriptor (state/value/name)
//                                                        → `~ @e3 button "Send": …→…`
//
// Pure (values in, values out): fully unit-testable without a browser.
// This is the "diffable observation" half of Phase 2; the CDP re-fetch
// that feeds it lives in the snapshot tool, and a content-script
// MutationObserver (true incremental streaming) is a later optimization.

// Stable node identity across two snapshots: CDP trees carry a
// backendDOMNodeId; DOM-walk pseudo-snapshots carry a walkId (stable per
// element within one document — walk-injected.js). The two id spaces are
// disjoint by construction (a capture is entirely one source or the
// other), but prefix-namespace them anyway so a mixed prev/next pair
// (CDP snapshot, then automation toggled off, then walk snapshot) can
// never alias.
/** @param {SnapRef | null | undefined} r */
const identityOf = (r) => {
  if (r?.backendDOMNodeId != null) return `b${r.backendDOMNodeId}`;
  if (r?.walkId != null) return `w${r.walkId}`;
  return null;
};

/**
 * One snapshot ref record (the shape the snapshot tool stores in the ref
 * registry). added/removed entries in the diff ARE these input records —
 * the diff never strips fields — and changed entries pair two of them.
 *
 * @typedef {Object} SnapRef
 * @property {string} ref                          '@e<n>' — reallocated per snapshot
 * @property {number | null} backendDOMNodeId      CDP identity; null for walk snapshots
 * @property {number | null} [walkId]              DOM-walk identity; the serializer always
 *                                                  writes it (`walkId ?? null`), so CDP
 *                                                  snapshots carry null rather than omit it
 * @property {string} role
 * @property {string} name
 * @property {string} desc
 */

/**
 * @param {SnapRef[]} prev
 * @param {SnapRef[]} next
 * @returns {{ text: string, added: SnapRef[], removed: SnapRef[], changed: Array<{ before: SnapRef, after: SnapRef }>, unchanged: number }}
 */
export const diffSnapshots = (prev, next) => {
  const prevByNode = new Map();
  for (const r of prev ?? []) {
    const id = identityOf(r);
    if (id != null) prevByNode.set(id, r);
  }
  const seen = new Set();

  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const r of next ?? []) {
    const id = identityOf(r);
    if (id == null) { added.push(r); continue; } // no identity → treat as new
    seen.add(id);
    const before = prevByNode.get(id);
    if (!before) { added.push(r); }
    else if (before.desc !== r.desc) { changed.push({ before, after: r }); }
    else { unchanged += 1; }
  }

  const removed = [];
  for (const r of prev ?? []) {
    const id = identityOf(r);
    if (id != null && !seen.has(id)) removed.push(r);
  }

  const lines = [];
  for (const r of added) lines.push(`+ ${r.ref} ${r.desc}`);
  for (const { before, after } of changed) lines.push(`~ ${after.ref} ${after.role}${after.name ? ` "${after.name}"` : ''}: ${before.desc} → ${after.desc}`);
  for (const r of removed) lines.push(`- ${r.desc}`);

  const text = lines.length
    ? lines.join('\n')
    : 'no change since last snapshot';

  return { text, added, removed, changed, unchanged };
};
