// @ts-check
// navigate — change the URL of the target tab and wait for load.
//
// V1 semantics:
//   - Default target is the active tab; pass tabId for a specific one.
//   - We update the URL and wait for chrome.tabs.onUpdated(status='complete').
//   - 30s timeout — pages that never fire 'complete' (websockets, infinite
//     scroll bootstraps) resolve with a "navigation timed out, partial
//     state may apply" warning; the agent can read_page to see what loaded.
//
// origins() returns BOTH the current tab origin and the destination
// origin so the denylist gate fires if either is denylisted.

import { resolveTargetTab, originOfUrl } from './dom-helpers.js';

const NAV_TIMEOUT_MS = 30_000;

/**
 * A browser tab as surfaced by browser.tabs.get.
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 */

/**
 * The browser.tabs surface navigate exercises.
 * @typedef {Object} TabsApi
 * @property {(tabId: number) => Promise<BrowserTab>} get
 * @property {(tabId: number, props: { url: string }) => Promise<unknown>} update
 * @property {{ addListener: (l: NavListener) => void, removeListener: (l: NavListener) => void }} onUpdated
 */

/**
 * @callback NavListener
 * @param {number} tabId
 * @param {{ status?: string }} changeInfo
 * @returns {void}
 */

// Destination schemes navigate will load. http(s) only: Chrome BLOCKS
// top-frame navigation to data: (and effectively blob:) URLs as an
// anti-phishing measure, so tabs.update silently no-ops and the load
// times out. Don't pretend to support them. (To render self-contained
// HTML the a11y tree can read, there is no good path today — Apps are
// sandboxed cross-origin iframes the a11y tree can't see into; use a real
// http(s) page for DOM work.)
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:']);

