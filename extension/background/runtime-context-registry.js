// @ts-check
// Track CDP execution contexts by tab so page_exec can select the checked
// main document instead of evaluating against whichever context is current.

export const createRuntimeContextRegistry = () => {
  /** @type {Map<number, Map<number, { origin: string, frameId: string, isDefault: boolean }>>} */
  const tabs = new Map();

  /**
   * Fold one Runtime context lifecycle event into the registry.
   * @param {number} tabId
   * @param {string} method
   * @param {any} params
   * @returns {boolean} whether the event was a context lifecycle event
   */
  const observe = (tabId, method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      const context = params?.context;
      if (typeof context?.id !== 'number') return true;
      const contexts = tabs.get(tabId) ?? new Map();
      contexts.set(context.id, {
        origin: typeof context.origin === 'string' ? context.origin : '',
        frameId: typeof context.auxData?.frameId === 'string' ? context.auxData.frameId : '',
        isDefault: context.auxData?.isDefault === true,
      });
      tabs.set(tabId, contexts);
      return true;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      tabs.get(tabId)?.delete(params?.executionContextId);
      return true;
    }
    if (method === 'Runtime.executionContextsCleared') {
      tabs.delete(tabId);
      return true;
    }
    return false;
  };

  /**
   * @param {number} tabId
   * @param {string} frameId
   * @param {string} origin
   * @returns {number | null}
   */
  const selectMain = (tabId, frameId, origin) => {
    for (const [contextId, context] of tabs.get(tabId) ?? []) {
      if (context.isDefault && context.frameId === frameId && context.origin === origin) return contextId;
    }
    return null;
  };

  return { observe, selectMain, release: (/** @type {number} */ tabId) => tabs.delete(tabId) };
};
