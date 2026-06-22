// @ts-check
// query_dom — selector-based DOM probe.
//
// read_page is comprehensive but expensive: it walks the body, returns
// a text snapshot, and caps interactables at 100. On a heavy SPA
// (Gmail, Linear, Notion, Twitter) the cap fills with shell chrome
// before reaching the buttons the agent actually needs. The toolbar
// for "Mark as read" never makes the cut.
//
// query_dom solves that: take a CSS selector, return up to N matches
// with the bits that matter for picking ONE — label, visibility,
// bbox, common attributes. Cheap to call (sub-KB results), surgical,
// and lets the agent iterate selectors against reality without paying
// for a full body scrape.
//
// Typical loop:
//
//   query_dom('[role="button"][aria-label*="read" i]')
//   → [{ label: "Mark as read", selector: ..., visible: true, ... }]
//   click(that selector)
//
// vs. the read_page → "interactable wasn't in the list" → blind-guess
// loop the field test kept hitting.

import { wrapUntrusted } from '../prompt-wrap.js';
import { resolveTargetTab, originOfUrl } from './dom-helpers.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const queryDomTool = {
  name: 'query_dom',
  primitive: 'tab',
  description: [
    'Probe the DOM by CSS selector. Returns up to `limit` matches (default 20),',
    'each with: tag, label (aria-label or visible text), a click-ready selector,',
    'visibility, bounding box, and a few attributes (role, href, type, name,',
    'data-testid). Use this when read_page didn\'t surface the element you',
    'need — e.g. dynamic toolbars, items past the 100-interactable cap on',
    'heavy SPAs (Gmail, Notion, Linear, Twitter), or when probing whether a',
    'guessed selector actually exists. Returns "no matches" cleanly if the',
    'selector hits nothing — that\'s expected feedback, not an error.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector. Supports standard CSS3 syntax including [attr*=val i] case-insensitive matchers and :is()/:where(). No :has() / :contains() polyfill — use attribute substring matchers.',
      },
      limit: {
        type: 'integer',
        description: 'Max matches to return (default 20, cap 50). Lower is cheaper.',
      },
      includeHidden: {
        type: 'boolean',
        description: 'If true, include elements that are display:none / visibility:hidden / opacity:0 / zero-size. Default false — most agent decisions only care about what the user could click.',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id; defaults to the active tab.',
      },
    },
    required: ['selector'],
  },
  sideEffect: 'read',
  origins: (_args, ctx) => ctx.activeTab?.origin ? [ctx.activeTab.origin] : [],

  execute: async (args, ctx) => {
    if (!args?.selector || typeof args.selector !== 'string') {
      return { ok: false, error: 'selector_required' };
    }
    const limit = Math.min(Math.max(1, args.limit ?? 20), 50);
    const includeHidden = !!args.includeHidden;
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // why: ToolContext types `scripting` as the opaque chrome.scripting slot;
    // narrow it to the typed API surface for the executeScript call.
    const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);
    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: { tabId: tab.id },
        func: queryDomInjected,
        args: [args.selector, limit, includeHidden],
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!scriptResult) return { ok: false, error: 'script_returned_nothing' };
    if (!scriptResult.ok) return { ok: false, error: scriptResult.error };

    const origin = originOfUrl(scriptResult.url || tab.url);
    return {
      ok: true,
      content: wrapUntrusted({
        origin,
        tool: 'query_dom',
        body: formatBody(scriptResult, args.selector, includeHidden),
      }),
    };
  },
};

/**
 * @typedef {Object} QueryMatch
 * @property {string} tag
 * @property {boolean} visible
 * @property {string} label
 * @property {string} role
 * @property {string} href
 * @property {string} type
 * @property {string} name
 * @property {string} testid
 * @property {string} value
 * @property {string} bbox
 * @property {string} selector
 */

/**
 * @typedef {Object} QueryResult
 * @property {true} ok
 * @property {string} url
 * @property {QueryMatch[]} matches
 * @property {number} totalMatches
 * @property {boolean} truncated
 */

