// @ts-check
// Extend surviving tab-scoped DNR blocks to an exact page-created child while
// the service worker is still restoring its in-memory ownership registries.

/** @param {{getSessionRules:()=>Promise<any[]>,updateSessionRules:(update:any)=>Promise<unknown>}} dnr */
export const makeSerializedDnrSessionRules = (dnr) => {
  let queue = Promise.resolve();
  return Object.freeze({
    getSessionRules: () => dnr.getSessionRules(),
    updateSessionRules(/** @type {any} */ update) {
      const pending = queue.then(() => dnr.updateSessionRules(update));
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  });
};

/**
 * @param {{
 *   getSessionRules?: () => Promise<any[]>,
 *   updateSessionRules?: (update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>,
 * }} dnr
 * @param {readonly number[]} ownedRuleIds
 * @param {{timeoutMs?:number,retryMs?:number,loadPending?:()=>Promise<unknown>,savePending?:(rows:{tabId:number,sourceTabId:number}[])=>Promise<unknown>,loadTabs?:()=>Promise<any[]>,ruleDigests?:readonly string[]}} [options]
 */
export const makeStartupPopupNetworkGuard = (dnr, ownedRuleIds, options = {}) => {
  const supported = typeof dnr?.getSessionRules === 'function'
    && typeof dnr?.updateSessionRules === 'function';
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Number(options.timeoutMs)) : 1_000;
  const retryMs = Number.isFinite(options.retryMs)
    ? Math.max(1, Number(options.retryMs)) : 250;
  const bounded = (/** @type {Promise<any>} */ operation, /** @type {string} */ code) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (cause) => { clearTimeout(timer); reject(cause); },
      );
    });
  /** @type {Set<number>} */
  const guardedChildren = new Set();
  /** @type {Map<number,symbol>} */
  const candidates = new Map();
  /** @type {Map<number,symbol>} */
  const removed = new Map();
  /** @type {Map<number,symbol>} */
  const generations = new Map();
  /** @type {Set<number>} */
  const preRestoreRemoved = new Set();
  /** @type {Map<number,number>} */
  const sources = new Map();
  /** @type {Map<number,Set<Promise<unknown>>>} */
  const mutations = new Map();
  /** @type {Map<number,ReturnType<typeof setTimeout>>} */
  const cleanupTimers = new Map();
  /** @type {ReturnType<typeof setTimeout>|null} */ let restorationTimer = null;
  let accepting = true;
  let queue = Promise.resolve();
  let persistence = Promise.resolve();
  /** @type {any[]} */
  let rules = [];
  /** @type {Set<number>} */
  let exactRules = new Set();
  /** @type {Promise<void>|null} */ let rulesReady = null;
  /** @returns {any} */
  const stable = (/** @type {any} */ value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  const digest = async (/** @type {any} */ rule) => {
    const { tabIds, resourceTypes, ...condition } = rule.condition;
    const data = new TextEncoder().encode(JSON.stringify(stable({
      id: rule.id, priority: rule.priority, action: rule.action, condition,
    })));
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  };
  const setRules = async (/** @type {unknown} */ current) => {
    rules = Array.isArray(current) ? current : [];
    exactRules = new Set();
    if (!Array.isArray(options.ruleDigests)) return;
    await Promise.all(rules.map(async (rule) => {
      const index = ownedRuleIds.indexOf(rule?.id);
      if (index >= 0 && await digest(rule) === options.ruleDigests?.[index]) {
        exactRules.add(rule.id);
      }
    }));
  };
  const ensureRules = () => {
    if (!supported) return Promise.resolve();
    if (rulesReady) return rulesReady;
    const attempt = bounded(Promise.resolve().then(() =>
      /** @type {() => Promise<any[]>} */ (dnr.getSessionRules)()),
    'startup-popup-rules-read-timeout').then(setRules);
    rulesReady = attempt;
    void attempt.catch(() => {
      if (rulesReady === attempt) rulesReady = null;
    });
    return attempt;
  };
  void ensureRules().catch(() => {});
  const refreshRules = async () => {
    const current = await bounded(Promise.resolve().then(() =>
      /** @type {() => Promise<any[]>} */ (dnr.getSessionRules)()),
    'startup-popup-rules-refresh-timeout');
    await setRules(current);
    rulesReady = Promise.resolve();
  };

  const requiredTypes = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'];
  const browserTypeSets = [
    new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
      'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
      'webbundle', 'webtransport', 'other']),
    new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
      'object', 'xmlhttprequest', 'xslt', 'ping', 'beacon', 'xml_dtd', 'csp_report',
      'media', 'websocket', 'imageset', 'web_manifest', 'speculative', 'json', 'other']),
  ];
  const exactRule = (/** @type {any} */ rule) => {
    if (!Array.isArray(options.ruleDigests)) return true;
    const index = ownedRuleIds.indexOf(rule?.id);
    const types = rule?.condition?.resourceTypes;
    const topKeys = Object.keys(rule ?? {}).sort().join(',');
    const actionKeys = Object.keys(rule?.action ?? {}).sort().join(',');
    const conditionKeys = Object.keys(rule?.condition ?? {}).sort().join(',');
    const expectedConditionKeys = Array.isArray(rule?.condition?.requestDomains)
      ? 'requestDomains,resourceTypes,tabIds'
      : 'isUrlFilterCaseSensitive,regexFilter,resourceTypes,tabIds';
    return index >= 0 && exactRules.has(rule.id)
      && topKeys === 'action,condition,id,priority' && actionKeys === 'type'
      && conditionKeys === expectedConditionKeys
      && Array.isArray(types) && browserTypeSets.some((expected) =>
        types.length === expected.size && types.every((type) => expected.has(type)));
  };
  const completePrivateRule = (/** @type {any} */ rule, /** @type {number} */ tabId) =>
    rule?.priority === 4
      && rule?.action?.type === 'block'
      && Array.isArray(rule?.condition?.tabIds)
      && rule.condition.tabIds.includes(tabId)
      && Array.isArray(rule.condition.resourceTypes)
      && requiredTypes.every((type) => rule.condition.resourceTypes.includes(type))
      && (Array.isArray(rule.condition.requestDomains)
        ? rule.condition.requestDomains.length > 0
        : typeof rule.condition.regexFilter === 'string'
          && rule.condition.regexFilter.length > 0
          && rule.condition.isUrlFilterCaseSensitive === false)
      && exactRule(rule);

  const ownedBlockRulesFor = (/** @type {number} */ tabId) => ownedRuleIds.map((ruleId) =>
    rules.find((rule) => rule?.id === ruleId && completePrivateRule(rule, tabId))).filter(Boolean);
  const blockRulesFor = (/** @type {number} */ tabId) => rules.filter((rule) =>
    rule?.action?.type === 'block'
      && Array.isArray(rule?.condition?.tabIds)
      && rule.condition.tabIds.includes(tabId));

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

  const persistCandidates = () => {
    if (typeof options.savePending !== 'function') return Promise.resolve();
    const snapshot = [...candidates.keys()].flatMap((tabId) => {
      const sourceTabId = sources.get(tabId);
      return typeof sourceTabId === 'number' ? [{ tabId, sourceTabId }] : [];
    });
    const pending = persistence.then(
      () => options.savePending?.(snapshot),
      () => options.savePending?.(snapshot),
    );
    persistence = pending.then(() => {}, () => {});
    return pending;
  };
  let restored = typeof options.loadPending !== 'function';
  /** @type {Promise<void>|null} */ let restoring = null;
  const ensureRestoration = () => {
    if (restored) return Promise.resolve();
    if (restoring) return restoring;
    const attempt = Promise.all([
      Promise.resolve().then(() => options.loadPending?.()),
      typeof options.loadTabs === 'function'
        ? Promise.resolve().then(() => options.loadTabs?.()) : Promise.resolve([]),
    ]).then(async ([value, tabs]) => {
      const rows = value == null ? [] : value;
      if (!Array.isArray(rows)) throw new TypeError('startup-popup-pending-invalid');
      if (!Array.isArray(tabs)) throw new TypeError('startup-popup-tabs-invalid');
      const current = new Map(tabs.filter((tab) => Number.isInteger(tab?.id))
        .map((tab) => [tab.id, tab]));
      await ensureRules();
      for (const row of rows) {
        const tabId = row?.tabId;
        const sourceTabId = row?.sourceTabId;
        if (!Number.isInteger(tabId) || tabId < 0
            || !Number.isInteger(sourceTabId) || sourceTabId < 0) continue;
        const token = Symbol(`restored:${tabId}`);
        candidates.set(tabId, token);
        generations.set(tabId, token);
        sources.set(tabId, sourceTabId);
        if (preRestoreRemoved.has(tabId)) {
          removed.set(tabId, token);
          continue;
        }
        const child = current.get(tabId);
        if (child?.openerTabId === sourceTabId && current.has(sourceTabId)) {
          if (ownedBlockRulesFor(tabId).length === ownedRuleIds.length) {
            guardedChildren.add(tabId);
          }
        } else removed.set(tabId, token);
      }
      restored = true;
    });
    restoring = attempt;
    void attempt.finally(() => {
      if (restoring === attempt) restoring = null;
    }).catch(() => {});
    return attempt;
  };

  const trackMutation = (/** @type {number} */ tabId,
    /** @type {Promise<unknown>} */ mutation) => {
    const current = mutations.get(tabId) ?? new Set();
    current.add(mutation);
    mutations.set(tabId, current);
    void mutation.finally(() => {
      current.delete(mutation);
      if (current.size === 0) mutations.delete(tabId);
    }).catch(() => {});
  };
  const drainMutations = async (/** @type {number} */ tabId) => {
    const current = [...(mutations.get(tabId) ?? [])];
    if (current.length === 0) return;
    await bounded(Promise.allSettled(current), 'startup-popup-mutation-drain-timeout');
  };
  const clearCleanupTimer = (/** @type {number} */ tabId) => {
    const timer = cleanupTimers.get(tabId);
    if (timer) clearTimeout(timer);
    cleanupTimers.delete(tabId);
  };

  const cleanup = async (/** @type {number} */ tabId, /** @type {symbol} */ token) => {
    if (removed.get(tabId) !== token) return true;
    await ensureRules();
    await drainMutations(tabId);
    await refreshRules();
    const childRules = blockRulesFor(tabId);
    if (childRules.length === 0) {
      if (candidates.get(tabId) === token) candidates.delete(tabId);
      if (generations.get(tabId) === token) sources.delete(tabId);
      if (removed.get(tabId) === token) removed.delete(tabId);
      if (generations.get(tabId) === token) generations.delete(tabId);
      clearCleanupTimer(tabId);
      preRestoreRemoved.delete(tabId);
      await persistCandidates().catch(() => {});
      return true;
    }
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
    const mutation = Promise.resolve().then(() =>
      /** @type {(update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>} */
        (dnr.updateSessionRules)({ removeRuleIds, addRules }));
    trackMutation(tabId, mutation);
    await bounded(mutation, 'startup-popup-rule-release-timeout');
    applyLocal(removeRuleIds, addRules);
    await refreshRules();
    if (blockRulesFor(tabId).length > 0) {
      throw new Error('startup-popup-rule-release-unverified');
    }
    if (candidates.get(tabId) === token) candidates.delete(tabId);
    if (generations.get(tabId) === token) sources.delete(tabId);
    if (removed.get(tabId) === token) removed.delete(tabId);
    if (generations.get(tabId) === token) generations.delete(tabId);
    clearCleanupTimer(tabId);
    preRestoreRemoved.delete(tabId);
    await persistCandidates().catch(() => {});
    return true;
  };

  const scheduleCleanup = (/** @type {number} */ tabId, /** @type {symbol} */ token) => {
    if (cleanupTimers.has(tabId) || removed.get(tabId) !== token || !supported) return;
    const timer = setTimeout(() => {
      cleanupTimers.delete(tabId);
      void update(() => cleanup(tabId, token)).catch(() => scheduleCleanup(tabId, token));
    }, retryMs);
    cleanupTimers.set(tabId, timer);
  };

  const release = async (/** @type {number} */ tabId,
    /** @type {symbol|undefined} */ expected = undefined) => {
    if (!restored) {
      preRestoreRemoved.add(tabId);
      await ensureRestoration();
    }
    const token = expected ?? generations.get(tabId);
    if (!token || generations.get(tabId) !== token || candidates.get(tabId) !== token) {
      preRestoreRemoved.delete(tabId);
      return;
    }
    removed.set(tabId, token);
    guardedChildren.delete(tabId);
    const durable = persistCandidates();
    if (!supported) return durable.then(() => {});
    return durable.catch(() => {}).then(() => update(() => cleanup(tabId, token)))
      .catch(() => { scheduleCleanup(tabId, token); });
  };

  const restoreAndClean = () => ensureRestoration().then(() => {
    for (const [tabId, token] of removed) scheduleCleanup(tabId, token);
  }).catch(() => {
    if (restorationTimer) return;
    restorationTimer = setTimeout(() => {
      restorationTimer = null;
      void restoreAndClean();
    }, retryMs);
  });
  void restoreAndClean();

  return {
    /** @param {number} sourceTabId @param {number} childTabId */
    adopt(sourceTabId, childTabId,
      /** @type {symbol|undefined} */ generation = undefined) {
      if (!supported || !accepting || removed.has(sourceTabId)) {
        return Promise.resolve(false);
      }
      const token = generation ?? candidates.get(childTabId) ?? Symbol(`child:${childTabId}`);
      return update(async () => {
        await ensureRestoration();
        const prior = removed.get(childTabId);
        if (prior && prior !== token) await cleanup(childTabId, prior);
        if (removed.has(childTabId) || removed.has(sourceTabId)) return false;
        await ensureRules();
        const proofRules = ownedBlockRulesFor(sourceTabId);
        if (proofRules.length === 0) return false;
        if (proofRules.length !== ownedRuleIds.length) {
          throw new Error('startup-popup-source-evidence-incomplete');
        }
        generations.set(childTabId, token);
        candidates.set(childTabId, token);
        sources.set(childTabId, sourceTabId);
        try {
          await persistCandidates();
        } catch (cause) {
          if (candidates.get(childTabId) === token) candidates.delete(childTabId);
          if (generations.get(childTabId) === token) {
            generations.delete(childTabId);
            sources.delete(childTabId);
          }
          throw cause;
        }
        const sourceRules = blockRulesFor(sourceTabId);
        const addRules = sourceRules.map((rule) => ({
          ...rule,
          condition: {
            ...rule.condition,
            tabIds: [...new Set([...rule.condition.tabIds, childTabId])],
          },
        }));
        const removeRuleIds = addRules.map((rule) => rule.id);
        const mutation = Promise.resolve().then(() =>
          /** @type {(update: { removeRuleIds: number[], addRules: any[] }) => Promise<unknown>} */
            (dnr.updateSessionRules)({ removeRuleIds, addRules }));
        trackMutation(childTabId, mutation);
        mutation.finally(() => {
          if (removed.get(childTabId) === token) {
            void update(() => cleanup(childTabId, token))
              .catch(() => scheduleCleanup(childTabId, token));
          }
        }).catch(() => {});
        await bounded(mutation, 'startup-popup-rule-update-timeout');
        applyLocal(removeRuleIds, addRules);
        if (removed.get(childTabId) === token) return false;
        await refreshRules();
        if (ownedBlockRulesFor(childTabId).length !== ownedRuleIds.length) {
          throw new Error('startup-popup-rule-update-unverified');
        }
        guardedChildren.add(childTabId);
        return true;
      });
    },

    /**
     * Prevent a closed numeric tab id from surviving in the startup copy.
     * Before handoff, remove it directly from every copied rule. After handoff,
     * the authoritative guard's normal tab-close reconcile owns cleanup.
     * @param {number} tabId
     */
    release,

    /** The authoritative custody set now carries this child. @param {number} tabId */
    async handoff(tabId, /** @type {symbol|undefined} */ expected = undefined) {
      const token = expected ?? generations.get(tabId);
      if (!token || generations.get(tabId) !== token) return;
      if (candidates.get(tabId) === token) candidates.delete(tabId);
      sources.delete(tabId);
      if (removed.get(tabId) === token) removed.delete(tabId);
      generations.delete(tabId);
      guardedChildren.delete(tabId);
      await persistCandidates();
    },

    /** Stop admitting startup copies and drain any already admitted update. */
    async seal() {
      accepting = false;
      await ensureRestoration();
      await queue;
      while (mutations.size > 0) {
        await Promise.allSettled([...mutations.values()].flatMap((current) => [...current]));
      }
      await Promise.resolve();
      await queue;
      await persistence;
    },

    tabIds: () => [...candidates.keys()].filter((tabId) => !removed.has(tabId)),

    async reconcileSources(/** @type {(sourceTabId:number)=>boolean|null} */ classify) {
      await ensureRestoration();
      await Promise.all([...candidates].map(async ([tabId, token]) => {
        if (removed.has(tabId)) return;
        const sourceTabId = sources.get(tabId);
        if (typeof sourceTabId !== 'number') return;
        let driven = null;
        try { driven = classify(sourceTabId); } catch {}
        if (driven === false) await release(tabId, token);
      }));
    },

    isGuarded(/** @type {number} */ tabId,
      /** @type {symbol|undefined} */ generation = undefined) {
      const token = generation ?? generations.get(tabId);
      return token != null && candidates.get(tabId) === token
        && guardedChildren.has(tabId) && !removed.has(tabId);
    },

    /** @param {number} sourceTabId */
    hasSourceEvidence(sourceTabId) {
      return restored && !removed.has(sourceTabId) && ownedRuleIds.length > 0
        && ownedBlockRulesFor(sourceTabId).length === ownedRuleIds.length;
    },

    /** @param {number} sourceTabId */
    async sourceEvidence(sourceTabId) {
      if (!supported || removed.has(sourceTabId)) return false;
      await ensureRestoration();
      await ensureRules();
      const sourceRules = ownedBlockRulesFor(sourceTabId);
      if (sourceRules.length === 0) return false;
      if (sourceRules.length !== ownedRuleIds.length) {
        throw new Error('startup-popup-source-evidence-incomplete');
      }
      return ownedRuleIds.length > 0;
    },
  };
};
