// @ts-check

import {
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
import { createKernelBrowserNetworkAuthority } from './kernel-browser-network-authority.js';

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
