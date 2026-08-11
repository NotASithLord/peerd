// @ts-check
// Own the lifecycle of site_capture across the CDP and injected-page backends.
// IO stays injected so the state machine is testable without a service worker.

/**
 * @param {{
 *   advancedAutomationOn: () => boolean,
 *   debuggerPool: any,
 *   scripting: any,
 *   installFetchTapInjected: Function,
 *   drainFetchTapInjected: Function,
 *   digestCapture: (events: any[], opts: { origins: string[], deriver: 'capture-cdp'|'capture-tap' }) => any,
 * }} deps
 */
export const makeSiteCaptureManager = (deps) => {
  const {
    advancedAutomationOn,
    debuggerPool,
    scripting,
    installFetchTapInjected,
    drainFetchTapInjected,
    digestCapture,
  } = deps;
  /** @typedef {{ tap: 'cdp'|'tap', origins: string[], documentId?: string, starting?: boolean, cancelled?: 'page_changed' }} CaptureRecord */
  /** @type {Map<number, CaptureRecord>} */
  const active = new Map();
  /** @type {Map<number, { reason: 'page_changed', record: CaptureRecord }>} */
  const cancellations = new Map();

  /**
   * End an existing capture before replacing it. A start call has already
   * passed the browser-target policy, so draining the injected backend here is
   * safe and prevents events from the old capture entering the new one.
   * @param {number} tabId
   */
  const clearForRestart = async (tabId) => {
    const prior = active.get(tabId);
    if (!prior) return;
    // A stop already settling this exact record must not digest it after the
    // replacement start takes ownership.
    prior.cancelled = 'page_changed';
    active.delete(tabId);
    if (prior.tap === 'cdp') {
      if (debuggerPool.discardNetworkCapture) await debuggerPool.discardNetworkCapture(tabId);
      else await debuggerPool.stopNetworkCapture?.(tabId);
      return;
    }
    if (!prior.documentId) return;
    await scripting.executeScript({
      target: { tabId, documentIds: [prior.documentId] },
      world: 'MAIN', func: drainFetchTapInjected,
    }).catch(() => {});
  };

  /** @param {{ tabId: number, origins: string[], documentId?: string, expectedDocument?: any }} input */
  const start = async ({ tabId, origins, documentId, expectedDocument }) => {
    await clearForRestart(tabId);
    cancellations.delete(tabId);
    if (advancedAutomationOn() && debuggerPool.startNetworkCapture) {
      const record = { tap: /** @type {const} */ ('cdp'), origins: [...origins], documentId, starting: true };
      active.set(tabId, record);
      try {
        await debuggerPool.startNetworkCapture(tabId, expectedDocument);
      } catch (error) {
        if (active.get(tabId) === record) active.delete(tabId);
        throw error;
      }
      // A tabs.onUpdated cancellation can race the async debugger setup. It
      // owns the outcome even when attach finishes afterward.
      if (active.get(tabId) !== record) {
        await debuggerPool.discardNetworkCapture?.(tabId);
        if (debuggerPool.isAttached?.(tabId) === true) await debuggerPool.detach?.(tabId);
        throw new Error('browser_target_changed');
      }
      record.starting = false;
      return { tap: 'cdp' };
    }
    if (!documentId) throw new Error('browser_target_unverified');
    const record = { tap: /** @type {const} */ ('tap'), origins: [...origins], documentId, starting: true };
    active.set(tabId, record);
    try {
      await scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        world: 'MAIN',
        func: installFetchTapInjected,
        args: [origins],
      });
    } catch (error) {
      if (active.get(tabId) === record) active.delete(tabId);
      throw error;
    }
    if (active.get(tabId) !== record) {
      await scripting.executeScript({
        target: { tabId, documentIds: [documentId] }, world: 'MAIN', func: drainFetchTapInjected,
      }).catch(() => {});
      throw new Error('browser_target_changed');
    }
    record.starting = false;
    return { tap: 'tap' };
  };

  /** @param {{ tabId: number, origins?: string[] }} input */
  const stop = async ({ tabId, origins = [] }) => {
    const priorCancellation = cancellations.get(tabId);
    if (priorCancellation) {
      if (cancellations.get(tabId) === priorCancellation) cancellations.delete(tabId);
      return { cancelled: priorCancellation.reason };
    }
    const current = active.get(tabId);
    if (!current) {
      return digestCapture([], {
        origins,
        deriver: 'capture-tap',
      });
    }
    /** @type {any[]} */
    let events = [];
    try {
      if (current.tap === 'cdp') {
        events = await debuggerPool.stopNetworkCapture(tabId);
      } else {
        if (!current.documentId) throw new Error('browser_target_unverified');
        const [result] = await scripting.executeScript({
          target: { tabId, documentIds: [current.documentId] },
          world: 'MAIN', func: drainFetchTapInjected,
        });
        events = /** @type {any} */ (result?.result)?.events ?? [];
      }
    } catch (error) {
      if (active.get(tabId) === current) active.delete(tabId);
      if (current.cancelled) {
        const pending = cancellations.get(tabId);
        if (pending?.record === current) cancellations.delete(tabId);
        return { cancelled: current.cancelled };
      }
      throw error;
    }
    // Keep ownership visible while the backend settles. tabs.onUpdated can now
    // find and revoke this exact record; a replacement start likewise marks it.
    if (current.cancelled || active.get(tabId) !== current) {
      const pending = cancellations.get(tabId);
      if (pending?.record === current) cancellations.delete(tabId);
      return { cancelled: current.cancelled ?? 'page_changed' };
    }
    active.delete(tabId);
    return digestCapture(events, {
      origins: current.origins,
      deriver: current.tap === 'cdp' ? 'capture-cdp' : 'capture-tap',
    });
  };

  /**
   * Stop observing and forget every event without touching the current page.
   * This is the private/blank navigation path: injecting a drain into the new
   * document would itself be an operation on the blocked destination.
   * @param {{ tabId: number, reason?: 'page_changed' }} input
   */
  const cancel = async ({ tabId, reason = 'page_changed' }) => {
    const current = active.get(tabId);
    if (!current) return { discarded: false, detached: false };
    current.cancelled = reason;
    active.delete(tabId);
    cancellations.set(tabId, { reason, record: current });
    const debuggerAttached = current.tap === 'cdp' && debuggerPool.isAttached?.(tabId) === true;
    if (current.tap === 'cdp') {
      if (debuggerPool.discardNetworkCapture) await debuggerPool.discardNetworkCapture(tabId);
      else await debuggerPool.stopNetworkCapture?.(tabId);
      // A private or blank landing ends all browser automation custody for the
      // tab, not only Network observation. Remove the pooled debugger session.
      if (debuggerAttached) await debuggerPool.detach?.(tabId);
    }
    return { discarded: !!current, detached: debuggerAttached };
  };

  /**
   * A removed tab has already destroyed its page and debugger session. This
   * synchronous release bounds manager state without issuing browser commands
   * against a dead target.
   * @param {number} tabId
   */
  const release = (tabId) => {
    const current = active.get(tabId);
    if (current) current.cancelled = 'page_changed';
    active.delete(tabId);
    cancellations.delete(tabId);
    debuggerPool.releaseNetworkCapture?.(tabId);
  };

  return { start, stop, cancel, release, has: (/** @type {number} */ tabId) => active.has(tabId) };
};
