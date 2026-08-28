// @ts-check

import { withDeadline } from '../shared/cold-util.js';
import { createPreviewContributorRoutes } from './kernel-contributor-owner.js';
export {
  CONTRIBUTOR_ACTIVE_CONSENT_KEY, CONTRIBUTOR_PENDING_RECEIPTS_KEY,
  CONTRIBUTOR_PENDING_MAX_RECEIPTS, CONTRIBUTOR_PENDING_RECEIPT_PREFIX,
  CONTRIBUTOR_PENDING_DROP_PREFIX,
  CONTRIBUTOR_STATE_PREFIX,
  createPreviewContributorAuthority, createPreviewContributorRoutes,
} from './kernel-contributor-owner.js';

export const KERNEL_UPDATE_CUSTODY_KEY = 'kernel.updateCustody.v1';
const VERSION = /^\d+(?:\.\d+)*$/;
const validVersion = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length > 0 && value.length <= 64 && VERSION.test(value);
/** @param {string} a @param {string} b */
const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) >= 0 ? a : b;
/** @param {any} value */
const normalize = (value) => ({ schema: 1,
  pendingVersion: validVersion(value?.pendingVersion) ? value.pendingVersion : null,
  notifiedVersion: validVersion(value?.notifiedVersion) ? value.notifiedVersion : null,
  lastCheckAt: Number.isFinite(value?.lastCheckAt) && value.lastCheckAt >= 0 ? value.lastCheckAt : null,
});

export const createKernelUpdateCustody = (/** @type {any} */ {
  runtime, session, ready, isEnabled, isBusy, listWindowClients, isBlockingWindow,
  notify = () => false, now = Date.now,
  scheduleRetry = (/** @type {()=>void} */ fn, /** @type {number} */ delayMs) => setTimeout(fn, delayMs),
  cancelRetry = (/** @type {unknown} */ handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  log = () => {}, operationTimeoutMs = 15_000,
}) => {
  if (![runtime?.reload, runtime?.getManifest, session?.get, session?.set, ready, isEnabled,
    isBusy, listWindowClients, isBlockingWindow].every((value) => typeof value === 'function')
      || !Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new TypeError('kernel-update-custody-config-invalid');
  }

  let tail = Promise.resolve();
  /** @type {Promise<boolean>|null} */ let active = null;
  /** @type {Promise<boolean>|null} */ let check = null;
  /** @type {unknown|null} */ let timer = null;
  let attempts = 0;
  /** @param {()=>Promise<any>|any} operation @param {string} code */
  const bounded = (operation, code) => withDeadline(
    operation, operationTimeoutMs, () => new Error(code),
  );

  const read = async () => normalize(await session.get(KERNEL_UPDATE_CUSTODY_KEY));
  /** @param {(state:ReturnType<typeof normalize>)=>ReturnType<typeof normalize>} mutate */
  const update = (mutate) => {
    const run = tail.then(async () => {
      const next = mutate(await read());
      await session.set(KERNEL_UPDATE_CUSTODY_KEY, next);
      return next;
    });
    tail = run.then(() => {}, () => {});
    return run;
  };
  const clear = () => { if (timer !== null) cancelRetry(timer); timer = null; attempts = 0; };
  const retry = () => {
    if (timer !== null) return;
    const delay = Math.min(15_000 * 2 ** attempts, 120_000);
    attempts = Math.min(attempts + 1, 4);
    timer = scheduleRetry(() => {
      timer = null;
      void apply().catch((error) => { log('[update] apply failed', error); retry(); });
    }, delay);
  };
  const notePending = async (/** @type {string} */ version) => {
    const state = await read();
    if (state.notifiedVersion === version) return;
    if (!notify(`peerd v${version} is downloaded - it installs when peerd goes quiet or the browser restarts.`)) return;
    await update((latest) => ({ ...latest, notifiedVersion: version }));
  };

  const tryApply = async () => {
    await tail;
    const state = await read();
    const version = state.pendingVersion;
    if (!version) { clear(); return false; }
    const installed = runtime.getManifest()?.version;
    if (validVersion(installed)
        && newer(/** @type {string} */ (installed), version) === installed) {
      await update((latest) => ({ ...latest, pendingVersion: null, notifiedVersion: null }));
      clear();
      return false;
    }
    if (isBusy()) { await notePending(version); retry(); return false; }
    let windows;
    try { windows = await bounded(listWindowClients, 'kernel-update-window-timeout'); }
    catch (error) { log('[update] window unavailable', error); retry(); return false; }
    if (!Array.isArray(windows) || windows.some(isBlockingWindow) || isBusy()) {
      await notePending(version); retry(); return false;
    }
    await update((latest) => ({ ...latest, pendingVersion: version }));
    clear();
    runtime.reload();
    return true;
  };
  const apply = () => {
    if (!active) active = tryApply().finally(() => { active = null; });
    return active;
  };

  const remember = async (/** @type {unknown} */ version) => {
    if (!validVersion(version)) return false;
    const exact = /** @type {string} */ (version);
    await update((state) => ({ ...state, pendingVersion: state.pendingVersion
      ? newer(state.pendingVersion, exact) : exact }));
    await ready();
    await apply();
    return true;
  };

  const checkNow = () => {
    if (!check) check = (async () => {
      await ready();
      if (!isEnabled() || typeof runtime.requestUpdateCheck !== 'function') return false;
      const state = await read();
      if (state.lastCheckAt !== null && now() - state.lastCheckAt < 21_600_000) return false;
      try {
        await bounded(
          () => runtime.requestUpdateCheck(), 'kernel-update-check-timeout',
        );
      }
      catch (error) { log('[update] request failed', error); return false; }
      await update((latest) => ({ ...latest, lastCheckAt: now() }));
      return true;
    })().finally(() => { check = null; });
    return check;
  };

  return Object.freeze({
    onUpdateAvailable: (/** @type {{version?:unknown}} */ details) => remember(details?.version),
    recover: async (/** @type {{entries?:any[]}} */ recovery = {}) => {
      const versions = (Array.isArray(recovery.entries) ? recovery.entries : [])
        .filter((entry) => entry?.event === 'runtime.onUpdateAvailable')
        .map((entry) => entry?.payload?.version).filter(validVersion);
      if (versions.length) await remember(versions.reduce((best, version) => newer(best, version)));
      else await apply();
    },
    start: async () => { await ready(); await apply(); await checkNow(); },
    onUiConnect: async () => { await apply(); await checkNow(); },
    onQuiet: apply,
    onSettingsChanged: () => checkNow(),
    checkNow,
  });
};

const disconnect = (/** @type {any} */ port) => {
  try { port?.disconnect?.(); } catch { /* already disconnected */ }
};

const DWEB_IDENTITY_SECRET = 'distributed/identity/v1';
const DWEB_SELF_DISCOVERY_SECRET = 'distributed/self-discovery/v1';
const DWEB_SELF_RECORDS_SECRET = 'distributed/self-records/v1';
const DWEB_SELF_SECRETS = Object.freeze([
  'distributed/device-key/v1',
  DWEB_SELF_DISCOVERY_SECRET,
  DWEB_SELF_RECORDS_SECRET,
]);
const MAX_DWEB_SELF_SECRET_BYTES = 256 * 1024;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DWEB_EFFECT_OPERATIONS = new Set([
  'identity/read', 'identity/create', 'identity/policy', 'identity/commit',
  'self/read', 'self/write',
]);
const DWEB_MUTATION_EFFECTS = new Set(['identity/create', 'identity/commit', 'self/write']);

const safeDwebId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 3 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);
const dwebEffectFailure = (/** @type {string} */ error,
  /** @type {boolean} */ outcomeKnown = true) => outcomeKnown
  ? ({ ok: false, error }) : ({ ok: false, error, outcomeKnown: false });

