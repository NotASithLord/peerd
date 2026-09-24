// @ts-check
// Settings export / import (PACKAGING.md §"Export & import") — the
// explicit migration path between peerd installs, including between the
// store and preview channels. No background sync, no shared storage:
// the user exports a JSON file, the user imports it, and the import
// says what it will overwrite before it does (the SW routes call
// inspectImport first; the UI shows the summary).
//
// Functional core, imperative shell: everything here operates on values
// and INJECTED IO (vault reads/writes, memory import, hook saves happen
// in the SW via the `io` parameter). Pure parts are unit-testable in Bun.
//
// Payload shape (format: 'peerd-export', version: 2):
//   settings           ONLY the user's explicit values (Option A: a
//                      stored value is an intentional choice; defaults
//                      never travel). On import, keys unknown to the
//                      receiving build are dropped with a notice — this
//                      is how preview-only (dweb*) settings fall
//                      away on a store import, by mechanism not by list.
//   providerEndpoints  user-added provider endpoints ({ endpoints: [...] })
//   secrets            vault credentials, encrypted under a passphrase the user
//                      enters at export time (fixed Argon2id → AES-GCM).
//                      Never exported in plaintext; never
//                      encrypted under the vault DK (the DK never leaves
//                      the vault).
//   memory             memory exportAll() payload (AGENTS.md docs)
//   hooks              user hook records (exportHooks())
//   skills             skill METADATA only — bodies reinstall from their
//                      original sources (git/manifest origin in the meta)
//   dweb               the portable identity record ({ identityRecord }):
//                      the did:key root sealed in an encrypted capsule
//                      whose wrappers only the export passphrase (or an
//                      enrolled credential) can open — built by the
//                      channel's dweb crypto host and passed in OPAQUE,
//                      because this file must not
//                      touch dweb code. Preview-channel only; store
//                      imports drop it with the §10 notice. The raw
//                      identity/device-key secrets are structurally
//                      excluded from the generic secrets box below —
//                      the seed travels ONLY inside the capsule, the
//                      device key never travels at all. (This
//                      comment says "the dweb module" because this file
//                      ships in store packages and the artifact verifier
//                      greps everything.)
//   durability         §12 labels for THIS file: the durability tier of
//                      each section actually included, plus the names of
//                      the device-bound surfaces an export structurally
//                      cannot carry. Older files may lack this additive block;
//                      import treats absence as unlabelled durability data.

import { omittedDeviceBoundStores, portableStores } from '../lifecycle/store-registry.js';
import { isDefaultHookId } from '/shared/default-hook-manifest.js';
import {
  BACKUP_ARGON2ID_PARAMS, BACKUP_ARGON2ID_SALT_BYTES,
  deriveBackupPassphraseBytes,
} from '/shared/backup-passphrase.js';
import { isCustodySecretName, portableSecretEntries } from './secret-policy.js';
import {
  assertUserHookRecordsBounded,
  HookRecordsLimitError,
  USER_HOOK_RECORDS_MAX_COUNT,
} from '/shared/semantic-hook-manifest.js';
export { isCustodySecretName } from './secret-policy.js';

export const EXPORT_VERSION = 2;
export const EXPORT_FORMAT = 'peerd-export';
const LEGACY_EXPORT_VERSION = 1;

export const EXPORT_PASSPHRASE_MIN_LENGTH = 16;

// Secrets that never enter the generic secrets box (see the header's
// dweb section): the identity seed travels only inside the capsule, the
// record is carried as payload.dweb, and the device key is device-bound.
// Enforced HERE (payload shaping), not in the route — mechanism, not
// caller discipline. Store-safe names (kv strings, not module paths).
export class ExportPassphraseError extends Error {
  constructor() {
    super('wrong passphrase (or corrupted export file)');
    this.name = 'ExportPassphraseError';
  }
}

// ── passphrase crypto ────────────────────────────────────────────────
// New exports use the same fixed memory-hard policy as the peer-identity
// wrapper. A backup containing both sections must not give an attacker a
// cheaper correctness oracle for their shared passphrase. PBKDF2 remains
// import-only for backups emitted before this hardening.

const LEGACY_PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const MAX_ENCRYPTED_SECRETS_B64 = 4 * 1024 * 1024;
const MAX_HOOK_ID_BYTES = 128;
const MAX_HOOK_TEXT_BYTES = 64 * 1024;

/**
 * Classify the bounded hook records a backup may carry. Executable JS,
 * regex rules, and built-in ID collisions remain portable only so an upgrade
 * can show them as disabled/retired; none becomes executable during import.
 * @param {unknown} value
 * @returns {'current'|'legacy-js'|'legacy-regex'|'reserved-id'|'invalid'}
 */
