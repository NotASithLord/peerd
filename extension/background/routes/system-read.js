// @ts-check
// Controller-independent system projections. Kept physically separate from
// transfer, actor-retry, audit-write, and surface-mutation authority so a thin
// native entry can expose basic UI reads without parsing those feature bodies.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => any>}
 */
export const makeSystemReadRoutes = (deps) => {
  const { vault, auditLog, sessions, buildStateSnapshot, uiPorts } = deps;
  return ({
  'state/get': async () => ({ ok: true, state: await buildStateSnapshot() }),
  'audit/list': async ({ limit = 500 } = {}) => {
    try {
      const all = await auditLog.list();
      return { ok: true, entries: all.slice(-limit).reverse(), total: all.length };
    } catch (error) {
      return {
        ok: false,
        error: /** @type {{message?:string}} */ (error)?.message ?? 'audit-list-failed',
      };
    }
  },
  'cost/total': async () => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    try {
      const all = await sessions.listMetadata();
      let usd = 0;
      let tokens = 0;
      let chats = 0;
      for (const session of all) {
        const kind = session.kind ?? 'chat';
        if (kind === 'actor' || kind === 'spawned') continue;
        const cost = session.cost;
        if (!cost) continue;
        const used = (cost.inputTokens || 0) + (cost.outputTokens || 0)
          + (cost.cacheReadTokens || 0) + (cost.cacheWriteTokens || 0);
        if (used === 0 && !(Number(cost.cost) > 0)) continue;
        usd += Number(cost.cost) || 0;
        tokens += used;
        chats += 1;
      }
      return { ok: true, usd, tokens, chats };
    } catch (error) {
      return {
        ok: false,
        error: /** @type {{message?:string}} */ (error)?.message ?? 'cost-total-failed',
      };
    }
  },
  'surfaces/get': () => ({ ok: true, sidePanelOpen: uiPorts.hasNamed('sidepanel') }),
  });
};
