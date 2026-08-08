// @ts-check
// page-activity — make it obvious WHICH tab peerd is driving and WHAT it is
// doing in there, from inside the browser rather than only from the side panel.
//
// Two surfaces, one lifecycle:
//   TAB STRIP   the driven tab joins the collapsible "peerd" tab group, the same
//               group the engine tabs already use (background/tab-tracker.js), so
//               a glance at the strip says which tab is not the user's to touch.
//   IN PAGE     a small corner pill (dom/activity-overlay-injected.js) naming the
//               current action, with a Stop button.
//
// why both and not one: they answer different questions. The group answers
// "which tab", visible even when the tab is in the background. The pill answers
// "is it working, or has it hung" — the complaint that prompted this — and it is
// only visible where the user is actually looking when peerd is mid-task.
//
// IO IS INJECTED (tabs / tabGroups / scripting), so the whole lifecycle is
// testable without a browser and the in-browser tests can drive it with stubs —
// the same posture tab-tracker.js takes.
//
// EVERYTHING HERE IS BEST-EFFORT. A failure to decorate a tab must never fail
// the tool call that triggered it: the user asked peerd to do something on a
// page, and losing that to a cosmetic error would be a strictly worse bug than
// the one this fixes. Every entry point swallows. On Firefox, `tabGroups` is
// absent and the group half no-ops while the pill still works.

import {
  activityOverlayInjected,
  classifyBrowserAutomationTarget,
  clearActivityOverlayInjected,
  isDenylistedTab,
  liveDocumentLocationInjected,
} from '/peerd-runtime/index.js';

/**
 * The tab group the driven tab joins. Deliberately the SAME title the engine
 * tabs use (app-client.js APP_TAB_GROUP_TITLE), so peerd owns one group in the
 * strip rather than sprouting one per subsystem.
 */
export const ACTIVITY_GROUP_TITLE = 'peerd';

/** @typedef {{ tabs: any, tabGroups?: any, scripting: any }} ActivityDeps */
/** @typedef {{ denylist?: readonly string[] }} ActivityPolicy */

/**
 * Put a tab into peerd's tab group.
 *
 * A tab already in a user group is left there. Moving its only tab would delete
 * that group immediately, making restoration impossible. For an ungrouped tab,
 * the prior strip index is captured before it joins peerd's group.
 *
 * @param {number} tabId
 * @param {ActivityDeps} deps
 * @returns {Promise<{ groupId: number, index: number } | null>} prior placement
 */
export const groupDrivenTab = async (tabId, deps) => {
  const { tabs, tabGroups } = deps;
  if (!tabGroups || typeof tabs?.group !== 'function') return null;   // Firefox
  try {
    const tab = await tabs.get(tabId);
    if (typeof tab.groupId === 'number' && tab.groupId >= 0) return null;
    const placement = {
      groupId: -1,
      index: typeof tab.index === 'number' ? tab.index : -1,
    };
    const existing = await tabGroups.query({ title: ACTIVITY_GROUP_TITLE, windowId: tab.windowId });
    const groupId = existing?.[0]?.id;
    if (groupId == null) {
      const created = await tabs.group({ tabIds: [tabId] });
      await tabGroups.update(created, { title: ACTIVITY_GROUP_TITLE, color: 'grey', collapsed: false });
    } else {
      await tabs.group({ tabIds: [tabId], groupId });
    }
    return placement;
  } catch {
    return null;
  }
};

/**
 * Take a tab back out of peerd's group.
 * @param {number} tabId
 * @param {ActivityDeps} deps
 * @returns {Promise<boolean>}
 */
