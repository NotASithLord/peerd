// @ts-check
// peerd-runtime/dom — snapshot capture (one contract, two observation
// channels).
//
// The single place that decides HOW a tab gets observed as an a11y-style
// tree:
//
//   1. CDP (Accessibility.getFullAXTree via the debugger pool) — the real
//      accessibility tree. Chrome with advanced automation on.
//   2. DOM-walk pseudo-snapshot (walk-injected.js via chrome.scripting) —
//      Firefox (no debugger API at all) or Chrome with the
//      advancedAutomationEnabled setting off.
//
// Both channels feed the SAME pure serializer, so the snapshot tool, the
// ref registry, the diff, and the runner's pre-seeding never fork on the
// source — they just read `source` when they want to say which channel
// produced the capture. IO (debuggerPool / scripting) is injected via ctx,
// never imported, per the functional-core rule.
//
// Fallback policy: the walk runs only when the pool is ABSENT from ctx
// (capability missing), not when a CDP call errors — a CDP failure on a
// tab that should support it is a real signal the model needs to see, not
// something to paper over with a weaker observation.

import { serializeAxTree } from './ax-serialize.js';
import { domWalkInjected } from './walk-injected.js';

/**
 * Capture a snapshot of a tab via CDP or the DOM-walk fallback.
 *
 * @param {{ id: number }} tab        the resolved target tab
 * @param {object} ctx               tool context — debuggerPool? / scripting?
 *   are injected IO off the ToolContext spine; narrowed to their read surface
 *   locally below (they don't live on the typed ToolContext contract)
 * @param {{ budget?: number }} [opts]
 * `capped` (DOM-walk only) is the NODE-COUNT cap — the walk hit its
 * MAX_VISITED/MAX_EMITTED bound and stopped mid-DOM. This is distinct from
 * `truncated` (the serializer's CHAR-budget cut): a page can be capped
 * without being truncated and vice-versa. The CDP tree is never node-capped,
 * so the CDP path reports `capped: false`. Callers surface BOTH so the model
 * can't mistake a partial tree for a complete one.
 *
 * @returns {Promise<
 *   { ok: true, source: 'cdp'|'dom-walk', text: string, refs: object[],
 *     truncated: boolean, capped: boolean, nodeCount: number, refCount: number }
 *   | { ok: false, source: 'cdp'|'dom-walk'|'none', error: string }>}
 */
export const captureSnapshot = async (tab, ctx, { budget = 8000 } = {}) => {
  // why: debuggerPool / scripting are SW-injected IO not on the typed
  // ToolContext spine — narrow each to its read surface here.
  const debuggerPool = /** @type {{ getAxTree(tabId: number): Promise<Parameters<typeof serializeAxTree>[0]> } | undefined} */ (
    /** @type {{ debuggerPool?: unknown }} */ (ctx).debuggerPool);
  const scripting = /** @type {{ executeScript(opts: object): Promise<Array<{ result?: any }>> } | undefined} */ (
    /** @type {{ scripting?: unknown }} */ (ctx).scripting);
  if (typeof debuggerPool?.getAxTree === 'function') {
    let nodes;
    try {
      nodes = await debuggerPool.getAxTree(tab.id);
    } catch (e) {
      return { ok: false, source: 'cdp', error: `axtree_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    return { ok: true, source: 'cdp', capped: false, ...serializeAxTree(nodes, { budget }) };
  }

  if (typeof scripting?.executeScript !== 'function') {
    return {
      ok: false,
      source: 'none',
      error: 'snapshot_unavailable: no CDP pool and no scripting API in this context',
    };
  }

  let walk;
  try {
    const results = await scripting.executeScript({
      target: { tabId: tab.id },
      func: domWalkInjected,
    });
    walk = results?.[0]?.result;
  } catch (e) {
    // Pages the browser refuses to inject into (chrome:/about:, the
    // extension stores) land here — same class of refusal CDP attach has.
    return { ok: false, source: 'dom-walk', error: `dom_walk_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  if (!walk?.ok || !Array.isArray(walk.nodes)) {
    return {
      ok: false,
      source: 'dom-walk',
      error: `dom_walk_failed: ${walk?.error ?? 'no result from the injected walk'}`,
    };
  }
  return { ok: true, source: 'dom-walk', capped: !!walk.capped, ...serializeAxTree(walk.nodes, { budget }) };
};

/**
 * One-line, model-facing label for where a capture came from — used in
 * snapshot headers so a fallback capture SAYS it's a fallback (and names
 * its limits) instead of impersonating the real AX tree.
 * @param {'cdp'|'dom-walk'|'none'} source
 */
export const describeSource = (source) => (
  source === 'dom-walk'
    ? 'pseudo-a11y snapshot (DOM-walk fallback — no CDP here; top frame only)'
    : 'a11y snapshot'
);
