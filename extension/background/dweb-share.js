// @ts-check
// One identity-bound app-share transaction. Both user and agent entry points
// call this shell so publisher-derived metadata and custody serialization cannot
// drift apart again.

import { toBase64 } from '../shared/bundle/bytes.js';
import { sha256Hex } from '../shared/util.js';

/**
 * @typedef {Readonly<{ok:true,appId:string,name:string,entryFile:string,
 * fileKinds:Record<string,unknown>,files:Record<string,{base64:string}>,digest:string,
 * fileCount:number,totalBytes:number}>|Readonly<{ok:false,error:string}>} PublishDescriptor
 */

/**
 * @param {Object} deps
 * @param {boolean} deps.enabled
 * @param {() => boolean} deps.active
 * @param {<T>(operation: (isCurrent: () => boolean) => Promise<T>) => Promise<T>} deps.withDwebPublication
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} deps.withIdentityMutation
 * @param {<T>(appId: string, operation: () => Promise<T>) => Promise<T>} deps.withAppLifecycle
 * @param {<T>(appId: string, operation: () => Promise<T>) => Promise<T>} [deps.withAppWriteLock]
 * @param {{ get: (id: string) => Promise<any>, update: (id: string, patch: any) => Promise<any> }} deps.appRegistry
 * @param {{ statusApp: (id: string) => Promise<any>, commitApp: (id: string, opts: {message: string}) => Promise<any>, historyApp: (id: string, opts: {depth: number}) => Promise<any[]>, snapshot: (ref: {kind: string, id: string}, opts: {at: string}) => Promise<Record<string, Uint8Array>>, workingSnapshot?: (ref:{kind:string,id:string})=>Promise<Record<string,Uint8Array>> }} [deps.repositories]
 * @param {() => Promise<any>} deps.prepareRuntime
 * @param {(message: any) => Promise<any>} deps.sendMessage
 */
