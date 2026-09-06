// @ts-check
// Node-fs-shaped OPFS adapter for isomorphic-git. Git runs in the trusted
// extension context; paths are still normalized here because cloned tree names
// and repository metadata are untrusted bytes.

/** @param {string} code @param {string} path @param {unknown} [cause] */
const fsError = (code, path, cause) => {
  const error = /** @type {Error & { code: string, path: string, cause?: unknown }} */ (
    new Error(`${code}: ${path}`));
  error.code = code;
  error.path = path;
  if (cause) error.cause = cause;
  return error;
};

/** @param {string} path @returns {string[]} */
export const normalizeRepositoryPath = (path) => {
  const raw = String(path ?? '');
  if (raw.includes('\\') || raw.includes('\0')) throw fsError('EINVAL', raw);
  const parts = raw.replace(/^\/+/, '').split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw fsError('EINVAL', raw);
  return parts;
};

/** @param {unknown} error @param {string} path @param {string} [fallback] */
const mapDomError = (error, path, fallback = 'EIO') => {
  const name = /** @type {{ name?: string }} */ (error)?.name;
  if (name === 'NotFoundError') return fsError('ENOENT', path, error);
  if (name === 'TypeMismatchError') return fsError('ENOTDIR', path, error);
  if (name === 'InvalidModificationError') return fsError('ENOTEMPTY', path, error);
  if (name === 'NoModificationAllowedError') return fsError('EACCES', path, error);
  return fsError(fallback, path, error);
};

/** @param {string} path @param {'file'|'dir'} kind @param {number} size @param {number} mtimeMs */
const statShape = (path, kind, size = 0, mtimeMs = 0) => ({
  dev: 0,
  ino: [...path].reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381),
  mode: kind === 'file' ? 0o100644 : 0o040755,
  nlink: 1,
  uid: 0,
  gid: 0,
  rdev: 0,
  size,
  blksize: 4096,
  blocks: Math.ceil(size / 512),
  atimeMs: mtimeMs,
  mtimeMs,
  ctimeMs: mtimeMs,
  birthtimeMs: mtimeMs,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => false,
});

/** @param {FileSystemDirectoryHandle} root @param {string[]} parts @param {{ create?: boolean }} [opts] */
const directoryAt = async (root, parts, { create = false } = {}) => {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
};

/** @param {FileSystemDirectoryHandle} root @param {string} path */
const parentAndLeaf = async (root, path) => {
  const parts = normalizeRepositoryPath(path);
  if (!parts.length) throw fsError('EISDIR', path);
  const leaf = /** @type {string} */ (parts.pop());
  try { return { parent: await directoryAt(root, parts), leaf }; }
  catch (error) { throw mapDomError(error, path); }
};

/**
 * @param {{ getRoot?: () => Promise<FileSystemDirectoryHandle> }} [deps]
 */
