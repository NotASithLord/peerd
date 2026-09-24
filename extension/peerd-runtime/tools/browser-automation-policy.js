// @ts-check

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../../shared/private-network.js';
import {
  FAILURE_OUTCOMES,
  isFailureOutcomeKind,
} from '../lifecycle/failure-taxonomy.js';

/** @typedef {'invalid_url' | 'unsupported_scheme' | 'private_network' | 'cloud_metadata' | 'sensitive_site' | 'unverified_target' | 'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} BrowserTargetRefusalReason */
/** @typedef {'pre_navigation' | 'committed_origin'} BrowserTargetStage */
/** @typedef {'not_run' | 'page_loaded_not_automated'} BrowserTargetOutcome */

/** @typedef {{allowed:true,origin:string}} AllowedBrowserTarget */
/** @typedef {{allowed:false,code:string,reason:BrowserTargetRefusalReason,stage:BrowserTargetStage,outcome:BrowserTargetOutcome,retryable:boolean,message:string,correction:string}} RefusedBrowserTarget */

/** @typedef {AllowedBrowserTarget | RefusedBrowserTarget} BrowserTargetVerdict */

/** @typedef {{ok:false,error:string,content:string,structured:RefusedBrowserTarget,outcomeKind:import('../lifecycle/failure-taxonomy.js').FailureOutcomeKind}} BrowserTargetRefusalResult */

export const BROWSER_TARGET_CODES = Object.freeze({
  INVALID_URL: 'browser_target_invalid',
  UNSUPPORTED_SCHEME: 'browser_target_scheme_blocked',
  PRIVATE_NETWORK: 'browser_private_network_blocked',
  SENSITIVE_SITE: 'browser_sensitive_site_blocked',
  UNVERIFIED_TARGET: 'browser_target_unverified',
  NETWORK_GUARD_UNAVAILABLE: 'browser_network_guard_unavailable',
});

export const FORM_SUBMISSION_CODES = Object.freeze({
  CROSS_ORIGIN: 'cross_origin_form_submission_blocked',
});

export const CROSS_ORIGIN_FORM_SUBMISSION_MESSAGE =
  'This form submits to another site. peerd did not click, type, or submit. Review and complete the form in the open tab, then submit it yourself if you want to continue. Do not retry with another click, selector, type submit, or page code.';

const crossOriginFormSubmissionRefusalReceipt = () => ({
  ok: /** @type {const} */ (false),
  error: FORM_SUBMISSION_CODES.CROSS_ORIGIN,
  structured: {
    code: FORM_SUBMISSION_CODES.CROSS_ORIGIN,
    reason: 'cross_origin_form_submission',
    outcome: 'not_run',
    performed: false,
    retryable: false,
  },
  outcomeKind: FAILURE_OUTCOMES.PRE_EFFECT_FAILURE,
  endTurn: /** @type {const} */ (true),
});

/** @param {unknown} carrier */
const isCrossOriginFormSubmission = (carrier) =>
  /** @type {{ error?: unknown }} */ (carrier)?.error === FORM_SUBMISSION_CODES.CROSS_ORIGIN;

/** @param {unknown} carrier */
export const formSubmissionRefusalReceiptFrom = (carrier) => {
  return isCrossOriginFormSubmission(carrier)
    ? crossOriginFormSubmissionRefusalReceipt()
    : null;
};

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

/** @param {BrowserTargetStage} stage @returns {Pick<RefusedBrowserTarget,'stage'|'outcome'>} */
const stageContract = (stage) => ({ stage, outcome: stageOutcome(stage) });

/** @param {RefusedBrowserTarget} verdict @param {boolean|undefined} effectCompleted */
const lifecycleOutcome = (verdict, effectCompleted) => (
  effectCompleted ?? verdict.stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
)
  ? FAILURE_OUTCOMES.EFFECT_COMPLETED
  : FAILURE_OUTCOMES.PRE_EFFECT_FAILURE;

/** @param {RefusedBrowserTarget} verdict @param {boolean|undefined} [effectCompleted] */
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

/** @param {{message?:string,correction?:string}} [overrides] @returns {RefusedBrowserTarget} */
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
 * @param {RefusedBrowserTarget} verdict
 * @param {{effectCompleted?:boolean,neutralized?:boolean}} [options]
 */
export const browserTargetRefusalReceipt = (verdict, options = {}) => ({
  ok: /** @type {const} */ (false),
  error: verdict.code,
  structured: {
    ...verdict,
    ...(typeof options.neutralized === 'boolean' ? { neutralized: options.neutralized } : {}),
  },
  outcomeKind: lifecycleOutcome(verdict, options.effectCompleted),
});

/** @param {RefusedBrowserTarget} verdict @param {{effectCompleted?:boolean,neutralized?:boolean}} [options]
 * @returns {BrowserTargetRefusalResult} */
export const browserTargetRefusalResult = (verdict, options = {}) => ({
  ...browserTargetRefusalReceipt(verdict, options),
  content: formatBrowserTargetRefusal(verdict, options.effectCompleted),
});

