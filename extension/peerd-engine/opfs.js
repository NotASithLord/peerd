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

  /** @param {string} path @param {{ create?: boolean }} [opts] */
  const walkDirectory = async (path, { create = false } = {}) => {
    let dir = await ensureRoot();
    for (const part of safeParts(path, { allowRoot: true })) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  };

  /**
   * @param {string} path
   * @param {{ create?: boolean }} [opts]
   */
  const walkParent = async (path, { create = false } = {}) => {
    const root = await ensureRoot();
    const parts = safeParts(path);
    // why cast: the length guard above makes pop() non-undefined; TS can't
    // narrow that across the call.
    const leaf = /** @type {string} */ (parts.pop());
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, leaf };
  };

  /** @param {string} path */
  const getEntry = async (path) => {
    const parts = safeParts(path, { allowRoot: true });
    if (!parts.length) return { kind: 'directory', handle: await ensureRoot() };
    const { dir, leaf } = await walkParent(path);
    try { return { kind: 'file', handle: await dir.getFileHandle(leaf) }; }
    catch (error) {
      if ((/** @type {{name?:string}} */ (error)).name !== 'TypeMismatchError'
          && (/** @type {{name?:string}} */ (error)).name !== 'NotFoundError') throw error;
    }
    return { kind: 'directory', handle: await dir.getDirectoryHandle(leaf) };
  };

  /** @param {FileSystemFileHandle|FileSystemDirectoryHandle} handle @param {string} target @param {boolean} recursive */
  const copyEntry = async (handle, target, recursive) => {
    if (handle.kind === 'file') {
      const source = await /** @type {FileSystemFileHandle} */ (handle).getFile();
      const { dir, leaf } = await walkParent(target, { create: true });
      const output = await dir.getFileHandle(leaf, { create: true });
      const writable = await output.createWritable();
      await writable.write(await source.arrayBuffer());
      await writable.close();
      return;
    }
    if (!recursive) throw new Error('opfs: source is a directory (recursive required)');
    const targetDir = await walkDirectory(target, { create: true });
    for await (const child of /** @type {FileSystemDirectoryHandle} */ (handle).values()) {
      await copyEntry(child, `${target}/${child.name}`, true);
    }
    // why touch the handle: creating an empty directory above is the whole copy.
    void targetDir;
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

    /** Read a file without UTF-8 decoding (Git and artifact exports need bytes). */
    readBytes: async (/** @type {string} */ path) => {
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
      await w.write(content);
      await w.close();
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

    /** Return metadata without exposing a raw OPFS handle. */
    stat: async (/** @type {string} */ path) => {
      const normalized = path.replace(/^\/+|\/+$/g, '');
      const entry = await getEntry(path);
      if (entry.kind === 'directory') return { path: normalized ? `/${normalized}` : '/', kind: 'directory', size: 0 };
      const file = await /** @type {FileSystemFileHandle} */ (entry.handle).getFile();
      return { path: `/${normalized}`, kind: 'file', size: file.size, modifiedAt: file.lastModified };
    },

    /** List one directory, including directories (unlike list(), which is recursive files only). */
    listDir: async (/** @type {string} */ path = '/') => {
      const dir = await walkDirectory(path);
      const prefix = path.replace(/^\/+|\/+$/g, '');
      const entries = [];
      for await (const entry of dir.values()) {
        let size = 0;
        if (entry.kind === 'file') size = (await entry.getFile()).size;
        entries.push({
          name: entry.name,
          path: `/${prefix ? `${prefix}/` : ''}${entry.name}`,
          kind: entry.kind,
          size,
        });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Create a directory; parents are created by default for shell ergonomics. */
    mkdir: async (/** @type {string} */ path, /** @type {{recursive?:boolean}} */ { recursive = true } = {}) => {
      const parts = safeParts(path);
      if (recursive) { await walkDirectory(path, { create: true }); return; }
      const leaf = /** @type {string} */ (parts.pop());
      const parent = await walkDirectory(parts.join('/'));
      await parent.getDirectoryHandle(leaf, { create: true });
    },

    /** Remove a file or directory. The mounted root itself is never a valid target. */
    remove: async (/** @type {string} */ path, /** @type {{recursive?:boolean}} */ { recursive = false } = {}) => {
      const { dir, leaf } = await walkParent(path);
      await dir.removeEntry(leaf, { recursive });
    },

    /** Copy within this rooted workspace. */
    copy: async (/** @type {string} */ from, /** @type {string} */ to, /** @type {{recursive?:boolean}} */ { recursive = false } = {}) => {
      const source = await getEntry(from);
      assertDistinctTarget(from, to, source.kind === 'directory');
      await copyEntry(/** @type {any} */ (source.handle), to, recursive);
    },

    /** Move within this rooted workspace, using copy-then-delete for Firefox parity. */
    move: async (/** @type {string} */ from, /** @type {string} */ to) => {
      const source = await getEntry(from);
      assertDistinctTarget(from, to, source.kind === 'directory');
      await copyEntry(/** @type {any} */ (source.handle), to, true);
      const { dir, leaf } = await walkParent(from);
      await dir.removeEntry(leaf, { recursive: source.kind === 'directory' });
    },

    /** Missing-path checks are common in shell dispatch and should not throw. */
    exists: async (/** @type {string} */ path) => {
      try { await getEntry(path); return true; }
      catch (error) {
        if ((/** @type {{name?:string}} */ (error)).name === 'NotFoundError') return false;
        throw error;
      }
    },

    /** Drop the entire subtree (used when an instance is deleted). */
    nuke: async () => {
      try {
        const parent = await navigator.storage.getDirectory();
        let dir = parent;
        for (let i = 0; i < rootPath.length - 1; i++) {
          dir = await dir.getDirectoryHandle(rootPath[i]);
        }
        await dir.removeEntry(rootPath[rootPath.length - 1], { recursive: true });
      } catch (error) {
        // Missing is idempotent; permission/quota/storage failures must reach
        // callers so they do not drop the only registry handle to live bytes.
        if ((/** @type {{name?:string}} */ (error)).name !== 'NotFoundError') throw error;
      }
    },
  };
};
