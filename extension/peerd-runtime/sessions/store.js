// @ts-check
// Session store — CRUD over the IDB session records + per-message store.
//
// Storage shape (v2): a session record holds METADATA only — provider,
// model, title, cost, permission, the rolling trim summary, and `msgIndex`,
// the ordered list of its message ids. The MESSAGES themselves live one
// record each in the `session_messages` store, keyed by the message's own
// (globally-unique uuidv7) id. `get`/`list` reassemble the classic
// `Session.messages` array, so every READER is unchanged.
//
// why per-message records (the v1 → v2 change): v1 stored the whole
// `messages` array inline on the session blob, so EVERY streaming text/
// reasoning delta rewrote the entire session — all prior messages included —
// back to disk. On a long session that's an O(n) write per token, and two
// in-flight writers (a delta patch racing a cost/summary update) could
// clobber each other's view of the array (last-writer-wins). v2 makes a
// delta a single-record patch (`updateAssistantMessage` touches ONE message
// record, never the session blob), which kills both the write amplification
// and the cross-field race — the session metadata and the messages live in
// different records now, so they can't stomp one another.
//
// Migration is lazy and forward-only (solo-dev convention: no migration
// scripts — convert on read). The first time a pre-v2 session is read
// through `get`, its inline messages are externalized and the record is
// rewritten in v2 shape. Idempotent; `list` reads both shapes but never
// writes (so opening the chat list can't trigger a write storm).
//
// The store is a factory taking the IDB wrapper (egress.idb in prod, a mock
// in tests). It does NOT take vault — sessions themselves are not encrypted
// at rest in V1. Secrets that DO need encryption (API keys) live in the
// vault separately. The session payload contains the conversation text,
// which is local-only and protected by the same OS-level boundary as any
// other browser-extension storage.

import { uuidv7 } from '/shared/util.js';
import { SessionNotFoundError } from '../errors.js';
// why: the store persists ONE canonical manifest shape so every consumer
// (descriptor filter, exposure gate, subagent inheritance, UI chips)
// reads the same thing. Pure module — keeps this store bun-testable.
import { normalizeToolManifest } from '../tools/manifests.js';

const STORE = 'sessions';
// why a sibling store, not an index on `sessions`: each message is its own
// record keyed by its uuidv7 id, so a delta patch is a single-record put
// and assembly is a batched get of exactly the session's ids — no scan, no
// whole-array rewrite. The session record's `msgIndex` carries order.
const MSGS = 'session_messages';

/**
 * @typedef {import('./types.js').Session} Session
 * @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage
 */

/**
 * @param {Object} deps
 * @param {{
 *   get: (store: string, key: string) => Promise<any>,
 *   put: (store: string, value: any) => Promise<void>,
 *   getAll: (store: string) => Promise<any[]>,
 *   getMany?: (store: string, keys: string[]) => Promise<any[]>,
 * }} deps.idb  get/put/getAll over an IDB store (optionally getMany for a
 *   batched assembly read — falls back to per-id get when absent, so simpler
 *   test fakes still work). why any-valued: records are untyped IDB blobs.
 * @param {() => number} [deps.now]              injectable clock
 * @param {() => string} [deps.makeId]           injectable id generator
 */
