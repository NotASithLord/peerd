// @ts-check

import { createKernelMemoryAuthority } from './kernel-memory-authority.js';
import { maskProviderKey, PROVIDER_AUTHORITY } from '../shared/provider-authority-policy.js';

const MUTATIONS = new Set([
  'semantic.memory.delete-all', 'semantic.memory.write', 'semantic.memory.delete',
  'semantic.memory.approve', 'semantic.memory.dismiss',
]);

const ROUTES = Object.freeze({
  'semantic.providers.key-status': 'provider/status',
  'semantic.memory.delete-all': 'memory/deleteAll',
  'semantic.memory.write': 'memory/write',
  'semantic.memory.delete': 'memory/delete',
  'semantic.memory.suggestions': 'memory/suggestions',
  'semantic.memory.approve': 'memory/suggestions/approve',
  'semantic.memory.dismiss': 'memory/suggestions/dismiss',
});

/** @param {any} deps */
export const createKernelSemanticAuthority = ({
  idb, kv, auditLog, vault, ready, now = Date.now,
  memory: injectedMemory = null,
}) => {
  const memory = injectedMemory ?? createKernelMemoryAuthority({ idb, kv, auditLog, now });
  const keyStatus = async () => {
    await ready;
    return Object.fromEntries(await Promise.all(PROVIDER_AUTHORITY.map(async (policy) => {
      let key = null;
      try { if (policy.secretName) key = await vault.getSecret(policy.secretName); } catch {}
      return [policy.name, {
        hasKey: policy.secretName === null || !!key,
        keyPreview: key ? maskProviderKey(key) : null,
      }];
    })));
  };
  const calls = Object.freeze({
    'semantic.providers.key-status': keyStatus,
    'semantic.memory.delete-all': (/** @type {any} */ payload) => memory.routes['memory/deleteAll'](payload),
    'semantic.memory.write': (/** @type {any} */ payload) => memory.routes['memory/write'](payload),
    'semantic.memory.delete': (/** @type {any} */ payload) => memory.routes['memory/delete'](payload),
    'semantic.memory.suggestions': (/** @type {any} */ payload) => memory.routes['memory/suggestions'](payload),
    'semantic.memory.approve': (/** @type {any} */ payload) => memory.routes['memory/suggestions/approve'](payload),
    'semantic.memory.dismiss': (/** @type {any} */ payload) => memory.routes['memory/suggestions/dismiss'](payload),
  });
  return Object.freeze({
    handle: async (/** @type {string} */ operation, /** @type {any} */ payload,
      /** @type {any} */ context) => {
      const route = /** @type {Record<string,string>} */ (ROUTES)[operation];
      if (!route || !String(context?.authority?.target ?? '').startsWith(`semantic:${route}:`)) {
        return { ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true };
      }
      if (vault.isLocked() && !route.startsWith('toolbox/')) {
        return { ok: false, error: 'vault-locked', outcomeKnown: true };
      }
      try {
        return { ok: true, value: await /** @type {any} */ (calls)[operation](payload),
          outcomeKnown: true };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: !MUTATIONS.has(operation),
        };
      }
    },
  });
};
