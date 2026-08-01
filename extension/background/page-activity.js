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

import { activityOverlayInjected, clearActivityOverlayInjected } from '/peerd-runtime/index.js';

/**
 * The tab group the driven tab joins. Deliberately the SAME title the engine
 * tabs use (app-client.js APP_TAB_GROUP_TITLE), so peerd owns one group in the
 * strip rather than sprouting one per subsystem.
 */
export const ACTIVITY_GROUP_TITLE = 'peerd';

/** @typedef {{ tabs: any, tabGroups?: any, scripting: any }} ActivityDeps */

/**
 * Put a tab into peerd's tab group.
 *
 * why remember nothing about the previous group: a tab the user had already
 * grouped is a case we cannot restore faithfully (tabGroups has no "put it back
 * where it was" and re-grouping would move it again), so release UNGROUPS and
 * leaves it loose. Stated here because it IS a behaviour change to the user's
 * strip and the honest answer is that it is imperfect, not that it is invisible.
 *
 * @param {number} tabId
 * @param {ActivityDeps} deps
 * @returns {Promise<boolean>} whether the tab ended up grouped
 */
export const groupDrivenTab = async (tabId, deps) => {
  const { tabs, tabGroups } = deps;
  if (!tabGroups || typeof tabs?.group !== 'function') return false;   // Firefox
  try {
    const tab = await tabs.get(tabId);
    const existing = await tabGroups.query({ title: ACTIVITY_GROUP_TITLE, windowId: tab.windowId });
    const groupId = existing?.[0]?.id;
    if (groupId == null) {
      const created = await tabs.group({ tabIds: [tabId] });
      await tabGroups.update(created, { title: ACTIVITY_GROUP_TITLE, color: 'orange', collapsed: false });
    } else {
      await tabs.group({ tabIds: [tabId], groupId });
    }
    return true;
  } catch {
    return false;
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
 * @returns {Promise<boolean>}
 */
export const showPageActivity = async (tabId, label, origin, deps) => {
  try {
    await deps.scripting.executeScript({
      target: { tabId },
      func: activityOverlayInjected,
      args: [String(label ?? ''), String(origin ?? '')],
    });
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
    await deps.scripting.executeScript({
      target: { tabId },
      func: clearActivityOverlayInjected,
    });
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
 * `onToolActivity`. It is stateful in one small way — it remembers which tabs it
 * has grouped — so release can ungroup exactly those and leave every other tab
 * alone.
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
 *   begin: (tabId: number, label: string, origin: string) => Promise<void>,
 *   end: (tabId: number) => Promise<void>,
 *   idle: (tabId: number) => Promise<void>,
 *   release: (tabId: number) => Promise<void>,
 *   markedTabs: () => number[],
 * }}
 */
export const createPageActivityReporter = (deps) => {
  /** Tabs this reporter grouped, so release only undoes its own work. */
  const marked = new Set();

  return {
    /** A tab tool is starting: mark the tab and name the action. */
    begin: async (tabId, label, origin) => {
      if (typeof tabId !== 'number') return;
      if (!marked.has(tabId)) {
        marked.add(tabId);
        await groupDrivenTab(tabId, deps);
      }
      await showPageActivity(tabId, label, origin, deps);
    },

    // why the pill SURVIVES the end of a call: the gap between two tool calls is
    // the model thinking, which is most of the wall-clock the user is waiting
    // through — and it is exactly when a disappearing indicator would read as
    // "it finished" and invite them to grab the keyboard. The phrase softens to
    // "Thinking…" instead; idle() is what takes the pill down, at turn end.
    end: async (tabId) => {
      if (typeof tabId !== 'number' || !marked.has(tabId)) return;
      await showPageActivity(tabId, 'Thinking…', '', deps);
    },

    /**
     * The TURN is over. Take the pill down — peerd is not doing anything right
     * now — but keep the group: it still owns the tab and will be back.
     */
    idle: async (tabId) => {
      if (typeof tabId !== 'number' || !marked.has(tabId)) return;
      await clearPageActivity(tabId, deps);
    },

    /**
     * Peerd no longer OWNS the tab — the binding dropped, the tab closed, or the
     * origin lock handed it back. Undo everything, including the grouping.
     */
    release: async (tabId) => {
      if (typeof tabId !== 'number' || !marked.delete(tabId)) return;
      await clearPageActivity(tabId, deps);
      await ungroupDrivenTab(tabId, deps);
    },

    markedTabs: () => [...marked],
  };
};
