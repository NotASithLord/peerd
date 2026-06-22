// @ts-check
// read_state — read the React/Vue component state behind an element.
//
// For framework apps the rendered DOM is a lossy projection of the real
// state. This reads the source: the owning component's props + state from
// the framework internals (React fiber / Vue component) in the page's MAIN
// world. Two channels, ONE contract:
//   - CDP: resolve a snapshot {ref} → node → Runtime.callFunctionOn (the
//     debugger-pool path). Used when the CDP pool is wired.
//   - chrome.scripting world:'MAIN' on a CSS {selector} (framework-state.js
//     readFrameworkStateInjected). Works WITHOUT CDP — Firefox, the store
//     Chrome package, or advanced automation off. The DOM-walk's walkId map
//     lives in the ISOLATED world (invisible from MAIN), so a walk {ref}
//     can't be bridged there; a {selector} can. Hence: on the no-CDP
//     channel, pass a selector (from read_page / query_dom).

import { wrapUntrusted } from '../prompt-wrap.js';
import { resolveTargetTab, originOfUrl } from './dom-helpers.js';
import { readFrameworkStateInjected } from '../../dom/index.js';

/**
 * The harness ref-registry entry shape (resolve()). Injected onto ctx by the
 * SW; not on the ToolContext typedef, so the DOM tools narrow through these.
 *
 * @typedef {{ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }} RefEntry
 * @typedef {{ resolve?: (tabId: number, ref: string) => RefEntry | null }} DomRefs
 * @typedef {{ readFrameworkState?: (tabId: number, backendDOMNodeId: number) => Promise<{ ok: true, [k: string]: any } | { ok: false, error?: string }> }} DebuggerPool
 * @typedef {{ domRefs?: DomRefs, debuggerPool?: DebuggerPool }} DomCtxExtras
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const readStateTool = {
  name: 'read_state',
  primitive: 'tab',
  description: [
    'Read the framework component state behind an element. For React/Vue',
    'apps, returns the owning component\'s name + props + state straight from',
    'the framework internals (MAIN world) — cleaner and more stable than',
    'scraping rendered DOM. Use when you need a component\'s data: "what\'s in',
    'this form\'s state?", "is this toggle on?". Identify the element by a',
    'snapshot {ref} (e.g. "@e3") OR a CSS {selector} (from read_page /',
    'query_dom). The {selector} form works WITHOUT advanced automation/CDP',
    '(Firefox, or a DOM-walk snapshot) — prefer it there. Returns { framework,',
    'component, props, state }, or framework:null when the element isn\'t',
    'inside a known framework. Defaults to the active tab.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'An element ref from a snapshot (e.g. "@e3"). Resolved via CDP. One of ref|selector is required.' },
      selector: { type: 'string', description: 'A CSS selector for the element (from read_page / query_dom). Read via chrome.scripting in the page\'s MAIN world — no CDP needed. One of ref|selector is required.' },
      tabId: { type: 'integer', description: 'Optional tab id; defaults to the active tab.' },
    },
  },
  sideEffect: 'read',
  origins: (_args, ctx) => (ctx.activeTab?.origin ? [ctx.activeTab.origin] : []),

  execute: async (args, ctx) => {
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // why: domRefs + debuggerPool are SW-injected onto ctx but absent from the
    // ToolContext typedef — narrow them through an erased cast.
    const { domRefs, debuggerPool } = /** @type {DomCtxExtras} */ (ctx);

    // Selector path: read via chrome.scripting world:'MAIN'. No CDP needed —
    // querySelector resolves the node in the page's own JS context where the
    // React fiber / Vue internals live. resolveTargetTab already enforced the
    // denylist, so this can't run on a sensitive tab.
    const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
    if (selector) return readViaScripting(tab, selector, ctx);

    if (typeof args?.ref !== 'string' || !args.ref.trim()) {
      return { ok: false, error: 'ref_or_selector_required' };
    }
    const entry = domRefs?.resolve?.(tab.id, args.ref.trim());
    if (!entry) return { ok: false, error: `stale_ref: ${args.ref} — re-run snapshot on this tab first` };
    if (entry.backendDOMNodeId == null) {
      // A DOM-walk pseudo-snapshot ref (no CDP): walkId→element lives in the
      // ISOLATED world, unreachable from the MAIN world the fiber read needs.
      // Can't bridge a walk ref — but a CSS {selector} CAN be read in MAIN.
      if (entry.walkId != null) {
        return {
          ok: false,
          error: 'read_state_needs_selector: this ref came from a DOM-walk snapshot (no CDP), which '
            + 'can\'t be resolved in the page\'s JS context. Pass a CSS {selector} for the element '
            + '(from read_page / query_dom) — read_state reads the framework state there directly.',
        };
      }
      return { ok: false, error: `ref_has_no_node: ${args.ref}` };
    }
    if (typeof debuggerPool?.readFrameworkState !== 'function') {
      // A CDP-sourced ref but the pool is gone (advanced automation turned off
      // since the snapshot). The selector path still works — steer there.
      return {
        ok: false,
        error: 'read_state_needs_selector: advanced automation is off, so this CDP ref can\'t be '
          + 'resolved. Pass a CSS {selector} (from read_page / query_dom) and read_state reads the '
          + 'framework state via the page\'s MAIN world instead.',
      };
    }
    let r;
    try { r = await debuggerPool.readFrameworkState(tab.id, entry.backendDOMNodeId); }
    catch (e) { return { ok: false, error: `read_state_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` }; }
    if (r.ok === false) return { ok: false, error: r.error ?? 'read_state_failed' };
    const { ok, ...payload } = r;
    return {
      ok: true,
      content: wrapUntrusted({ origin: originOfUrl(tab.url), tool: 'read_state', body: JSON.stringify(payload, null, 2) }),
    };
  },
};

