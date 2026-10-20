// @ts-check

import { createKernelMemoryAuthority } from './kernel-memory-authority.js';
import { createKernelContactsAuthority } from './kernel-contacts-authority.js';
import { PROVIDER_EGRESS_MANIFEST } from './provider-egress-manifest.js';
import { createAppLaunchOwner } from '../shared/current-session-binding.js';
import { parseAppManifest } from '../peerd-engine/app-manifest.js';

const MEMORY_ROUTES = Object.freeze(Object.fromEntries([
  ['delete-all', 'deleteAll'], ['write', 'write'], ['delete', 'delete'],
  ['suggestions', 'suggestions'], ['approve', 'suggestions/approve'], ['dismiss', 'suggestions/dismiss'],
].map(([operation, route]) => [`semantic.memory.${operation}`, `memory/${route}`])));

// All other admitted operations may have committed a mutation before failing.
const READS = new Set(['semantic.apps.reload', 'semantic.providers.key-status', 'semantic.memory.suggestions']);

const denied = (/** @type {string} */ code) => ({ ok: false, code, outcomeKnown: true });

const ROUTES = Object.freeze({
  'semantic.contacts.upsert': 'contacts/set',
  'semantic.contacts.remove': 'contacts/forget',
  'semantic.apps.favorite': 'apps/favorite',
  'semantic.apps.open': 'apps/open',
  'semantic.apps.reload': 'apps/rename',
  'semantic.apps.rename': 'apps/rename',
  'semantic.apps.set-entry': 'app/get-meta',
  'semantic.providers.key-status': 'provider/status',
  ...MEMORY_ROUTES,
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
  appLaunchSessions = null,
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
  const resolveLaunchOwner = createAppLaunchOwner(appLaunchSessions, sessionCache);
  const openApp = async (/** @type {any} */ payload) => {
    if (!appCatalog) return false;
    const app = await appCatalog.get(payload.appId);
    if (!app) return false;
    const sessionId = await sessionCache?.sessionGet('currentSessionId');
    const claim = typeof sessionId === 'string' ? sessionId
      : typeof app.ownerSessionId === 'string' ? app.ownerSessionId : null;
    const owner = await resolveLaunchOwner(claim);
    const url = `${appTabUrl}#${payload.appId}?owner=${encodeURIComponent(owner)}`;
    // why: tabs.query omits fragments. Match the full owner URL after App ID validation.
    const existing = (await browser?.tabs?.query?.({ url: `${appTabUrl}*` }) ?? []).find((/** @type {any} */ tab) => tab.url === url);
    if (typeof existing?.id === 'number') await browser.tabs.update(existing.id, { active: true });
    else await browser?.tabs?.create?.({ url, active: true });
    await appCatalog.setDefaultForSession(owner, payload.appId);
    return true;
  };
  const calls = Object.freeze({
    'semantic.apps.favorite': (/** @type {any} */ payload) =>
      typeof payload.favorite === 'boolean' && appCatalog
        ? appCatalog.setFavorite(payload.appId, payload.favorite) : null,
    'semantic.apps.open': openApp,
    'semantic.apps.reload': async (/** @type {any} */ payload) => {
      try { await reloadApp(payload.appId); } catch {}
      return true;
    },
    'semantic.apps.rename': (/** @type {any} */ payload) =>
      typeof payload.name === 'string'
        && payload.name.length <= 80 && appCatalog
        ? appCatalog.setName(payload.appId, payload.name) : null,
    'semantic.apps.set-entry': (/** @type {any} */ payload) =>
      typeof payload.entryFile === 'string'
        && payload.entryFile.length <= 512 && appCatalog
        ? appCatalog.setEntryFile(payload.appId, payload.entryFile) : null,
    'semantic.contacts.upsert': (/** @type {any} */ payload) =>
      contacts?.upsert(payload?.did, payload?.patch ?? {}),
    'semantic.contacts.remove': (/** @type {any} */ payload) => contacts?.remove(payload?.did),
    'semantic.providers.key-status': keyStatus,

  });
  return Object.freeze({
    handle: async (/** @type {string} */ operation, /** @type {any} */ payload,
      /** @type {any} */ context) => {
      const route = /** @type {Record<string,string>} */ (ROUTES)[operation];
      if (!route || !String(context?.authority?.target ?? '').startsWith(`semantic:${route}:`)) {
        return denied('semantic-kernel-operation-denied');
      }
      if (vault.isLocked() && route !== 'app/get-meta') {
        return { ok: false, error: 'vault-locked', outcomeKnown: true };
      }
      if (operation.startsWith('semantic.apps.')) {
        // why: route admission is not target admission. Only the host-retained
        // request, never the sealed worker's reverse-call arguments, selects an App.
        const requested = context?.outerPayload?.message;
        const appId = route === 'app/get-meta' ? requested?.app?.id : requested?.appId;
        if (typeof appId !== 'string' || payload?.appId !== appId
            || context.authority.instanceId !== appId) {
          return denied('semantic-app-target-denied');
        }
        if (operation === 'semantic.apps.set-entry') {
          try {
            const { entry } = parseAppManifest(requested.manifestText);
            if (payload.entryFile !== entry || !Array.isArray(requested.paths)
                || !requested.paths.some((/** @type {unknown} */ path) =>
                  typeof path === 'string' && path.replace(/^\/+/, '') === entry)) {
              return denied('semantic-app-entry-denied');
            }
          } catch {
            return denied('semantic-app-entry-denied');
          }
        }
      }
      try {
        return { ok: true, value: await (/** @type {any} */ (calls)[operation] ?? memory.routes[route])(payload),
          outcomeKnown: true };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: READS.has(operation),
        };
      }
    },
  });
};