/** @type {import('/shared/tool-types.js').Tool} */
export const navigateTool = {
  name: 'navigate',
  primitive: 'tab',
  description: [
    'Navigate the target tab to an http(s) URL. OPENS the tab if you do not',
    'own one yet (the web actor starts tabless: navigate is how you go from',
    'fetch-only to a rendered page — there is no separate open-tab tool and',
    'you never need one). Waits up to 30s for the page to finish loading.',
    'Returns the final URL (may differ from the requested URL after',
    'redirects).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to navigate to (must include scheme).',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id; defaults to the active tab.',
      },
    },
    required: ['url'],
  },
  sideEffect: 'write',
  origins: (args, ctx) => {
    /** @type {string[]} */
    const out = [];
    if (ctx.activeTab?.origin) out.push(ctx.activeTab.origin);
    const dest = originOfUrl(args?.url);
    if (dest && !out.includes(dest)) out.push(dest);
    return out;
  },

  execute: async (args, ctx) => {
    if (!args?.url || typeof args.url !== 'string') {
      return { ok: false, error: 'url_required' };
    }
    let parsed;
    try { parsed = new URL(args.url); }
    catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
    // Allowlist of safe destination schemes. http(s) is the norm; data:
    // and blob: let the agent render self-contained HTML (test pages,
    // generated previews) WITHOUT the App/sandboxed-iframe detour that the
    // a11y tree can't see into. javascript:/file:/chrome: stay rejected —
    // they're injection / local-fs / privileged surfaces.
    if (!NAVIGABLE_SCHEMES.has(parsed.protocol)) {
      // why: actionable so the agent doesn't improvise (e.g. hosting HTML
      // in an App, whose sandboxed iframe the a11y tree can't read).
      return {
        ok: false,
        error: `unsupported_scheme: ${parsed.protocol} — navigate only loads http(s). `
          + 'Chrome blocks data:/blob: top-frame navigation. For DOM work use a real http(s) page.',
      };
    }

    const c = /** @type {any} */ (ctx);
    let tab = await resolveTargetTab(args, ctx);
    // DESIGN-17 lazy tab adoption: the web ACTOR (kind:'web') may own 0 tabs — a
    // pure-fetch task never rendered. navigate IS the render decision made concrete:
    // when it owns no tab, open + adopt one now (SW-side ctx.adoptWebTab). Only the web
    // kind gets adoptWebTab; every other no-tab path still fails closed.
    // why repinActiveTab (not a direct ctx.activeTab = …): the dispatcher hands each
    // tool a per-call SHALLOW COPY ({ ...ctx }), so reassigning activeTab on THIS object
    // dies with the copy. repinActiveTab closes over the SHARED turn ctx, so the rest of
    // the turn's DOM tools + the session-scoped webFetch see the adopted tab. We keep a
    // local ref (adoptedPin === the shared object) to re-stamp the landed origin below.
    /** @type {{ id: number, windowId?: number, url: string, origin: string } | null} */
    let adoptedPin = null;
    // issue 251 — ADOPT ONLY FROM THE GENUINE 0-TAB STATE. resolveTargetTab
    // returns null for two very different reasons: "this actor owns no tab yet"
    // and "the origin lock (or the denylist) REFUSED the tab it owns". Adopting
    // on the second turns a refusal into a brand-new tab the actor may drive
    // anywhere — and because adoption re-pins ctx.activeTab, which IS the
    // session-credential scope, every 'end' verdict would buy another
    // credentialed tab. `c.activeTab?.id` is the discriminator: an actor in the
    // real 0-tab state has no pin at all.
    //
    // why this is called out rather than quietly fixed: the previous commit's
    // comment in dom-helpers.js claimed "every caller already treats null as a
    // refusal, so the fail-closed shape is free". That was FALSE for the one
    // caller that can create a tab, and an adversarial review proved it by
    // execution. The chokepoint is only fail-closed once this guard exists.
    if (!tab?.id && !c.activeTab?.id && typeof c.adoptWebTab === 'function') {
      let adopted;
      try { adopted = await c.adoptWebTab(); }
      catch (e) { return { ok: false, error: `tab_open_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? 'could not open a tab'}` }; }
      if (!adopted?.tabId) return { ok: false, error: 'tab_open_failed' };
      // url/origin blank: freshly opened to about:blank; navigate drives it next and the
      // post-load block re-stamps the real origin on this same (shared) object.
      adoptedPin = { id: adopted.tabId, windowId: adopted.windowId, url: '', origin: '' };
      if (typeof c.repinActiveTab === 'function') c.repinActiveTab(adoptedPin);
      else c.activeTab = adoptedPin;   // direct-execute / non-actor fallback
      tab = { id: adopted.tabId };
    }
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };
    const tabId = tab.id;

    try {
      await waitForNavigation(ctx, tabId, args.url);
    } catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message;
      return {
        ok: false,
        error: msg ?? 'navigation_failed',
        content: JSON.stringify({ requested: args.url, timed_out: /timed out/i.test(msg ?? '') }),
      };
    }

    // Read the final URL — may differ after redirects.
    // why: ctx.tabs is the opaque `Object` contract slot; narrow to get().
    const tabsApi = /** @type {TabsApi} */ (ctx.tabs);
    /** @type {BrowserTab} */
    let finalTab;
    try { finalTab = await tabsApi.get(tabId); }
    catch { finalTab = tab; }

    // Keep the turn's activeTab pin fresh: if it points at the tab we just drove,
    // re-stamp its url/origin to where the page LANDED so the next tool's origin gate
    // sees the live origin, not the turn-start one (matters most for a freshly-adopted
    // web-actor tab, which started blank). adoptedPin IS the shared object (set via
    // repinActiveTab); for an already-owned tab, ctx.activeTab is the same object the
    // shallow copy shares — both mutate in place. resolveTargetTab's in-execute denylist
    // re-check is still the second wall on the landing.
    //
    // issue 251 — THE PIN TRACKS REALITY, ALWAYS. A draft of this PR froze it at
    // the actor's owned origin on an off-origin landing, reasoning that the
    // re-stamp is what launders an open redirect. That was wrong twice over, and
    // an adversarial review caught it:
    //
    //   1. This pin IS the credential scope. service-worker.js wires
    //      `webFetch = withSessionScopedCredentials(webFetch, () => ctx.activeTab?.origin)`
    //      and peerd-egress reads that getter LIVE on every fetch to decide
    //      `credentials:'include'`. Freezing it at the owned origin leaves a
    //      hijacked actor sitting on the attacker's page still holding
    //      CREDENTIALED reach into the origin it left — strictly worse than the
    //      laundering it was meant to stop.
    //   2. It is also what the confirm prompt, the origin gate, and the audit
    //      log report. A frozen pin tells the user "on github.com" while the
    //      tool acts on evil.test. A security change must not make the record
    //      lie.
    //
    // The origin LOCK does not need this and never did: what an actor OWNS is
    // separate state (actor/origin-lock.js), and decideLanding compares the live
    // tab URL against that, never against the pin. Reality here, ownership
    // there, and the two are allowed to disagree — the disagreement is exactly
    // what the lock detects on the next tool call.
    const pin = adoptedPin ?? c.activeTab;
    if (pin && pin.id === tabId && finalTab?.url) {
      pin.url = finalTab.url;
      pin.origin = originOfUrl(finalTab.url) ?? pin.origin;
    }
    // issue 251 — JUDGE THE LANDING WE JUST CAUSED. resolveTargetTab judged the
    // tab's PRE-navigation URL; this is the only place in the tree that sees a
    // landing at the moment it is created, and it is exactly case (2) of the
    // landing rule's own enumeration — "that navigation 302s somewhere else, no
    // tool call for the hop". Without this the lock is structurally ONE TOOL
    // CALL LATE: the actor lands on a credentialed origin, the pin (and with it
    // the session-credential scope) follows, and the refusal only fires if the
    // actor happens to make another DOM tool call — which it need not, because
    // fetch_url and the site_client_* tools never pass through resolveTargetTab.
    //
    // Ordering: AFTER the re-stamp, so the pin tells the truth in the audit and
    // the confirm even on a refusal, and so a same-origin path change is judged
    // against reality.
    if (c.judgeLanding && finalTab?.url) {
      const verdict = await c.judgeLanding(finalTab.url);
      if (verdict && verdict.action !== 'continue') {
        return { ok: false, error: `origin_lock: ${verdict.reason ?? 'this task was stopped'}` };
      }
    }
    // A freshly-adopted web-actor tab is a peerd-opened web page, same as open_tab —
    // give it the agent-tab card (the landed URL as its label, not a blank "a tab") and
    // schedule the "pull peerd in" orientation hint, matching the open_tab path.
    if (adoptedPin && finalTab?.url) {
      try { c.noteTab?.(tabId, finalTab.url, { opened: true }); } catch { /* best-effort */ }
      try { c.hintPullIn?.(tabId, finalTab.url); } catch { /* best-effort */ }
    }

    return {
      ok: true,
      content: JSON.stringify({
        requested: args.url,
        finalUrl: finalTab?.url ?? args.url,
        tabId,
      }, null, 2),
    };
  },
};

/**
 * @param {import('/shared/tool-types.js').ToolContext} ctx
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
const waitForNavigation = (ctx, tabId, url) => new Promise((resolve, reject) => {
  // why: ctx.tabs is the opaque `Object` contract slot; narrow to the
  // onUpdated/update surface this navigation watcher exercises.
  const tabsApi = /** @type {TabsApi} */ (ctx.tabs);
  let settled = false;
  /** @param {Error | null} err */
  const finish = (err) => {
    if (settled) return;
    settled = true;
    tabsApi.onUpdated.removeListener(listener);
    clearTimeout(timer);
    err ? reject(err) : resolve();
  };
  /** @type {NavListener} */
  const listener = (id, info) => {
    if (id !== tabId) return;
    if (info.status === 'complete') finish(null);
  };
  tabsApi.onUpdated.addListener(listener);
  const timer = setTimeout(() => finish(new Error('navigation timed out after 30s')), NAV_TIMEOUT_MS);
  tabsApi.update(tabId, { url }).catch(finish);
});
