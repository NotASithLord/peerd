// @ts-check
// Internal helpers for the web wrapper tools.
//
// These are NOT tools — they're composable building blocks called from
// read_article, call_api, web_search, submit_form, capture. The agent
// reaches the underlying capabilities (open_tab, navigate, read_page)
// when it wants raw control; the wrappers reach into here when they
// want the standard escalation pipeline.
//
// All helpers take a ToolContext and read ctx.{webFetch, tabs,
// scripting} so they remain testable with mock ctx objects. Web
// fetches go through ctx.webFetch (denylist-gated) NOT ctx.safeFetch
// (provider-allowlist-locked).

// Deep imports of the PURE host guards (not the /peerd-egress barrel, which
// pulls in vault/storage + the polyfill and would break the bun test runner —
// same reason as tools/gates.js). Used to re-validate where a tab LANDED.
import { findDenylistMatch } from '../../../peerd-egress/denylist/denylist.js';
import { isPrivateOrLocalHost } from '../../../peerd-egress/fetch/private-network.js';

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */

// why: ToolContext types tabs/scripting/webFetch as opaque `Object`/optional
// (the contract slot). These erased casts narrow them to the exact chrome.*
// surface these helpers call, at the one point each function reaches in —
// keeping the bodies type-checked without changing the public contract.
/** @param {ToolContext} ctx @returns {typeof chrome.tabs} */
const tabsOf = (ctx) => /** @type {typeof chrome.tabs} */ (/** @type {unknown} */ (ctx.tabs));
/** @param {ToolContext} ctx @returns {typeof chrome.scripting} */
const scriptingOf = (ctx) => /** @type {typeof chrome.scripting} */ (/** @type {unknown} */ (ctx.scripting));

/**
 * Re-validate the host a tab ACTUALLY landed on — after it natively followed
 * any HTTP redirect / meta-refresh / JS navigation the dispatcher's origin
 * gate never saw — against the denylist + the private-network (SSRF) guard.
 * A real tab follows redirects client-side, so the landed host can differ from
 * the requested one and MUST face the same guards before its content is read
 * back into the agent. Returns a denial, or null when the landing is allowed.
 *
 * @param {string} finalUrl
 * @param {ToolContext} ctx
 * @returns {{ host: string, reason: string } | null}
 */
export const landedHostDenial = (finalUrl, ctx) => {
  let host;
  try { host = new URL(finalUrl).hostname; }
  catch { return null; }  // unparseable landing — nothing readable anyway
  const patterns = /** @type {readonly string[]} */ (ctx?.denylist ?? []);
  const match = findDenylistMatch(host, patterns);
  if (match) return { host, reason: `denylist:${match}` };
  if (isPrivateOrLocalHost(host)) return { host, reason: 'private_network' };
  return null;
};

/**
 * Fetch a URL through the SW's webFetch (denylist-gated + audited)
 * with a wall-clock timeout. Returns the response status + body text
 * + final URL. Redirects are NOT followed — webFetch fails closed on any
 * 3xx (it can't re-validate the redirect target in an MV3 SW), so finalUrl
 * equals the requested URL. Throws on egress denial (incl. a blocked
 * redirect) — the gate-blocked path already returns a typed error elsewhere.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} opts
 * @param {ToolContext} ctx
 * @returns {Promise<{ status: number, body: string, headers: Record<string,string>, finalUrl: string }>}
 */