export const portableHookDisposition = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const hook = /** @type {Record<string,any>} */ (value);
  if (typeof hook.id !== 'string' || !hook.id || hook.id.length > MAX_HOOK_ID_BYTES
      || (hook.event !== 'pre-tool-use' && hook.event !== 'post-tool-use')
      || (hook.enabled !== undefined && typeof hook.enabled !== 'boolean')
      || (hook.order !== undefined && (!Number.isFinite(hook.order)
        || Math.abs(hook.order) > 1_000_000))
      || (hook.match !== undefined && (typeof hook.match !== 'string'
        || hook.match.length > 1024))
      || (hook.doc !== undefined && (typeof hook.doc !== 'string'
        || hook.doc.length > MAX_HOOK_TEXT_BYTES))) return 'invalid';
  if (isDefaultHookId(hook.id)) return 'reserved-id';
  if (hook.kind === 'js') {
    return typeof hook.body === 'string' && hook.body.length <= MAX_HOOK_TEXT_BYTES
      ? 'legacy-js' : 'invalid';
  }
  if (hook.kind !== 'declarative' || !hook.rule || typeof hook.rule !== 'object'
      || Array.isArray(hook.rule)) return 'invalid';
  const rule = /** @type {Record<string,any>} */ (hook.rule);
  if (typeof rule.matchArg !== 'string' || !rule.matchArg || rule.matchArg.length > 128
      || (rule.onMatch !== undefined && rule.onMatch !== 'block' && rule.onMatch !== 'allow')
      || (rule.reason !== undefined && (typeof rule.reason !== 'string'
        || rule.reason.length > 4096))) return 'invalid';
  if (typeof rule.contains === 'string' && rule.contains.length > 0
      && rule.contains.length <= 1024 && !Object.hasOwn(rule, 'pattern')) return 'current';
  return typeof rule.pattern === 'string' && rule.pattern.length <= 4096
    ? 'legacy-regex' : 'invalid';
};
const MAX_SECRET_ENTRIES = 256;
const MAX_SECRET_NAME_LENGTH = 256;
const MAX_SECRET_VALUE_LENGTH = 1024 * 1024;
const MAX_SETTINGS_KEYS = 512;
const MAX_PROVIDER_ENDPOINTS = 64;
const MAX_MEMORY_DOCS = 10_000;
const MAX_SKILLS = 512;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** @param {Uint8Array} bytes */
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
/** @param {string} b64 */
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** @param {any} box */
const validEncryptedSecretsBox = (box) => {
  if (!box || typeof box !== 'object' || box.cipher !== 'AES-GCM'
      || typeof box.salt !== 'string' || box.salt.length !== 24
      || !BASE64_PATTERN.test(box.salt)
      || typeof box.data !== 'string' || box.data.length === 0
      || box.data.length > MAX_ENCRYPTED_SECRETS_B64
      || !BASE64_PATTERN.test(box.data)) return false;
  if (box.kdf === BACKUP_ARGON2ID_PARAMS.name) {
    return box.memKiB === BACKUP_ARGON2ID_PARAMS.memKiB
      && box.iters === BACKUP_ARGON2ID_PARAMS.iters
      && box.parallelism === BACKUP_ARGON2ID_PARAMS.parallelism
      && box.iterations === undefined;
  }
  return box.kdf === 'PBKDF2-SHA256'
    && box.iterations === LEGACY_PBKDF2_ITERATIONS
    && box.memKiB === undefined
    && box.iters === undefined
    && box.parallelism === undefined;
};

/**
 * @param {string} passphrase
 * @param {BufferSource} salt
 * @param {number} iterations
 */
