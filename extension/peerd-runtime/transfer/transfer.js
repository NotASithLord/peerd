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
// Payload shape (format: 'peerd-export', version: 1):
//   settings           ONLY the user's explicit values (Option A: a
//                      stored value is an intentional choice; defaults
//                      never travel). On import, keys unknown to the
//                      receiving build are dropped with a notice — this
//                      is how preview-only (dweb*) settings fall
//                      away on a store import, by mechanism not by list.
//   providerEndpoints  user-added provider endpoints ({ endpoints: [...] })
//   secrets            API keys, encrypted under a passphrase the user
//                      enters at export time (PBKDF2-SHA256 600k →
//                      AES-GCM). Never exported in plaintext; never
//                      encrypted under the vault DK (the DK never leaves
//                      the vault).
//   memory             memory exportAll() payload (AGENTS.md docs)
//   hooks              user hook records (exportHooks())
//   skills             skill METADATA only — bodies reinstall from their
//                      original sources (git/manifest origin in the meta)
//   dweb               absent in Phase 0 (identity is ephemeral by
//                      design — see the dweb module's identity
//                      notes). When the persistent vault-seeded identity
//                      lands (Phase 2), it exports here, preview-channel
//                      only, and store imports drop it with the §10
//                      notice. (This comment says "the dweb module"
//                      because this file ships in store packages and the
//                      artifact verifier greps everything.)

export const EXPORT_VERSION = 1;
export const EXPORT_FORMAT = 'peerd-export';

export class ExportPassphraseError extends Error {
  constructor() {
    super('wrong passphrase (or corrupted export file)');
    this.name = 'ExportPassphraseError';
  }
}

// ── passphrase crypto ────────────────────────────────────────────────
// PBKDF2-SHA256 @600k for the EXPORT FILE passphrase only (the vault
// itself uses Argon2id; an export is an ephemeral user-carried file, a
// different threat model) but
// derives an AES-GCM key directly — this is file encryption under a
// user-chosen passphrase, independent of the vault DK.

const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

/** @param {Uint8Array} bytes */
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
/** @param {string} b64 */
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * @param {string} passphrase
 * @param {BufferSource} salt
 * @param {number} iterations
 */
const deriveExportKey = async (passphrase, salt, iterations) => {
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

/**
 * Encrypt a JSON-able value under a passphrase → self-describing box.
 * @param {string} passphrase
 * @param {unknown} value
 */
export const encryptWithPassphrase = async (passphrase, value) => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveExportKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return {
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToB64(salt),
    cipher: 'AES-GCM',
    data: bytesToB64(blob),
  };
};

/**
 * Decrypt an encryptWithPassphrase box. Throws ExportPassphraseError on
 * auth failure (GCM tag mismatch = wrong passphrase or tampering).
 * @param {string} passphrase
 * @param {{ salt: string, iterations: number, data: string }} box
 */
export const decryptWithPassphrase = async (passphrase, box) => {
  const blob = b64ToBytes(box.data);
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  const key = await deriveExportKey(passphrase, b64ToBytes(box.salt), box.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new ExportPassphraseError();
  }
};

// ── export ───────────────────────────────────────────────────────────

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
 */
export const buildExport = async ({
  channel, storedSettings, providerEndpoints, secrets, passphrase, memory, hooks, skills,
}) => {
  const secretNames = Object.keys(secrets ?? {});
  if (secretNames.length > 0 && !passphrase) {
    throw new ExportPassphraseError();
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    channel,
    settings: storedSettings ?? {},
    providerEndpoints: providerEndpoints ?? null,
    secrets: secretNames.length > 0 ? await encryptWithPassphrase(passphrase, secrets) : null,
    memory: memory ?? null,
    hooks: hooks ?? [],
    skills: skills ?? [],
  };
};

