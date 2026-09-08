// @ts-check

import { createKeyedQueue } from '../command-queue.js';
import { REPOSITORY_MAX_GIT_HTTP_BODY_BYTES } from '/shared/repository-channel.js';
import { createOpfsGitFs } from './opfs-fs.js';
import { repositoryPaths, appRepositoryRef } from './paths.js';
import { createGitHttpClient, normalizeGitRemote } from './remote.js';
import { diffRepositorySnapshots } from './diff.js';

const AUTHOR = Object.freeze({ name: 'peerd', email: 'agent@local' });
const DEFAULT_BRANCH = 'main';
const MAX_LIGHTWEIGHT_FILES = 2_000;
const MAX_LIGHTWEIGHT_BYTES = 128_000_000;

/** @typedef {{ git:any, fs:any, dir:string, gitdir:string }} RepositoryContext */
/** @typedef {[string, number, number, number]} StatusRow */

// Extension pages may load the heavy vendor on first repository use. Chrome's
// MV3 service worker injects a static loader instead because its global rejects
// runtime import(); keeping that host choice out of this core also keeps engine
// consumers that only need a small helper from loading Git.
const loadVendoredGit = async () => (await import('/vendor/isomorphic-git/index.js')).default;

/** @param {unknown} message @param {string} [fallback] */
const commitMessage = (message, fallback = 'checkpoint') => {
  const subject = String(message || fallback).replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (subject || fallback).slice(0, 160);
};

/** @param {string} name */
const validBranch = (name) => {
  const branch = String(name || '');
  if (!/^[a-z0-9][a-z0-9._/-]{0,100}$/i.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.includes('@{')
      || branch.toUpperCase() === 'HEAD' || branch.startsWith('refs/')
      || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw new Error('invalid branch name');
  }
  return branch;
};

