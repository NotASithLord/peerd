// @ts-check
// open_tab — open a new browser tab, optionally pre-loaded with a URL.
//
// This is mutate_external in spirit (it changes user-visible browser
// state), so it's gated: Plan refuses it (clicks/new tabs aren't pure
// reads — pure URL loads via navigate/open_tab are the lone Plan
// exception, see docs/DECISIONS.md #16), and Act can route it through a
// confirmation prompt per the denylist + confirmActions policy.

import { isDenylistedTab, originOfUrl } from './dom-helpers.js';
import {
  BROWSER_TARGET_STAGES,
  browserNetworkGuardPostNavigationResult,
  browserTargetRefusalResult,
  classifyBrowserAutomationTarget,
  sensitiveSiteBrowserTargetVerdict,
} from '../browser-automation-policy.js';
import {
  resetToVerifiedBlank,
  updateAndObserveCommittedNavigation,
} from './committed-navigation.js';

const NAV_TIMEOUT_MS = 30_000;

/**
 * A browser tab as surfaced by browser.tabs.create.
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [pendingUrl]
 */

/**
 * Options accepted by browser.tabs.create (subset this tool sets).
 * @typedef {Object} CreateOpts
 * @property {boolean} active
 * @property {number} [windowId]
 * @property {string} [url]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const openTabTool = {
  name: 'open_tab',
  primitive: 'tab',
  description: [
    'Open a new browser tab. Pass url to pre-load it; omit for a blank',
    'new tab. The tab opens in the BACKGROUND and a "go there" card appears in',
    'the chat — peerd never yanks the user to a new tab; they click to go.',
    "Returns the new tab id. If its final site is ordinary, the web actor can work",
    "there via message_actor with to:'<that tabId>'. A redirect to a site peerd treats",
    "as signed in is refused; use its explicit site:<origin> actor only when the user's",
    "request already targets that site. Do NOT combine open_tab with to:'web', which opens its",
    "OWN tab. For a fresh web task, skip open_tab and just message_actor to:'web'",
    'with the goal (it opens a tab itself only if it decides to render).',
    'This opens a protected peerd tab. Until the tab closes, peerd blocks private',
    'or local network destinations and sites in the sensitive-site denylist.',
    'Use a normal tab for unrestricted browsing.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Optional absolute URL to load. Must include scheme.',
      },
    },
  },
  sideEffect: 'mutate_external',
  origins: (args) => {
    const dest = originOfUrl(args?.url);
    return dest ? [dest] : [];
  },

  execute: async (args, ctx) => {
    // why background, always: a tab peerd opens no longer steals the user away
    // (DESIGN-12, owner 2026-06-18). It opens quietly and ctx.announceTab drops a
    // "go there" card in the chat — the user's click focuses it AND opens the side
    // panel (the click is the only gesture Chrome lets us open the panel in).
    // Co-locate with the tab the agent is working in: a new tab opens in the
    // active tab's window, not a random last-focused one. No-op for normal use
    // (active tab is already in the current window); it keeps eval/headless tabs
    // together in their own window instead of leaking into the user's.
    /** @type {CreateOpts} */
    const opts = { active: false };
    // why: activeTab.windowId is not on the ActiveTab contract slot; read it
    // off a narrowed view so we can co-locate the new tab with the agent's.
    const activeWindowId = /** @type {{ windowId?: number }} */ (ctx.activeTab ?? {}).windowId;
    if (activeWindowId != null) opts.windowId = activeWindowId;
    /** @type {string | null} */
    let requestedUrl = null;
    if (args?.url) {
      const verdict = classifyBrowserAutomationTarget(args.url, {
        stage: BROWSER_TARGET_STAGES.PRE_NAVIGATION,
      });
      if (!verdict.allowed) return browserTargetRefusalResult(verdict);
      requestedUrl = new URL(String(args.url).trim()).toString();
      // why: creating the tab blank lets the same correlated observer used by
      // navigate own the requested transition from its first event.
      opts.url = 'about:blank';
    }
    // why: ctx.tabs is the opaque `Object` contract slot; narrow to the tab
    // creation and committed-navigation surface used here.
    const tabsApi = /** @type {import('./committed-navigation.js').NavigationTabsApi & { create: (opts: CreateOpts) => Promise<BrowserTab>, remove?: (tabId: number) => Promise<unknown> }} */ (ctx.tabs);
    // why: noteTab / hintPullIn are optional SW-injected context extras not on
    // the ToolContext contract slot.
    const ctxExtras = /** @type {{ noteTab?: (id: number | undefined, label?: string) => Promise<unknown>, hintPullIn?: (id: number | undefined, url: string) => unknown, judgeLanding?: (url: string) => Promise<unknown>, navigationTimeoutMs?: number, ensureBrowserNetworkGuard?: (tabId: number, targetUrl?: string) => Promise<import('/shared/tool-types.js').ToolResult>, updateBrowserNetworkGuardOrigin?: (tabId: number, rawUrl?: string) => Promise<import('/shared/tool-types.js').ToolResult> }} */ (ctx);
    /** @type {BrowserTab} */
    let tab;
    try { tab = await tabsApi.create(opts); }
    catch (e) {
      return { ok: false, error: `tabs_create_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!tab.id) return { ok: false, error: 'tabs_create_failed: browser returned no tab id' };
    if (typeof ctxExtras.ensureBrowserNetworkGuard === 'function') {
      const guarded = await ctxExtras.ensureBrowserNetworkGuard(tab.id, requestedUrl ?? tab.url);
      if (!guarded.ok) {
        await tabsApi.remove?.(tab.id).catch(() => {});
        return guarded;
      }
    }

    const navigationTimeoutMs = Number.isFinite(ctxExtras.navigationTimeoutMs)
        ? Math.max(1, Number(ctxExtras.navigationTimeoutMs))
        : NAV_TIMEOUT_MS;
      if (requestedUrl) {
        const navigation = await updateAndObserveCommittedNavigation(
          tabsApi,
          tab.id,
          requestedUrl,
          { timeoutMs: navigationTimeoutMs },
        );
        /** @type {BrowserTab} */
        let finalTab;
        try { finalTab = await tabsApi.get(tab.id); }
        catch {
          const neutralized = await resetToVerifiedBlank(tabsApi, tab.id, {
            timeoutMs: navigationTimeoutMs,
          });
          return {
            ok: false,
            error: 'navigation_final_url_unavailable',
            content: neutralized
              ? 'peerd could not verify the opened page. The new tab was reset to a verified blank page.'
              : 'peerd could not verify the opened page or reset the new tab. Browser automation remains stopped for it.',
            outcomeKind: 'host-lost',
          };
        }

        const committedVerdict = classifyBrowserAutomationTarget(finalTab?.url, {
          stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
        });
        if (!committedVerdict.allowed) {
          if (ctxExtras.judgeLanding && finalTab?.url) {
            try { await ctxExtras.judgeLanding(finalTab.url); } catch { /* best-effort */ }
          }
          const neutralized = await resetToVerifiedBlank(tabsApi, tab.id, {
            timeoutMs: navigationTimeoutMs,
          });
          const refusal = browserTargetRefusalResult(committedVerdict, { neutralized });
          return {
            ...refusal,
            content: `${refusal.content} ${neutralized
              ? 'The new tab was reset to a verified blank page.'
              : 'The new tab could not be reset, so browser automation remains stopped for it.'}`,
          };
        }

        if (isDenylistedTab(finalTab?.url, ctx.denylist)) {
          if (ctxExtras.judgeLanding && finalTab?.url) {
            try { await ctxExtras.judgeLanding(finalTab.url); } catch { /* best-effort */ }
          }
          const neutralized = await resetToVerifiedBlank(tabsApi, tab.id, {
            timeoutMs: navigationTimeoutMs,
          });
          const refusal = browserTargetRefusalResult(sensitiveSiteBrowserTargetVerdict(), {
            neutralized,
          });
          return {
            ...refusal,
            content: `${refusal.content} ${neutralized
              ? 'The new tab was reset to a verified blank page.'
              : 'The new tab could not be reset, so browser automation remains stopped for it.'}`,
          };
        }

        if (typeof ctxExtras.updateBrowserNetworkGuardOrigin === 'function') {
          const guarded = await ctxExtras.updateBrowserNetworkGuardOrigin(tab.id, finalTab?.url);
          if (!guarded.ok) {
            let closed = false;
            if (typeof tabsApi.remove === 'function') {
              try {
                await tabsApi.remove(tab.id);
                closed = true;
              } catch { /* the policy result below reports the failed cleanup */ }
            }
            const refusal = browserNetworkGuardPostNavigationResult(
              guarded.structured?.reason,
            );
            return {
              ...refusal,
              structured: { ...refusal.structured, neutralized: closed },
              content: `${refusal.content} ${closed
                ? 'The new tab was closed.'
                : 'The new tab could not be closed, so browser automation remains stopped for it.'}`,
            };
          }
        }

        if (navigation.status !== 'complete') {
          return {
            ok: false,
            error: navigation.status === 'timeout'
              ? 'navigation_timeout'
              : `navigation_failed: ${navigation.error ?? 'tabs.update was rejected'}`,
            content: JSON.stringify({
              tabId: tab.id,
              finalUrl: finalTab?.url ?? requestedUrl,
              timed_out: navigation.status === 'timeout',
            }),
            outcomeKind: 'host-lost',
          };
        }
        tab = finalTab;
      }

      const finalLabel = requestedUrl ? tab.url || requestedUrl : 'a new tab';
      try { await ctxExtras.noteTab?.(tab.id, finalLabel); }
      catch (e) { console.debug('[open_tab] noteTab failed', e); }
      // why: a peerd-opened web page can't carry the pull-in button, so it gets the
      // informational reminder instead (the SW injects it once the tab is visible).
      // Only for real URL opens: a blank new tab has nothing to orient toward.
      if (requestedUrl) { try { ctxExtras.hintPullIn?.(tab.id, tab.url || requestedUrl); } catch (e) { console.debug('[open_tab] hintPullIn failed', e); } }
    return {
      ok: true,
      content: JSON.stringify({
        tabId: tab.id,
        url: tab.url || tab.pendingUrl || requestedUrl || '',
        networkGuard: {
          scope: 'tab_and_visited_origin_workers',
          lifetime: 'until_tab_closed',
          blocks: ['private_network', 'sensitive_site_denylist'],
          workerScope: 'private_network_fetch',
          chromeWorkerWebSocket: 'not_covered_by_dnr',
        },
      }, null, 2),
    };
  },
};
