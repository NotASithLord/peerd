// @ts-check
// SW-side App client.
//
// Apps are multi-file artifacts stored in OPFS at
// `peerd-apps/<appId>/`. The registry tracks metadata (name, tags,
// entryFile, timestamps). When an app tab opens, the parent page
// reads OPFS directly + composes a single HTML body for the
// sandboxed runner (see peerd-engine/app-compose.js).
//
// Note on IDB: the old `peerd-app-bodies` store from the single-blob
// era stays put -- it's reserved for the future snapshot tier
// (immutable, addressable "save this version" records). New apps
// don't touch it.

import {
  inferAppFileKind,
  isBinaryAppFile,
  isBinaryAssetPath,
  isLosslessUtf8Text,
  opfsHelpers,
  buildAppManifest,
  parseAppManifest,
} from '/peerd-engine/background.js';
import { base64ByteLength, fromBase64, toBase64 } from '/shared/bundle/bytes.js';

export const APP_TAB_GROUP_TITLE = 'peerd';

// These are storage-layer rails. Tool schemas keep smaller model-facing writes
// useful, but every caller, including imports and dweb installs, meets these
// limits again beside the OPFS write.
export const MAX_APP_TOTAL_BYTES = 50_000_000;
export const MAX_APP_FILES = 256;
const MAX_APP_PATH_CHARS = 512;

export class AppFileContentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AppFileContentError';
  }
}

export class AppFileLimitError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AppFileLimitError';
  }
}

export class AppBinaryFileError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`binary App asset cannot be read or edited as text: ${path}. Replace it with app_write_file contentBase64.`);
    this.name = 'AppBinaryFileError';
    this.code = 'binary_asset_not_text';
  }
}

export class AppDefaultMissingError extends Error {
  constructor() {
    // why: resolving a session default happens before OPFS is touched. The
    // type lets trusted callers report that proven refusal without matching
    // or forwarding storage-layer prose.
    super('no current app for this session; create one first');
    this.name = 'AppDefaultMissingError';
    this.code = 'app_default_missing';
  }
}

/**
 * @param {unknown} original
 * @param {PromiseSettledResult<unknown>[]} cleanup
 */
const throwAppRollbackResult = (original, cleanup) => {
  const cleanupFailures = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => /** @type {PromiseRejectedResult} */ (result).reason);
  if (!cleanupFailures.length) throw original;
  // why: once catalog/OPFS/repository creation began, failed rollback proves
  // durable residue may remain. Report performed custody and forbid retry.
  const failure = new AggregateError(
    [original, ...cleanupFailures],
    `App creation failed and rollback was incomplete: ${String(/** @type {any} */ (original)?.message ?? original)}`,
  );
  Object.assign(failure, {
    performed: true,
    outcomeKnown: false,
    outcomeKind: 'host-lost',
    retryable: false,
  });
  throw failure;
};

/**
 * A completed rollback proves the attempted mutation left no durable change.
 * Keep the original failure only as an internal cause; the host-facing message
 * and custody fields are fixed and cannot inherit storage/backend text.
 * @param {unknown} cause
 * @param {string} message
 */
const appRollbackCompleted = (cause, message) => Object.assign(
  new Error(message, { cause }),
  {
    performed: false,
    outcomeKnown: true,
    outcomeKind: 'pre-effect-failure',
    retryable: true,
  },
);

/** @param {unknown[]} failures @param {string} message */
const appRollbackIncomplete = (failures, message) => Object.assign(
  new AggregateError(failures, message),
  {
    performed: true,
    outcomeKnown: false,
    outcomeKind: 'host-lost',
    retryable: false,
  },
);

/** @param {string} path */
const validateAppPath = (path) => {
  if (typeof path !== 'string' || !path || path.length > MAX_APP_PATH_CHARS) {
    throw new AppFileContentError('app file path is missing or too long');
  }
  const parts = path.split('/');
  if (path.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new AppFileContentError(`unsafe app file path: ${path}`);
  }
  return path;
};

/**
 * Normalize one text, byte, or JSON-safe base64 value before any storage write.
 * The encoded-length rail runs before atob so a hostile transport string cannot
 * allocate beyond the App ceiling merely to be rejected afterward.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {unknown} [declaredKind]
 * @returns {{ stored: string | Uint8Array<ArrayBuffer>, size: number, kind: 'text' | 'binary' }}
 */
const normalizeFileContent = (path, value, declaredKind) => {
  if (typeof value === 'string') {
    if (isBinaryAssetPath(path) || declaredKind === 'binary') {
      throw new AppFileContentError(`binary App asset requires bytes or { base64 }: ${path}`);
    }
    return { stored: value, size: new TextEncoder().encode(value).byteLength, kind: 'text' };
  }
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let stored = null;
  let transportKind = declaredKind;
  if (value instanceof Uint8Array) {
    stored = new Uint8Array(value);
    if (transportKind !== 'text' && transportKind !== 'binary') transportKind = 'auto';
  } else {
    const envelope = value && typeof value === 'object'
      ? /** @type {{ base64?: unknown, kind?: unknown }} */ (value)
      : null;
    const base64 = envelope?.base64;
    if (typeof base64 !== 'string') {
      throw new AppFileContentError('App file content must be text, bytes, or { base64 }');
    }
    let decodedUpperBound;
    try { decodedUpperBound = base64ByteLength(base64); }
    catch { throw new AppFileContentError('App file is not valid base64'); }
    if (decodedUpperBound > MAX_APP_TOTAL_BYTES) {
      throw new AppFileLimitError('encoded App file exceeds the storage limit');
    }
    try { stored = fromBase64(base64); }
    catch { throw new AppFileContentError('App file is not valid base64'); }
    if (transportKind !== 'text' && transportKind !== 'binary') {
      transportKind = envelope?.kind === 'auto' ? 'auto' : 'binary';
    }
  }
  const kind = transportKind === 'text'
    ? 'text'
    : transportKind === 'binary'
      ? 'binary'
      : inferAppFileKind(path, stored);
  if (kind === 'text' && (isBinaryAssetPath(path) || !isLosslessUtf8Text(stored))) {
    throw new AppFileContentError(`App text file is not lossless UTF-8: ${path}`);
  }
  return { stored, size: stored.byteLength, kind };
};

