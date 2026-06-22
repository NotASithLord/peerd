// @ts-check
// Memory store — imperative shell over the pure core (memory.js).
//
// IO is injected: the SW passes the egress `idb` adapter ({ get, put,
// getAll, del } over the 'agents_memory' object store) and a `confirm`
// fn (the SW's confirm coordinator). Tests pass an in-memory fake of
// both. This module never imports a concrete IDB or chrome.* — the
// functional-core/imperative-shell rule CLAUDE.md mandates.
//
// Public verbs (re-exported through peerd-runtime/index.js):
//   loadAlwaysLoaded()    → the <memory> block for the system prompt
//   readScope(scope)      → one doc (used for subtree on-demand reads)
//   proposeWrite(...)     → build a confirmation-gated write proposal
//   commitWrite(proposal) → persist a proposal (post-confirmation)
//   writeWithConfirm(...) → propose → confirm round-trip → commit
//   deleteScope(scope)    → remove a doc (still goes through confirm)
//   exportAll() / importAll() / deleteAll()  → reversibility (CLAUDE.md)
//   readInitializer / ensureInitializer / logProgress  → initializer pattern

import {
  scopeId, normalizeWorkspace, normalizeSubpath, subpathInScope,
  normalizeBody, assembleAlwaysLoaded, buildWriteProposal,
  initializerScope, seedInitializerBody, appendProgress,
  ALWAYS_LOADED_LINE_BUDGET,
} from './memory.js';

const STORE = 'agents_memory';

/** @typedef {import('./memory.js').MemoryDoc} MemoryDoc */
/** @typedef {import('./memory.js').MemoryScopeKind} MemoryScopeKind */

/**
 * Build a memory store bound to injected IO.
 *
 * @param {Object} deps
 * @param {{
 *   get: (store: string, key: string) => Promise<any>,
 *   put: (store: string, value: any) => Promise<void>,
 *   getAll: (store: string) => Promise<any[]>,
 *   del: (store: string, key: string) => Promise<void>,
 * }} deps.idb
 * @param {() => number} [deps.now]  injected clock (ms); defaults Date.now
 */
