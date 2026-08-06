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
 */
export const opfsHelpers = (rootPath) => {
  const ensureRoot = async () => {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS not supported in this context');
    }
    let dir = await navigator.storage.getDirectory();
    for (const part of rootPath) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return dir;
  };

  /**
   * @param {string} path
   * @param {{ create?: boolean }} [opts]
   */
  const walkParent = async (path, { create = false } = {}) => {
    const root = await ensureRoot();
    const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('opfs: empty path');
    // why cast: the length guard above makes pop() non-undefined; TS can't
    // narrow that across the call.
    const leaf = /** @type {string} */ (parts.pop());
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, leaf };
  };

  return {
    /**
     * Read a text file.
     * @param {string} path
     */
    read: async (path) => {
      const { dir, leaf } = await walkParent(path);
      const fh = await dir.getFileHandle(leaf);
      return (await fh.getFile()).text();
    },

    /**
     * Read a file without UTF-8 decoding.
     *
     * why: App assets and artifact exports must preserve arbitrary bytes.
     * @param {string} path
     * @returns {Promise<Uint8Array<ArrayBuffer>>}
     */
    readBytes: async (path) => {
      const { dir, leaf } = await walkParent(path);
      const fh = await dir.getFileHandle(leaf);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    },

    /**
     * Write a text or binary file.
     * @param {string} path
     * @param {FileSystemWriteChunkType} content
     */
    write: async (path, content) => {
      const { dir, leaf } = await walkParent(path, { create: true });
      const fh = await dir.getFileHandle(leaf, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(content);
        await w.close();
      } catch (error) {
        // why: an aborted writable retains the previous file atomically, while
        // leaving a failed stream open can strand a partial replacement.
        try { await w.abort(); } catch { /* preserve the original write error */ }
        throw error;
      }
    },

    /**
     * Delete a file.
     * @param {string} path
     */
    delete: async (path) => {
      const { dir, leaf } = await walkParent(path);
      await dir.removeEntry(leaf);
    },

    /** List all files recursively from the root. */
    list: async () => {
      const root = await ensureRoot();
      /** @type {{ path: string, size: number }[]} */
      const out = [];
      /**
       * @param {FileSystemDirectoryHandle} dir
       * @param {string} prefix
       */
      const walk = async (dir, prefix) => {
        for await (const entry of dir.values()) {
          const path = `${prefix}/${entry.name}`;
          if (entry.kind === 'file') {
            const fh = await entry.getFile();
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
        const parent = await navigator.storage.getDirectory();
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
