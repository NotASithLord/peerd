// @ts-check
// Give page-created child tabs the same tab-scoped network floor as their
// peerd-owned source. Exact browser tab identity is the ownership signal.

/**
 * @param {number} sourceTabId
 * @param {readonly number[]} drivenTabIds
 * @param {boolean} bootAuthoritative
 * @returns {'driven'|'user'|'unknown'}
 */
export const popupSourceState = (sourceTabId, drivenTabIds, bootAuthoritative) => {
  if (drivenTabIds.includes(sourceTabId)) return 'driven';
  return bootAuthoritative ? 'user' : 'unknown';
};

/**
 * @typedef {{ allowed: boolean, reason?: string }} PopupTargetVerdict
 */

/** @typedef {'closed'|'left_blank'|'uncontained'} PopupChildState */
/** @typedef {{ sourceTabId: number, tabId: number, reason: string, child: PopupChildState, guarded: boolean }} PopupOutcomeEvent */

/**
 * @param {Object} deps
 * @param {(sourceTabId: number, childTabId: number) => Promise<{ ok: boolean, adopted?: boolean }>} deps.adoptFromSource
 * @param {(sourceTabId: number, childTabId: number) => Promise<boolean>} [deps.adoptUnknownFromSource]
 * @param {(sourceTabId: number) => 'driven'|'user'|'unknown'} deps.sourceState
 * @param {(tabId: number) => Promise<unknown>} deps.neutralize
 * @param {(tabId: number) => Promise<unknown>} [deps.close]
 * @param {(tabId: number, url: string) => Promise<unknown>} deps.resume
 * @param {(url: string) => PopupTargetVerdict} deps.classifyTarget
 * @param {(event: PopupOutcomeEvent & { outcome: 'not_run'|'unverified' }) => unknown} [deps.onBlocked]
 * @param {(event: PopupOutcomeEvent) => unknown} [deps.onFailed]
 * @param {(event: PopupOutcomeEvent) => unknown} [deps.onBlank]
 * @param {(event: { sourceTabId: number, tabId: number }) => unknown} [deps.onGuarded]
 * @param {number} [deps.blankDelayMs]
 */
