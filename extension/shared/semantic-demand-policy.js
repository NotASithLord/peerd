// @ts-check
// Exact, capability-local limits for semantic controller demand.  This module
// deliberately contains no route implementation and no browser authority.  It
// is shared by the authority-kernel port and the sealed host so quota drift
// retires a channel instead of widening it.

import { controllerPayloadBytes } from './structured-clone-size.js';

export const SEMANTIC_DEMAND_MAX_BYTES = 256 * 1024;
export const SEMANTIC_DEMAND_MAX_CONCURRENT = 3;

const POLICIES = Object.freeze({
  'app/get-meta': Object.freeze({ 'semantic.apps.set-entry': 1 }),
  'apps/favorite': Object.freeze({ 'semantic.apps.favorite': 1 }),
  'apps/open': Object.freeze({ 'semantic.apps.open': 1 }),
  'apps/rename': Object.freeze({ 'semantic.apps.rename': 1, 'semantic.apps.reload': 1 }),
  'contacts/forget': Object.freeze({ 'semantic.contacts.remove': 1 }),
  'contacts/set': Object.freeze({ 'semantic.contacts.upsert': 1 }),
  'provider/status': Object.freeze({ 'semantic.providers.key-status': 1 }),
  'contributor/enable': Object.freeze({
    'semantic.contributor.enable-read': 1, 'semantic.contributor.enable': 1,
  }),
  'contributor/disable': Object.freeze({
    'semantic.contributor.clear': 1, 'semantic.contributor.disable-read': 1,
  }),
  'contributor/status': Object.freeze({ 'semantic.contributor.read': 1 }),
  'memory/deleteAll': Object.freeze({ 'semantic.memory.delete-all': 1 }),
  'memory/write': Object.freeze({ 'semantic.memory.write': 1 }),
  'memory/delete': Object.freeze({ 'semantic.memory.delete': 1 }),
  'memory/suggestions': Object.freeze({ 'semantic.memory.suggestions': 1 }),
  'memory/suggestions/approve': Object.freeze({ 'semantic.memory.approve': 1 }),
  'memory/suggestions/dismiss': Object.freeze({ 'semantic.memory.dismiss': 1 }),
});

const refusal = (/** @type {string} */ code, /** @type {boolean} */ known = true) =>
  Object.freeze({ ok: false, code, outcomeKnown: known });

const bounded = (/** @type {unknown} */ value) => {
  const bytes = controllerPayloadBytes(value, { maxDepth: 32, maxNodes: 250_000 });
  return Number.isFinite(bytes) && bytes <= SEMANTIC_DEMAND_MAX_BYTES;
};

/**
 * Route-bound reverse-call quota. Unknown routes intentionally receive no
 * reverse authority. That permits a future pure Class-E `agent/send`
 * projection without silently granting browser, vault, provider, or tool
 * operations; every such operation must first be added here and on both ends.
 * @param {unknown} outerPayload
 */
export const createSemanticDemandQuota = (outerPayload) => {
  const route = outerPayload && typeof outerPayload === 'object' && !Array.isArray(outerPayload)
    ? /** @type {Record<string, unknown>} */ (outerPayload).route : null;
  const allowed = typeof route === 'string'
    ? POLICIES[/** @type {keyof typeof POLICIES} */ (route)] ?? null : null;
  /** @type {Map<string, number>} */
  const used = new Map();
  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const limit = allowed?.[/** @type {keyof typeof allowed} */ (operation)] ?? 0;
    const count = used.get(operation) ?? 0;
    if (count >= limit) return refusal('kernel-operation-denied');
    if (!bounded(payload)) return refusal('kernel-operation-payload-too-large');
    used.set(operation, count + 1);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  const observe = (/** @type {string} */ operation, /** @type {unknown} */ result) => {
    const admitted = (allowed?.[/** @type {keyof typeof allowed} */ (operation)] ?? 0) > 0;
    if (!admitted) return refusal('kernel-operation-denied', false);
    return bounded(result)
      ? Object.freeze({ ok: true, outcomeKnown: true })
      : refusal('kernel-operation-result-too-large', false);
  };
  const pendingCap = allowed
    ? Math.min(SEMANTIC_DEMAND_MAX_CONCURRENT,
        Object.values(allowed).reduce((sum, value) => sum + value, 0))
    : 0;
  return Object.freeze({ admit, observe, pendingCap });
};