/**
 * @param {Record<string, unknown>} fileMap
 * @param {string} entry
 * @param {Record<string, unknown>} [declaredKinds]
 */
const normalizeFileMap = (fileMap, entry, declaredKinds = {}) => {
  const entries = Object.entries(fileMap);
  if (!entries.length) throw new AppFileContentError('files (or html) required');
  if (entries.length > MAX_APP_FILES) {
    throw new AppFileLimitError(`App has too many files: ${entries.length} > ${MAX_APP_FILES}`);
  }
  validateAppPath(entry);
  if (!Object.hasOwn(fileMap, entry)) {
    throw new AppFileContentError(`entryFile not in files: ${entry}`);
  }

  /** @type {Array<{ path: string, stored: string | Uint8Array<ArrayBuffer>, size: number, kind: 'text' | 'binary' }>} */
  const files = [];
  /** @type {Record<string, 'text' | 'binary'>} */
  const fileKinds = Object.create(null);
  let totalBytes = 0;
  for (const [path, value] of entries) {
    validateAppPath(path);
    const normalized = normalizeFileContent(path, value, declaredKinds[path]);
    if (path === entry && normalized.kind !== 'text') {
      throw new AppFileContentError(`entryFile must be text: ${entry}`);
    }
    totalBytes += normalized.size;
    if (totalBytes > MAX_APP_TOTAL_BYTES) {
      throw new AppFileLimitError(`App is too large: ${totalBytes} > ${MAX_APP_TOTAL_BYTES} bytes`);
    }
    fileKinds[path] = normalized.kind;
    files.push({ path, ...normalized });
  }
  return { files, fileKinds, totalBytes };
};

/** @param {string} appId @param {() => void | Promise<void>} [beforeMutation] */
const opfsForApp = (appId, beforeMutation = () => {}) =>
  opfsHelpers(['peerd-apps', appId], { beforeMutation });

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/background.js').createAppRegistry>} deps.registry
 * @param {ReturnType<typeof import('./app-tab-tracker.js').createAppTabTracker>} deps.tracker
 * @param {() => void | Promise<void>} [deps.beforeOpfsMutation]
 * @param {(appId:string)=>void|Promise<void>} [deps.onManifestMutation]
 * @param {(ownerSessionId:string,record:any)=>Promise<string>} [deps.resolveOwnerRoot]
 * @param {ReturnType<typeof import('/peerd-engine/repository.js').createRepositoryService>} [deps.repositories]
 */
