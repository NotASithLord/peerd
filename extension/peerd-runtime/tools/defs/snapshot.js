// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// snapshot — read a tab as an ACCESSIBILITY-TREE snapshot with element refs.
//
// The a11y-tree-+-refs paradigm (DOM nav Phase 1). Where read_page hands
// the model raw DOM text + CSS selectors, snapshot hands it the semantic
// tree (roles, names, state) with an opaque ref (@e1, @e2…) on every
// interactable. The model picks a ref; click/type resolve it to the real
// node. No model-authored selectors → the "selector not found" failure
// class disappears.
//
// Observation has two channels behind ONE contract (dom/capture.js):
// CDP Accessibility.getFullAXTree when the debugger pool is wired, else a
// chrome.scripting DOM-walk pseudo-snapshot (Firefox has no debugger API;
// Chrome can turn advanced automation off). The result header names the
// channel so the model — and the user reading the transcript — can tell a
// real AX tree from the fallback. The pure serializer + ref registry live
// in peerd-runtime/dom. Output is wrapped <untrusted_web_content> like
// every other DOM tool.

import { wrapUntrusted } from '../prompt-wrap.js';
import { resolveTargetTab, originOfUrl } from './dom-helpers.js';
import { captureSnapshot, describeSource } from '../../dom/capture.js';
import { diffSnapshots } from '../../dom/snapshot-diff.js';

/** @typedef {import('../../dom/snapshot-diff.js').SnapRef} SnapRef */
/**
 * The harness ref registry (createRefRegistry). why: it's injected onto ctx
 * by the SW (buildToolContext) but isn't on the ToolContext typedef, so DOM
 * tools narrow ctx through this shape with an erased cast.
 *
 * @typedef {Object} DomRefs
 * @property {(tabId: number) => SnapRef[]} [getRefs]
 * @property {(tabId: number, refs: SnapRef[]) => number} [setSnapshot]
 * @property {(tabId: number, ref: string) => ({ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }) | null} [resolve]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const snapshotTool = composeTool("snapshot", {

  execute: async (args, ctx) => {
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };
    const budget = Number.isFinite(args?.budget) && args.budget > 0
      ? Math.min(args.budget, 40000) : 8000;
    // why: domRefs is the SW-injected ref registry, not on the ToolContext
    // typedef — narrow it through an erased cast.
    const domRefs = /** @type {{ domRefs?: DomRefs }} */ (ctx).domRefs;
    // Grab the PREVIOUS snapshot's refs (for diff) BEFORE replacing them.
    const prevRefs = args?.diff ? (domRefs?.getRefs?.(tab.id) ?? []) : [];

    // CDP when the pool is wired; DOM-walk pseudo-snapshot otherwise
    // (Firefox, or Chrome with advanced automation off). Same serializer,
    // same ref contract — the header below names the channel.
    const cap = await captureSnapshot(tab, ctx, { budget });
    if (!cap.ok) return cap.refusal ?? { ok: false, error: cap.error };
    const { text, truncated, capped, refCount, source } = cap;
    // why: captureSnapshot types refs loosely as object[]; the serializer
    // emits the SnapRef shape the registry + differ expect — restate it.
    const refs = /** @type {SnapRef[]} */ (cap.refs);
    // Register the refs so a later click/type({ref}) on this tab resolves them.
    domRefs?.setSnapshot?.(tab.id, refs);
    const origin = originOfUrl(tab.url);
    // why: `capped` (DOM-walk node-count limit) is a DIFFERENT truncation
    // from `truncated` (char budget) — a capped tree stops mid-DOM, so the
    // model must not read a missing element as "absent". Surface it always.
    const cappedNote = capped
      ? ' (node cap hit — page larger than the DOM-walk limit; focus a smaller region/tab to see the rest)'
      : '';

    if (args?.diff && prevRefs.length) {
      const { text: diffText } = diffSnapshots(prevRefs, refs);
      const header = `${describeSource(source)} diff since last snapshot — ${refCount} refs now`
        + `${truncated ? ' (truncated)' : ''}${cappedNote}\n`;
      return { ok: true, content: wrapUntrusted({ origin, tool: 'snapshot', body: header + diffText }) };
    }

    const header = `${describeSource(source)} — ${refCount} interactable refs`
      + `${truncated ? ' (truncated; raise budget or focus a region)' : ''}${cappedNote}\n`;
    return {
      ok: true,
      content: wrapUntrusted({ origin, tool: 'snapshot', body: header + text }),
    };
  },
});
