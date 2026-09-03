// @ts-check

// open_tab: open a new browser tab, optionally pre-loaded with a URL.
//
// This is mutate_external in spirit (it changes user-visible browser
// state), so it's gated: Plan refuses it (clicks/new tabs aren't pure
// reads: pure URL loads via navigate/open_tab are the lone Plan
// exception, see docs/DECISIONS.md #16), and Act can route it through a
// confirmation prompt per the denylist + confirmActions policy.

import {
  BROWSER_TARGET_STAGES,
  browserNetworkGuardPostNavigationReceipt,
  browserTargetRefusalReceipt,
  browserTargetRefusalReceiptFrom,
  classifyBrowserAutomationTarget,
  isDenylistedTab,
  resetToVerifiedBlank,
  sensitiveSiteBrowserTargetVerdict,
  updateAndObserveCommittedNavigation,
} from '/peerd-runtime/browser-authority.js';

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

/** @param {any} args @param {any} ctx */
export const openProtectedBackgroundTabAuthority = async (args, ctx) => {
    const stoppedResult = (performed = false) => ({
      ok: false, error: 'page action was stopped',
      outcomeKind: performed ? 'effect-completed' : 'pre-effect-failure', retryable: false,
    });
    // why background, always: a tab peerd opens no longer steals the user away
    // (DESIGN-12, owner 2026-06-18). It opens quietly and ctx.announceTab drops a
    // "go there" card in the chat: the user's click focuses it AND opens the side
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
      if (!verdict.allowed) return browserTargetRefusalReceipt(verdict);
      requestedUrl = new URL(String(args.url).trim()).toString();
      // why: creating the tab blank lets the same correlated observer used by
      // navigate own the requested transition from its first event.
      opts.url = 'about:blank';
    }
    // why: ctx.tabs is the opaque `Object` contract slot; narrow to the tab
    // creation and committed-navigation surface used here.
    const tabsApi = /** @type {import('/peerd-runtime/browser-authority/committed-navigation.js').NavigationTabsApi & { create: (opts: CreateOpts) => Promise<BrowserTab>, remove?: (tabId: number) => Promise<unknown> }} */ (ctx.tabs);
    // why: noteTab / hintPullIn are optional SW-injected context extras not on
    // the ToolContext contract slot.
    const ctxExtras = /** @type {{ noteTab?: (id: number | undefined, label?: string) => Promise<unknown>, hintPullIn?: (id: number | undefined, url: string) => unknown, judgeLanding?: (url: string) => Promise<unknown>, navigationTimeoutMs?: number, ensureBrowserNetworkGuard?: (tabId: number, targetUrl?: string) => Promise<import('/shared/tool-types.js').ToolResult>, armBrowserChildQuarantine?: (tabId:number)=>Promise<import('/shared/tool-types.js').ToolResult>, updateBrowserNetworkGuardOrigin?: (tabId: number, rawUrl?: string) => Promise<import('/shared/tool-types.js').ToolResult> }} */ (ctx);
    /** @type {BrowserTab} */
    let tab;
    if (ctx.abortSignal?.aborted) return stoppedResult();
    try { tab = await tabsApi.create(opts); }
    catch (e) {
      return { ok: false, error: `tabs_create_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!tab.id) return { ok: false, error: 'tabs_create_failed: browser returned no tab id' };
    if (ctx.abortSignal?.aborted) {
      return stoppedResult(!await closeCreatedTab(tabsApi, tab.id));
    }
    if (typeof ctxExtras.ensureBrowserNetworkGuard === 'function') {
      const guarded = await ctxExtras.ensureBrowserNetworkGuard(tab.id, requestedUrl ?? tab.url);
      if (!guarded.ok) {
        const closed = await closeCreatedTab(tabsApi, tab.id);
        const refusal = browserTargetRefusalReceiptFrom(guarded, {
          effectCompleted: !closed,
        });
        const structured = /** @type {any} */ (refusal).structured;
        return {
          ...refusal,
          structured: {
            ...structured,
            cleanup: closed ? 'new_tab_closed' : 'new_tab_close_failed',
          },
        };
      }
    }
    if (requestedUrl && typeof ctxExtras.armBrowserChildQuarantine === 'function') {
      const armed = await ctxExtras.armBrowserChildQuarantine(tab.id);
      if (!armed.ok) {
        const closed = await closeCreatedTab(tabsApi, tab.id);
        return closed || armed.outcomeKnown === false
          ? armed : { ...armed, outcomeKind: 'effect-completed' };
      }
    }
    if (ctx.abortSignal?.aborted) {
      return stoppedResult(!await closeCreatedTab(tabsApi, tab.id));
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
            structured: { neutralized, phase: 'final_url_unavailable', target: 'new_tab' },
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
          const refusal = browserTargetRefusalReceipt(committedVerdict, { neutralized });
          return {
            ...refusal,
            structured: {
              ...refusal.structured,
              cleanup: neutralized ? 'new_tab_reset_verified_blank' : 'new_tab_reset_failed',
            },
          };
        }

        if (isDenylistedTab(finalTab?.url, ctx.denylist)) {
          if (ctxExtras.judgeLanding && finalTab?.url) {
            try { await ctxExtras.judgeLanding(finalTab.url); } catch { /* best-effort */ }
          }
          const neutralized = await resetToVerifiedBlank(tabsApi, tab.id, {
            timeoutMs: navigationTimeoutMs,
          });
          const refusal = browserTargetRefusalReceipt(sensitiveSiteBrowserTargetVerdict(), {
            neutralized,
          });
          return {
            ...refusal,
            structured: {
              ...refusal.structured,
              cleanup: neutralized ? 'new_tab_reset_verified_blank' : 'new_tab_reset_failed',
            },
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
            const refusal = browserNetworkGuardPostNavigationReceipt(
              guarded.structured?.reason,
            );
            return {
              ...refusal,
              structured: {
                ...refusal.structured,
                neutralized: closed,
                cleanup: closed ? 'new_tab_closed' : 'new_tab_close_failed',
              },
            };
          }
        }

        if (navigation.status !== 'complete') {
          return {
            ok: false,
            error: navigation.status === 'timeout'
              ? 'navigation_timeout'
              : `navigation_failed: ${navigation.error ?? 'tabs.update was rejected'}`,
            structured: {
              tabId: tab.id,
              finalUrl: finalTab?.url ?? requestedUrl,
              timed_out: navigation.status === 'timeout',
            },
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
      receipt: { tabId: tab.id, url: tab.url || tab.pendingUrl || requestedUrl || '' },
    };
};

/** @param {{remove?:(tabId:number)=>Promise<unknown>}} tabsApi @param {number} tabId */
const closeCreatedTab = async (tabsApi, tabId) => {
  if (typeof tabsApi.remove !== 'function') return false;
  try { await tabsApi.remove(tabId); return true; }
  catch { return false; }
};
