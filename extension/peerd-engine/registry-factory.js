// @ts-check
// Shared factory for the three peerd-engine instance registries
// (WebVM, Notebook, App). The fourth execution kind, the headless js_run
// worker, is ephemeral (no persisted instances), so it has no registry.
//
// why: vm/js/app-registry were ~95% the same code — same persistence
// story (a single chrome.storage.local key holding
// { schemaVersion, <collection>, sessionDefaults }), same per-session
// "current" pointer with stale-pointer auto-clear, same CRUD shape.
// They diverged only in data (storage key, collection key, id prefix,
// the snapshot's current-id field) plus two genuinely per-kind
// behaviors, which ride in as injected pure functions rather than
// in-factory `if (kind === …)` branches:
//   - buildExtra(id, opts): the kind-specific record fields at create
//     time (VM's diskOverlayKey; App's tags + entryFile + updatedAt).
//   - applyPatch(next, patch): the update allowlist (VM/JS patch
//     name/pinned/ownerSessionId/lastUsedAt; App patches
//     name/tags/entryFile and always bumps updatedAt).
// Anything truly unique to one kind (App's searchMetadata) is spread
// onto the returned object by that kind's module — it never reaches
// here.

/**
 * @template Rec
 * @typedef {Object} RegistryConfig
 * @property {string} storageKey         chrome.storage.local key for the whole catalog
 * @property {string} collectionKey      key holding the id→record map (also the snapshot field)
 * @property {string} currentKey         snapshot field naming the session's current id
 * @property {string} idPrefix           id namespace, e.g. 'vm' → 'vm-<ts>-<rand>'
 * @property {string} defaultNamePrefix  fallback name prefix, e.g. 'notebook' → 'notebook-3'
 * @property {string} notFoundLabel      noun used in the "<label> not found" throw
 * @property {(id: string, opts: any) => Record<string, any>} [buildExtra]
 *   kind-specific fields merged into a new record (id/name/ownerSessionId/createdAt
 *   are always set by the factory).
 * @property {(next: Rec, patch: Partial<Rec>) => void} applyPatch
 *   mutate `next` in place with the allowlisted fields from `patch`.
 * @property {boolean} [touchOnSetDefault]
 *   when true, setDefaultForSession bumps the record's lastUsedAt (VM/JS).
 */

/**
 * The persisted catalog shape. The id→record map lives under the
 * runtime-chosen `collectionKey` (a dynamic string), so it rides the
 * index signature alongside the two fixed bookkeeping fields.
 *
 * @template Rec
 * @typedef {{
 *   schemaVersion: number,
 *   sessionDefaults: Record<string, string>,
 *   [collection: string]: number | Record<string, string> | Record<string, Rec>,
 * }} RegistryState
 */

/** @param {string} prefix */
const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Create an instance registry backed by the injected key-value store.
 *
 * @template Rec
 * @param {RegistryConfig<Rec>} config
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.storage
 */