export const fetchUrl = async (url, opts, ctx) => {
  const webFetch = ctx?.webFetch;
  if (typeof webFetch !== 'function') {
    throw new Error('web/primitives: ctx.webFetch is missing — check buildToolContext wiring.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // No redirect mode here: webFetch forces redirect:'manual' and fails
    // closed on any 3xx (SSRF/denylist re-validation isn't possible per-hop
    // in an MV3 SW). Asking for 'follow' would be silently overridden.
    const res = await webFetch(url, {
      method:  opts?.method  ?? 'GET',
      headers: opts?.headers ?? {},
      body:    opts?.body,
      signal:  controller.signal,
    });
    const body = await res.text();
    /** @type {Record<string, string>} */
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, body, headers, finalUrl: res.url ?? url };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Open a new tab at `url`, wait for load, return the resulting tab's
 * id and final URL. Caller is responsible for closing the tab when
 * done (via closeTab).
 *
 * Visibility: this primitive backs the TRANSIENT scrape tools
 * (read_article / web_search), which open a tab, read it, and close it
 * immediately — so it opens in the BACKGROUND, always. Focusing a tab
 * that's about to vanish would just flash the user (DECISIONS #20). Tabs
 * the user is meant to SEE go through open_tab, which takes focus.
 *
 * @param {string} url
 * @param {ToolContext} ctx
 * @returns {Promise<{ tabId: number, finalUrl: string }>}
 */
export const openWebTab = async (url, ctx) => {
  const tabs = tabsOf(ctx);
  if (typeof tabs?.create !== 'function') {
    throw new Error('web/primitives: ctx.tabs.create is missing.');
  }
  const created = await tabs.create({ url, active: false });
  const tabId = created?.id;
  if (typeof tabId !== 'number') throw new Error('open_inactive_tab: no tab id');
  try {
    await waitForLoad(tabId, ctx);
  } catch (e) {
    // why: timeout doesn't mean the page is useless — the model can
    // still read what loaded. Surface it but don't abort the tab.
    console.warn('[web/primitives] waitForLoad partial:', /** @type {{ message?: string }} */ (e)?.message);
  }
  let finalUrl = url;
  try {
    const t = await tabs.get(tabId);
    finalUrl = t?.url ?? url;
  } catch { /* tab closed mid-load; rare */ }
  return { tabId, finalUrl };
};

/**
 * Resolve when the tab's status reaches 'complete', or reject after a
 * 30s timeout.
 *
 * @param {number} tabId
 * @param {ToolContext} ctx
 * @returns {Promise<void>}
 */
export const waitForLoad = (tabId, ctx) => /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
  const tabs = tabsOf(ctx);
  let settled = false;
  /** @param {Error | null} err */
  const finish = (err) => {
    if (settled) return;
    settled = true;
    try { tabs.onUpdated.removeListener(listener); } catch { /* noop */ }
    clearTimeout(timer);
    err ? reject(err) : resolve();
  };
  /** @type {(id: number, info: chrome.tabs.OnUpdatedInfo) => void} */
  const listener = (id, info) => {
    if (id !== tabId) return;
    if (info?.status === 'complete') finish(null);
  };
  tabs.onUpdated.addListener(listener);
  const timer = setTimeout(
    () => finish(new Error(`page load timeout after ${PAGE_LOAD_TIMEOUT_MS}ms`)),
    PAGE_LOAD_TIMEOUT_MS,
  );
}));

/**
 * Run a small page-extractor in the tab and return its visible text +
 * URL + title. Same shape `read_page` uses; web wrappers call this
 * instead of dispatching read_page so they can compose without going
 * through the dispatcher gates a second time.
 *
 * @param {number} tabId
 * @param {ToolContext} ctx
 * @returns {Promise<{ url: string, title: string, text: string }>}
 */
export const readTabContent = async (tabId, ctx) => {
  const scripting = scriptingOf(ctx);
  if (typeof scripting?.executeScript !== 'function') {
    throw new Error('web/primitives: ctx.scripting.executeScript is missing.');
  }
  const results = await scripting.executeScript({
    target: { tabId },
    func: extractPageInjected,
  });
  const r = results?.[0]?.result;
  if (!r) throw new Error('readTabContent: no extractor result');
  return r;
};

/**
 * Close a tab. Best-effort; missing/closed tab is not an error.
 *
 * @param {number} tabId
 * @param {ToolContext} ctx
 */
export const closeTab = async (tabId, ctx) => {
  try { await tabsOf(ctx).remove(tabId); }
  catch { /* tab was already closed */ }
};

// ---- injected functions ---------------------------------------------------
// These are serialized by chrome.scripting and re-evaluated in the
// target page's classic-script world. Each is self-contained and opts
// in to strict mode explicitly (per project convention).

/** @returns {{ url: string, title: string, text: string }} */
function extractPageInjected() {
  'use strict';
  const TEXT_CAP = 4000;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'SVG', 'IFRAME',
  ]);
  /** @param {Element} el @returns {boolean} */
  const isVisible = (el) => {
    if (!(el instanceof Element)) return true;
    const s = window.getComputedStyle(el);
    if (!s) return true;
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  };
  /** @param {Node} node @param {string[]} out */
  const walk = (node, out) => {
    if (out.length >= TEXT_CAP) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (node);
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!isVisible(el)) return;
    for (const child of node.childNodes) walk(child, out);
  };
  /** @type {string[]} */
  const parts = [];
  walk(document.body, parts);
  const text = parts.join(' ').replace(/\s+/g, ' ').slice(0, TEXT_CAP);
  return {
    url:   location.href,
    title: document.title || '',
    text,
  };
}

