// @ts-check

import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_OFFER,
  CONTRIBUTOR_ACTION_KINDS, CONTRIBUTOR_BROWSERS, CONTRIBUTOR_CHANNELS,
  CONTRIBUTOR_FAILURES, CONTRIBUTOR_FALLBACKS, CONTRIBUTOR_MODEL_FAMILIES,
  CONTRIBUTOR_OUTCOMES, CONTRIBUTOR_PROVIDERS, CONTRIBUTOR_SURFACES,
  CONTRIBUTOR_CHANNEL_PROTOCOL, CONTRIBUTOR_CHANNEL_REPLY,
  CONTRIBUTOR_CHANNEL_RESULT, contributorPayloadFits, parseContributorOffer,
} from '../shared/contributor-channel.js';
import { withDeadline } from '../shared/cold-util.js';

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
  let recoveryPending = false;
  const recoveryError = () =>
    new KernelIdentityTransferError('identity-recovery-pending', false);
  const pump = () => {
    if (active || recoveryPending || queue.length === 0) return;
    const entry = queue.shift();
    active = true;
    Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
      active = false;
      pump();
    });
  };
  const withMutation = (/** @type {()=>Promise<any>} */ operation) => {
    if (recoveryPending) return Promise.reject(recoveryError());
    return new Promise((resolve, reject) => {
      queue.push({ operation, resolve, reject });
      pump();
    });
  };
  const beginRecovery = () => {
    if (recoveryPending) return;
    recoveryPending = true;
    for (const entry of queue.splice(0)) entry.reject(recoveryError());
  };
  const endRecovery = () => {
    recoveryPending = false;
  };
  return Object.freeze({ withMutation, beginRecovery, endRecovery });
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
    const operation = grant || message.operation === 'self/read'
      ? Promise.resolve().then(run)
      : lane.withMutation(run);
    if (grant) {
      grant.pendingEffects.add(operation);
      grant.effectCalls.set(message.requestId, { key, promise: operation });
      void operation.finally(() => { grant.pendingEffects.delete(operation); }).catch(() => {});
    }
    void operation.then(
      (result) => respond(port, {
        type: 'custody/effect-response', requestId: message.requestId, ok: true, result,
      }),
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
          const error = new KernelIdentityTransferError(
            typeof message.error === 'string' ? message.error : 'dweb-custody-host-failed',
            outcomeKnown,
          );
          if (message.error === 'identity-custody-operation-timeout'
              && message.phase === 'inspection') {
            void Promise.resolve().then(retireDwebHost).then(
              () => entry.reject(error), () => entry.reject(error),
            );
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
        const error = new KernelIdentityTransferError(
          'dweb-custody-operation-timeout', outcomeKnown,
        );
        if (outcomeKnown) {
          void Promise.resolve().then(retireDwebHost).then(
            () => reject(error), () => reject(error),
          );
        } else reject(error);
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
    /** @type {'export'|'prepare'|'adopt'} */ operation, /** @type {any} */ args) =>
    new Promise((resolve, reject) => {
      let visibleSettled = false;
      const settle = (/** @type {boolean} */ ok, /** @type {any} */ value) => {
        if (visibleSettled) return;
        visibleSettled = true;
        if (ok) resolve(value); else reject(value);
      };
      const job = lane.withMutation(async () => {
        let operationId = `operation:${newId()}`;
        try {
          if (operation === 'adopt') {
            if (!approvedAdoption(args)) {
              throw new KernelIdentityTransferError('dweb-custody-approval-required');
            }
            let statusResult;
            try {
              statusResult = await status(port, operation, args);
            } catch {
              const identity = await reconcileAdoption(args);
              try { await retireDwebHost(); }
              catch (retireCause) {
                if (identity === 'incoming') {
                  settle(true, recoveredAdoption(args));
                  return;
                }
                if (identity === 'changed') {
                  throw new KernelIdentityTransferError('identity-changed');
                }
                throw new KernelIdentityTransferError(
                  'dweb-custody-host-retirement-failed', true, retireCause,
                );
              }
              if (identity === 'incoming') {
                settle(true, recoveredAdoption(args));
                return;
              }
              if (identity === 'changed') {
                throw new KernelIdentityTransferError('identity-changed');
              }
              port = await waitForPort();
              statusResult = { receipt: { state: 'missing' } };
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
                  await retireDwebHost();
                  port = await waitForPort();
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
                    try { await retireDwebHost(); } catch { /* durable identity is authoritative */ }
                  }
                  settle(true, recoveredAdoption(args));
                  return;
                }
                if (receipt.phase === 'suspending') {
                  await retireDwebHost();
                  port = await waitForPort();
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
            pendingEffects: new Set(), effectCalls: new Map(),
          };
          activeGrant = grant;
          try {
            const result = await request(port, operation, operationId, args);
            settle(true, result);
          } catch (cause) {
            settle(false, cause);
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
      void job.catch((cause) => { settle(false, cause); });
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

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.target-addon.v1');
if (root[addonId]) throw new Error('kernel-target-addon-owner-conflict');
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

export const CONTRIBUTOR_PENDING_RECEIPTS_KEY = 'contributor_metrics.pending.v1';
export const CONTRIBUTOR_PENDING_MAX_RECEIPTS = 64;
const CONTRIBUTOR_RECORD_KEY = 'contributor_metrics.aggregate.v1';
const CONTRIBUTOR_MAX_TEXT = 200;
const CONTRIBUTOR_MAX_ACTIONS = 128;
const CONTRIBUTOR_MAX_COUNTER = 1_000_000_000;
const exactKeys = (/** @type {unknown} */ value, /** @type {string[]} */ keys) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const boundedText = (/** @type {unknown} */ value, nullable = false) => nullable && value == null
  ? null : typeof value === 'string' && value.length > 0 && value.length <= CONTRIBUTOR_MAX_TEXT
    ? value : undefined;
const armFromRecord = (/** @type {any} */ record) => {
  if (!exactKeys(record, ['version', 'consent', 'aggregate']) || record.version !== 1
      || !exactKeys(record.consent, [
        'enabled', 'schemaVersion', 'disclosureVersion', 'generation',
      ]) || record.consent.enabled !== true || record.consent.schemaVersion !== 1
      || record.consent.disclosureVersion !== 1
      || boundedText(record.consent.generation) === undefined
      || !record.aggregate || typeof record.aggregate !== 'object'
      || Array.isArray(record.aggregate)) {
    return Object.freeze({ enabled: false, generation: null });
  }
  return Object.freeze({ enabled: true, generation: record.consent.generation });
};
const normalizePendingReceipt = (/** @type {any} */ value) => {
  const keys = [
    'version', 'consentGeneration', 'operationKey', 'feedbackContextKey', 'decision',
    'browser', 'extensionVersion', 'channel', 'provider', 'modelFamily', 'durationMs',
    'tokens', 'outcome', 'failure', 'actions',
  ];
  if (!exactKeys(value, keys) || value.version !== 1
      || boundedText(value.consentGeneration) === undefined
      || boundedText(value.operationKey) === undefined
      || boundedText(value.feedbackContextKey, true) === undefined
      || !exactKeys(value.decision, ['requested', 'resolved', 'fallback'])
      || !CONTRIBUTOR_SURFACES.includes(value.decision.requested)
      || !CONTRIBUTOR_SURFACES.includes(value.decision.resolved)
      || !CONTRIBUTOR_FALLBACKS.includes(value.decision.fallback)
      || !CONTRIBUTOR_BROWSERS.includes(value.browser)
      || typeof value.extensionVersion !== 'string'
      || !/^0\.[0-9]{1,4}\.[0-9]{1,4}$/.test(value.extensionVersion)
      || !CONTRIBUTOR_CHANNELS.includes(value.channel)
      || !CONTRIBUTOR_PROVIDERS.includes(value.provider)
      || !CONTRIBUTOR_MODEL_FAMILIES.includes(value.modelFamily)
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
      || value.durationMs > CONTRIBUTOR_MAX_COUNTER
      || !Number.isSafeInteger(value.tokens) || value.tokens < 0
      || value.tokens > CONTRIBUTOR_MAX_COUNTER
      || !CONTRIBUTOR_OUTCOMES.includes(value.outcome)
      || !CONTRIBUTOR_FAILURES.includes(value.failure)
      || !Array.isArray(value.actions) || value.actions.length > CONTRIBUTOR_MAX_ACTIONS
      || value.actions.some((/** @type {unknown} */ action) =>
        !CONTRIBUTOR_ACTION_KINDS.includes(/** @type {any} */ (action)))) return null;
  return Object.freeze({
    version: 1,
    consentGeneration: value.consentGeneration,
    operationKey: value.operationKey,
    feedbackContextKey: value.feedbackContextKey,
    decision: Object.freeze({ ...value.decision }),
    browser: value.browser,
    extensionVersion: value.extensionVersion,
    channel: value.channel,
    provider: value.provider,
    modelFamily: value.modelFamily,
    durationMs: value.durationMs,
    tokens: value.tokens,
    outcome: value.outcome,
    failure: value.failure,
    actions: Object.freeze([...value.actions]),
  });
};
const normalizePendingRecord = (/** @type {any} */ value) => {
  if (value == null) return Object.freeze({ version: 1, receipts: Object.freeze([]) });
  if (!exactKeys(value, ['version', 'receipts']) || value.version !== 1
      || !Array.isArray(value.receipts)
      || value.receipts.length > CONTRIBUTOR_PENDING_MAX_RECEIPTS) return null;
  const receipts = value.receipts.map(normalizePendingReceipt);
  return receipts.every(Boolean)
    ? Object.freeze({ version: 1, receipts: Object.freeze(receipts) }) : null;
};

export const createPreviewContributorAuthority = (/** @type {any} */ { kv }) => {
  if (!kv?.get || !kv?.set || !kv?.delete) {
    throw new TypeError('kernel-preview-contributor-config-invalid');
  }
  let tail = Promise.resolve();
  const effect = (/** @type {()=>Promise<any>} */ run) => {
    const task = tail.then(run, run);
    tail = task.then(() => {}, () => {});
    return task;
  };
  const routes = Object.freeze({
    read: 'contributor/status',
    'enable-read': 'contributor/enable',
    enable: 'contributor/enable',
    'disable-read': 'contributor/disable',
    clear: 'contributor/disable',
    'settlement-read': 'contributor/settlement',
    'settlement-record': 'contributor/settlement',
    'feedback-read': 'contributor/feedback',
    'feedback-record': 'contributor/feedback',
  });
  const handle = async (/** @type {string} */ op, /** @type {any} */ payload,
    /** @type {any} */ ctx) => {
    const kind = op.startsWith('semantic.contributor.') ? op.slice(21) : '';
    const route = routes[/** @type {keyof typeof routes} */ (kind)] ?? null;
    const surface = route === 'contributor/feedback' ? 'chat'
      : route === 'contributor/settlement' ? 'runtime'
        : 'options';
    const write = kind === 'enable' || kind === 'clear' || kind.endsWith('-record');
    if (!route || ctx?.authority?.target !== `semantic:${route}:${surface}`) return null;
    if (ctx.signal?.aborted || ctx.deadlineAt <= Date.now()) {
      return { ok: false, code: 'semantic-kernel-operation-expired', outcomeKnown: true };
    }
    const run = async () => {
      if (kind === 'read' || kind.endsWith('-read')) return kv.get(CONTRIBUTOR_RECORD_KEY);
      if (kind === 'clear') {
        await kv.delete(CONTRIBUTOR_RECORD_KEY); return { ok: true };
      }
      if (kind.endsWith('-record')) {
        const current = await kv.get(CONTRIBUTOR_RECORD_KEY);
        const expected = payload?.expected ?? null;
        const value = payload?.value;
        const exactRecordShape = value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).sort().join('\0') === ['aggregate', 'consent', 'version'].join('\0');
        const unchangedConsent = JSON.stringify(current?.consent ?? null)
          === JSON.stringify(value?.consent ?? null);
        if (JSON.stringify(current ?? null) !== JSON.stringify(expected)
            || !exactRecordShape || value.version !== 1 || !unchangedConsent
            || current?.consent?.enabled !== true) {
          return { ok: false, error: 'contributor-state-changed' };
        }
        await kv.set(CONTRIBUTOR_RECORD_KEY, value);
        return { ok: true };
      }
      const current = await kv.get(CONTRIBUTOR_RECORD_KEY);
      if (JSON.stringify(current ?? null) !== JSON.stringify(payload?.expected ?? null)) {
        return { ok: false, error: 'contributor-state-changed' };
      }
      const value = { version: 1,
        consent: { enabled: true, schemaVersion: 1, disclosureVersion: 1,
          generation: crypto.randomUUID() },
        aggregate: { version: 1, rows: {}, dedupe: [], contexts: {}, contextOrder: [],
          feedback: {}, feedbackOrder: [] } };
      await kv.set(CONTRIBUTOR_RECORD_KEY, value);
      return { ok: true, value };
    };
    try {
      const value = write ? await effect(run) : await run();
      return { ok: true, outcomeKnown: true, value };
    } catch {
      return { ok: false, code: 'semantic-contributor-operation-failed',
        outcomeKnown: !write };
    }
  };
  const arm = async () => {
    await tail;
    return armFromRecord(await kv.get(CONTRIBUTOR_RECORD_KEY));
  };
  const pending = async () => {
    await tail;
    const record = normalizePendingRecord(await kv.get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!record) throw new Error('contributor-pending-record-invalid');
    return [...record.receipts];
  };
  const appendPending = (/** @type {any} */ input) => effect(async () => {
    const receipt = normalizePendingReceipt(input);
    if (!receipt) return { ok: false, code: 'contributor-pending-receipt-invalid' };
    const armSnapshot = armFromRecord(await kv.get(CONTRIBUTOR_RECORD_KEY));
    if (armSnapshot.enabled !== true || armSnapshot.generation !== receipt.consentGeneration) {
      return { ok: true, queued: false, reason: 'disabled' };
    }
    const current = normalizePendingRecord(await kv.get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!current) return { ok: false, code: 'contributor-pending-record-invalid' };
    const existing = current.receipts.find((/** @type {any} */ item) =>
      item.operationKey === receipt.operationKey);
    if (existing) return { ok: true, queued: false, reason: 'duplicate' };
    if (current.receipts.length >= CONTRIBUTOR_PENDING_MAX_RECEIPTS) {
      return { ok: false, code: 'contributor-pending-receipts-full' };
    }
    await kv.set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, {
      version: 1, receipts: [...current.receipts, receipt],
    });
    return { ok: true, queued: true };
  });
  const removePending = (/** @type {string} */ operationKey) => effect(async () => {
    const current = normalizePendingRecord(await kv.get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!current) throw new Error('contributor-pending-record-invalid');
    const receipts = current.receipts.filter((/** @type {any} */ item) =>
      item.operationKey !== operationKey);
    if (receipts.length === current.receipts.length) return false;
    if (receipts.length === 0) await kv.delete(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
    else await kv.set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, { version: 1, receipts });
    return true;
  });
  const clearPending = () => effect(() => kv.delete(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
  return Object.freeze({
    handle, arm, pending, appendPending, removePending, clearPending,
  });
};

export const createPreviewContributorRoutes = (/** @type {any} */ {
  kv, optionsUi, sidepanelUi, homeUi, validateFeedback, offscreenUrl, featureHost,
  scheduleDrain = (/** @type {()=>void} */ operation) => queueMicrotask(operation),
  channelDeadlineMs = 15_000,
}) => {
  if (![optionsUi, sidepanelUi, homeUi, validateFeedback].every(
    (value) => typeof value === 'function') || typeof scheduleDrain !== 'function'
      || typeof offscreenUrl !== 'string' || !Number.isFinite(channelDeadlineMs)
      || channelDeadlineMs <= 0
      || typeof featureHost?.runtime?.runWithLease !== 'function') {
    throw new TypeError('kernel-preview-contributor-routes-invalid');
  }
  const authority = createPreviewContributorAuthority({ kv });
  let mutationTail = Promise.resolve();
  const mutate = (/** @type {()=>Promise<any>} */ operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const allowed = Object.freeze({
    'contributor/status': Object.freeze({ 'semantic.contributor.read': 1 }),
    'contributor/enable': Object.freeze({
      'semantic.contributor.enable-read': 2, 'semantic.contributor.enable': 1,
    }),
    'contributor/disable': Object.freeze({
      'semantic.contributor.clear': 1, 'semantic.contributor.disable-read': 1,
    }),
    'contributor/settlement': Object.freeze({
      'semantic.contributor.settlement-read': 1,
      'semantic.contributor.settlement-record': 1,
    }),
    'contributor/feedback': Object.freeze({
      'semantic.contributor.feedback-read': 1,
      'semantic.contributor.feedback-record': 1,
    }),
  });
  const dispatch = async (/** @type {string} */ route,
    /** @type {any} */ message) => {
    if (!Object.hasOwn(allowed, route)) {
      return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    }
    let entered = false;
    const surface = route === 'contributor/feedback' ? 'chat'
      : route === 'contributor/settlement' ? 'runtime'
        : 'options';
    const result = await featureHost.runtime.runWithLease('controller', async (/** @type {any} */ lease) => {
      entered = true;
      const clients = await /** @type {any} */ (globalThis).clients?.matchAll?.({
        type: 'window', includeUncontrolled: true,
      }) ?? [];
      const exact = clients.filter((/** @type {any} */ client) => client?.url === offscreenUrl);
      if (exact.length !== 1) {
        return { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
      }
      const channelId = crypto.randomUUID();
      const offer = {
        type: CONTRIBUTOR_CHANNEL_OFFER, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId, route, lease, message,
      };
      if (!parseContributorOffer(offer)) {
        return { ok: false, code: 'contributor-channel-offer-invalid', outcomeKnown: true };
      }
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve) => {
        const deadlineAt = Date.now() + channelDeadlineMs;
        const counts = new Map();
        let effectDispatched = false;
        let settled = false;
        const finish = (/** @type {any} */ value) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { port1.close(); } catch {}
          resolve(value);
        };
        const lost = () => finish({
          ok: false, code: 'contributor-channel-lost',
          outcomeKnown: !effectDispatched,
          ...(effectDispatched ? { outcomeKind: 'unknown', retryable: false } : {}),
        });
        const timer = setTimeout(lost, channelDeadlineMs);
        port1.onmessage = (event) => {
          const packet = event.data;
          if (packet?.protocol !== CONTRIBUTOR_CHANNEL_PROTOCOL
              || packet.channelId !== channelId) { lost(); return; }
          if (packet.type === CONTRIBUTOR_CHANNEL_RESULT) {
            if (!contributorPayloadFits(packet.result ?? {})) { lost(); return; }
            finish(packet.result ?? { ok: false, outcomeKnown: effectDispatched ? false : true });
            return;
          }
          if (packet.type !== CONTRIBUTOR_CHANNEL_CALL
              || typeof packet.requestId !== 'string' || packet.requestId.length > 128
              || typeof packet.operation !== 'string' || packet.operation.length > 128
              || !contributorPayloadFits(packet.payload ?? {})) {
            lost(); return;
          }
          const limits = /** @type {any} */ (allowed)[route];
          const used = counts.get(packet.operation) ?? 0;
          if (used >= (limits[packet.operation] ?? 0)) { lost(); return; }
          counts.set(packet.operation, used + 1);
          if (packet.operation === 'semantic.contributor.enable'
              || packet.operation === 'semantic.contributor.clear'
              || packet.operation.endsWith('-record')) effectDispatched = true;
          Promise.resolve(authority.handle(packet.operation, packet.payload, {
            authority: { target: `semantic:${route}:${surface}` },
            signal: { aborted: false }, deadlineAt,
          })).then((value) => {
            try { port1.postMessage({
              type: CONTRIBUTOR_CHANNEL_REPLY, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
              channelId, requestId: packet.requestId,
              result: value ?? { ok: false, outcomeKnown: true },
            }); } catch { lost(); }
          }, lost);
        };
        port1.onmessageerror = lost;
        port1.addEventListener?.('close', lost, { once: true });
        port1.start();
        try { exact[0].postMessage(offer, [port2]); } catch { lost(); }
      });
    }, { reason: 'preview-contributor-demand' });
    return entered ? result
      : { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
  };
  const optionsRoute = (/** @type {string} */ route) => (
    /** @type {any} */ message, /** @type {any} */ sender,
  ) => {
    if (message?.type !== route || !optionsUi(sender)) {
      return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    }
    if (route === 'contributor/status') return dispatch(route, {});
    return mutate(async () => {
      const result = await dispatch(route, {});
      if (route === 'contributor/disable' && result?.ok === true) {
        await authority.clearPending();
      }
      return result;
    });
  };
  let drainTail = Promise.resolve(/** @type {any} */ ({ ok: true, drained: 0 }));
  const drainPending = () => {
    const attempt = drainTail.then(async () => {
      let drained = 0;
      for (let index = 0; index < CONTRIBUTOR_PENDING_MAX_RECEIPTS; index += 1) {
        const receipt = (await authority.pending())[0];
        if (!receipt) return { ok: true, drained };
        const result = await mutate(() => dispatch('contributor/settlement', receipt));
        if (result?.ok !== true) return { ...result, drained };
        await authority.removePending(receipt.operationKey);
        drained += 1;
      }
      return (await authority.pending()).length === 0
        ? { ok: true, drained }
        : { ok: false, code: 'contributor-pending-drain-limit', drained };
    });
    const task = attempt.catch(() => ({
      ok: false, code: 'contributor-pending-drain-failed', drained: 0,
    }));
    drainTail = task;
    return task;
  };
  let drainScheduled = false;
  let drainAgain = false;
  const requestDrain = () => {
    if (drainScheduled) { drainAgain = true; return; }
    drainScheduled = true;
    let lastDrainOk = false;
    try {
      scheduleDrain(() => {
        void (async () => {
          let result;
          do {
            drainAgain = false;
            result = await drainPending();
            lastDrainOk = result?.ok === true;
          } while (lastDrainOk && drainAgain);
        })().finally(() => {
          const retry = lastDrainOk && drainAgain;
          drainScheduled = false;
          if (retry) requestDrain();
        });
      });
    } catch { drainScheduled = false; }
  };
  const routes = Object.freeze({
    'contributor/status': optionsRoute('contributor/status'),
    'contributor/enable': optionsRoute('contributor/enable'),
    'contributor/disable': optionsRoute('contributor/disable'),
    'contributor/feedback': async (/** @type {any} */ message = {},
      /** @type {any} */ sender = undefined) => {
      if (message?.type !== 'contributor/feedback'
          || !sidepanelUi(sender) && !homeUi(sender)) {
        return { ok: false, error: 'trusted-chat-sender-required', outcomeKnown: true };
      }
      if (!['worked', 'didnt_work'].includes(message.verdict)) {
        return { ok: false, error: 'invalid-feedback', outcomeKnown: true };
      }
      if (boundedText(message.sessionId) === undefined
          || boundedText(message.messageId) === undefined) {
        return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
      }
      const guarded = await validateFeedback(message);
      if (guarded?.ok !== true || !Array.isArray(guarded.messages)) return guarded;
      const drained = await drainPending();
      if (drained?.ok !== true) {
        return { ok: false, error: 'Contributor Metrics settlement is still pending.',
          outcomeKnown: true, retryable: true };
      }
      return mutate(() => dispatch('contributor/feedback', {
        sessionId: message.sessionId, messageId: message.messageId,
        verdict: message.verdict, messages: guarded.messages,
      }));
    },
  });
  const owner = Object.freeze({
    routes,
    arm: () => authority.arm(),
    recordWebSettlement: async (/** @type {any} */ message) => {
      const result = await authority.appendPending(message);
      if (result?.ok === true && result.queued === true) requestDrain();
      return result;
    },
    drainPending,
    pending: () => authority.pending(),
  });
  requestDrain();
  return owner;
};
root[addonId] = Object.freeze({
  target: 'preview-chrome', update: createUpdateCustody,
  dwebCustody: createKernelDwebCustodyOwner,
  contributor: createPreviewContributorRoutes,
});