// Read framework state via chrome.scripting in the page's MAIN world. The
// injected walk (readFrameworkStateInjected) is the no-CDP twin of
// debugger-pool's FRAMEWORK_STATE_FN; it querySelectors the element itself.
/**
 * @param {{ id: number, url?: string }} tab
 * @param {string} selector
 * @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
const readViaScripting = async (tab, selector, ctx) => {
  // why: ToolContext types `scripting` as the opaque chrome.scripting slot;
  // narrow it to the typed API surface for the executeScript call.
  const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);
  if (typeof scripting?.executeScript !== 'function') {
    return { ok: false, error: 'read_state_unavailable: no scripting API in this context' };
  }
  // why: the injected reader returns dynamic page state (framework props/state
  // are arbitrary JSON) plus an optional error tag — restate that contract.
  /** @type {{ error?: string, [k: string]: any } | undefined} */
  let result;
  try {
    const results = await scripting.executeScript({
      target: { tabId: tab.id },
      // MAIN world: the React fiber / Vue internals are properties the page's
      // own JS set on the element — invisible from the isolated content world.
      world: 'MAIN',
      func: readFrameworkStateInjected,
      args: [selector],
    });
    result = results?.[0]?.result;
  } catch (e) {
    // chrome:/about:/store pages the browser refuses to inject into land here.
    return { ok: false, error: `read_state_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  if (!result) return { ok: false, error: 'read_state_returned_nothing' };
  if (typeof result.error === 'string' && result.error.indexOf('no_match') === 0) {
    return { ok: false, error: `no_match: ${selector} — no element matched; check the selector with query_dom.` };
  }
  if (typeof result.error === 'string' && result.error.indexOf('bad_selector') === 0) {
    return { ok: false, error: `invalid_selector: ${selector}` };
  }
  return {
    ok: true,
    content: wrapUntrusted({ origin: originOfUrl(tab.url), tool: 'read_state', body: JSON.stringify(result, null, 2) }),
  };
};
