// @ts-check
// Durable session primitives needed by one orchestrator turn. This module owns
// the v1 -> v2 record transition and the one per-session write queue; callers
// must not recreate either or metadata and message indexes can race.

const SESSIONS = 'sessions';
const MESSAGES = 'session_messages';

/**
 * @typedef {import('../peerd-runtime/sessions/types.js').Session} Session
 * @typedef {import('../peerd-provider/types.js').InternalMessage} InternalMessage
 */

/** @param {any} message */
const isRealUserMessage = (message) => message?.role === 'user'
  && message.synthetic !== true
  && typeof message.content === 'string'
  && message.content.trim().length > 0;

/**
 * @param {Object} deps
 * @param {{
 *   get:(store:string,key:string)=>Promise<any>,
 *   getMany?:(store:string,keys:string[])=>Promise<any[]>,
 *   mutate?:(store:string,key:string,transform:(current:any)=>any)=>Promise<any|undefined>,
 *   put:(store:string,value:any)=>Promise<void>,
 * }} deps.idb
 * @param {(sessionId:string)=>Error} deps.notFound
 * @param {(sessionId:string,message:any)=>Promise<void>|void} [deps.onMessageAppended]
 */
export const createSessionTurnStore = ({
  idb,
  notFound,
  onMessageAppended = async () => {},
}) => {
  /** @type {Map<string, Promise<unknown>>} */
  const sessionChains = new Map();
  const mutateRecord = async (/** @type {string} */ sessionId,
    /** @type {(record:any)=>any} */ transform) => {
    if (typeof idb.mutate === 'function') return idb.mutate(SESSIONS, sessionId, transform);
    const record = await idb.get(SESSIONS, sessionId);
    if (!record) return undefined;
    const updated = transform(record);
    await idb.put(SESSIONS, updated);
    return updated;
  };

  /**
   * Serialize every read-modify-write of one session record, including lazy
   * migration. Message-body patches need no session-record lock.
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = (sessionId, operation) => {
    const previous = sessionChains.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    sessionChains.set(sessionId, current);
    void current.finally(() => {
      if (sessionChains.get(sessionId) === current) sessionChains.delete(sessionId);
    }).catch(() => {});
    return current;
  };

  /** @param {string[]} ids @returns {Promise<InternalMessage[]>} */
  const readMessages = async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = typeof idb.getMany === 'function'
      ? await idb.getMany(MESSAGES, ids)
      : await Promise.all(ids.map((id) => idb.get(MESSAGES, id)));
    return rows.filter(Boolean).map((row) => row.message);
  };

  /** @param {any} record */
  const withKindDefaults = (record) => (
    record.kind !== undefined && record.depth !== undefined
      ? record : { ...record, kind: record.kind ?? 'chat', depth: record.depth ?? 0 }
  );

  /** @param {any} record @param {InternalMessage[]} messages @returns {Session} */
  const present = (record, messages) => {
    const {
      msgIndex: _index,
      messagesV2: _v2,
      messages: _inline,
      latestNonSyntheticUserMessageId: _latest,
      messageCount: _messageCount,
      lastMessageAt: _lastMessageAt,
      ...metadata
    } = record;
    return withKindDefaults({ ...metadata, messages });
  };

  /** @param {any} record @returns {Omit<Session, 'messages'>} */
  const presentMetadata = (record) => {
    const {
      msgIndex: _index,
      messagesV2: _v2,
      messages: _inline,
      latestNonSyntheticUserMessageId: _latest,
      messageCount: _messageCount,
      lastMessageAt: _lastMessageAt,
      ...metadata
    } = record;
    return withKindDefaults(metadata);
  };

  /** @param {string} sessionId @param {any} message @param {number} seq */
  const messageKey = (sessionId, message, seq) => (
    typeof message?.id === 'string' && message.id ? message.id : `${sessionId}#${seq}`
  );

  /** @param {any} record @returns {Promise<Session|undefined>} */
  const migrate = async (record) => {
    if (record.messagesV2) return record;
    const inline = Array.isArray(record.messages) ? record.messages : [];
    /** @type {string[]} */
    const msgIndex = [];
    for (let seq = 0; seq < inline.length; seq++) {
      const message = inline[seq];
      const id = messageKey(record.sessionId, message, seq);
      await idb.put(MESSAGES, { id, sessionId: record.sessionId, seq, message });
      msgIndex.push(id);
    }
    const migrated = await mutateRecord(record.sessionId, (current) => {
      if (current.messagesV2) return current;
      const { messages: _drop, ...metadata } = current;
      return {
        ...metadata, msgIndex, messagesV2: true, messageCount: inline.length,
        lastMessageAt: inline.at(-1)?.when ?? current.createdAt,
      };
    });
    return migrated;
  };

  /** @param {string} sessionId */
  const getRecord = async (sessionId) => {
    const record = await idb.get(SESSIONS, sessionId);
    return record?.messagesV2 ? record : record ? migrate(record) : undefined;
  };

  /** @param {any} record */
  const assemble = async (record) => {
    if (!record) return undefined;
    const messages = record.messagesV2
      ? await readMessages(Array.isArray(record.msgIndex) ? record.msgIndex : [])
      : (Array.isArray(record.messages) ? record.messages : []);
    return present(record, messages);
  };

  /**
   * @param {string} sessionId
   * @param {(record:any)=>any} transform
   * @returns {Promise<Session>}
   */
  const updateRecord = (sessionId, transform) => serialize(sessionId, async () => {
    const record = await getRecord(sessionId);
    if (!record) throw notFound(sessionId);
    const updated = await mutateRecord(sessionId, transform);
    if (!updated) throw notFound(sessionId);
    return /** @type {Promise<Session>} */ (assemble(updated));
  });

  /** @param {string} sessionId @returns {Promise<Session|undefined>} */
  const get = (sessionId) => serialize(
    sessionId,
    async () => assemble(await getRecord(sessionId)),
  );

  /**
   * @param {string} sessionId
   * @param {InternalMessage} message
   * @returns {Promise<Session>}
   */
  const appendMessage = (sessionId, message) => serialize(sessionId, async () => {
    const record = await getRecord(sessionId);
    if (!record) throw notFound(sessionId);
    const seq = record.msgIndex.length;
    const id = messageKey(sessionId, message, seq);
    if (record.msgIndex.includes(id)) {
      try { await onMessageAppended(sessionId, message); } catch {}
      return /** @type {Promise<Session>} */ (assemble(record));
    }
    await idb.put(MESSAGES, { id, sessionId, seq, message });
    const updated = await mutateRecord(sessionId, (current) => {
      if (current.msgIndex.includes(id)) return current;
      const next = {
        ...current,
        msgIndex: [...current.msgIndex, id],
        messageCount: Number.isSafeInteger(current.messageCount) && current.messageCount >= 0
          ? current.messageCount + 1 : current.msgIndex.length + 1,
        lastMessageAt: message?.when ?? current.lastMessageAt ?? current.createdAt,
        ...(isRealUserMessage(message) ? { latestNonSyntheticUserMessageId: id } : {}),
      };
      if (!current.title && message.role === 'user' && typeof message.content === 'string') {
        const title = message.content.replace(/\s+/g, ' ').trim();
        if (title) next.title = title.slice(0, 60);
      }
      return next;
    });
    if (!updated) throw notFound(sessionId);
    try { await onMessageAppended(sessionId, message); } catch {}
    return /** @type {Promise<Session>} */ (assemble(updated));
  });

  /**
   * @param {string} _sessionId
   * @param {string} messageId
   * @param {Partial<InternalMessage>} patch
   */
  const updateAssistantMessage = async (_sessionId, messageId, patch) => {
    const row = await idb.get(MESSAGES, messageId);
    if (!row) return;
    await idb.put(MESSAGES, { ...row, message: { ...row.message, ...patch } });
  };

  /** @param {string} sessionId @param {any} state */
  const setTrimSummary = (sessionId, state) => updateRecord(
    sessionId,
    (record) => ({ ...record, trimSummary: state }),
  );

  return Object.freeze({
    get,
    appendMessage,
    updateAssistantMessage,
    setTrimSummary,
    // The legacy facade uses these record mechanics too, so all metadata
    // writers share this module's queue and migration rather than racing it.
    records: Object.freeze({
      serialize,
      update: updateRecord,
      assemble,
      readMessages,
      present,
      presentMetadata,
      isRealUserMessage,
    }),
  });
};
