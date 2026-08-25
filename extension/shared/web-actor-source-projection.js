// @ts-check

export const WEB_ACTOR_SOURCE_PROJECTION_KEY = 'webActorSourceProjection.v1';

/** @param {any} tab @param {string} sessionId */
export const webActorSourceProjectionRow = (tab, sessionId) => {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || typeof sessionId !== 'string'
      || sessionId.length === 0 || typeof tab?.url !== 'string' || tab.url.length === 0) {
    return null;
  }
  return Object.freeze({
    tabId: tab.id,
    sessionId,
    url: tab.url,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    cookieStoreId: typeof tab.cookieStoreId === 'string' ? tab.cookieStoreId : null,
  });
};

/**
 * @param {unknown} bindings
 * @param {unknown} projection
 * @param {readonly any[]} tabs
 * @param {{requireCookieStore?:boolean}} [options]
 */
export const validateWebActorSourceProjection = (
  bindings, projection, tabs, { requireCookieStore = true } = {},
) => {
  if (!Array.isArray(bindings) || !Array.isArray(tabs)) return null;
  if (projection === null || projection === undefined) {
    return bindings.length === 0 ? new Map() : null;
  }
  if (!Array.isArray(projection)) return null;
  const sessions = new Map();
  for (const binding of bindings) {
    if (!Array.isArray(binding) || !Number.isInteger(binding[0]) || binding[0] < 0
        || typeof binding[1] !== 'string' || binding[1].length === 0
        || sessions.has(binding[0])) return null;
    sessions.set(binding[0], binding[1]);
  }
  if (projection.length !== sessions.size) return null;
  const rows = new Map();
  for (const row of projection) {
    if (!row || !Number.isInteger(row.tabId) || row.tabId < 0
        || typeof row.sessionId !== 'string' || typeof row.url !== 'string'
        || row.url.length === 0
        || ![null, undefined].includes(row.openerTabId)
          && (!Number.isInteger(row.openerTabId) || row.openerTabId < 0)
        || row.cookieStoreId !== null && typeof row.cookieStoreId !== 'string'
        || rows.has(row.tabId) || sessions.get(row.tabId) !== row.sessionId) return null;
    rows.set(row.tabId, row);
  }
  const current = new Map(tabs
    .filter((tab) => Number.isInteger(tab?.id) && tab.id >= 0)
    .map((tab) => [tab.id, tab]));
  const live = new Map();
  const unknown = Symbol('unknown-source-identity');
  for (const [tabId, row] of rows) {
    const tab = current.get(tabId);
    if (!tab) continue;
    const expectedOpener = row.openerTabId ?? null;
    const url = typeof tab.url === 'string' && tab.url.length > 0 ? tab.url : unknown;
    const openerTabId = Number.isInteger(tab.openerTabId) && tab.openerTabId >= 0
      ? tab.openerTabId
      : [null, undefined].includes(tab.openerTabId) && expectedOpener === null
        ? null : unknown;
    const cookieStoreId = requireCookieStore
      ? row.cookieStoreId !== null && typeof tab.cookieStoreId === 'string'
        ? tab.cookieStoreId : unknown
      : null;
    const identity = [
      [url, row.url], [openerTabId, expectedOpener],
      ...(requireCookieStore ? [[cookieStoreId, row.cookieStoreId]] : []),
    ];
    if (identity.some(([actual, expected]) => actual !== unknown && actual !== expected)) {
      continue;
    }
    if (identity.some(([actual]) => actual === unknown)) return null;
    live.set(tabId, row.sessionId);
  }
  return live;
};
