// @ts-check
/**
 * @param {Object} deps
 * @param {any} deps.dnr
 * @param {() => readonly string[]} deps.getPatterns
 * @param {() => readonly number[]} deps.getTabIds
 * @param {() => readonly string[]} [deps.getInitiatorDomains]
 * @param {(input: { patterns: readonly string[], tabIds: readonly number[], initiatorDomains: readonly string[] }) =>
 *   { removeRuleIds: number[], addRules: any[] }} deps.buildUpdate
 * @param {(entry: { type: string, details?: Record<string, any> }) => any} [deps.audit]
 * @param {Pick<Console, 'warn'>} [deps.console]
 * @param {boolean} [deps.deferUntilStarted]
 */
export const makeDenylistNetGuard = ({
  dnr, getPatterns, getTabIds, getInitiatorDomains = () => [], buildUpdate,
  audit, console: log = console,
  deferUntilStarted = false,
}) => {
  const supported = typeof dnr?.updateSessionRules === 'function';
  let queue = Promise.resolve();
  let applied = /** @type {string | null} */ (null);
  const loggedFailures = new Set();
  let lastError = /** @type {string | null} */ (null);
  let custodyError = /** @type {string | null} */ (null);
  let ruleDomains = 0;
  let ruleTabs = /** @type {number[]} */ ([]);
  let startupError = /** @type {string | null} */ (null);
  let start = /** @type {(() => void) | null} */ (null);
  const started = deferUntilStarted
    ? new Promise((resolve) => { start = () => resolve(undefined); })
    : Promise.resolve();

  /** @param {unknown} error */
  const recordFailure = (error) => {
    applied = null;
    lastError = error instanceof Error ? error.message : String(error);
    if (loggedFailures.has(lastError)) return;
    loggedFailures.add(lastError);
    log.warn('[denylist-net-guard] session rule update failed:',
      'the browser network backstop is off; page actions and App hosts will fail closed until the rules install:', lastError);
    try { audit?.({ type: 'denylist_net_guard_failed', details: { reason: lastError } }); }
    catch {}
  };

  const apply = async () => {
    if (startupError) return;
    try {
      const update = buildUpdate({
        patterns: getPatterns() ?? [],
        tabIds: getTabIds() ?? [],
        initiatorDomains: getInitiatorDomains() ?? [],
      });
      const denylistRule = /** @type {any} */ (update.addRules.find((candidate) =>
        candidate.priority === 1 && Array.isArray(candidate.condition?.requestDomains)));
      const tabRule = denylistRule ?? update.addRules.find((candidate) =>
        Array.isArray(candidate.condition?.tabIds));
      const fingerprint = JSON.stringify(update.addRules);
      if (applied === fingerprint) return;
      await dnr.updateSessionRules(update);
      applied = fingerprint;
      lastError = null;
      ruleDomains = denylistRule ? denylistRule.condition.requestDomains.length : 0;
      ruleTabs = tabRule ? [...tabRule.condition.tabIds] : [];
    } catch (error) { recordFailure(error); }
  };

  return {
    /** @returns {Promise<void>} */
    sync() {
      if (!supported) return queue;
      queue = queue.then(() => started).then(apply, apply);
      return queue;
    },

    /** @param {{ok?:boolean,error?:string}} [result] */
    start(result = { ok: true }) {
      if (result.ok === false) startupError = result.error || 'custody_hydration_failed';
      start?.();
      start = null;
      return queue;
    },

    /** @param {unknown} error */
    fail(error) {
      custodyError = error instanceof Error ? error.message : String(error);
      recordFailure(error);
    },

    recover() {
      custodyError = null;
      applied = null;
    },

    supported: () => supported,
    state: () => ({
      supported, domains: ruleDomains, tabs: [...ruleTabs],
      lastError: startupError || custodyError || lastError,
      startupError,
    }),
  };
};
