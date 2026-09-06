// @ts-check

import { createKernelMemoryAuthority } from './kernel-memory-authority.js';
import { createKernelContactsAuthority } from './kernel-contacts-authority.js';
import { PROVIDER_EGRESS_MANIFEST } from './provider-egress-manifest.js';

const MUTATIONS = new Set([
  'semantic.memory.delete-all', 'semantic.memory.write', 'semantic.memory.delete',
  'semantic.memory.approve', 'semantic.memory.dismiss',
  'semantic.contacts.upsert', 'semantic.contacts.remove',
  'semantic.apps.favorite', 'semantic.apps.open', 'semantic.apps.rename',
  'semantic.apps.set-entry',
]);

const ROUTES = Object.freeze({
  'semantic.contacts.upsert': 'contacts/set',
  'semantic.contacts.remove': 'contacts/forget',
  'semantic.apps.favorite': 'apps/favorite',
  'semantic.apps.open': 'apps/open',
  'semantic.apps.reload': 'apps/rename',
  'semantic.apps.rename': 'apps/rename',
  'semantic.apps.set-entry': 'app/get-meta',
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
  contacts: injectedContacts = null,
  appCatalog = null,
  reloadApp = () => {},
  browser = null,
  appTabUrl = '',
  sessionCache = null,
}) => {
  const memory = injectedMemory ?? createKernelMemoryAuthority({ idb, kv, auditLog, now });
  const contacts = injectedContacts ?? createKernelContactsAuthority({ idb, now });
  const keyStatus = async () => {
    await ready;
    return Object.fromEntries(await Promise.all(Object.entries(PROVIDER_EGRESS_MANIFEST)
      .map(async ([provider, policy]) => {
        let key = null;
        try { if (policy.credential) key = await vault.getSecret(policy.credential); } catch {}
        // why: even masked fragments and length are properties of plaintext.
        // The sealed semantic controller needs only credential readiness.
        return [provider, { hasKey: policy.credential === null || !!key }];
      })));
  };
  const openApp = async (/** @type {any} */ payload) => {
    if (typeof payload?.appId !== 'string' || !appCatalog) return false;
    const app = await appCatalog.get(payload.appId);
    if (!app) return false;
    const sessionId = await sessionCache?.sessionGet('currentSessionId');
    const owner = typeof sessionId === 'string' ? sessionId
      : typeof app.ownerSessionId === 'string' ? app.ownerSessionId : null;
    const url = `${appTabUrl}#${payload.appId}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`;
    const existing = (await browser?.tabs?.query?.({ url: `${appTabUrl}#${payload.appId}*` }) ?? [])[0];
    if (typeof existing?.id === 'number') await browser.tabs.update(existing.id, { active: true });
    else await browser?.tabs?.create?.({ url, active: true });
    if (typeof sessionId === 'string') {
      await appCatalog.setDefaultForSession(sessionId, payload.appId);
    }
    return true;
  };
  const calls = Object.freeze({
    'semantic.apps.favorite': (/** @type {any} */ payload) =>
      typeof payload?.appId === 'string' && typeof payload.favorite === 'boolean' && appCatalog
        ? appCatalog.setFavorite(payload.appId, payload.favorite) : null,
    'semantic.apps.open': openApp,
    'semantic.apps.reload': async (/** @type {any} */ payload) => {
      if (typeof payload?.appId !== 'string') return false;
      try { await reloadApp(payload.appId); } catch {}
      return true;
    },
    'semantic.apps.rename': (/** @type {any} */ payload) =>
      typeof payload?.appId === 'string' && typeof payload.name === 'string'
        && payload.name.length <= 80 && appCatalog
        ? appCatalog.setName(payload.appId, payload.name) : null,
    'semantic.apps.set-entry': (/** @type {any} */ payload) =>
      typeof payload?.appId === 'string' && typeof payload.entryFile === 'string'
        && payload.entryFile.length <= 512 && appCatalog
        ? appCatalog.setEntryFile(payload.appId, payload.entryFile) : null,
    'semantic.contacts.upsert': (/** @type {any} */ payload) =>
      contacts?.upsert(payload?.did, payload?.patch ?? {}),
    'semantic.contacts.remove': (/** @type {any} */ payload) => contacts?.remove(payload?.did),
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
      if (vault.isLocked() && route !== 'app/get-meta') {
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
