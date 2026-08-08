// @ts-check
// capture — screenshot of the active tab.
//
// chrome.tabs.captureVisibleTab requires either the activeTab grant
// (which we have at session start) or <all_urls> host permission.
// V1 captures the active tab by default; explicit windowId is
// supported for multi-window setups.
//
// The result is a base64 data URL. We return it inline; downstream
// rendering (in the side panel chat view) detects the data URL and
// renders the image. For agent consumption, the model can include
// the image in a follow-up vision request — V1 doesn't push it
// directly into context because most provider adapters don't support
// inline base64 images at the schema layer yet.

import { captureVisible } from './primitives.js';
import { originOfUrl, resolveTargetTab } from '../defs/dom-helpers.js';
import {
  BrowserAutomationPolicyError,
  browserTargetRefusalResult,
} from '../browser-automation-policy.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const captureTool = {
  name: 'capture',
  primitive: 'tab',
  description: [
    'Take a screenshot of the visible region of the active tab and show',
    'it to the USER inline in chat. IMPORTANT: you (the model) do NOT',
    'receive the image — its bytes are stripped from your context and',
    'only metadata (dimensions, origin) comes back to you. This is a',
    '"show the user a picture" tool, not a way for you to see the page.',
    'To READ or reason about page content, use read_page / query_dom /',
    'page_exec. Reach for capture only when the user explicitly wants to',
    'SEE something rendered.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      windowId: {
        type: 'integer',
        description: 'Optional window id; defaults to the current window.',
      },
    },
  },
  sideEffect: 'read',
  origins: (_args, ctx) => {
    return ctx?.activeTab?.origin ? [ctx.activeTab.origin] : [];
  },
  execute: async (args, ctx) => {
    /** @type {Map<number, { tabId?: number, token?: string }>} */
    const guardLeases = new Map();
    /** @type {ReturnType<typeof watchTabActivations>} */
    let activationWatch = null;
    try {
      const requestedWindowId = typeof args?.windowId === 'number' ? args.windowId : null;
      // captureVisibleTab has no tab/document target. Watch from before the first
      // foreground query so an A -> B -> A switch cannot make B's pixels pass the
      // two snapshots of A. A browser without this lifecycle signal cannot make
      // foreground capture exact enough, so it fails closed.
      activationWatch = watchTabActivations(ctx.tabs);
      if (!activationWatch) {
        return { ok: false, error: 'capture_failed: tab activation tracking is unavailable' };
      }
      const beforeForeground = await foregroundTab(ctx.tabs, requestedWindowId);
      if (!beforeForeground || typeof beforeForeground.id !== 'number') {
        return { ok: false, error: 'capture_no_foreground_tab: the requested window has no active tab' };
      }
      // captureVisibleTab photographs the window foreground, not an actor pin.
      // Validate the tab the browser will actually photograph. Suppress noteTab:
      // a user foreground tab is not converted into an agent-owned tab merely
      // because the orchestrator showed the user a screenshot of it.
      const acquire = /** @type {{ acquireBrowserNetworkGuardLease?: (tabId: number) => Promise<any> }} */ (ctx)
        .acquireBrowserNetworkGuardLease;
      if (typeof acquire !== 'function') {
        return { ok: false, error: 'capture_failed: browser network guard lease is unavailable' };
      }
      const beforeGuard = await acquire(beforeForeground.id);
      if (!beforeGuard?.ok) return beforeGuard;
      guardLeases.set(beforeForeground.id, beforeGuard.lease);
      const policyCtx = {
        ...ctx,
        noteTab: undefined,
        ensureBrowserNetworkGuard: async () => ({ ok: true }),
      };
      const tab = await resolveTargetTab({ tabId: beforeForeground.id }, /** @type {any} */ (policyCtx));
      if (!tab || typeof tab.id !== 'number' || tab.id !== beforeForeground.id) {
        return { ok: false, error: 'capture_no_target_tab: the foreground tab is missing or blocked' };
      }
      const windowId = typeof beforeForeground.windowId === 'number'
        ? beforeForeground.windowId
        : requestedWindowId ?? undefined;
      const dataUrl = await captureVisible(windowId, ctx);
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return { ok: false, error: 'capture_returned_unexpected_shape' };
      }
      if (activationWatch.changedIn(windowId)) {
        return { ok: false, error: 'capture_target_changed: screenshot discarded because the foreground tab changed' };
      }
      // A user action or navigation can change the foreground while the browser
      // is producing the screenshot. Re-resolve the actual foreground and drop
      // the bytes unless it is still the same allowed page.
      const afterForeground = await foregroundTab(ctx.tabs, windowId ?? null);
      if (!afterForeground || typeof afterForeground.id !== 'number') {
        return { ok: false, error: 'capture_target_changed: screenshot discarded because the foreground tab changed' };
      }
      if (!guardLeases.has(afterForeground.id)) {
        const afterGuard = await acquire(afterForeground.id);
        if (!afterGuard?.ok) return afterGuard;
        guardLeases.set(afterForeground.id, afterGuard.lease);
      }
      const afterTab = await resolveTargetTab({ tabId: afterForeground.id }, /** @type {any} */ (policyCtx));
      if (!afterTab
        || afterTab.id !== tab.id
        || afterTab.url !== tab.url
        || afterTab.peerdDocumentId !== tab.peerdDocumentId
        || afterForeground.id !== beforeForeground.id
        || activationWatch.changedIn(windowId)) {
        return { ok: false, error: 'capture_target_changed: screenshot discarded because the foreground tab changed' };
      }
      return {
        ok: true,
        content: JSON.stringify({
          format: 'png',
          dataUrl,
          bytes: estimateBase64Bytes(dataUrl),
          origin: originOfUrl(tab.url) || null,
        }, null, 2),
      };
    } catch (e) {
      if (e instanceof BrowserAutomationPolicyError) {
        return browserTargetRefusalResult(e.structured, { effectCompleted: false });
      }
      return { ok: false, error: `capture_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
    } finally {
      activationWatch?.stop();
      const release = /** @type {{ releaseBrowserNetworkGuardLease?: (lease: { tabId?: number, token?: string }) => Promise<unknown> }} */ (ctx)
        .releaseBrowserNetworkGuardLease;
      if (typeof release === 'function') {
        for (const lease of guardLeases.values()) await release(lease).catch(() => {});
      }
    }
  },
};

/**
 * Record every foreground activation while captureVisibleTab is in flight.
 * Before/after queries alone cannot detect A -> B -> A because A's document
 * identity does not change while another tab is briefly foregrounded.
 *
 * @param {any} tabs
 * @returns {{ changedIn: (windowId: number | undefined) => boolean, stop: () => void } | null}
 */
const watchTabActivations = (tabs) => {
  const event = tabs?.onActivated;
  if (typeof event?.addListener !== 'function' || typeof event?.removeListener !== 'function') {
    return null;
  }
  let anyActivation = false;
  const activatedWindows = new Set();
  /** @param {{ windowId?: number }} info */
  const listener = (info) => {
    anyActivation = true;
    if (typeof info?.windowId === 'number') activatedWindows.add(info.windowId);
  };
  event.addListener(listener);
  let listening = true;
  return {
    changedIn: (windowId) => typeof windowId === 'number'
      ? activatedWindows.has(windowId)
      : anyActivation,
    stop: () => {
      if (!listening) return;
      listening = false;
      event.removeListener(listener);
    },
  };
};

/**
 * Return the tab captureVisibleTab will photograph.
 * @param {any} tabs
 * @param {number | null} windowId
 */
const foregroundTab = async (tabs, windowId) => {
  if (typeof tabs?.query !== 'function') return null;
  const [tab] = await tabs.query(windowId === null
    ? { active: true, currentWindow: true }
    : { active: true, windowId });
  return tab ?? null;
};

/**
 * Rough decode size from a "data:image/...;base64,XXXX" URL. Useful
 * for the side panel to decide whether to inline the image or show a
 * link.
 *
 * @param {string} dataUrl
 * @returns {number}
 */
const estimateBase64Bytes = (dataUrl) => {
  const idx = dataUrl.indexOf(',');
  if (idx < 0) return 0;
  const b64 = dataUrl.slice(idx + 1);
  // why: every 4 base64 chars = 3 bytes, modulo padding. Close enough
  // for a size hint.
  return Math.floor((b64.length * 3) / 4);
};
