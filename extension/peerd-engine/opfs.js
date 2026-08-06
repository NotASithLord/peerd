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
 * @param {{ getDirectory?: () => Promise<FileSystemDirectoryHandle> }} [deps]
 *   Test seam for the browser-owned OPFS root.
 */
export const opfsHelpers = (rootPath, {
  getDirectory = () => {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS not supported in this context');
    return navigator.storage.getDirectory();
  },
} = {}) => {
  /** @param {AbortSignal | undefined} signal */
  const throwIfAborted = (signal) => {
    if (!signal?.aborted) return;
    const error = new Error('opfs: operation aborted');
    error.name = 'AbortError';
    throw error;
  };

  /** @param {AbortSignal | undefined} signal */
  const ensureRoot = async (signal) => {
    if (typeof getDirectory !== 'function') {
      throw new Error('OPFS not supported in this context');
    }
    throwIfAborted(signal);
    let dir = await getDirectory();
    throwIfAborted(signal);
    for (const part of rootPath) {
      dir = await dir.getDirectoryHandle(part, { create: true });
      throwIfAborted(signal);
    }
    return dir;
  };

  /**
   * @param {string} path
   * @param {{ create?: boolean, signal?: AbortSignal }} [opts]
   */
  const walkParent = async (path, { create = false, signal } = {}) => {
    const root = await ensureRoot(signal);
    const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('opfs: empty path');
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
      const { dir, leaf } = await walkParent(path, { signal });
      // removeEntry has no AbortSignal. This last synchronous check is the
      // commit point: a Stop that landed during path resolution cannot delete
      // a workspace file after the run was terminated.
      throwIfAborted(signal);
      await dir.removeEntry(leaf);
    },

    /** List all files recursively from the root. @param {{ signal?: AbortSignal }} [opts] */
    list: async ({ signal } = {}) => {
      const root = await ensureRoot(signal);
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

    /** Drop the entire subtree (used when an instance is deleted).
     * Missing trees are already gone; every other storage failure must surface. */
    nuke: async () => {
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