const deriveLegacyExportKey = async (passphrase, salt, iterations) => {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

/** @param {string} passphrase @param {Uint8Array} salt */
const deriveExportKey = async (passphrase, salt) => {
  const raw = await deriveBackupPassphraseBytes(passphrase, salt);
  try {
    return await crypto.subtle.importKey(
      'raw', /** @type {BufferSource} */ (raw), { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt'],
    );
  } finally {
    raw.fill(0);
  }
};

/**
 * Encrypt a JSON-able value under a passphrase → self-describing box.
 * @param {string} passphrase
 * @param {unknown} value
 */
export const encryptWithPassphrase = async (passphrase, value) => {
  const salt = crypto.getRandomValues(new Uint8Array(BACKUP_ARGON2ID_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveExportKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv, 0);
    blob.set(ct, iv.length);
    return {
      kdf: BACKUP_ARGON2ID_PARAMS.name,
      memKiB: BACKUP_ARGON2ID_PARAMS.memKiB,
      iters: BACKUP_ARGON2ID_PARAMS.iters,
      parallelism: BACKUP_ARGON2ID_PARAMS.parallelism,
      salt: bytesToB64(salt),
      cipher: 'AES-GCM',
      data: bytesToB64(blob),
    };
  } finally {
    plaintext.fill(0);
  }
};

/**
 * Decrypt an encryptWithPassphrase box. Throws ExportPassphraseError on
 * auth failure (GCM tag mismatch = wrong passphrase or tampering).
 * @param {string} passphrase
 * @param {{ kdf: string, cipher: string, salt: string, data: string, iterations?: number, memKiB?: number, iters?: number, parallelism?: number }} box
 */
export const decryptWithPassphrase = async (passphrase, box) => {
  try {
    if (!validEncryptedSecretsBox(box)) {
      throw new Error('malformed encrypted secrets box');
    }
    const salt = b64ToBytes(box.salt);
    if (salt.byteLength !== BACKUP_ARGON2ID_SALT_BYTES) throw new Error('bad salt');
    const blob = b64ToBytes(box.data);
    if (blob.byteLength < IV_BYTES + 16) throw new Error('ciphertext too short');
    const iv = blob.slice(0, IV_BYTES);
    const ct = blob.slice(IV_BYTES);
    let key;
    if (box.kdf === BACKUP_ARGON2ID_PARAMS.name) {
      key = await deriveExportKey(passphrase, salt);
    } else if (box.kdf === 'PBKDF2-SHA256') {
      key = await deriveLegacyExportKey(
        passphrase, salt, /** @type {number} */ (box.iterations),
      );
    } else {
      throw new Error('unsupported encrypted secrets KDF');
    }
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new ExportPassphraseError();
  }
};

// ── export ───────────────────────────────────────────────────────────

// why this map lives here and not in the registry: the registry names
// durable SURFACES, this file names payload SECTIONS. Keeping the
// translation on the transfer side lets §12's tier labels ride along
// without the lifecycle registry knowing a thing about this file format.
/** @type {Readonly<Record<string, string>>} */
const SECTION_OF_STORE = Object.freeze({
  vault: 'secrets',
  memory: 'memory',
  skills: 'skills',
  hooks: 'hooks',
});

/**
 * The §12 durability block for a shaped payload: tier labels for the
 * sections this file actually carries, and the device-bound surfaces it
 * left behind ("the export format must identify omitted device-bound
 * state" — a profile arriving without them is incomplete, not corrupt).
 *
 * @param {Record<string, unknown>} payload  the shaped export, pre-durability
 */
const durabilitySection = (payload) => {
  /** @type {Record<string, string>} */
  const tiers = {};
  for (const entry of portableStores()) {
    const section = SECTION_OF_STORE[entry.store];
    if (!section) continue;
    const value = payload[section];
    const present = value != null && !(Array.isArray(value) && value.length === 0);
    if (present) tiers[entry.store] = entry.tier;
  }
  return { tiers, omittedDeviceBound: omittedDeviceBoundStores() };
};

/**
 * Assemble the export payload. The SW gathers the pieces (vault must be
 * unlocked to read secrets) and passes them in; this function only
 * shapes + encrypts.
 *
 * @param {Object} args
 * @param {'store'|'preview'} args.channel
 * @param {Record<string, any>} args.storedSettings  explicit values only
 * @param {any} args.providerEndpoints
 * @param {Record<string, string>} args.secrets  plaintext name→value (encrypted here)
 * @param {string} args.passphrase  required when secrets is non-empty
 * @param {any} args.memory   memory exportAll() payload
 * @param {any[]} args.hooks  exportHooks() records
 * @param {any[]} args.skills skill metadata list
 * @param {any} [args.dweb]   the portable identity section
 *        ({ identityRecord } — already encrypted by the dweb crypto host), or null
 */
export const buildExport = async ({
  channel, storedSettings, providerEndpoints, secrets, passphrase, memory, hooks, skills, dweb,
}) => {
  const portableSecrets = portableSecretEntries(secrets);
  const secretNames = Object.keys(portableSecrets);
  if (secretNames.length > 0 && !passphrase) {
    throw new ExportPassphraseError();
  }
  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    channel,
    settings: storedSettings ?? {},
    providerEndpoints: providerEndpoints ?? null,
    secrets: secretNames.length > 0 ? await encryptWithPassphrase(passphrase, portableSecrets) : null,
    memory: memory ?? null,
    hooks: hooks ?? [],
    skills: skills ?? [],
    // Absent (not null) when there is nothing to carry — the pre-identity
    // export shape, so old files and identity-less exports stay identical.
    ...(dweb ? { dweb } : {}),
  };
  return { ...payload, durability: durabilitySection(payload) };
};

// ── import ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} ImportSummary
 * @property {string | null} exportedAt
 * @property {string | null} sourceChannel
 * @property {string[]} settingsKeys
 * @property {string[]} settingsDropped
 * @property {boolean} hasSecrets
 * @property {boolean} hasIdentityRecord
 * @property {boolean} requiresPassphrase
 * @property {string | null} identityDid
 * @property {number} memoryDocs
 * @property {number} hooks
 * @property {string[]} skills
 * @property {boolean} dwebPresent
 * @property {boolean} dwebDropped
 * @property {Record<string, string>} durabilityTiers  §12 labels ({} on older files)
 * @property {string[]} omittedDeviceBound             device-bound surfaces not carried
 * @property {string[]} notices
 */

/**
 * Pure pre-flight: what would an import do? The UI shows this BEFORE
 * anything is written (§10: "surfaces what will be overwritten").
 *
 * @param {Object} args
 * @param {any} args.payload
 * @param {'store'|'preview'} args.channel    the RECEIVING build's channel
 * @param {string[]} args.knownSettingKeys    Object.keys(CHANNEL_DEFAULTS)
 */
export const inspectImport = ({ payload, channel, knownSettingKeys }) => {
  if (!payload || payload.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'not-a-peerd-export' };
  }
  if (payload.version !== EXPORT_VERSION && payload.version !== LEGACY_EXPORT_VERSION) {
    return { ok: false, error: `unsupported-export-version-${payload.version}` };
  }
  // Bound every collection that can become work or writes before the user can
  // approve the file. The UI already caps total bytes; these shape limits stop
  // small adversarial JSON from expanding into unbounded route activity.
  const settingsValid = payload.settings == null
    || (typeof payload.settings === 'object' && !Array.isArray(payload.settings)
      && Object.keys(payload.settings).length <= MAX_SETTINGS_KEYS);
  const endpointsValid = payload.providerEndpoints == null
    || (typeof payload.providerEndpoints === 'object'
      && Array.isArray(payload.providerEndpoints.endpoints)
      && payload.providerEndpoints.endpoints.length <= MAX_PROVIDER_ENDPOINTS
      && payload.providerEndpoints.endpoints.every((/** @type {any} */ endpoint) =>
        endpoint && typeof endpoint === 'object'
        && typeof endpoint.url === 'string' && endpoint.url.length <= 4096));
  const memoryValid = payload.memory == null
    || (typeof payload.memory === 'object' && Array.isArray(payload.memory.docs)
      && payload.memory.docs.length <= MAX_MEMORY_DOCS
      && payload.memory.docs.every((/** @type {any} */ doc) => doc && typeof doc === 'object'));
  const hooksValid = Array.isArray(payload.hooks)
    && payload.hooks.length <= USER_HOOK_RECORDS_MAX_COUNT
    && payload.hooks.every((/** @type {any} */ hook) => portableHookDisposition(hook) !== 'invalid');
  const skillsValid = Array.isArray(payload.skills) && payload.skills.length <= MAX_SKILLS
    && payload.skills.every((/** @type {any} */ skill) => skill && typeof skill === 'object');
  const dwebValid = payload.dweb == null
    || (typeof payload.dweb === 'object' && !Array.isArray(payload.dweb));
  const secretsValid = payload.secrets == null || validEncryptedSecretsBox(payload.secrets);
  if (!settingsValid || !endpointsValid || !memoryValid || !hooksValid || !skillsValid
      || !dwebValid || !secretsValid) {
    return { ok: false, error: 'invalid-export-sections' };
  }
  try { assertUserHookRecordsBounded(payload.hooks); }
  catch (cause) {
    if (cause instanceof HookRecordsLimitError) {
      return { ok: false, error: cause.message, code: cause.code };
    }
    throw cause;
  }
  const settings = (payload.settings && typeof payload.settings === 'object') ? payload.settings : {};
  const known = new Set(knownSettingKeys);
  const settingsDropped = Object.keys(settings).filter((k) => !known.has(k));
  const dwebPresent = payload.dweb != null;
  const identityRecord = payload.dweb?.identityRecord;
  const hasIdentityRecord = channel !== 'store' && identityRecord != null;
  /** @type {string[]} */
  const notices = [];
  if (channel === 'store' && dwebPresent) {
    notices.push(identityRecord != null
      ? 'The peer identity in this preview backup cannot be restored by the store build and will be skipped.'
      : 'Dweb state in this export is not supported in the store package and was skipped.');
  }
  if (hasIdentityRecord) {
    // §10 transparency: an identity is the most consequential thing an
    // import can carry — say so before the user confirms.
    notices.push('This export carries a dweb identity record — if this install has no dweb identity yet, importing restores that identity (same did as the exporting install).');
  }
  if (settingsDropped.length > 0) {
    notices.push(`Settings not recognized by this build were skipped: ${settingsDropped.join(', ')}.`);
  }
  /** @type {Array<{ name?: string, id?: string }>} */
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  if (skills.length > 0) {
    notices.push(`${skills.length} skill(s) are listed as metadata only — reinstall them from the Skills view (their sources are preserved in the export).`);
  }
  // R6 (import is an untrusted-deserialization surface): the two payload
  // sections that can redirect authority — provider endpoints (egress
  // targets) and hooks (code that vetoes/permits tool calls) — are named
  // LOUDLY in the summary the user approves, not buried in counts.
  /** @type {string[]} */
  const endpointUrls = (Array.isArray(payload.providerEndpoints?.endpoints) ? payload.providerEndpoints.endpoints : [])
    .map((/** @type {any} */ e) => String(e?.url ?? '')).filter(Boolean);
  if (typeof settings.ollamaHost === 'string') {
    try {
      const configured = new URL(settings.ollamaHost.trim());
      if ((configured.protocol === 'http:' || configured.protocol === 'https:')
          && !endpointUrls.includes(configured.origin)) endpointUrls.push(configured.origin);
    } catch { /* malformed settings are normalized or dropped before apply */ }
  }
  if (endpointUrls.length > 0) {
    notices.push(`This import adds provider endpoint(s) the agent will send API traffic to: ${endpointUrls.join(', ')} — only proceed if you recognize them.`);
  }
  /** @type {string[]} */
  const hookIds = (Array.isArray(payload.hooks) ? payload.hooks : [])
    .map((/** @type {any} */ h) => String(h?.id ?? 'unknown'));
  const unsupportedHookIds = (Array.isArray(payload.hooks) ? payload.hooks : [])
    .filter((/** @type {any} */ hook) => portableHookDisposition(hook) !== 'current')
    .map((/** @type {any} */ hook) => String(hook.id));
  if (hookIds.length > 0) {
    notices.push(`${hookIds.length} hook(s) will be imported DISABLED and untrusted (${hookIds.join(', ')}) — review and re-enable them in Settings → Hooks.`);
  }
  if (unsupportedHookIds.length > 0) {
    notices.push(`Unsupported legacy or reserved hook record(s) will remain DISABLED and appear as retired until removed or replaced: ${unsupportedHookIds.join(', ')}.`);
  }
  // §12 durability labels. Additive to the format, so an export written
  // before this section existed is fully valid: absent means "unlabelled",
  // never "nothing was omitted" — hence the empty defaults and no notice.
  const durability = (payload.durability && typeof payload.durability === 'object') ? payload.durability : null;
  const durabilityTiers = (durability?.tiers && typeof durability.tiers === 'object') ? durability.tiers : {};
  /** @type {string[]} */
  const omittedDeviceBound = Array.isArray(durability?.omittedDeviceBound)
    ? durability.omittedDeviceBound.map((/** @type {unknown} */ s) => String(s))
    : [];
  if (omittedDeviceBound.length > 0) {
    notices.push(`Device-bound state cannot travel and was not exported (${omittedDeviceBound.join(', ')}) — this build re-creates it locally.`);
  }
  return {
    ok: true,
    summary: {
      exportedAt: payload.exportedAt ?? null,
      sourceChannel: payload.channel ?? null,
      settingsKeys: Object.keys(settings).filter((k) => known.has(k)),
      settingsDropped,
      hasSecrets: payload.secrets != null,
      hasIdentityRecord,
      requiresPassphrase: payload.secrets != null || hasIdentityRecord,
      identityDid: typeof identityRecord?.did === 'string' ? identityRecord.did : null,
      memoryDocs: Array.isArray(payload.memory?.docs) ? payload.memory.docs.length : 0,
      hooks: Array.isArray(payload.hooks) ? payload.hooks.length : 0,
      hookIds,
      unsupportedHookIds,
      endpointUrls,
      skills: skills.map((s) => s?.name ?? s?.id ?? 'unknown'),
      dwebPresent,
      dwebDropped: channel === 'store' && dwebPresent,
      durabilityTiers,
      omittedDeviceBound,
      notices,
    },
  };
};

