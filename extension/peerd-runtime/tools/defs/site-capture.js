// @ts-check
// site_capture — record the page's OWN network traffic while you drive it, then
// digest it into a draft SITE CLIENT dossier (DESIGN-19 Phase 2).
//
// Two taps behind ONE capability (the CDP-vs-scripting dual-backend posture): on
// preview/dev, CDP Network on the debugger pool (full fidelity); on store-Chrome
// AND Firefox, a chrome.scripting MAIN-world fetch/XHR wrap (no new permission).
// The SW picks by the SAME availability check the DOM tools use — never a channel
// probe. Credentials are redacted at the tap boundary (digest.js) before anything
// reaches here, the model, or the store.
//
// Flow: site_capture({action:'start'}) → drive the site (navigate/click/type) →
// site_capture({action:'stop'}) returns a redacted endpoint inventory the actor
// turns into a client via site_client_write (a confirmed write). Web-actor-only,
// tab backing only (an API actor has no tab to observe — it derives by probing).

import { wrapUntrusted } from '../prompt-wrap.js';
import { originOfUrl } from './dom-helpers.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteCaptureTool = {
  name: 'site_capture',
  primitive: 'web',
  description: [
    'Record the API traffic a page makes while YOU drive it, to derive a reusable',
    'site client. { action: "start" } begins recording on your owned tab; then',
    'navigate/click/type through a representative flow; { action: "stop" } returns a',
    'redacted endpoint inventory (credentials are never captured). Turn that inventory',
    'into a client with site_client_write. Only records same-origin API calls on the',
    'tab you own — open the site first (navigate).',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['start', 'stop'], description: 'start recording, or stop and get the digest.' },
    },
  },
  sideEffect: 'read',
  origins: () => [],
  execute: async (args, ctx) => {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') return { ok: false, error: 'action_must_be_start_or_stop' };
    const capture = /** @type {{ start?: (o: object) => Promise<any>, stop?: (o: object) => Promise<any> } | undefined} */ (
      /** @type {any} */ (ctx).siteCapture);
    if (!capture?.start || !capture?.stop) return { ok: false, error: 'site_capture_unavailable' };
    const tab = /** @type {{ id?: number, origin?: string, url?: string } | undefined} */ (ctx.activeTab);
    if (!tab?.id || !tab.origin) {
      return { ok: false, error: 'no_owned_tab: open the site first (navigate), then start capture.' };
    }
    // issue 251 — the origin lock. This tool is the one that drives and reads a
    // tab WITHOUT going through resolveTargetTab (it needs the tabId, not the Tab),
    // so the DOM chokepoint does not cover it and adversarial review flagged the
    // hole: a hijacked actor whose tab had moved to a credentialed origin could
    // start a capture there and read every request the page makes. Judging the
    // live location here closes it at the same policy the DOM tools use.
    const judge = /** @type {{ judgeLanding?: (url: string) => Promise<{ action: string, reason?: string } | null> }} */ (
      /** @type {any} */ (ctx)).judgeLanding;
    if (judge) {
      const verdict = await judge(tab.url || tab.origin);
      if (verdict && verdict.action !== 'continue') {
        return { ok: false, error: `origin_lock: ${verdict.reason ?? 'this task was stopped'}` };
      }
    }
    // Same-origin (+ obvious api. sibling) scope for the digest — third-party
    // analytics noise is dropped. The tab's LIVE origin is authoritative.
    const origins = relatedOrigins(tab.origin);

    try {
      if (action === 'start') {
        const r = await capture.start({ tabId: tab.id, origins });
        return { ok: true, content: `capture started on ${tab.origin} (via ${r?.tap ?? 'tap'}). Drive the site, then site_capture stop.` };
      }
      const digest = await capture.stop({ tabId: tab.id, origins });
      const endpoints = (digest?.endpoints ?? []);
      if (!endpoints.length) {
        return { ok: true, content: `capture stopped — no same-origin API traffic observed (dropped ${digest?.dropped ?? 0} out-of-scope). If the page loaded before capture started, re-run with capture on from the start.` };
      }
      const body = [
        `deriver: ${digest.deriver}`,
        `auth posture: ${digest.auth}`,
        `endpoints (${endpoints.length}):`,
        ...endpoints.map((/** @type {{method:string,path:string,note?:string}} */ e) => `  ${e.method} ${e.path}${e.note ? ` — ${e.note}` : ''}`),
        '',
        'Turn this into a client module with site_client_write (a confirmed write).',
      ].join('\n');
      // The inventory is derived from page traffic → fenced, tagged with the origin.
      const fenced = wrapUntrusted({ origin: originOfUrl(tab.origin) || tab.origin, tool: 'site_capture', body });
      return { ok: true, content: fenced };
    } catch (e) {
      return { ok: false, error: `site_capture_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};

/**
 * The origins in scope for a capture: the tab's own origin plus an `api.<domain>`
 * sibling (common split — the app on www., the API on api.). Pure-ish (URL parse).
 * @param {string} origin
 * @returns {string[]}
 */
const relatedOrigins = (origin) => {
  const out = [origin];
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^www\./, '');
    const apiHost = `api.${host}`;
    if (apiHost !== u.hostname) out.push(`${u.protocol}//${apiHost}`);
  } catch { /* keep just the origin */ }
  return out;
};
