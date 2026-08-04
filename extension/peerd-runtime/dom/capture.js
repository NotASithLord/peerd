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
import { domWalkInjected, hasPasswordFieldInjected } from './walk-injected.js';

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
 * `hasPasswordField` (issue 251) is the origin-sensitivity signal, NOT model-facing:
 * it never reaches the snapshot text, only the classifier that decides whether an
 * origin is one the user has an identity on. `null` means unknown — a probe that
 * could not run — and must never be read as `false`.
 *
 * `probeOrigin` says WHERE that signal was observed. The caller's tab record is
 * resolved before this runs, so the two can disagree if the page navigates in
 * between; a caller that cannot attribute the signal must drop it rather than
 * credit it to the wrong origin (issue 278). `null` = unknown, same posture.
 *
 * @returns {Promise<
 *   { ok: true, source: 'cdp'|'dom-walk', text: string, refs: object[],
 *     truncated: boolean, capped: boolean, nodeCount: number, refCount: number,
 *     hasPasswordField: boolean | null, probeOrigin?: string | null }
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
    // issue 251 — the password-field signal, which the a11y tree cannot carry
    // (a password input and a search box are both role `textbox`). One extra
    // injection, and a cheap one next to a full tree fetch. `null` on any
    // failure means UNKNOWN, never false: the classifier must not read "we could
    // not look" as "there is nothing here".
    let hasPasswordField = /** @type {boolean | null} */ (null);
    // Where the probe ran, which is NOT necessarily where the caller thinks the
    // tab is — the caller's tab record predates this injection. Null = unknown.
    let probeOrigin = /** @type {string | null} */ (null);
    if (typeof scripting?.executeScript === 'function') {
      try {
        const probe = await scripting.executeScript({ target: { tabId: tab.id }, func: hasPasswordFieldInjected });
        const v = probe?.[0]?.result;
        if (typeof v?.has === 'boolean') { hasPasswordField = v.has; probeOrigin = typeof v.origin === 'string' ? v.origin : null; }
      } catch { hasPasswordField = null; probeOrigin = null; }
    }
    return { ok: true, source: 'cdp', capped: false, hasPasswordField, probeOrigin, ...serializeAxTree(nodes, { budget }) };
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
  return {
    ok: true,
    source: 'dom-walk',
    capped: !!walk.capped,
    // The walk reports both inline — free, since it is already in the page.
    hasPasswordField: typeof walk.hasPasswordField === 'boolean' ? walk.hasPasswordField : null,
    probeOrigin: typeof walk.probeOrigin === 'string' ? walk.probeOrigin : null,
    ...serializeAxTree(walk.nodes, { budget }),
  };
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

/**
 * Can a password-field signal observed by the probe be credited to `origin`?
 *
 * The tab record is resolved BEFORE the capture and the probe runs after, in
 * whatever document is committed by then. A page that navigates cross-origin
 * inside that window would otherwise have its password field recorded against
 * the origin we started on — which lets a hostile page mark arbitrary third
 * parties as "the user has an account here" (roaming helpers are then refused
 * there), and, repeated, fills the learned-origin cap so nothing further is
 * ever learned (issue 278).
 *
 * `null` from the probe is UNKNOWN, not a mismatch: an opaque document cannot
 * report its origin, and treating that as a mismatch would silently stop
 * learning on pages where the signal is still the caller's own. That is the
 * same posture as reading `hasPasswordField === true` strictly.
 *
 * @param {string | null | undefined} probeOrigin  where the probe says it ran
 * @param {string | null | undefined} origin       where the caller thinks it ran
 * @returns {boolean}
 */
export const signalIsAttributable = (probeOrigin, origin) =>
  probeOrigin == null || probeOrigin === origin;