/**
 * Fill form fields and optionally submit. `fields` is an object
 * mapping CSS selectors to values; `submitSelector` (optional) is
 * clicked at the end.
 *
 * Returns per-field status so the model can see which ones it found.
 *
 * @param {number} tabId
 * @param {Record<string, string>} fields
 * @param {string | null} submitSelector
 * @param {ToolContext} ctx
 * @returns {Promise<{ fields: Record<string, { ok: boolean, error?: string }>, submitted: boolean }>}
 */
export const submitFormInTab = async (tabId, fields, submitSelector, ctx) => {
  const scripting = scriptingOf(ctx);
  if (typeof scripting?.executeScript !== 'function') {
    throw new Error('web/primitives: ctx.scripting.executeScript is missing.');
  }
  const results = await scripting.executeScript({
    target: { tabId },
    func: submitFormInjected,
    args: [fields, submitSelector ?? null],
  });
  const r = results?.[0]?.result;
  if (!r) throw new Error('submitFormInTab: no result from injected function');
  return r;
};

/**
 * @param {Record<string, string>} fields
 * @param {string | null} submitSelector
 * @returns {{ fields: Record<string, { ok: boolean, error?: string }>, submitted: boolean }}
 */
function submitFormInjected(fields, submitSelector) {
  'use strict';
  /** @type {Record<string, { ok: boolean, error?: string }>} */
  const reports = {};
  // why: React + other controlled-input libraries override the native
  // setter on HTMLInputElement.prototype.value, intercepting direct
  // assignment. Reaching into the prototype's descriptor bypasses
  // them.
  /** @param {Element} el @param {string} value */
  const setNative = (el, value) => {
    const tag = el.tagName.toLowerCase();
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype
                : tag === 'select'   ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const input = /** @type {HTMLInputElement} */ (el);
    if (setter) setter.call(el, value);
    else input.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const [selector, value] of Object.entries(fields || {})) {
    const el = document.querySelector(selector);
    if (!el) { reports[selector] = { ok: false, error: 'no_match' }; continue; }
    try {
      const focusable = /** @type {HTMLElement} */ (el);
      if (typeof focusable.focus === 'function') focusable.focus();
      setNative(el, String(value));
      reports[selector] = { ok: true };
    } catch (e) {
      reports[selector] = { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'set_failed' };
    }
  }
  let submitted = false;
  if (submitSelector) {
    const btn = /** @type {HTMLElement | null} */ (document.querySelector(submitSelector));
    if (!btn) {
      reports[submitSelector] = { ok: false, error: 'no_match' };
    } else {
      try {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        submitted = true;
      } catch (e) {
        reports[submitSelector] = { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'click_failed' };
      }
    }
  }
  return { fields: reports, submitted };
}

/**
 * Capture the visible region of the given window as a base64 data URL.
 * Requires the activeTab or <all_urls> permission for the source tab.
 * NOTE: captureVisibleTab can only grab the window's FOREGROUND tab — callers
 * that must capture a specific (possibly backgrounded) tab use the CDP
 * debugger-pool captureScreenshot path instead.
 *
 * @param {number | undefined} windowId
 * @param {ToolContext} ctx
 * @param {{ format?: 'png'|'jpeg', quality?: number }} [opts]
 * @returns {Promise<string>}     data URL ("data:image/<fmt>;base64,...")
 */
export const captureVisible = async (windowId, ctx, { format = 'png', quality } = {}) => {
  const tabs = tabsOf(ctx);
  if (typeof tabs?.captureVisibleTab !== 'function') {
    throw new Error('web/primitives: ctx.tabs.captureVisibleTab is missing.');
  }
  // why: windowId can be undefined for the current window; chrome
  // accepts null at runtime for "current", but @types/chrome only types
  // `number | undefined`, so cast the `?? null` arg to keep the existing
  // call shape without changing behavior.
  return tabs.captureVisibleTab(
    /** @type {number} */ (/** @type {unknown} */ (windowId ?? null)),
    { format, ...(format === 'jpeg' && typeof quality === 'number' ? { quality } : {}) },
  );
};
