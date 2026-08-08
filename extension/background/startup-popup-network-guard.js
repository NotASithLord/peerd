// @ts-check
// Extend surviving tab-scoped DNR blocks to an exact page-created child while
// the service worker is still restoring its in-memory ownership registries.

/**
 * @param {{
 *   getSessionRules?: () => Promise<any[]>,
 *   updateSessionRules?: (update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>,
 * }} dnr
 * @param {readonly number[]} ownedRuleIds
 */
export const makeStartupPopupNetworkGuard = (dnr, ownedRuleIds) => {
  const supported = typeof dnr?.getSessionRules === 'function'
    && typeof dnr?.updateSessionRules === 'function';
  /** @type {Set<number>} */
  const guardedChildren = new Set();
  /** @type {Set<number>} */
  const candidates = new Set();
  /** @type {Set<number>} */
  const removed = new Set();
  let accepting = true;
  let queue = Promise.resolve();
  /** @type {any[]} */
  let rules = [];
  // Start the browser read at construction, before navigation listeners can
  // fire. The authoritative guard remains boot-deferred until seal().
  const rulesReady = supported
    ? Promise.resolve().then(() => /** @type {() => Promise<any[]>} */ (dnr.getSessionRules)())
      .then((current) => { rules = Array.isArray(current) ? current : []; })
      .catch(() => {})
    : Promise.resolve();

  const ownedBlockRulesFor = (/** @type {number} */ tabId) => ownedRuleIds.map((ruleId) =>
    rules.find((rule) => rule?.id === ruleId
      && rule?.action?.type === 'block'
      && Array.isArray(rule?.condition?.tabIds)
      && rule.condition.tabIds.includes(tabId))).filter(Boolean);

  const applyLocal = (/** @type {number[]} */ removeRuleIds, /** @type {any[]} */ addRules) => {
    rules = [
      ...rules.filter((rule) => !removeRuleIds.includes(rule.id)),
      ...addRules,
    ];
  };

  const update = (/** @type {() => Promise<boolean>} */ operation) => {
    const pending = queue.then(operation, operation);
    queue = pending.then(() => {}, () => {});
    return pending;
  };

  return {
    /**
     * Surviving block rules are positive browser-held evidence that peerd
     * already owned the exact source tab. Copy only those block rules to the
     * exact child. An absent or failed proof never authorizes touching it.
     * @param {number} sourceTabId
     * @param {number} childTabId
     */
    adopt(sourceTabId, childTabId) {
      if (!supported || !accepting || removed.has(childTabId)) return Promise.resolve(false);
      candidates.add(childTabId);
      return update(async () => {
        if (removed.has(childTabId)) return false;
        await rulesReady;
        const sourceRules = ownedBlockRulesFor(sourceTabId);
        if (sourceRules.length !== ownedRuleIds.length || sourceRules.length === 0) return false;
        const addRules = sourceRules.map((rule) => ({
          ...rule,
          condition: {
            ...rule.condition,
            tabIds: [...new Set([...rule.condition.tabIds, childTabId])],
          },
        }));
        const removeRuleIds = addRules.map((rule) => rule.id);
        await /** @type {(update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>} */
          (dnr.updateSessionRules)({ removeRuleIds, addRules });
        applyLocal(removeRuleIds, addRules);
        if (removed.has(childTabId)) return false;
        guardedChildren.add(childTabId);
        return true;
      }).catch(() => false);
    },

    /**
     * Prevent a closed numeric tab id from surviving in the startup copy.
     * Before handoff, remove it directly from every copied rule. After handoff,
     * the authoritative guard's normal tab-close reconcile owns cleanup.
     * @param {number} tabId
     */
    release(tabId) {
      if (!candidates.has(tabId)) return Promise.resolve();
      removed.add(tabId);
      guardedChildren.delete(tabId);
      if (!supported || !accepting) return Promise.resolve();
      return update(async () => {
        await rulesReady;
        const childRules = ownedBlockRulesFor(tabId);
        if (childRules.length === 0) return true;
        const addRules = childRules
          .map((rule) => ({
            ...rule,
            condition: {
              ...rule.condition,
              tabIds: rule.condition.tabIds.filter((/** @type {number} */ id) => id !== tabId),
            },
          }))
          .filter((rule) => rule.condition.tabIds.length > 0);
        const removeRuleIds = childRules.map((rule) => rule.id);
        await /** @type {(update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>} */
          (dnr.updateSessionRules)({ removeRuleIds, addRules });
        applyLocal(removeRuleIds, addRules);
        return true;
      }).then(() => {}, () => {});
    },

    /** The authoritative custody set now carries this child. @param {number} tabId */
    handoff(tabId) {
      candidates.delete(tabId);
      removed.delete(tabId);
      guardedChildren.delete(tabId);
    },

    /** Stop admitting startup copies and drain any already admitted update. */
    async seal() {
      accepting = false;
      await queue;
    },

    tabIds: () => [...guardedChildren],
  };
};
