// @ts-check

import {
  APP_EGRESS_REGEX,
  APP_EGRESS_RULE_ID,
  CHROME_DNR_RESOURCE_TYPES,
  DENYLIST_RESOURCE_TYPES,
  denylistSessionRuleUpdate,
  PRIVATE_NETWORK_RULE_IDS,
} from '/peerd-egress/kernel-network.js';
import {
  browserNetworkGuardUnavailableResult,
  classifyBrowserAutomationTarget,
  knownIdpDomains,
} from '/peerd-runtime/kernel-network.js';
import { createBrowserNetworkCustody } from './browser-network-custody.js';
import { createBrowserOriginCustody } from './browser-origin-custody.js';
import { makeDenylistNetGuard } from './denylist-net-guard.js';
import { makeDrivenPopupGuard, popupSourceState } from './driven-popup-guard.js';
import { makeStartupPopupNetworkGuard } from './startup-popup-network-guard.js';

const GUARDED_TABS_KEY = 'guardedBrowserTabIds';
const GUARDED_ORIGINS_KEY = 'guardedBrowserOriginDomains';
const CHILD_QUARANTINE_RULE_OFFSET = 200;
const CHILD_QUARANTINE_SUBRESOURCE_RULE_OFFSET = 300;
const CHILD_QUARANTINE_NAVIGATION_RULE_ID = 203;
const CHILD_QUARANTINE_POLICY_RULE_IDS = Object.freeze([1, 2]);
const CHILD_QUARANTINE_TRANSITION_RULE_MIN = 10_000;
const CHILD_QUARANTINE_TRANSITION_RULE_MAX = 13_999;

/** @param {unknown} cause */
const reason = (cause) => cause instanceof Error ? cause.message : String(cause);
/** @param {unknown} value */
const integerIds = (value) => Array.isArray(value)
  ? value.filter((id) => Number.isInteger(id) && id >= 0) : [];

/** @param {Record<string,any>} deps */
export const createKernelBrowserNetworkRuntime = (deps) =>
  createKernelBrowserNetworkAuthority(/** @type {any} */ ({
    ...deps,
    buildRuleUpdate: denylistSessionRuleUpdate,
    privateNetworkRuleIds: PRIVATE_NETWORK_RULE_IDS,
    resourceTypes: deps.firefox ? DENYLIST_RESOURCE_TYPES : CHROME_DNR_RESOURCE_TYPES,
    idpExemptDomains: knownIdpDomains(),
    classifyTarget: classifyBrowserAutomationTarget,
    unavailableResult: browserNetworkGuardUnavailableResult,
  }));

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {any} deps.dnr
 * @param {boolean} [deps.firefox]
 * @param {{sessionGet:(key:string)=>Promise<any>,sessionSet:(key:string,value:any)=>Promise<any>}} deps.sessionCache
 * @param {{ready:()=>Promise<{ok?:boolean,error?:string}>,patterns:()=>readonly string[],blocks:(hostname:string)=>boolean}} deps.denylist
 * @param {(input:{patterns:readonly string[],tabIds:readonly number[],initiatorDomains:readonly string[],resourceTypes:readonly string[],exemptDomains:readonly string[],appTabIds:readonly number[]})=>{removeRuleIds:number[],addRules:any[]}} deps.buildRuleUpdate
 * @param {readonly number[]} deps.privateNetworkRuleIds
 * @param {readonly string[]} deps.resourceTypes
 * @param {readonly string[]} deps.idpExemptDomains
 * @param {()=>readonly number[]} deps.getExternalTabIds
 * @param {()=>readonly number[]} deps.getAppTabIds
 * @param {(tabId:number)=>boolean} deps.isWebActorTab
 * @param {()=>Promise<unknown>} [deps.ensureExternalReady]
 * @param {Promise<unknown>} [deps.webActorReady]
 * @param {Promise<unknown>} [deps.engineReady]
 * @param {(url:string)=>{allowed:boolean,reason?:string}} deps.classifyTarget
 * @param {(reason:'network_guard_unsupported'|'network_guard_install_failed')=>any} deps.unavailableResult
 * @param {(entry:{type:string,details?:Record<string,any>})=>unknown} [deps.audit]
 * @param {(event:any)=>unknown} [deps.onPopupBlocked]
 * @param {(event:any)=>unknown} [deps.onPopupFailed]
 * @param {(event:any)=>unknown} [deps.onPopupBlank]
 * @param {(event:any)=>unknown} [deps.onPopupGuarded]
 * @param {ReturnType<typeof makeStartupPopupNetworkGuard>} [deps.startupGuard]
 * @param {number} [deps.quarantineTimeoutMs]
 * @param {number} [deps.quarantineClassificationMs]
 * @param {number} [deps.quarantineRetryMs]
 */
