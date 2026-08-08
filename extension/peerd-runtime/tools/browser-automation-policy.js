// @ts-check
// Browser-automation target policy.
//
// Browser tabs have broader reach than the open web. With host permission they
// can load loopback, LAN, link-local, and cloud-metadata pages, then hand those
// pages to the scripting or debugger backends. Keep the browser-facing decision
// in one pure classifier so every entry point can apply the same rule before it
// gains page authority.

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../../shared/private-network.js';
import { FAILURE_OUTCOMES } from '../lifecycle/failure-taxonomy.js';

/** @typedef {'invalid_url' | 'unsupported_scheme' | 'private_network' | 'cloud_metadata' | 'sensitive_site' | 'unverified_target' | 'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} BrowserTargetRefusalReason */
/** @typedef {'pre_navigation' | 'committed_origin'} BrowserTargetStage */
/** @typedef {'not_run' | 'page_loaded_not_automated'} BrowserTargetOutcome */

/**
 * @typedef {Object} AllowedBrowserTarget
 * @property {true} allowed
 * @property {string} origin
 */

/**
 * @typedef {Object} RefusedBrowserTarget
 * @property {false} allowed
 * @property {string} code
 * @property {BrowserTargetRefusalReason} reason
 * @property {BrowserTargetStage} stage
 * @property {BrowserTargetOutcome} outcome
 * @property {boolean} retryable
 * @property {string} message
 * @property {string} correction
 */

/** @typedef {AllowedBrowserTarget | RefusedBrowserTarget} BrowserTargetVerdict */

/**
 * @typedef {Object} BrowserTargetRefusalResult
 * @property {false} ok
 * @property {string} error
 * @property {string} content
 * @property {RefusedBrowserTarget} structured
 * @property {import('../lifecycle/failure-taxonomy.js').FailureOutcomeKind} outcomeKind
 */

export const BROWSER_TARGET_CODES = Object.freeze({
  INVALID_URL: 'browser_target_invalid',
  UNSUPPORTED_SCHEME: 'browser_target_scheme_blocked',
  PRIVATE_NETWORK: 'browser_private_network_blocked',
  SENSITIVE_SITE: 'browser_sensitive_site_blocked',
  UNVERIFIED_TARGET: 'browser_target_unverified',
  NETWORK_GUARD_UNAVAILABLE: 'browser_network_guard_unavailable',
});

export const BROWSER_TARGET_STAGES = Object.freeze({
  PRE_NAVIGATION: /** @type {const} */ ('pre_navigation'),
  COMMITTED_ORIGIN: /** @type {const} */ ('committed_origin'),
});

const WEB_SCHEMES = new Set(['http:', 'https:']);

/** @param {BrowserTargetStage} stage */
const stageOutcome = (stage) => stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
  ? /** @type {const} */ ('page_loaded_not_automated')
  : /** @type {const} */ ('not_run');

/** @param {unknown} stage @returns {BrowserTargetStage} */
const normalizeStage = (stage) => stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
  ? BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
  : BROWSER_TARGET_STAGES.PRE_NAVIGATION;

/**
 * @param {BrowserTargetStage} stage
 * @returns {Pick<RefusedBrowserTarget, 'stage' | 'outcome'>}
 */
const stageContract = (stage) => ({ stage, outcome: stageOutcome(stage) });

/**
 * @param {RefusedBrowserTarget} verdict
 * @param {boolean | undefined} effectCompleted
 */
const lifecycleOutcome = (verdict, effectCompleted) => (
  effectCompleted ?? verdict.stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
)
  ? FAILURE_OUTCOMES.EFFECT_COMPLETED
  : FAILURE_OUTCOMES.PRE_EFFECT_FAILURE;

/**
 * Format a refusal without copying a URL path, query, fragment, or credentials
 * into an error channel. The code prefix is stable for callers and tests.
 *
 * @param {RefusedBrowserTarget} verdict
 * @param {boolean | undefined} [effectCompleted]
 */
export const formatBrowserTargetRefusal = (verdict, effectCompleted = undefined) => {
  const completed = effectCompleted ?? verdict.stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN;
  let message = verdict.message;
  if (verdict.stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
      && (verdict.reason === 'private_network' || verdict.reason === 'cloud_metadata')) {
    const target = verdict.reason === 'cloud_metadata'
      ? 'a cloud metadata page'
      : 'a localhost, private network, or link-local page';
    message = completed
      ? `Navigation loaded ${target}. peerd stopped further browser automation for it.`
      : `This tab is on ${target}. peerd did not run this tool.`;
  }
  const modelContract = {
    code: verdict.code,
    reason: verdict.reason,
    stage: verdict.stage,
    outcome: verdict.outcome,
    retryable: verdict.retryable,
  };
  return `${message} ${verdict.correction}\nPolicy: ${JSON.stringify(modelContract)}`;
};

