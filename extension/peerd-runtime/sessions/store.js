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
import { createSessionTurnStore } from '/shared/session-turn-store.js';
import { SessionNotFoundError } from '../errors.js';
// why: the store persists ONE canonical manifest shape so every consumer
// (descriptor filter, exposure gate, actor inheritance, UI chips)
// reads the same thing. Pure module — keeps this store bun-testable.
import { normalizeToolManifest } from '../tools/manifests.js';
import { controllerDomainOperationPolicy } from '/shared/controller-kernel-quota.js';

const STORE = 'sessions';
// why a sibling store, not an index on `sessions`: each message is its own
// record keyed by its uuidv7 id, so a delta patch is a single-record put
// and assembly is a batched get of exactly the session's ids — no scan, no
// whole-array rewrite. The session record's `msgIndex` carries order.
const MSGS = 'session_messages';
const MAX_GRANTED_OPERATIONS = 256;
const MUTABLE_SESSION_FIELDS = new Set([
  'provider', 'model', 'permissionMode', 'confirmActions', 'originState',
  'cost', 'todos', 'autoMemory', 'routineId',
]);

const normalizeGrantedOperations = (/** @type {unknown} */ value) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_GRANTED_OPERATIONS) {
    throw new TypeError('session-granted-operations-invalid');
  }
  const operations = value.map((operation) => {
    if (typeof operation !== 'string' || !controllerDomainOperationPolicy(operation)) {
      throw new TypeError('session-granted-operation-invalid');
    }
    return operation;
  });
  if (new Set(operations).size !== operations.length) {
    throw new TypeError('session-granted-operation-duplicate');
  }
  return Object.freeze([...operations]);
};

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
 * @param {(sessionId: string, message: InternalMessage) => Promise<void>|void} [deps.onMessageAppended]
 *   post-commit hook. Runs only after the message row and session index are
 *   durable. A hook failure cannot roll back or fail an already-committed append.
 */
