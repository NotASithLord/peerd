// @ts-check
// peerd-runtime/transfer/self-sync-surfaces.js — the runtime side of
// self-device state transfer: shaping durable stores INTO the logical sync
// surfaces (self/sync.js) on the source, and materializing them on the
// receiver.
//
// This is the "durable content vs device-local bookkeeping" separation the
// issue demands, made concrete per surface. Pure functions over INJECTED IO
// — no chrome.*, no dweb import — so every projection is Bun-testable and
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
//   hooks              user hook records — applied DISABLED + UNTRUSTED
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
// shared/bundle primitives — the SAME bytes the dweb sync module's
// encode/decodeSurfacePayload produce, kept in lockstep by their shared
// JSON+utf8 shape (self-sync-surfaces.test.ts round-trips it).

import { utf8, fromUtf8 } from '/shared/bundle/bytes.js';

// ── the person-portable session projection ───────────────────────────
// A session record carries two intermixed things: DURABLE conversation
// content (the messages, model, title, cost, timestamps) and DEVICE-LOCAL
// runtime bookkeeping (actor lineage, instance handles, origin authority,
// live prewalk/trim state). Only the former is a person's; the latter is
// meaningless — or dangerous — on another install (issue §10: instantiate
// fresh environments, don't transplant handles).

// Fields that are DEVICE-LOCAL runtime bookkeeping — never travel.
const SESSION_LOCAL_FIELDS = Object.freeze([
  'grantedTools', 'spawnedTrusted', 'instanceId', 'actorType', 'backing',
  'originState', 'review', 'prewalk', 'permissionMode', 'confirmActions',
  'parentSessionId', 'task', 'depth',
]);

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
  const clean = { ...session };
  for (const field of SESSION_LOCAL_FIELDS) delete clean[field];
  const messages = Array.isArray(session.messages)
    ? session.messages.map((/** @type {any} */ message) => {
        const { actorDelivery, actorReplyPending, streaming, ...rest } = message ?? {};
        return rest;
      })
    : [];
  return { ...clean, kind: 'chat', depth: 0, messages };
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
  let written = 0;
  let skipped = 0;
  for (const session of payload?.sessions ?? []) {
    if (!session || typeof session.sessionId !== 'string') { skipped++; continue; }
    if (existingIds.has(session.sessionId)) { skipped++; continue; }
    await putSession(portableSession(session));
    written++;
  }
  return { written, skipped };
};

// ── generic value surfaces (settings / endpoints / memory / hooks / skills) ──

/** @param {{ settings: Record<string, unknown> }} args */
export const shapeSettingsSurface = ({ settings }) => ({ v: 1, settings: settings ?? {} });

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
export const shapeSecretsSurface = ({ secrets }) => ({ v: 1, secrets: secrets ?? {} });

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

/**
 * @param {any} payload
 * @param {{ existingHashes: Set<string>, installApp: (app: any) => Promise<void> }} io
 * @returns {Promise<{ installed: number, skipped: number }>}
 */
export const applyAppsSurface = async (payload, { existingHashes, installApp }) => {
  let installed = 0;
  let skipped = 0;
  for (const app of payload?.apps ?? []) {
    if (!app || typeof app.name !== 'string' || !app.files) { skipped++; continue; }
    if (app.contentHash && existingHashes.has(app.contentHash)) { skipped++; continue; }
    await installApp(app);
    installed++;
  }
  return { installed, skipped };
};

// ── workspaces (OPFS content, never handles) ─────────────────────────

/**
 * A workspace snapshot: a flat map of relative path -> base64 bytes for one
 * logical workspace (a Notebook/Pod root). The source walks the OPFS tree
 * (opfsHelpers.list/readBytes); the receiver materializes into a FRESH root
 * (opfsHelpers.write) — no platform handle ever crosses.
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
 * Encode a shaped surface payload into transferable bytes — the exact
 * JSON+utf8 shape self/sync.js encodeSurfacePayload produces.
 * @param {unknown} shaped
 */
export const encodeSurface = (shaped) => utf8(JSON.stringify(shaped));

/**
 * Decode received surface bytes back into the logical payload.
 * @param {Uint8Array} bytes
 */
export const decodeSurface = (bytes) => JSON.parse(fromUtf8(bytes));