export const ungroupDrivenTab = async (tabId, deps) => {
  const { tabs } = deps;
  if (typeof tabs?.ungroup !== 'function') return false;
  try {
    await tabs.ungroup([tabId]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Restore the user's original group and strip position after peerd releases a
 * tab. Browser chrome is user state, so decoration must be reversible.
 * @param {number} tabId
 * @param {{ groupId: number, index: number } | null} placement
 * @param {ActivityDeps} deps
 */
export const restoreDrivenTab = async (tabId, placement, deps) => {
  if (!placement) return false;
  try {
    if (placement.groupId >= 0 && typeof deps.tabs?.group === 'function') {
      await deps.tabs.group({ tabIds: [tabId], groupId: placement.groupId });
    } else {
      await ungroupDrivenTab(tabId, deps);
    }
    if (placement.index >= 0 && typeof deps.tabs?.move === 'function') {
      await deps.tabs.move(tabId, { index: placement.index });
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * Bind activity decoration to the exact allowed document whose location was
 * checked. A slow, replaced, or uninjectable document receives no overlay.
 *
 * @param {number} tabId
 * @param {ActivityDeps} deps
 * @param {ActivityPolicy} [policy]
 * @param {string | null} [expectedOrigin]
 * @returns {Promise<{ tabId: number, documentIds: string[] } | null>}
 */
export const allowedDocumentTarget = async (tabId, deps, policy = {}, expectedOrigin = null) => {
  try {
    const [injection] = await deps.scripting.executeScript({
      target: { tabId },
      func: liveDocumentLocationInjected,
    });
    const href = injection?.result?.href ?? injection?.result?.origin;
    const verdict = classifyBrowserAutomationTarget(href);
    if (!verdict.allowed || typeof injection?.documentId !== 'string') return null;
    if (expectedOrigin && verdict.origin !== expectedOrigin) return null;
    if (isDenylistedTab(href, policy.denylist)) return null;
    return { tabId, documentIds: [injection.documentId] };
  } catch {
    return null;
  }
};

/** @param {{ tabId: number, documentIds: string[] }} target @param {string} label @param {string} origin @param {ActivityDeps} deps */
const showOnTarget = async (target, label, origin, deps) => {
  await deps.scripting.executeScript({
    target,
    func: activityOverlayInjected,
    args: [String(label ?? ''), String(origin ?? '')],
  });
};

/** @param {{ tabId: number, documentIds: string[] }} target @param {ActivityDeps} deps */
const clearOnTarget = async (target, deps) => {
  await deps.scripting.executeScript({ target, func: clearActivityOverlayInjected });
};

/**
 * Show (or update) the in-page pill.
 *
 * why re-inject on every call rather than holding a port: the pill dies with the
 * document, and the actor navigates constantly. A per-call injection is
 * self-healing — the first action after a navigation rebuilds it — where a port
 * would need reconnect bookkeeping to reach the same place.
 *
 * @param {number} tabId
 * @param {string} label   the phrase from describeToolActivity
 * @param {string} origin  the origin being driven, shown under the phrase
 * @param {ActivityDeps} deps
 * @param {ActivityPolicy} [policy]
 * @returns {Promise<boolean>}
 */
export const showPageActivity = async (tabId, label, origin, deps, policy = {}) => {
  try {
    const target = await allowedDocumentTarget(tabId, deps, policy);
    if (!target) return false;
    await showOnTarget(target, label, origin, deps);
    return true;
  } catch {
    // A restricted page (chrome://, the Web Store, a PDF viewer) refuses
    // injection. Nothing to do — the tab-group marking still stands.
    return false;
  }
};

/**
 * Remove the in-page pill.
 * @param {number} tabId
 * @param {ActivityDeps} deps
 * @returns {Promise<boolean>}
 */
export const clearPageActivity = async (tabId, deps) => {
  try {
    const target = await allowedDocumentTarget(tabId, deps);
    if (!target) return false;
    await clearOnTarget(target, deps);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the activity reporter the tool dispatcher calls around every
 * `primitive:'tab'` call.
 *
 * The returned object is what gets threaded onto the tool context as
 * `onToolActivity`. It remembers each exact document and the tab's prior strip
 * placement so release can remove the pill and restore user chrome.
 *
 * THE TWO LIFETIMES, which are deliberately different because they answer
 * different questions:
 *
 *   THE GROUP lasts as long as peerd OWNS the tab — across turns, through the
 *   thinking gaps, until the binding drops. "This tab is not yours right now."
 *   THE PILL lasts only while a turn is actually running. "It is working, here,
 *   on this, and here is Stop."
 *
 * Collapsing them was the first design and it was wrong in both directions: a
 * pill that outlived the turn says peerd is busy when it is idle, and a group
 * that ended with the turn would shuffle the tab in and out of the strip on
 * every exchange.
 *
 * @param {ActivityDeps} deps
 * @returns {{
 *   begin: (tabId: number, label: string, origin: string, policy?: ActivityPolicy) => Promise<void>,
 *   end: (tabId: number) => Promise<void>,
 *   idle: (tabId: number) => Promise<void>,
 *   release: (tabId: number) => Promise<void>,
 *   markedTabs: () => number[],
 * }}
 */
export const createPageActivityReporter = (deps) => {
  /** @type {Map<number, { target: { tabId: number, documentIds: string[] }, placement: { groupId: number, index: number } | null }>} */
  const marked = new Map();
  /** @type {Map<number, Promise<void>>} */
  const pending = new Map();

  // why serialize per tab: dispatcher deliberately does not await this cosmetic
  // work. Without a queue, a slow begin can finish after end/idle and leave a
  // stale Working pill behind, or an old end can overwrite the next tool's pill.
  // A hung page still cannot delay the tool itself because callers fire and
  // forget the returned promise.
  const schedule = (/** @type {number} */ tabId, /** @type {() => Promise<void>} */ operation) => {
    const previous = pending.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation).catch(() => {});
    pending.set(tabId, current);
    current.finally(() => {
      if (pending.get(tabId) === current) pending.delete(tabId);
    });
    return current;
  };

  return {
    /** A tab tool is starting: mark the tab and name the action. */
    begin: (tabId, label, origin, policy = {}) => schedule(tabId, async () => {
      const target = await allowedDocumentTarget(tabId, deps, policy, origin || null);
      if (!target) return;
      try { await showOnTarget(target, label, origin, deps); }
      catch { return; }
      const existing = marked.get(tabId);
      const placement = existing?.placement ?? await groupDrivenTab(tabId, deps);
      marked.set(tabId, { target, placement });
    }),

    // why the pill SURVIVES the end of a call: the gap between two tool calls is
    // the model thinking, which is most of the wall-clock the user is waiting
    // through — and it is exactly when a disappearing indicator would read as
    // "it finished" and invite them to grab the keyboard. The phrase softens to
    // "Thinking…" instead; idle() is what takes the pill down, at turn end.
    end: (tabId) => schedule(tabId, async () => {
      const record = marked.get(tabId);
      if (!record) return;
      try { await showOnTarget(record.target, 'Thinking…', '', deps); } catch { /* document changed */ }
    }),

    /**
     * The TURN is over. Take the pill down — peerd is not doing anything right
     * now — but keep the group: it still owns the tab and will be back.
     */
    idle: (tabId) => schedule(tabId, async () => {
      const record = marked.get(tabId);
      if (!record) return;
      try { await clearOnTarget(record.target, deps); } catch { /* document changed */ }
    }),

    /**
     * Peerd no longer OWNS the tab — the binding dropped, the tab closed, or the
     * origin lock handed it back. Undo everything, including the grouping.
     */
    release: (tabId) => schedule(tabId, async () => {
      const record = marked.get(tabId);
      marked.delete(tabId);
      if (record) {
        try { await clearOnTarget(record.target, deps); } catch { /* document changed */ }
      }
      await restoreDrivenTab(tabId, record?.placement ?? null, deps);
    }),

    markedTabs: () => [...marked.keys()],
  };
};