export const createSessionStore = ({ idb, now = Date.now, makeId, onMessageAppended = async () => {} }) => {
  const generateId = makeId ?? (() => uuidv7(now));
  const turnSessions = createSessionTurnStore({
    idb,
    notFound: (sessionId) => new SessionNotFoundError(sessionId),
    onMessageAppended,
  });
  // why property access, not destructuring: Bun 1.4's transpiler miscompiles
  // free variables captured through this factory's multiply nested async
  // closures (a destructured `readMessages` arrived undefined inside
  // importPortable's serialized closure). Reading through the stable
  // `records` object sidesteps the broken capture path and keeps the same
  // shared queue + migration semantics.
  const turnRecords = turnSessions.records;
  const serializeSession = turnRecords.serialize;
  const updateSessionRecord = turnRecords.update;

  /**
   * Create and persist a fresh session record.
   *
   * @param {{
   *   provider?: string,
   *   model?: string,
   *   kind?: import('./types.js').SessionKind,
   *   parentSessionId?: string,
   *   spawnedTrusted?: boolean,
   *   task?: string,
   *   grantedOperations?: string[],
   *   depth?: number,
   *   permissionMode?: string,
   *   confirmActions?: boolean,
   *   customSystemPrompt?: string,
   *   appManifestDigest?: string,
   *   appOwnerAuthorityDigest?: string,
   *   ownerSemanticPostureDigest?: string,
   *   appRole?: {source:'local'|'unsigned-import'|'dweb', publisher:string, manifestDigest:string, name?:string, instructions?:string},
   *   actorSurface?: 'code',
   *   toolManifest?: import('../tools/manifests.js').ToolManifest | null,
   *   instanceId?: string,
   *   actorType?: 'webvm' | 'notebook' | 'pod' | 'app' | 'web' | 'dweb',
   *   backing?: 'tab' | 'api',
   *   originState?: import('../actor/origin-lock.js').ActorOriginState,
   * }} [opts]
   * @returns {Promise<Session>}
   */
  const create = async ({
    provider = 'anthropic',
    model = 'claude-sonnet-4-6',
    kind = 'chat',
    parentSessionId,
    spawnedTrusted,
    task,
    grantedOperations,
    depth = 0,
    permissionMode,
    confirmActions,
    customSystemPrompt,
    appManifestDigest,
    appOwnerAuthorityDigest,
    ownerSemanticPostureDigest,
    appRole,
    actorSurface,
    toolManifest,
    instanceId,
    actorType,
    backing,
    originState,
  } = {}) => {
    const normalizedGrantedOperations = normalizeGrantedOperations(grantedOperations);
    if (normalizedGrantedOperations !== undefined && kind !== 'spawned') {
      throw new TypeError('session-granted-operations-kind-invalid');
    }
    const normalizedManifest = normalizeToolManifest(toolManifest);
    const createdAt = now();
    const record = {
      sessionId: generateId(),
      createdAt,
      provider,
      model,
      // v2: messages live in the message store; the record carries order.
      msgIndex: [],
      messagesV2: true,
      latestNonSyntheticUserMessageId: null,
      messageCount: 0,
      lastMessageAt: createdAt,
      kind,
      depth,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(confirmActions !== undefined ? { confirmActions } : {}),
      ...(typeof customSystemPrompt === 'string' && customSystemPrompt.trim().length > 0
        ? { customSystemPrompt }
        : {}),
      ...(typeof appManifestDigest === 'string' && /^[0-9a-f]{64}$/.test(appManifestDigest)
        ? { appManifestDigest }
        : {}),
      ...(typeof appOwnerAuthorityDigest === 'string' && /^[0-9a-f]{64}$/.test(appOwnerAuthorityDigest)
        ? { appOwnerAuthorityDigest }
        : {}),
      ...(typeof ownerSemanticPostureDigest === 'string' && /^[0-9a-f]{64}$/.test(ownerSemanticPostureDigest)
        ? { ownerSemanticPostureDigest }
        : {}),
      ...(appRole && typeof appRole === 'object'
          && (appRole.source === 'local' || appRole.source === 'unsigned-import' || appRole.source === 'dweb')
          && typeof appRole.publisher === 'string'
          && typeof appRole.manifestDigest === 'string'
          && /^[0-9a-f]{64}$/.test(appRole.manifestDigest)
        ? { appRole: {
          source: appRole.source,
          publisher: appRole.publisher.slice(0, 512),
          manifestDigest: appRole.manifestDigest,
          ...(typeof appRole.name === 'string' ? { name: appRole.name.slice(0, 80) } : {}),
          ...(typeof appRole.instructions === 'string' ? { instructions: appRole.instructions.slice(0, 12_000) } : {}),
        } }
        : {}),
      ...(actorType === 'app' && actorSurface === 'code' ? { actorSurface: 'code' } : {}),
      ...(normalizedManifest ? { toolManifest: normalizedManifest } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      // Trusted-lineage hop verdict (actor/delegation-lineage.js): stamped by
      // spawn.js from the SPAWNING turn's inbound flag, server-side — the model
      // never supplies it. Persisted only when explicitly passed, so roots stay
      // absent (getAncestry treats an unparented record as trusted).
      ...(spawnedTrusted !== undefined ? { spawnedTrusted } : {}),
      ...(task ? { task } : {}),
      ...(normalizedGrantedOperations && normalizedGrantedOperations.length > 0
        ? { grantedOperations: normalizedGrantedOperations } : {}),
      // DESIGN-17: an actor self-describes the instance it owns + its kind.
      ...(instanceId ? { instanceId } : {}),
      ...(actorType ? { actorType } : {}),
      // DESIGN-18: a web actor's backing — 'api' (fetch-only origin actor) vs the
      // default tab backing. MUST be persisted: every backing-aware branch (gate,
      // egress, prompt, no-tab) reads turnSession.backing, so dropping it here silently
      // makes an API actor behave as a tab actor.
      ...(backing ? { backing } : {}),
      // issue 251: a tab-backed web actor's origin authority — its mode, the
      // origin it owns, and its excursion counters. MUST be persisted, for the
      // same reason as `backing` above: a service worker eviction mid-task would
      // otherwise hand the next turn an actor with no owned origin and a fresh
      // excursion budget, which is a bound actor silently becoming unbounded.
      // Absent on every kind that has no tab to land anywhere.
      ...(originState && typeof originState === 'object' ? { originState } : {}),
    };
    await idb.put(STORE, record);
    return turnRecords.present(record, []);
  };

  // Same-user transfer imports an existing conversation identity rather
  // than creating a fresh empty chat. Keep this path deliberately narrower
  // than create/update: a peer may supply durable conversation content, but
  // never actor lineage, tool authority, live trim/prewalk state, or other
  // device-local bookkeeping.
  const PORTABLE_MESSAGE_FIELDS = Object.freeze([
    'role', 'content', 'toolUses', 'toolResults', 'model', 'provider',
    'error', 'stopReason', 'synthetic', 'when', 'generation',
  ]);

  /** @param {any} value @param {readonly string[]} fields */
  const pickPortable = (value, fields) => Object.fromEntries(
    fields.filter((field) => value?.[field] !== undefined)
      .map((field) => [field, value[field]]),
  );

  /**
   * Import one portable top-level chat under its original session id.
   *
   * Message ids are re-keyed into a session namespace. The message store is
   * global, so trusting a remote message id would let a compromised old
   * self-device overwrite a row belonging to an unrelated local chat. The
   * metadata record is committed last: interruption can leave harmless
   * orphan rows, while retry deterministically resumes and can never expose
   * a half-imported conversation.
   *
   * @param {any} portable
   * @returns {Promise<Session>}
   */
  const importPortable = async (portable) => {
    const sessionId = typeof portable?.sessionId === 'string' ? portable.sessionId.trim() : '';
    if (!sessionId) throw new TypeError('portable sessionId is required');

    return serializeSession(sessionId, async () => {
      const existing = await idb.get(STORE, sessionId);
      if (existing) return /** @type {Session} */ (await turnRecords.assemble(existing));

      const sourceMessages = Array.isArray(portable.messages) ? portable.messages : [];
      /** @type {string[]} */
      const msgIndex = [];
      let latestNonSyntheticUserMessageId = null;
      let lastMessageAt;
      for (let seq = 0; seq < sourceMessages.length; seq++) {
        const source = sourceMessages[seq];
        if (!source || typeof source !== 'object') continue;

        // Collision resolution is deterministic across a retry: rows already
        // written for this import are reusable; rows owned by another session
        // force the same monotonically numbered suffix on every attempt.
        const base = `selfsync:${sessionId}:${seq}`;
        let id = base;
        for (let suffix = 1; ; suffix++) {
          const occupied = await idb.get(MSGS, id);
          if (!occupied || occupied.sessionId === sessionId) break;
          id = `${base}:${suffix}`;
        }
        const message = /** @type {any} */ ({ ...pickPortable(source, PORTABLE_MESSAGE_FIELDS), id });
        await idb.put(MSGS, { id, sessionId, seq: msgIndex.length, message });
        msgIndex.push(id);
        if (Number.isFinite(message.when)) lastMessageAt = message.when;
        if (turnRecords.isRealUserMessage(message)) latestNonSyntheticUserMessageId = id;
      }

      const record = {
        sessionId,
        createdAt: Number.isFinite(portable.createdAt) ? portable.createdAt : now(),
        provider: typeof portable.provider === 'string' && portable.provider
          ? portable.provider : 'anthropic',
        model: typeof portable.model === 'string' && portable.model
          ? portable.model : 'claude-sonnet-4-6',
        kind: 'chat',
        depth: 0,
        msgIndex,
        messagesV2: true,
        latestNonSyntheticUserMessageId,
        messageCount: msgIndex.length,
        lastMessageAt: lastMessageAt
          ?? (Number.isFinite(portable.createdAt) ? portable.createdAt : now()),
        ...(Number.isFinite(portable.archivedAt) ? { archivedAt: portable.archivedAt } : {}),
        ...(typeof portable.title === 'string' && portable.title ? { title: portable.title } : {}),
        ...(portable.cost && typeof portable.cost === 'object' ? { cost: portable.cost } : {}),
        ...(typeof portable.customSystemPrompt === 'string' && portable.customSystemPrompt.trim()
          ? { customSystemPrompt: portable.customSystemPrompt }
          : {}),
      };
      await idb.put(STORE, record);
      return turnRecords.present(record, await turnRecords.readMessages(msgIndex));
    });
  };

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
        return turnRecords.present(record, Array.isArray(record.messages) ? record.messages : []);
      }
      const rows = bySession.get(record.sessionId) ?? [];
      const byId = new Map(rows.map((row) => [row.id, row.message]));
      const messages = (record.msgIndex ?? [])
        .map((/** @type {string} */ id) => byId.get(id))
        .filter(Boolean);
      return turnRecords.present(record, messages);
    });
    // Stable order: newest first. UUIDv7 keys sort chronologically.
    return out.sort((a, b) => b.createdAt - a.createdAt);
  };

  /**
   * List session records without reading the per-message store or assembling
   * message bodies. Unlike `list()`, this touches only the session-record
   * store, making it suitable for chat lists and other coarse discovery.
   * Read-only over legacy and v2 shapes; never migrates.
   * @returns {Promise<Array<Omit<Session, 'messages'>>>}
   */
  const listMetadata = async () => {
    const records = await idb.getAll(STORE);
    return records
      .map(turnRecords.presentMetadata)
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  /**
   * Targeted metadata lookup for lifecycle monitors that already know the
   * session id. It never migrates a legacy record or touches message rows.
   * @param {string} sessionId
   * @returns {Promise<Omit<Session, 'messages'> | undefined>}
   */
  const getMetadata = async (sessionId) => {
    const record = await idb.get(STORE, sessionId);
    return record ? turnRecords.presentMetadata(record) : undefined;
  };

  /**
   * Resolve the one metadata-pinned real user request needed by the actor
   * monitor. New records maintain the pointer on append, making every refresh
   * constant-time without transcript assembly or compatibility scans.
   * @param {string} sessionId
   * @returns {Promise<InternalMessage | undefined>}
   */
  const getLatestNonSyntheticUserMessage = async (sessionId) => {
    const record = await idb.get(STORE, sessionId);
    if (!record) return undefined;
    const messageId = record.latestNonSyntheticUserMessageId;
    if (typeof messageId !== 'string' || !messageId) return undefined;
    const message = (await idb.get(MSGS, messageId))?.message;
    return turnRecords.isRealUserMessage(message) ? message : undefined;
  };

  const archive = (/** @type {string} */ sessionId) => updateSessionRecord(
    sessionId,
    (record) => ({ ...record, archivedAt: now() }),
  );

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
   * Patch the deliberately mutable portion of a session record. Authority
   * identity, lineage, actor bindings and exact-operation grants are
   * create-once: accepting them here would turn an ordinary metadata write
   * into a durable privilege-escalation primitive.
   *
   * @param {string} sessionId
   * @param {Record<string, unknown>} patch
   */
  const update = (sessionId, patch) => updateSessionRecord(
    sessionId,
    (record) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
          || Object.keys(patch).some((field) => !MUTABLE_SESSION_FIELDS.has(field))) {
        throw new TypeError('session-update-field-invalid');
      }
      return { ...record, ...patch };
    },
  );

  /**
   * Set or CLEAR the session's user-authored system-prompt augmentation
   * (the /system command). Non-empty string sets; null/''/whitespace
   * removes the field entirely (absent, not empty — the shared "unset"
   * shape every consumer keys on).
   *
   * @param {string} sessionId
   * @param {string | null | undefined} text
   */
  const setCustomSystemPrompt = (sessionId, text) => updateSessionRecord(sessionId, (record) => {
    const { customSystemPrompt: _removed, ...rest } = record;
    return (typeof text === 'string' && text.trim().length > 0)
      ? { ...rest, customSystemPrompt: text }
      : rest;
  });

  /**
   * Set or CLEAR the session's tool exposure manifest (the /tools command).
   *
   * @param {string} sessionId
   * @param {import('../tools/manifests.js').ToolManifest | null | undefined} manifest
   */
  const setToolManifest = (sessionId, manifest) => updateSessionRecord(sessionId, (record) => {
    const { toolManifest: _removed, ...rest } = record;
    const normalized = normalizeToolManifest(manifest);
    return normalized ? { ...rest, toolManifest: normalized } : rest;
  });

  /**
   * Persist the session's accumulated cost/usage tally (feature 06).
   * Touches only the session record — never the message store, so it can't
   * race a streaming-message patch.
   *
   * @param {string} sessionId
   * @param {import('../cost/accumulator.js').CostTally} cost
   */
  const setCost = (sessionId, cost) => updateSessionRecord(
    sessionId,
    (record) => ({ ...record, cost }),
  );

  /**
   * Set or CLEAR the session's prewalk state (loop/prewalk.js). null removes
   * the field entirely (absent = "no prewalk", the shape every consumer keys
   * on) — a generic update() spread can't unset a key, hence this setter.
   * Optionally restores the planner provider/model in the SAME write, so a
   * run-end restore can't be torn by a crash between two writes.
   *
   * @param {string} sessionId
   * @param {import('../loop/prewalk.js').PrewalkState | null} state
   * @param {{ provider?: string, model?: string }} [modelPatch]
   */
  const setPrewalk = (sessionId, state, modelPatch) => updateSessionRecord(sessionId, (record) => {
    const { prewalk: _removed, ...rest } = record;
    return {
      ...rest,
      ...(modelPatch ?? {}),
      ...(state ? { prewalk: state } : {}),
    };
  });

  return Object.freeze({
    create,
    importPortable,
    get: turnSessions.get,
    list,
    listMetadata,
    getMetadata,
    getLatestNonSyntheticUserMessage,
    findActorSession,
    archive,
    appendMessage: turnSessions.appendMessage,
    updateAssistantMessage: turnSessions.updateAssistantMessage,
    update,
    setCustomSystemPrompt,
    setToolManifest,
    setCost,
    setPrewalk,
    setTrimSummary: turnSessions.setTrimSummary,
  });
};
