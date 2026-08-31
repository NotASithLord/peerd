// @ts-check

const MAX_NOTICES = 32;

/** @param {{audit?:(entry:any)=>unknown,noteBlank?:(tabId:number)=>unknown}} deps */
export const createKernelBrowserChildOutcomes = ({ audit = () => {}, noteBlank = () => {} }) => {
  /** @type {Map<number,any[]>} */ const notices = new Map();
  /** @type {Map<number,Set<()=>void>>} */ const waiters = new Map();
  /** @type {Map<number,Map<number,{token:symbol,count:number,guarded:boolean,actionToken?:symbol}>>} */ const pending = new Map();
  /** @type {Map<number,symbol>} */ const currentTokens = new Map();
  /** @type {Map<number,symbol>} */ const reportedTokens = new Map();
  /** @type {Map<number,{token:symbol,observed:boolean,notices:any[],waiters:Set<()=>void>}>} */
  const actions = new Map();
  const wake = (/** @type {number} */ sourceTabId) => {
    for (const resolve of waiters.get(sourceTabId) ?? []) resolve();
  };
  const enqueue = (/** @type {number} */ sourceTabId, /** @type {any} */ notice) => {
    const current = notices.get(sourceTabId) ?? [];
    if (current.length < MAX_NOTICES) current.push(Object.freeze(notice));
    notices.set(sourceTabId, current);
    wake(sourceTabId);
  };
  const wakeAction = (/** @type {number} */ sourceTabId) => {
    for (const resolve of actions.get(sourceTabId)?.waiters ?? []) resolve();
  };
  const enqueueAction = (/** @type {number} */ sourceTabId,
    /** @type {symbol|undefined} */ actionToken, /** @type {any} */ notice) => {
    const action = actions.get(sourceTabId);
    if (!actionToken || action?.token !== actionToken) return false;
    if (action.notices.length < MAX_NOTICES) action.notices.push(Object.freeze(notice));
    wakeAction(sourceTabId);
    return true;
  };
  const append = (/** @type {any} */ event, /** @type {string} */ type,
    /** @type {any} */ notice) => {
    const token = event.flowToken;
    const current = currentTokens.get(event.tabId);
    const flow = pending.get(event.sourceTabId)?.get(event.tabId);
    const accepted = typeof token === 'symbol'
      ? current === token
      : current != null
        && flow?.token === current;
    if (accepted && (typeof token !== 'symbol'
        || reportedTokens.get(event.tabId) !== token)) {
      if (typeof token === 'symbol') reportedTokens.set(event.tabId, token);
      if (!enqueueAction(event.sourceTabId, flow?.actionToken, notice)) {
        enqueue(event.sourceTabId, notice);
      }
    }
    try {
      Promise.resolve(audit({
        type,
        details: { browserPolicy: {
          reason: event.reason,
          child: notice.child,
          guarded: event.guarded !== false,
          outcome: notice.outcome,
        } },
      })).catch(() => {});
    } catch {}
    if (event.child === 'left_blank') {
      try { Promise.resolve(noteBlank(event.tabId)).catch(() => {}); } catch {}
    }
  };
  const navigation = (/** @type {any} */ event, /** @type {string} */ kind) => {
    const blocked = kind === 'blocked';
    const outcome = blocked && event.outcome === 'not_run' ? 'not_run' : 'unverified';
    append(event, `browser_child_navigation_${kind}`, {
      reason: event.reason === 'child_authority_unavailable' ? event.reason
        : blocked ? 'protected_child_navigation'
        : kind === 'unverified' ? 'child_navigation_unverified' : 'child_navigation_failed',
      outcome, child: event.child, retryable: event.retryable === true,
    });
  };
  const consume = (/** @type {number} */ tabId) => {
    const current = notices.get(tabId) ?? [];
    if (current.length) notices.delete(tabId);
    return current;
  };
  const wait = (/** @type {number} */ tabId, /** @type {number} */ timeoutMs) => {
    if ((notices.get(tabId)?.length ?? 0) > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (/** @type {boolean} */ found) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const current = waiters.get(tabId);
        current?.delete(waiterWake);
        if (current?.size === 0) waiters.delete(tabId);
        resolve(found);
      };
      const waiterWake = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      const current = waiters.get(tabId) ?? new Set();
      current.add(waiterWake);
      waiters.set(tabId, current);
    });
  };
  const pendingForAction = (/** @type {number} */ sourceTabId,
    /** @type {symbol} */ actionToken) => [...(pending.get(sourceTabId)?.entries() ?? [])]
    .filter(([, flow]) => flow.actionToken === actionToken);
  const releaseAction = (/** @type {number} */ sourceTabId,
    /** @type {symbol} */ actionToken) => {
    const action = actions.get(sourceTabId);
    if (action?.token !== actionToken) return false;
    for (const [childTabId, flow] of pendingForAction(sourceTabId, actionToken)) {
      pending.get(sourceTabId)?.delete(childTabId);
      if (currentTokens.get(childTabId) === flow.token) currentTokens.delete(childTabId);
      if (reportedTokens.get(childTabId) === flow.token) reportedTokens.delete(childTabId);
    }
    if (pending.get(sourceTabId)?.size === 0) pending.delete(sourceTabId);
    actions.delete(sourceTabId);
    for (const resolve of action.waiters) resolve();
    return true;
  };
  const waitForAction = (/** @type {number} */ sourceTabId,
    /** @type {symbol} */ actionToken, /** @type {number} */ timeoutMs,
    /** @type {boolean} */ terminal = false, /** @type {AbortSignal|undefined} */ signal = undefined) => {
    const action = actions.get(sourceTabId);
    if (action?.token !== actionToken) return Promise.resolve(false);
    const complete = () => {
      const current = actions.get(sourceTabId);
      if (current?.token !== actionToken) return false;
      if (!terminal) return current.observed || current.notices.length > 0;
      return current.notices.length > 0
        || current.observed && pendingForAction(sourceTabId, actionToken).length === 0;
    };
    if (complete()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    // why: the action reservation exists before page execution, but does not
    // itself prove a child exists. The short onset wait keeps ordinary clicks
    // fast; only an observed child enters the terminal authority wait.
    return new Promise((resolve) => {
      let settled = false;
      const finish = (/** @type {boolean} */ found) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        actions.get(sourceTabId)?.waiters.delete(onWake);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(found);
      };
      const onWake = () => {
        if (actions.get(sourceTabId)?.token !== actionToken) finish(false);
        else if (complete()) finish(true);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => {
        const current = actions.get(sourceTabId);
        if (current?.token !== actionToken) return finish(false);
        const children = pendingForAction(sourceTabId, actionToken);
        if (!terminal || !current.observed || children.length === 0) return finish(false);
        const guarded = children.every(([, flow]) => flow.guarded);
        for (const [childTabId, flow] of children) {
          pending.get(sourceTabId)?.delete(childTabId);
          if (currentTokens.get(childTabId) === flow.token) currentTokens.delete(childTabId);
          if (reportedTokens.get(childTabId) === flow.token) reportedTokens.delete(childTabId);
        }
        if (pending.get(sourceTabId)?.size === 0) pending.delete(sourceTabId);
        enqueueAction(sourceTabId, actionToken, {
          reason: guarded ? 'child_authority_unavailable' : 'child_navigation_unverified',
          outcome: 'unverified', child: guarded ? 'guarded' : 'uncontained',
          retryable: guarded,
        });
        try {
          Promise.resolve(audit({
            type: 'browser_child_navigation_timeout',
            details: { browserPolicy: {
              reason: 'child_authority_timeout',
              child: guarded ? 'guarded' : 'uncontained',
              guarded, outcome: 'unverified',
            } },
          })).catch(() => {});
        } catch {}
        finish(true);
      }, Math.max(0, timeoutMs));
      action.waiters.add(onWake);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  };
  return Object.freeze({
    reserveAction(/** @type {number} */ sourceTabId) {
      if (!Number.isInteger(sourceTabId) || sourceTabId < 0 || actions.has(sourceTabId)) {
        return null;
      }
      const token = Symbol(`source-action:${sourceTabId}`);
      actions.set(sourceTabId, {
        token, observed: false, notices: [], waiters: new Set(),
      });
      return token;
    },
    begin(/** @type {number} */ sourceTabId, /** @type {number} */ childTabId,
      /** @type {symbol} */ token = Symbol(`child:${childTabId}`)) {
      if (!Number.isInteger(sourceTabId) || sourceTabId < 0
          || !Number.isInteger(childTabId) || childTabId < 0) return token;
      const prior = currentTokens.get(childTabId);
      if (prior && prior !== token) reportedTokens.delete(childTabId);
      currentTokens.set(childTabId, token);
      const children = pending.get(sourceTabId) ?? new Map();
      const current = children.get(childTabId);
      const action = actions.get(sourceTabId);
      if (action) {
        action.observed = true;
        wakeAction(sourceTabId);
      }
      children.set(childTabId, {
        token,
        count: current?.token === token ? current.count + 1 : 1,
        guarded: current?.token === token && current.guarded === true,
        ...(current?.token === token && current.actionToken
          ? { actionToken: current.actionToken }
          : action ? { actionToken: action.token } : {}),
      });
      pending.set(sourceTabId, children);
      return token;
    },
    settle(/** @type {number} */ sourceTabId, /** @type {number} */ childTabId,
      /** @type {symbol|undefined} */ token = undefined) {
      const children = pending.get(sourceTabId);
      const current = children?.get(childTabId);
      if (!current || (token && current.token !== token)) return;
      if (current.count > 1) children?.set(childTabId, {
        token: current.token, count: current.count - 1, guarded: current.guarded,
      });
      else children?.delete(childTabId);
      if (children?.size === 0) pending.delete(sourceTabId);
      wake(sourceTabId);
      if (current.actionToken) wakeAction(sourceTabId);
    },
    recordBlocked: (/** @type {any} */ event) => navigation(event, 'blocked'),
    recordFailed: (/** @type {any} */ event) => navigation(event, 'failed'),
    recordUnverified: (/** @type {any} */ event) => navigation(event, 'unverified'),
    recordRequestBlocked: (/** @type {any} */ event) => append(
      { ...event, guarded: true }, 'browser_child_request_blocked', {
        reason: 'protected_child_request', outcome: 'not_run',
        child: 'guarded', retryable: false,
      },
    ),
    consume,
    consumeAction(/** @type {number} */ sourceTabId, /** @type {symbol} */ actionToken) {
      const action = actions.get(sourceTabId);
      if (action?.token !== actionToken) return [];
      return action.notices.splice(0);
    },
    waitAction: waitForAction,
    releaseAction,
    contain(/** @type {number} */ sourceTabId, /** @type {number} */ childTabId,
      /** @type {symbol} */ token) {
      const flow = pending.get(sourceTabId)?.get(childTabId);
      if (flow?.token === token) flow.guarded = true;
    },
    wait: (/** @type {number} */ tabId, /** @type {number} */ timeoutMs,
      /** @type {boolean} */ terminal = false) => {
      if (!terminal) return wait(tabId, timeoutMs);
      if ((notices.get(tabId)?.length ?? 0) > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {boolean} */ found) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const current = waiters.get(tabId);
          current?.delete(onWake);
          if (current?.size === 0) waiters.delete(tabId);
          resolve(found);
        };
        const onWake = () => {
          if ((notices.get(tabId)?.length ?? 0) > 0 || !pending.has(tabId)) finish(true);
        };
        const timer = setTimeout(() => {
          const children = pending.get(tabId);
          if (children?.size) {
            const guarded = [...children.values()].every((flow) => flow.guarded);
            for (const [childTabId, flow] of children) {
              if (currentTokens.get(childTabId) === flow.token) currentTokens.delete(childTabId);
              if (reportedTokens.get(childTabId) === flow.token) reportedTokens.delete(childTabId);
            }
            pending.delete(tabId);
            enqueue(tabId, {
              reason: guarded ? 'child_authority_unavailable' : 'child_navigation_unverified',
              outcome: 'unverified', child: guarded ? 'guarded' : 'uncontained',
              retryable: guarded,
            });
            try {
              Promise.resolve(audit({
                type: 'browser_child_navigation_timeout',
                details: { browserPolicy: {
                  reason: 'child_authority_timeout',
                  child: guarded ? 'guarded' : 'uncontained',
                  guarded, outcome: 'unverified',
                } },
              })).catch(() => {});
            } catch {}
            finish(true);
          } else finish(false);
        }, Math.max(0, timeoutMs));
        const current = waiters.get(tabId) ?? new Set();
        current.add(onWake);
        waiters.set(tabId, current);
      });
    },
    has: (/** @type {number} */ tabId) => (notices.get(tabId)?.length ?? 0) > 0
      || pending.has(tabId),
    release(/** @type {number} */ tabId) {
      const action = actions.get(tabId);
      if (action) releaseAction(tabId, action.token);
      notices.delete(tabId);
      for (const [childTabId, flow] of pending.get(tabId) ?? []) {
        if (currentTokens.get(childTabId) === flow.token) currentTokens.delete(childTabId);
        if (reportedTokens.get(childTabId) === flow.token) reportedTokens.delete(childTabId);
      }
      pending.delete(tabId);
      const ownToken = currentTokens.get(tabId);
      if (ownToken && reportedTokens.get(tabId) === ownToken) reportedTokens.delete(tabId);
      currentTokens.delete(tabId);
      for (const [sourceTabId, children] of pending) {
        const flow = children.get(tabId);
        if (flow) {
          if (reportedTokens.get(tabId) === flow.token) reportedTokens.delete(tabId);
          children.delete(tabId);
          wake(sourceTabId);
        }
      }
      for (const [sourceTabId, children] of pending) {
        if (children.size === 0) {
          pending.delete(sourceTabId);
          wake(sourceTabId);
        }
      }
      wake(tabId);
      waiters.delete(tabId);
    },
  });
};