/** @param {string} value */
const dwebRevision = async (value) => {
  const encoded = new TextEncoder().encode(value);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    encoded.fill(0);
  }
};

/** @param {string} stored */
const dwebPersonDid = (stored) => {
  const material = JSON.parse(stored);
  const binary = atob(material.pub);
  if (binary.length !== 32) throw new Error('identity-material-malformed');
  const bytes = Uint8Array.from([0xed, 0x01, ...Array.from(
    binary, (character) => character.charCodeAt(0),
  )]);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  /** @type {number[]} */ const digits = [];
  for (let index = zeros; index < bytes.length; index++) {
    let carry = bytes[index];
    for (let digit = 0; digit < digits.length; digit++) {
      carry += digits[digit] << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return `did:key:z${'1'.repeat(zeros)}${digits.reverse()
    .map((digit) => BASE58_ALPHABET[digit]).join('')}`;
};

/** @param {any[]} apps */
const dwebIdentityBlockedByApps = (apps) => apps.some((app) => app?.shared === true
  || (app?.dweb?.local === true
    && typeof app.dweb.publisher === 'string' && app.dweb.publisher.length > 0));

/** @param {Record<string,any>} deps */
export const createKernelDwebVaultEffects = ({
  enabled, active, vault, auditLog, listApps,
}) => {
  if (typeof enabled !== 'boolean' || typeof active !== 'function'
      || !vault || typeof vault.isLocked !== 'function'
      || typeof vault.getSecret !== 'function' || typeof vault.setSecret !== 'function'
      || typeof auditLog?.append !== 'function' || typeof listApps !== 'function') {
    throw new TypeError('kernel-dweb-vault-effects-config-invalid');
  }
  const available = () => enabled && active();

  /** @param {string|null} incomingDid */
  const identityPolicy = async (incomingDid) => {
    const selfRecords = await vault.getSecret(DWEB_SELF_RECORDS_SECRET);
    if (selfRecords) {
      try {
        if (JSON.parse(selfRecords)?.certificate?.personDid !== incomingDid) {
          return { allowed: false, reason: 'self-custody-mismatch' };
        }
      } catch { return { allowed: false, reason: 'self-custody-mismatch' }; }
    }
    if (dwebIdentityBlockedByApps(await listApps())) {
      return { allowed: false, reason: 'identity-in-use' };
    }
    return { allowed: true };
  };

  /** @param {string} operation @param {any} [args] */
  const handle = async (operation, args = {}) => {
    if (!available()) return dwebEffectFailure('dweb-disabled');
    if (vault.isLocked()) return dwebEffectFailure('vault-locked');
    if (operation === 'identity/read') {
      try { return { ok: true, value: await vault.getSecret(DWEB_IDENTITY_SECRET) }; }
      catch { return dwebEffectFailure('identity-read-failed'); }
    }
    if (operation === 'identity/policy') {
      if (typeof args?.incomingDid !== 'string') return dwebEffectFailure('incoming-did-required');
      try { return { ok: true, ...await identityPolicy(args.incomingDid) }; }
      catch { return dwebEffectFailure('identity-policy-unavailable'); }
    }
    if (operation === 'identity/create') {
      if (typeof args?.value !== 'string') return dwebEffectFailure('value-required');
      try {
        const existing = await vault.getSecret(DWEB_IDENTITY_SECRET);
        if (existing === args.value) return { ok: true };
        if (existing) return dwebEffectFailure('identity-already-exists');
        if (await vault.getSecret(DWEB_SELF_RECORDS_SECRET)
            || await vault.getSecret(DWEB_SELF_DISCOVERY_SECRET)) {
          return dwebEffectFailure('certificate-only-device');
        }
        if (dwebIdentityBlockedByApps(await listApps())) {
          return dwebEffectFailure('identity-in-use');
        }
        await vault.setSecret(DWEB_IDENTITY_SECRET, args.value);
        void auditLog.append({ type: 'dweb_identity_issued', details: {} }).catch(() => {});
        return { ok: true };
      } catch { return dwebEffectFailure('identity-create-failed', false); }
    }
    if (operation === 'identity/commit') {
      if (typeof args?.value !== 'string' || typeof args?.incomingDid !== 'string') {
        return dwebEffectFailure('identity-commit-invalid');
      }
      if (typeof args.expectedExistingRevision !== 'string'
          && !Object.hasOwn(args, 'expectedExistingDid')) {
        return dwebEffectFailure('identity-cas-required');
      }
      let incomingMaterialDid;
      try { incomingMaterialDid = dwebPersonDid(args.value); }
      catch { return dwebEffectFailure('identity-material-malformed'); }
      if (incomingMaterialDid !== args.incomingDid) {
        return dwebEffectFailure('identity-incoming-mismatch');
      }
      let existing;
      try { existing = await vault.getSecret(DWEB_IDENTITY_SECRET); }
      catch { return dwebEffectFailure('identity-read-failed'); }
      const matchesExpected = async (/** @type {string|null} */ value) => {
        if (value === args.value) return true;
        if (typeof args.expectedExistingRevision === 'string') {
          return typeof value === 'string'
            && await dwebRevision(value) === args.expectedExistingRevision;
        }
        let did = null;
        if (value) {
          try { did = dwebPersonDid(value); } catch { return false; }
        }
        return did === args.expectedExistingDid;
      };
      if (existing === args.value) return { ok: true, committed: true, alreadyApplied: true };
      if (!await matchesExpected(existing)) return dwebEffectFailure('identity-changed');
      let policy;
      try { policy = await identityPolicy(args.incomingDid); }
      catch { return dwebEffectFailure('identity-policy-unavailable'); }
      if (!policy.allowed) return dwebEffectFailure(policy.reason ?? 'identity-in-use');
      try {
        existing = await vault.getSecret(DWEB_IDENTITY_SECRET);
        if (existing === args.value) return { ok: true, committed: true, alreadyApplied: true };
        if (!await matchesExpected(existing)) return dwebEffectFailure('identity-changed');
      } catch { return dwebEffectFailure('identity-read-failed'); }
      try { await vault.setSecret(DWEB_IDENTITY_SECRET, args.value); }
      catch {
        try {
          if (await vault.getSecret(DWEB_IDENTITY_SECRET) === args.value) {
            return { ok: true, committed: true, alreadyApplied: true };
          }
          return dwebEffectFailure('identity-store-failed');
        } catch { return dwebEffectFailure('identity-store-outcome-unknown', false); }
      }
      void auditLog.append({
        type: existing ? 'dweb_identity_replaced' : 'dweb_identity_adopted',
        details: { did: args.incomingDid, previousDid: args.expectedExistingDid ?? null },
      }).catch(() => {});
      return { ok: true, committed: true };
    }
    if (operation !== 'self/read' && operation !== 'self/write') {
      return dwebEffectFailure('identity-effect-unknown');
    }
    if (typeof args?.name !== 'string' || !DWEB_SELF_SECRETS.includes(args.name)) {
      return dwebEffectFailure('secret-not-allowed');
    }
    if (operation === 'self/read') {
      try { return { ok: true, value: await vault.getSecret(args.name) }; }
      catch { return dwebEffectFailure('self-secret-read-failed'); }
    }
    if (typeof args?.value !== 'string') return dwebEffectFailure('value-required');
    if (args.value.length > MAX_DWEB_SELF_SECRET_BYTES) {
      return dwebEffectFailure('value-too-large');
    }
    if (args.name === DWEB_SELF_RECORDS_SECRET) {
      let candidate;
      let previous;
      try {
        candidate = JSON.parse(args.value);
        const stored = await vault.getSecret(DWEB_SELF_RECORDS_SECRET);
        previous = stored ? JSON.parse(stored) : null;
      } catch { return dwebEffectFailure('self-records-malformed'); }
      const nextRoster = candidate?.roster;
      const heldRoster = previous?.roster;
      if (!Number.isSafeInteger(nextRoster?.seq) || typeof nextRoster?.personDid !== 'string'
          || typeof nextRoster?.sig !== 'string') {
        return dwebEffectFailure('self-records-malformed');
      }
      if (heldRoster) {
        if (nextRoster.personDid !== heldRoster.personDid || nextRoster.seq < heldRoster.seq) {
          return dwebEffectFailure('roster-rollback');
        }
        if (nextRoster.seq === heldRoster.seq && nextRoster.sig !== heldRoster.sig) {
          return dwebEffectFailure('roster-equivocation');
        }
      }
      const rootMaterial = await vault.getSecret(DWEB_IDENTITY_SECRET);
      if (rootMaterial) {
        let rootDid;
        try { rootDid = dwebPersonDid(rootMaterial); }
        catch { return dwebEffectFailure('identity-material-malformed'); }
        if (rootDid !== nextRoster.personDid) {
          return dwebEffectFailure('identity-self-mismatch');
        }
      }
    }
    try { await vault.setSecret(args.name, args.value); }
    catch { return dwebEffectFailure('self-secret-store-failed', false); }
    return { ok: true };
  };
  return Object.freeze({ handle });
};

class KernelIdentityTransferError extends Error {
  /** @param {string} code @param {boolean} [outcomeKnown] @param {unknown} [cause] */
  constructor(code, outcomeKnown = true, cause = undefined) {
    super(code, { cause });
    this.name = 'IdentityTransferError';
    this.code = code;
    this.outcomeKnown = outcomeKnown;
  }
}

const makeIdentityLane = () => {
  /** @type {any[]} */ const queue = [];
  let active = false;
  let recoveryDepth = 0;
  const recoveryPending = () => recoveryDepth > 0;
  const recoveryError = () =>
    new KernelIdentityTransferError('identity-recovery-pending', false);
  const pump = () => {
    if (active || recoveryPending() || queue.length === 0) return;
    const entry = queue.shift();
    active = true;
    Promise.resolve().then(entry.operation).then((value) => {
      active = false;
      entry.resolve(value);
      pump();
    }, (cause) => {
      active = false;
      entry.reject(cause);
      pump();
    });
  };
  const withMutation = (/** @type {()=>Promise<any>} */ operation) => {
    if (recoveryPending()) return Promise.reject(recoveryError());
    return new Promise((resolve, reject) => {
      queue.push({ operation, resolve, reject });
      pump();
    });
  };
  const beginRecovery = () => {
    recoveryDepth += 1;
    if (recoveryDepth === 1) {
      for (const entry of queue.splice(0)) entry.reject(recoveryError());
    }
  };
  const endRecovery = () => {
    recoveryDepth = Math.max(0, recoveryDepth - 1);
    if (!recoveryPending()) pump();
  };
  const withRead = (/** @type {()=>Promise<any>} */ operation) =>
    // why: physical-host replacement must keep writes fenced while the new
    // dweb realm reads the already-reconciled durable identity to start. The
    // retiring mutation has released `active`; no later mutation is admitted
    // until recovery ends.
    recoveryPending() && !active
      ? Promise.resolve().then(operation)
      : withMutation(operation);
  return Object.freeze({ withMutation, withRead, beginRecovery, endRecovery });
};

const TRANSFER_EFFECTS = Object.freeze({
  export: new Set(['identity/read']),
  prepare: new Set(['identity/read', 'identity/policy']),
  adopt: new Set(['identity/read', 'identity/policy', 'identity/commit']),
});
const LOCAL_EFFECTS = new Set(['identity/read', 'identity/create', 'self/read', 'self/write']);

/** @param {any} deps */
export const createKernelDwebCustodyOwner = ({
  enabled, ensureDwebFeature = async () => {}, active = () => false,
  retireDwebHost = async () => { throw new Error('dweb-host-retirement-unavailable'); },
  vault, auditLog, listApps = async () => [], timeoutMs = 60_000,
  newId = () => crypto.randomUUID(),
}) => {
  if (typeof enabled !== 'boolean' || typeof ensureDwebFeature !== 'function'
      || typeof active !== 'function' || typeof retireDwebHost !== 'function'
      || typeof newId !== 'function'
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || enabled && (!vault || !auditLog || typeof listApps !== 'function')) {
    throw new TypeError('kernel-dweb-custody-owner-config-invalid');
  }
  const effects = enabled ? createKernelDwebVaultEffects({
    enabled, active, vault, auditLog, listApps,
  }) : null;
  /** @type {any|null} */ let activePort = null;
  /** @type {string|null} */ let authorityId = null;
  /** @type {any|null} */ let activeGrant = null;
  const portWaiters = new Set();
  const calls = new Map();
  const statuses = new Map();
  const recoveries = new Map();
  const lane = makeIdentityLane();

  const post = (/** @type {any} */ port, /** @type {any} */ message) => {
    if (activePort !== port) throw new Error('dweb-custody-port-disconnected');
    port.postMessage(message);
  };
  const respond = (/** @type {any} */ port, /** @type {any} */ message) => {
    try { post(port, message); } catch { /* a lost Port settles through its owner */ }
  };
  const beforeIdentityWrite = (/** @type {any} */ entry) => entry.operation !== 'adopt'
    || (activeGrant?.port === entry.port
      && activeGrant.operationId === entry.operationId
      && activeGrant.commitStarted === false);
  const failPending = (/** @type {any} */ port) => {
    for (const [requestId, entry] of calls) {
      if (entry.port !== port) continue;
      calls.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new KernelIdentityTransferError(
        'dweb-custody-port-disconnected', beforeIdentityWrite(entry),
      ));
    }
    for (const [requestId, entry] of statuses) {
      if (entry.port !== port) continue;
      statuses.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new KernelIdentityTransferError('dweb-custody-status-unavailable', false));
    }
    for (const [requestId, entry] of recoveries) {
      if (entry.port !== port) continue;
      recoveries.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new KernelIdentityTransferError('dweb-custody-recovery-unavailable', false));
    }
  };
  const lose = (/** @type {any} */ port) => {
    if (activePort === port) { activePort = null; authorityId = null; }
    failPending(port);
  };
  const waitForPort = async () => {
    try { await ensureDwebFeature(); }
    catch (cause) {
      throw new KernelIdentityTransferError('dweb-custody-host-unavailable', true, cause);
    }
    if (activePort && authorityId) return activePort;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: /** @type {any} */ (null) };
      waiter.timer = setTimeout(() => {
        portWaiters.delete(waiter);
        reject(new KernelIdentityTransferError('dweb-custody-port-timeout'));
      }, timeoutMs);
      portWaiters.add(waiter);
    });
  };

  /** @param {any} grant @param {any} message */
  const grantFailure = (grant, message) => {
    if (!grant || message.parentOperationId !== grant.operationId) {
      return dwebEffectFailure('identity-grant-invalid');
    }
    const allowed = TRANSFER_EFFECTS[
      /** @type {'export'|'prepare'|'adopt'} */ (grant.operation)
    ];
    if (!allowed.has(message.operation)) {
      return dwebEffectFailure('identity-effect-not-granted');
    }
    if (message.operation === 'identity/policy' && grant.operation === 'adopt'
        && message.args?.incomingDid !== grant.args.options?.expectedIncomingDid) {
      return dwebEffectFailure('identity-incoming-mismatch');
    }
    if (message.operation !== 'identity/commit') return null;
    if (grant.commitStarted) return dwebEffectFailure('identity-commit-already-dispatched', false);
    const approved = grant.args.options ?? {};
    if (message.args?.incomingDid !== approved.expectedIncomingDid) {
      return dwebEffectFailure('identity-incoming-mismatch');
    }
    if (typeof approved.expectedExistingRevision === 'string') {
      if (message.args?.expectedExistingRevision !== approved.expectedExistingRevision) {
        return dwebEffectFailure('identity-cas-mismatch');
      }
    } else if (Object.hasOwn(approved, 'expectedExistingDid')) {
      if (!Object.hasOwn(message.args ?? {}, 'expectedExistingDid')
          || message.args.expectedExistingDid !== approved.expectedExistingDid) {
        return dwebEffectFailure('identity-cas-mismatch');
      }
    } else {
      return dwebEffectFailure('identity-cas-required');
    }
    grant.commitStarted = true;
    return null;
  };

  const handleEffectRequest = (/** @type {any} */ port, /** @type {any} */ message) => {
    if (!safeDwebId(message.requestId) || !DWEB_EFFECT_OPERATIONS.has(message.operation)) return;
    const hasParent = message.parentOperationId !== undefined;
    const grant = hasParent && activeGrant?.port === port ? activeGrant : null;
    const key = JSON.stringify([message.operation, message.args ?? {}]);
    const prior = grant?.effectCalls.get(message.requestId);
    if (prior) {
      if (prior.key !== key) { disconnect(port); return; }
      void prior.promise.then(
        (/** @type {any} */ result) => respond(port, {
          type: 'custody/effect-response', requestId: message.requestId, ok: true, result,
        }),
        () => respond(port, {
          type: 'custody/effect-response', requestId: message.requestId,
          ok: false, error: 'identity-effect-failed', outcomeKnown: false,
        }),
      );
      return;
    }
    const denied = hasParent
      ? grantFailure(grant, message)
      : LOCAL_EFFECTS.has(message.operation) ? null : dwebEffectFailure('identity-grant-required');
    if (denied) {
      respond(port, {
        type: 'custody/effect-response', requestId: message.requestId,
        ok: true, result: denied,
      });
      return;
    }
    const run = () => /** @type {any} */ (effects).handle(message.operation, message.args ?? {});
    const committedAdoptionRead = !hasParent && message.operation === 'identity/read'
      && activeGrant?.port === port && activeGrant.commitSettled === true;
    const operation = grant || message.operation === 'self/read' || committedAdoptionRead
      ? Promise.resolve().then(run)
      : message.operation === 'identity/read'
        ? lane.withRead(run)
        : lane.withMutation(run);
    if (grant) {
      grant.pendingEffects.add(operation);
      grant.effectCalls.set(message.requestId, { key, promise: operation });
      void operation.finally(() => { grant.pendingEffects.delete(operation); }).catch(() => {});
    }
    void operation.then(
      (result) => {
        if (grant && message.operation === 'identity/commit'
            && result?.ok === true && result.committed === true) {
          // why: the stopped dweb realm resumes inside this same adoption and
          // immediately rereads the permanent identity. Mark only the exact
          // acknowledged commit so that read need not wait behind its own
          // outer mutation lane.
          grant.commitSettled = true;
        }
        respond(port, {
          type: 'custody/effect-response', requestId: message.requestId, ok: true, result,
        });
      },
      () => respond(port, {
        type: 'custody/effect-response', requestId: message.requestId,
        ok: false, error: 'identity-effect-failed', outcomeKnown: false,
      }),
    );
  };

  const attachDwebCustody = (/** @type {any} */ port) => {
    if (!enabled || !port || typeof port.postMessage !== 'function'
        || typeof port.disconnect !== 'function'
        || typeof port.onMessage?.addListener !== 'function'
        || typeof port.onDisconnect?.addListener !== 'function') {
      throw new TypeError('kernel-dweb-custody-port-invalid');
    }
    if (activePort && activePort !== port) disconnect(activePort);
    activePort = port;
    authorityId = null;
    port.onMessage.addListener((/** @type {any} */ message) => {
      if (activePort !== port) return;
      if (message?.type === 'custody/ready' && safeDwebId(message.authorityId)) {
        authorityId = message.authorityId;
        for (const waiter of portWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(port);
        }
        portWaiters.clear();
        return;
      }
      if (message?.type === 'custody/response'
          && safeDwebId(message.requestId) && safeDwebId(message.operationId)
          && message.authorityId === authorityId) {
        const entry = calls.get(message.requestId);
        if (!entry || entry.port !== port || entry.operationId !== message.operationId) return;
        calls.delete(message.requestId);
        clearTimeout(entry.timer);
        const failedBeforeWrite = entry.operation !== 'adopt'
          || (message.phase === 'inspection'
            && activeGrant?.port === port
            && activeGrant.operationId === entry.operationId
            && activeGrant.commitStarted === false);
        const outcomeKnown = message.outcomeKnown !== false || failedBeforeWrite;
        if (message.ok || outcomeKnown) {
          respond(port, { type: 'custody/ack', operationId: entry.operationId });
        }
        if (message.ok) entry.resolve(message.result);
        else {
          const error = /** @type {KernelIdentityTransferError & {retireHost?:boolean}} */ (
            new KernelIdentityTransferError(
              typeof message.error === 'string' ? message.error : 'dweb-custody-host-failed',
              outcomeKnown,
            )
          );
          if (message.error === 'identity-custody-operation-timeout'
              && message.phase === 'inspection') {
            error.retireHost = true;
            entry.reject(error);
          } else entry.reject(error);
        }
        return;
      }
      if (message?.type === 'custody/status-response'
          && safeDwebId(message.requestId) && safeDwebId(message.operationId)
          && message.authorityId === authorityId) {
        const entry = statuses.get(message.requestId);
        if (!entry || entry.port !== port || entry.operationId !== message.operationId) return;
        statuses.delete(message.requestId);
        clearTimeout(entry.timer);
        entry.resolve({ receipt: message.receipt, hostState: message.hostState });
        return;
      }
      if (message?.type === 'custody/recover-response'
          && safeDwebId(message.requestId) && safeDwebId(message.operationId)
          && message.authorityId === authorityId) {
        const entry = recoveries.get(message.requestId);
        if (!entry || entry.port !== port || entry.operationId !== message.operationId) return;
        recoveries.delete(message.requestId);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new KernelIdentityTransferError(
          typeof message.error === 'string' ? message.error : 'dweb-custody-recovery-failed',
          message.outcomeKnown !== false,
        ));
        return;
      }
      if (message?.type === 'custody/effect-request') handleEffectRequest(port, message);
    });
    port.onDisconnect.addListener(() => { lose(port); });
  };

  const status = (/** @type {any} */ port, /** @type {string} */ operation,
    /** @type {any} */ args) => {
    const requestId = `status:${newId()}`;
    const operationId = `query:${newId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        statuses.delete(requestId);
        reject(new KernelIdentityTransferError('dweb-custody-status-timeout', false));
      }, timeoutMs);
      statuses.set(requestId, { port, operationId, resolve, reject, timer });
      try { post(port, { type: 'custody/status', requestId, operationId, operation, args }); }
      catch (cause) {
        statuses.delete(requestId);
        clearTimeout(timer);
        reject(new KernelIdentityTransferError('dweb-custody-status-unavailable', false, cause));
      }
    });
  };

  const recover = (/** @type {any} */ port, /** @type {string} */ operationId,
    /** @type {string} */ operation, /** @type {any} */ args) => {
    const requestId = `recover:${newId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recoveries.delete(requestId);
        reject(new KernelIdentityTransferError('dweb-custody-recovery-timeout', false));
      }, Math.min(timeoutMs, 5_000));
      recoveries.set(requestId, { port, operationId, resolve, reject, timer });
      try { post(port, { type: 'custody/recover', requestId, operationId, operation, args }); }
      catch (cause) {
        recoveries.delete(requestId);
        clearTimeout(timer);
        reject(new KernelIdentityTransferError('dweb-custody-recovery-unavailable', false, cause));
      }
    });
  };

  const request = (/** @type {any} */ port, /** @type {string} */ operation,
    /** @type {string} */ operationId, /** @type {any} */ args) => {
    const requestId = `request:${newId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(requestId);
        const outcomeKnown = beforeIdentityWrite({ port, operation, operationId });
        disconnect(port);
        const error = /** @type {KernelIdentityTransferError & {retireHost?:boolean}} */ (
          new KernelIdentityTransferError(
            'dweb-custody-operation-timeout', outcomeKnown,
          )
        );
        error.retireHost = outcomeKnown;
        reject(error);
      }, timeoutMs);
      calls.set(requestId, { port, operation, operationId, resolve, reject, timer });
      try {
        post(port, { type: 'custody/request', requestId, operationId, operation, args });
      } catch (cause) {
        calls.delete(requestId);
        clearTimeout(timer);
        reject(new KernelIdentityTransferError(
          'dweb-custody-post-failed', true, cause,
        ));
      }
    });
  };

  const approvedAdoption = (/** @type {any} */ args) =>
    typeof args.options?.expectedIncomingDid === 'string'
    && (typeof args.options?.expectedExistingRevision === 'string'
      || Object.hasOwn(args.options ?? {}, 'expectedExistingDid'));

  const reconcileAdoption = async (/** @type {any} */ args) => {
    const read = await /** @type {any} */ (effects).handle('identity/read', {});
    if (read?.ok !== true) {
      throw new KernelIdentityTransferError(
        read?.error ?? 'identity-read-failed', false,
      );
    }
    try {
      const value = typeof read.value === 'string' ? read.value : null;
      let did = null;
      if (value) { try { did = dwebPersonDid(value); } catch { /* revision may still match */ } }
      const options = args.options ?? {};
      if (did === options.expectedIncomingDid) return 'incoming';
      if (typeof options.expectedExistingRevision === 'string') {
        return value && await dwebRevision(value) === options.expectedExistingRevision
          ? 'expected' : 'changed';
      }
      return did === options.expectedExistingDid ? 'expected' : 'changed';
    } catch (cause) {
      throw new KernelIdentityTransferError('identity-reconciliation-failed', false, cause);
    }
  };

  const recoveredAdoption = (/** @type {any} */ args) => {
    const options = args.options ?? {};
    const repaired = typeof options.expectedExistingRevision === 'string';
    const replaced = repaired || options.expectedExistingDid !== null;
    return {
      adopted: true,
      did: options.expectedIncomingDid,
      incomingDid: options.expectedIncomingDid,
      existingDid: options.expectedExistingDid ?? null,
      reason: repaired ? 'replaced-invalid-local' : replaced ? 'replaced' : 'recovered',
      runtimeRecoveryPending: true,
    };
  };

  const enqueueTransfer = (/** @type {any} */ port,
    /** @type {'export'|'prepare'|'adopt'} */ operation, /** @type {any} */ args,
    /** @type {{freshHost?:boolean}} */ context = {}) =>
    new Promise((resolve, reject) => {
      let visibleSettled = false;
      /** @type {{kind:'result',value:any}|{kind:'retry'}|{kind:'error',value:any}|null} */
      let retirementPlan = null;
      const settle = (/** @type {boolean} */ ok, /** @type {any} */ value) => {
        if (visibleSettled) return;
        visibleSettled = true;
        if (ok) resolve(value); else reject(value);
      };
      const deferRetirement = (/** @type {Exclude<typeof retirementPlan, null>} */ plan) => {
        if (retirementPlan) throw new Error('dweb-custody-retirement-already-planned');
        retirementPlan = plan;
        lane.beginRecovery();
      };
      const job = lane.withMutation(async () => {
        let operationId = `operation:${newId()}`;
        try {
          if (operation === 'adopt') {
            if (!approvedAdoption(args)) {
              throw new KernelIdentityTransferError('dweb-custody-approval-required');
            }
            /** @type {any} */
            let statusResult = { receipt: { state: 'missing' } };
            if (!context.freshHost) {
              try {
                statusResult = await status(port, operation, args);
              } catch {
                const identity = await reconcileAdoption(args);
                if (identity === 'incoming') {
                  deferRetirement({ kind: 'result', value: recoveredAdoption(args) });
                  return;
                }
                if (identity === 'changed') {
                  deferRetirement({
                    kind: 'error', value: new KernelIdentityTransferError('identity-changed'),
                  });
                  return;
                }
                deferRetirement({ kind: 'retry' });
                return;
              }
            }
            const receipt = statusResult?.receipt;
            if (receipt?.state === 'succeeded' && safeDwebId(receipt.operationId)) {
              respond(port, { type: 'custody/ack', operationId: receipt.operationId });
              settle(true, receipt.result);
              return;
            }
            if (receipt?.state === 'failed' || receipt?.state === 'unknown') {
              const outcomeKnown = receipt.outcomeKnown !== false
                || receipt.phase === 'inspection';
              if (outcomeKnown && safeDwebId(receipt.operationId)) {
                respond(port, { type: 'custody/ack', operationId: receipt.operationId });
              }
              if (outcomeKnown || !safeDwebId(receipt.operationId)) {
                if (receipt.error === 'identity-custody-operation-timeout'
                    && receipt.phase === 'inspection' && safeDwebId(receipt.operationId)) {
                  deferRetirement({ kind: 'retry' });
                  return;
                } else {
                  throw new KernelIdentityTransferError(
                    receipt.error ?? 'dweb-custody-host-failed', outcomeKnown,
                  );
                }
              } else {
                const identity = await reconcileAdoption(args);
                if (identity === 'incoming') {
                  try {
                    await recover(port, receipt.operationId, operation, args);
                    respond(port, { type: 'custody/ack', operationId: receipt.operationId });
                  } catch {
                    deferRetirement({ kind: 'result', value: recoveredAdoption(args) });
                    return;
                  }
                  settle(true, recoveredAdoption(args));
                  return;
                }
                if (receipt.phase === 'suspending') {
                  deferRetirement({ kind: 'retry' });
                  return;
                } else if (receipt.phase === 'commit-dispatched'
                    || receipt.phase === 'recovering') {
                  await recover(port, receipt.operationId, operation, args);
                  respond(port, { type: 'custody/ack', operationId: receipt.operationId });
                } else {
                  throw new KernelIdentityTransferError(
                    receipt.error ?? 'dweb-custody-host-failed', false,
                  );
                }
                if (identity === 'changed') {
                  throw new KernelIdentityTransferError('identity-changed');
                }
              }
            }
            if (receipt?.state === 'pending' && safeDwebId(receipt.operationId)) {
              operationId = receipt.operationId;
            }
          }
          const grant = {
            port, operation, operationId, args, commitStarted: false,
            commitSettled: false, pendingEffects: new Set(), effectCalls: new Map(),
          };
          activeGrant = grant;
          try {
            const result = await request(port, operation, operationId, args);
            settle(true, result);
          } catch (cause) {
            if (/** @type {{retireHost?:boolean}} */ (cause)?.retireHost === true) {
              deferRetirement({ kind: 'error', value: cause });
            } else if (operation === 'adopt'
                && /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === false) {
              const identity = await reconcileAdoption(args);
              if (identity === 'incoming') {
                // why: the durable DID is stronger evidence than a lost host
                // receipt. Retire the uncertain runtime, but do not turn a
                // proven commit back into a user-visible failure if teardown
                // itself loses its acknowledgement.
                deferRetirement({ kind: 'result', value: recoveredAdoption(args) });
              } else if (identity === 'changed') {
                settle(false, new KernelIdentityTransferError('identity-changed'));
              } else settle(false, cause);
            } else settle(false, cause);
          } finally {
            if (grant.pendingEffects.size > 0) {
              lane.beginRecovery();
              while (grant.pendingEffects.size > 0) {
                await Promise.allSettled([...grant.pendingEffects]);
              }
              lane.endRecovery();
            }
            if (activeGrant === grant) activeGrant = null;
          }
        } catch (cause) {
          settle(false, cause);
        }
      });
      void job.then(async () => {
        const plan = retirementPlan;
        if (!plan) return;
        let retirementError = null;
        try { await retireDwebHost(); }
        catch (cause) { retirementError = cause; }
        finally { lane.endRecovery(); }
        if (plan.kind === 'result') {
          // why: reconciliation already proved the durable incoming DID. A
          // failed physical restart remains explicit in this result and can
          // be retried, but it cannot turn a landed single commit into failure.
          settle(true, plan.value);
          return;
        }
        if (plan.kind === 'error') {
          settle(false, plan.value);
          return;
        }
        if (retirementError) {
          settle(false, new KernelIdentityTransferError(
            'dweb-custody-host-retirement-failed', true, retirementError,
          ));
          return;
        }
        try {
          const next = enqueueTransfer(await waitForPort(), operation, args, { freshHost: true });
          void next.then((value) => settle(true, value), (cause) => settle(false, cause));
        } catch (cause) { settle(false, cause); }
      }, (cause) => { settle(false, cause); });
    });

  const call = async (/** @type {'export'|'prepare'|'adopt'} */ operation,
    /** @type {any} */ args) => enqueueTransfer(await waitForPort(), operation, args);
  const dwebTransfer = Object.freeze({
    exportRecord: (/** @type {string} */ passphrase) => call('export', { passphrase }),
    prepareRecord: (/** @type {any} */ record, /** @type {string} */ passphrase,
      /** @type {any} */ options = {}) => call('prepare', { record, passphrase, options }),
    adoptRecord: (/** @type {any} */ record, /** @type {string} */ passphrase,
      /** @type {any} */ options = {}) => call('adopt', { record, passphrase, options }),
  });
  const live = Object.freeze({ dwebTransfer, withIdentityMutation: lane.withMutation });
  return Object.freeze({
    attachDwebCustody,
    getDwebLive: async () => enabled ? live : null,
    getDwebTransfer: async () => enabled ? dwebTransfer : null,
  });
};

const createUpdateCustody = (/** @type {any} */ c) => createKernelUpdateCustody({
  runtime: c.browser.runtime,
  session: {
    get: async (/** @type {string} */ key) =>
      (await c.browser.storage.session.get(key))?.[key],
    set: async (/** @type {string} */ key, /** @type {any} */ value) => {
      await c.browser.storage.session.set({ [key]: value });
    },
  },
  ready: async () => { await c.kernelReady; },
  isEnabled: () => c.settingsStore.get().autoUpdateEnabled === true,
  isBusy: () => c.uiPorts.size > 0 || Object.entries(
    c.featureHost.runtime.snapshot()?.leases ?? {},
  ).some(([scope, lease]) => !['dweb', 'vault-authority'].includes(scope)
    && ['starting', 'active', 'unknown'].includes(lease?.status)),
  listWindowClients: async () => {
    const clients = /** @type {any} */ (globalThis).clients;
    if (!clients?.matchAll) throw new Error('kernel-update-window-oracle-unavailable');
    return clients.matchAll({ type: 'window' });
  },
  isBlockingWindow: (/** @type {any} */ client) => client?.url !== c.offscreenUrl,
  notify: (/** @type {string} */ text) => {
    if (c.uiPorts.size === 0) return false;
    c.uiPorts.broadcast({ type: 'turn/system-note', text });
    return true;
  },
  log: (/** @type {any[]} */ ...args) => console.log('[kernel]', ...args),
});

export const previewTargetAddon = Object.freeze({
  target: 'preview-chrome', update: createUpdateCustody,
  dwebCustody: createKernelDwebCustodyOwner,
  contributor: createPreviewContributorRoutes,
});

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.target-addon.v1');
if (root[addonId]) throw new Error('kernel-target-addon-owner-conflict');
root[addonId] = previewTargetAddon;