export const createSessionStore = ({ idb, now = Date.now, makeId }) => {
  const generateId = makeId ?? (() => uuidv7(now));

  // ---- message-record helpers -------------------------------------------

  // why a stable fallback id: every message the loop writes carries a
  // uuidv7 id, but a hand-crafted/legacy message might not — keying it by
  // `${sessionId}#${seq}` keeps it addressable instead of colliding on
  // `undefined`.
  const messageKey = (/** @type {string} */ sessionId, /** @type {any} */ message, /** @type {number} */ seq) =>
    (typeof message?.id === 'string' && message.id) ? message.id : `${sessionId}#${seq}`;

  /** Batched read of message records by id, in the same order as `ids`.
   * @param {string[]} ids */
  const readMessages = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = typeof idb.getMany === 'function'
      ? await idb.getMany(MSGS, ids)
      : await Promise.all(ids.map((id) => idb.get(MSGS, id)));
    // Drop any holes (a record that somehow went missing) rather than
    // surfacing `undefined` into the messages array — a missing message is
    // recoverable degradation; a malformed array is not.
    return rows.filter(Boolean).map((/** @type {any} */ row) => row.message);
  };

  // why: default the subagent fields at read time rather than migrating.
  // Sessions written before subagents landed have no kind/depth, so we
  // backfill the defaults here so every consumer sees a consistent shape.
  const withKindDefaults = (/** @type {any} */ record) => {
    if (record.kind !== undefined && record.depth !== undefined) return record;
    return { ...record, kind: record.kind ?? 'chat', depth: record.depth ?? 0 };
  };

  // Strip the v2 internals (msgIndex / messagesV2) and attach the assembled
  // `messages` array, so callers see the classic Session shape.
  const present = (/** @type {any} */ record, /** @type {any[]} */ messages) => {
    const { msgIndex: _i, messagesV2: _v, messages: _m, ...rest } = record;
    return withKindDefaults({ ...rest, messages });
  };

  // Externalize a pre-v2 record's inline messages into the message store and
  // rewrite it in v2 shape. Idempotent; a no-op once `messagesV2` is set.
  const migrate = async (/** @type {any} */ record) => {
    if (record.messagesV2) return record;
    const inline = Array.isArray(record.messages) ? record.messages : [];
    const msgIndex = [];
    for (let seq = 0; seq < inline.length; seq++) {
      const message = inline[seq];
      const id = messageKey(record.sessionId, message, seq);
      await idb.put(MSGS, { id, sessionId: record.sessionId, seq, message });
      msgIndex.push(id);
    }
    const { messages: _drop, ...rest } = record;
    const migrated = { ...rest, msgIndex, messagesV2: true };
    await idb.put(STORE, migrated);
    return migrated;
  };

  // Internal: the raw v2 metadata record (migrating a legacy one on the
  // way through). Writers mutate THIS and re-put it — never the assembled
  // shape, so messages never get re-inlined onto the session blob.
  const getRecord = async (/** @type {string} */ sessionId) => {
    const raw = await idb.get(STORE, sessionId);
    if (!raw) return undefined;
    return raw.messagesV2 ? raw : migrate(raw);
  };

  const assemble = async (/** @type {any} */ record) => {
    if (!record) return undefined;
    const messages = record.messagesV2
      ? await readMessages(record.msgIndex)
      : (Array.isArray(record.messages) ? record.messages : []);
    return present(record, messages);
  };

  /**
   * Create and persist a fresh session record.
   *
   * @param {{
   *   provider?: string,
   *   model?: string,
   *   kind?: import('./types.js').SessionKind,
   *   parentSessionId?: string,
   *   task?: string,
   *   depth?: number,
   *   permissionMode?: string,
   *   confirmActions?: boolean,
   *   customSystemPrompt?: string,
   *   toolManifest?: import('../tools/manifests.js').ToolManifest | null,
   *   instanceId?: string,
   *   actorType?: 'webvm' | 'notebook' | 'app' | 'web',
   *   backing?: 'tab' | 'api',
   * }} [opts]
   * @returns {Promise<Session>}
   */
  const create = async ({
    provider = 'anthropic',
    model = 'claude-sonnet-4-6',
    kind = 'chat',
    parentSessionId,
    task,
    depth = 0,
    permissionMode,
    confirmActions,
    customSystemPrompt,
    toolManifest,
    instanceId,
    actorType,
    backing,
  } = {}) => {
    const normalizedManifest = normalizeToolManifest(toolManifest);
    const record = {
      sessionId: generateId(),
      createdAt: now(),
      provider,
      model,
      // v2: messages live in the message store; the record carries order.
      msgIndex: [],
      messagesV2: true,
      kind,
      depth,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(confirmActions !== undefined ? { confirmActions } : {}),
      ...(typeof customSystemPrompt === 'string' && customSystemPrompt.trim().length > 0
        ? { customSystemPrompt }
        : {}),
      ...(normalizedManifest ? { toolManifest: normalizedManifest } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(task ? { task } : {}),
      // DESIGN-17: an actor self-describes the instance it owns + its kind.
      ...(instanceId ? { instanceId } : {}),
      ...(actorType ? { actorType } : {}),
      // DESIGN-18: a web actor's backing — 'api' (fetch-only origin actor) vs the
      // default tab backing. MUST be persisted: every backing-aware branch (gate,
      // egress, prompt, no-tab) reads turnSession.backing, so dropping it here silently
      // makes an API actor behave as a tab actor.
      ...(backing ? { backing } : {}),
    };
    await idb.put(STORE, record);
    return present(record, []);
  };

  /** @returns {Promise<Session | undefined>} */
  const get = async (/** @type {string} */ sessionId) => assemble(await getRecord(sessionId));

  /**
   * @returns {Promise<Session[]>}
   * Read-only over BOTH shapes — never migrates (so listing the chats can't
   * trigger a write storm). v2 records are reassembled from a single
   * getAll of the message store, grouped by session.
   */
  const list = async () => {
    const records = await idb.getAll(STORE);
    if (records.length === 0) return [];
    const needsExternal = records.some((r) => r.messagesV2);
    /** @type {Map<string, any[]>} */
    const bySession = new Map();
    if (needsExternal) {
      const allMsgs = (await idb.getAll(MSGS)) ?? [];
      for (const row of allMsgs) {
        if (!row || typeof row.sessionId !== 'string') continue;
        const arr = bySession.get(row.sessionId) ?? [];
        arr.push(row);
        bySession.set(row.sessionId, arr);
      }
    }
    const out = records.map((record) => {
      if (!record.messagesV2) {
        return present(record, Array.isArray(record.messages) ? record.messages : []);
      }
      const rows = bySession.get(record.sessionId) ?? [];
      const byId = new Map(rows.map((row) => [row.id, row.message]));
      const messages = (record.msgIndex ?? [])
        .map((/** @type {string} */ id) => byId.get(id))
        .filter(Boolean);
      return present(record, messages);
    });
    // Stable order: newest first. UUIDv7 keys sort chronologically.
    return out.sort((a, b) => b.createdAt - a.createdAt);
  };

  const archive = async (/** @type {string} */ sessionId) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const updated = { ...record, archivedAt: now() };
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Metadata-only lookup of a live actor session by its self-description — used to
   * RECONNECT to a durable actor whose (ephemeral) routing binding was lost. The
   * DESIGN-18 case: an API actor after a browser restart — its accumulated memory is
   * durable on the session record, but the chrome.storage.session (chat,origin) binding
   * cleared, so without this the next address mints an empty actor and orphans the
   * memory. Scans ONLY the session metadata store (idb.getAll(STORE) — NO message
   * load), newest-first, skips archived, returns the sessionId or null.
   * @param {{ parentSessionId?: string, instanceId?: string, actorType?: string, backing?: string }} [q]
   * @returns {Promise<string | null>}
   */
  const findActorSession = async ({ parentSessionId, instanceId, actorType, backing } = {}) => {
    const records = await idb.getAll(STORE);
    const match = records
      .filter((r) => r && r.kind === 'actor' && !r.archivedAt
        && (parentSessionId === undefined || r.parentSessionId === parentSessionId)
        && (instanceId === undefined || r.instanceId === instanceId)
        && (actorType === undefined || r.actorType === actorType)
        && (backing === undefined || r.backing === backing))
      .sort((a, b) => b.createdAt - a.createdAt);
    return match.length ? match[0].sessionId : null;
  };

  /**
   * Append a message: write its own record, push its id to the session's
   * order index, persist the (small) session record. Auto-derives the title
   * from the first user message. Returns the assembled session.
   *
   * @param {string} sessionId
   * @param {InternalMessage} message
   */
  const appendMessage = async (sessionId, message) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const seq = record.msgIndex.length;
    const id = messageKey(sessionId, message, seq);
    await idb.put(MSGS, { id, sessionId, seq, message });
    const updated = { ...record, msgIndex: [...record.msgIndex, id] };
    if (!record.title && message.role === 'user' && typeof message.content === 'string') {
      const cleaned = message.content.replace(/\s+/g, ' ').trim();
      if (cleaned) updated.title = cleaned.slice(0, 60);
    }
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Patch the streaming assistant message in place (matched by id). This is
   * the per-delta hot path — it touches ONLY the one message record, never
   * the session blob, so a delta is an O(1) write regardless of session
   * length and can't race a cost/summary write on the session record.
   *
   * Returns nothing: the loop ignores the return on this path (it re-reads
   * via get() at finalize), and assembling the full session per delta would
   * reintroduce an O(n) read on every token.
   *
   * @param {string} sessionId
   * @param {string} messageId
   * @param {Partial<InternalMessage>} patch
   */
  const updateAssistantMessage = async (sessionId, messageId, patch) => {
    // why no session-record read on this path: the assistant stub was
    // appended (and the session migrated) earlier this turn, so the message
    // record exists. A missing record means the id is stale — no-op rather
    // than resurrect it.
    const row = await idb.get(MSGS, messageId);
    if (!row) return;
    row.message = { ...row.message, ...patch };
    await idb.put(MSGS, row);
  };

  /**
   * Shallow-patch arbitrary top-level fields on a session and persist.
   * Used by the Plan/Act permission UI and session/setModel.
   *
   * @param {string} sessionId
   * @param {Record<string, unknown>} patch
   */
  const update = async (sessionId, patch) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const updated = { ...record, ...patch };
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Set or CLEAR the session's user-authored system-prompt augmentation
   * (the /system command). Non-empty string sets; null/''/whitespace
   * removes the field entirely (absent, not empty — the shared "unset"
   * shape every consumer keys on).
   *
   * @param {string} sessionId
   * @param {string | null | undefined} text
   */
  const setCustomSystemPrompt = async (sessionId, text) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const { customSystemPrompt: _removed, ...rest } = record;
    const updated = (typeof text === 'string' && text.trim().length > 0)
      ? { ...rest, customSystemPrompt: text }
      : rest;
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Set or CLEAR the session's tool exposure manifest (the /tools command).
   *
   * @param {string} sessionId
   * @param {import('../tools/manifests.js').ToolManifest | null | undefined} manifest
   */
  const setToolManifest = async (sessionId, manifest) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const { toolManifest: _removed, ...rest } = record;
    const normalized = normalizeToolManifest(manifest);
    const updated = normalized ? { ...rest, toolManifest: normalized } : rest;
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Persist the session's accumulated cost/usage tally (feature 06).
   * Touches only the session record — never the message store, so it can't
   * race a streaming-message patch.
   *
   * @param {string} sessionId
   * @param {import('../cost/accumulator.js').CostTally} cost
   */
  const setCost = async (sessionId, cost) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const updated = { ...record, cost };
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  /**
   * Persist the session's rolling trim-summary state.
   *
   * @param {string} sessionId
   * @param {import('../loop/rolling-summary.js').TrimSummaryState} state
   */
  const setTrimSummary = async (sessionId, state) => {
    const record = await getRecord(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const updated = { ...record, trimSummary: state };
    await idb.put(STORE, updated);
    return assemble(updated);
  };

  return Object.freeze({
    create,
    get,
    list,
    findActorSession,
    archive,
    appendMessage,
    updateAssistantMessage,
    update,
    setCustomSystemPrompt,
    setToolManifest,
    setCost,
    setTrimSummary,
  });
};