export const makeDrivenPopupGuard = ({
  adoptFromSource,
  adoptUnknownFromSource,
  sourceState,
  neutralize,
  close,
  resume,
  classifyTarget,
  onBlocked = () => {},
  onFailed = () => {},
  onBlank = () => {},
  onGuarded = () => {},
  blankDelayMs = 75,
}) => {
  /**
   * @typedef {Object} PopupFlow
   * @property {number} tabId
   * @property {Set<number>} sourceTabIds
   * @property {string} destination
   * @property {boolean} started
   * @property {boolean} ready
   * @property {boolean} finishing
   * @property {boolean} resolvingUnknown
   * @property {Set<number>} unknownAttempted
   * @property {number | null} sourceTabId
   * @property {boolean} blocked
   * @property {string} blockReason
   * @property {boolean} neutralized
   * @property {boolean} guarded
   * @property {boolean} blankReported
   * @property {ReturnType<typeof setTimeout> | null} blankTimer
   * @property {Promise<void>} done
   * @property {(value?:void)=>void} resolve
   */
  /** @type {Map<number, PopupFlow>} */
  const flows = new Map();
  /** @type {Set<number>} */
  const settled = new Set();
  const meaningfulDestination = (/** @type {unknown} */ url) =>
    typeof url === 'string' && url.length > 0 && url !== 'about:blank' ? url : '';
  const forget = (/** @type {number} */ tabId) => {
    const flow = flows.get(tabId);
    if (flow?.blankTimer != null) clearTimeout(flow.blankTimer);
    flows.delete(tabId);
    flow?.resolve();
  };
  const settle = (/** @type {number} */ tabId) => {
    const flow = flows.get(tabId);
    // The synchronous request marker stays only through the guarded resume or
    // containment step. Releasing as soon as DNR installation returned left a
    // race where DNR blocked an immediate child request but no source receipt
    // could be attached to the creating action.
    if (flow?.guarded && flow.sourceTabId != null) {
      try {
        Promise.resolve(onGuarded({ sourceTabId: flow.sourceTabId, tabId })).catch(() => {});
      } catch { /* release notification is best-effort; tab removal also cleans up */ }
    }
    forget(tabId);
    settled.add(tabId);
  };

  const scheduleBlankReport = (/** @type {PopupFlow} */ flow) => {
    if (flow.destination || flow.blankReported || flow.blankTimer != null
        || flow.sourceTabId == null) return;
    flow.blankTimer = setTimeout(() => {
      flow.blankTimer = null;
      if (flows.get(flow.tabId) !== flow || flow.destination || !flow.ready
          || flow.blankReported || flow.sourceTabId == null) return;
      flow.blankReported = true;
      flow.finishing = true;
      (async () => {
        const child = await closeOrBlank(flow);
        await Promise.resolve(onBlank({
          sourceTabId: /** @type {number} */ (flow.sourceTabId),
          tabId: flow.tabId,
          reason: 'child_destination_unverified',
          child,
          guarded: flow.guarded,
        })).catch(() => {});
        settle(flow.tabId);
      })().catch(() => { settle(flow.tabId); });
    }, Math.max(0, blankDelayMs));
  };

  const closeOrBlank = async (/** @type {PopupFlow} */ flow) => {
    if (close) {
      try {
        await close(flow.tabId);
        return /** @type {'closed'} */ ('closed');
      } catch { /* fall through to a verified blank */ }
    }
    try {
      await neutralize(flow.tabId);
      return /** @type {'left_blank'} */ ('left_blank');
    } catch {
      // why: never claim a child is blank when both browser control calls
      // rejected. The tab-scoped network floor remains, but its visible state
      // is unknown and the model must not infer successful containment.
      return /** @type {'uncontained'} */ ('uncontained');
    }
  };

  const reportFailure = (
    /** @type {PopupFlow} */ flow,
    /** @type {string} */ reason,
    /** @type {PopupChildState} */ child,
  ) => {
    if (flow.sourceTabId == null) return;
    Promise.resolve(onFailed({
      sourceTabId: flow.sourceTabId,
      tabId: flow.tabId,
      reason,
      child,
      guarded: flow.guarded,
    })).catch(() => {});
  };

  const reportBlocked = (
    /** @type {PopupFlow} */ flow,
    /** @type {PopupChildState} */ child,
  ) => {
    if (flow.sourceTabId == null) return;
    Promise.resolve(onBlocked({
      sourceTabId: flow.sourceTabId,
      tabId: flow.tabId,
      reason: flow.blockReason || 'protected_target',
      child,
      guarded: flow.guarded,
      outcome: flow.neutralized && child !== 'uncontained' ? 'not_run' : 'unverified',
    })).catch(() => {});
  };

  const blockProtectedTarget = (/** @type {PopupFlow} */ flow) => {
    if (flow.blocked) return true;
    if (!flow.destination || flow.sourceTabId == null) return false;
    const verdict = classifyTarget(flow.destination);
    if (verdict.allowed) return false;
    flow.blocked = true;
    flow.blockReason = verdict.reason || 'protected_target';
    return true;
  };

  const finish = (/** @type {PopupFlow} */ flow) => {
    if (!flow.ready || !flow.destination || flow.finishing) return;
    if (blockProtectedTarget(flow)) {
      flow.finishing = true;
      (async () => {
        const child = await closeOrBlank(flow);
        reportBlocked(flow, child);
        settle(flow.tabId);
      })().catch(() => { settle(flow.tabId); });
      return;
    }
    flow.finishing = true;
    const destination = flow.destination;
    resume(flow.tabId, destination)
      .then(() => { settle(flow.tabId); })
      .catch(async () => {
        const child = await closeOrBlank(flow);
        reportFailure(flow, 'child_resume_failed', child);
        settle(flow.tabId);
      });
  };

  const drivenSource = (/** @type {PopupFlow} */ flow) => {
    for (const sourceTabId of flow.sourceTabIds) {
      if (sourceState(sourceTabId) === 'driven') return sourceTabId;
    }
    return null;
  };

  const startDrivenFlow = (
    /** @type {PopupFlow} */ flow,
    /** @type {number} */ sourceTabId,
    /** @type {boolean} */ startupGuarded = false,
  ) => {
    if (flow.started) return;
    flow.started = true;
    flow.sourceTabId = sourceTabId;
    flow.guarded = startupGuarded;
    (async () => {
      const protectedTarget = blockProtectedTarget(flow);
      // webNavigation identifies the child before onBeforeNavigate. Replace its
      // shell first, then resume only after exact source custody is rechecked
      // and the child has its own durable tab-scoped DNR rules.
      try {
        await neutralize(flow.tabId);
        flow.neutralized = true;
      } catch { /* the exact child still needs its independent network floor */ }
      if (flows.get(flow.tabId) !== flow) return;
      const result = await adoptFromSource(sourceTabId, flow.tabId);
      if (flows.get(flow.tabId) !== flow) return;
      if (!result.ok || result.adopted !== true) {
        flow.guarded = false;
        flow.finishing = true;
        const child = await closeOrBlank(flow);
        if (protectedTarget) reportBlocked(flow, child);
        else reportFailure(flow, 'child_guard_failed', child);
        settle(flow.tabId);
        return;
      }
      flow.guarded = true;
      if (!flow.neutralized) {
        flow.finishing = true;
        const child = await closeOrBlank(flow);
        if (protectedTarget) reportBlocked(flow, child);
        else reportFailure(flow, 'child_neutralize_failed', child);
        settle(flow.tabId);
        return;
      }
      flow.ready = true;
      if (protectedTarget || flow.destination) finish(flow);
      else scheduleBlankReport(flow);
    })().catch(() => {
      if (flow.finishing) return;
      flow.finishing = true;
      (async () => {
        const child = await closeOrBlank(flow);
        if (flow.blocked) reportBlocked(flow, child);
        else reportFailure(flow, 'child_guard_failed', child);
        settle(flow.tabId);
      })().catch(() => { settle(flow.tabId); });
    });
  };

  const resolveUnknownFlow = (/** @type {PopupFlow} */ flow) => {
    if (!adoptUnknownFromSource || flow.resolvingUnknown || flow.started) return;
    const unknownSources = [...flow.sourceTabIds]
      .filter((sourceTabId) => sourceState(sourceTabId) === 'unknown'
        && !flow.unknownAttempted.has(sourceTabId));
    if (unknownSources.length === 0) return;
    flow.resolvingUnknown = true;
    (async () => {
      for (const sourceTabId of unknownSources) {
        flow.unknownAttempted.add(sourceTabId);
        if (await adoptUnknownFromSource(sourceTabId, flow.tabId)) {
          if (flows.get(flow.tabId) === flow && !flow.started && !flow.finishing) {
            startDrivenFlow(flow, sourceTabId, true);
          }
          return;
        }
      }
    })().finally(() => {
      flow.resolvingUnknown = false;
      if (flows.get(flow.tabId) === flow && !flow.started && !flow.finishing) advance(flow);
    });
  };

  const advance = (/** @type {PopupFlow} */ flow) => {
    if (flow.started) {
      finish(flow);
      return;
    }
    const sourceTabId = drivenSource(flow);
    if (sourceTabId == null) {
      const states = [...flow.sourceTabIds].map(sourceState);
      if (states.length > 0 && states.every((state) => state === 'user')) forget(flow.tabId);
      else resolveUnknownFlow(flow);
      return;
    }
    startDrivenFlow(flow, sourceTabId);
  };

  const observe = (
    /** @type {number} */ tabId,
    /** @type {number} */ sourceTabId,
    /** @type {unknown} */ rawUrl,
  ) => {
    if (settled.has(tabId)) return Promise.resolve();
    let flow = flows.get(tabId);
    if (!flow) {
      /** @type {(value?:void)=>void} */ let resolve = () => {};
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      flow = {
      tabId,
      sourceTabIds: new Set(),
      destination: '',
      started: false,
      ready: false,
      finishing: false,
      resolvingUnknown: false,
      unknownAttempted: new Set(),
      sourceTabId: null,
      blocked: false,
      blockReason: '',
      neutralized: false,
      guarded: false,
      blankReported: false,
      blankTimer: null,
      done,
      resolve,
      };
    }
    flow.sourceTabIds.add(sourceTabId);
    flow.destination = meaningfulDestination(rawUrl) || flow.destination;
    if (flow.destination && flow.blankTimer != null) {
      clearTimeout(flow.blankTimer);
      flow.blankTimer = null;
    }
    flows.set(tabId, flow);
    advance(flow);
    return flow.done;
  };

  return {
    /** @param {{ id?: number, openerTabId?: number, pendingUrl?: string, url?: string }} tab */
    onCreated(tab) {
      if (typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return;
      return observe(tab.id, tab.openerTabId, tab.pendingUrl || tab.url);
    },

    /**
     * Firefox can expose about:blank at creation. Keep a later meaningful URL
     * only for a child already tied to a browser source event.
     * @param {number} tabId
     * @param {{ url?: string }} changeInfo
     * @param {{ pendingUrl?: string, url?: string }} [tab]
     */
    onUpdated(tabId, changeInfo, tab = {}) {
      const flow = flows.get(tabId);
      if (!flow) return;
      flow.destination = meaningfulDestination(changeInfo.url || tab.pendingUrl || tab.url)
        || flow.destination;
      if (flow.destination && flow.blankTimer != null) {
        clearTimeout(flow.blankTimer);
        flow.blankTimer = null;
      }
      finish(flow);
      return flow.done;
    },

    /**
     * This event supplies exact source and destination identity before
     * onBeforeNavigate, including a child opened by a cross-origin frame.
     * @param {{ sourceTabId?: number, tabId?: number, url?: string }} details
     */
    onNavigationTarget(details) {
      if (typeof details.sourceTabId !== 'number' || typeof details.tabId !== 'number') return;
      return observe(details.tabId, details.sourceTabId, details.url);
    },

    // Resolve only queued unknown-source events after session custody hydrates.
    // Positively user-owned children were never blanked or changed.
    onBootReady() {
      for (const flow of flows.values()) advance(flow);
    },

    /** @param {number} sourceTabId */
    hasPendingSource(sourceTabId) {
      for (const flow of flows.values()) {
        if (flow.sourceTabIds.has(sourceTabId)) return true;
      }
      return false;
    },

    /** @param {number} tabId */
    onRemoved(tabId) {
      forget(tabId);
      settled.delete(tabId);
    },
  };
};
