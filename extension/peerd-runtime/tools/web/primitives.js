// @ts-check
// Internal helpers for the web wrapper tools.
//
// These are NOT tools — they're composable building blocks. With web_search /
// read_article / submit_form removed, the only surviving consumers are:
//   - fetchUrl   → backs the fetch_url tool (the web actor's sessionless fetch)
//   - captureVisible → backs the capture tool (user-facing screenshot)
//   - tabsOf     → internal narrowing helper used by captureVisible
//
// The tab-driving primitives (openWebTab / readTabContent / submitFormInTab /
// closeTab / waitForLoad / the landed-host guard) are GONE: the web actor drives
// pages through the real DOM tools now, not these one-off scrapers.
//
// All helpers take a ToolContext and read ctx.{webFetch, tabs} so they remain
// testable with mock ctx objects. Web fetches go through ctx.webFetch
// (denylist-gated) NOT ctx.safeFetch (provider-allowlist-locked).

const FETCH_TIMEOUT_MS = 20_000;

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */

// why: ToolContext types tabs as opaque `Object`/optional (the contract slot).
// This erased cast narrows it to the exact chrome.tabs surface captureVisible
// calls, at the one point it reaches in — keeping the body type-checked without
// changing the public contract.
/** @param {ToolContext} ctx @returns {typeof chrome.tabs} */
const tabsOf = (ctx) => /** @type {typeof chrome.tabs} */ (/** @type {unknown} */ (ctx.tabs));

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