export const createAppClient = ({
  registry, tracker, beforeOpfsMutation = () => {}, onManifestMutation = () => {},
  resolveOwnerRoot = async (ownerSessionId) => ownerSessionId, repositories = undefined,
}) => {
  // why injected: App files are a self-hosted durable surface. The lifecycle
  // schema guard must run at the physical OPFS boundary, including callers of
  // the exposed helper, without making the engine module import runtime policy.
  const guardedOpfsForApp = (/** @type {string} */ appId) =>
    opfsForApp(appId, beforeOpfsMutation);
  /** @type {Map<string, Promise<unknown>>} */
  const mutationTails = new Map();

  /**
   * Serialize mutations per App so two independently authorized callers cannot
   * both pass a stale aggregate-size check and overfill the same OPFS tree.
   * @template T
   * @param {string} appId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const withLocalMutation = async (appId, operation) => {
    const prior = mutationTails.get(appId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    mutationTails.set(appId, current);
    try { return await current; }
    finally {
      if (mutationTails.get(appId) === current) mutationTails.delete(appId);
    }
  };
  /**
   * Serialize every App byte mutation with repository restore/checkout/commit.
   * Tests and embedders that do not install browser Git retain the original
   * local lane; the production service always supplies the repository lane.
   * @template T
   * @param {string} appId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const withMutation = (appId, operation) => repositories?.coordinate
    ? repositories.coordinate({ kind: 'app', id: appId }, () => withLocalMutation(appId, operation))
    : withLocalMutation(appId, operation);

  /**
   * Hold the complete App/repository transaction lane. Callers using this must
   * perform raw workspace operations inside the callback rather than re-entering
   * a client mutation method.
   * @template T
   * @param {string} appId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const withWriteLock = (appId, operation) => repositories?.coordinate
    ? repositories.coordinate({ kind: 'app', id: appId }, operation)
    : withLocalMutation(appId, operation);

  /** @param {ReturnType<typeof opfsForApp>} opfs */
  const currentFileSizes = async (opfs) => {
    const sizes = new Map();
    for (const file of await opfs.list()) sizes.set(file.path.replace(/^\/+/, ''), file.size);
    return sizes;
  };

  /**
   * @param {Map<string, number>} current
   * @param {Array<{ path: string, size: number }>} replacements
   */
  const assertReplacementFits = (current, replacements) => {
    const next = new Map(current);
    for (const { path, size } of replacements) next.set(path, size);
    if (next.size > MAX_APP_FILES) {
      throw new AppFileLimitError(`App has too many files: ${next.size} > ${MAX_APP_FILES}`);
    }
    let totalBytes = 0;
    for (const size of next.values()) totalBytes += size;
    if (totalBytes > MAX_APP_TOTAL_BYTES) {
      throw new AppFileLimitError(`App is too large: ${totalBytes} > ${MAX_APP_TOTAL_BYTES} bytes`);
    }
  };

  /** @param {ReturnType<typeof opfsForApp>} opfs @param {string} path */
  const deleteIfPresent = async (opfs, path) => {
    try { await opfs.delete(path); }
    catch (error) {
      if (/** @type {{ name?: string }} */ (error)?.name !== 'NotFoundError') throw error;
    }
  };

  /**
   * @param {ReturnType<typeof opfsForApp>} opfs
   * @param {Map<string, Uint8Array<ArrayBuffer> | null>} backups
   */
  const restoreBackups = async (opfs, backups) => {
    /** @type {unknown[]} */
    const errors = [];
    for (const [path, backup] of backups) {
      try {
        if (backup) await opfs.write(path, backup);
        else await deleteIfPresent(opfs, path);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'App byte rollback failed');
  };

  /**
   * Write a group with per-file rollback. Normalization and limit checks happen
   * before the first byte changes; a failed later write restores earlier files.
   * @param {ReturnType<typeof opfsForApp>} opfs
   * @param {Array<{ path: string, stored: string | Uint8Array<ArrayBuffer>, size: number }>} replacements
   * @returns {Promise<() => Promise<void>>}
   */
  const writeReplacements = async (opfs, replacements) => {
    const current = await currentFileSizes(opfs);
    assertReplacementFits(current, replacements);
    /** @type {Map<string, Uint8Array<ArrayBuffer> | null>} */
    const backups = new Map();
    for (const { path } of replacements) {
      backups.set(path, current.has(path) ? await opfs.readBytes(path) : null);
    }
    try {
      for (const { path, stored } of replacements) await opfs.write(path, stored);
    } catch (writeError) {
      try {
        await restoreBackups(opfs, backups);
      } catch (rollbackError) {
        throw appRollbackIncomplete(
          [writeError, rollbackError], 'App write and rollback both failed',
        );
      }
      throw appRollbackCompleted(writeError, 'App write failed; rollback completed');
    }
    return () => restoreBackups(opfs, backups);
  };

  /**
   * Restore the mutable catalog fields changed by App file transactions.
   * @param {string} id
   * @param {import('/peerd-engine/app-registry.js').AppRecord} record
   */
  const restoreRecord = async (id, record) => {
    const restored = await registry.update(id, /** @type {any} */ ({
      name: record.name,
      tags: record.tags,
      entryFile: record.entryFile,
      fileKinds: record.fileKinds ?? {},
      dwebExact: record.dweb ?? null,
    }));
    if (!restored) throw new Error(`app not found during metadata rollback: ${id}`);
  };

  /**
   * @param {unknown} cause
   * @param {(() => Promise<void>) | null} rollbackBytes
   * @param {string} id
   * @param {import('/peerd-engine/app-registry.js').AppRecord} record
   */
  const rollbackMutation = async (cause, rollbackBytes, id, record) => {
    /** @type {unknown[]} */
    const failures = [];
    if (rollbackBytes) {
      try { await rollbackBytes(); } catch (error) { failures.push(error); }
    }
    try { await restoreRecord(id, record); } catch (error) { failures.push(error); }
    if (failures.length) {
      throw appRollbackIncomplete(
        [cause, ...failures], 'App mutation and rollback both failed',
      );
    }
    throw appRollbackCompleted(cause, 'App mutation failed; rollback completed');
  };

  /** @param {{ sessionId?: string, appId?: string }} [opts] @returns {Promise<string>} */
  const resolveId = async ({ sessionId, appId } = {}) => {
    if (appId) {
      const rec = await registry.get(appId);
      if (!rec) throw new Error(`app not found: ${appId}`);
      return appId;
    }
    if (!sessionId) throw new Error('sessionId or appId required');
    const defaultId = await registry.getDefaultForSession(sessionId);
    if (!defaultId) throw new AppDefaultMissingError();
    return defaultId;
  };

  /**
   * Create a new app. `files` is a path → content map; we write each
   * to OPFS. If only `html` is passed, it becomes index.html (back-
   * compat with the single-file model the agent used to assume).
   * @param {{ appId?: string, name?: string, files?: Record<string, unknown>, html?: string,
   *   tags?: string[], entryFile?: string, sessionId?: string,
   *   dweb?: import('/peerd-engine/app-registry.js').AppDwebMeta, source?: string,
   *   fileKinds?: Record<string, unknown>, syncContentHash?: string }} [opts]
   */
  const create = async ({
    appId, name, files, html, tags, entryFile, sessionId, dweb, source, fileKinds, syncContentHash,
  } = {}) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('name required');

    const suppliedFiles = files && typeof files === 'object'
      ? files
      : (typeof html === 'string' ? { 'index.html': html } : null);
    if (!suppliedFiles || !Object.keys(suppliedFiles).length) {
      throw new AppFileContentError('files (or html) required');
    }
    const requestedEntry = entryFile || 'index.html';
    /** @type {Record<string, unknown>} */
    const fileMap = Object.assign(Object.create(null), suppliedFiles);
    if (!Object.hasOwn(fileMap, 'peerd.json')) {
      fileMap['peerd.json'] = `${JSON.stringify(buildAppManifest({
        entry: requestedEntry,
        dwapp: !!dweb,
      }), null, 2)}\n`;
    }
    const manifestContent = normalizeFileContent(
      'peerd.json',
      fileMap['peerd.json'],
      fileKinds?.['peerd.json'],
    );
    if (manifestContent.kind !== 'text') {
      throw new AppFileContentError('peerd.json must be text');
    }
    const contract = parseAppManifest(typeof manifestContent.stored === 'string'
      ? manifestContent.stored
      : new TextDecoder().decode(manifestContent.stored));
    const entry = contract.entry;
    const normalized = normalizeFileMap(fileMap, entry, fileKinds);

    const record = await registry.create({
      ...(appId ? { id: appId } : {}),
      name: name.trim().slice(0, 80),
      tags,
      source,
      entryFile: entry,
      ownerSessionId: sessionId ?? null,
      dweb,
      syncContentHash,
      fileKinds: normalized.fileKinds,
    });

    try {
      const opfs = guardedOpfsForApp(record.id);
      for (const { path, stored } of normalized.files) await opfs.write(path, stored);
      if (repositories?.initApp) {
        await repositories.initApp(record.id, { message: `create ${record.name}` });
      }
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
    } catch (error) {
      const cleanup = await Promise.allSettled([
        guardedOpfsForApp(record.id).nuke(),
        repositories?.destroyApp ? repositories.destroyApp(record.id) : Promise.resolve(),
        registry.delete(record.id),
      ]);
      throwAppRollbackResult(error, cleanup);
    }
    return record;
  };

  /** Clone a repository and instantiate the validated peerd.json contract.
   * @param {{name?:string,url:string,ref?:string,depth?:number,sessionId?:string,signal?:AbortSignal,allowDweb?:boolean}} opts */
  const createFromGit = async ({ name, url, ref, depth = 50, sessionId, signal, allowDweb = false }) => {
    if (typeof url !== 'string') throw new Error('git URL required');
    if (!repositories) throw new Error('browser Git is unavailable');
    await beforeOpfsMutation();
    const record = await registry.create({
      name: (typeof name === 'string' && name.trim() ? name.trim() : 'Git App').slice(0, 80),
      source: 'imported', entryFile: 'index.html', ownerSessionId: sessionId ?? null,
    });
    try {
      const repository = await repositories.clone({ kind: 'app', id: record.id }, {
        url,
        ...(typeof ref === 'string' && ref ? { ref } : {}),
        depth: Math.min(500, Math.max(1, Number(depth) || 50)),
        signal,
      });
      const opfs = guardedOpfsForApp(record.id);
      const listed = await opfs.list();
      if (listed.length > MAX_APP_FILES) {
        throw new AppFileLimitError(`App has too many files: ${listed.length} > ${MAX_APP_FILES}`);
      }
      const paths = new Set();
      /** @type {Record<string, 'text' | 'binary'>} */
      const fileKinds = Object.create(null);
      let totalBytes = 0;
      for (const file of listed) {
        const path = validateAppPath(file.path.replace(/^\/+/, ''));
        paths.add(path);
        const bytes = await opfs.readBytes(path);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_APP_TOTAL_BYTES) {
          throw new AppFileLimitError(`App is too large: ${totalBytes} > ${MAX_APP_TOTAL_BYTES} bytes`);
        }
        fileKinds[path] = inferAppFileKind(path, bytes);
      }
      let contract;
      if (paths.has('peerd.json')) {
        if (fileKinds['peerd.json'] !== 'text') throw new AppFileContentError('peerd.json must be text');
        contract = parseAppManifest(await opfs.read('peerd.json'));
      }
      else if (paths.has('index.html')) contract = parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'index.html' })));
      else throw new Error('repository is not an App: add peerd.json or index.html');
      if (!paths.has(contract.entry)) throw new Error(`peerd.json entry is missing: ${contract.entry}`);
      if (fileKinds[contract.entry] !== 'text') throw new AppFileContentError(`entryFile must be text: ${contract.entry}`);
      if (contract.capabilities.includes('dweb') && !allowDweb) throw new Error('this dwapp requires a preview build with the dweb enabled');
      const dwapp = contract.capabilities.includes('dweb')
        ? { uri: null, publisher: null, hash: null, local: true }
        : null;
      const updated = await registry.update(record.id, {
        entryFile: contract.entry,
        fileKinds,
        ...(dwapp ? { dweb: dwapp } : {}),
      });
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
      return { record: updated, repository, contract };
    } catch (error) {
      const cleanup = await Promise.allSettled([
        repositories.destroy({ kind: 'app', id: record.id }, { worktree: true }),
        registry.delete(record.id),
      ]);
      throwAppRollbackResult(error, cleanup);
    }
  };

  /**
   * Update an existing app. `html` is the convenience for editing the
   * entry file; `path`+`content` updates an arbitrary file. The tab
   * reloads either way so the user sees the result.
   * @param {{ appId?: string, name?: string, html?: string, path?: string,
   *   content?: unknown, tags?: string[], entryFile?: string, sessionId?: string }} [opts]
   */
  const update = async ({ appId, name, html, path, content, tags, entryFile, sessionId } = {}) => {
    const id = await resolveId({ sessionId, appId });
    const updated = await withMutation(id, async () => {
      const rec = await registry.get(id);
      if (!rec) return null;
      const opfs = guardedOpfsForApp(id);
      /** @type {Map<string, { path: string, stored: string | Uint8Array<ArrayBuffer>, size: number, kind: 'text' | 'binary' }>} */
      const replacementMap = new Map();
      if (typeof html === 'string') {
        replacementMap.set(rec.entryFile, { path: rec.entryFile, ...normalizeFileContent(rec.entryFile, html) });
      }
      if (typeof path === 'string' && content !== undefined) {
        validateAppPath(path);
        replacementMap.set(path, { path, ...normalizeFileContent(path, content) });
      }
      const replacements = Array.from(replacementMap.values());

      const nextEntry = typeof entryFile === 'string' ? validateAppPath(entryFile) : rec.entryFile;
      const paths = new Set((await opfs.list()).map((file) => file.path.replace(/^\/+/, '')));
      for (const replacement of replacements) paths.add(replacement.path);
      if (!paths.has(nextEntry)) throw new AppFileContentError(`entryFile not in files: ${nextEntry}`);
      const entryReplacement = replacementMap.get(nextEntry);
      if (entryReplacement?.kind === 'binary') {
        throw new AppFileContentError(`entryFile must be text: ${nextEntry}`);
      }
      if (!entryReplacement) {
        const entryBytes = await opfs.readBytes(nextEntry);
        if (isBinaryAppFile(nextEntry, entryBytes, rec.fileKinds?.[nextEntry])) {
          throw new AppFileContentError(`entryFile must be text: ${nextEntry}`);
        }
      }

      const nextKinds = { ...(rec.fileKinds ?? {}) };
      for (const replacement of replacements) nextKinds[replacement.path] = replacement.kind;
      const rollbackBytes = replacements.length ? await writeReplacements(opfs, replacements) : null;
      /** @type {Partial<import('/peerd-engine/app-registry.js').AppRecord>} */
      const patch = { fileKinds: nextKinds };
      if (typeof name === 'string') patch.name = name.trim().slice(0, 80);
      if (Array.isArray(tags)) patch.tags = tags;
      if (typeof entryFile === 'string') patch.entryFile = entryFile;
      try {
        const result = await registry.update(id, patch);
        if (!result) throw new Error(`app not found after update: ${id}`);
        return result;
      } catch (error) {
        return rollbackMutation(error, rollbackBytes, id, rec);
      }
    });

    if (!updated) return null;
    if (sessionId) await registry.setDefaultForSession(sessionId, id);
    if (path === 'peerd.json') await onManifestMutation(id);
    tracker.reloadTab(id).catch(() => {});
    return updated;
  };

  /** @param {string} id @param {string} path @param {unknown} content */
  const writeFileUnlocked = async (id, path, content) => {
    validateAppPath(path);
    const replacement = { path, ...normalizeFileContent(path, content) };
    const rec = await registry.get(id);
    if (!rec) throw new Error(`app not found: ${id}`);
    if (path === rec.entryFile && replacement.kind === 'binary') {
      throw new AppFileContentError(`entryFile must be text: ${path}`);
    }
    const rollbackBytes = await writeReplacements(guardedOpfsForApp(id), [replacement]);
    try {
      const updated = await registry.update(id, {
        fileKinds: { ...(rec.fileKinds ?? {}), [path]: replacement.kind },
      });
      if (!updated) throw new Error(`app not found after write: ${id}`);
    } catch (error) {
      return rollbackMutation(error, rollbackBytes, id, rec);
    }
    return { bytesWritten: replacement.size, kind: replacement.kind };
  };

  /** Write a single file in the app's OPFS subdir.
   * @param {{ appId?: string, path: string, content: unknown, sessionId?: string, reload?: boolean }} args */
  const writeFile = async ({ appId, path, content, sessionId, reload = true }) => {
    const id = await resolveId({ sessionId, appId });
    const result = await withMutation(id, () => writeFileUnlocked(id, path, content));
    if (path === 'peerd.json') await onManifestMutation(id);
    if (reload) tracker.reloadTab(id).catch(() => {});
    return result;
  };

  /**
   * Compare and write under the App/repository transaction lane.
   * @param {{appId?:string,path:string,content:string,sessionId?:string,
   *   expectedExists:boolean,expectedContent:string,signal?:AbortSignal,reload?:boolean}} args
   */
  const compareAndWriteFile = async ({
    appId, path, content, sessionId, expectedExists, expectedContent, signal, reload = true,
  }) => {
    const id = await resolveId({ sessionId, appId });
    const result = await withMutation(id, async () => {
      validateAppPath(path);
      let exists = true;
      let source = '';
      try {
        const rec = await registry.get(id);
        if (!rec) throw new Error(`app not found: ${id}`);
        const bytes = await guardedOpfsForApp(id).readBytes(path);
        if (isBinaryAppFile(path, bytes, rec.fileKinds?.[path])) {
          throw new AppBinaryFileError(path);
        }
        source = new TextDecoder().decode(bytes);
      } catch (cause) {
        if (/** @type {{name?:string}} */ (cause)?.name !== 'NotFoundError') throw cause;
        exists = false;
      }
      if (exists !== expectedExists || source !== expectedContent) return {
        ok: false, code: 'edit_conflict', retryable: false,
        error: 'The file changed after it was read; review the latest contents before writing.',
        outcomeKind: 'pre-effect-failure',
      };
      if (signal?.aborted) return {
        ok: false, code: 'edit_aborted', retryable: false,
        error: 'The edit was stopped before writing.', outcomeKind: 'pre-effect-failure',
      };
      return { ok: true, value: await writeFileUnlocked(id, path, content) };
    });
    if (result.ok) {
      if (path === 'peerd.json') await onManifestMutation(id);
      if (reload) tracker.reloadTab(id).catch(() => {});
    }
    return result;
  };

  /** @param {{ appId?: string, path: string, sessionId?: string }} args */
  const readFile = async ({ appId, path, sessionId }) => {
    validateAppPath(path);
    const id = await resolveId({ sessionId, appId });
    const rec = await registry.get(id);
    if (!rec) throw new Error(`app not found: ${id}`);
    const bytes = await guardedOpfsForApp(id).readBytes(path);
    if (isBinaryAppFile(path, bytes, rec.fileKinds?.[path])) throw new AppBinaryFileError(path);
    return new TextDecoder().decode(bytes);
  };

  /** @param {{ appId?: string, path: string, sessionId?: string }} args */
  const readFileBytes = async ({ appId, path, sessionId }) => {
    validateAppPath(path);
    const id = await resolveId({ sessionId, appId });
    return guardedOpfsForApp(id).readBytes(path);
  };

  /**
   * Replace an entire App tree while retaining a bounded byte snapshot for rollback.
   * @param {{ appId: string, files: Record<string, unknown>, entryFile: string,
   *   fileKinds?: Record<string, unknown>,
   *   metadata?: { dweb?: import('/peerd-engine/app-registry.js').AppDwebMeta } }} args
   */
  const replaceFiles = async ({ appId, files, entryFile, fileKinds, metadata = {} }) => {
    const id = await resolveId({ appId });
    const normalized = normalizeFileMap(files, entryFile, fileKinds);
    const updated = await withMutation(id, async () => {
      const opfs = guardedOpfsForApp(id);
      const oldRecord = await registry.get(id);
      if (!oldRecord) throw new Error(`app not found: ${id}`);
      /** @type {Record<string, Uint8Array<ArrayBuffer>>} */
      const oldFiles = Object.create(null);
      const oldList = await opfs.list();
      if (oldList.length > MAX_APP_FILES) {
        throw new AppFileLimitError('existing App has too many files to update safely');
      }
      let oldTotalBytes = 0;
      for (const file of oldList) {
        oldTotalBytes += file.size;
        if (oldTotalBytes > MAX_APP_TOTAL_BYTES) {
          throw new AppFileLimitError('existing App is too large to update safely');
        }
        const path = file.path.replace(/^\/+/, '');
        oldFiles[path] = await opfs.readBytes(path);
      }
      let treeChanged = false;
      try {
        await opfs.nuke();
        treeChanged = true;
        for (const { path, stored } of normalized.files) await opfs.write(path, stored);
        const updatedRecord = await registry.update(id, {
          entryFile,
          fileKinds: normalized.fileKinds,
          ...(metadata.dweb && typeof metadata.dweb === 'object' ? { dweb: metadata.dweb } : {}),
        });
        if (!updatedRecord) throw new Error(`app not found after file replacement: ${id}`);
        return updatedRecord;
      } catch (writeError) {
        if (!treeChanged) throw writeError;
        try {
          await opfs.nuke();
          for (const [path, bytes] of Object.entries(oldFiles)) await opfs.write(path, bytes);
          await restoreRecord(id, oldRecord);
        } catch (rollbackError) {
          throw appRollbackIncomplete(
            [writeError, rollbackError], 'App replacement and rollback both failed',
          );
        }
        throw appRollbackCompleted(writeError, 'App replacement failed; rollback completed');
      }
    });
    await onManifestMutation(id);
    tracker.reloadTab(id).catch(() => {});
    return updated;
  };

  /**
   * Replace a complete App release and record its Git/catalog lineage while the
   * caller already holds `withWriteLock(appId, ...)`. This deliberately has no
   * public locking of its own: dweb update needs divergence checks, an optional
   * fork, byte replacement, commit, and metadata persistence in one outer lane.
   *
   * @param {{ appId: string, files: Record<string, unknown>, entryFile: string,
   *   fileKinds?: Record<string, unknown>, message?: string,
   *   metadataForOid?: (oid: string | null, oldRecord: import('/peerd-engine/app-registry.js').AppRecord) => Partial<import('/peerd-engine/app-registry.js').AppRecord>,
   *   isCurrent?: () => boolean,
   *   afterCommit?: (record: import('/peerd-engine/app-registry.js').AppRecord) => Promise<void>|void }} args
   */
  const replaceVersionedFilesUnlocked = async ({
    appId, files, entryFile, fileKinds, message = 'replace App release', metadataForOid = () => ({}),
    isCurrent = () => true, afterCommit = () => {},
  }) => {
    if (!repositories?.replaceWorkingTree) throw new Error('browser Git is unavailable');
    await beforeOpfsMutation();
    const id = await resolveId({ appId });
    const normalized = normalizeFileMap(files, entryFile, fileKinds);
    const opfs = guardedOpfsForApp(id);
    const oldRecord = await registry.get(id);
    if (!oldRecord) throw new Error(`app not found: ${id}`);

    /** @type {Record<string, Uint8Array<ArrayBuffer>>} */
    const oldFiles = Object.create(null);
    const oldList = await opfs.list();
    if (oldList.length > MAX_APP_FILES) {
      throw new AppFileLimitError('existing App has too many files to update safely');
    }
    let oldTotalBytes = 0;
    for (const file of oldList) {
      oldTotalBytes += file.size;
      if (oldTotalBytes > MAX_APP_TOTAL_BYTES) {
        throw new AppFileLimitError('existing App is too large to update safely');
      }
      const path = file.path.replace(/^\/+/, '');
      oldFiles[path] = await opfs.readBytes(path);
    }
    /** @type {Record<string, string | Uint8Array<ArrayBuffer>>} */
    const nextFiles = Object.create(null);
    for (const file of normalized.files) nextFiles[file.path] = file.stored;

    try {
      if (!isCurrent()) throw new Error('dweb-custody-changed');
      const committed = await repositories.replaceWorkingTree(
        { kind: 'app', id },
        { files: nextFiles, message },
      );
      if (!isCurrent()) throw new Error('dweb-custody-changed');
      const patch = {
        entryFile,
        fileKinds: normalized.fileKinds,
        ...metadataForOid(committed.oid ?? null, oldRecord),
      };
      const updated = await registry.update(id, /** @type {any} */ (patch));
      if (!updated) throw new Error(`app not found after versioned replacement: ${id}`);
      if (!isCurrent()) throw new Error('dweb-custody-changed');
      await onManifestMutation(id);
      await afterCommit(updated);
      if (!isCurrent()) throw new Error('dweb-custody-changed');
      tracker.reloadTab(id).catch(() => {});
      return { record: updated, oid: committed.oid ?? null, created: committed.created === true };
    } catch (cause) {
      /** @type {unknown[]} */
      const rollbackFailures = [];
      // replaceWorkingTree can fail after changing bytes, so every failed
      // attempt must restore the exact snapshot captured above.
      try {
        await repositories.replaceWorkingTree(
          { kind: 'app', id },
          { files: oldFiles, message: 'rollback failed App release update' },
        );
      } catch (error) { rollbackFailures.push(error); }
      try { await restoreRecord(id, oldRecord); }
      catch (error) { rollbackFailures.push(error); }
      if (rollbackFailures.length) {
        throw new AggregateError([cause, ...rollbackFailures], 'App release update and rollback both failed');
      }
      throw cause;
    }
  };

  /** @param {{ appId?: string, sessionId?: string }} args */
  const listFiles = async ({ appId, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    return guardedOpfsForApp(id).list();
  };

  /**
   * Capture bytes and their catalog kind under the same per-App lane as every
   * mutation. Export and sharing therefore see one complete version.
   * @param {{ appId: string }} args
   */
  const snapshotFiles = async ({ appId }) => {
    const id = await resolveId({ appId });
    return withMutation(id, async () => {
      const record = await registry.get(id);
      if (!record) throw new Error(`app not found: ${id}`);
      const opfs = guardedOpfsForApp(id);
      const listed = await opfs.list();
      if (listed.length > MAX_APP_FILES) {
        throw new AppFileLimitError(`App has too many files: ${listed.length} > ${MAX_APP_FILES}`);
      }
      /** @type {Record<string, Uint8Array<ArrayBuffer>>} */
      const files = Object.create(null);
      let totalBytes = 0;
      for (const file of listed) {
        const path = validateAppPath(file.path.replace(/^\/+/, ''));
        totalBytes += file.size;
        if (totalBytes > MAX_APP_TOTAL_BYTES) {
          throw new AppFileLimitError(`App is too large: ${totalBytes} > ${MAX_APP_TOTAL_BYTES} bytes`);
        }
        files[path] = await opfs.readBytes(path);
      }
      if (!Object.hasOwn(files, record.entryFile)) {
        throw new AppFileContentError(`entryFile not in files: ${record.entryFile}`);
      }
      return { record: { ...record, fileKinds: { ...(record.fileKinds ?? {}) } }, files, totalBytes };
    });
  };

  /** @param {{ appId: string }} args */
  const snapshotFilesBase64 = async (args) => {
    const snapshot = await snapshotFiles(args);
    /** @type {Record<string, { base64: string }>} */
    const files = Object.create(null);
    for (const [path, bytes] of Object.entries(snapshot.files)) {
      files[path] = { base64: toBase64(bytes) };
    }
    return { ...snapshot, files };
  };

  /** @param {{ appId?: string, path: string, sessionId?: string, reload?: boolean }} args */
  const deleteFile = async ({ appId, path, sessionId, reload = true }) => {
    validateAppPath(path);
    const id = await resolveId({ sessionId, appId });
    await withMutation(id, async () => {
      const rec = await registry.get(id);
      if (!rec) throw new Error(`app not found: ${id}`);
      if (path === rec.entryFile) throw new Error(`refusing to delete entry file: ${path}`);
      const opfs = guardedOpfsForApp(id);
      const backup = await opfs.readBytes(path);
      await opfs.delete(path);
      const nextKinds = { ...(rec.fileKinds ?? {}) };
      delete nextKinds[path];
      try {
        const updated = await registry.update(id, { fileKinds: nextKinds });
        if (!updated) throw new Error(`app not found after delete: ${id}`);
      } catch (error) {
        return rollbackMutation(error, () => opfs.write(path, backup), id, rec);
      }
    });
    if (path === 'peerd.json') await onManifestMutation(id);
    if (reload) tracker.reloadTab(id).catch(() => {});
  };

  /** @param {{ appId?: string, sessionId?: string, focus?: boolean }} [opts] */
  const open = async ({ appId, sessionId, focus = true } = {}) => {
    const id = await resolveId({ sessionId, appId });
    const record = await registry.get(id);
    if (!record) throw new Error(`app not found: ${id}`);
    // The App tab asks the SW to attach a manifest-defined actor during boot.
    // Carry a durable, explicit owner into that handshake; actor minting must
    // never consult whichever chat happens to be active at tab-ready time.
    const ownerClaim = sessionId ?? record.ownerSessionId ?? null;
    const ownerSessionId = ownerClaim ? await resolveOwnerRoot(ownerClaim, record) : null;
    const ownerSuffix = ownerSessionId
      ? `?owner=${encodeURIComponent(ownerSessionId)}`
      : '';
    // why focus: a USER opening an App (Library → Open) brings its tab to the
    // foreground so they see it (DECISIONS #20). The AGENT opening one
    // (focus:false) opens in the BACKGROUND — the tracker drops a "go there" card
    // in the chat instead of stealing focus (DESIGN-12). ensureTab early-returns
    // for a live tab, so re-opening an existing App tab doesn't yank the user back.
    // Isolation failures and readiness timeouts both propagate. why: claiming
    // a background App opened when its host is not runnable leaves the model
    // and user with a dead card and hides a security-floor failure.
    await tracker.ensureTab(id, {
      active: focus,
      groupTitle: APP_TAB_GROUP_TITLE,
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(ownerSuffix ? { hashSuffix: ownerSuffix } : {}),
    });
    if (sessionId) await registry.setDefaultForSession(sessionId, id);
    return id;
  };

  /** @param {string} appId */
  const deleteApp = async (appId) => {
    const rec = await registry.get(appId);
    if (!rec) return false;
    // Preflight before closing the live tab. The OPFS helper repeats this at
    // the physical mutation boundary, but an early refusal avoids visible UX
    // damage and prevents a caught nuke refusal from falling through to the
    // metadata delete.
    await beforeOpfsMutation();
    await tracker.closeTab(appId);
    await withMutation(appId, async () => {
      await new Promise((r) => setTimeout(r, 100));
      // Every App now owns a separate peerd-git/app/<id> DAG and remote
      // configuration. Deletion is one fail-closed transaction: preserve the
      // catalog/worktree recovery handle unless Git cleanup succeeds, and never
      // claim deletion while either durable byte root remains.
      await repositories?.destroyApp?.(appId);
      await guardedOpfsForApp(appId).nuke();
      await registry.delete(appId);
    });
    return true;
  };

  /** @param {{ appId?: string, sessionId?: string, to: string }} args */
  const restoreVersion = async ({ appId, sessionId, to }) => {
    if (!repositories?.restoreApp) throw new Error('browser Git is unavailable');
    const id = await resolveId({ appId, sessionId });
    const result = await withMutation(id, () => repositories.restoreApp(id, { to }));
    await onManifestMutation(id);
    tracker.reloadTab(id).catch(() => {});
    return result;
  };

  /** @param {{ appId?: string, sessionId?: string, name: string }} args */
  const checkoutBranch = async ({ appId, sessionId, name }) => {
    if (!repositories?.checkout) throw new Error('browser Git is unavailable');
    const id = await resolveId({ appId, sessionId });
    const result = await withMutation(id, () => repositories.checkout({ kind: 'app', id }, { name }));
    await onManifestMutation(id);
    tracker.reloadTab(id).catch(() => {});
    return result;
  };

  /**
   * Substring search. Metadata first (name + tags), then a linear
   * scan of every file in every app for body matches. Slower than the
   * old single-body search; fine at v1 scale.
   * @param {string} [query]
   */
  const search = async (query) => {
    const q = (query ?? '').trim();
    if (!q) return [];
    const ql = q.toLowerCase();
    const metaHits = await registry.searchMetadata(q);
    /** @type {Map<string, { app: import('/peerd-engine/app-registry.js').AppRecord, snippet: string | null, rank: number }>} */
    const byId = new Map();
    for (const m of metaHits) byId.set(m.id, { app: m, snippet: null, rank: 2 });

    // Body scan
    const allApps = await registry.list();
    for (const app of allApps) {
      try {
        const opfs = guardedOpfsForApp(app.id);
        const files = await opfs.list();
        for (const f of files) {
          const path = f.path.replace(/^\/+/, '');
          let bytes;
          try { bytes = await opfs.readBytes(path); } catch { continue; }
          if (isBinaryAppFile(path, bytes, app.fileKinds?.[path])) continue;
          const content = new TextDecoder().decode(bytes);
          const idx = content.toLowerCase().indexOf(ql);
          if (idx < 0) continue;
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + q.length + 60);
          const snippet = (start > 0 ? '…' : '')
            + content.slice(start, end).replace(/\s+/g, ' ').trim()
            + (end < content.length ? '…' : '');
          const cur = byId.get(app.id);
          if (cur) { cur.snippet = `${path}: ${snippet}`; cur.rank += 1; }
          else { byId.set(app.id, { app, snippet: `${path}: ${snippet}`, rank: 1 }); }
          break;          // one snippet per app is enough
        }
      } catch { /* skip apps with broken OPFS */ }
    }

    return Array.from(byId.values()).sort((a, b) => b.rank - a.rank);
  };

  return {
    resolveId,
    create, createFromGit, update,
    writeFile, compareAndWriteFile, readFile, readFileBytes, replaceFiles, listFiles, deleteFile,
    replaceVersionedFilesUnlocked,
    snapshotFiles, snapshotFilesBase64,
    open,
    delete: deleteApp,
    restoreVersion,
    checkoutBranch,
    search,
    opfsForApp: guardedOpfsForApp,
    withWriteLock,
    repositories,
  };
};