/** @param {any} fs @param {string} dir @param {{maxBytes?:number,maxFiles?:number}} [limits] */
const readWorkingTree = async (fs, dir, { maxBytes = Infinity, maxFiles = Infinity } = {}) => {
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  let total = 0;
  /** @param {string} current @param {string} prefix */
  const walk = async (current, prefix) => {
    for (const name of await fs.promises.readdir(current)) {
      const path = `${current}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.promises.stat(path);
      if (stat.isDirectory()) await walk(path, rel);
      else {
        const bytes = new Uint8Array(await fs.promises.readFile(path));
        total += bytes.byteLength;
        if (Object.keys(files).length + 1 > maxFiles || total > maxBytes) {
          throw new Error('repository snapshot exceeds the operation budget');
        }
        files[rel] = bytes;
      }
    }
  };
  try { await walk(dir, ''); } catch (error) {
    if ((/** @type {{ code?: string }} */ (error)).code !== 'ENOENT') throw error;
  }
  return files;
};

/** @param {any} fs @param {string} path */
const mkdirParents = async (fs, path) => {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try { await fs.promises.mkdir(current); }
    catch (error) {
      if ((/** @type {{ code?: string }} */ (error)).code !== 'EEXIST') throw error;
    }
  }
};

/** @param {string} path */
const validRelativePath = (path) => {
  const value = String(path || '');
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  return value;
};

/** @param {RepositoryContext} ctx @param {Record<string,Uint8Array>} files */
const writeWorkingTreeUnlocked = async (ctx, files) => {
  await ctx.fs.promises.rm(ctx.dir, { recursive: true, force: true });
  await mkdirParents(ctx.fs, ctx.dir);
  for (const [path, bytes] of Object.entries(files)) {
    const slash = path.lastIndexOf('/');
    if (slash >= 0) await mkdirParents(ctx.fs, `${ctx.dir}/${path.slice(0, slash)}`);
    await ctx.fs.promises.writeFile(`${ctx.dir}/${path}`, bytes);
  }
};

/**
 * OPFS has no portable atomic directory rename. Validate first and retain the
 * bounded previous tree until every replacement byte lands so a bad peer path
 * or quota failure cannot strand an empty/partial App.
 * @param {RepositoryContext} ctx @param {Record<string,Uint8Array>} files
 */
const replaceWorkingTreeUnlocked = async (ctx, files) => {
  for (const path of Object.keys(files)) validRelativePath(path);
  const previous = await readWorkingTree(ctx.fs, ctx.dir);
  try {
    await writeWorkingTreeUnlocked(ctx, files);
  } catch (error) {
    try { await writeWorkingTreeUnlocked(ctx, previous); }
    catch (rollbackError) {
      const failure = new Error('repository replacement and rollback both failed');
      failure.cause = { replacement: error, rollback: rollbackError };
      throw failure;
    }
    throw error;
  }
};

/** @param {any} git @param {any} fs @param {string} gitdir @param {string} treeOid @param {string} [prefix] @param {Record<string,Uint8Array>} [files] @param {{bytes:number,maxBytes:number,maxFiles:number}} [budget] */
const readTreeRecursive = async (git, fs, gitdir, treeOid, prefix = '', files = {}, budget = { bytes: 0, maxBytes: Infinity, maxFiles: Infinity }) => {
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  for (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'tree') await readTreeRecursive(git, fs, gitdir, entry.oid, path, files, budget);
    else {
      const bytes = new Uint8Array((await git.readBlob({ fs, gitdir, oid: entry.oid })).blob);
      budget.bytes += bytes.byteLength;
      if (Object.keys(files).length + 1 > budget.maxFiles || budget.bytes > budget.maxBytes) {
        throw new Error('repository snapshot exceeds the operation budget');
      }
      files[path] = bytes;
    }
  }
  return files;
};

/** Build a private recovery commit directly from bytes, without touching HEAD's index. */
/** @param {RepositoryContext} ctx @param {Record<string,Uint8Array>} files @param {string} parent */
const writePrivateSnapshotCommit = async (ctx, files, parent) => {
  /** @type {Map<string, any>} */
  const root = new Map();
  for (const [path, bytes] of Object.entries(files)) {
    const parts = validRelativePath(path).split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      const next = node.get(part);
      if (!(next instanceof Map)) throw new Error(`repository path collision: ${path}`);
      node = next;
    }
    const leaf = parts.at(-1);
    if (!leaf || node.has(leaf)) throw new Error(`repository path collision: ${path}`);
    node.set(leaf, bytes);
  }
  /** @param {Map<string,any>} node @returns {Promise<string>} */
  const writeTree = async (node) => {
    const tree = [];
    for (const [path, value] of [...node.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (value instanceof Map) {
        tree.push({ mode: '040000', path, oid: await writeTree(value), type: 'tree' });
      } else {
        tree.push({ mode: '100644', path, oid: await ctx.git.writeBlob({ fs: ctx.fs, gitdir: ctx.gitdir, blob: value }), type: 'blob' });
      }
    }
    return ctx.git.writeTree({ fs: ctx.fs, gitdir: ctx.gitdir, tree });
  };
  const timestamp = Math.floor(Date.now() / 1000);
  const person = { ...AUTHOR, timestamp, timezoneOffset: new Date().getTimezoneOffset() };
  return ctx.git.writeCommit({
    fs: ctx.fs, gitdir: ctx.gitdir,
    commit: { tree: await writeTree(root), parent: [parent], author: person, committer: person, message: 'checkpoint before restore\n' },
  });
};

/** Only bytes Git considers visible may cross the model/diff boundary. */
/** @param {RepositoryContext} ctx @param {{maxBytes?:number,maxFiles?:number}} limits */
const readVisibleWorkingTree = async (ctx, limits) => {
  const visible = new Set((await ctx.git.statusMatrix({
    fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ignored: false,
  })).map((/** @type {StatusRow} */ row) => row[0]));
  const all = await readWorkingTree(ctx.fs, ctx.dir, limits);
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  for (const [path, bytes] of Object.entries(all)) if (visible.has(path)) files[path] = bytes;
  return files;
};

/** Bound decompressed Git/object writes before OPFS can be exhausted. */
/** @param {RepositoryContext} ctx */
const quotaFsFor = (ctx) => {
  let written = 0;
  const paths = new Set();
  return {
    ...ctx.fs,
    promises: {
      ...ctx.fs.promises,
      writeFile: async (/** @type {string} */ path, /** @type {any} */ data) => {
        const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : Number(data?.byteLength ?? data?.length ?? 0);
        written += size;
        paths.add(path);
        if (written > MAX_LIGHTWEIGHT_BYTES * 2 || paths.size > MAX_LIGHTWEIGHT_FILES * 8) {
          throw new Error('repository transport exceeded its storage budget; use a WebVM');
        }
        return ctx.fs.promises.writeFile(path, data);
      },
    },
  };
};

/** @param {Record<string,Uint8Array>} left @param {Record<string,Uint8Array>} right */
const snapshotsEqual = (left, right) => {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  if (leftPaths.length !== rightPaths.length || leftPaths.some((path, index) => path !== rightPaths[index])) return false;
  return leftPaths.every((path) => {
    const a = left[path];
    const b = right[path];
    return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
  });
};

/**
 * @param {{ loadGit?: () => Promise<any>, fs?: any,
 *   webFetch?: (url:string, init?:RequestInit,
 *     context?:{gitRemote:{url:string,host:string}})=>Promise<Response>,
 *   getSecret?: (name:string)=>Promise<string|null>, audit?: (event:any)=>void }} [deps]
 */
export const createRepositoryService = ({
  loadGit = loadVendoredGit,
  fs = createOpfsGitFs(),
  webFetch,
  getSecret,
  audit,
} = {}) => {
  const queue = createKeyedQueue();
  const mutationQueue = createKeyedQueue();
  /** @type {Promise<any>|null} */ let gitPromise = null;
  const getGit = () => (gitPromise ??= loadGit());
  /** @param {{url:string,host:string}} remote @param {AbortSignal|undefined} signal */
  const gitHttp = (remote, signal) => {
    if (!webFetch) throw new Error('git remote transport unavailable');
    return createGitHttpClient({
      remote, webFetch, maxBodyBytes: REPOSITORY_MAX_GIT_HTTP_BODY_BYTES,
      getSecret, audit, signal,
    });
  };
  /** @param {{kind:string,id:string}} ref */
  const key = (ref) => `${ref.kind}:${ref.id}`;
  /** @param {{kind:string,id:string}} ref @param {(ctx:{git:any,fs:any,dir:string,gitdir:string})=>Promise<any>} operation */
  const run = (ref, operation) => queue.enqueue(key(ref), async () => {
    const git = await getGit();
    const { dir, gitdir } = repositoryPaths(ref);
    return operation({ git, fs, dir, gitdir });
  });
  /** Serialize repository mutations with engine-client/editor writes. */
  /** @param {{kind:string,id:string}} ref @param {() => Promise<any>} operation */
  const coordinate = (ref, operation) => mutationQueue.enqueue(key(ref), operation);

  const resolveHead = async (/** @type {RepositoryContext} */ { git, fs: repoFs, gitdir }) => {
    try { return await git.resolveRef({ fs: repoFs, gitdir, ref: 'HEAD' }); }
    catch { return null; }
  };

  const stageAll = async (/** @type {RepositoryContext} */ { git, fs: repoFs, dir, gitdir }, { includeIgnored = false } = {}) => {
    // Regular commits honor .gitignore. Destructive-operation safety snapshots
    // may include ignored bytes, but are kept on a private non-pushed ref.
    const matrix = await git.statusMatrix({ fs: repoFs, dir, gitdir, ignored: includeIgnored });
    for (const [filepath, _head, workdir] of matrix) {
      if (workdir === 0) await git.remove({ fs: repoFs, dir, gitdir, filepath });
      else await git.add({ fs: repoFs, dir, gitdir, filepath, ...(includeIgnored ? { force: true } : {}) });
    }
    return matrix;
  };

  /** @param {RepositoryContext} ctx @param {string} [initialMessage] */
  const ensureUnlocked = async (ctx, initialMessage = 'initial snapshot') => {
    const head = await resolveHead(ctx);
    if (head) return head;
    await ctx.git.init({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, defaultBranch: DEFAULT_BRANCH });
    const matrix = await stageAll(ctx);
    if (!matrix.length) return null;
    return ctx.git.commit({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, message: commitMessage(initialMessage), author: AUTHOR });
  };

  /** @param {{kind:string,id:string}} ref @param {{message?:string}} [opts] */
  const init = (ref, { message = 'initial snapshot' } = {}) => run(ref, (ctx) => ensureUnlocked(ctx, message));

  /** Stage selected paths, or the complete visible worktree for `.` / no paths. */
  /** @param {{kind:string,id:string}} ref @param {{paths?:string[]}} [opts] */
  const stage = (ref, { paths = [] } = {}) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const requested = paths.map(String).filter((path) => path && path !== '.').map(validRelativePath);
    if (!requested.length) {
      const matrix = await stageAll(ctx);
      return { staged: matrix.map((/** @type {StatusRow} */ row) => row[0]) };
    }
    const matrix = await ctx.git.statusMatrix({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ignored: false });
    const wanted = new Set(requested);
    const staged = [];
    for (const [filepath, _head, workdir] of matrix) {
      if (!wanted.has(filepath)) continue;
      if (workdir === 0) await ctx.git.remove({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath });
      else await ctx.git.add({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath });
      staged.push(filepath);
    }
    return { staged };
  });

  /** @param {{kind:string,id:string}} ref @param {{message?:string}} [opts] */
  const commit = (ref, { message = 'checkpoint' } = {}) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx, message);
    const matrix = await ctx.git.statusMatrix({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir });
    const changed = matrix
      .filter((/** @type {StatusRow} */ row) => row[1] !== row[2])
      .map((/** @type {StatusRow} */ row) => row[0]);
    if (!changed.length) return { oid: await resolveHead(ctx), changed: [], created: false };
    await stageAll(ctx);
    const oid = await ctx.git.commit({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, message: commitMessage(message), author: AUTHOR });
    return { oid, changed, created: true };
  });

  /** @param {{kind:string,id:string}} ref */
  const status = (ref) => run(ref, async (ctx) => {
    const head = await resolveHead(ctx);
    if (!head) {
      const files = await readWorkingTree(ctx.fs, ctx.dir);
      return {
        oid: null, branch: null, dirty: Object.keys(files).length > 0,
        changed: Object.keys(files).sort().map((path) => ({ path, status: 'added' })),
      };
    }
    const matrix = await ctx.git.statusMatrix({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir });
    const changed = matrix
      .filter((/** @type {StatusRow} */ row) => row[1] !== row[2])
      .map((/** @type {StatusRow} */ [path, headStatus, workdir]) => ({ path, status: headStatus === 0 ? 'added' : workdir === 0 ? 'deleted' : 'modified' }));
    const branch = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, fullname: false });
    return { oid: await resolveHead(ctx), branch: branch ?? null, dirty: changed.length > 0, changed };
  });

  /** @param {{kind:string,id:string}} ref */
  const branches = (ref) => run(ref, async (ctx) => {
    if (!await resolveHead(ctx)) return [];
    return (await ctx.git.listBranches({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir })).sort();
  });

  /** @param {{kind:string,id:string}} ref @param {{depth?:number,includeSafety?:boolean}} [opts] */
  const history = (ref, { depth = 50, includeSafety = false } = {}) => run(ref, async (ctx) => {
    const head = await resolveHead(ctx);
    if (!head) return [];
    const rows = await ctx.git.log({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, depth: Math.min(200, Math.max(1, depth)) });
    const main = rows.map((/** @type {{ oid:string, commit:any }} */ { oid, commit: row }) => ({ oid, message: String(row.message || '').trim(), author: row.author?.name ?? 'peerd', timestamp: Number(row.author?.timestamp ?? 0) * 1000, parents: row.parent ?? [] }));
    if (!includeSafety || typeof ctx.git.listRefs !== 'function') return main;
    let safetyNames = [];
    try { safetyNames = await ctx.git.listRefs({ fs: ctx.fs, gitdir: ctx.gitdir, filepath: 'refs/peerd/safety' }); }
    catch { return main; }
    const safety = [];
    for (const name of safetyNames.slice(-20)) {
      try {
        const oid = await ctx.git.resolveRef({ fs: ctx.fs, gitdir: ctx.gitdir, ref: `refs/peerd/safety/${name}` });
        const { commit: row } = await ctx.git.readCommit({ fs: ctx.fs, gitdir: ctx.gitdir, oid });
        safety.push({ oid, message: String(row.message || '').trim(), author: row.author?.name ?? 'peerd', timestamp: Number(row.author?.timestamp ?? 0) * 1000, parents: row.parent ?? [], safety: true });
      } catch { /* one corrupt private ref must not hide normal history */ }
    }
    return [...safety, ...main];
  });

  /** @param {RepositoryContext} ctx @param {string} ref */
  const snapshotAtUnlocked = async (ctx, ref, /** @type {{maxBytes?:number,maxFiles?:number}} */ limits = {}) => {
    const oid = await ctx.git.resolveRef({ fs: ctx.fs, gitdir: ctx.gitdir, ref });
    const { commit: row } = await ctx.git.readCommit({ fs: ctx.fs, gitdir: ctx.gitdir, oid });
    return readTreeRecursive(ctx.git, ctx.fs, ctx.gitdir, row.tree, '', Object.create(null), {
      bytes: 0,
      maxBytes: limits.maxBytes ?? Infinity,
      maxFiles: limits.maxFiles ?? Infinity,
    });
  };

  /** @param {{kind:string,id:string}} ref @param {{from?:string,to?:string|null}} [opts] */
  const diff = (ref, { from = 'HEAD', to = null } = {}) => run(ref, async (ctx) => {
    const head = await resolveHead(ctx);
    const limits = { maxBytes: 8_000_000, maxFiles: 1_000 };
    const before = head ? await snapshotAtUnlocked(ctx, from, limits) : Object.create(null);
    const after = to ? await snapshotAtUnlocked(ctx, to, limits) : await readVisibleWorkingTree(ctx, limits);
    return { from, to: to ?? 'WORKDIR', ...diffRepositorySnapshots(before, after) };
  });

  /** @param {{kind:string,id:string}} ref @param {{to:string,message?:string}} opts */
  const restore = (ref, { to, message }) => run(ref, async (ctx) => {
    const originalHead = await ensureUnlocked(ctx);
    if (!originalHead) throw new Error('cannot restore an empty repository');
    // Resolve the target before touching the index or worktree. A typo must be
    // a no-op, not leave a half-created safety checkpoint behind.
    const snapshot = await snapshotAtUnlocked(ctx, to);
    const headSnapshot = await snapshotAtUnlocked(ctx, originalHead);
    const liveSnapshot = await readWorkingTree(ctx.fs, ctx.dir);
    let checkpointOid = null;
    const needsSafetyCheckpoint = !snapshotsEqual(headSnapshot, liveSnapshot);
    if (needsSafetyCheckpoint) {
      checkpointOid = await writePrivateSnapshotCommit(ctx, liveSnapshot, originalHead);
      const safetyRef = `refs/peerd/safety/${Date.now()}-${checkpointOid.slice(0, 10)}`;
      // why the ref lands last: an interrupted object write leaves only
      // unreachable local objects, never a half-valid recovery checkpoint.
      await ctx.git.writeRef({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: safetyRef, value: checkpointOid, force: true });
    }
    try {
      await replaceWorkingTreeUnlocked(ctx, snapshot);
      const matrix = await stageAll(ctx);
      if (!matrix.some((/** @type {StatusRow} */ row) => row[1] !== row[2])) {
        return { oid: await resolveHead(ctx), restored: false, checkpointOid };
      }
      const oid = await ctx.git.commit({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, message: commitMessage(message, `restore ${to.slice(0, 10)}`), author: AUTHOR });
      return { oid, restored: true, checkpointOid };
    } catch (error) {
      // Reconstitute the exact pre-restore state, including ignored files. The
      // private safety ref remains as a second recovery path across a crash.
      try {
        const branchName = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, fullname: false });
        await ctx.git.writeRef({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: branchName ? `refs/heads/${branchName}` : 'HEAD', value: originalHead, force: true });
        await ctx.git.checkout({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: branchName ?? originalHead, force: true });
        await writeWorkingTreeUnlocked(ctx, liveSnapshot);
      } catch (rollbackError) {
        const failure = new Error('restore failed and the live tree could not be reconstructed');
        failure.cause = { restore: error, rollback: rollbackError, checkpointOid };
        throw failure;
      }
      throw error;
    }
  });

  /** @param {{kind:string,id:string}} ref @param {{name:string,checkout?:boolean,startPoint?:string}} opts */
  const branch = (ref, { name, checkout = true, startPoint = 'HEAD' }) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const branchName = validBranch(name);
    await ctx.git.branch({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: branchName, object: startPoint, checkout });
    return { branch: branchName, checkedOut: checkout };
  });

  /** @param {{kind:string,id:string}} ref @param {{name:string}} opts */
  const checkout = (ref, { name }) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const branchName = validBranch(name);
    const matrix = await ctx.git.statusMatrix({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir });
    if (matrix.some((/** @type {StatusRow} */ row) => row[1] !== row[2])) throw new Error('commit or restore working-tree changes before switching branches');
    await ctx.git.checkout({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: branchName });
    return { branch: branchName, oid: await resolveHead(ctx) };
  });

  /** @param {{kind:string,id:string}} ref @param {{url:string}} opts */
  const setRemote = (ref, { url }) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const remote = normalizeGitRemote(url);
    await ctx.git.addRemote({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, remote: 'origin', url: remote.url, force: true });
    return remote;
  });

  /** @param {RepositoryContext} ctx */
  const remoteFor = async (ctx) => {
    const url = await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, path: 'remote.origin.url' });
    if (!url) throw new Error('no origin remote configured');
    return normalizeGitRemote(url);
  };

  /** @param {{kind:string,id:string}} ref */
  const getRemote = (ref) => run(ref, async (ctx) => {
    if (!await resolveHead(ctx)) return null;
    try { return await remoteFor(ctx); } catch { return null; }
  });

  /** @param {RepositoryContext} ctx @param {{http:any,remote:{url:string},ref?:string|null,
   * depth?:number,prune?:boolean,tags?:boolean,fs?:any}} options */
  const fetchBranch = async (ctx, { http, remote, ref, depth, prune = false, tags = false,
    fs: transportFs = quotaFsFor(ctx) }) => {
    let result;
    try {
      result = await ctx.git.fetch({
        fs: transportFs, http, dir: ctx.dir, gitdir: ctx.gitdir,
        remote: 'origin', url: remote.url, singleBranch: true, prune, tags,
        ...(ref ? { ref } : {}),
        ...(Number.isFinite(depth) ? { depth } : {}),
      });
    } catch (cause) {
      const missing = /** @type {{code?:unknown,data?:{what?:unknown}}} */ (cause);
      if (missing?.code !== 'NotFoundError' || missing.data?.what !== 'HEAD' || !ref) {
        throw cause;
      }
      const fetchHead = await ctx.git.resolveRef({
        fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir,
        ref: `refs/remotes/origin/${ref}`,
      });
      result = { defaultBranch: null, fetchHead, fetchHeadDescription: null };
    }
    return result;
  };

  /** @param {{kind:string,id:string}} ref @param {{signal?:AbortSignal,expectedRemote?:string}} [opts] */
  const fetchRemote = (ref, { signal, expectedRemote } = {}) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const remote = await remoteFor(ctx);
    if (expectedRemote !== undefined && normalizeGitRemote(expectedRemote).url !== remote.url) {
      throw new Error('Git remote changed before fetch');
    }
    const current = await ctx.git.currentBranch({
      fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, fullname: false,
    });
    const http = gitHttp(remote, signal);
    const result = await fetchBranch(ctx, { http, remote, ref: current, prune: true });
    return { remote, fetchHead: result.fetchHead ?? null, fetchHeadDescription: result.fetchHeadDescription ?? null };
  });

  /** @param {{kind:string,id:string}} ref @param {{ref?:string,signal?:AbortSignal,expectedRemote?:string}} [opts] */
  const push = (ref, { ref: branchName, signal, expectedRemote } = {}) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    const remote = await remoteFor(ctx);
    if (expectedRemote !== undefined && normalizeGitRemote(expectedRemote).url !== remote.url) {
      throw new Error('Git remote changed before push');
    }
    const current = branchName ? validBranch(branchName) : await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, fullname: false });
    if (!current) throw new Error('cannot push a detached HEAD');
    const http = gitHttp(remote, signal);
    const result = await ctx.git.push({ fs: ctx.fs, http, dir: ctx.dir, gitdir: ctx.gitdir, remote: 'origin', ref: current, force: false });
    return { remote, branch: current, ok: result.ok === true, error: result.error ?? null, refs: result.refs ?? [] };
  });

  /** @param {{kind:string,id:string}} ref @param {{url:string,ref?:string,depth?:number,signal?:AbortSignal}} opts */
  const clone = (ref, { url, ref: branchName, depth = 50, signal }) => run(ref, async (ctx) => {
    const remote = normalizeGitRemote(url);
    const existing = await readWorkingTree(ctx.fs, ctx.dir);
    if (Object.keys(existing).length || await resolveHead(ctx)) throw new Error('clone target is not empty');
    const http = gitHttp(remote, signal);
    const quotaFs = quotaFsFor(ctx);
    try {
      await ctx.git.clone({ fs: quotaFs, http, dir: ctx.dir, gitdir: ctx.gitdir, url: remote.url, ...(branchName ? { ref: validBranch(branchName), singleBranch: true } : {}), depth: Math.min(500, Math.max(1, depth)) });
      const files = await readWorkingTree(ctx.fs, ctx.dir, { maxFiles: MAX_LIGHTWEIGHT_FILES, maxBytes: MAX_LIGHTWEIGHT_BYTES });
      const total = Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);
      if (Object.keys(files).length > MAX_LIGHTWEIGHT_FILES || total > MAX_LIGHTWEIGHT_BYTES) {
        throw new Error('repository exceeds the lightweight browser Git limit; use a WebVM');
      }
      return { remote, ...(await statusUnlocked(ctx)) };
    } catch (error) {
      try { await ctx.fs.promises.rm(ctx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { await ctx.fs.promises.rm(ctx.gitdir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  });

  /** Return immutable bytes from a commit, never a concurrently mutable tree. */
  /** @param {{kind:string,id:string}} ref @param {{at?:string}} [opts] */
  const snapshot = (ref, { at = 'HEAD' } = {}) => run(ref, async (ctx) => {
    if (!await resolveHead(ctx)) throw new Error('repository is not initialized');
    return snapshotAtUnlocked(ctx, at);
  });

  /** Return a copy of the visible live worktree without creating a commit. */
  /** @param {{kind:string,id:string}} ref */
  const workingSnapshot = (ref) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    return readVisibleWorkingTree(ctx, {});
  });

  /** Compare every live byte (including ignored files) with one commit tree. */
  /** @param {{kind:string,id:string}} ref @param {{at?:string}} [opts] */
  const matches = (ref, { at = 'HEAD' } = {}) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    return snapshotsEqual(
      await snapshotAtUnlocked(ctx, at),
      await readWorkingTree(ctx.fs, ctx.dir),
    );
  });

  /** Duplicate the complete local DAG/config into a newly-created repository. */
  /** @param {{kind:string,id:string}} source @param {{kind:string,id:string}} target */
  const forkRepository = (source, target) => run(source, async (ctx) => {
    const targetPaths = repositoryPaths(target);
    const sourceGit = await readWorkingTree(ctx.fs, ctx.gitdir);
    const sourceTree = await readWorkingTree(ctx.fs, ctx.dir);
    const targetCtx = { ...ctx, dir: targetPaths.dir, gitdir: targetPaths.gitdir };
    await replaceWorkingTreeUnlocked(targetCtx, sourceTree);
    // The same replacement helper can copy a standalone directory by treating
    // the target gitdir as its worktree; Git objects/refs/config remain exact.
    await replaceWorkingTreeUnlocked({ ...targetCtx, dir: targetPaths.gitdir }, sourceGit);
    return statusUnlocked(targetCtx);
  });

  /** @param {{kind:string,id:string}} ref @param {{files:Record<string,string|Uint8Array>,message?:string}} opts */
  const replaceWorkingTree = (ref, { files, message = 'replace working tree' }) => run(ref, async (ctx) => {
    await ensureUnlocked(ctx);
    /** @type {Record<string,Uint8Array>} */ const bytes = Object.create(null);
    for (const [path, value] of Object.entries(files)) {
      bytes[path] = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    }
    await replaceWorkingTreeUnlocked(ctx, bytes);
    const matrix = await stageAll(ctx);
    if (!matrix.some((/** @type {StatusRow} */ row) => row[1] !== row[2])) {
      return { oid: await resolveHead(ctx), changed: [], created: false };
    }
    const oid = await ctx.git.commit({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, message: commitMessage(message), author: AUTHOR });
    return { oid, changed: matrix.map((/** @type {StatusRow} */ row) => row[0]), created: true };
  });

  /** @param {RepositoryContext} ctx */
  const statusUnlocked = async (ctx) => {
    const matrix = await ctx.git.statusMatrix({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ignored: true });
    const branchName = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, fullname: false });
    return { oid: await resolveHead(ctx), branch: branchName ?? null, dirty: matrix.some((/** @type {StatusRow} */ row) => row[1] !== row[2]) };
  };

  /** @param {{kind:string,id:string}} ref @param {{worktree?:boolean}} [opts] */
  const destroy = (ref, { worktree = false } = {}) => run(ref, async ({ fs: repoFs, dir, gitdir }) => {
    try { await repoFs.promises.rm(gitdir, { recursive: true, force: true }); }
    catch (error) {
      if ((/** @type {{code?:string}} */ (error)).code !== 'ENOENT') throw error;
    }
    if (worktree) {
      try { await repoFs.promises.rm(dir, { recursive: true, force: true }); }
      catch (error) {
        if ((/** @type {{code?:string}} */ (error)).code !== 'ENOENT') throw error;
      }
    }
  });

  return {
    coordinate,
    init, stage, commit, status, branches, history, diff, restore, branch, checkout,
    setRemote, getRemote, fetch: fetchRemote, push, clone, snapshot, workingSnapshot,
    matches, fork: forkRepository,
    replaceWorkingTree, destroy,
    initApp: (/** @type {string} */ appId, /** @type {{message?:string}} */ opts) => init(appRepositoryRef(appId), opts),
    commitApp: (/** @type {string} */ appId, /** @type {{message?:string}} */ opts) => commit(appRepositoryRef(appId), opts),
    statusApp: (/** @type {string} */ appId) => status(appRepositoryRef(appId)),
    historyApp: (/** @type {string} */ appId, /** @type {{depth?:number,includeSafety?:boolean}} */ opts) => history(appRepositoryRef(appId), opts),
    diffApp: (/** @type {string} */ appId, /** @type {{from?:string,to?:string|null}} */ opts) => diff(appRepositoryRef(appId), opts),
    restoreApp: (/** @type {string} */ appId, /** @type {{to:string,message?:string}} */ opts) => restore(appRepositoryRef(appId), opts),
    getAppRemote: (/** @type {string} */ appId) => getRemote(appRepositoryRef(appId)),
    destroyApp: (/** @type {string} */ appId) => destroy(appRepositoryRef(appId)),
  };
};
