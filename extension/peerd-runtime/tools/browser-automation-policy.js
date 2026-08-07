// @ts-check
// Browser-automation target policy.
//
// Browser tabs have broader reach than the open web. With host permission they
// can load loopback, LAN, link-local, and cloud-metadata pages, then hand those
// pages to the scripting or debugger backends. Keep the browser-facing decision
// in one pure classifier so every entry point can apply the same rule before it
// gains page authority.

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../../shared/private-network.js';

/** @typedef {'invalid_url' | 'unsupported_scheme' | 'private_network' | 'cloud_metadata'} BrowserTargetRefusalReason */
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
 * @property {false} retryable
 * @property {string} message
 * @property {string} correction
 * @property {string} [origin]
 */

/** @typedef {AllowedBrowserTarget | RefusedBrowserTarget} BrowserTargetVerdict */

export const BROWSER_TARGET_CODES = Object.freeze({
  INVALID_URL: 'browser_target_invalid',
  UNSUPPORTED_SCHEME: 'browser_target_scheme_blocked',
  PRIVATE_NETWORK: 'browser_private_network_blocked',
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
 * @param {BrowserTargetStage} stage
 * @param {'private_network' | 'cloud_metadata'} reason
 */
const privateTargetMessage = (stage, reason) => {
  const target = reason === 'cloud_metadata'
    ? 'a cloud metadata page'
    : 'a localhost, private network, or link-local page';
  return stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN
    ? `Navigation reached ${target}. The page may have loaded, but peerd did not inspect or operate it.`
    : `peerd does not automate ${target}. No browser action was run.`;
};

/**
 * Classify a URL before browser automation receives authority over its page.
 * The result contains only the origin, never a path, query, fragment, or
 * credentials, so a policy refusal can safely flow through audit and UI layers.
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
      correction: 'Do not retry with another URL spelling or browser tool. Ask the user to handle this page directly.',
      origin: url.origin,
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
      correction: 'Do not retry with another URL spelling or browser tool. Ask the user to handle this page directly.',
      origin: url.origin,
    };
  }

  return { allowed: true, origin: url.origin };
};