/**
 * Apply an import. Call inspectImport first (the SW route does) — this
 * assumes a structurally valid payload and performs the writes through
 * injected IO. Settings keys unknown to this build are dropped here too
 * (mechanism, not trust in the caller).
 *
 * @param {Object} args
 * @param {any} args.payload
 * @param {string} [args.passphrase]  required when payload.secrets present
 * @param {'store'|'preview'} args.channel
 * @param {string[]} args.knownSettingKeys
 * @param {Object} args.io
 * @param {(patch: Record<string, any>) => Promise<void|{count?: number, notices?: string[]}>} args.io.applySettings
 * @param {(endpoints: any) => Promise<void>} args.io.setProviderEndpoints
 * @param {(name: string, value: string) => Promise<void>} args.io.setSecret
 * @param {(payload: any) => Promise<{written: number, skipped: number}>} args.io.importMemory
 * @param {(record: any) => Promise<any>} args.io.saveHook
 * @param {(records: any[]) => Promise<void>} [args.io.prepareHookImport]
 * @param {(record: any, passphrase: string, options?: { replaceExisting?: boolean, prepareOnly?: boolean, expectedExistingDid?: string | null, expectedExistingRevision?: string, expectedIncomingDid?: string }) => Promise<{ adopted: boolean, did?: string | null, reason?: string, existingDid?: string | null, incomingDid?: string | null, existingUnreadable?: boolean, existingRevision?: string, runtimeRecoveryPending?: boolean }>} [args.io.adoptDwebIdentity]
 *        preview-channel identity adoption (absent on store builds / when
 *        the receiving build cannot host an identity)
 * @param {boolean} [args.replaceDwebIdentity] explicit user approval to replace
 *        a different local identity
 * @param {string} [args.approvedExistingDwebDid] local did shown in that approval
 * @param {string} [args.approvedExistingDwebRevision] opaque revision for an
 *        unreadable local identity shown in that approval
 * @param {string} [args.approvedIncomingDwebDid] backup did shown in that approval
 * @param {boolean} [args.skipDwebIdentity] explicit user choice to keep the
 *        local identity while importing every other section
 */
