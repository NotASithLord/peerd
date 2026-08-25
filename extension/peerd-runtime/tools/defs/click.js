// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// click — click an element matching a CSS selector on the target tab.
//
// V1 implementation uses chrome.scripting.executeScript to dispatch a
// full pointer + mouse + click event sequence in the page world.
// Sites that check event.isTrusted (LinkedIn, Facebook, and other
// apps that ignore synthetic events) refuse dispatched clicks — those
// need chrome.debugger (V1.1), whose CDP-issued events pages receive
// as trusted user input.
//
// Design notes for the V2 upgrade:
//
//   - el.click() alone misses sites that listen on pointerdown /
//     mousedown / mouseup (Gmail's toolbar, many React libraries that
//     wrap radix-ui / floating-ui). We dispatch the full sequence.
//   - scrollIntoView({block:'center'}) before clicking handles lazy
//     rendering and ensures the element is in the layout viewport,
//     which sites use to gate "real" interactions.
//   - `nth` lets the agent target the Nth match without crafting a
//     :nth-of-type selector — common when query_dom returns several
//     candidates with the same aria-label.
//   - On no-match, we return up to 3 nearby candidates (siblings,
//     ancestors with role=button) as breadcrumbs so the agent can
//     refine without paying for a full read_page.

import { browserDocumentIdentity, resolveTargetTab, scriptingTarget } from './dom-helpers.js';
import { summarizeMutations } from '../../dom/action-result.js';
import { browserDocumentRefusalFrom, formSubmissionRefusalFrom } from '../browser-automation-policy.js';

