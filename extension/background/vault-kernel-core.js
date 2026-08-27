// @ts-check
// Pure cold-vault assembly shared with differential tests.

import { makeVaultRoutes } from './routes/vault.js';
import {
  KERNEL_STATE_DEFERRED_FIELDS,
  KERNEL_STATE_PROVENANCE,
  KERNEL_STATE_SCHEMA,
  validateKernelStateProjection,
} from '../shared/kernel-state-contract.js';
export { createVaultPostureIndex } from './vault-posture-index.js';
export { createKernelSessionReader } from './kernel-session-reader.js';
export { makeSystemReadRoutes } from './routes/system-read.js';

/** @param {{admit:(name:string,message:any,sender:any)=>boolean,vault:{isLocked:()=>boolean},ready:Promise<any>}} deps */
export const makeSessionSupportPreflight = (deps) => async (
  /** @type {string} */ name, /** @type {any} */ message, /** @type {any} */ sender,
) => {
  if (!deps.admit(name, message, sender)) {
    return { ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true };
  }
  if (name === 'session/setModel') await deps.ready;
  return name !== 'permission/set' && deps.vault.isLocked()
    ? { ok: false, error: 'locked' } : null;
};

const PROFILE_ID = 'default';
const PROFILE_STORE = 'profiles';
const MEMORY_STORE = 'agents_memory';
const MAX_DOC_CHARS = 24_000;
const normalizePeerName = (/** @type {unknown} */ value) => {
  const clean = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 32).trim() : '';
  return clean || 'peerd';
};
const normalizeFacts = (/** @type {unknown} */ value) => {
  if (value == null) return { ok: true, callMe: '', notes: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const facts = /** @type {{callMe?:unknown,notes?:unknown}} */ (value);
  if ((facts.callMe !== undefined && typeof facts.callMe !== 'string')
      || (facts.notes !== undefined && typeof facts.notes !== 'string')
      || String(facts.callMe ?? '').length > MAX_DOC_CHARS
      || String(facts.notes ?? '').length > MAX_DOC_CHARS) return { ok: false };
  return {
    ok: true,
    callMe: String(facts.callMe ?? '').replace(/\s+/g, ' ').trim(),
    notes: String(facts.notes ?? '').trim(),
  };
};
const validProfile = (/** @type {any} */ value) => value?.id === PROFILE_ID
  && typeof value.peerName === 'string' && value.peerName.length > 0 && value.peerName.length <= 32
  && Number.isFinite(value.createdAt) && typeof value.onboardingComplete === 'boolean'
  && (value.onboardingInferred === undefined || typeof value.onboardingInferred === 'boolean');
const userDocBody = (/** @type {{callMe:string,notes:string}} */ facts,
  /** @type {unknown} */ prior) => {
  if (!facts.callMe && !facts.notes) return '';
  const section = ['## About the user', ...(facts.callMe
    ? [`- Prefers to be called: ${facts.callMe}`] : []), ...(facts.notes ? ['', facts.notes] : [])]
    .join('\n');
  const before = typeof prior === 'string' ? prior.trim() : '';
  return before ? `${before}\n\n${section}\n` : `# User memory\n\n${section}\n`;
};
const normalizeMemoryBody = (/** @type {string} */ body) => {
  const normalized = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  return normalized.length <= MAX_DOC_CHARS ? normalized : null;
};

/** @param {any} deps */
export const createKernelProfileAuthority = ({ idb, sessions, now = Date.now }) => {
  if (typeof idb?.get !== 'function' || typeof idb?.transact !== 'function'
      || typeof sessions?.hasChat !== 'function') throw new TypeError('kernel-profile-config-invalid');
  /** @type {any} */ let current = null;
  /** @type {Promise<any>|null} */ let loading = null;
  const read = async () => {
    if (current) return current;
    if (!loading) loading = idb.transact([PROFILE_STORE], (/** @type {Record<string,IDBObjectStore>} */ handles) => {
      /** @type {any} */ let result;
      const request = handles[PROFILE_STORE].get(PROFILE_ID);
      request.onsuccess = () => {
        const stored = request.result;
        if (stored !== undefined && !validProfile(stored)) {
          result = { error: 'profile-record-invalid' }; return;
        }
        result = stored ?? {
          id: PROFILE_ID, peerName: 'peerd', createdAt: now(), onboardingComplete: false,
        };
        if (!stored) handles[PROFILE_STORE].put(result);
      };
      return () => result;
    }).then((/** @type {any} */ result) => {
      if (result?.error) throw new Error(result.error);
      current = result;
      return result;
    }).finally(() => { loading = null; });
    return loading;
  };
  const latch = async (/** @type {unknown} */ peerName, facts = null, inferred = false) => {
    const normalized = normalizeFacts(facts);
    if (!normalized.ok) return { ok: false, error: 'onboarding-facts-invalid' };
    const seed = normalized.callMe || normalized.notes;
    const stores = seed ? [PROFILE_STORE, MEMORY_STORE] : [PROFILE_STORE];
    return idb.transact(stores, (/** @type {Record<string,IDBObjectStore>} */ handles) => {
      /** @type {any} */ let result;
      const profileRequest = handles[PROFILE_STORE].get(PROFILE_ID);
      const memoryRequest = seed ? handles[MEMORY_STORE].get('user') : null;
      let pending = seed ? 2 : 1;
      const finish = () => {
        if (--pending !== 0) return;
        const prior = profileRequest.result;
        if (prior !== undefined && !validProfile(prior)) {
          result = { ok: false, error: 'profile-record-invalid' }; return;
        }
        if (prior?.onboardingComplete && !(prior.onboardingInferred === true && !inferred)) {
          result = { ok: true, profile: prior }; return;
        }
        const timestamp = now();
        const profile = {
          ...(prior ?? { id: PROFILE_ID, createdAt: timestamp }),
          peerName: normalizePeerName(peerName ?? prior?.peerName),
          onboardingComplete: true, onboardedAt: timestamp, onboardingInferred: inferred,
        };
        if (seed) {
          const memory = memoryRequest?.result;
          const body = normalizeMemoryBody(userDocBody(
            /** @type {any} */ (normalized), memory?.body,
          ));
          if (body === null) {
            result = { ok: false, error: 'onboarding-facts-too-large' }; return;
          }
          handles[MEMORY_STORE].put({
            id: 'user', kind: 'user', workspace: '', body,
            createdAt: Number.isFinite(memory?.createdAt) ? memory.createdAt : timestamp,
            updatedAt: timestamp,
          });
        }
        handles[PROFILE_STORE].put(profile);
        result = { ok: true, profile };
      };
      profileRequest.onsuccess = finish;
      if (memoryRequest) memoryRequest.onsuccess = finish;
      return () => result;
    });
  };
  return Object.freeze({
    get: read,
    reconcile: async () => {
      const profile = await read();
      if (profile.onboardingComplete || !await sessions.hasChat()) return profile;
      const result = await latch(profile.peerName, null, true);
      if (!result.ok) throw new Error(result.error);
      current = result.profile;
      return result.profile;
    },
    complete: async (/** @type {any} */ input = {}) => {
      if (!normalizeFacts(input.facts).ok) {
        return { ok: false, error: 'onboarding-facts-invalid' };
      }
      if (loading) await loading;
      if (current?.onboardingComplete && current.onboardingInferred !== true) {
        return { ok: true, profile: current };
      }
      const result = await latch(input.peerName, input.facts);
      if (result.ok) current = result.profile;
      return result;
    },
  });
};

/** @param {any} input */
export const buildVaultKernelState = ({
  kernel, status, locked, unlockedAt, lockReason, autoLockMs,
  settings, session, providers, composer, profile = null,
  generation = 1, actorHost = 'offscreen-document-worker',
}) => {
  if (!locked && !profile) throw new TypeError('kernel-profile-required');
  const state = {
    kernel: Object.freeze({ ...kernel }),
    hydrated: true,
    vault: {
      initialized: status.initialized,
      locked,
      unlockedAt: locked ? 0 : unlockedAt,
      prfEnrolled: status.prfEnrolled,
      hasRecovery: status.hasRecovery,
      lockReason,
    },
    session,
    providers,
    composer,
    ...(!locked ? { profile } : {}),
    capabilities: {
      actorExecution: {
        status: 'temporarily_unavailable', host: actorHost,
        reason: 'controller-not-ready', retryable: true,
      },
    },
    settings: { ...settings, vaultAutoLockMs: autoLockMs },
    projection: {
      schema: KERNEL_STATE_SCHEMA,
      provenance: KERNEL_STATE_PROVENANCE,
      authorityEpoch: kernel.kernelEpoch,
      generation,
      settings: 'hydrated',
      actorIsolation: 'hydrated',
      semanticController: 'required',
      deferredFields: [...KERNEL_STATE_DEFERRED_FIELDS],
      failures: [],
    },
  };
  const checked = validateKernelStateProjection(state);
  if (!checked.ok) throw new TypeError(checked.error);
  return state;
};

// why: a locked worker must answer the first-paint authority route without
// starting the semantic controller or projecting provider/model metadata.
// Empty identities are intentional: the vault shell only needs the fixed
// denial posture, and the rich application cannot mount until unlock.
export const LOCKED_PROVIDER_AUTHORITY_VIEW = Object.freeze({
  providers: Object.freeze({ current: '', model: '', hasKey: false }),
  composer: Object.freeze({
    provider: '', model: '', keyless: false, credentialReady: false,
    localReady: false, canSend: false, reason: 'vault-locked',
  }),
});

/** @param {any} session @param {unknown} cachedMode @param {unknown} cachedConfirm */
export const resolveKernelPermission = (session, cachedMode, cachedConfirm) => {
  const rawMode = session?.permissionMode ?? cachedMode ?? 'act';
  const storedConfirm = typeof session?.confirmActions === 'boolean'
    ? session.confirmActions
    : typeof session?.actTier === 'string' && session.actTier
      ? session.actTier !== 'full-auto' : undefined;
  return {
    mode: rawMode === 'act' ? 'act' : 'plan',
    confirmActions: storedConfirm
      ?? (typeof cachedConfirm === 'boolean' ? cachedConfirm : false),
  };
};

/** @param {ReturnType<typeof buildVaultKernelState>|Record<string, any>} state */
export const projectVaultGateState = (state) => ({
  hydrated: state.hydrated === true,
  vault: {
    initialized: state.vault.initialized,
    locked: state.vault.locked,
    unlockedAt: state.vault.locked ? 0 : state.vault.unlockedAt,
    prfEnrolled: state.vault.prfEnrolled,
    hasRecovery: state.vault.hasRecovery,
    lockReason: state.vault.lockReason ?? null,
  },
  settings: { vaultAutoLockMs: state.settings.vaultAutoLockMs },
});

export const VAULT_KERNEL_ROUTE_NAMES = Object.freeze([
  'vault/initialize',
  'vault/unlock',
  'vault/initializeWithPasskey',
  'vault/setRecoveryPassphrase',
  'vault/lock',
  'vault/prfStatus',
  'vault/enrollPrf',
  'vault/unlockPrf',
  'vault/disablePrf',
]);

export const VAULT_KERNEL_HUMAN_ROUTE_NAMES = Object.freeze([
  ...VAULT_KERNEL_ROUTE_NAMES,
  'settings/update',
  'settings/reset',
]);

/**
 */
/** Exact document ownership; handler-pinned routes stay outside. @param {any} deps */
export const makeKernelRouteProvenance = ({
  humanUi, homeUi, sidepanelUi, optionsUi, appUi, voiceUi,
  evalUi = () => false, activityStopUi = () => false,
  actorSpawnUi = () => false, vaultRoutes,
}) => {
  /** @type {Map<string,(sender:any,message:any)=>boolean>} */
  const table = new Map();
  const add = (/** @type {string[]} */ names,
    /** @type {(sender:any,message:any)=>boolean} */ admits) => {
    for (const name of names) {
      if (table.has(name)) throw new Error(`kernel-route-provenance-duplicate:${name}`);
      table.set(name, admits);
    }
  };
  const anyHumanUi = (/** @type {any} */ sender) => humanUi(sender) || optionsUi(sender);
  add([
    'settings/update', 'settings/reset', 'provider/setKey', 'provider/status', 'provider/test',
    'models/options', ...vaultRoutes,
    'session/list', 'permission/set', 'audit/list', 'cost/total', 'state/get',
  ], anyHumanUi);
  add(['audit/voice-fetch'], voiceUi);
  add(['contacts/list', 'contacts/set', 'contacts/forget'], homeUi);
  add([
    'session/get', 'session/setModel', 'session/contextSnapshots', 'commands/list',
    'onboarding/complete',
    'composer/files', 'composer/tabs', 'apps/list', 'apps/favorite',
    'apps/rename', 'apps/open', 'apps/import-git', 'apps/repository/status',
    'apps/repository/history', 'apps/repository/diff', 'apps/repository/commit',
    'apps/repository/restore', 'apps/repository/branch', 'apps/repository/checkout',
    'apps/repository/link', 'apps/repository/fetch', 'apps/repository/push',
    'denylist/list', 'denylist/add', 'denylist/remove',
    'learned/list', 'learned/forget', 'learned/clear',
  ], humanUi);
  add([
    'skills/list', 'skills/setEnabled', 'skills/remove',
    'skills/installGit', 'skills/installLocal', 'skills/installManifest',
    'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle',
  ], sidepanelUi);
  add(['agent/send'], (sender) => sidepanelUi(sender) || evalUi(sender));
  add(['debug/originLock'], (sender) => sidepanelUi(sender) || evalUi(sender));
  add(['agent/stop'], (sender, message) => sidepanelUi(sender) || evalUi(sender)
    || activityStopUi(sender, message));
  add(['actor/spawn'], actorSpawnUi);
  add(['session/debugBundle'], (sender) => sidepanelUi(sender) || optionsUi(sender));
  add(['session/archive', 'session/switch'], (sender) => sidepanelUi(sender) || homeUi(sender));
  add(['session/reset'], (sender) => sidepanelUi(sender) || homeUi(sender) || evalUi(sender));
  add(['actor-isolation/retry'], sidepanelUi);
  add([
    'git-cred/list', 'git-cred/set', 'git-cred/delete', 'openrouter/models',
    'origin-cred/list', 'origin-cred/set', 'origin-cred/delete',
    'local-model/status', 'local-model/catalog', 'local-model/probe', 'local-model/init',
    'site-client/list', 'site-client/delete',
    'memory/init',
    'memory/export', 'memory/deleteAll', 'memory/write', 'memory/delete',
    'memory/suggestions', 'memory/suggestions/approve', 'memory/suggestions/dismiss',
  ], optionsUi);
  add([
    'app/editor/read', 'app/editor/list', 'app/editor/write', 'app/editor/delete',
    'app/editor-write', 'app/editor-delete',
  ], (sender, message) => typeof message?.appId === 'string' && appUi(sender, message.appId));
  return table;
};

/**
 * @param {{ ready: Promise<unknown>, deps: Record<string, any> }} input
 */
export const makeVaultKernelRoutes = ({ ready, deps }) => {
  const legacy = makeVaultRoutes(deps);
  return Object.freeze(Object.fromEntries(VAULT_KERNEL_ROUTE_NAMES.map((name) => [
    name,
    async (message = {}) => {
      await ready;
      return legacy[name](message);
    },
  ])));
};

/**
 * Keep the nonsecret first-paint index coherent even when a vault mutation
 * rejects after committing part of its storage work. The authority status is
 * still the source of truth; reconciliation failures never replace the
 * original route error.
 *
 * @param {{routes:Record<string,(message?:any)=>Promise<any>>,posture:any,vault:any,pushState:()=>any}} input
 */
export const makeIndexedVaultRoutes = ({ routes, posture, vault, pushState }) =>
  Object.freeze(Object.fromEntries(Object.entries(routes).map(([name, handler]) => [
    name,
    async (message = {}) => {
      const indexed = posture.snapshot() ?? await posture.read();
      if (name === 'vault/prfStatus' && indexed?.initialized === false
          && !vault.isInitialized()) {
        return { ok: true, enrolled: false };
      }
      try {
        const result = await handler(message);
        const discoveredExistingVault = (name === 'vault/initialize'
          || name === 'vault/initializeWithPasskey')
          && result?.error === 'already-initialized';
        if (name !== 'vault/lock' && (result?.ok === true || discoveredExistingVault)) {
          await posture.write(await vault.status());
        }
        return result;
      } catch (cause) {
        try { await posture.write(await vault.status()); }
        catch (error) { console.error('[kernel] vault posture reconciliation failed', error); }
        try { await Promise.resolve(pushState()); }
        catch (error) { console.error('[kernel] vault state reconciliation failed', error); }
        throw cause;
      }
    },
  ])));

/** @param {unknown} value @param {number} fallback */
export const resolveVaultAutoLockMs = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const KERNEL_OUTCOME_UNKNOWN_MESSAGE = 'Peerd could not confirm whether the requested change '
  + 'finished. Refresh to reconcile before trying again.';

/** @param {Record<string, unknown>} reply */
const normalizeKernelReply = (reply) => reply?.ok === false && reply?.outcomeKnown === false
  ? {
      ...reply,
      error: KERNEL_OUTCOME_UNKNOWN_MESSAGE,
      outcomeKnown: false,
      outcomeKind: reply.outcomeKind ?? 'unknown',
      retryable: false,
    }
  : reply;

/** @param {unknown} cause */
const kernelRouteFailure = (cause) => {
  const error = /** @type {{code?:unknown,message?:unknown,outcomeKnown?:unknown}} */ (cause);
  const code = typeof error?.code === 'string'
      && /^[a-z0-9][a-z0-9-]{0,127}$/.test(error.code)
    ? error.code : null;
  const message = typeof error?.message === 'string'
    ? error.message.slice(0, 256) : String(cause).slice(0, 256);
  return {
    ok: false,
    error: error?.outcomeKnown === false ? KERNEL_OUTCOME_UNKNOWN_MESSAGE : message,
    ...(code ? { code } : {}),
    ...(error?.outcomeKnown === false
      ? { outcomeKnown: false, outcomeKind: 'unknown', retryable: false }
      : {}),
  };
};

/** @param {any} deps */
export const makeVaultKernelMessageHandler = ({
  routes, trusted, humanUi, humanRoutes = new Set(VAULT_KERNEL_HUMAN_ROUTE_NAMES),
  routeProvenance = new Map(),
  bindReply = (/** @type {any} */ reply) => reply,
}) => (
  /** @type {any} */ message,
  /** @type {any} */ sender,
  /** @type {(reply: any) => void} */ sendResponse,
) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'malformed-message' });
    return false;
  }
  const exactProvenance = routeProvenance.get(message.type);
  if (!trusted(sender) && !(exactProvenance && exactProvenance(sender, message))) {
    sendResponse({ ok: false, error: 'untrusted-sender' });
    return false;
  }
  if ((exactProvenance && !exactProvenance(sender, message))
      || (!exactProvenance && humanRoutes.has(message.type) && !humanUi(sender))) {
    sendResponse({ ok: false, error: 'vault-route-unauthorized-sender' });
    return false;
  }
  const route = routes[message.type];
  if (!route) return false;
  const settle = (/** @type {Record<string, unknown>} */ reply) =>
    Promise.resolve(bindReply(normalizeKernelReply(reply))).then(sendResponse, () => sendResponse({
      ok: false,
      error: KERNEL_OUTCOME_UNKNOWN_MESSAGE,
      code: 'kernel-generation-retired',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
      retryable: false,
    }));
  // Exact routes refine the immutable browser sender after ingress admission.
  Promise.resolve(route(message, sender)).then(
    (reply) => settle(reply ?? { ok: true }),
    (error) => settle(kernelRouteFailure(error)),
  );
  return true;
};

/** @param {any} deps */
export const prepareVaultKernel = async ({
  applyPosture, readSettings, setAutoLockMs, attemptResume, defaultAutoLockMs,
}) => {
  const posture = await applyPosture();
  const settings = await readSettings().catch(() => null);
  const autoLockMs = resolveVaultAutoLockMs(
    settings?.vaultAutoLockMs,
    defaultAutoLockMs,
  );
  await setAutoLockMs(autoLockMs);
  const resumed = await attemptResume();
  return Object.freeze({ posture, autoLockMs, resumed });
};