/**
 * @param {QueryResult} snap
 * @param {string} selector
 * @param {boolean} includeHidden
 */
const formatBody = (snap, selector, includeHidden) => {
  const lines = [
    `Selector: ${selector}`,
    `URL: ${snap.url}`,
    `Total matches: ${snap.totalMatches}${snap.truncated ? ' (truncated)' : ''}`,
    includeHidden ? 'Mode: including hidden elements' : 'Mode: visible only',
    '',
  ];
  if (snap.matches.length === 0) {
    lines.push('(no matches)');
    return lines.join('\n');
  }
  snap.matches.forEach((m, i) => {
    lines.push(`[${i}] <${m.tag}>${m.visible ? '' : ' (hidden)'}`);
    if (m.label) lines.push(`    label: ${m.label}`);
    if (m.role) lines.push(`    role: ${m.role}`);
    if (m.href) lines.push(`    href: ${m.href}`);
    if (m.type) lines.push(`    type: ${m.type}`);
    if (m.name) lines.push(`    name: ${m.name}`);
    if (m.testid) lines.push(`    data-testid: ${m.testid}`);
    if (m.value) lines.push(`    value: ${m.value}`);
    lines.push(`    bbox: ${m.bbox}`);
    lines.push(`    selector: ${m.selector}`);
  });
  return lines.join('\n');
};

// ───────────────────────────────────────────────────────────────────────
// Injected function — runs in the page world. Self-contained, strict.
// ───────────────────────────────────────────────────────────────────────
/**
 * @param {string} selector
 * @param {number} limit
 * @param {boolean} includeHidden
 * @returns {{ ok: false, error: string } | QueryResult}
 */
function queryDomInjected(selector, limit, includeHidden) {
  'use strict';
  /** @type {NodeListOf<HTMLElement>} */
  let nodes;
  try { nodes = document.querySelectorAll(selector); }
  catch (e) { return { ok: false, error: `invalid_selector: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` }; }

  const cssEscape = (/** @type {string} */ s) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s)
    : String(s).replace(/(["\\\[\]\.#\(\)\s])/g, '\\$1');

  const isVisible = (/** @type {Element} */ el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  };

  const selectorFor = (/** @type {Element} */ el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `[aria-label="${cssEscape(aria)}"]`;
    let nth = 1;
    /** @type {Element | null} */
    let sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) nth += 1;
    }
    return `${el.tagName.toLowerCase()}:nth-of-type(${nth})`;
  };

  const labelOf = (/** @type {Element} */ el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (el.tagName === 'INPUT' && el.id) {
      const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lbl) return (lbl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
    const title = el.getAttribute('title');
    if (title) return title.trim().slice(0, 120);
    return '';
  };

  const formatBbox = (/** @type {DOMRect} */ r) => `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;

  /** @type {QueryMatch[]} */
  const matches = [];
  let totalMatches = 0;
  for (const el of nodes) {
    totalMatches++;
    const visible = isVisible(el);
    if (!includeHidden && !visible) continue;
    if (matches.length >= limit) continue;
    const rect = el.getBoundingClientRect();
    const m = {
      tag: el.tagName.toLowerCase(),
      visible,
      label: labelOf(el),
      role: el.getAttribute('role') || '',
      href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
      type: (el.tagName === 'INPUT' || el.tagName === 'BUTTON') ? (el.getAttribute('type') || '') : '',
      name: el.getAttribute('name') || '',
      testid: el.getAttribute('data-testid') || '',
      // why: erased cast — the tagName guard already constrained el to a
      // value-bearing control; HTMLElement has no `value`.
      value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (/** @type {HTMLInputElement} */ (el).value || '').slice(0, 80) : '',
      bbox: formatBbox(rect),
      selector: selectorFor(el),
    };
    matches.push(m);
  }
  return {
    ok: true,
    url: location.href,
    matches,
    totalMatches,
    truncated: totalMatches > matches.length + (includeHidden ? 0 : 0) && matches.length >= limit,
  };
}
