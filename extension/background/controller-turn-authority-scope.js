// @ts-check

// Static host-only projection for the controller turn bridge. The semantic
// controller never receives this binding or chooses an authority class.

const BRIDGE_KEYS = Object.freeze([
  'permission', 'readAuthorityPermission', 'confirm', 'lifecycle',
  'lifecycleOwnerSessionId', 'lifecycleTurnId', 'lifecycleUserInitiated',
]);
const BROWSER_TARGET_KEYS = Object.freeze([
  'tabs', 'scripting', 'denylist', 'judgeLanding', 'noteTab',
  'noteLearnedOrigin', 'ensureBrowserNetworkGuard',
]);
/** @type {Readonly<Record<string, readonly string[]>>} */
const CLASS_KEYS = Object.freeze({
  local: Object.freeze(['completeGoalRun']),
  actor: Object.freeze(['session', 'inbound', 'actorAuthority']),
  pod: Object.freeze(['session', 'confirm', 'podClient', 'repositories']),
  repository: Object.freeze([
    'actorType', 'actorInstanceId', 'confirm',
    'repositories', 'appQuiescence', 'podClient', 'podRegistry', 'podTabTracker',
    'jsTabTracker',
  ]),
  vm: Object.freeze([
    'session', 'actorType', 'actorInstanceId', 'vm', 'vmRegistry', 'vmTabTracker', 'webFetch',
  ]),
  notebook: Object.freeze([
    'session', 'actorType', 'actorInstanceId',
    'jsClient', 'jsRegistry', 'jsTabTracker', 'repositories',
  ]),
  app: Object.freeze([
    'session', 'actorType', 'actorInstanceId',
    'appAgentCall', 'appClient', 'appRegistry', 'jsOffscreenClient', 'scriptRuns',
  ]),
  persistence: Object.freeze([
    'session', 'permission', 'readAuthorityPermission', 'confirm', 'memory', 'todoStore',
  ]),
  page: Object.freeze([
    'session', 'activeTab', 'actorType', 'backing', 'inbound',
    'permission', 'readAuthorityPermission', 'confirm',
    ...BROWSER_TARGET_KEYS,
    'acquireBrowserNetworkGuardLease', 'adoptWebTab', 'audit',
    'armBrowserChildQuarantine', 'browserChildQuarantineRequired',
    'cdpUnavailableReason', 'consumeBrowserChildPolicyNotice', 'debuggerPool', 'domRefs',
    'hasPendingBrowserChildPolicy', 'hintPullIn', 'jsOffscreenClient', 'onToolActivity',
    'releaseBrowserNetworkGuardLease', 'repinActiveTab', 'resultStore', 'scriptRuns',
    'siteCapture', 'updateBrowserNetworkGuardOrigin', 'waitForBrowserChildPolicyNotice',
    'webOffscreenClient', 'authorizeSignInOrigin', 'authorizeSignInExcursion',
    'revokeSignInExcursion',
  ]),
  resource: Object.freeze([
    'session', 'activeTab', 'actorType', 'actorInstanceId', 'backing', 'confirm',
    ...BROWSER_TARGET_KEYS,
    'docOffscreenClient', 'resultStore', 'webFetch', 'webOffscreenClient',
  ]),
  siteclient: Object.freeze([
    'session', 'activeTab', 'actorType', 'permission', 'readAuthorityPermission', 'confirm',
    ...BROWSER_TARGET_KEYS,
    'authorizeSiteClientOrigin', 'jsOffscreenClient', 'scriptRuns', 'siteCapture',
    'siteClients',
  ]),
  execution: Object.freeze([
    'session', 'inbound', 'confirm',
    'appClient', 'dweb', 'jsOffscreenClient', 'jsRegistry', 'jsTabTracker',
    'messageActor', 'podRegistry', 'podTabTracker', 'repositories', 'resultStore',
    'scriptRuns', 'toolUseId', 'vmRegistry', 'vmTabTracker',
  ]),
  editing: Object.freeze([
    'session', 'actorType', 'actorInstanceId',
    'appClient', 'appRegistry', 'jsClient', 'jsRegistry', 'repositories',
  ]),
  introspection: Object.freeze([
    'session',
    'actorIsolation', 'appRegistry', 'appTabTracker', 'denylist', 'idb', 'jsRegistry',
    'jsTabTracker', 'kv', 'listApiIntegrations', 'podRegistry', 'podTabTracker',
    'provider', 'skills', 'tabs', 'vault', 'vmRegistry', 'vmTabTracker',
  ]),
  schedule: Object.freeze([
    'session', 'permission', 'readAuthorityPermission', 'confirm',
    'scheduleAdd', 'scheduleList', 'scheduleRemove',
  ]),
  dweb: Object.freeze([
    'session', 'permission', 'readAuthorityPermission', 'confirm',
    'dweb', 'jsOffscreenClient', 'scriptRuns',
  ]),
});

/** @param {Record<string, any>} value @param {readonly string[]} keys */
const pick = (value, keys) => Object.freeze(Object.fromEntries(keys
  .filter((key) => Object.hasOwn(value, key))
  .map((key) => [key, value[key]])));

/**
 * Expose live membership without exposing the Set's mutation surface. The Set
 * stays closure-private so trusted refresh can narrow it; even borrowing
 * Set.prototype.add fails because a Proxy has no Set internal slot.
 * @param {Set<string>} membership
 * @returns {Set<string>}
 */
export const createReadOnlyOperationGrant = (membership) => {
  const has = (/** @type {string} */ operation) => membership.has(operation);
  return Object.freeze(new Proxy(membership, {
    get: (_target, property) => property === 'has' ? has : undefined,
  }));
};

/**
 * @param {Record<string, any>} value
 * @param {{sessionId:string,operationGrant:Set<string>,abortSignal:AbortSignal}} fixed
 */
export const snapshotControllerTurnAuthorityBinding = (value, fixed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.session?.sessionId !== fixed.sessionId) {
    throw new TypeError('turn authority context binding invalid');
  }
  const keys = new Set(BRIDGE_KEYS);
  for (const scoped of Object.values(CLASS_KEYS)) {
    for (const key of scoped) keys.add(key);
  }
  return Object.freeze({
    ...pick(value, [...keys]),
    operationGrant: fixed.operationGrant,
    abortSignal: fixed.abortSignal,
  });
};

/**
 * @param {Record<string, any>} binding
 * @param {string} authorityClass
 */
export const projectControllerTurnAuthorityClass = (binding, authorityClass) => {
  const keys = CLASS_KEYS[authorityClass];
  return keys ? pick(binding, [
    ...keys, 'operationGrant', 'abortSignal',
  ]) : null;
};

/** @param {Record<string, any>} binding */
export const projectControllerTurnBridgeAuthority = (binding) => pick(
  binding, [...BRIDGE_KEYS, 'abortSignal'],
);