export const createKernelBrowserNetworkAuthority = ({
  browser,
  dnr,
  firefox = false,
  sessionCache,
  denylist,
  buildRuleUpdate,
  privateNetworkRuleIds,
  resourceTypes,
  idpExemptDomains,
  getExternalTabIds,
  getAppTabIds,
  isWebActorTab,
  ensureExternalReady,
  webActorReady,
  engineReady,
  classifyTarget,
  unavailableResult,
  audit,
  onPopupBlocked = () => {},
  onPopupFailed = () => {},
  onPopupBlank = () => {},
  onPopupGuarded = () => {},
  startupGuard: injectedStartupGuard,
  quarantineTimeoutMs = 1_000,
  quarantineClassificationMs = 250,
  quarantineRetryMs = 250,
}) => {
  if (!browser?.tabs || !sessionCache || !denylist
      || typeof buildRuleUpdate !== 'function'
      || !Array.isArray(privateNetworkRuleIds) || !Array.isArray(resourceTypes)
      || !Array.isArray(idpExemptDomains) || typeof getExternalTabIds !== 'function'
      || typeof getAppTabIds !== 'function' || typeof isWebActorTab !== 'function'
      || typeof classifyTarget !== 'function' || typeof unavailableResult !== 'function') {
    throw new TypeError('kernel-browser-network-authority-config-invalid');
  }

  const startupGuard = injectedStartupGuard
    ?? makeStartupPopupNetworkGuard(dnr, privateNetworkRuleIds);
  const custody = createBrowserNetworkCustody({
    persist: (tabIds) => sessionCache.sessionSet(GUARDED_TABS_KEY, tabIds),
  });
  const unprovenDurable = new Set();
  const startupCandidates = new Set();
  /** @type {()=>number[]} */
  const drivenTabIds = () => [...new Set([
    ...integerIds(getExternalTabIds()),
    ...integerIds(startupGuard.tabIds?.() ?? []),
    ...custody.tabIds().filter((tabId) => !unprovenDurable.has(tabId)
      && !startupCandidates.has(tabId)),
  ])];
  const origins = createBrowserOriginCustody({
    isGuarded: (tabId) => drivenTabIds().includes(tabId),
    allowUrl: (url) => classifyTarget(url).allowed,
    persist: (rows) => sessionCache.sessionSet(GUARDED_ORIGINS_KEY, rows),
    deferUntilHydrated: true,
  });
  const tabsReady = Promise.resolve(sessionCache.sessionGet(GUARDED_TABS_KEY))
    .then(async (ids) => {
      const restored = integerIds(ids);
      for (const tabId of restored) unprovenDurable.add(tabId);
      await custody.hydrate(restored);
      return /** @type {const} */ ({ ok: true });
    })
    .catch((cause) => ({ ok: false, error: `guarded_tabs_hydration_failed: ${reason(cause)}` }));
  const originsReady = tabsReady.then(async (tabsResult) => {
    if (!tabsResult.ok) {
      // why: settle origin waiters even though the aggregate authority stays closed.
      await origins.hydrate([]).catch(() => {});
      return tabsResult;
    }
    try {
      const rows = await sessionCache.sessionGet(GUARDED_ORIGINS_KEY);
      // why: a genuinely absent first-run snapshot is empty. Present corrupt or
      // partial custody is unknown authority and must leave surviving DNR rules untouched.
      await origins.hydrate(rows == null ? [] : rows);
      return /** @type {const} */ ({ ok: true });
    } catch (cause) {
      return { ok: false, error: `guarded_origins_hydration_failed: ${reason(cause)}` };
    }
  });

  const netGuard = makeDenylistNetGuard({
    dnr,
    getPatterns: denylist.patterns,
    getTabIds: drivenTabIds,
    getInitiatorDomains: origins.domains,
    buildUpdate: (input) => buildRuleUpdate({
      ...input,
      resourceTypes,
      exemptDomains: idpExemptDomains,
      appTabIds: integerIds(getAppTabIds()),
    }),
    audit,
    deferUntilStarted: true,
  });
  const unavailable = () => unavailableResult(
    netGuard.state().supported ? 'network_guard_install_failed' : 'network_guard_unsupported',
  );

  /** @type {Map<number,{tabId:number,token:string}>} */
  const startupLeases = new Map();
  let startupOpen = true;
  let startupQueue = Promise.resolve();
  /** @type {Promise<{ok?:boolean,error?:string}>|null} */ let starting = null;
  const quarantineRuleIds = [
    CHILD_QUARANTINE_NAVIGATION_RULE_ID,
    2 + CHILD_QUARANTINE_RULE_OFFSET,
    ...[...CHILD_QUARANTINE_POLICY_RULE_IDS, ...privateNetworkRuleIds].map(
      (ruleId) => ruleId + CHILD_QUARANTINE_SUBRESOURCE_RULE_OFFSET,
    ),
  ];
  /** @type {any[]} */ let quarantineTemplates = [];
  const quarantineExcluded = new Set();
  /** @type {Map<number,{ruleId:number,token:symbol}>} */
  const quarantineTransitions = new Map();
  const quarantineTransitionRuleIds = new Set();
  /** @type {Map<number,{url:string,token:symbol,sourceTabId:number|undefined}>} */
  const quarantineResumes = new Map();
  /** @type {Map<number,{token:symbol,url:string,sourceTabId:number|undefined,timer:ReturnType<typeof setTimeout>|null}>} */
  const quarantineCandidates = new Map();
  /** @type {Promise<any>|null} */ let quarantineInstalling = null;
  /** @type {Promise<true|false|'removed'>|null} */ let quarantineRestoring = null;
  /** @type {Promise<boolean>|null} */ let quarantineRemoving = null;
  let quarantineDnrLane = Promise.resolve();
  let quarantineActive = false;
  let quarantineStateRead = false;
  let quarantineRevision = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */ let quarantineRemoveRetry = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let quarantineResumeRetry = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let quarantineUpdateRetry = null;
  const quarantineBounded = (/** @type {Promise<any>} */ operation,
    /** @type {string} */ code) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), Math.max(1, quarantineTimeoutMs));
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); },
    );
  });
  const quarantineDnr = (/** @type {()=>Promise<any>} */ operation) => {
    const next = quarantineDnrLane.then(operation, operation);
    quarantineDnrLane = next.then(() => {}, () => {});
    return next;
  };
  const quarantineRead = (/** @type {string} */ code) => quarantineDnr(() =>
    quarantineBounded(Promise.resolve(dnr.getSessionRules()), code));
  const externalReady = () => typeof ensureExternalReady === 'function'
    ? ensureExternalReady() : Promise.all([webActorReady, engineReady]);
  /** @type {Promise<{ok:boolean,error?:string}>|null} */ let externalProjectionLoading = null;
  const reconcileExternalProjection = () => {
    if (externalProjectionLoading) return externalProjectionLoading;
    const operation = Promise.resolve().then(externalReady)
      .then(async () => {
        const authoritative = new Set(integerIds(getExternalTabIds()));
        for (const tabId of custody.durableTabIds()) {
          if (!authoritative.has(tabId)) {
            await origins.close(tabId).catch(() => {});
            await custody.close(tabId).catch(() => {});
          }
          unprovenDurable.delete(tabId);
        }
        return /** @type {const} */ ({ ok: true });
      }, (cause) => ({
        ok: false, error: `external_tab_hydration_failed: ${reason(cause)}`,
      }));
    externalProjectionLoading = operation;
    void operation.finally(() => {
      if (externalProjectionLoading === operation) externalProjectionLoading = null;
    }).catch(() => {});
    return operation;
  };

  const ensure = async (
    /** @type {number} */ tabId,
    /** @type {string|undefined} */ targetUrl,
    /** @type {{tabId:number,token:string}|undefined} */ requiredLease = undefined,
  ) => {
    await start();
    if (netGuard.state().lastError) return unavailableResult('network_guard_install_failed');
    /** @type {{tabId:number,token:string,added:boolean}} */ let claim;
    try {
      claim = await custody.claimDurable(tabId, requiredLease);
    } catch {
      await netGuard.sync();
      return unavailableResult('network_guard_install_failed');
    }
    let receipt = null;
    try {
      receipt = targetUrl ? await origins.retain(tabId, targetUrl) : null;
    } catch {
      if (claim.added) await custody.removeDurable(tabId).catch(() => {});
      await netGuard.sync();
      return unavailableResult('network_guard_install_failed');
    }
    await netGuard.sync();
    const state = netGuard.state();
    if (state.supported && !state.lastError && custody.isDurableClaimValid(claim)) {
      return { ok: true };
    }
    if (!custody.isDurableClaimValid(claim)) {
      await netGuard.sync();
      return unavailableResult('network_guard_install_failed');
    }
    if (claim.added) await custody.removeDurable(tabId).catch(() => {});
    await origins.rollback(receipt).catch(() => {});
    if (claim.added) await origins.close(tabId).catch(() => {});
    await netGuard.sync();
    return unavailable();
  };

  const acquireLease = async (/** @type {number} */ tabId) => {
    await start();
    if (netGuard.state().lastError) return unavailableResult('network_guard_install_failed');
    const lease = custody.acquire(tabId);
    await netGuard.sync();
    const state = netGuard.state();
    if (state.supported && !state.lastError && custody.isLeaseValid(lease)) {
      return { ok: true, lease };
    }
    custody.release(lease);
    await netGuard.sync();
    return unavailable();
  };

  const releaseLease = async (/** @type {{tabId?:number,token?:string}|undefined} */ lease) => {
    if (!lease || typeof lease.tabId !== 'number' || typeof lease.token !== 'string') return;
    await start();
    if (!custody.release(lease)) return;
    origins.domains();
    await netGuard.sync();
  };

  const updateOrigin = async (
    /** @type {number} */ tabId,
    /** @type {string|undefined} */ url,
  ) => {
    await start();
    if (!url || !drivenTabIds().includes(tabId)) {
      return unavailableResult('network_guard_install_failed');
    }
    const receipt = await origins.retain(tabId, url).catch(() => null);
    if (!receipt) return unavailableResult('network_guard_install_failed');
    await netGuard.sync();
    const state = netGuard.state();
    if (state.supported && !state.lastError) return { ok: true };
    await origins.rollback(receipt).catch(() => {});
    return unavailable();
  };

  const adoptStartup = (/** @type {number} */ sourceTabId, /** @type {number} */ childTabId) => {
    if (!startupOpen) return Promise.resolve(false);
    startupCandidates.add(childTabId);
    const lease = custody.acquire(childTabId);
    startupLeases.set(childTabId, lease);
    const operation = startupQueue.then(async () => {
      const tabsResult = await tabsReady;
      if (!tabsResult.ok) return false;
      if (!custody.isLeaseValid(lease)) return false;
      const sourceOwned = custody.hasDurable(sourceTabId) || isWebActorTab(sourceTabId);
      if (!sourceOwned) return false;
      const adopted = await startupGuard.adopt(sourceTabId, childTabId);
      return adopted && custody.isLeaseValid(lease);
    }, () => false);
    const settled = operation.then(async (adopted) => {
      if (adopted) return true;
      if (startupLeases.get(childTabId) === lease) startupLeases.delete(childTabId);
      startupCandidates.delete(childTabId);
      custody.release(lease);
      await startupGuard.release(childTabId);
      return false;
    }, async () => {
      if (startupLeases.get(childTabId) === lease) startupLeases.delete(childTabId);
      startupCandidates.delete(childTabId);
      custody.release(lease);
      await startupGuard.release(childTabId);
      return false;
    });
    startupQueue = settled.then(() => {}, () => {});
    return settled;
  };

  const adopt = async (/** @type {number} */ sourceTabId, /** @type {number} */ childTabId) => {
    await start();
    const startupLease = startupLeases.get(childTabId);
    const releaseStartup = () => {
      if (!startupLease) return;
      if (startupLeases.get(childTabId) === startupLease) startupLeases.delete(childTabId);
      startupCandidates.delete(childTabId);
      custody.release(startupLease);
    };
    if (startupLease && !custody.isLeaseValid(startupLease)) {
      releaseStartup();
      await startupGuard.release(childTabId);
      await netGuard.sync();
      return { ok: true, adopted: false };
    }
    if (netGuard.state().lastError) {
      releaseStartup();
      await startupGuard.release(childTabId);
      await netGuard.sync();
      return unavailableResult('network_guard_install_failed');
    }
    if (!drivenTabIds().includes(sourceTabId) && !isWebActorTab(sourceTabId)) {
      releaseStartup();
      await startupGuard.release(childTabId);
      await netGuard.sync();
      const state = netGuard.state();
      return { ok: !state.supported || !state.lastError, adopted: false };
    }
    const child = await browser.tabs.get(childTabId).catch(() => null);
    if (!child || (typeof child.openerTabId === 'number'
        && child.openerTabId !== sourceTabId)) {
      releaseStartup();
      await startupGuard.release(childTabId);
      await netGuard.sync();
      return { ok: true, adopted: false };
    }
    const result = await ensure(childTabId, child?.url, startupLease);
    releaseStartup();
    const current = result.ok ? await browser.tabs.get(childTabId).catch(() => null) : null;
    const currentOwned = current != null && (typeof current.openerTabId !== 'number'
      || current.openerTabId === sourceTabId);
    if (result.ok && currentOwned) {
      await startupGuard.handoff(childTabId);
      await exactChildGuarded(childTabId);
    }
    else {
      await startupGuard.release(childTabId);
      if (result.ok) {
        await origins.close(childTabId).catch(() => {});
        await custody.close(childTabId).catch(() => {});
      }
      await netGuard.sync();
    }
    return { ...result, adopted: result.ok && currentOwned };
  };

  const classifyPopup = (/** @type {string} */ url) => {
    const verdict = classifyTarget(url);
    if (!verdict.allowed) return verdict;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const idpExempt = idpExemptDomains.some((domain) =>
        hostname === domain || hostname.endsWith(`.${domain}`));
      return !idpExempt && denylist.blocks(hostname)
        ? { allowed: false, reason: 'sensitive_site' } : { allowed: true };
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }
  };
  const heldNavigationTarget = (/** @type {string} */ url) => {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); }
    catch { return false; }
  };
  const quarantineRulesFrom = (/** @type {any[]} */ rules) => quarantineRuleIds
    .map((ruleId) => rules.find((rule) => rule?.id === ruleId)).filter(Boolean);
  /** @returns {any} */
  const stable = (/** @type {any} */ value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  const quarantineSourceRules = (/** @type {any[]} */ rules) => {
    const optional = CHILD_QUARANTINE_POLICY_RULE_IDS.flatMap((ruleId) => {
      const rule = rules.find((candidate) => candidate?.id === ruleId);
      return rule ? [rule] : [];
    });
    const mandatory = privateNetworkRuleIds.map((ruleId) =>
      rules.find((rule) => rule?.id === ruleId)).filter(Boolean);
    if (mandatory.length !== privateNetworkRuleIds.length) return [];
    const source = [...optional, ...mandatory];
    return source.every((rule) => Array.isArray(rule?.condition?.tabIds)
      && rule.condition.tabIds.length > 0) ? source : [];
  };
  const quarantineTemplatesFrom = (/** @type {any[]} */ source) => {
    const navigation = {
      id: CHILD_QUARANTINE_NAVIGATION_RULE_ID,
      priority: 1,
      action: { type: 'block' },
      condition: {
        regexFilter: '^https?://', isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame'],
      },
    };
    return [navigation, ...source.flatMap((rule) => {
      const { tabIds: _tabIds, excludedTabIds: _excludedTabIds,
        resourceTypes: sourceTypes, ...condition } = rule.condition;
      const types = Array.isArray(sourceTypes) ? sourceTypes : [];
      const main = rule.id === 2 && types.includes('main_frame') ? [{
        ...rule,
        id: rule.id + CHILD_QUARANTINE_RULE_OFFSET,
        condition: { ...condition, resourceTypes: ['main_frame'] },
      }] : [];
      const childTypes = types.filter((type) => type !== 'main_frame');
      return childTypes.length === 0 ? main : [...main, {
        ...rule,
        id: rule.id + CHILD_QUARANTINE_SUBRESOURCE_RULE_OFFSET,
        condition: { ...condition, resourceTypes: childTypes },
      }];
    })];
  };
  const transitionRule = (/** @type {number} */ ruleId, /** @type {number} */ tabId) => ({
    id: ruleId,
    priority: 10,
    action: { type: 'block' },
    condition: {
      tabIds: [tabId], regexFilter: '^(?:https?|wss?)://', isUrlFilterCaseSensitive: false,
      resourceTypes: [...resourceTypes],
    },
  });
  const transitionRulesFrom = (/** @type {any[]} */ rules) => {
    /** @type {Map<number,{ruleId:number,token:symbol}>} */ const transitions = new Map();
    for (const rule of rules) {
      if (!Number.isInteger(rule?.id) || rule.id < CHILD_QUARANTINE_TRANSITION_RULE_MIN
          || rule.id > CHILD_QUARANTINE_TRANSITION_RULE_MAX) continue;
      quarantineTransitionRuleIds.add(rule.id);
      const tabId = rule?.condition?.tabIds?.[0];
      if (!Number.isInteger(tabId) || tabId < 0 || rule.condition.tabIds.length !== 1
          || transitions.has(tabId)
          || JSON.stringify(stable(rule)) !== JSON.stringify(stable(
            transitionRule(rule.id, tabId),
          ))) {
        throw new Error('browser-child-quarantine-transition-invalid');
      }
      transitions.set(tabId, { ruleId: rule.id, token: Symbol(`transition:${tabId}`) });
    }
    return transitions;
  };
  const allocateTransition = (/** @type {number} */ tabId, /** @type {symbol} */ token) => {
    const current = quarantineTransitions.get(tabId);
    if (current) return current;
    for (let ruleId = CHILD_QUARANTINE_TRANSITION_RULE_MIN;
      ruleId <= CHILD_QUARANTINE_TRANSITION_RULE_MAX; ruleId += 1) {
      if (quarantineTransitionRuleIds.has(ruleId)) continue;
      const transition = { ruleId, token };
      quarantineTransitionRuleIds.add(ruleId);
      quarantineTransitions.set(tabId, transition);
      return transition;
    }
    return null;
  };
  const hydrateQuarantine = (/** @type {any[]} */ rules) => {
    const current = quarantineRulesFrom(rules);
    if (current.length === 0) return false;
    const source = quarantineSourceRules(rules);
    const templates = quarantineTemplatesFrom(source);
    const expectedIds = templates.map((rule) => rule.id);
    if (source.length === 0 || current.length !== expectedIds.length
        || current.some((rule) => !expectedIds.includes(rule.id)
      || Array.isArray(rule?.condition?.tabIds)
      || !Array.isArray(rule?.condition?.excludedTabIds))) {
      throw new Error('browser-child-quarantine-invalid');
    }
    const excluded = [...current[0].condition.excludedTabIds].sort((a, b) => a - b);
    if (excluded.some((tabId) => !Number.isInteger(tabId) || tabId < -1)
        || !excluded.includes(-1)
        || current.some((rule) => JSON.stringify(
          [...rule.condition.excludedTabIds].sort((a, b) => a - b),
        ) !== JSON.stringify(excluded))) {
      throw new Error('browser-child-quarantine-exclusions-invalid');
    }
    for (const rule of current) {
      const expected = templates.find((candidate) => candidate.id === rule.id);
      if (!expected) throw new Error('browser-child-quarantine-source-invalid');
      const { excludedTabIds: _excludedTabIds, ...condition } = rule.condition;
      if (Object.keys(rule).sort().join(',') !== 'action,condition,id,priority'
          || Object.keys(rule.action ?? {}).sort().join(',') !== Object.keys(
            expected.action ?? {},
          ).sort().join(',')
          || JSON.stringify(stable({ ...rule, condition }))
            !== JSON.stringify(stable(expected))) {
        throw new Error('browser-child-quarantine-shape-invalid');
      }
    }
    quarantineExcluded.clear();
    for (const tabId of excluded) quarantineExcluded.add(tabId);
    quarantineTemplates = current.map((rule) => {
      const { excludedTabIds: _excludedTabIds, ...condition } = rule.condition;
      return { ...rule, condition };
    });
    const transitions = transitionRulesFrom(rules);
    quarantineTransitions.clear();
    for (const [tabId, transition] of transitions) {
      quarantineTransitions.set(tabId, transition);
    }
    quarantineActive = true;
    quarantineStateRead = true;
    quarantineRevision += 1;
    return true;
  };
  const stableQuarantineRules = async (/** @type {string} */ code) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = quarantineRevision;
      const rules = /** @type {any[]} */ (await quarantineRead(code));
      if (revision === quarantineRevision) return rules;
    }
    throw new Error('browser-child-quarantine-state-changed');
  };
  const verifyQuarantine = async (/** @type {string} */ code) =>
    hydrateQuarantine(await stableQuarantineRules(code));
  const quarantineUpdate = async () => {
    if (quarantineRemoving) await quarantineRemoving;
    if (!quarantineActive || quarantineTemplates.length < privateNetworkRuleIds.length) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let projectedRevision = quarantineRevision;
      await quarantineBounded(quarantineDnr(async () => {
        projectedRevision = quarantineRevision;
        const excludedTabIds = [...quarantineExcluded].sort((left, right) => left - right);
        const addRules = quarantineTemplates.map((rule) => ({
          ...rule, condition: { ...rule.condition, excludedTabIds },
        }));
        for (const [tabId, transition] of quarantineTransitions) {
          addRules.push(transitionRule(transition.ruleId, tabId));
        }
        await dnr.updateSessionRules({
          removeRuleIds: [...quarantineRuleIds, ...quarantineTransitionRuleIds], addRules,
        });
      }), 'browser-child-quarantine-update-timeout');
      if (quarantineRemoving) {
        await quarantineRemoving;
        return;
      }
      if (projectedRevision === quarantineRevision) return;
    }
    throw new Error('browser-child-quarantine-state-changed');
  };
  const refreshQuarantine = async () => {
    if (quarantineRemoving) await quarantineRemoving;
    if (!quarantineActive) return;
    const rules = await stableQuarantineRules(
      'browser-child-quarantine-refresh-read-timeout',
    );
    const source = quarantineSourceRules(rules);
    if (source.length === 0) {
      if (!await quarantineRemove()) retryQuarantineRemove();
      return;
    }
    quarantineTemplates = quarantineTemplatesFrom(source);
    quarantineRevision += 1;
    await quarantineUpdate();
    await verifyQuarantine('browser-child-quarantine-refresh-verify-timeout');
  };
  const quarantineRemove = () => {
    if (quarantineRemoving) return quarantineRemoving;
    const operation = (async () => {
      if (typeof dnr?.updateSessionRules !== 'function') return false;
      quarantineRevision += 1;
      const revision = quarantineRevision;
      await quarantineBounded(quarantineDnr(() => Promise.resolve(dnr.updateSessionRules({
        removeRuleIds: [...quarantineRuleIds, ...quarantineTransitionRuleIds], addRules: [],
      }))), 'browser-child-quarantine-remove-timeout');
      const current = /** @type {any[]} */ (await quarantineRead(
        'browser-child-quarantine-remove-verify-timeout',
      ));
      if (quarantineRulesFrom(current).length !== 0 || current.some((rule) =>
        quarantineTransitionRuleIds.has(rule?.id))) {
        throw new Error('browser-child-quarantine-remove-unverified');
      }
      if (revision !== quarantineRevision) {
        throw new Error('browser-child-quarantine-state-changed');
      }
      quarantineActive = false;
      quarantineStateRead = true;
      quarantineTemplates = [];
      quarantineExcluded.clear();
      quarantineTransitions.clear();
      quarantineTransitionRuleIds.clear();
      quarantineRevision += 1;
      if (quarantineUpdateRetry) clearTimeout(quarantineUpdateRetry);
      quarantineUpdateRetry = null;
      if (quarantineResumeRetry) clearTimeout(quarantineResumeRetry);
      quarantineResumeRetry = null;
      if (quarantineRemoveRetry) clearTimeout(quarantineRemoveRetry);
      quarantineRemoveRetry = null;
      for (const candidate of quarantineCandidates.values()) {
        if (candidate.timer) clearTimeout(candidate.timer);
      }
      for (const [tabId, candidate] of quarantineCandidates) {
        if (!quarantineResumes.has(tabId) && heldNavigationTarget(candidate.url)) {
          quarantineResumes.set(tabId, {
            url: candidate.url, token: candidate.token,
            sourceTabId: candidate.sourceTabId,
          });
        }
      }
      await resumeQuarantineTabs();
      for (const [tabId] of quarantineCandidates) {
        if (!quarantineResumes.has(tabId)) quarantineCandidates.delete(tabId);
      }
      return true;
    })().catch(() => {
      if (!quarantineActive) quarantineStateRead = false;
      return false;
    });
    quarantineRemoving = operation;
    void operation.finally(() => {
      if (quarantineRemoving === operation) quarantineRemoving = null;
    }).catch(() => {});
    return operation;
  };
  const resumeQuarantineTabs = async () => {
    const pending = [...quarantineResumes];
    let retry = false;
    await Promise.all(pending.map(async ([tabId, resume]) => {
      const candidate = quarantineCandidates.get(tabId);
      if (candidate?.token !== resume.token
          || candidate.sourceTabId !== resume.sourceTabId) return;
      const current = await browser.tabs.get(tabId).catch(() => null);
      const currentUrl = current?.pendingUrl || current?.url;
      const currentSource = typeof current?.openerTabId === 'number'
        ? current.openerTabId : undefined;
      if (!current || (typeof currentSource === 'number'
          && currentSource !== resume.sourceTabId)
          || currentUrl !== resume.url) {
        if (quarantineResumes.get(tabId)?.token === resume.token) {
          quarantineResumes.delete(tabId);
          quarantineCandidates.delete(tabId);
        }
        return;
      }
      try {
        await browser.tabs.update(tabId, { url: resume.url });
        if (quarantineResumes.get(tabId)?.token === resume.token) {
          quarantineResumes.delete(tabId);
          quarantineCandidates.delete(tabId);
        }
      } catch { retry = true; }
    }));
    if (retry) retryQuarantineResume();
  };
  const retryQuarantineResume = () => {
    if (quarantineResumeRetry) return;
    quarantineResumeRetry = setTimeout(() => {
      quarantineResumeRetry = null;
      void resumeQuarantineTabs();
    }, Math.max(1, quarantineRetryMs));
  };
  const retryQuarantineRemove = () => {
    if (quarantineRemoveRetry) return;
    quarantineRemoveRetry = setTimeout(() => {
      quarantineRemoveRetry = null;
      void quarantineRemove().then((removed) => {
        if (!removed && drivenTabIds().length === 0) retryQuarantineRemove();
      });
    }, Math.max(1, quarantineRetryMs));
  };
  const retryQuarantineUpdate = () => {
    if (quarantineUpdateRetry) return;
    quarantineUpdateRetry = setTimeout(() => {
      quarantineUpdateRetry = null;
      void quarantineUpdate().then(resumeQuarantineTabs).catch(retryQuarantineUpdate);
    }, Math.max(1, quarantineRetryMs));
  };
  const excludeQuarantineTab = async (/** @type {number} */ tabId,
    /** @type {string} */ resumeUrl = '', /** @type {boolean} */ exactGuarded = false) => {
    if (quarantineRemoving) await quarantineRemoving;
    if (!quarantineActive) return true;
    const candidate = quarantineCandidates.get(tabId);
    const alreadyExcluded = quarantineExcluded.has(tabId);
    let transition = quarantineTransitions.get(tabId);
    if (!transition && !exactGuarded && candidate && !alreadyExcluded) {
      transition = allocateTransition(tabId, candidate.token) ?? undefined;
      if (!transition) return false;
    }
    if (alreadyExcluded && !transition) return true;
    if (!alreadyExcluded) quarantineExcluded.add(tabId);
    quarantineRevision += 1;
    if (candidate && resumeUrl && heldNavigationTarget(resumeUrl)) {
      quarantineResumes.set(tabId, {
        url: resumeUrl, token: candidate.token, sourceTabId: candidate.sourceTabId,
      });
    }
    try { await quarantineUpdate(); }
    catch {
      retryQuarantineUpdate();
      return false;
    }
    const currentCandidate = quarantineCandidates.get(tabId);
    if (currentCandidate?.token !== candidate?.token) {
      if (quarantineResumes.get(tabId)?.token === candidate?.token) {
        quarantineResumes.delete(tabId);
      }
      return false;
    }
    if (transition) {
      quarantineTransitions.delete(tabId);
      quarantineRevision += 1;
      try {
        await quarantineUpdate();
        quarantineTransitionRuleIds.delete(transition.ruleId);
      }
      catch {
        quarantineTransitions.set(tabId, transition);
        quarantineRevision += 1;
        retryQuarantineUpdate();
        return false;
      }
    }
    if (currentCandidate?.timer) clearTimeout(currentCandidate.timer);
    if (!quarantineResumes.has(tabId)) quarantineCandidates.delete(tabId);
    await resumeQuarantineTabs();
    return true;
  };
  /** @returns {Promise<true|false|'removed'>} */
  const restoreQuarantine = async () => {
    if (quarantineRemoving) await quarantineRemoving;
    if (quarantineActive || quarantineInstalling) return true;
    if (quarantineRestoring) return quarantineRestoring;
    if (quarantineStateRead || typeof dnr?.getSessionRules !== 'function') return false;
    const operation = (async () => {
      /** @type {any[]|null} */ let rules = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          rules = /** @type {any[]} */ (await quarantineRead(
            'browser-child-quarantine-restore-read-timeout',
          ));
          break;
        } catch {
          if (attempt === 0) await new Promise((resolve) => setTimeout(
            resolve, Math.max(1, quarantineRetryMs),
          ));
        }
      }
      if (!rules) throw new Error('browser-child-quarantine-restore-unavailable');
      quarantineStateRead = true;
      if (quarantineRulesFrom(rules).length === 0) return false;
      await start();
      try {
        if (!await verifyQuarantine('browser-child-quarantine-restore-verify-timeout')) {
          throw new Error('browser-child-quarantine-restore-missing');
        }
      }
      catch {
        if (!await quarantineRemove()) {
          retryQuarantineRemove();
          throw new Error('browser-child-quarantine-restore-unavailable');
        }
        return 'removed';
      }
      if (drivenTabIds().length === 0) {
        if (!await quarantineRemove()) {
          retryQuarantineRemove();
          throw new Error('browser-child-quarantine-restore-unavailable');
        }
        return 'removed';
      }
      return true;
    })().catch(() => {
      quarantineStateRead = false;
      throw new Error('browser-child-quarantine-restore-unavailable');
    });
    quarantineRestoring = operation;
    void operation.finally(() => {
      if (quarantineRestoring === operation) quarantineRestoring = null;
    }).catch(() => {});
    return operation;
  };
  const observeQuarantineTab = async (/** @type {number} */ tabId,
    /** @type {number|undefined} */ sourceTabId, /** @type {unknown} */ rawUrl) => {
    if (quarantineRemoving) await quarantineRemoving;
    const url = typeof rawUrl === 'string' && rawUrl && rawUrl !== 'about:blank'
      ? rawUrl : '';
    const restored = !quarantineActive && !quarantineInstalling
      ? await restoreQuarantine() : true;
    if (restored !== true) {
      if (restored === 'removed' && url && heldNavigationTarget(url)) {
        await browser.tabs.update(tabId, { url }).catch(() => {});
      }
      return true;
    }
    if (quarantineInstalling) await quarantineInstalling;
    if (!quarantineActive
        || (quarantineExcluded.has(tabId) && !quarantineTransitions.has(tabId))) return true;
    const prior = quarantineCandidates.get(tabId);
    const candidateUrl = url || prior?.url || '';
    const sameCandidate = prior?.url === candidateUrl
      && prior.sourceTabId === sourceTabId;
    const token = sameCandidate ? prior.token : Symbol(`quarantine:${tabId}`);
    if (prior?.timer) clearTimeout(prior.timer);
    quarantineCandidates.set(tabId, {
      token, url: candidateUrl, sourceTabId, timer: null,
    });
    if (typeof sourceTabId === 'number') {
      if (drivenTabIds().includes(sourceTabId)) return true;
      return excludeQuarantineTab(tabId, candidateUrl);
    }
    const timer = setTimeout(() => {
      const current = quarantineCandidates.get(tabId);
      if (current?.token !== token) return;
      current.timer = null;
      void excludeQuarantineTab(tabId, current.url);
    }, Math.max(0, quarantineClassificationMs));
    quarantineCandidates.set(tabId, { token, url: candidateUrl, sourceTabId, timer });
    return true;
  };
  const exactChildGuarded = (/** @type {number} */ tabId) =>
    excludeQuarantineTab(tabId, '', true).catch(() => false);
  const removeQuarantineTab = async (/** @type {number} */ tabId) => {
    if (quarantineRemoving) await quarantineRemoving;
    const candidate = quarantineCandidates.get(tabId);
    if (candidate?.timer) clearTimeout(candidate.timer);
    quarantineCandidates.delete(tabId);
    quarantineResumes.delete(tabId);
    if (quarantineExcluded.delete(tabId)) {
      quarantineRevision += 1;
      try { await quarantineUpdate(); } catch { retryQuarantineUpdate(); }
    }
    const transition = quarantineTransitions.get(tabId);
    if (transition && !await browser.tabs.get(tabId).catch(() => null)) {
      quarantineTransitions.delete(tabId);
      quarantineRevision += 1;
      try {
        await quarantineUpdate();
        quarantineTransitionRuleIds.delete(transition.ruleId);
      }
      catch {
        quarantineTransitions.set(tabId, transition);
        quarantineRevision += 1;
        retryQuarantineUpdate();
      }
    }
    if (drivenTabIds().length === 0) {
      if (!await quarantineRemove()) retryQuarantineRemove();
    }
  };
  const armBrowserChildQuarantine = async (/** @type {number} */ sourceTabId) => {
    if (firefox) return { ok: true };
    if (typeof sourceTabId !== 'number' || !Number.isInteger(sourceTabId) || sourceTabId < 0) {
      return unavailableResult('network_guard_install_failed');
    }
    if (typeof dnr?.getSessionRules !== 'function'
        || typeof dnr?.updateSessionRules !== 'function') {
      return unavailableResult('network_guard_unsupported');
    }
    await start();
    const source = await browser.tabs.get(sourceTabId).catch(() => null);
    if (!source) return unavailableResult('network_guard_install_failed');
    const guarded = await ensure(sourceTabId, source.url);
    if (!guarded?.ok) return guarded;
    const sourceLease = custody.acquire(sourceTabId);
    const sourceFingerprint = {
      url: source.url, windowId: source.windowId, openerTabId: source.openerTabId,
    };
    const sourceStillOwned = async () => {
      if (!custody.isLeaseValid(sourceLease)
          || (!drivenTabIds().includes(sourceTabId) && !isWebActorTab(sourceTabId))) {
        return false;
      }
      const current = await browser.tabs.get(sourceTabId).catch(() => null);
      return current?.url === sourceFingerprint.url
        && current?.windowId === sourceFingerprint.windowId
        && current?.openerTabId === sourceFingerprint.openerTabId;
    };
    if (quarantineRemoving) await quarantineRemoving;
    if (quarantineRestoring) await quarantineRestoring.catch(() => false);
    if (quarantineActive) {
      const valid = await sourceStillOwned();
      custody.release(sourceLease);
      return valid ? { ok: true } : unavailableResult('network_guard_install_failed');
    }
    if (quarantineInstalling) {
      const installed = await quarantineInstalling;
      const valid = installed?.ok && await sourceStillOwned();
      custody.release(sourceLease);
      return valid ? installed : unavailableResult('network_guard_install_failed');
    }
    const operation = (async () => {
      const current = await stableQuarantineRules('browser-child-quarantine-read-timeout');
      let replacedInvalid = false;
      try {
        if (hydrateQuarantine(current)) {
          if (!await sourceStillOwned()) {
            throw new Error('browser-child-quarantine-source-stale');
          }
          return { ok: true };
        }
      } catch {
        replacedInvalid = true;
        if (!await quarantineRemove()) throw new Error('browser-child-quarantine-remove-failed');
      }
      const sourceRules = quarantineSourceRules(current).filter((rule) =>
        rule.condition.tabIds.includes(sourceTabId));
      if (sourceRules.filter((rule) => privateNetworkRuleIds.includes(rule.id)).length
          !== privateNetworkRuleIds.length) {
        throw new Error('browser-child-quarantine-source-proof-incomplete');
      }
      const existingTabs = await browser.tabs.query({});
      const excludedTabIds = [-1, ...existingTabs.flatMap((/** @type {any} */ tab) =>
        Number.isInteger(tab?.id) && tab.id >= 0 ? [tab.id] : [])];
      quarantineTemplates = quarantineTemplatesFrom(sourceRules);
      quarantineExcluded.clear();
      for (const tabId of excludedTabIds) quarantineExcluded.add(tabId);
      quarantineActive = true;
      quarantineStateRead = true;
      quarantineRevision += 1;
      const update = quarantineDnr(() => {
        const currentExcluded = [...quarantineExcluded]
          .sort((left, right) => left - right);
        return Promise.resolve(dnr.updateSessionRules({
          removeRuleIds: quarantineRuleIds,
          addRules: quarantineTemplates.map((rule) => ({
            ...rule, condition: { ...rule.condition, excludedTabIds: currentExcluded },
          })),
        }));
      });
      try {
        await quarantineBounded(update, 'browser-child-quarantine-install-timeout');
      } catch (cause) {
        quarantineActive = false;
        quarantineRevision += 1;
        // why: enqueue cleanup before a retry can read the timed-out install.
        void quarantineRemove().catch(() => {});
        throw cause;
      }
      if (!await verifyQuarantine('browser-child-quarantine-verify-timeout')) {
        throw new Error('browser-child-quarantine-install-missing');
      }
      if (!await sourceStillOwned()) {
        throw new Error('browser-child-quarantine-source-stale');
      }
      const afterInstallTabs = await browser.tabs.query({});
      await Promise.all(afterInstallTabs.map((/** @type {any} */ tab) =>
        typeof tab?.id === 'number' && !quarantineExcluded.has(tab.id)
          ? observeQuarantineTab(
            tab.id, tab.openerTabId, tab.pendingUrl || tab.url,
          ) : undefined));
      return replacedInvalid ? unavailableResult('network_guard_install_failed') : { ok: true };
    })().catch(async () => {
      if (!await quarantineRemove()) retryQuarantineRemove();
      return unavailableResult('network_guard_install_failed');
    });
    quarantineInstalling = operation;
    void operation.finally(() => {
      if (quarantineInstalling === operation) quarantineInstalling = null;
      custody.release(sourceLease);
    }).catch(() => {});
    return operation;
  };
  const popupGuard = makeDrivenPopupGuard({
    adoptFromSource: adopt,
    adoptUnknownFromSource: adoptStartup,
    sourceState: (sourceTabId) => isWebActorTab(sourceTabId)
      ? 'driven' : popupSourceState(sourceTabId, drivenTabIds(), bootAuthoritative),
    neutralize: (tabId) => browser.tabs.update(tabId, { url: 'about:blank' }),
    close: (tabId) => browser.tabs.remove(tabId),
    resume: (tabId, url) => browser.tabs.update(tabId, { url }),
    classifyTarget: classifyPopup,
    onBlocked: onPopupBlocked,
    onFailed: onPopupFailed,
    onBlank: onPopupBlank,
    onGuarded: (event) => {
      void exactChildGuarded(event.tabId);
      onPopupGuarded(event);
    },
  });
  let bootAuthoritative = false;

  const start = () => {
    starting ??= Promise.all([
      Promise.resolve().then(() => denylist.ready())
        .catch((cause) => ({ ok: false, error: `denylist_hydration_failed: ${reason(cause)}` })),
      tabsReady,
      originsReady,
    ]).then(async (results) => {
      let failed = results.find((result) => result?.ok === false);
      startupOpen = false;
      await startupQueue;
      await startupGuard.seal();
      if (!failed) {
        for (const tabId of drivenTabIds()) {
          const tab = await browser.tabs.get(tabId).catch(() => null);
          if (!tab) {
            failed = { ok: false, error: 'browser_origin_custody_hydration_failed' };
            break;
          }
          if (!tab.url) continue;
          try {
            await origins.retain(tabId, tab.url);
          } catch {
            failed = { ok: false, error: 'browser_origin_custody_hydration_failed' };
            break;
          }
        }
      }
      await netGuard.start(failed ?? { ok: true });
      if (!failed) {
        await netGuard.sync();
        bootAuthoritative = true;
        popupGuard.onBootReady();
      }
      return failed ?? { ok: true };
    });
    return starting;
  };

  const sync = async () => {
    await start();
    const result = await netGuard.sync();
    if (quarantineActive) await refreshQuarantine();
    return result;
  };
  const verifyAppNetwork = async (/** @type {number} */ tabId) => {
    if (!Number.isInteger(tabId) || tabId < 0
        || typeof dnr?.getSessionRules !== 'function') return false;
    try {
      const rules = await quarantineRead('kernel-browser-app-network-verify-timeout');
      const rule = rules.find((/** @type {any} */ candidate) =>
        candidate?.id === APP_EGRESS_RULE_ID);
      const actualTypes = rule?.condition?.resourceTypes;
      return rule?.action?.type === 'block'
        && rule?.condition?.regexFilter === APP_EGRESS_REGEX
        && Array.isArray(rule?.condition?.tabIds)
        && rule.condition.tabIds.includes(tabId)
        && Array.isArray(actualTypes)
        && actualTypes.length === resourceTypes.length
        && resourceTypes.every((type) => actualTypes.includes(type));
    } catch {
      return false;
    }
  };
  const syncStarted = () => starting ? netGuard.sync() : Promise.resolve();
  const onUpdated = (
    /** @type {number} */ tabId,
    /** @type {{url?:string}} */ changeInfo,
    /** @type {any} */ tab,
  ) => {
    const popup = popupGuard.onUpdated(tabId, changeInfo, tab);
    const quarantine = typeof changeInfo?.url === 'string'
      ? observeQuarantineTab(tabId, tab?.openerTabId, changeInfo.url)
      : Promise.resolve();
    if (typeof changeInfo?.url !== 'string' || !drivenTabIds().includes(tabId)) {
      return Promise.all([popup, quarantine]);
    }
    const retained = origins.retain(tabId, changeInfo.url, { keepOnPersistFailure: true })
      .then((receipt) => {
        if (receipt) netGuard.recover();
        return syncStarted();
      })
      .catch(async (cause) => {
        netGuard.fail(cause);
        await syncStarted();
      });
    return Promise.all([popup, quarantine, retained]);
  };
  const onRemoved = async (/** @type {number} */ tabId) => {
    popupGuard.onRemoved(tabId);
    startupLeases.delete(tabId);
    startupCandidates.delete(tabId);
    const quarantine = removeQuarantineTab(tabId);
    await Promise.all([
      startupGuard.release(tabId),
      origins.close(tabId),
      custody.close(tabId),
      quarantine,
    ]);
    await syncStarted();
  };
  const reconcile = async () => {
    await Promise.all([tabsReady, originsReady]);
    const tabs = await browser.tabs.query({});
    const live = new Map(tabs.flatMap((/** @type {any} */ tab) =>
      typeof tab?.id === 'number' ? [[tab.id, tab]] : []));
    for (const tabId of custody.tabIds()) {
      if (live.has(tabId)) continue;
      await origins.close(tabId).catch(() => {});
      await custody.close(tabId).catch(() => {});
    }
    if (starting) {
      await start();
      for (const tabId of drivenTabIds()) {
        const tab = live.get(tabId);
        if (!tab?.url) continue;
        try {
          const receipt = await origins.retain(tabId, tab.url, { keepOnPersistFailure: true });
          if (receipt) netGuard.recover();
        } catch (cause) {
          netGuard.fail(cause);
        }
      }
      await netGuard.sync();
    }
    if (quarantineActive) {
      if (quarantineRemoving) await quarantineRemoving;
      if (!quarantineActive) return status();
      let changed = false;
      for (const tabId of [...quarantineExcluded]) {
        if (live.has(tabId)) continue;
        quarantineExcluded.delete(tabId);
        changed = true;
      }
      if (changed) quarantineRevision += 1;
      for (const [tabId, candidate] of quarantineCandidates) {
        if (live.has(tabId)) continue;
        if (candidate.timer) clearTimeout(candidate.timer);
        quarantineCandidates.delete(tabId);
      }
      if (drivenTabIds().length === 0) {
        if (!await quarantineRemove()) retryQuarantineRemove();
      }
      else if (changed) await quarantineUpdate().catch(retryQuarantineUpdate);
    }
    return status();
  };
  const status = () => Object.freeze({
    ...netGuard.state(),
    ready: bootAuthoritative,
    tabs: Object.freeze(drivenTabIds()),
    origins: Object.freeze(origins.domains()),
  });

  return Object.freeze({
    ensureBrowserNetworkGuard: ensure,
    acquireBrowserNetworkGuardLease: acquireLease,
    releaseBrowserNetworkGuardLease: releaseLease,
    updateBrowserNetworkGuardOrigin: updateOrigin,
    syncDenylistNetwork: sync,
    verifyAppNetwork,
    armBrowserChildQuarantine,
    onCreated: (/** @type {any} */ tab) => Promise.all([
      popupGuard.onCreated(tab),
      typeof tab?.id === 'number'
        ? observeQuarantineTab(tab.id, tab.openerTabId, tab.pendingUrl || tab.url)
        : undefined,
    ]),
    onNavigationTarget: (/** @type {any} */ details) => Promise.all([
      popupGuard.onNavigationTarget(details),
      typeof details?.tabId === 'number'
        ? observeQuarantineTab(
          details.tabId, details.sourceTabId, details.url,
        ) : undefined,
    ]),
    onUpdated,
    onRemoved,
    reconcile,
    reconcileExternalProjection,
    ready: start,
    status,
  });
};