/**
 * Fail closed when the browser cannot bind an operation to the document whose
 * location was checked. This is distinct from classifying a known private URL.
 *
 * @param {{ message?: string, correction?: string }} [overrides]
 * @returns {RefusedBrowserTarget}
 */
export const unverifiedBrowserTargetVerdict = (overrides = {}) => ({
  allowed: false,
  code: BROWSER_TARGET_CODES.UNVERIFIED_TARGET,
  reason: 'unverified_target',
  stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
  outcome: 'not_run',
  retryable: true,
  message: overrides.message
    ?? 'peerd could not verify which document is currently loaded in this tab. The browser tool was not run.',
  correction: overrides.correction
    ?? 'Wait for the page to finish loading, then retry once. If this continues, handle the page directly in the browser.',
});

/**
 * Build the shared returned-result shape for browser automation policy stops.
 *
 * @param {RefusedBrowserTarget} verdict
 * @param {{ effectCompleted?: boolean, neutralized?: boolean }} [options]
 * @returns {BrowserTargetRefusalResult}
 */
export const browserTargetRefusalResult = (verdict, options = {}) => ({
  ok: false,
  error: verdict.code,
  content: formatBrowserTargetRefusal(verdict, options.effectCompleted),
  structured: {
    ...verdict,
    ...(typeof options.neutralized === 'boolean' ? { neutralized: options.neutralized } : {}),
  },
  outcomeKind: lifecycleOutcome(verdict, options.effectCompleted),
});

/**
 * Convert only a host-stamped pre-effect exact-document failure into the shared
 * model/user recovery contract. Page exception text alone is never trusted as
 * evidence that an action did not run.
 * @param {unknown} carrier
 * @returns {BrowserTargetRefusalResult | null}
 */
export const browserDocumentRefusalFrom = (carrier) => {
  const value = /** @type {{ outcomeKind?: unknown, error?: unknown, message?: unknown }} */ (carrier);
  if (value?.outcomeKind !== FAILURE_OUTCOMES.PRE_EFFECT_FAILURE) return null;
  const message = typeof value.error === 'string'
    ? value.error
    : typeof value.message === 'string' ? value.message : '';
  if (!/browser_target_(?:changed|unverified)/i.test(message)) return null;
  return browserTargetRefusalResult(unverifiedBrowserTargetVerdict(), {
    effectCompleted: false,
  });
};

/**
 * Thrown form for entry points whose API uses exceptions instead of results.
 * Its own fields survive explicit relay serialization without exposing a URL.
 */
export class BrowserAutomationPolicyError extends Error {
  /**
   * @param {RefusedBrowserTarget} verdict
   * @param {{ effectCompleted?: boolean, neutralized?: boolean }} [options]
   */
  constructor(verdict, options = {}) {
    const result = browserTargetRefusalResult(verdict, options);
    super(result.error);
    this.name = 'BrowserAutomationPolicyError';
    this.exposeToModel = true;
    this.code = verdict.code;
    this.content = result.content;
    this.structured = result.structured;
    this.outcomeKind = result.outcomeKind;
  }
}

/**
 * Truthful recovery differs between a browser that lacks the enforcement API
 * and a supported browser whose rule installation failed in this context.
 * @param {'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} [reason]
 * @returns {RefusedBrowserTarget}
 */
export const browserNetworkGuardUnavailableVerdict = (reason = 'network_guard_unavailable') => {
  const unsupported = reason === 'network_guard_unsupported';
  const installFailed = reason === 'network_guard_install_failed';
  return {
    allowed: false,
    code: BROWSER_TARGET_CODES.NETWORK_GUARD_UNAVAILABLE,
    reason,
    stage: BROWSER_TARGET_STAGES.PRE_NAVIGATION,
    outcome: 'not_run',
    retryable: false,
    message: installFailed
      ? 'peerd did not run this browser tool because private-network request blocking could not be installed.'
      : 'peerd did not run this browser tool because private-network request blocking is unavailable.',
    correction: unsupported
      ? 'Do not retry this browser action in the current context. Update to a supported current browser version, then begin a new attempt.'
      : installFailed
        ? 'Do not retry this browser action in the current context. Restart the browser or extension, then begin a new attempt. Update it if the problem continues.'
        : 'Do not retry this browser action in the current context. Update or restart the browser or extension, then begin a new attempt.',
  };
};

/**
 * @param {'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} [reason]
 */
export const browserNetworkGuardUnavailableResult = (reason = 'network_guard_unavailable') =>
  browserTargetRefusalResult(browserNetworkGuardUnavailableVerdict(reason), {
    effectCompleted: false,
  });

/**
 * A navigation can commit before the worker-origin companion rule finishes
 * installing. Report the browser effect truthfully while withholding further
 * page authority.
 * @param {'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} [reason]
 */