export const createMemoryStore = ({ idb, now = () => Date.now() }) => {
  if (!idb || typeof idb.get !== 'function') {
    throw new TypeError('createMemoryStore: idb adapter is required');
  }

  /** Raw read of a doc by scope id. @param {string} id @returns {Promise<MemoryDoc|null>} */
  const getById = async (id) => (await idb.get(STORE, id)) ?? null;

  /**
   * Read the doc at an explicit scope. Used for subtree on-demand reads
   * and for fetching the prior doc before a write.
   * @param {{kind: MemoryScopeKind, workspace?: string, subpath?: string}} scope
   * @returns {Promise<MemoryDoc|null>}
   */
  const readScope = (scope) => getById(scopeId(scope));

  /**
   * Assemble the always-loaded <memory> block for the system prompt. We
   * fetch only the user doc + the doc for the active workspace, never a
   * full table scan — keeping load cheap and the prompt lean.
   *
   * @param {Object} [opts]
   * @param {string} [opts.workspace]   active workspace (origin / vm / app id)
   * @param {number} [opts.budget]      line budget override
   * @returns {Promise<{ text: string, includedIds: string[], truncated: boolean, lineCount: number }>}
   */
  const loadAlwaysLoaded = async ({ workspace, budget = ALWAYS_LOADED_LINE_BUDGET } = {}) => {
    const ws = normalizeWorkspace(workspace);
    const ids = ['user'];
    if (ws) ids.push(scopeId({ kind: 'project', workspace: ws }));
    const docs = (await Promise.all(ids.map(getById)))
      .filter(/** @returns {d is MemoryDoc} */ (d) => d != null);
    return assembleAlwaysLoaded(docs, { budget });
  };

  /**
   * List subtree docs in scope for a workspace+path, most-specific first.
   * On-demand only (never always-loaded). The agent calls this when it
   * descends into a folder/section.
   *
   * @param {string} workspace
   * @param {string} targetSubpath
   * @returns {Promise<MemoryDoc[]>}
   */
  const readSubtree = async (workspace, targetSubpath) => {
    const ws = normalizeWorkspace(workspace);
    const target = normalizeSubpath(targetSubpath);
    const all = await idb.getAll(STORE);
    return all
      .filter((d) => d.kind === 'subtree' && d.workspace === ws && subpathInScope(d.subpath, target))
      .sort((a, b) => b.subpath.length - a.subpath.length);
  };

  /**
   * Build a write proposal WITHOUT persisting. The agent path always
   * produces one of these; the SW renders it for confirmation. Reads the
   * prior doc so the proposal carries an accurate diff.
   *
   * @param {Object} input
   * @param {{kind: MemoryScopeKind, workspace?: string, subpath?: string}} input.scope
   * @param {string} input.body
   * @param {'agent'|'user'} [input.origin]
   */
  const proposeWrite = async ({ scope, body, origin = 'agent' }) => {
    const prior = await readScope(scope);
    return buildWriteProposal({ scope, prior, body, origin });
  };

  /**
   * Persist a proposal. Caller is responsible for having obtained user
   * consent for agent-origin writes (writeWithConfirm does this). A
   * delete op removes the row; create/update puts it; noop is a no-op.
   *
   * @param {ReturnType<typeof buildWriteProposal>} proposal
   * @returns {Promise<{ ok: true, op: string, id: string }>}
   */
  const commitWrite = async (proposal) => {
    const { id, scope, op } = proposal;
    if (op === 'noop') return { ok: true, op, id };
    if (op === 'delete') {
      await idb.del(STORE, id);
      return { ok: true, op, id };
    }
    const ts = now();
    const prior = await getById(id);
    /** @type {MemoryDoc} */
    const doc = {
      id,
      kind: scope.kind,
      workspace: scope.workspace,
      subpath: scope.subpath || undefined,
      body: normalizeBody(proposal.body),
      createdAt: prior?.createdAt ?? ts,
      updatedAt: ts,
    };
    await idb.put(STORE, doc);
    return { ok: true, op, id };
  };

  /**
   * Full propose → confirm → commit flow. AGENT-origin writes round-trip
   * through the injected confirm fn (the lethal-trifecta defense); a
   * rejection returns { ok:false, rejected:true } and persists nothing.
   * USER-origin writes (proposal.requiresConfirmation === false) commit
   * directly. The confirm fn receives the proposal so the side panel can
   * render the exact diff before the user says yes.
   *
   * @param {Object} input
   * @param {import('./memory.js').MemoryScope} input.scope
   * @param {string} input.body
   * @param {'agent'|'user'} [input.origin]
   * @param {(proposal: object) => Promise<'yes_once'|'yes_session'|'no'|boolean>} [input.confirm]
   * @returns {Promise<{ ok: boolean, op?: string, id?: string, rejected?: boolean,
   *   reason?: string, proposal: import('./memory.js').WriteProposal }>}
   */
  const writeWithConfirm = async ({ scope, body, origin = 'agent', confirm }) => {
    const proposal = await proposeWrite({ scope, body, origin });
    if (proposal.op === 'noop') return { ok: true, op: 'noop', id: proposal.id, proposal };
    if (proposal.requiresConfirmation) {
      if (typeof confirm !== 'function') {
        // why: fail CLOSED. A missing confirm channel on an agent write
        // must never silently persist — that's the exact trifecta hole.
        return { ok: false, rejected: true, reason: 'no_confirm_channel', proposal };
      }
      let answer;
      try { answer = await confirm(proposal); }
      catch { answer = 'no'; }
      const approved = answer === true || answer === 'yes_once' || answer === 'yes_session';
      if (!approved) return { ok: false, rejected: true, proposal };
    }
    const res = await commitWrite(proposal);
    return { ...res, proposal };
  };

  /**
   * Delete a scope's doc. Routed through writeWithConfirm with an empty
   * body so a destructive agent action still asks first.
   *
   * @param {Object} input
   * @param {import('./memory.js').MemoryScope} input.scope
   * @param {'agent'|'user'} [input.origin]
   * @param {(proposal: object) => Promise<'yes_once'|'yes_session'|'no'|boolean>} [input.confirm]
   */
  const deleteScope = ({ scope, origin = 'agent', confirm }) =>
    writeWithConfirm({ scope, body: '', origin, confirm });

  // ── Reversibility (CLAUDE.md: persisted state is exportable + deletable)

  /** Export every memory doc as a plain JSON-able array. */
  const exportAll = async () => {
    const all = await idb.getAll(STORE);
    return { version: 1, exportedAt: now(), docs: all };
  };

  /**
   * Import docs (e.g. from another machine). Last-write-wins per id by
   * updatedAt; lets a user restore a backup without clobbering newer
   * local edits. Returns counts.
   *
   * @param {{ docs?: MemoryDoc[] } | null | undefined} payload  an exportAll() blob
   */
  const importAll = async (payload) => {
    const docs = Array.isArray(payload?.docs) ? payload.docs : [];
    let written = 0; let skipped = 0;
    for (const incoming of docs) {
      if (!incoming?.id || typeof incoming.body !== 'string') { skipped++; continue; }
      const existing = await getById(incoming.id);
      if (existing && existing.updatedAt >= incoming.updatedAt) { skipped++; continue; }
      await idb.put(STORE, incoming);
      written++;
    }
    return { written, skipped };
  };

  /** Delete ALL memory. Reversible-via-export; the nuclear option. */
  const deleteAll = async () => {
    const all = await idb.getAll(STORE);
    await Promise.all(all.map((d) => idb.del(STORE, d.id)));
    return { deleted: all.length };
  };

  // ── Initializer-session pattern ──────────────────────────────────────

  /** Read a workspace's initializer journal, or null if it has none. @param {string} workspace */
  const readInitializer = (workspace) => readScope(initializerScope(workspace));

  /**
   * Ensure a workspace has an initializer journal, creating it on first
   * run. The initializer doc is internal bookkeeping, not curated user
   * memory, so it is written with origin:'user' — it does not prompt.
   * Idempotent: returns the existing journal untouched on later calls.
   *
   * @param {Object} input
   * @param {string} input.workspace
   * @param {string[]} [input.checklist]
   * @returns {Promise<{ created: boolean, doc: MemoryDoc }>}
   */
  const ensureInitializer = async ({ workspace, checklist = [] }) => {
    const existing = await readInitializer(workspace);
    if (existing) return { created: false, doc: existing };
    const scope = initializerScope(workspace);
    const body = seedInitializerBody({ workspace, checklist, nowIso: new Date(now()).toISOString() });
    await writeWithConfirm({ scope, body, origin: 'user' });
    // why cast: an origin:'user' write commits unconditionally (no confirm
    // gate), so the just-persisted doc reads back non-null here.
    const doc = /** @type {MemoryDoc} */ (await getById(scopeId(scope)));
    return { created: true, doc };
  };

  /**
   * Append a progress entry to the workspace journal before a session
   * exits (the "update before exiting" half of the pattern). Creates the
   * journal first if missing. origin:'user' — internal bookkeeping.
   *
   * @param {Object} input
   * @param {string} input.workspace
   * @param {string} input.entry
   */
  const logProgress = async ({ workspace, entry }) => {
    const { doc } = await ensureInitializer({ workspace });
    const body = appendProgress(doc.body, entry, new Date(now()).toISOString());
    return writeWithConfirm({ scope: initializerScope(workspace), body, origin: 'user' });
  };

  return {
    readScope, readSubtree, loadAlwaysLoaded,
    proposeWrite, commitWrite, writeWithConfirm, deleteScope,
    exportAll, importAll, deleteAll,
    readInitializer, ensureInitializer, logProgress,
  };
};
