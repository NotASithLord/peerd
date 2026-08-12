// @ts-check
// peerd-runtime/transfer/self-sync-surfaces.js: the runtime side of
// self-device state transfer: shaping durable stores INTO the logical sync
// surfaces (self/sync.js) on the source, and materializing them on the
// receiver.
//
// This is the "durable content vs device-local bookkeeping" separation the
// issue demands, made concrete per surface. Pure functions over INJECTED IO
// - no chrome.*, no dweb import, so every projection is Bun-testable and
// the file ships in store packages (it names no dweb module path; the store
// artifact verifier greps the shipped bytes, comments included). The sync
// host calls a shaper for a pulled surface and an applier on the receiver;
// secrets ride the same shape but are gated by the source including them
// only on explicit consent.
//
// The projections, and what each drops:
//   settings           explicit values only (already the export shape)
//   providerEndpoints  user-added endpoints (re-validated on apply)
//   memory             memory.exportAll() payload (its own merge on apply)
//   hooks              user hook records, applied DISABLED + UNTRUSTED
//   skills             metadata only (bodies reinstall from origin)
//   sessions           conversation content with ALL actor/runtime
//                      bookkeeping stripped (portableSession below)
//   apps               logical App artifacts (manifest + body/assets),
//                      never the local IDB handle
//   workspaces         path→bytes tree snapshots, never OPFS handles
//   secrets            re-encryptable name→value map (consent-gated)
//
// why NOT import the dweb sync module here: the dweb boundary forbids core
// code from importing that module at all, and this file ships in store
// packages. The surface encode/decode is plain JSON over the store-safe
// shared/bundle primitives: the SAME bytes the dweb sync module's
// encode/decodeSurfacePayload produce, kept in lockstep by their shared
// JSON+utf8 shape (self-sync-surfaces.test.ts round-trips it).

import { utf8, fromUtf8 } from '/shared/bundle/bytes.js';
import { isCustodySecretName, portableSecretEntries } from './secret-policy.js';

// ── the person-portable session projection ───────────────────────────
// A session record carries two intermixed things: DURABLE conversation
// content (the messages, model, title, cost, timestamps) and DEVICE-LOCAL
// runtime bookkeeping (actor lineage, instance handles, origin authority,
// live prewalk/trim state). Only the former is a person's; the latter is
// meaningless, or dangerous, on another install (issue §10: instantiate
// fresh environments, don't transplant handles).

// Positive lists are deliberate: a newly-added authority or runtime field
// must be reviewed before it can cross devices. A blacklist silently made
// fields such as trimSummary portable when the session schema grew.
const PORTABLE_SESSION_FIELDS = Object.freeze([
  'sessionId', 'createdAt', 'provider', 'model', 'archivedAt', 'title',
  'cost', 'customSystemPrompt',
]);
const PORTABLE_MESSAGE_FIELDS = Object.freeze([
  'id', 'role', 'content', 'toolUses', 'toolResults', 'model', 'provider',
  'error', 'stopReason', 'synthetic', 'when', 'generation',
]);

/** @param {any} value @param {readonly string[]} fields */
const pick = (value, fields) => Object.fromEntries(
  fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]),
);

// Only top-level chats are person-portable; actor/spawned sessions are
// bound to instances that don't exist on the receiver.
/** @param {any} session */
const isPortableSession = (session) =>
  session && (session.kind === 'chat' || session.kind === undefined) && !session.parentSessionId;

/**
 * Project one session record into its person-portable form: keep the
 * conversation, drop the bookkeeping, and strip per-message actor/streaming
 * scaffolding down to role/content/tool shape.
 * @param {any} session
 */
export const portableSession = (session) => {
  const messages = Array.isArray(session.messages)
    ? session.messages.map((/** @type {any} */ message) => pick(message, PORTABLE_MESSAGE_FIELDS))
    : [];
  return { ...pick(session, PORTABLE_SESSION_FIELDS), kind: 'chat', depth: 0, messages };
};

/**
 * Shape the sessions surface: every portable chat, projected.
 * @param {{ sessions: any[] }} args
 */
export const shapeSessionsSurface = ({ sessions }) => ({
  v: 1,
  sessions: (sessions ?? []).filter(isPortableSession).map(portableSession),
});

