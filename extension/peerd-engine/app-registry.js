// @ts-check
// Persistent catalog of Apps.
//
// An App is a multi-file artifact peerd built FOR the user: a
// calculator, a chart, a one-off tool. Files (index.html + style.css
// + script.js + ...) live in OPFS at `peerd-apps/<appId>/`. Only the
// CATALOG (name, tags, entry filename, timestamps) lives here.
//
// Mirrors vm-registry's session-default pattern (each chat tracks the
// last app it touched, so "make the title bigger" without args edits
// that app) via the shared createRegistry. App's record shape diverges
// from VM/JS — it carries tags + entryFile + updatedAt instead of
// pinned/lastUsedAt — so its buildExtra/applyPatch differ, and it adds
// a metadata search the other kinds don't have.

import { createRegistry } from './registry-factory.js';

const STORAGE_KEY = 'apps.v1';

/**
 * @typedef {{
 *   uri: string | null,
 *   publisher: string | null,
 *   hash: string | null,
 *   version_id?: string,
 *   dwapp_id?: string,
 *   slug?: string,
 *   seq?: number,
 *   manifest_created?: number,
 *   local?: boolean,
 *   seed?: string,
 *   git_oid?: string,
 *   source_git_oid?: string,
 *   previous_version_id?: string,
 *   changelog?: string,
 *   release_created?: number,
 *   release_entry_file?: string,
 *   release_file_kinds?: Record<string, 'text' | 'binary'>,
 *   published_hashes?: string[],
 *   forked_from?: { publisher?: string | null, dwapp_id?: string | null, version_id?: string | null },
 * }} AppDwebMeta
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   tags: string[],
 *   entryFile: string,
 *   ownerSessionId: string | null,
 *   createdAt: number,
 *   updatedAt: number,
 *   favorite: boolean,
 *   source: 'local' | 'imported' | 'dweb',
 *   thumbnail: string | null,
 *   fileKinds: Record<string, 'text' | 'binary'>,
 *   dweb?: AppDwebMeta,
 *   shared?: boolean,
 *   syncContentHash?: string,
 * }} AppRecord
 */

/** @param {unknown} tags */
const truncTags = (tags) => (Array.isArray(tags) ? tags.slice(0, 16) : []);

/** @param {unknown} value */
const cleanFileKinds = (value) => {
  if (!value || typeof value !== 'object') return Object.create(null);
  /** @type {Record<string, 'text' | 'binary'>} */
  const clean = Object.create(null);
  for (const [path, kind] of Object.entries(value).slice(0, 256)) {
    if (path && path.length <= 512 && (kind === 'text' || kind === 'binary')) clean[path] = kind;
  }
  return clean;
};

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.storage
 * @param {(actorSessionId: string) => void} [deps.onActorArchive]  DESIGN-17: forwarded to createRegistry — archive an actor orphaned by delete.
 * @returns the registry; snapshot() returns { apps, currentId }.
 */
export const createAppRegistry = (deps) => {
  /** @type {import('./registry-factory.js').RegistryConfig<AppRecord>} */
  const config = {
    storageKey: STORAGE_KEY,
    collectionKey: 'apps',
    currentKey: 'currentId',
    idPrefix: 'app',
    defaultNamePrefix: 'app',
    notFoundLabel: 'app',
    buildExtra: (_id, opts) => ({
      tags: truncTags(opts.tags),
      entryFile: opts.entryFile || 'index.html',
      fileKinds: cleanFileKinds(opts.fileKinds),
      // why: createdAt is set by the factory; updatedAt starts equal to it.
      updatedAt: Date.now(),
      // Library metadata. favorite = the user's one-click star (filterable
      // in the Library). source distinguishes locally-built apps from
      // imported (.peerd) / dweb-installed ones. thumbnail is a future
      // grid affordance (null until captured).
      favorite: !!opts.favorite,
      source: opts.source ?? 'local',
      thumbnail: opts.thumbnail ?? null,
      // why optional: only dwapps carry it — installed peer-to-peer (uri/
      // publisher/hash from the verified manifest) or shipped as a signed
      // seed. Its presence is what unlocks the app-tab dweb bridge. Set at
      // create, immutable after (like source) — so it is NOT in applyPatch.
      ...(opts.dweb && typeof opts.dweb === 'object' ? { dweb: opts.dweb } : {}),
      ...(typeof opts.syncContentHash === 'string' && /^[0-9a-f]{64}$/.test(opts.syncContentHash)
        ? { syncContentHash: opts.syncContentHash } : {}),
    }),
    applyPatch: (next, patch) => {
      if (typeof patch.name === 'string') next.name = patch.name;
      if (Array.isArray(patch.tags)) next.tags = truncTags(patch.tags);
      if (typeof patch.entryFile === 'string') next.entryFile = patch.entryFile;
      if (patch.fileKinds && typeof patch.fileKinds === 'object') {
        next.fileKinds = cleanFileKinds(patch.fileKinds);
      }
      // Library-mutable fields. favorite is the one-click star; thumbnail
      // is set when a grid preview is captured. source is immutable after
      // create (provenance), so it is deliberately NOT patchable.
      if (typeof patch.favorite === 'boolean') next.favorite = patch.favorite;
      // shared = "this app is published on the dweb" (set on share, cleared on
      // un-share). why mutable (unlike dweb/source): sharing is an action the user
      // takes AFTER create, and it drives the seeding delete-confirmation + the
      // un-share-on-delete path. A plain (non-dwapp) app can be shared too, so this
      // is the only on-record signal that the bytes are out on the network.
      if (typeof patch.shared === 'boolean') next.shared = patch.shared;
      // dweb versioning slot: MERGE (don't replace) so sharing/installing/updating
      // an app can amend its version identity (slug, dwapp_id, version_id, seq, uri)
      // without dropping the provenance fields. why merge not assign: an update
      // bumps version_id+uri+seq but must keep publisher + slug + dwapp_id stable.
      // The slot is otherwise set at create (a self-authored dwapp / an install);
      // this is the one post-create amendment path, mirroring `shared`.
      if (patch.dweb && typeof patch.dweb === 'object') next.dweb = { ...(next.dweb || {}), ...patch.dweb };
      // Internal transaction rollback needs exact replacement, including
      // removal of keys added by a failed version update. Normal callers keep
      // the merge behavior above.
      if (Object.hasOwn(patch, 'dwebExact')) {
        const exact = /** @type {any} */ (patch).dwebExact;
        if (exact && typeof exact === 'object') next.dweb = { ...exact };
        else delete next.dweb;
      }
      // why the cap: the catalog promises "metadata only, stays light" —
      // a fat data-URI thumbnail would ride every apps/list response.
      // Same bounding discipline as name.slice(80) / truncTags.
      if ('thumbnail' in patch) {
        next.thumbnail = (typeof patch.thumbnail === 'string' && patch.thumbnail.length <= 256_000)
          ? patch.thumbnail : null;
      }
      // why: every update bumps updatedAt, unconditionally — it's the
      // "last touched" signal the side panel sorts by.
      next.updatedAt = Date.now();
    },
  };
  const base = createRegistry(config, deps);

  /**
   * Cheap metadata search (name + tags). Repository file search owns bodies.
   *
   * @param {string} query
   */
  const searchMetadata = async (query) => {
    const q = query.toLowerCase();
    const apps = await base.list();
    return apps.filter((a) =>
      a.name.toLowerCase().includes(q)
      || (a.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  };

  return { ...base, searchMetadata };
};

export const APP_TAB_PATH = '/engine-tabs/app-tab/index.html';
