// @ts-check
// The execute-time wall for durable SITE CLIENT custody.
//
// The actor-tier gate asks the same predicate before confirmation, but pre-tool
// hooks may rewrite arguments after gates run. Every site-client tool therefore
// rechecks the FINAL normalized target here before reading a record, executing
// its module, prompting, or mutating the store.

/**
 * @param {string} origin
 * @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResultErr | null>}
 */
export const siteClientOriginRefusal = async (origin, ctx) => {
  try {
    if (await ctx.authorizeSiteClientOrigin?.(origin) === true) return null;
  } catch { /* a broken custody predicate fails closed */ }
  return {
    ok: false,
    // Fixed prose: a page-steered origin argument must not become a reflected
    // prompt in the actor result or the dispatcher audit trail.
    error: 'site_client_origin_refused: this actor does not own that site client origin',
    outcomeKind: 'pre-effect-failure',
  };
};