export const applyImport = async ({
  payload, passphrase, channel, knownSettingKeys, io,
  replaceDwebIdentity = false, skipDwebIdentity = false,
  approvedExistingDwebDid, approvedExistingDwebRevision, approvedIncomingDwebDid,
}) => {
  const inspected = inspectImport({ payload, channel, knownSettingKeys });
  if (!inspected.ok) return inspected;
  // why: the `!ok` early-return guarantees the ok:true branch, whose
  // `summary` is always present — TS doesn't propagate that through the
  // inferred union, so assert the shape the runtime guarantees here.
  const summary = /** @type {ImportSummary} */ (inspected.summary);
  const imported = {
    settings: 0, secrets: 0, providerEndpoints: 0,
    memoryWritten: 0, hooks: 0, dwebIdentity: 0,
  };

  // Validate the complete merge against the receiving store before any import
  // mutation. This keeps a clear hook-limit refusal from becoming a partial
  // settings/memory import when the local store is already populated.
  await io.prepareHookImport?.((payload.hooks ?? []).map((/** @type {any} */ record) => ({
    ...record, enabled: false,
  })));

  /** @type {'not-present'|'restored'|'replaced'|'already-present'|'kept-local'|'unsupported'} */
  let identityOutcome = 'not-present';
  let runtimeRecoveryPending = false;

  // Stage every credential-dependent decision before the first settings/data
  // write. A wrong passphrase or identity conflict must leave the rest of the
  // profile untouched.
  /** @type {Record<string, string>} */
  const portableSecrets = {};
  if (payload.secrets != null) {
    const decrypted = await decryptWithPassphrase(passphrase ?? '', payload.secrets);
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
      throw new ExportPassphraseError();
    }
    const entries = Object.entries(decrypted);
    if (entries.length > MAX_SECRET_ENTRIES) throw new ExportPassphraseError();
    let custodySecretsSkipped = 0;
    for (const [name, value] of entries) {
      if (name.length === 0 || name.length > MAX_SECRET_NAME_LENGTH
          || typeof value !== 'string' || value.length > MAX_SECRET_VALUE_LENGTH) {
        throw new ExportPassphraseError();
      }
      if (isCustodySecretName(name)) { custodySecretsSkipped++; continue; }
      portableSecrets[name] = value;
    }
    if (custodySecretsSkipped > 0) {
      summary.notices.push(`${custodySecretsSkipped} protected identity/device secret(s) in the file were refused; identity custody only moves through the verified recovery record.`);
    }
  }

  // Authenticate the identity wrapper and resolve conflicts before any write,
  // but do not change custody yet. The final adoption happens after every
  // fallible ordinary import write, making the permanent identity the commit.
  let preparedIdentity = false;
  /** @type {string | null | undefined} */
  let preparedExistingDid;
  /** @type {string | undefined} */
  let preparedExistingRevision;
  /** @type {string | undefined} */
  let preparedIncomingDid;
  if (channel === 'store' && payload.dweb?.identityRecord != null) {
    identityOutcome = 'unsupported';
  } else if (channel !== 'store' && payload.dweb?.identityRecord != null && skipDwebIdentity) {
    identityOutcome = 'kept-local';
    summary.notices.push('The backup\'s peer identity was skipped; this install kept its current identity.');
  } else if (channel !== 'store' && payload.dweb?.identityRecord != null) {
    if (!io.adoptDwebIdentity) return { ok: false, error: 'dweb-identity-unavailable' };
    const outcome = await io.adoptDwebIdentity(
      payload.dweb.identityRecord,
      passphrase ?? '',
      { replaceExisting: replaceDwebIdentity, prepareOnly: true },
    );
    if (replaceDwebIdentity) {
      const unreadableLocal = outcome?.existingUnreadable === true;
      const localApprovalPresent = unreadableLocal
        ? typeof approvedExistingDwebRevision === 'string'
        : typeof approvedExistingDwebDid === 'string';
      if (!localApprovalPresent || typeof approvedIncomingDwebDid !== 'string') {
        return { ok: false, error: 'dweb-identity-approval-required' };
      }
      const localApprovalMatches = unreadableLocal
        ? outcome.existingRevision === approvedExistingDwebRevision
        : outcome?.existingDid === approvedExistingDwebDid;
      if (!localApprovalMatches || outcome?.incomingDid !== approvedIncomingDwebDid) {
        return {
          ok: false,
          error: 'dweb-identity-conflict',
          conflict: {
            existingDid: outcome?.existingDid ?? outcome?.did ?? null,
            incomingDid: outcome?.incomingDid ?? null,
            ...(unreadableLocal ? {
              existingUnreadable: true,
              existingRevision: outcome?.existingRevision ?? null,
            } : {}),
          },
        };
      }
    }
    if (outcome?.reason === 'did-conflict') {
      return {
        ok: false,
        error: 'dweb-identity-conflict',
        conflict: {
          existingDid: outcome.existingDid ?? outcome.did ?? null,
          incomingDid: outcome.incomingDid ?? null,
        },
      };
    }
    if (outcome?.reason === 'identity-in-use') {
      return {
        ok: false,
        error: 'dweb-identity-in-use',
        conflict: {
          existingDid: outcome.existingDid ?? outcome.did ?? null,
          incomingDid: outcome.incomingDid ?? null,
        },
      };
    }
    if (outcome?.reason === 'invalid-local-identity') {
      return {
        ok: false,
        error: 'dweb-identity-conflict',
        conflict: {
          existingDid: null,
          incomingDid: outcome.incomingDid ?? null,
          existingUnreadable: true,
          existingRevision: outcome.existingRevision ?? null,
        },
      };
    }
    if (!outcome?.adopted) {
      if (outcome?.reason === 'no-openable-wrapper') throw new ExportPassphraseError();
      return { ok: false, error: `dweb-identity-${outcome?.reason ?? 'adopt-failed'}` };
    }
    if (outcome.reason === 'already-present') identityOutcome = 'already-present';
    else {
      preparedIdentity = true;
      preparedExistingDid = outcome.existingDid ?? null;
      preparedExistingRevision = outcome.existingUnreadable
        ? outcome.existingRevision : undefined;
      preparedIncomingDid = outcome.incomingDid ?? outcome.did ?? undefined;
    }
  }

  try {
    // Settings: explicit values only, filtered to keys this build knows.
    // A preview value stricter-or-looser than this channel's default is
    // PRESERVED — the user picked it; the channel default only applies in
    // absence of a stored value (§11 cross-channel nuances).
    const known = new Set(knownSettingKeys);
    /** @type {Record<string, unknown>} */
    const patch = {};
    for (const [k, v] of Object.entries(payload.settings ?? {})) {
      if (known.has(k)) patch[k] = v;
    }
    if (Object.keys(patch).length > 0) {
      const applied = await io.applySettings(patch);
      const appliedResult = applied && typeof applied === 'object' ? applied : null;
      const appliedCount = appliedResult?.count;
      imported.settings = Number.isInteger(appliedCount)
        ? /** @type {number} */ (appliedCount)
        : Object.keys(patch).length;
      if (Array.isArray(appliedResult?.notices)) summary.notices.push(...appliedResult.notices);
    }

    if (payload.providerEndpoints?.endpoints) {
      // R6: an imported endpoint becomes an egress target the agent sends
      // API traffic (and headers) to. Only https (or local-loopback http for
      // Ollama-style daemons) parses through; anything else is dropped and
      // named. This blocks scheme smuggling; the https hosts themselves were
      // shown to the user in the inspect summary they approved.
      const accepted = [];
      const dropped = [];
      for (const endpoint of payload.providerEndpoints.endpoints) {
        const url = (() => { try { return new URL(String(endpoint?.url ?? '')); } catch { return null; } })();
        const localLoopback = url?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url && (url.protocol === 'https:' || localLoopback)) accepted.push(endpoint);
        else dropped.push(String(endpoint?.url ?? '(unparseable)'));
      }
      if (accepted.length > 0) {
        await io.setProviderEndpoints({ ...payload.providerEndpoints, endpoints: accepted });
        imported.providerEndpoints = accepted.length;
      }
      if (dropped.length > 0) {
        summary.notices.push(`Dropped ${dropped.length} provider endpoint(s) that are not https or local loopback: ${dropped.join(', ')}.`);
      }
    }

    if (payload.secrets != null) {
      for (const [name, value] of Object.entries(portableSecrets)) {
        await io.setSecret(name, value);
        imported.secrets++;
      }
    }

    if (payload.memory?.docs) {
      const res = await io.importMemory(payload.memory);
      imported.memoryWritten = res.written;
      if (res.written > 0) {
        // R6: memory is injected into future prompts as trusted context — an
        // import that repopulates it is a poisoning vector. Import stays legal
        // (the user approved the summary), but the consequence is stated.
        summary.notices.push(`${res.written} memory doc(s) imported — they will inform future prompts; review them via /memory if this file wasn't authored by you.`);
      }
    }

    for (const record of payload.hooks ?? []) {
      // R6: imported declarative hook policy runs against every tool call. It
      // arrives from a file, so it lands disabled for explicit user review;
      // legacy executable/regex kinds remain inert retired records so import
      // matches the preflight promise instead of failing after earlier writes.
      await io.saveHook({ ...record, enabled: false });
      imported.hooks++;
    }

    if (preparedIdentity) {
      const outcome = await io.adoptDwebIdentity?.(
        payload.dweb.identityRecord,
        passphrase ?? '',
        {
          replaceExisting: replaceDwebIdentity,
          expectedExistingDid: preparedExistingDid,
          ...(preparedExistingRevision
            ? { expectedExistingRevision: preparedExistingRevision }
            : {}),
          expectedIncomingDid: preparedIncomingDid,
        },
      );
      if (!outcome?.adopted) {
        if (outcome?.reason === 'no-openable-wrapper') throw new ExportPassphraseError();
        return {
          ok: false,
          error: `dweb-identity-${outcome?.reason ?? 'adopt-failed'}`,
          partial: imported,
          identityOutcome: 'not-changed',
        };
      }
      if (outcome.reason === 'recovered' || outcome.reason === 'replaced'
          || outcome.reason === 'replaced-invalid-local') {
        imported.dwebIdentity = 1;
        const replaced = outcome.reason === 'replaced' || outcome.reason === 'replaced-invalid-local';
        identityOutcome = replaced ? 'replaced' : 'restored';
        summary.notices.push(`${replaced ? 'Local peer identity replaced' : 'Peer identity restored'} from the backup${outcome.did ? ` (${outcome.did})` : ''}.`);
      } else {
        identityOutcome = 'already-present';
      }
      runtimeRecoveryPending = outcome.runtimeRecoveryPending === true;
    }
    if (identityOutcome === 'already-present') {
      summary.notices.push('The backup carries the same peer identity already present on this install; no identity change was needed.');
    }
    return { ok: true, imported, identityOutcome, runtimeRecoveryPending, notices: summary.notices };
  } catch (cause) {
    const named = /** @type {{ name?: string, code?: string, outcomeKnown?: boolean }} */ (cause);
    const outcomeKnown = named?.name !== 'IdentityTransferError'
      || named.outcomeKnown !== false;
    const failure = cause instanceof ExportPassphraseError
      ? 'wrong-passphrase'
      : named?.name === 'IdentityTransferError'
        ? `dweb-identity-${named.code ?? 'transfer-failed'}`
        : 'write-failed';
    return {
      ok: false,
      error: 'import-partial',
      failure,
      partial: imported,
      identityOutcome: outcomeKnown ? 'not-changed' : 'unknown',
      ...(outcomeKnown ? {} : { outcomeKnown: false }),
    };
  }
};
