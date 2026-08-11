// @ts-check
// peerd-engine/opfs.js — OPFS file ops rooted at a per-instance path.
//
// Both editor.js (mounted in tab pages) and the SW use these for
// per-instance file storage. The browser surface is the same in both
// contexts; we just don't bake a directory handle into the closure
// since the handles can become stale across SW restarts.

/**
 * @param {string[]} rootPath - path components from origin root, e.g.
 *                              ['peerd-notebooks', 'notebook-abc'] or
 *                              ['peerd-apps', 'app-xyz'].
 * @param {{ getDirectory?: () => Promise<FileSystemDirectoryHandle>,
 *   beforeMutation?: () => void | Promise<void> }} [deps]
 *   Test seam for the browser-owned OPFS root.
 */
export const opfsHelpers = (rootPath, {
  getDirectory = () => {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS not supported in this context');
    return navigator.storage.getDirectory();
  },
  beforeMutation = () => {},
} = {}) => {
  if (!Array.isArray(rootPath) || !rootPath.length || rootPath.some((part) => (
    typeof part !== 'string' || !part || part === '.' || part === '..'
    || part.includes('/') || part.includes('\\') || part.includes('\0')
  ))) {
    throw new Error('opfs: invalid root path');
  }

  /** @param {string} path @param {{ allowRoot?: boolean }} [opts] */
  const safeParts = (path, { allowRoot = false } = {}) => {
    if (typeof path !== 'string' || path.includes('\\') || path.includes('\0')) {
      throw new Error('opfs: invalid path');
    }
    const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
    if ((!allowRoot && !parts.length) || parts.some((part) => part === '.' || part === '..')) {
      throw new Error(`opfs: unsafe path: ${path}`);
    }
    return parts;
  };

  /** @param {AbortSignal | undefined} signal */
  const throwIfAborted = (signal) => {
    if (!signal?.aborted) return;
    const error = new Error('opfs: operation aborted');
    error.name = 'AbortError';
    throw error;
  };

  /** @param {boolean} create @param {AbortSignal | undefined} signal */
  const openRoot = async (create, signal) => {
    if (typeof getDirectory !== 'function') {
      throw new Error('OPFS not supported in this context');
    }
    throwIfAborted(signal);
    let dir = await getDirectory();
    throwIfAborted(signal);
    for (const part of rootPath) {
      dir = await dir.getDirectoryHandle(part, { create });
      throwIfAborted(signal);
    }
    return dir;
  };

  /** @param {string} path */
  const canonicalPath = (path) => safeParts(path, { allowRoot: true }).join('/');

  /** Refuse the two copy shapes that would mutate the traversal beneath it. */
  const assertDistinctTarget = (/** @type {string} */ from, /** @type {string} */ to, /** @type {boolean} */ directory) => {
    const source = canonicalPath(from);
    const target = canonicalPath(to);
    if (source === target || (directory && (!source || target.startsWith(`${source}/`)))) {
      throw new Error('opfs: destination must be outside the source');
    }
  };

  /** @param {string} path @param {{ create?: boolean, rootCreate?: boolean, signal?: AbortSignal }} [opts] */
  const walkDirectory = async (path, { create = false, rootCreate = create, signal } = {}) => {
    let dir = await openRoot(rootCreate, signal);
    for (const part of safeParts(path, { allowRoot: true })) {
      dir = await dir.getDirectoryHandle(part, { create });
      throwIfAborted(signal);
    }
    return dir;
  };

  /**
   * @param {string} path
   * @param {{ create?: boolean, signal?: AbortSignal }} [opts]
   */
  const walkParent = async (path, { create = false, signal } = {}) => {
    const parts = safeParts(path);
    const root = await openRoot(create, signal);
    // why cast: the length guard above makes pop() non-undefined; TS can't
    // narrow that across the call.
    const leaf = /** @type {string} */ (parts.pop());
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
      throwIfAborted(signal);
    }
    return { dir, leaf };
  };

  /** @param {string} path @param {{ signal?: AbortSignal }} [opts] */
  const getEntry = async (path, { signal } = {}) => {
    const parts = safeParts(path, { allowRoot: true });
    if (!parts.length) return { kind: 'directory', handle: await openRoot(false, signal) };
    const { dir, leaf } = await walkParent(path, { signal });
    try {
      const handle = await dir.getFileHandle(leaf);
      throwIfAborted(signal);
      return { kind: 'file', handle };
    }
    catch (error) {
      if ((/** @type {{name?:string}} */ (error)).name !== 'TypeMismatchError'
          && (/** @type {{name?:string}} */ (error)).name !== 'NotFoundError') throw error;
    }
    const handle = await dir.getDirectoryHandle(leaf);
    throwIfAborted(signal);
    return { kind: 'directory', handle };
  };

  /** @param {FileSystemFileHandle|FileSystemDirectoryHandle} handle @param {string} target @param {boolean} recursive @param {AbortSignal | undefined} signal */
  const copyEntry = async (handle, target, recursive, signal) => {
    throwIfAborted(signal);
    if (handle.kind === 'file') {
      const source = await /** @type {FileSystemFileHandle} */ (handle).getFile();
      throwIfAborted(signal);
      const { dir, leaf } = await walkParent(target, { create: true, signal });
      const output = await dir.getFileHandle(leaf, { create: true });
      throwIfAborted(signal);
      const writable = await output.createWritable();
      try {
        await writable.write(await source.arrayBuffer());
        throwIfAborted(signal);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch { /* preserve the original copy error */ }
        throw error;
      }
      return;
    }
    if (!recursive) throw new Error('opfs: source is a directory (recursive required)');
    const targetDir = await walkDirectory(target, { create: true, signal });
    for await (const child of /** @type {FileSystemDirectoryHandle} */ (handle).values()) {
      throwIfAborted(signal);
      await copyEntry(child, `${target}/${child.name}`, true, signal);
    }
    // why touch the handle: creating an empty directory above is the whole copy.
    void targetDir;
  };

  return {
    /**
     * Read a text file.
     * @param {string} path
     * @param {{ signal?: AbortSignal }} [opts]
     */
    read: async (path, { signal } = {}) => {
      const { dir, leaf } = await walkParent(path, { signal });
      throwIfAborted(signal);
      const fh = await dir.getFileHandle(leaf);
      throwIfAborted(signal);
      const file = await fh.getFile();
      throwIfAborted(signal);
      return file.text();
    },

    /**
     * Read a file without UTF-8 decoding.
     *
     * why: App assets and artifact exports must preserve arbitrary bytes.
     * @param {string} path
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<Uint8Array<ArrayBuffer>>}
     */
    readBytes: async (path, { signal } = {}) => {
      const { dir, leaf } = await walkParent(path, { signal });
      throwIfAborted(signal);
      const fh = await dir.getFileHandle(leaf);
      throwIfAborted(signal);
      const file = await fh.getFile();
      throwIfAborted(signal);
      return new Uint8Array(await file.arrayBuffer());
    },

    /**
     * Write a text or binary file.
     * @param {string} path
     * @param {FileSystemWriteChunkType} content
     * @param {{ signal?: AbortSignal }} [opts]
     */
    write: async (path, content, { signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const { dir, leaf } = await walkParent(path, { create: true, signal });
      throwIfAborted(signal);
      const fh = await dir.getFileHandle(leaf, { create: true });
      throwIfAborted(signal);
      const w = await fh.createWritable();
      /** @type {(() => void) | undefined} */
      let onAbort;
      try {
        // FileSystemWritableFileStream is the one OPFS primitive here with an
        // explicit rollback operation. Wire Stop directly to abort(), then
        // re-check before close so an interrupted replacement never commits.
        if (signal) {
          onAbort = () => { void w.abort().catch(() => {}); };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        throwIfAborted(signal);
        await w.write(content);
        throwIfAborted(signal);
        await w.close();
      } catch (error) {
        // why: an aborted writable retains the previous file atomically, while
        // leaving a failed stream open can strand a partial replacement.
        try { await w.abort(); } catch { /* preserve the original write error */ }
        throw error;
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    },

    /**
     * Delete a file.
     * @param {string} path
     * @param {{ signal?: AbortSignal }} [opts]
     */
    delete: async (path, { signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const { dir, leaf } = await walkParent(path, { signal });
      // removeEntry has no AbortSignal. This last synchronous check is the
      // commit point: a Stop that landed during path resolution cannot delete
      // a workspace file after the run was terminated.
      throwIfAborted(signal);
      await dir.removeEntry(leaf);
    },

    /** List all files recursively from the root. @param {{ signal?: AbortSignal }} [opts] */
    list: async ({ signal } = {}) => {
      let root;
      try { root = await openRoot(false, signal); }
      catch (error) {
        if (/** @type {{ name?: string }} */ (error)?.name === 'NotFoundError') return [];
        throw error;
      }
      /** @type {{ path: string, size: number }[]} */
      const out = [];
      /**
       * @param {FileSystemDirectoryHandle} dir
       * @param {string} prefix
       */
      const walk = async (dir, prefix) => {
        for await (const entry of dir.values()) {
          throwIfAborted(signal);
          const path = `${prefix}/${entry.name}`;
          if (entry.kind === 'file') {
            const fh = await entry.getFile();
            throwIfAborted(signal);
            out.push({ path, size: fh.size });
          } else {
            await walk(entry, path);
          }
        }
      };
      await walk(root, '');
      return out;
    },

    /** Return metadata without exposing a raw OPFS handle.
     * @param {string} path @param {{ signal?: AbortSignal }} [opts] */
    stat: async (path, { signal } = {}) => {
      const normalized = canonicalPath(path);
      if (!normalized) {
        // The mounted root is a logical directory even before its first write;
        // inspecting an empty Pod must not create browser storage as a side effect.
        return { path: '/', kind: 'directory', size: 0 };
      }
      const entry = await getEntry(path, { signal });
      if (entry.kind === 'directory') {
        return { path: normalized ? `/${normalized}` : '/', kind: 'directory', size: 0 };
      }
      const file = await /** @type {FileSystemFileHandle} */ (entry.handle).getFile();
      throwIfAborted(signal);
      return { path: `/${normalized}`, kind: 'file', size: file.size, modifiedAt: file.lastModified };
    },

    /** List one directory, including directories (unlike list(), which is recursive files only).
     * @param {string} [path] @param {{ signal?: AbortSignal }} [opts] */
    listDir: async (path = '/', { signal } = {}) => {
      const prefix = canonicalPath(path);
      let dir;
      try { dir = await walkDirectory(path, { signal }); }
      catch (error) {
        if (!prefix && (/** @type {{name?:string}} */ (error)).name === 'NotFoundError') return [];
        throw error;
      }
      const entries = [];
      for await (const entry of dir.values()) {
        throwIfAborted(signal);
        let size = 0;
        if (entry.kind === 'file') {
          size = (await entry.getFile()).size;
          throwIfAborted(signal);
        }
        entries.push({
          name: entry.name,
          path: `/${prefix ? `${prefix}/` : ''}${entry.name}`,
          kind: entry.kind,
          size,
        });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Create a directory; parents are created by default for shell ergonomics.
     * @param {string} path @param {{ recursive?: boolean, signal?: AbortSignal }} [opts] */
    mkdir: async (path, { recursive = true, signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const parts = safeParts(path);
      if (recursive) {
        await walkDirectory(path, { create: true, signal });
        return;
      }
      const leaf = /** @type {string} */ (parts.pop());
      const parent = await walkDirectory(parts.join('/'), { rootCreate: true, signal });
      throwIfAborted(signal);
      await parent.getDirectoryHandle(leaf, { create: true });
    },

    /** Remove a file or directory. The mounted root itself is never a valid target.
     * @param {string} path @param {{ recursive?: boolean, signal?: AbortSignal }} [opts] */
    remove: async (path, { recursive = false, signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const { dir, leaf } = await walkParent(path, { signal });
      throwIfAborted(signal);
      await dir.removeEntry(leaf, { recursive });
    },

    /** Copy within this rooted workspace.
     * @param {string} from @param {string} to
     * @param {{ recursive?: boolean, signal?: AbortSignal }} [opts] */
    copy: async (from, to, { recursive = false, signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const source = await getEntry(from, { signal });
      assertDistinctTarget(from, to, source.kind === 'directory');
      await copyEntry(/** @type {any} */ (source.handle), to, recursive, signal);
    },

    /** Move within this rooted workspace, using copy-then-delete for Firefox parity.
     * @param {string} from @param {string} to @param {{ signal?: AbortSignal }} [opts] */
    move: async (from, to, { signal } = {}) => {
      throwIfAborted(signal);
      await beforeMutation();
      throwIfAborted(signal);
      const source = await getEntry(from, { signal });
      assertDistinctTarget(from, to, source.kind === 'directory');
      await copyEntry(/** @type {any} */ (source.handle), to, true, signal);
      throwIfAborted(signal);
      const { dir, leaf } = await walkParent(from, { signal });
      throwIfAborted(signal);
      await dir.removeEntry(leaf, { recursive: source.kind === 'directory' });
    },

    /** Missing-path checks are common in shell dispatch and should not throw.
     * @param {string} path @param {{ signal?: AbortSignal }} [opts] */
    exists: async (path, { signal } = {}) => {
      if (!canonicalPath(path)) return true;
      try { await getEntry(path, { signal }); return true; }
      catch (error) {
        if ((/** @type {{name?:string}} */ (error)).name === 'NotFoundError') return false;
        throw error;
      }
    },

    /** Drop the entire subtree (used when an instance is deleted).
     * Missing trees are already gone; every other storage failure must surface. */
    nuke: async () => {
      await beforeMutation();
      try {
        const parent = await getDirectory();
        let dir = parent;
        for (let i = 0; i < rootPath.length - 1; i++) {
          dir = await dir.getDirectoryHandle(rootPath[i]);
        }
        await dir.removeEntry(rootPath[rootPath.length - 1], { recursive: true });
      } catch (error) {
        if (/** @type {{ name?: string }} */ (error)?.name !== 'NotFoundError') throw error;
      }
    },
  };
};