export const browserNetworkGuardPostNavigationResult = (reason = 'network_guard_unavailable') => {
  const base = browserNetworkGuardUnavailableVerdict(reason);
  return browserTargetRefusalResult({
    ...base,
    stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    outcome: 'page_loaded_not_automated',
    message: 'Navigation loaded a public page, but peerd stopped further browser automation because private-network request blocking could not be installed.',
  }, { effectCompleted: true });
};

/**
 * A public navigation can redirect onto a site protected by the user's
 * denylist. Keep that landing on the same URL-free recovery contract as a
 * private-network redirect, while naming the distinct user-controlled policy.
 * @returns {RefusedBrowserTarget}
 */
export const sensitiveSiteBrowserTargetVerdict = () => ({
  allowed: false,
  code: BROWSER_TARGET_CODES.SENSITIVE_SITE,
  reason: 'sensitive_site',
  stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
  outcome: 'page_loaded_not_automated',
  retryable: false,
  message: 'Navigation loaded a site protected by the user denylist. peerd stopped further browser automation for it.',
  correction: 'Handle this site directly, or remove its denylist pattern only if you want peerd to access it.',
});

/**
 * Refusal used when a tab exists but the browser could not install the
 * tab-scoped private-network request floor. This is not a target-classification
 * verdict: the public page may be valid, but running page code without the
 * network backstop would grant it an unguarded path to local services.
 */
export class BrowserNetworkGuardUnavailableError extends BrowserAutomationPolicyError {
  /** @param {'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} [reason] */
  constructor(reason = 'network_guard_unavailable') {
    super(browserNetworkGuardUnavailableVerdict(reason), { effectCompleted: false });
    this.name = 'BrowserNetworkGuardUnavailableError';
  }
}

/**
 * @param {BrowserTargetStage} stage
 * @param {'private_network' | 'cloud_metadata'} reason
 */
const privateTargetMessage = (stage, reason) => {
  const target = reason === 'cloud_metadata'
    ? 'a cloud metadata page'
    : 'a localhost, private network, or link-local page';
  return stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
    ? `Navigation loaded ${target}. peerd stopped further browser automation for it.`
    : `peerd does not automate ${target}. No browser action was run.`;
};

/**
 * Classify a URL before browser automation receives authority over its page.
 * Allowed results carry the public origin. Refusals carry no target text, so a
 * redirect onto a private address cannot disclose it through model or audit
 * error channels.
 *
 * @param {unknown} target
 * @param {{ stage?: BrowserTargetStage }} [options]
 * @returns {BrowserTargetVerdict}
 */
export const classifyBrowserAutomationTarget = (target, options = {}) => {
  const stage = normalizeStage(options?.stage);
  if (typeof target !== 'string' && !(target instanceof URL)) {
    return {
      allowed: false,
      code: BROWSER_TARGET_CODES.INVALID_URL,
      reason: 'invalid_url',
      ...stageContract(stage),
      retryable: false,
      message: 'Browser automation requires an absolute URL.',
      correction: 'Use a full address beginning with http:// or https://.',
    };
  }

  /** @type {URL} */
  let url;
  try {
    url = new URL(typeof target === 'string' ? target.trim() : target.toString());
  } catch {
    return {
      allowed: false,
      code: BROWSER_TARGET_CODES.INVALID_URL,
      reason: 'invalid_url',
      ...stageContract(stage),
      retryable: false,
      message: 'Browser automation requires an absolute URL.',
      correction: 'Use a full address beginning with http:// or https://.',
    };
  }

  if (!WEB_SCHEMES.has(url.protocol)) {
    return {
      allowed: false,
      code: BROWSER_TARGET_CODES.UNSUPPORTED_SCHEME,
      reason: 'unsupported_scheme',
      ...stageContract(stage),
      retryable: false,
      message: 'Browser automation only supports web pages.',
      correction: 'Use a full address beginning with http:// or https://.',
    };
  }

  const hostname = url.hostname;
  if (isCloudMetadataHost(hostname)) {
    return {
      allowed: false,
      code: BROWSER_TARGET_CODES.PRIVATE_NETWORK,
      reason: 'cloud_metadata',
      ...stageContract(stage),
      retryable: false,
      message: privateTargetMessage(stage, 'cloud_metadata'),
      correction: 'Do not retry with another spelling or browser tool. This page must be handled directly in the browser.',
    };
  }
  if (isPrivateOrLocalHost(hostname)) {
    return {
      allowed: false,
      code: BROWSER_TARGET_CODES.PRIVATE_NETWORK,
      reason: 'private_network',
      ...stageContract(stage),
      retryable: false,
      message: privateTargetMessage(stage, 'private_network'),
      correction: 'Do not retry with another spelling or browser tool. This page must be handled directly in the browser.',
    };
  }

  return { allowed: true, origin: url.origin };
};

/**
 * A numeric tab handle may mint an actor only for an actionable public page.
 * @param {unknown} target
 */
export const isAddressableBrowserTab = (target) =>
  classifyBrowserAutomationTarget(target, {
    stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
  }).allowed;
