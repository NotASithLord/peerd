// @ts-check
// background/denylist-net-guard.js — the imperative shell around the denylist's
// declarativeNetRequest backstop (peerd-egress/denylist/dnr-rules.js holds the
// pure rule math; read the why there).
//
// One job: keep exactly one session-scoped DNR rule in sync with
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
//      which interleave freely; overlapping updateSessionRules calls on one
//      rule id would race to a nondeterministic winner. Every sync queues
//      behind the last.
//   3. NEVER FATAL. DNR support varies (Firefox's implementation is partial,
//      and `tabIds` conditions are session-rule-only), so an unsupported or
//      failing API must leave the JS gates — which are the actual
//      specification — running exactly as before. Failures log once per
//      distinct message and audit once; they never reject into a caller and
//      never permanently disarm the guard.

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
 */
export const makeDenylistNetGuard = ({ dnr, getPatterns, getTabIds, buildUpdate, audit, console: log = console }) => {
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

  const apply = async () => {
    const update = buildUpdate({ patterns: getPatterns() ?? [], tabIds: getTabIds() ?? [] });
    const rule = /** @type {any} */ (update.addRules[0]);
    // why fingerprint rather than always call: tab lifecycle churn (open, close,
    // re-bind, re-bind again) fires many syncs that describe the SAME rule, and
    // updateSessionRules is a real IPC round trip. Cleared on failure so a retry
    // is never skipped.
    const fingerprint = rule
      ? `${rule.condition.requestDomains.join(',')}|${rule.condition.tabIds.join(',')}`
      : '';
    if (applied === fingerprint) return;
    try {
      await dnr.updateSessionRules(update);
      applied = fingerprint;
      lastError = null;
      ruleDomains = rule ? rule.condition.requestDomains.length : 0;
      ruleTabs = rule ? [...rule.condition.tabIds] : [];
    } catch (e) {
      applied = null;
      lastError = e instanceof Error ? e.message : String(e);
      if (!loggedFailures.has(lastError)) {
        loggedFailures.add(lastError);
        log.warn('[denylist-net-guard] session rule update failed —',
          'the network backstop is off; the denylist gates in the dispatcher and webFetch still apply:', lastError);
        try { audit?.({ type: 'denylist_net_guard_failed', details: { reason: lastError } }); }
        catch { /* audit is best-effort; never let it mask the original failure */ }
      }
    }
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
      queue = queue.then(apply, apply);
      return queue;
    },

    /** Is a usable DNR session-rule API present? (false → this guard is a no-op.) */
    supported: () => supported,

    /** Diagnostics for the audit/inspect surfaces. No authority. */
    state: () => ({
      supported, domains: ruleDomains, tabs: [...ruleTabs], lastError,
    }),
  };
};
