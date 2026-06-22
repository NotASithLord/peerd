// @ts-check
// peerd-engine/export.js — .peerd artifact export/import (DESIGN-10).
//
// One bundle format under manual shares, web publishing, and (later)
// dwapps: the envelope wraps the SAME canonical manifest + 256KiB
// chunks the dweb addresses, serialized to a single JSON file. A file
// exported today is already addressable tomorrow — its manifest hash
// never changes. v1 envelopes are UNSIGNED (publisher/sig absent;
// Phase 2's vault-seeded identity adds signing without a format
// change), which is why everything here rides /shared/bundle/ and
// never touches the dweb module — exports must work in store
// builds, which prune the dweb module entirely.
//
// Pure-ish by the module rule: values in, envelope out. The SW injects
// all IO (registry reads, OPFS trees, the stored image pin).

import { packBundle, unpackBundle } from '/shared/bundle/bundle.js';
import { buildManifest, manifestHash, verifyManifestChunks } from '/shared/bundle/manifest.js';
import { utf8, toBase64, fromBase64, concat } from '/shared/bundle/bytes.js';
import {
  ArtifactTooLargeError,
  EnvelopeFormatError,
  EnvelopeIntegrityError,
} from './errors.js';

export const EXPORT_FORMAT = 'peerd-bundle';
export const EXPORT_VERSION = 1;
// 64 MB payload rail — everything is in-memory base64 (see DESIGN-10
// "Size + safety rails"); the limit exists for the pathological case.
export const EXPORT_LIMIT_BYTES = 64 * 1024 * 1024;

/** @typedef {'app' | 'notebook' | 'vm'} Kind */

// manifest.type <-> meta.kind for the three artifact kinds. The
// manifest type is the content layer's vocabulary; `kind` is what the
// UI and the import routes speak.
/** @type {Record<Kind, string>} */
const TYPE_BY_KIND = {
  app: 'app',
  notebook: 'notebook',
  vm: 'vm-recipe',
};
/** @type {Record<Kind, string>} */
const MIME_BY_KIND = {
  app: 'application/peerd-app',
  notebook: 'application/peerd-notebook',
  vm: 'application/peerd-vm-recipe',
};

// File maps arrive as text (the OPFS read surface) or bytes; the bundle
// layer speaks bytes only.
/**
 * @param {Record<string, string | Uint8Array>} [files]
 * @returns {Record<string, Uint8Array>}
 */
const toByteFiles = (files = {}) => {
  /** @type {Record<string, Uint8Array>} */
  const out = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = typeof content === 'string' ? utf8(content) : content;
  }
  return out;
};

/**
 * @typedef {{ format: 'peerd-bundle', version: number,
 *             manifest: Record<string, any>, chunks: string[] }} PeerdEnvelope
 */

/**
 * @param {{ payload: Uint8Array, kind: Kind, entry?: string,
 *           meta: Record<string, any> }} args
 * @returns {Promise<PeerdEnvelope>}
 */
const packEnvelope = async ({ payload, kind, entry, meta }) => {
  if (payload.length > EXPORT_LIMIT_BYTES) {
    throw new ArtifactTooLargeError(payload.length, EXPORT_LIMIT_BYTES);
  }
  const { manifest, chunks } = await buildManifest({
    payload,
    type: TYPE_BY_KIND[kind],
    mime: MIME_BY_KIND[kind],
    entry,
    meta,
  });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    manifest,
    // why manifest order: the file is self-verifying — chunk i is
    // checked against manifest.chunks[i] on import, no index needed.
    chunks: chunks.map(toBase64),
  };
};

/**
 * App → envelope. `files` is the OPFS tree under peerd-apps/<id>/
 * (path → text|bytes); entry comes from the AppRecord.
 *
 * @param {{ record: { name: string, entryFile: string, tags?: string[] },
 *           files: Record<string, string | Uint8Array> }} args
 */
export const buildAppExport = async ({ record, files }) => packEnvelope({
  payload: packBundle({ entry: record.entryFile, files: toByteFiles(files) }),
  kind: 'app',
  entry: record.entryFile,
  meta: { kind: 'app', name: record.name, tags: record.tags ?? [] },
});

/**
 * Notebook → envelope. `files` is the OPFS tree under
 * peerd-notebooks/<id>/; Notebooks have no entry file.
 *
 * @param {{ record: { name: string },
 *           files: Record<string, string | Uint8Array> }} args
 */
export const buildNotebookExport = async ({ record, files }) => packEnvelope({
  payload: packBundle({ files: toByteFiles(files) }),
  kind: 'notebook',
  meta: { kind: 'notebook', name: record.name },
});

