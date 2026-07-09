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

import { opfsHelpers } from '/peerd-engine/index.js';
import { actorManifestFromFiles, ACTOR_MANIFEST_FILE } from '/peerd-runtime/index.js';

export const APP_TAB_GROUP_TITLE = 'peerd';

// Write-layer cap on total app file size. Mirrors the sandbox_create app arm’s
// MAX_TOTAL_CHARS (the tool pre-checks for a nicer error); this is the
// backstop every create() caller hits, including the dweb install routes.
const MAX_APP_TOTAL_CHARS = 2_000_000;

/** @param {string} appId */
const opfsForApp = (appId) => opfsHelpers(['peerd-apps', appId]);

// Re-derive the dwapp ACTOR MANIFEST from an app's OPFS bundle (its
// peerd.actor.json), validated. Returns the manifest or null (absent/unusable →
// a plain app). Called after any file mutation so editing/removing the manifest
// file flips the app's actor identity. Never throws.
/** @param {string} appId @returns {Promise<object | null>} */
const readActorManifest = async (appId) => {
  let raw;
  try { raw = await opfsForApp(appId).read(ACTOR_MANIFEST_FILE); }
  catch { return null; }   // file absent / unreadable → not (or no longer) an actor
  return actorManifestFromFiles({ [ACTOR_MANIFEST_FILE]: raw });
};

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/index.js').createAppRegistry>} deps.registry
 * @param {ReturnType<typeof import('./app-tab-tracker.js').createAppTabTracker>} deps.tracker
 */
export const createAppClient = ({ registry, tracker }) => {
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

    const fileMap = files && typeof files === 'object'
      ? files
      : (typeof html === 'string' ? { 'index.html': html } : null);
    if (!fileMap || !Object.keys(fileMap).length) {
      throw new Error('files (or html) required');
    }
    const entry = entryFile || 'index.html';
    if (!(entry in fileMap)) throw new Error(`entryFile not in files: ${entry}`);

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
      // A dwapp declares its actor personality in peerd.actor.json among its
      // files. Derived + validated here (in memory — no extra OPFS read) so a
      // locally-built app AND a dweb-installed one both become actors uniformly.
      // A peer's untrusted manifest is coerce-and-clamped by the parser.
      actor: actorManifestFromFiles(fileMap),
    });

    const opfs = opfsForApp(record.id);
    for (const [path, content] of Object.entries(fileMap)) {
      await opfs.write(path, content);
    }
    if (sessionId) {
      await registry.setDefaultForSession(sessionId, record.id);
    }
    return record;
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
    // Re-derive the actor manifest only when this update actually wrote files —
    // a pure metadata edit (rename/tag) must not clear a valid manifest.
    if (typeof html === 'string' || (typeof path === 'string' && typeof content === 'string')) {
      // null (manifest removed) is a valid clear signal the registry handles.
      patch.actor = /** @type {any} */ (await readActorManifest(id));
    }
    const updated = await registry.update(id, patch);

    if (sessionId) await registry.setDefaultForSession(sessionId, id);
    tracker.reloadTab(id).catch(() => {});
    return updated;
  };

  /** Write a single file in the app's OPFS subdir.
   * @param {{ appId?: string, path: string, content: string, sessionId?: string }} args */
  const writeFile = async ({ appId, path, content, sessionId }) => {
    const id = await resolveId({ sessionId, appId });
    await opfsForApp(id).write(path, content);
    // Bump updatedAt AND re-derive the actor manifest — writing peerd.actor.json
    // (or editing it) is exactly how an app becomes/updates its actor identity.
    await registry.update(id, /** @type {any} */ ({ actor: await readActorManifest(id) }));
    tracker.reloadTab(id).catch(() => {});
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
    const rec = await registry.get(id);
    if (path === rec?.entryFile) throw new Error(`refusing to delete entry file: ${path}`);
    await opfsForApp(id).delete(path);
    // Deleting peerd.actor.json drops the actor identity; re-derive to reflect it.
    await registry.update(id, /** @type {any} */ ({ actor: await readActorManifest(id) }));
    tracker.reloadTab(id).catch(() => {});
  };

  /** @param {{ appId?: string, sessionId?: string, focus?: boolean }} [opts] */
  const open = async ({ appId, sessionId, focus = true } = {}) => {
    const id = await resolveId({ sessionId, appId });
    // why focus: a USER opening an App (Library → Open) brings its tab to the
    // foreground so they see it (DECISIONS #20). The AGENT opening one
    // (focus:false) opens in the BACKGROUND — the tracker drops a "go there" card
    // in the chat instead of stealing focus (DESIGN-12). ensureTab early-returns
    // for a live tab, so re-opening an existing App tab doesn't yank the user back.
    try {
      await tracker.ensureTab(id, { active: focus, groupTitle: APP_TAB_GROUP_TITLE });
    } catch (e) {
      // A background tab can miss the readiness timeout (Chrome throttles
      // not-yet-visible tabs) but it WAS created + already announced — only a
      // FOCUSED (user) open treats the timeout as a real failure.
      if (focus) throw e;
    }
    if (sessionId) await registry.setDefaultForSession(sessionId, id);
    return id;
  };

  /** @param {string} appId */
  const deleteApp = async (appId) => {
    const rec = await registry.get(appId);
    if (!rec) return false;
    await tracker.closeTab(appId);
    await new Promise((r) => setTimeout(r, 100));
    try { await opfsForApp(appId).nuke(); }
    catch (e) { console.warn('[app-client] OPFS nuke failed', e); }
    await registry.delete(appId);
    return true;
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
    create, update,
    writeFile, readFile, listFiles, deleteFile,
    open,
    delete: deleteApp,
    search,
    opfsForApp,
  };
};
