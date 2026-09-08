// @ts-check

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

/** @typedef {{allowed:boolean,reason?:string}} PopupTargetVerdict */

/** @typedef {'closed'|'left_blank'|'uncontained'} PopupChildState */
/** @typedef {{ sourceTabId: number, tabId: number, reason: string, child: PopupChildState, guarded: boolean, flowToken?:symbol }} PopupOutcomeEvent */

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
  /** @typedef {{tabId:number,sourceTabIds:Set<number>,destination:string,started:boolean,ready:boolean,finishing:boolean,resolvingUnknown:boolean,unknownAttempted:Set<number>,sourceTabId:number|null,flowToken:symbol|undefined,blocked:boolean,blockReason:string,neutralized:boolean,guarded:boolean,blankReported:boolean,blankTimer:ReturnType<typeof setTimeout>|null,done:Promise<void>,resolve:(value?:void)=>void}} PopupFlow */
  /** @type {Map<number, PopupFlow>} */
  const flows = new Map();
  /** @type {Set<number>} */
  const settled = new Set();
  const meaningfulDestination = (/** @type {unknown} */ url) =>
    typeof url === 'string' && url.length > 0 && url !== 'about:blank' ? url : '';
  const forget = (/** @type {number} */ tabId,
    /** @type {PopupFlow|null} */ expected = null) => {
    const flow = flows.get(tabId);
    if (expected && flow !== expected) {
      expected.resolve();
      return false;
    }
    if (flow?.blankTimer != null) clearTimeout(flow.blankTimer);
    flows.delete(tabId);
    flow?.resolve();
    return true;
  };
  const settle = (/** @type {PopupFlow} */ flow) => {
    const tabId = flow.tabId;
    if (flows.get(tabId) !== flow) {
      flow.resolve();
      return;
    }
    if (flow?.guarded && flow.sourceTabId != null) {
      try {
        Promise.resolve(onGuarded({ sourceTabId: flow.sourceTabId, tabId })).catch(() => {});
      } catch { /* release notification is best-effort; tab removal also cleans up */ }
    }
    forget(tabId, flow);
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
          flowToken: flow.flowToken,
        })).catch(() => {});
        settle(flow);
      })().catch(() => { settle(flow); });
    }, Math.max(0, blankDelayMs));
  };

  const closeOrBlank = async (/** @type {PopupFlow} */ flow) => {
    if (flows.get(flow.tabId) !== flow) return /** @type {'closed'} */ ('closed');
    if (close) {
      try {
        await close(flow.tabId);
        return /** @type {'closed'} */ ('closed');
      } catch {
        if (flows.get(flow.tabId) !== flow) return /** @type {'closed'} */ ('closed');
      }
    }
    if (flows.get(flow.tabId) !== flow) return /** @type {'closed'} */ ('closed');
    try {
      await neutralize(flow.tabId);
      return /** @type {'left_blank'} */ ('left_blank');
    } catch {
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
      flowToken: flow.flowToken,
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
      flowToken: flow.flowToken,
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
        settle(flow);
      })().catch(() => { settle(flow); });
      return;
    }
    flow.finishing = true;
    const destination = flow.destination;
    if (flows.get(flow.tabId) !== flow) return;
    resume(flow.tabId, destination)
      .then(() => { settle(flow); })
      .catch(async () => {
        const child = await closeOrBlank(flow);
        reportFailure(flow, 'child_resume_failed', child);
        settle(flow);
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
        settle(flow);
        return;
      }
      flow.guarded = true;
      if (!flow.neutralized) {
        flow.finishing = true;
        const child = await closeOrBlank(flow);
        if (protectedTarget) reportBlocked(flow, child);
        else reportFailure(flow, 'child_neutralize_failed', child);
        settle(flow);
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
        settle(flow);
      })().catch(() => { settle(flow); });
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
      if (states.length > 0 && states.every((state) => state === 'user')) {
        forget(flow.tabId, flow);
      }
      else resolveUnknownFlow(flow);
      return;
    }
    startDrivenFlow(flow, sourceTabId);
  };

  const observe = (
    /** @type {number} */ tabId,
    /** @type {number} */ sourceTabId,
    /** @type {unknown} */ rawUrl,
    /** @type {symbol|undefined} */ flowToken = undefined,
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
      flowToken,
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
    if (flowToken && !flow.flowToken) flow.flowToken = flowToken;
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
    /** @param {{ id?: number, openerTabId?: number, pendingUrl?: string, url?: string, flowToken?:symbol }} tab */
    onCreated(tab) {
      if (typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return;
      return observe(tab.id, tab.openerTabId, tab.pendingUrl || tab.url, tab.flowToken);
    },

    /** @param {number} tabId
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

    /** @param {{sourceTabId?:number,tabId?:number,url?:string,flowToken?:symbol}} details */
    onNavigationTarget(details) {
      if (typeof details.sourceTabId !== 'number' || typeof details.tabId !== 'number') return;
      return observe(details.tabId, details.sourceTabId, details.url, details.flowToken);
    },

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