export const createOpfsGitFs = ({ getRoot = () => navigator.storage.getDirectory() } = {}) => {
  const root = async () => {
    if (!getRoot) throw fsError('ENOSYS', '/');
    return getRoot();
  };

  const stat = async (/** @type {string} */ path) => {
    const parts = normalizeRepositoryPath(path);
    if (!parts.length) return statShape('/', 'dir');
    const leaf = /** @type {string} */ (parts.pop());
    let parent;
    try { parent = await directoryAt(await root(), parts); }
    catch (error) { throw mapDomError(error, path); }
    try {
      await parent.getDirectoryHandle(leaf);
      return statShape(path, 'dir');
    } catch (directoryError) {
      if ((/** @type {{ name?: string }} */ (directoryError)).name !== 'TypeMismatchError'
          && (/** @type {{ name?: string }} */ (directoryError)).name !== 'NotFoundError') {
        throw mapDomError(directoryError, path);
      }
    }
    try {
      const file = await (await parent.getFileHandle(leaf)).getFile();
      return statShape(path, 'file', file.size, file.lastModified);
    } catch (error) { throw mapDomError(error, path); }
  };

  const promises = {
    /** @param {string} path @param {string|{ encoding?: string }} [options] */
    readFile: async (path, options) => {
      const { parent, leaf } = await parentAndLeaf(await root(), path);
      try {
        const file = await (await parent.getFileHandle(leaf)).getFile();
        const encoding = typeof options === 'string' ? options : options?.encoding;
        if (encoding === 'utf8' || encoding === 'utf-8') return file.text();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) { throw mapDomError(error, path); }
    },
    /** @param {string} path @param {FileSystemWriteChunkType|Uint8Array|string} data */
    writeFile: async (path, data) => {
      const { parent, leaf } = await parentAndLeaf(await root(), path);
      let writable;
      try {
        const file = await parent.getFileHandle(leaf, { create: true });
        writable = await file.createWritable();
        await writable.write(/** @type {FileSystemWriteChunkType} */ (data));
        await writable.close();
      } catch (error) {
        try { await writable?.abort?.(); } catch { /* best effort */ }
        throw mapDomError(error, path);
      }
    },
    /** @param {string} path */
    unlink: async (path) => {
      const { parent, leaf } = await parentAndLeaf(await root(), path);
      try { await parent.removeEntry(leaf); }
      catch (error) { throw mapDomError(error, path); }
    },
    /** @param {string} path */
    readdir: async (path) => {
      const parts = normalizeRepositoryPath(path);
      try {
        const dir = await directoryAt(await root(), parts);
        /** @type {string[]} */ const names = [];
        for await (const entry of dir.values()) names.push(entry.name);
        return names;
      } catch (error) { throw mapDomError(error, path); }
    },
    /** @param {string} path */
    mkdir: async (path) => {
      const parts = normalizeRepositoryPath(path);
      if (!parts.length) throw fsError('EEXIST', path);
      const leaf = /** @type {string} */ (parts.pop());
      let parent;
      try { parent = await directoryAt(await root(), parts); }
      catch (error) { throw mapDomError(error, path); }
      try {
        // OPFS does not expose an exclusive-create flag. Probe first so Git sees
        // the Node-compatible EEXIST it uses to terminate mkdirp recursion.
        try { await parent.getDirectoryHandle(leaf); throw fsError('EEXIST', path); }
        catch (error) {
          if ((/** @type {{ code?: string }} */ (error)).code === 'EEXIST') throw error;
          if ((/** @type {{ name?: string }} */ (error)).name !== 'NotFoundError') throw error;
        }
        await parent.getDirectoryHandle(leaf, { create: true });
      } catch (error) {
        if ((/** @type {{ code?: string }} */ (error)).code === 'EEXIST') throw error;
        throw mapDomError(error, path, 'EEXIST');
      }
    },
    /** @param {string} path @param {{ recursive?: boolean }} [options] */
    rmdir: async (path, options) => {
      const { parent, leaf } = await parentAndLeaf(await root(), path);
      try { await parent.removeEntry(leaf, { recursive: options?.recursive === true }); }
      catch (error) { throw mapDomError(error, path); }
    },
    /** @param {string} path @param {{ recursive?: boolean, force?: boolean }} [options] */
    rm: async (path, options) => {
      try {
        const { parent, leaf } = await parentAndLeaf(await root(), path);
        await parent.removeEntry(leaf, { recursive: options?.recursive === true });
      } catch (error) {
        const normalized = typeof /** @type {{code?:unknown}} */ (error)?.code === 'string'
          ? error : mapDomError(error, path);
        if (options?.force
            && (/** @type {{ code?: string }} */ (normalized)).code === 'ENOENT') return;
        throw normalized;
      }
    },
    stat,
    lstat: stat,
    // OPFS has no symbolic-link primitive. Fail explicitly instead of letting a
    // checkout smuggle a link-like path out of the repository root. Repositories
    // containing symlinks remain available in the WebVM lane.
    /** @param {string} path */
    readlink: async (path) => { throw fsError('EINVAL', path); },
    /** @param {string} _target @param {string} path */
    symlink: async (_target, path) => { throw fsError('ENOSYS', path); },
    // OPFS has no executable bit. Apps/Notebooks intentionally use a stable
    // synthetic 100644 mode; checkout may still ask to chmod it.
    chmod: async () => {},
  };
  return { promises };
};