export const createRegistry = (config, { storage }) => {
  const {
    storageKey,
    collectionKey,
    currentKey,
    idPrefix,
    defaultNamePrefix,
    notFoundLabel,
    buildExtra = () => ({}),
    applyPatch,
    touchOnSetDefault = false,
  } = config;

  /** @returns {RegistryState<Rec>} */
  const defaultState = () => ({
    schemaVersion: 1,
    [collectionKey]: {},
    sessionDefaults: {},
  });

  let state = defaultState();
  let loaded = false;
  /** @type {Promise<void> | null} the in-flight load(), shared by concurrent callers */
  let loadPromise = null;

  // why a typed accessor: the id→record map sits under the dynamic
  // `collectionKey`, so index access yields the state's union value type;
  // this funnels the one honest narrowing into a single place. It returns
  // the live object reference, so mutations through it persist.
  /** @returns {Record<string, Rec>} */
  const collection = () => /** @type {Record<string, Rec>} */ (state[collectionKey]);

  // why memoize the in-flight read: load() yields at `await storage.get`, and
  // the `loaded` flag is only set AFTER. Two concurrent callers (a cold-boot
  // wave — boot runs load() un-awaited and a registry op can arrive before it
  // resolves) would each reassign the module-level `state` from a pre-write
  // snapshot, so the later resolver clobbers the earlier op's committed write
  // (a just-created/deleted record silently vanishes, its OPFS subtree orphaned).
  // Sharing one promise collapses concurrent loads onto a single read + state.
  const load = () => {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = (async () => {
        const raw = await storage.get(storageKey);
        state = (raw && typeof raw === 'object' && raw.schemaVersion === 1)
          ? {
              ...defaultState(),
              ...raw,
              [collectionKey]: { ...raw[collectionKey] },
              sessionDefaults: { ...raw.sessionDefaults },
            }
          : defaultState();
        loaded = true;
      })();
    }
    return loadPromise;
  };

  const persist = async () => {
    await storage.set(storageKey, state);
  };

  /** @returns {Promise<Rec[]>} */
  const list = async () => {
    await load();
    return Object.values(collection());
  };

  /**
   * @param {string} id
   * @returns {Promise<Rec | null>}
   */
  const get = async (id) => {
    await load();
    return collection()[id] ?? null;
  };

  /**
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<Rec>}
   */
  const create = async (opts = {}) => {
    await load();
    const id = newId(idPrefix);
    const now = Date.now();
    const record = /** @type {Rec} */ ({
      id,
      name: opts.name || `${defaultNamePrefix}-${Object.keys(collection()).length + 1}`,
      ownerSessionId: opts.ownerSessionId ?? null,
      createdAt: now,
      ...buildExtra(id, opts),
    });
    collection()[id] = record;
    await persist();
    return record;
  };

  /**
   * @param {string} id
   * @param {Partial<Rec>} patch
   * @returns {Promise<Rec | null>}
   */
  const update = async (id, patch) => {
    await load();
    const cur = collection()[id];
    if (!cur) return null;
    // why: explicit allowlist of patchable fields. id/createdAt and any
    // kind-specific immutable keys (e.g. VM's diskOverlayKey) are never
    // copied from `patch` — applyPatch only touches the mutable set.
    const next = { ...cur };
    applyPatch(next, patch);
    collection()[id] = next;
    await persist();
    return next;
  };

  /**
   * Drop a record's metadata + clear any session pointers to it. Caller
   * is responsible for the kind's heavier teardown (IDB overlay, OPFS
   * tree, open tab) — the registry only owns the catalog.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  const remove = async (id) => {
    await load();
    if (!collection()[id]) return false;
    delete collection()[id];
    for (const [sessionId, mappedId] of Object.entries(state.sessionDefaults)) {
      if (mappedId === id) delete state.sessionDefaults[sessionId];
    }
    await persist();
    return true;
  };

  /** @param {string} sessionId */
  const getDefaultForSession = async (sessionId) => {
    await load();
    const id = state.sessionDefaults[sessionId];
    if (!id) return null;
    // why: the record may have been deleted out from under us; auto-clear
    // the stale pointer so callers never resolve a dead id.
    if (!collection()[id]) {
      delete state.sessionDefaults[sessionId];
      await persist();
      return null;
    }
    return id;
  };

  /**
   * @param {string} sessionId
   * @param {string} id
   */
  const setDefaultForSession = async (sessionId, id) => {
    await load();
    if (!collection()[id]) throw new Error(`${notFoundLabel} not found: ${id}`);
    state.sessionDefaults[sessionId] = id;
    // why cast: lastUsedAt only exists on the VM/JS record shapes that opt
    // into touchOnSetDefault; the generic Rec doesn't declare it.
    if (touchOnSetDefault) {
      /** @type {{ lastUsedAt?: number }} */ (collection()[id]).lastUsedAt = Date.now();
    }
    await persist();
  };

  /**
   * DESIGN-17: bind an instance to its resident session (the FORWARD pointer
   * instance → resident). A direct field write + persist — NOT via update()/
   * applyPatch, whose per-kind allowlists deliberately don't carry it. Returns
   * the updated record, or null if the instance is gone. Distinct from
   * ownerSessionId (the CHAT that created the instance): a single instance can
   * be owned by chat X yet driven by its own resident session R.
   *
   * @param {string} id @param {string} residentSessionId @returns {Promise<Rec | null>}
   */
  const setResidentSession = async (id, residentSessionId) => {
    await load();
    const cur = collection()[id];
    if (!cur) return null;
    const next = { ...cur, residentSessionId };
    collection()[id] = next;
    await persist();
    return next;
  };

  /**
   * Read the instance's bound resident session id, or null when unbound (lazy
   * minting: the first message_resident binds it). Survives registry.load()
   * because it rides the persisted record.
   *
   * @param {string} id @returns {Promise<string | null>}
   */
  const getResidentSession = async (id) => {
    await load();
    const rec = /** @type {{ residentSessionId?: string } | undefined} */ (collection()[id]);
    return rec?.residentSessionId ?? null;
  };

  /**
   * Bulk view for the side panel + agent tools. Includes which record is
   * the current default for the given session so the UI can flag
   * "current" without a second lookup.
   *
   * @param {{ sessionId?: string }} [opts]
   */
  const snapshot = async ({ sessionId } = {}) => {
    await load();
    const current = sessionId ? state.sessionDefaults[sessionId] ?? null : null;
    return {
      [collectionKey]: Object.values(collection()),
      [currentKey]: current,
    };
  };

  return {
    load,
    list,
    get,
    create,
    update,
    delete: remove,
    getDefaultForSession,
    setDefaultForSession,
    setResidentSession,
    getResidentSession,
    snapshot,
  };
};