export const makeDwebShare = ({
  enabled, active, withDwebPublication, withIdentityMutation, withAppLifecycle, appRegistry,
  withAppWriteLock = (_appId, operation) => operation(), repositories,
  prepareRuntime, sendMessage,
}) => {
  /** @returns {Promise<PublishDescriptor>} */
  const descriptorFor = async (/** @type {string} */ appId, /** @type {any} */ record,
    /** @type {Record<string,Uint8Array>|null} */ snapshot) => {
    if (!record) return { ok: false, error: 'app-not-found' };
    /** @type {Record<string,{base64:string}>} */
    const files = Object.create(null);
    let totalBytes = 0;
    for (const [path, bytes] of Object.entries(snapshot ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      totalBytes += bytes.byteLength;
      files[path] = { base64: toBase64(bytes) };
    }
    if (snapshot && !Object.hasOwn(snapshot, record.entryFile)) {
      return { ok: false, error: 'release-entry-missing' };
    }
    const identity = {
      appId, name: String(record.name ?? ''), entryFile: String(record.entryFile ?? ''),
      fileKinds: { ...(record.fileKinds ?? {}) }, files,
    };
    const digest = await sha256Hex(JSON.stringify(identity));
    return Object.freeze({
      ok: true, ...identity, digest, fileCount: Object.keys(files).length, totalBytes,
    });
  };

  const snapshotDescriptorUnlocked = async (/** @type {string} */ appId) => {
    const record = await appRegistry.get(appId);
    const snapshot = repositories?.workingSnapshot
      ? await repositories.workingSnapshot({ kind: 'app', id: appId }) : null;
    return descriptorFor(appId, record, snapshot);
  };

  const prepare = (/** @type {string} */ appId) => withAppLifecycle(
    appId,
    () => withAppWriteLock(appId, () => snapshotDescriptorUnlocked(appId)),
  );

  const share = async (
    /** @type {string} */ appId,
    /** @type {string | undefined} */ slug,
    /** @type {any} */ preparedInput = null,
  ) => {
  if (!enabled || !active()) return { ok: false, error: 'dweb-disabled' };
  const prepared = preparedInput ?? await prepare(appId);
  if (prepared?.ok !== true || prepared.appId !== appId
      || typeof prepared.digest !== 'string') {
    return { ok: false, error: prepared?.error ?? 'share-preparation-invalid' };
  }

  return withDwebPublication(async (isCurrent) => {
    if (!isCurrent() || !active()) return { ok: false, error: 'dweb-disabled' };
    // why: a cold host mints its first identity through the custody lane. Start
    // it before owning that lane or first-share waits on its own queued mint.
    const started = await prepareRuntime();
    if (!started?.ok) return started ?? { ok: false, error: 'dweb-start-failed' };
    let commitDispatched = false;
    let durableCommitPerformed = false;
    try {
      const result = await withIdentityMutation(() => withAppLifecycle(
        appId, () => withAppWriteLock(appId, async () => {
    if (!enabled || !isCurrent() || !active()) return { ok: false, error: 'dweb-disabled' };
    const record = await appRegistry.get(appId);
    if (!record) return { ok: false, error: 'app-not-found' };
    const current = await snapshotDescriptorUnlocked(appId);
    if (current.ok !== true || current.digest !== prepared.digest) return {
      ok: false, error: 'share-prepared-snapshot-changed',
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    };
    let release = null;
    let releaseSnapshot = null;
    if (repositories) {
      const beforeRelease = await repositories.statusApp(appId);
      const changes = Array.isArray(beforeRelease.changed) ? beforeRelease.changed : [];
      const changedPaths = changes.slice(0, 3)
        .map((/** @type {{path?: unknown}} */ change) => change?.path)
        .filter((/** @type {unknown} */ path) => typeof path === 'string');
      commitDispatched = true;
      const committed = await repositories.commitApp(appId, {
        message: changedPaths.length
          ? `release: update ${changedPaths.join(', ')}${changes.length > changedPaths.length ? ', …' : ''}`
          : 'publish dweb release',
      });
      if (typeof committed?.oid !== 'string' || !/^[a-f0-9]{40}$/.test(committed.oid)) {
        throw new Error('release Git commit identity invalid');
      }
      durableCommitPerformed = true;
      const history = await repositories.historyApp(appId, { depth: 100 });
      const messages = [];
      for (const item of history) {
        if (record.dweb?.git_oid && item.oid === record.dweb.git_oid) break;
        if (typeof item.message === 'string' && item.message) messages.push(item.message.split('\n')[0]);
        if (messages.length >= 20) break;
      }
      const changelog = messages.reverse().join('\n').slice(0, 1200);
      const snapshot = await repositories.snapshot({ kind: 'app', id: appId }, { at: committed.oid });
      const committedDescriptor = await descriptorFor(appId, record, snapshot);
      if (committedDescriptor.ok !== true) {
        return {
          ok: false, error: committedDescriptor.error,
          performed: true, outcomeKnown: true,
          outcomeKind: 'effect-completed', retryable: false,
        };
      }
      if (repositories.workingSnapshot && committedDescriptor.digest !== prepared.digest) {
        return {
          ok: false, error: 'share-prepared-snapshot-changed',
          performed: true, outcomeKnown: true,
          outcomeKind: 'effect-completed', retryable: false,
        };
      }
      release = {
        previousVersionId: record.dweb?.version_id ?? null,
        gitCommitOid: committed.oid,
        changelog,
      };
      releaseSnapshot = {
        ok: true,
        oid: committed.oid,
        totalBytes: committedDescriptor.totalBytes,
        record: {
          name: record.name,
          entryFile: record.entryFile,
          fileKinds: { ...(record.fileKinds ?? {}) },
        },
        files: committedDescriptor.files,
      };
    }
    const useSlug = record.dweb?.slug || slug || undefined;
    const previousHash = record.dweb?.hash ?? null;
    const previousShareHash = record.dweb?.local === true ? previousHash : null;
    const previousSeedHash = record.dweb && record.dweb.local !== true ? previousHash : null;
    const reply = await sendMessage({
      type: 'dweb/base-host/share-app',
      appId,
      name: record.name,
      entry: record.entryFile,
      fileKinds: record.fileKinds ?? {},
      slug: useSlug,
      previousHash: previousShareHash,
      ...(release ? { release, releaseSnapshot } : {}),
    });
    if (!reply?.ok) return reply;
    const rollbackShare = async () => {
      let rollback = null;
      for (let attempt = 0; attempt < 2 && !rollback?.ok; attempt += 1) {
        rollback = await sendMessage({
          type: 'dweb/base-host/rollback-share',
          transactionId: reply.transactionId,
          failedSeq: reply.seq,
        }).catch(() => null);
      }
      return rollback;
    };
    const persistUncertainHash = async () => {
      if (typeof reply.hash !== 'string') return false;
      const recoveryHashes = [...new Set([
        ...(Array.isArray(record.dweb?.pending_unserve_hashes)
          ? record.dweb.pending_unserve_hashes
          : []),
        reply.hash,
      ])];
      // Preserve a durable delete/re-share recovery handle when the public
      // rollback is uncertain. A later delete sends every pending hash.
      return Boolean(await appRegistry.update(appId, {
        shared: true,
        dweb: { ...(record.dweb ?? {}), pending_unserve_hashes: recoveryHashes },
      }).catch(() => null));
    };
    if (!isCurrent() || !active()) {
      const rollback = await rollbackShare();
      if (!rollback?.ok) await persistUncertainHash();
      return rollback?.ok
        ? { ok: false, error: 'dweb-disabled' }
        : { ok: false, error: 'share-rollback-failed' };
    }
    const pendingHashes = [...new Set([
      ...(Array.isArray(record.dweb?.pending_unserve_hashes)
        ? record.dweb.pending_unserve_hashes
        : []),
      ...(previousShareHash && previousShareHash !== reply.hash ? [previousShareHash] : []),
    ].filter((hash) => typeof hash === 'string' && hash !== reply.hash))];
    const pendingSeedHashes = [...new Set([
      ...(Array.isArray(record.dweb?.pending_seed_unserve_hashes)
        ? record.dweb.pending_seed_unserve_hashes
        : []),
      ...(previousSeedHash ? [previousSeedHash] : []),
    ].filter((hash) => typeof hash === 'string'))];
    const committedDweb = {
      ...(record.dweb ?? {}),
      uri: reply.uri, publisher: reply.publisher ?? null, hash: reply.hash,
      ...(Number.isInteger(reply.size) ? { size: reply.size } : {}),
      version_id: reply.hash, slug: reply.slug, dwapp_id: reply.dwapp_id,
      seq: reply.seq, manifest_created: reply.created, local: true,
      ...(release ? {
        git_oid: release.gitCommitOid,
        source_git_oid: release.gitCommitOid,
        previous_version_id: release.previousVersionId ?? undefined,
        changelog: release.changelog,
        release_entry_file: record.entryFile,
        release_file_kinds: { ...(record.fileKinds ?? {}) },
        ...(Number.isInteger(reply.created) ? { release_created: reply.created } : {}),
        published_hashes: [...new Set([
          ...(Array.isArray(record.dweb?.published_hashes) ? record.dweb.published_hashes : []),
          reply.hash,
        ].filter((hash) => typeof hash === 'string'))],
      } : {}),
      ...(pendingHashes.length ? { pending_unserve_hashes: pendingHashes } : {}),
      ...(pendingSeedHashes.length ? { pending_seed_unserve_hashes: pendingSeedHashes } : {}),
    };
    try {
      const updated = await appRegistry.update(appId, {
        shared: true,
        dweb: committedDweb,
      });
      if (!updated) throw new Error('app was deleted before share metadata was stored');
    } catch (cause) {
      // Retry with the same host transaction. Its state remains pending until
      // metadata restoration and byte revocation both finish.
      const rollback = await rollbackShare();
      const rollbackComplete = rollback?.ok && (!previousShareHash || rollback.restored === true);
      if (!rollbackComplete) await persistUncertainHash();
      return {
        ok: false,
        error: rollbackComplete ? 'share-metadata-store-failed' : 'share-rollback-failed',
        cause: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause),
      };
    }
    if (typeof reply.transactionId === 'string') {
      let committed = null;
      for (let attempt = 0; attempt < 2 && !committed?.ok; attempt += 1) {
        committed = await sendMessage({
          type: 'dweb/base-host/commit-share', transactionId: reply.transactionId,
        }).catch(() => null);
      }
    }
    /** @param {string[]} hashes @param {'share' | 'seed'} slot */
    const cleanSlot = async (hashes, slot) => {
      const remaining = [];
      for (const hash of hashes) {
        const cleaned = await sendMessage({
          type: 'dweb/base-host/unserve-content', appId, hash, slot,
        }).catch(() => null);
        if (!cleaned?.ok) remaining.push(hash);
      }
      return remaining;
    };
    const remaining = await cleanSlot(pendingHashes, 'share');
    const remainingSeed = await cleanSlot(pendingSeedHashes, 'seed');
    if ((pendingHashes.length && remaining.length !== pendingHashes.length)
        || (pendingSeedHashes.length && remainingSeed.length !== pendingSeedHashes.length)) {
      const clearedDweb = { ...committedDweb };
      if (remaining.length) clearedDweb.pending_unserve_hashes = remaining;
      else delete clearedDweb.pending_unserve_hashes;
      if (remainingSeed.length) clearedDweb.pending_seed_unserve_hashes = remainingSeed;
      else delete clearedDweb.pending_seed_unserve_hashes;
      try {
        const updated = await appRegistry.update(appId, { dwebExact: clearedDweb });
        if (!updated) throw new Error('app-not-found');
      } catch {
        remaining.splice(0, remaining.length, ...pendingHashes);
        remainingSeed.splice(0, remainingSeed.length, ...pendingSeedHashes);
      }
    }
    return remaining.length || remainingSeed.length
      ? { ...reply, warning: 'previous-version-cleanup-pending', cleanupPending: true }
      : reply;
        })),
      );
      if (durableCommitPerformed && result?.ok === false) {
        const unknown = result.outcomeKnown === false
          || result.error === 'share-rollback-failed';
        return {
          ...result, performed: true, outcomeKnown: !unknown,
          outcomeKind: unknown ? 'host-lost' : 'effect-completed', retryable: false,
        };
      }
      return result;
    } catch (cause) {
      if (!commitDispatched) throw cause;
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      throw Object.assign(failure, {
        ...(durableCommitPerformed ? { performed: true } : {}),
        outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
      });
    }
  });
  };
  return Object.assign(share, { prepare });
};