/**
 * Harness-injected ctx extras (ref registry + CDP pool). Not on the
 * ToolContext typedef, so click narrows ctx through this with an erased cast.
 * The CDP click result is loosely typed: navigated/mutations are dynamic.
 *
 * @typedef {{ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }} RefEntry
 * @typedef {{ resolve?: (tabId: number, ref: string) => RefEntry | null }} DomRefs
 * @typedef {{ clickBackendNode?: (tabId: number, backendDOMNodeId: number, expectedDocument: ReturnType<typeof browserDocumentIdentity>) =>
 *   Promise<{ ok: false, error?: string, outcomeKind?: import('../../lifecycle/failure-taxonomy.js').FailureOutcomeKind }
 *     | { ok: true, tag?: string, text?: string, navigated?: boolean, mutations?: any }> }} DebuggerPool
 * @typedef {{ domRefs?: DomRefs, debuggerPool?: DebuggerPool }} DomCtxExtras
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const clickTool = composeTool("click", {

  execute: async (args, ctx) => {
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab', outcomeKind: 'pre-effect-failure' };

    // why: domRefs/debuggerPool are SW-injected onto ctx but absent from the
    // ToolContext typedef; scripting is typed opaquely — narrow all three.
    const { domRefs, debuggerPool } = /** @type {DomCtxExtras} */ (ctx);
    const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);

    // why: hoisted above the ref branch — the cardinality guard applies to
    // BOTH resolution channels the injected body serves (selector match count,
    // walk-ref 0/1), not just selector calls (issue #36).
    const expectedCount = Number.isInteger(args?.expectedCount) && args.expectedCount > 0
      ? args.expectedCount
      : null;

    // Ref path (a11y snapshot): the harness owns the ref→node mapping, so
    // there's no ambiguity and no "selector not found". Two resolutions,
    // matching the snapshot's two capture channels (dom/capture.js):
    // backendDOMNodeId → CDP click; walkId (DOM-walk pseudo-snapshot,
    // Firefox / advanced automation off) → scripting click against the
    // injected world's walk registry.
    if (typeof args?.ref === 'string' && args.ref.trim()) {
      const ref = args.ref.trim();
      const entry = domRefs?.resolve?.(tab.id, ref);
      if (!entry) return { ok: false, error: `stale_ref: ${ref} — re-run snapshot on this tab first`, outcomeKind: 'pre-effect-failure' };

      if (entry.backendDOMNodeId != null && typeof debuggerPool?.clickBackendNode === 'function') {
        // Cardinality guard on the CDP channel too (#36 consistency): a resolved
        // backendDOMNodeId ref IS exactly one node, so any expectedCount other
        // than 1 is a mismatch — same shape the walk-ref/selector paths return,
        // so the guard the schema promises holds identically across channels.
        if (expectedCount != null && expectedCount !== 1) {
          return { ok: false, error: 'matched_count_mismatch', matchedCount: 1, expectedCount, outcomeKind: 'pre-effect-failure' };
        }
        try {
          const r = await debuggerPool.clickBackendNode(
            tab.id, entry.backendDOMNodeId, browserDocumentIdentity(tab));
          if (!r.ok) return formSubmissionRefusalFrom(r) ?? browserDocumentRefusalFrom(r) ?? {
            ok: false,
            error: r.error ?? 'ref_click_failed',
            ...(r.outcomeKind ? { outcomeKind: r.outcomeKind } : {}),
          };
          return {
            ok: true,
            content: JSON.stringify({
              clicked: true, ref, role: entry.role, name: entry.name, tag: r.tag, text: r.text, matchedCount: 1,
              ...(r.navigated ? { navigated: true } : {}),
              // Action-result attribution: what the click changed on the page.
              result: r.navigated ? 'page navigated' : summarizeMutations(r.mutations),
            }, null, 2),
          };
        } catch (e) {
          const outcomeKind = /** @type {{ outcomeKind?: import('../../lifecycle/failure-taxonomy.js').FailureOutcomeKind }} */ (e)?.outcomeKind;
          const refusal = browserDocumentRefusalFrom(e);
          if (refusal) return refusal;
          return {
            ok: false,
            error: `ref_click_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
            ...(outcomeKind ? { outcomeKind } : {}),
          };
        }
      }

      if (entry.walkId != null) {
        let scriptResult;
        try {
          const results = await scripting.executeScript({
            target: scriptingTarget(tab),
            func: clickInjected,
            args: [null, 0, entry.walkId, expectedCount, null],
          });
          scriptResult = results[0]?.result;
        } catch (e) {
          return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, outcomeKind: 'pre-effect-failure' };
        }
        if (!scriptResult) return { ok: false, error: 'script_returned_nothing' };
        if (!scriptResult.ok) return formSubmissionRefusalFrom(scriptResult)
          ?? { ok: false, error: scriptResult.error ?? 'ref_click_failed' };
        return {
          ok: true,
          content: JSON.stringify({
            clicked: true, ref, role: entry.role, name: entry.name,
            tag: scriptResult.tag, text: scriptResult.text,
            // why: keep matchedCount present on every success shape (selector
            // AND walk ref) so the agent reads one consistent contract; a
            // resolved walk ref is always exactly 1 (issue #36).
            matchedCount: scriptResult.matchedCount,
            // Honest about the channel: a scripting click is synthetic
            // (isTrusted=false) — sites that gate on trusted input may
            // ignore it, and there is no fallback channel here.
            via: 'dom-walk',
          }, null, 2),
        };
      }

      // A CDP-sourced ref but the pool is gone (advanced automation was
      // turned off since the snapshot). A fresh snapshot will hand out
      // walk refs that CAN be clicked here — steer the model there.
      return {
        ok: false,
        error: 'debugger_unavailable: this ref came from a CDP snapshot but advanced automation is now '
          + 'off. Re-run snapshot (it falls back to a DOM-walk) and use the fresh refs, or use a CSS '
          + '{selector} from read_page / query_dom.',
      };
    }

    if (!args?.selector || typeof args.selector !== 'string') {
      return { ok: false, error: 'selector_or_ref_required' };
    }
    const nth = Number.isInteger(args.nth) && args.nth >= 0 ? args.nth : 0;

    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: scriptingTarget(tab),
        func: clickInjected,
        args: [args.selector, nth, null, expectedCount, null],
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, outcomeKind: 'pre-effect-failure' };
    }

    if (!scriptResult) {
      return { ok: false, error: 'script_returned_nothing' };
    }
    if (!scriptResult.ok) {
      return formSubmissionRefusalFrom(scriptResult)
        ?? { ok: false, error: scriptResult.error ?? 'click_failed' };
    }
    return {
      ok: true,
      content: JSON.stringify({
        clicked: scriptResult.clicked,
        tag: scriptResult.tag,
        text: scriptResult.text,
        matchedCount: scriptResult.matchedCount,
        nth: scriptResult.nth,
      }, null, 2),
    };
  },
});

/**
 * @param {string | null} selector
 * @param {number} nth
 * @param {number | null} [walkId]
 * @param {number | null} [expectedCount]
 * @param {string | null} [allowedCrossOriginFormOrigin]
 */
// why: exported for the Bun tests to exercise the REAL body's walk-ref
// cardinality guard (mocked scriptResults would hide an omission — #103
// review lesson). Same precedent as domWalkInjected; `export` is not part
// of Function.prototype.toString, so executeScript serialization is
// unchanged.
export function clickInjected(selector, nth, walkId, expectedCount, allowedCrossOriginFormOrigin) {
  'use strict';
  /** @type {HTMLElement | null} */
  let el;
  let matchedCount = 1;
  if (walkId != null) {
    // DOM-walk ref resolution: the walk (walk-injected.js) registered
    // walkId → element in this same isolated world. Element gone or
    // detached → the snapshot is stale, same contract as a CDP ref.
    // why: __peerdWalkEls is set on the page world by walk-injected.js — not
    // a standard global, so reach it through an erased cast.
    const reg = /** @type {{ __peerdWalkEls?: Map<number, HTMLElement> }} */ (globalThis).__peerdWalkEls;
    el = reg && typeof reg.get === 'function' ? (reg.get(walkId) ?? null) : null;
    // why: a walkId names exactly one registered element, so the real match
    // cardinality is 0 (stale/unregistered) or 1 (found). Enforce the guard
    // against that count — same code + fields as the selector path — instead
    // of silently ignoring expectedCount on ref calls (issue #36). Checked
    // BEFORE the stale return so the 0 case reports the mismatch the caller
    // asked to be told about, with the re-snapshot hint kept in the text.
    matchedCount = el && el.isConnected ? 1 : 0;
    if (expectedCount != null && matchedCount !== expectedCount) {
      return {
        ok: false,
        error: `matched_count_mismatch: walk ref matched ${matchedCount} element(s), expected ${expectedCount}${matchedCount === 0 ? ' — element no longer in the page; re-run snapshot on this tab first' : ''}`,
        matchedCount,
        expectedCount,
      };
    }
    if (!el || !el.isConnected) {
      return { ok: false, error: 'stale_ref: element no longer in the page — re-run snapshot on this tab first' };
    }
  } else {
    /** @type {NodeListOf<HTMLElement>} */
    let nodes;
    // why: erased cast — this branch is reached only when walkId is null, so a
    // selector is always present; the schema/guards upstream ensure a string.
    try { nodes = document.querySelectorAll(/** @type {string} */ (selector)); }
    catch (e) { return { ok: false, error: `invalid_selector: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` }; }

    if (nodes.length === 0) {
      return { ok: false, error: `no_match: ${selector}` };
    }
    if (expectedCount != null && nodes.length !== expectedCount) {
      return {
        ok: false,
        error: `matched_count_mismatch: selector matched ${nodes.length} element(s), expected ${expectedCount}`,
        matchedCount: nodes.length,
        expectedCount,
      };
    }
    if (nth >= nodes.length) {
      return {
        ok: false,
        error: `nth_out_of_range: selector matched ${nodes.length} element(s), requested index ${nth}`,
      };
    }
    el = nodes[nth];
    matchedCount = nodes.length;
  }
  try {
    // why: a native submitter can move every live form value without placing
    // either the destination or payload in the click tool arguments. Resolve
    // the exact submitter and its override at the effect point, before any
    // focus or event can activate page or browser submission behavior.
    const directSubmitter = typeof el.closest === 'function' ? el.closest('button,input') : null;
    const activationLabel = !directSubmitter && typeof el.closest === 'function'
      ? el.closest('label')
      : null;
    const submitter = directSubmitter
      || /** @type {HTMLLabelElement | null} */ (activationLabel)?.control
      || null;
    const submitterTag = submitter?.tagName?.toLowerCase() ?? '';
    const submitterType = /** @type {HTMLButtonElement | HTMLInputElement | null} */ (submitter)?.type?.toLowerCase() ?? '';
    const isSubmitter = (submitterTag === 'button' && submitterType === 'submit')
      || (submitterTag === 'input' && (submitterType === 'submit' || submitterType === 'image'));
    const form = isSubmitter
      ? /** @type {HTMLButtonElement | HTMLInputElement} */ (submitter).form
      : null;
    if (form) {
      const getAttribute = Element.prototype.getAttribute;
      const submitterMethod = getAttribute.call(submitter, 'formmethod');
      const method = (submitterMethod || getAttribute.call(form, 'method') || 'get').toLowerCase();
      if (method !== 'dialog') {
        try {
          const submitterAction = getAttribute.call(submitter, 'formaction');
          const formAction = getAttribute.call(form, 'action');
          const action = submitterAction !== null ? submitterAction : formAction;
          const actionOrigin = action
            ? new URL(action, document.baseURI).origin
            : document.location.origin;
          if (actionOrigin !== document.location.origin && actionOrigin !== allowedCrossOriginFormOrigin) {
            return { ok: false, error: 'cross_origin_form_submission_blocked' };
          }
        } catch {
          return { ok: false, error: 'cross_origin_form_submission_blocked' };
        }
      }
    }
    // Scroll the element to the centre of the viewport. Many sites
    // (including Gmail and Google Docs) only register a click as a
    // real interaction if the target is visible at click time.
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch { /* old browsers */ }
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, composed: true,
      view: window, clientX: cx, clientY: cy,
      button: 0, buttons: 1,
    };
    // Modern sites listen on pointer events first (Material UI, Radix,
    // floating-ui all do this). Fire those before the mouse sequence.
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup',   { ...opts, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
    }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup',   { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click',     { ...opts, buttons: 0 }));
    // Fallback: also call native click() in case the page only wires
    // up the HTMLElement.click() activation behaviour (form submit,
    // <a> navigation). Idempotent for handlers that already fired.
    try { el.click(); } catch { /* swallow */ }
    return {
      ok: true,
      clicked: walkId != null ? `walk:${walkId}` : selector,
      nth,
      matchedCount,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  } catch (e) {
    return { ok: false, error: `click_threw: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
}
