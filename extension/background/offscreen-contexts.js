// @ts-check
// One capability-checked probe for the Chrome-only offscreen context API.

/**
 * @param {any} browserApi
 * @returns {Promise<any[]>}
 */
export const listOffscreenContexts = async (browserApi) => {
  if (typeof browserApi?.offscreen?.createDocument !== 'function'
      || typeof browserApi?.runtime?.getContexts !== 'function') return [];
  const contexts = await browserApi.runtime.getContexts({
    contextTypes: /** @type {any} */ (['OFFSCREEN_DOCUMENT']),
  });
  return Array.isArray(contexts) ? contexts : [];
};
