// @ts-check
// background/denylist-net-guard.js — the imperative shell around the denylist's
// declarativeNetRequest backstop (peerd-egress/denylist/dnr-rules.js holds the
// pure rule math; read the why there).
//
// One job: keep the session-scoped DNR rule set in sync with
// (the live denylist × the tabs peerd is currently driving). Everything it
// needs is injected — the DNR namespace, the two live getters, audit — so the
// whole thing is exercisable from Bun with a fake API.
//
// Three properties this file is responsible for:
//
//   1. NEVER browser-wide. The rule is dropped entirely when the driven-tab
//      set is empty (dnr-rules refuses to build an unscoped rule), so a bug
//      here degrades to "no backstop", never to "the user can't reach their
//      bank".
//   2. SERIALIZED. Syncs fire from tab lifecycle events and denylist edits,
//      which interleave freely; overlapping updateSessionRules calls on the
//      owned rule set would race to a nondeterministic winner. Every sync queues
//      behind the last.
//   3. OBSERVABLE FAILURE. Sync itself never rejects and wedges a lifecycle
//      listener. It records API support and the last error so a page-affecting
//      tool can fail closed before navigation when the network floor is
//      unavailable. Non-browser JS policy gates continue to work.

// Imports nothing: the rule math (peerd-egress's denylistSessionRuleUpdate) is
// INJECTED like every other collaborator here, so this file stays Bun-importable
// — pulling /peerd-egress/index.js in transitively drags the browser polyfill,
// which throws outside an extension. Same posture as denylist-store.js.

/**
 * @param {Object} deps
 * @param {any} deps.dnr  the chrome.declarativeNetRequest namespace (or a fake)
 * @param {() => readonly string[]} deps.getPatterns  live denylist patterns
 * @param {() => readonly number[]} deps.getTabIds    tabs peerd is driving right now
 * @param {(input: { patterns: readonly string[], tabIds: readonly number[] }) =>
 *   { removeRuleIds: number[], addRules: any[] }} deps.buildUpdate
 *   peerd-egress's denylistSessionRuleUpdate (pure).
 * @param {(entry: { type: string, details?: Record<string, any> }) => any} [deps.audit]
 * @param {Pick<Console, 'warn'>} [deps.console]
 * @param {boolean} [deps.deferUntilStarted]
 */
export const makeDenylistNetGuard = ({
  dnr, getPatterns, getTabIds, buildUpdate, audit, console: log = console,
  deferUntilStarted = false,
}) => {
  const supported = typeof dnr?.updateSessionRules === 'function';
  /** Serialization lane — every sync chains onto the previous one. */
  let queue = Promise.resolve();
  /** Fingerprint of the last successfully applied rule; null = unknown/dirty. */
  let applied = /** @type {string | null} */ (null);
  /** Distinct failure messages already logged (so a stuck API isn't a log flood). */
  const loggedFailures = new Set();
  let lastError = /** @type {string | null} */ (null);
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
    catch { /* audit is best-effort; never let it mask the original failure */ }
  };

  const apply = async () => {
    // A failed custody snapshot is not permission to narrow surviving rules.
    // Keep them untouched and make new page actions fail closed.
    if (startupError) return;
    try {
      const update = buildUpdate({
        patterns: getPatterns() ?? [],
        tabIds: getTabIds() ?? [],
      });
      const denylistRule = /** @type {any} */ (update.addRules.find((candidate) =>
        candidate.priority === 1 && Array.isArray(candidate.condition?.requestDomains)));
      const tabRule = denylistRule ?? update.addRules.find((candidate) =>
        Array.isArray(candidate.condition?.tabIds));
      // why fingerprint rather than always call: tab lifecycle churn (open,
      // close, re-bind) fires many syncs that describe the SAME rule. Over the
      // WHOLE addRules array, not just the block rule: every owned rule matters.
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
    /**
     * Reconcile the rule with current state. Safe to call on every lifecycle
     * event, including ones that changed nothing. Resolves when this sync's
     * turn in the queue has run (callers that must not race a navigation can
     * await it); never rejects.
     * @returns {Promise<void>}
     */
    sync() {
      if (!supported) return queue;
      queue = queue.then(() => started).then(apply, apply);
      return queue;
    },

    /**
     * Release boot-deferred reconciles after every custody source is ready.
     * @param {{ ok?: boolean, error?: string }} [result]
     */
    start(result = { ok: true }) {
      if (result.ok === false) startupError = result.error || 'custody_hydration_failed';
      start?.();
      start = null;
      return queue;
    },

    /** Is a usable DNR session-rule API present? (false → this guard is a no-op.) */
    supported: () => supported,

    /** Diagnostics for the audit/inspect surfaces. No authority. */
    state: () => ({
      supported, domains: ruleDomains, tabs: [...ruleTabs],
      lastError: startupError || lastError,
      startupError,
    }),
  };
};