/**
 * Apply a sessions surface. Idempotent by sessionId: an existing session on
 * the receiver is left alone (conflict behavior = keep destination), a new
 * one is written whole. Never resurrects an archived local session.
 * @param {any} payload
 * @param {{ existingIds: Set<string>, putSession: (session: any) => Promise<void> }} io
 * @returns {Promise<{ written: number, skipped: number }>}
 */
export const applySessionsSurface = async (payload, { existingIds, putSession }) => {
  if (!payload || payload.v !== 1 || !Array.isArray(payload.sessions)) {
    throw new Error('sessions surface payload is malformed or unsupported');
  }
  let written = 0;
  let skipped = 0;
  for (const session of payload?.sessions ?? []) {
    if (!session || typeof session.sessionId !== 'string') {
      throw new Error('sessions surface contains a malformed session');
    }
    if (existingIds.has(session.sessionId)) { skipped++; continue; }
    try {
      await putSession(portableSession(session));
      written++;
    } catch (error) {
      // The surface is item-atomic, not transaction-atomic. Preserve the
      // durable count in the thrown result so the transport cannot report
      // `applied: []` after earlier chats already committed.
      if (written > 0) throw new SurfaceApplyPartialError('sessions', { written, skipped }, error);
      throw error;
    }
  }
  return { written, skipped };
};

export class SurfaceApplyPartialError extends Error {
  /** @param {string} surface @param {Record<string, number>} result @param {unknown} cause */
  constructor(surface, result, cause) {
    super(`${surface} surface applied only part of its items`, { cause });
    this.name = 'SurfaceApplyPartialError';
    this.surface = surface;
    this.result = result;
  }
}

// ── generic value surfaces (settings / endpoints / memory / hooks / skills) ──

/** @param {{ settings: Record<string, unknown> }} args */
export const shapeSettingsSurface = ({ settings }) => {
  // Transport lifecycle is device-local. Moving `dwebEnabled:false` while a
  // restore is using that same transport would ask stop() to await itself.
  const { dwebEnabled: _transportControl, ...portable } = settings ?? {};
  return { v: 1, settings: portable };
};

/** @param {{ providerEndpoints: any }} args */
export const shapeProviderEndpointsSurface = ({ providerEndpoints }) =>
  ({ v: 1, providerEndpoints: providerEndpoints ?? null });

/** @param {{ memory: any }} args */
export const shapeMemorySurface = ({ memory }) => ({ v: 1, memory: memory ?? null });

/** @param {{ hooks: any[] }} args */
export const shapeHooksSurface = ({ hooks }) => ({ v: 1, hooks: hooks ?? [] });

/** @param {{ skills: any[] }} args */
export const shapeSkillsSurface = ({ skills }) => ({ v: 1, skills: skills ?? [] });

/** @param {{ secrets: Record<string, string> }} args */
export const shapeSecretsSurface = ({ secrets }) => ({
  v: 1,
  secrets: portableSecretEntries(secrets),
});

/**
 * Apply only ordinary provider/user secrets. Inbound filtering is mandatory
 * even though the sender filters: an authenticated but compromised self
 * device must not overwrite identity or per-install custody.
 * @param {any} payload
 * @param {{ setSecret: (name: string, value: string) => Promise<void> }} io
 */
export const applySecretsSurface = async (payload, { setSecret }) => {
  let written = 0;
  let refused = 0;
  for (const [name, value] of Object.entries(payload?.secrets ?? {})) {
    if (isCustodySecretName(name) || typeof value !== 'string') { refused++; continue; }
    await setSecret(name, value);
    written++;
  }
  return { written, refused };
};

// ── apps (logical artifacts) ─────────────────────────────────────────
// An App's portable form is its manifest + content-addressed files, NOT the
// local IDB record. On apply the receiver installs into fresh storage; a
// content hash lets a future delta layer skip re-transfer of identical
// bytes (base-network.js re-chunks deterministically, so identical files
// hash identically across devices).

/**
 * @param {{ apps: Array<{ id?: string, name: string, entryFile: string,
 *   fileKinds?: Record<string, string>, files: Record<string, string>,
 *   contentHash?: string, meta?: any }> }} args
 */
export const shapeAppsSurface = ({ apps }) => ({
  v: 1,
  apps: (apps ?? []).map((app) => ({
    name: app.name,
    entryFile: app.entryFile,
    fileKinds: app.fileKinds ?? {},
    files: app.files, // path -> base64
    ...(app.contentHash ? { contentHash: app.contentHash } : {}),
    ...(app.meta ? { meta: app.meta } : {}),
  })),
});

