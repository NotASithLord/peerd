// @ts-check
// type — set the value of an input/textarea and dispatch the events a
// well-behaved page expects (focus, input, change). For
// contenteditable elements, replaces innerText.
//
// Like click(), this is good enough for most pages but not for sites
// that ignore synthetic events (event.isTrusted checks). V1.1
// chrome.debugger gives us per-keystroke CDP input events, which
// pages receive as trusted user input.
//
// V1 design: a single `set whole value` operation. We don't simulate
// individual keystrokes — that's a V1.1+ refinement. If a site has
// keystroke-by-keystroke autocomplete that needs typing flow, the
// agent can call type() with progressively longer prefixes.

import { resolveTargetTab } from './dom-helpers.js';
import { summarizeMutations } from '../../dom/index.js';

/**
 * Harness-injected ctx extras (ref registry + CDP pool). Not on the
 * ToolContext typedef, so type narrows ctx through this with an erased cast.
 * The CDP set-value result is loosely typed: navigated/mutations are dynamic.
 *
 * @typedef {{ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }} RefEntry
 * @typedef {{ resolve?: (tabId: number, ref: string) => RefEntry | null }} DomRefs
 * @typedef {{ setValueBackendNode?: (tabId: number, backendDOMNodeId: number, text: string, submit: boolean) =>
 *   Promise<{ ok: false, error?: string }
 *     | { ok: true, tag?: string, navigated?: boolean, mutations?: any }> }} DebuggerPool
 * @typedef {{ domRefs?: DomRefs, debuggerPool?: DebuggerPool }} DomCtxExtras
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const typeTool = {
  name: 'type',
  primitive: 'tab',
  description: [
    'Set the value of a text input, textarea, contenteditable, or native',
    '<select> dropdown. For a <select>, pass the option\'s visible label as',
    'text (e.g. "Two") — the harness resolves it to the matching option.',
    'Selector is a CSS selector (get one from read_page), or pass a snapshot',
    'ref. Replaces whatever value was there. Fires focus, input, and change',
    'events so reactive frameworks see the update. By default acts on the',
    'active tab. Optional submit=true sends an Enter key after setting',
    'the value (useful for search boxes).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'PREFERRED. An element ref from a snapshot (e.g. "@e2"). Resolved to the exact field via CDP. Use when you took a snapshot.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the input/textarea/contenteditable (from read_page). Use when you have a selector instead of a snapshot ref. One of ref|selector is required.',
      },
      text: {
        type: 'string',
        description: 'Value to set. For a <select> dropdown, the visible LABEL of the option to choose (e.g. "Two"); the harness maps it to the underlying option value.',
      },
      submit: {
        type: 'boolean',
        description: 'If true, dispatch an Enter keydown after typing (submits search boxes).',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id; defaults to the active tab.',
      },
    },
    required: ['text'],
  },
  sideEffect: 'write',
  origins: (_args, ctx) => ctx.activeTab?.origin ? [ctx.activeTab.origin] : [],

  execute: async (args, ctx) => {
    if (typeof args?.text !== 'string') {
      return { ok: false, error: 'text_required' };
    }
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // why: domRefs/debuggerPool are SW-injected onto ctx but absent from the
    // ToolContext typedef; scripting is typed opaquely — narrow all three.
    const { domRefs, debuggerPool } = /** @type {DomCtxExtras} */ (ctx);
    const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);

    // Ref path (a11y snapshot): exact node, no selector ambiguity. Two
    // resolutions, matching the snapshot's two capture channels
    // (dom/capture.js): backendDOMNodeId → CDP set-value; walkId
    // (DOM-walk pseudo-snapshot, Firefox / advanced automation off) →
    // scripting set-value against the injected world's walk registry.
    if (typeof args?.ref === 'string' && args.ref.trim()) {
      const ref = args.ref.trim();
      const entry = domRefs?.resolve?.(tab.id, ref);
      if (!entry) return { ok: false, error: `stale_ref: ${ref} — re-run snapshot on this tab first` };

      if (entry.backendDOMNodeId != null && typeof debuggerPool?.setValueBackendNode === 'function') {
        try {
          const r = await debuggerPool.setValueBackendNode(tab.id, entry.backendDOMNodeId, args.text, !!args.submit);
          if (!r.ok) return { ok: false, error: r.error ?? 'ref_type_failed' };
          return {
            ok: true,
            content: JSON.stringify({
              typed: args.text.slice(0, 200), submitted: !!args.submit,
              ref, role: entry.role, name: entry.name, tag: r.tag,
              ...(r.navigated ? { navigated: true } : {}),
              // Action-result attribution: what typing changed on the page.
              result: r.navigated ? 'page navigated' : summarizeMutations(r.mutations),
            }, null, 2),
          };
        } catch (e) {
          return { ok: false, error: `ref_type_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
        }
      }

      if (entry.walkId != null) {
        let scriptResult;
        try {
          const results = await scripting.executeScript({
            target: { tabId: tab.id },
            func: typeInjected,
            args: [null, args.text, !!args.submit, entry.walkId],
          });
          scriptResult = results[0]?.result;
        } catch (e) {
          return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
        }
        if (!scriptResult) return { ok: false, error: 'script_returned_nothing' };
        if (!scriptResult.ok) return { ok: false, error: scriptResult.error ?? 'ref_type_failed' };
        return {
          ok: true,
          content: JSON.stringify({
            typed: scriptResult.typed, submitted: scriptResult.submitted,
            ref, role: entry.role, name: entry.name, tag: scriptResult.tag,
            // Honest about the channel: scripting input is synthetic
            // (isTrusted=false); sites that gate on trusted keystrokes
            // may ignore it, and there is no fallback channel here.
            via: 'dom-walk',
          }, null, 2),
        };
      }

      // A CDP-sourced ref but the pool is gone (advanced automation was
      // turned off since the snapshot). A fresh snapshot hands out walk
      // refs that CAN be typed into here — steer the model there.
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

    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: { tabId: tab.id },
        func: typeInjected,
        args: [args.selector, args.text, !!args.submit],
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!scriptResult) return { ok: false, error: 'script_returned_nothing' };
    if (!scriptResult.ok) return { ok: false, error: scriptResult.error ?? 'type_failed' };

    return {
      ok: true,
      content: JSON.stringify({
        typed: scriptResult.typed,
        submitted: scriptResult.submitted,
        tag: scriptResult.tag,
      }, null, 2),
    };
  },
};

/**
 * @param {string | null} selector
 * @param {string} text
 * @param {boolean} submit
 * @param {number | null} [walkId]
 */
function typeInjected(selector, text, submit, walkId) {
  // why: serialized by chrome.scripting.executeScript and re-evaluated
  // in the page's classic-script world; the calling module's strict
  // mode doesn't carry across. Opt in here.
  'use strict';
  /** @type {HTMLElement | null} */
  let el;
  if (walkId != null) {
    // DOM-walk ref resolution: the walk (walk-injected.js) registered
    // walkId → element in this same isolated world. Element gone or
    // detached → the snapshot is stale, same contract as a CDP ref.
    // why: __peerdWalkEls is set on the page world by walk-injected.js — not
    // a standard global, so reach it through an erased cast.
    const reg = /** @type {{ __peerdWalkEls?: Map<number, HTMLElement> }} */ (globalThis).__peerdWalkEls;
    el = reg && typeof reg.get === 'function' ? (reg.get(walkId) ?? null) : null;
    if (!el || !el.isConnected) {
      return { ok: false, error: 'stale_ref: element no longer in the page — re-run snapshot on this tab first' };
    }
  } else {
    // why: erased cast — this branch is reached only when walkId is null, so a
    // selector is always present.
    el = /** @type {HTMLElement | null} */ (document.querySelector(/** @type {string} */ (selector)));
    if (!el) return { ok: false, error: `no_match: ${selector}` };
  }
  try {
    if (typeof el.focus === 'function') el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      // why: erased cast — the tag guard constrains el to a value-bearing control.
      const input = /** @type {HTMLInputElement} */ (el);
      const setter = Object.getOwnPropertyDescriptor(
        tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      // Using the native setter bypasses framework property interceptors
      // (React tracks the value on the element directly; assigning via
      // el.value = ... doesn't trigger React's synthetic input event).
      if (setter) setter.call(input, text);
      else input.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'select') {
      // Native <select>: match the requested text against option LABELS (what
      // the model sees in the a11y tree), then set the option's VALUE (often
      // different — label "Two" -> value "2"). Setting el.value to the label is
      // silently ignored by the browser, which is the exact bug this fixes.
      // why: erased cast — the tag guard constrains el to a <select>.
      const select = /** @type {HTMLSelectElement} */ (el);
      const want = (`${text}`).trim();
      const options = Array.from(select.options || []);
      const opt =
        options.find((o) => (`${o.label || o.text || ''}`).trim() === want)
        || options.find((o) => o.value === want)
        || options.find((o) => (`${o.text || ''}`).trim().toLowerCase() === want.toLowerCase());
      if (!opt) {
        const avail = options.map((o) => (`${o.text || ''}`).trim()).filter(Boolean).slice(0, 25);
        return { ok: false, error: `no_option_matching: "${want}" — available: ${avail.join(' | ')}` };
      }
      const sset = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (sset) sset.call(select, opt.value);
      else select.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, error: `not_typable: ${tag} is not an input/textarea/contenteditable` };
    }
    let submitted = false;
    if (submit) {
      const enter = (/** @type {string} */ kind) => new KeyboardEvent(kind, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      });
      el.dispatchEvent(enter('keydown'));
      el.dispatchEvent(enter('keypress'));
      el.dispatchEvent(enter('keyup'));
      // Also attempt form submission if the element is in one.
      // why: erased cast — only form controls carry `.form`; a non-form element
      // yields undefined and skips the requestSubmit path exactly as before.
      const form = /** @type {HTMLInputElement} */ (el).form;
      if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(); }
        catch { /* swallow — keydown may be enough */ }
      }
      submitted = true;
    }
    return {
      ok: true,
      typed: text.slice(0, 200),
      submitted,
      tag,
    };
  } catch (e) {
    return { ok: false, error: `type_threw: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
}
