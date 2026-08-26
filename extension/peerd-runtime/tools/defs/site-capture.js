// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// site_capture: record the page's OWN network traffic while you drive it, then
// digest it into a draft SITE CLIENT dossier (DESIGN-19 Phase 2).
//
// Two taps behind ONE capability (the CDP-vs-scripting dual-backend posture): on
// preview/dev, CDP Network on the debugger pool (full fidelity); on store-Chrome
// AND Firefox, a chrome.scripting MAIN-world fetch/XHR wrap (no new permission).
// The SW picks by the SAME availability check the DOM tools use; never a channel
// probe. Credentials are redacted at the tap boundary (digest.js) before anything
// reaches here, the model, or the store.
//
// Flow: site_capture({action:'start'}) → drive the site (navigate/click/type) →
// site_capture({action:'stop'}) returns a redacted endpoint inventory the actor
// turns into a client via site_client_write (a confirmed write). Web-actor-only,
// tab backing only (an API actor has no tab to observe; it derives by probing).

import { wrapUntrusted } from '../prompt-wrap.js';
import { browserDocumentIdentity, originOfUrl, resolveTargetTab } from '../../browser-authority/dom-helpers.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteCaptureTool = composeTool("site_capture", {
  execute: async (args, ctx) => {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') return { ok: false, error: 'action_must_be_start_or_stop' };
    const capture = /** @type {{ start?: (o: object) => Promise<any>, stop?: (o: object) => Promise<any>, cancel?: (o: object) => Promise<any> } | undefined} */ (
      /** @type {any} */ (ctx).siteCapture);
    if (!capture?.start || !capture?.stop) return { ok: false, error: 'site_capture_unavailable' };
    // This raw tab-backed tool does not otherwise pass through the DOM helpers.
    // Resolve the live owned tab here so private-network, denylist, and origin
    // lock policy all run before capture starts or returns data.
    const ownedTabId = typeof ctx?.activeTab?.id === 'number' ? ctx.activeTab.id : null;
    let tab;
    try {
      tab = await resolveTargetTab({}, /** @type {any} */ (ctx));
    } catch (error) {
      // A capture that began on a public document must not keep observing after
      // that tab lands on a private destination. Cancel without injecting into
      // the blocked document, discard every recorded event, then preserve the
      // policy error for the caller.
      if (ownedTabId !== null) {
        try { await capture.cancel?.({ tabId: ownedTabId }); } catch { /* preserve the policy refusal */ }
      }
      throw error;
    }
    const tabOrigin = originOfUrl(tab?.url);
    if (!tab?.id || !/^https?:\/\//.test(tabOrigin)) {
      if (ownedTabId !== null) {
        try { await capture.cancel?.({ tabId: ownedTabId }); } catch { /* return the stable refusal below */ }
      }
      return {
        ok: false,
        error: 'site_capture_discarded: the owned tab has no web origin; the capture was canceled and its data discarded.',
      };
    }
    // Observe the tab plus its common api.<host> sibling, but keep the digest
    // attributed per exact origin. A syntactic DNS sibling is useful discovery,
    // never custody: only that origin's API actor may verify/persist its client.
    const origins = relatedOrigins(tabOrigin);

    try {
      if (action === 'start') {
        const r = await capture.start({
          tabId: tab.id,
          origins,
          documentId: tab.peerdDocumentId,
          expectedDocument: browserDocumentIdentity(tab),
        });
        return { ok: true, content: `capture started on ${tabOrigin} (via ${r?.tap ?? 'tap'}). Drive the site, then site_capture stop.` };
      }
      const digest = await capture.stop({ tabId: tab.id, origins });
      if (digest?.cancelled === 'page_changed') {
        return {
          ok: false,
          error: 'site_capture_page_changed',
          content: 'The capture ended and its data was discarded because the tab changed pages. Start a new capture on the current page before driving it.',
        };
      }
      const groups = Array.isArray(digest?.originDigests)
        ? digest.originDigests.filter((/** @type {{ endpoints?: unknown[] }} */ group) => group.endpoints?.length)
        : [];
      if (!groups.length) {
        return {
          ok: true,
          content: `capture stopped: no in-scope API traffic observed (dropped ${digest?.dropped ?? 0} out-of-scope). If the page loaded before capture started, re-run with capture on from the start. If its API is on another origin, address that exact API actor and derive its client there; sibling hosts are observed only when explicitly attributed, never inferred as shared custody.`,
        };
      }
      const body = [
        `deriver: ${digest.deriver}`,
        `captured origins (${groups.length}):`,
        ...groups.flatMap((/** @type {{origin:string,auth:string,endpoints:Array<{method:string,path:string,note?:string}>}} */ group) => [
          `origin: ${group.origin}${group.origin === tabOrigin ? ' (owned tab)' : ' (related observation; separate custody)'}`,
          `  auth posture: ${group.auth}`,
          `  endpoints (${group.endpoints.length}):`,
          ...group.endpoints.map((e) => `    ${e.method} ${e.path}${e.note ? ` - ${e.note}` : ''}`),
        ]),
        '',
        `Persist only the ${tabOrigin} group here with site_client_write. For every other origin, report the attributed group and have the orchestrator delegate to that exact API actor to verify and derive its own client.`,
      ].join('\n');
      // The inventory is derived from page traffic → fenced, tagged with the origin.
      const fenced = wrapUntrusted({ origin: tabOrigin, tool: 'site_capture', body });
      return { ok: true, content: fenced };
    } catch (e) {
      return { ok: false, error: `site_capture_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});

/**
 * Capture the owned origin plus the common API sibling as separately
 * attributed evidence. This expands observation, never client custody.
 * @param {string} origin
 * @returns {string[]}
 */
const relatedOrigins = (origin) => {
  const out = [origin];
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^www\./, '');
    const apiHost = `api.${host}`;
    if (apiHost !== url.hostname) out.push(`${url.protocol}//${apiHost}`);
  } catch { /* keep just the exact origin */ }
  return out;
};