/**
 * VM → recipe envelope. v1 deliberately does NOT export the block
 * overlay (per-VM IDB devices run 100s of MB–GBs); the recipe carries
 * the base-image URL plus its TOFU pin, so an import pins the image
 * BEFORE first boot — receiver integrity is strictly stronger than a
 * fresh local VM. `files` stays empty (reserved for a future
 * /setup.sh seed).
 *
 * @param {{ record: { name: string },
 *           pin: { totalBytes: number | null, headSha256: string },
 *           imageUrl: string }} args
 */
export const buildVmRecipeExport = async ({ record, pin, imageUrl }) => packEnvelope({
  payload: packBundle({ files: {} }),
  kind: 'vm',
  meta: {
    kind: 'vm',
    name: record.name,
    image: {
      url: imageUrl,
      // pinnedAt deliberately stays home — it's local TOFU bookkeeping,
      // not image identity, and would churn the content hash.
      pin: { totalBytes: pin.totalBytes ?? null, headSha256: pin.headSha256 },
    },
  },
});

/**
 * Parse + verify an envelope and unpack its payload. Fails closed with
 * typed errors (EnvelopeFormatError / EnvelopeIntegrityError /
 * ArtifactTooLargeError) — callers that want `{ ok }` replies use
 * inspectEnvelope or catch these.
 *
 * @param {any} envelope
 * @returns {Promise<{
 *   manifest: any, hash: string, kind: 'app' | 'notebook' | 'vm',
 *   name: string, meta: Record<string, any>,
 *   entry: string | undefined, files: Record<string, Uint8Array>,
 *   summary: { kind: string, name: string, size: number, fileCount: number },
 * }>}
 */
export const openEnvelope = async (envelope) => {
  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeFormatError('not an object');
  }
  if (envelope.format !== EXPORT_FORMAT) {
    throw new EnvelopeFormatError(`format is not '${EXPORT_FORMAT}'`);
  }
  if (envelope.version !== EXPORT_VERSION) {
    throw new EnvelopeFormatError(`unsupported version: ${envelope.version}`);
  }
  const { manifest } = envelope;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(envelope.chunks)) {
    throw new EnvelopeFormatError('missing manifest or chunks');
  }
  if (!Number.isInteger(manifest.size) || manifest.size > EXPORT_LIMIT_BYTES) {
    throw new ArtifactTooLargeError(manifest.size ?? -1, EXPORT_LIMIT_BYTES);
  }
  const meta = manifest.meta;
  // why unknown (not the inferred any): forces the equality guard below to
  // narrow `kind` to the Kind union so the TYPE_BY_KIND index is sound.
  /** @type {unknown} */
  const kind = meta?.kind;
  if (kind !== 'app' && kind !== 'notebook' && kind !== 'vm') {
    throw new EnvelopeFormatError(`unknown artifact kind: ${String(kind)}`);
  }
  if (TYPE_BY_KIND[kind] !== manifest.type) {
    throw new EnvelopeFormatError(`manifest type '${manifest.type}' does not match kind '${kind}'`);
  }

  let chunks;
  try {
    chunks = envelope.chunks.map(/** @param {string} b64 */ (b64) => fromBase64(b64));
  } catch {
    throw new EnvelopeFormatError('chunk is not valid base64');
  }
  // Hash verification: every chunk against the manifest's commitments.
  const verdict = await verifyManifestChunks(manifest, chunks);
  if (!verdict.ok) throw new EnvelopeIntegrityError(verdict.reason);

  let unpacked;
  try {
    unpacked = unpackBundle(concat(...chunks));
  } catch {
    throw new EnvelopeFormatError('payload is not a peerd bundle');
  }

  const name = typeof meta.name === 'string' && meta.name ? meta.name : `imported-${kind}`;
  return {
    manifest,
    hash: await manifestHash(manifest),
    kind,
    name,
    meta,
    entry: unpacked.entry,
    files: unpacked.files,
    summary: {
      kind,
      name,
      size: manifest.size,
      fileCount: Object.keys(unpacked.files).length,
    },
  };
};

/**
 * Inspect-then-apply, step one (transfer.js precedent): parse + verify
 * and report what the file contains BEFORE any write. Normalized
 * `{ ok }` reply shape for the message routes.
 *
 * @param {any} envelope
 * @returns {Promise<{ ok: true, summary: { kind: string, name: string, size: number, fileCount: number } }
 *                  | { ok: false, error: string }>}
 */
export const inspectEnvelope = async (envelope) => {
  try {
    const { summary } = await openEnvelope(envelope);
    return { ok: true, summary };
  } catch (e) {
    if (e instanceof EnvelopeFormatError
        || e instanceof EnvelopeIntegrityError
        || e instanceof ArtifactTooLargeError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
};

/**
 * `<name>-<kind>.peerd`, sanitized for every OS file picker: keep
 * word chars/dots/hyphens, collapse the rest to single hyphens.
 *
 * @param {string} name
 * @param {'app' | 'notebook' | 'vm'} kind
 */
export const exportFilename = (name, kind) => {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${base || 'artifact'}-${kind}.peerd`;
};
