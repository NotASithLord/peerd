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

import { buildAppManifest, opfsHelpers, parseAppManifest } from '/peerd-engine/index.js';

export const APP_TAB_GROUP_TITLE = 'peerd';

// Write-layer cap on total app file size. Mirrors the sandbox_create app arm’s
// MAX_TOTAL_CHARS (the tool pre-checks for a nicer error); this is the
// backstop every create() caller hits, including the dweb install routes.
// why 50M: real dwapps ship WASM + a 3D engine (a game is millions of chars);
// the dweb loader already accepts 50M/256 files, but this backstop was the
// true ceiling on every path and capped them at 2M. Raised to match the loader
// so a WASM-heavy app (Three.js + Rapier + assets) can actually be imported.
const MAX_APP_TOTAL_CHARS = 50_000_000;

/** @param {string} appId */
const opfsForApp = (appId) => opfsHelpers(['peerd-apps', appId]);

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/index.js').createAppRegistry>} deps.registry
 * @param {ReturnType<typeof import('./app-tab-tracker.js').createAppTabTracker>} deps.tracker
 * @param {ReturnType<typeof import('/peerd-engine/index.js').createRepositoryService>} deps.repositories
 */
export const createAppClient = ({ registry, tracker, repositories }) => {
  /** @param {string} appId @param {() => Promise<any>} operation */
  const withWriteLock = (appId, operation) => repositories.coordinate({ kind: 'app', id: appId }, operation);
  /** @param {{ sessionId?: string, appId?: string }} [opts] @returns {Promise<string>} */
  const resolveId = async ({ sessionId, appId } = {}) => {
    if (appId) {
      const rec = await registry.get(appId);
      if (!rec) throw new Error(`app not found: ${appId}`);
      return appId;
    }
    if (!sessionId) throw new Error('sessionId or appId required');
    const defaultId = await registry.getDefaultForSession(sessionId);
    if (!defaultId) throw new Error('no current app for this session — create one first');
    return defaultId;
  };

  /**
   * Create a new app. `files` is a path → content map; we write each
   * to OPFS. If only `html` is passed, it becomes index.html (back-
   * compat with the single-file model the agent used to assume).
   * @param {{ name?: string, files?: Record<string, string>, html?: string,
   *   tags?: string[], entryFile?: string, sessionId?: string,
   *   dweb?: import('/peerd-engine/app-registry.js').AppDwebMeta, source?: string }} [opts]
   */
  const create = async ({ name, files, html, tags, entryFile, sessionId, dweb, source } = {}) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('name required');

    const suppliedFiles = files && typeof files === 'object'
      ? files
      : (typeof html === 'string' ? { 'index.html': html } : null);
    if (!suppliedFiles || !Object.keys(suppliedFiles).length) {
      throw new Error('files (or html) required');
    }
    const requestedEntry = entryFile || 'index.html';
    // why a checked-in manifest: the bound App actor is part of the artifact's
    // runtime contract, not invisible peerd metadata. Developers see the same
    // entry/capability declaration on GitHub and in a dweb release. A supplied
    // manifest wins so imported projects preserve their own declaration.
    /** @type {Record<string,string>} */
    const fileMap = Object.assign(Object.create(null), suppliedFiles);
    if (!Object.hasOwn(fileMap, 'peerd.json')) {
      fileMap['peerd.json'] = `${JSON.stringify(buildAppManifest({ entry: requestedEntry, dwapp: !!dweb }), null, 2)}\n`;
    }
    const contract = parseAppManifest(fileMap['peerd.json']);
    const entry = contract.entry;
    if (!Object.hasOwn(fileMap, entry)) throw new Error(`peerd.json entry is missing: ${entry}`);

    // Backstop size cap at the WRITE layer (was only in the app-create
    // tool — so the dweb install routes, which call create() directly with
    // page-supplied files, were unbounded; adversarial review caught it).
    // The tool still pre-checks for a nicer error; this is the floor every
    // caller hits.
    const totalChars = Object.values(fileMap)
      .reduce((n, c) => n + (typeof c === 'string' ? c.length : 0), 0);
    if (totalChars > MAX_APP_TOTAL_CHARS) {
      throw new Error(`app too large: ${totalChars} > ${MAX_APP_TOTAL_CHARS} chars`);
    }

    const record = await registry.create({
      name: name.trim().slice(0, 80),
      tags,
      source,
      entryFile: entry,
      ownerSessionId: sessionId ?? null,
      dweb,
    });

    const opfs = opfsForApp(record.id);
    try {
      for (const [path, content] of Object.entries(fileMap)) {
        await opfs.write(path, content);
      }
      // why part of create: every App is a repository from byte one. If Git
      // initialization fails, roll the half-created catalog + tree back instead
      // of returning an App that silently lacks the feature's safety net.
      await repositories.initApp(record.id, { message: `create ${record.name}` });
    } catch (error) {
      try { await opfs.nuke(); } catch { /* best effort rollback */ }
      try { await repositories.destroyApp(record.id); } catch { /* best effort rollback */ }
      try { await registry.delete(record.id); } catch { /* best effort rollback */ }
      throw error;
    }
    if (sessionId) {
      await registry.setDefaultForSession(sessionId, record.id);
    }
    return record;
  };

  /** Clone a repository and instantiate the validated peerd.json contract.
   * @param {{name?:string,url:string,ref?:string,depth?:number,sessionId?:string,signal?:AbortSignal,allowDweb?:boolean}} opts */
  const createFromGit = async ({ name, url, ref, depth = 50, sessionId, signal, allowDweb = false }) => {
    if (typeof url !== 'string') throw new Error('git URL required');
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
      const opfs = opfsForApp(record.id);
      const paths = new Set((await opfs.list()).map((file) => file.path.replace(/^\/+/, '')));
      let contract;
      if (paths.has('peerd.json')) contract = parseAppManifest(await opfs.read('peerd.json'));
      else if (paths.has('index.html')) contract = parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'index.html' })));
      else throw new Error('repository is not an App: add peerd.json or index.html');
      if (!paths.has(contract.entry)) throw new Error(`peerd.json entry is missing: ${contract.entry}`);
      if (contract.capabilities.includes('dweb') && !allowDweb) throw new Error('this dwapp requires a preview build with the dweb enabled');
      const dwapp = contract.capabilities.includes('dweb')
        ? { uri: null, publisher: null, hash: null, local: true }
        : null;
      const updated = await registry.update(record.id, {
        entryFile: contract.entry,
        ...(dwapp ? { dweb: dwapp } : {}),
      });
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
      return { record: updated, repository, contract };
    } catch (error) {
      await repositories.destroy({ kind: 'app', id: record.id }, { worktree: true }).catch(() => {});
      await registry.delete(record.id).catch(() => {});
      throw error;
    }
  };

  /**
   * Update an existing app. `html` is the convenience for editing the
   * entry file; `path`+`content` updates an arbitrary file. The tab
   * reloads either way so the user sees the result.
   * @param {{ appId?: string, name?: string, html?: string, path?: string,
   *   content?: string, tags?: string[], entryFile?: string, sessionId?: string }} [opts]
   */
  const update = async ({ appId, name, html, path, content, tags, entryFile, sessionId } = {}) => {
    const id = await resolveId({ sessionId, appId });
    return withWriteLock(id, async () => {
      const rec = await registry.get(id);
      if (!rec) return null;
      const opfs = opfsForApp(id);

      if (typeof html === 'string') {
        await opfs.write(rec.entryFile, html);
      }
      if (typeof path === 'string' && typeof content === 'string') {
        await opfs.write(path, content);
      }

      /** @type {Partial<import('/peerd-engine/app-registry.js').AppRecord>} */
      const patch = {};
      if (typeof name === 'string') patch.name = name.trim().slice(0, 80);
      if (Array.isArray(tags)) patch.tags = tags;
      if (typeof entryFile === 'string') patch.entryFile = entryFile;
      const updated = await registry.update(id, patch);

      if (sessionId) await registry.setDefaultForSession(sessionId, id);
      tracker.reloadTab(id).catch(() => {});
      return updated;
    });
  };

  /** Write a single file in the app's OPFS subdir.
   * @param {{ appId?: string, path: string, content: string, sessionId?: string }} args */
  const writeFile = async ({ appId, path, content, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    await withWriteLock(id, async () => {
      if (!await registry.get(id)) throw new Error(`app not found: ${id}`);
      await opfsForApp(id).write(path, content);
      await registry.update(id, {});                  // bump updatedAt
      tracker.reloadTab(id).catch(() => {});
    });
  };

  /** @param {{ appId?: string, path: string, sessionId?: string }} args */
  const readFile = async ({ appId, path, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    return opfsForApp(id).read(path);
  };

  /** @param {{ appId?: string, sessionId?: string }} args */
  const listFiles = async ({ appId, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    return opfsForApp(id).list();
  };

  /** @param {{ appId?: string, path: string, sessionId?: string }} args */
  const deleteFile = async ({ appId, path, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    await withWriteLock(id, async () => {
      const rec = await registry.get(id);
      if (!rec) throw new Error(`app not found: ${id}`);
      if (path === rec?.entryFile) throw new Error(`refusing to delete entry file: ${path}`);
      await opfsForApp(id).delete(path);
      await registry.update(id, {});
      tracker.reloadTab(id).catch(() => {});
    });
  };

  /** @param {{ appId?: string, sessionId?: string, focus?: boolean }} [opts] */
  const open = async ({ appId, sessionId, focus = true } = {}) => {
    const id = await resolveId({ sessionId, appId });
    // why focus: a USER opening an App (Library → Open) brings its tab to the
    // foreground so they see it (DECISIONS #20). The AGENT opening one
    // (focus:false) opens in the BACKGROUND — the tracker drops a "go there" card
    // in the chat instead of stealing focus (DESIGN-12). ensureTab early-returns
    // for a live tab, so re-opening an existing App tab doesn't yank the user back.
    // Isolation failures and readiness timeouts both propagate. why: claiming
    // a background App opened when its host is not runnable leaves the model
    // and user with a dead card and hides a security-floor failure.
    await tracker.ensureTab(id, { active: focus, groupTitle: APP_TAB_GROUP_TITLE });
    if (sessionId) await registry.setDefaultForSession(sessionId, id);
    return id;
  };

  /** @param {string} appId @param {{beforeDelete?:(record:any)=>Promise<void>}} [opts] */
  const deleteApp = async (appId, { beforeDelete } = {}) => withWriteLock(appId, async () => {
      const rec = await registry.get(appId);
      if (!rec) return false;
      if (beforeDelete) await beforeDelete(rec);
      await tracker.closeTab(appId);
      await new Promise((r) => setTimeout(r, 100));
      await opfsForApp(appId).nuke();
      await repositories.destroyApp(appId);
      await registry.delete(appId);
      return true;
    });

  /** @param {{ appId?: string, sessionId?: string, to: string }} args */
  const restoreVersion = async ({ appId, sessionId, to }) => {
    const id = await resolveId({ appId, sessionId });
    const result = await withWriteLock(id, () => repositories.restoreApp(id, { to }));
    tracker.reloadTab(id).catch(() => {});
    return result;
  };

  /** @param {{ appId?: string, sessionId?: string, name: string }} args */
  const checkoutBranch = async ({ appId, sessionId, name }) => {
    const id = await resolveId({ appId, sessionId });
    const result = await withWriteLock(id, () => repositories.checkout({ kind: 'app', id }, { name }));
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
        const files = await opfsForApp(app.id).list();
        for (const f of files) {
          const path = f.path.replace(/^\/+/, '');
          let content;
          try { content = await opfsForApp(app.id).read(path); } catch { continue; }
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
    writeFile, readFile, listFiles, deleteFile,
    open,
    delete: deleteApp,
    restoreVersion,
    checkoutBranch,
    search,
    opfsForApp,
    withWriteLock,
    repositories,
  };
};