// ── import ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} ImportSummary
 * @property {string | null} exportedAt
 * @property {string | null} sourceChannel
 * @property {string[]} settingsKeys
 * @property {string[]} settingsDropped
 * @property {boolean} hasSecrets
 * @property {number} memoryDocs
 * @property {number} hooks
 * @property {string[]} skills
 * @property {boolean} dwebPresent
 * @property {boolean} dwebDropped
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
  if (payload.version !== EXPORT_VERSION) {
    return { ok: false, error: `unsupported-export-version-${payload.version}` };
  }
  const settings = (payload.settings && typeof payload.settings === 'object') ? payload.settings : {};
  const known = new Set(knownSettingKeys);
  const settingsDropped = Object.keys(settings).filter((k) => !known.has(k));
  const dwebPresent = payload.dweb != null;
  /** @type {string[]} */
  const notices = [];
  if (channel === 'store' && dwebPresent) {
    // The §10 notice, verbatim.
    notices.push('Dweb state in this export is not supported in the store package and was skipped.');
  }
  if (settingsDropped.length > 0) {
    notices.push(`Settings not recognized by this build were skipped: ${settingsDropped.join(', ')}.`);
  }
  /** @type {Array<{ name?: string, id?: string }>} */
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  if (skills.length > 0) {
    notices.push(`${skills.length} skill(s) are listed as metadata only — reinstall them from the Skills view (their sources are preserved in the export).`);
  }
  return {
    ok: true,
    summary: {
      exportedAt: payload.exportedAt ?? null,
      sourceChannel: payload.channel ?? null,
      settingsKeys: Object.keys(settings).filter((k) => known.has(k)),
      settingsDropped,
      hasSecrets: payload.secrets != null,
      memoryDocs: Array.isArray(payload.memory?.docs) ? payload.memory.docs.length : 0,
      hooks: Array.isArray(payload.hooks) ? payload.hooks.length : 0,
      skills: skills.map((s) => s?.name ?? s?.id ?? 'unknown'),
      dwebPresent,
      dwebDropped: channel === 'store' && dwebPresent,
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
 * @param {(patch: Record<string, any>) => Promise<void>} args.io.applySettings
 * @param {(endpoints: any) => Promise<void>} args.io.setProviderEndpoints
 * @param {(name: string, value: string) => Promise<void>} args.io.setSecret
 * @param {(payload: any) => Promise<{written: number, skipped: number}>} args.io.importMemory
 * @param {(record: any) => Promise<any>} args.io.saveHook
 */
export const applyImport = async ({ payload, passphrase, channel, knownSettingKeys, io }) => {
  const inspected = inspectImport({ payload, channel, knownSettingKeys });
  if (!inspected.ok) return inspected;
  // why: the `!ok` early-return guarantees the ok:true branch, whose
  // `summary` is always present — TS doesn't propagate that through the
  // inferred union, so assert the shape the runtime guarantees here.
  const summary = /** @type {ImportSummary} */ (inspected.summary);
  const imported = { settings: 0, secrets: 0, memoryWritten: 0, hooks: 0 };

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
    await io.applySettings(patch);
    imported.settings = Object.keys(patch).length;
  }

  if (payload.providerEndpoints?.endpoints) {
    await io.setProviderEndpoints(payload.providerEndpoints);
  }

  if (payload.secrets != null) {
    // Throws ExportPassphraseError on a bad passphrase BEFORE any secret
    // is written — secrets import is all-or-nothing.
    const secrets = await decryptWithPassphrase(passphrase ?? '', payload.secrets);
    for (const [name, value] of Object.entries(secrets)) {
      if (typeof value !== 'string') continue;
      await io.setSecret(name, value);
      imported.secrets++;
    }
  }

  if (payload.memory?.docs) {
    const res = await io.importMemory(payload.memory);
    imported.memoryWritten = res.written;
  }

  for (const record of payload.hooks ?? []) {
    await io.saveHook(record);
    imported.hooks++;
  }

  // payload.dweb: nothing to apply in Phase 0. Store packages drop
  // it (notice already in summary); preview packages will consume it when
  // persistent dweb state exists (Phase 2).

  return { ok: true, imported, notices: summary.notices };
};