/** @param {any} app */
const appHashBytes = (app) => utf8(JSON.stringify({
  name: app.name,
  entryFile: app.entryFile,
  fileKinds: Object.fromEntries(Object.entries(app.fileKinds ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  files: Object.fromEntries(Object.entries(app.files ?? {}).sort(([a], [b]) => a.localeCompare(b))),
}));

/** @param {any} app */
const portableAppHash = async (app) => {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', /** @type {BufferSource} */ (appHashBytes(app)),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Capture every live App before declaring the Apps surface available. A
 * partial list is not an honest snapshot: the remote side has no inventory
 * against which it could detect an App silently omitted after a read error.
 *
 * @param {{ records: any[], snapshotApp: (record: any) => Promise<any>, maxBytes?: number }} args
 */
export const captureAppsSurface = async ({ records, snapshotApp, maxBytes = 64 * 1024 * 1024 }) => {
  const apps = [];
  let capturedBytes = 0;
  for (const record of records ?? []) {
    const app = await snapshotApp(record);
    const appBytes = appHashBytes(app).length;
    if (capturedBytes + appBytes > maxBytes) throw new Error('Apps surface exceeds its transfer cap');
    capturedBytes += appBytes;
    // The transfer identity belongs to the captured bytes, never registry
    // metadata. Imported Apps may retain an earlier snapshot hash, but local
    // edits make it stale; recomputing here keeps sync -> edit -> sync honest.
    apps.push({ ...app, contentHash: await portableAppHash(app) });
  }
  return shapeAppsSurface({ apps });
};

/**
 * @param {any} payload
 * @param {{ existingHashes: Set<string>, installApp: (app: any) => Promise<void> }} io
 * @returns {Promise<{ installed: number, skipped: number }>}
 */
export const applyAppsSurface = async (payload, { existingHashes, installApp }) => {
  if (!payload || payload.v !== 1 || !Array.isArray(payload.apps)) {
    throw new Error('apps surface payload is malformed or unsupported');
  }
  let installed = 0;
  let skipped = 0;
  for (const app of payload?.apps ?? []) {
    if (!app || typeof app.name !== 'string' || !app.files || typeof app.files !== 'object') {
      throw new Error('apps surface contains a malformed App');
    }
    if (app.contentHash && existingHashes.has(app.contentHash)) { skipped++; continue; }
    try {
      await installApp(app);
      installed++;
    } catch (error) {
      if (installed > 0) throw new SurfaceApplyPartialError('apps', { installed, skipped }, error);
      throw error;
    }
  }
  return { installed, skipped };
};

// ── workspaces (OPFS content, never handles) ─────────────────────────

/**
 * A workspace snapshot: a flat map of relative path -> base64 bytes for one
 * logical workspace (a Notebook/Pod root). The source walks the OPFS tree
 * (opfsHelpers.list/readBytes); the receiver materializes into a FRESH root
 * (opfsHelpers.write): no platform handle ever crosses.
 * @param {{ workspaces: Array<{ id: string, kind: string, files: Record<string, string> }> }} args
 */
export const shapeWorkspacesSurface = ({ workspaces }) => ({
  v: 1,
  workspaces: (workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    kind: workspace.kind,
    files: workspace.files, // relPath -> base64
  })),
});

/**
 * @param {any} payload
 * @param {{ materializeWorkspace: (workspace: any) => Promise<void> }} io
 * @returns {Promise<{ materialized: number, skipped: number }>}
 */
export const applyWorkspacesSurface = async (payload, { materializeWorkspace }) => {
  let materialized = 0;
  let skipped = 0;
  for (const workspace of payload?.workspaces ?? []) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.files) { skipped++; continue; }
    await materializeWorkspace(workspace);
    materialized++;
  }
  return { materialized, skipped };
};

// ── the surface encode/decode seam the sync host uses ────────────────

/**
 * Encode a shaped surface payload into transferable bytes: the exact
 * JSON+utf8 shape self/sync.js encodeSurfacePayload produces.
 * @param {unknown} shaped
 */
export const encodeSurface = (shaped) => utf8(JSON.stringify(shaped));

/**
 * Decode received surface bytes back into the logical payload.
 * @param {Uint8Array} bytes
 */
export const decodeSurface = (bytes) => JSON.parse(fromUtf8(bytes));