/** @param {any} carrier @param {{effectCompleted?:boolean}} [options] */
export const browserTargetRefusalReceiptFrom = (carrier, options = {}) => {
  if (carrier?.structured?.allowed === false) {
    return browserTargetRefusalReceipt(carrier.structured, options);
  }
  const safeCode = (/** @type {unknown} */ value) => typeof value === 'string'
    && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : null;
  const code = safeCode(carrier?.code);
  // why: a generic kernel host may attach diagnostic prose to `error`. It is
  // not reviewed controller presentation, so retain it only when it is itself
  // a bounded machine code; otherwise surface the validated code or fallback.
  const error = safeCode(carrier?.error) ?? code ?? 'browser_target_refused';
  const outcomeKind = isFailureOutcomeKind(carrier?.outcomeKind)
    ? carrier.outcomeKind : null;
  const effectCompleted = options.effectCompleted === true;
  const phase = carrier?.phase === 'startup' || carrier?.phase === 'run'
    ? carrier.phase : null;
  return {
    ok: /** @type {const} */ (false),
    error,
    ...(code ? { code } : {}),
    ...(typeof carrier?.outcomeKnown === 'boolean'
      ? { outcomeKnown: carrier.outcomeKnown } : {}),
    ...(effectCompleted
      ? { outcomeKind: FAILURE_OUTCOMES.EFFECT_COMPLETED, performed: true }
      : {
        ...(outcomeKind ? { outcomeKind } : {}),
        ...(typeof carrier?.performed === 'boolean' ? { performed: carrier.performed } : {}),
      }),
    ...(typeof carrier?.retryable === 'boolean' ? { retryable: carrier.retryable } : {}),
    ...(phase ? { phase } : {}),
  };
};

/** @param {unknown} carrier @returns {boolean} */
const isBrowserDocumentRefusal = (carrier) => {
  const value = /** @type {{ outcomeKind?: unknown, error?: unknown, message?: unknown }} */ (carrier);
  if (value?.outcomeKind !== FAILURE_OUTCOMES.PRE_EFFECT_FAILURE) return false;
  const message = typeof value.error === 'string'
    ? value.error
    : typeof value.message === 'string' ? value.message : '';
  return /browser_target_(?:changed|unverified)/i.test(message);
};

/** @param {unknown} carrier */
export const browserDocumentRefusalReceiptFrom = (carrier) =>
  isBrowserDocumentRefusal(carrier)
    ? browserTargetRefusalReceipt(unverifiedBrowserTargetVerdict(), { effectCompleted: false })
    : null;

export class BrowserAutomationPolicyError extends Error {
  /** @param {RefusedBrowserTarget} verdict @param {{effectCompleted?:boolean,neutralized?:boolean}} [options] */
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

/** @param {'network_guard_unavailable'|'network_guard_unsupported'|'network_guard_install_failed'} [reason]
 * @returns {RefusedBrowserTarget} */
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

/** @param {'network_guard_unavailable'|'network_guard_unsupported'|'network_guard_install_failed'} [reason] */
export const browserNetworkGuardUnavailableResult = (reason = 'network_guard_unavailable') =>
  browserTargetRefusalResult(browserNetworkGuardUnavailableVerdict(reason), {
    effectCompleted: false,
  });

/** @param {'network_guard_unavailable'|'network_guard_unsupported'|'network_guard_install_failed'} reason */
const browserNetworkGuardPostNavigationVerdict = (reason) => {
  const base = browserNetworkGuardUnavailableVerdict(reason);
  return {
    ...base,
    stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    outcome: /** @type {const} */ ('page_loaded_not_automated'),
    message: 'Navigation loaded a public page, but peerd stopped further browser automation because private-network request blocking could not be installed.',
  };
};

/** @param {'network_guard_unavailable'|'network_guard_unsupported'|'network_guard_install_failed'} [reason] */
export const browserNetworkGuardPostNavigationReceipt = (reason = 'network_guard_unavailable') => {
  return browserTargetRefusalReceipt(browserNetworkGuardPostNavigationVerdict(reason), {
    effectCompleted: true,
  });
};

/** @returns {RefusedBrowserTarget} */
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

export class BrowserNetworkGuardUnavailableError extends BrowserAutomationPolicyError {
  /** @param {'network_guard_unavailable' | 'network_guard_unsupported' | 'network_guard_install_failed'} [reason] */
  constructor(reason = 'network_guard_unavailable') {
    super(browserNetworkGuardUnavailableVerdict(reason), { effectCompleted: false });
    this.name = 'BrowserNetworkGuardUnavailableError';
  }
}

/** @param {BrowserTargetStage} stage @param {'private_network'|'cloud_metadata'} reason */
const privateTargetMessage = (stage, reason) => {
  const target = reason === 'cloud_metadata'
    ? 'a cloud metadata page'
    : 'a localhost, private network, or link-local page';
  return stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
    ? `Navigation loaded ${target}. peerd stopped further browser automation for it.`
    : `peerd does not automate ${target}. No browser action was run.`;
};

/** @param {unknown} target
 * @param {{ stage?: BrowserTargetStage }} [options]
 * @returns {BrowserTargetVerdict} */
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

/** @param {unknown} target */
export const isAddressableBrowserTab = (target) =>
  classifyBrowserAutomationTarget(target, {
    stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
  }).allowed;
