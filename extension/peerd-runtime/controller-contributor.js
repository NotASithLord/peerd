// @ts-check

// why: Contributor semantics are optional controller-owned policy. Keeping
// their public root separate prevents unrelated administrative hosts from
// acquiring provider/model catalogs or observability code.
export {
  CONTRIBUTOR_DISCLOSURE_VERSION, CONTRIBUTOR_SCHEMA_VERSION,
  contributorActionForTool, contributorModelFamilyCode, contributorModelFamilyFromCode,
  contributorProviderCode, contributorProviderFromCode, contributorTurnResult,
  normalizeContributorModelFamily, normalizeContributorProvider,
} from './observability/contributor-metrics.js';
export { contributorFeedbackTargets } from './observability/contributor-feedback.js';
export { makeContributorStore } from './observability/contributor-store.js';

import {
  contributorActionForTool,
  contributorModelFamilyCode,
  contributorProviderCode,
  contributorTurnResult,
} from './observability/contributor-metrics.js';

const CONTRIBUTOR_MAX_ACTIONS = 128;

/**
 * Project raw actor-loop state into the fixed, content-free contribution wire.
 * This runs in the dedicated semantic Worker, never the Firefox event page.
 * @param {any} result @param {unknown} provider @param {unknown} model
 */
export const projectContributorSettlement = (result, provider, model) => {
  const messages = Array.isArray(result?.newMessages) ? result.newMessages : [];
  const actions = messages.flatMap((/** @type {any} */ entry) => Array.isArray(entry?.toolUses)
    ? entry.toolUses.flatMap((/** @type {any} */ toolUse) => {
      const action = contributorActionForTool(toolUse?.name);
      return action ? [action] : [];
    }) : []);
  if (actions.length > CONTRIBUTOR_MAX_ACTIONS) return null;
  if (result?.aborted === true) {
    return Object.freeze({
      providerCode: contributorProviderCode(provider),
      modelFamilyCode: contributorModelFamilyCode(model),
      outcome: 'cancelled', failure: 'none', actions,
    });
  }
  const assistantMessages = messages.flatMap((/** @type {any} */ entry) =>
    entry?.role === 'assistant' ? [{
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
      ...(typeof entry.stopReason === 'string' ? { stopReason: entry.stopReason } : {}),
    }] : []);
  if (typeof result?.error === 'string'
      && !assistantMessages.some((/** @type {any} */ entry) => typeof entry.error === 'string')) {
    assistantMessages.push({ error: result.error, stopReason: result?.stopReason });
  }
  return Object.freeze({
    providerCode: contributorProviderCode(provider),
    modelFamilyCode: contributorModelFamilyCode(model),
    ...contributorTurnResult({
      assistantMessages,
      stopped: result?.ok !== true,
      result: result?.error ?? result?.finalText ?? '',
    }),
    actions,
  });
};
