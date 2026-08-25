// @ts-check
const SESSION_STORE = 'sessions';
const MESSAGE_STORE = 'session_messages';

/** @param {any} record @param {any[]|undefined} [messages] */
const present = (record, messages = undefined) => {
  if (!record) return undefined;
  const {
    msgIndex: _index,
    messagesV2: _v2,
    messages: _inline,
    latestNonSyntheticUserMessageId: _latest,
    ...metadata
  } = record;
  const value = { ...metadata, kind: metadata.kind ?? 'chat', depth: metadata.depth ?? 0 };
  return messages === undefined ? value : { ...value, messages };
};

/** @param {any} message */
const realUserMessage = (message) => message?.role === 'user'
  && message.synthetic !== true
  && typeof message.content === 'string'
  && message.content.trim().length > 0;

/**
 * @param {{
 *   get:(store:string,key:string)=>Promise<any>,
 *   getAll:(store:string)=>Promise<any[]>,
 *   getMany?:(store:string,keys:string[])=>Promise<any[]>,
 *   patch?:(store:string,key:string,fields:Record<string,unknown>)=>Promise<any|undefined>,
 * }} idb
 */
export const createKernelSessionReader = (idb) => {
  /** @param {any} record */
  const assemble = async (record) => {
    if (!record) return undefined;
    if (record.messagesV2 !== true) {
      return present(record, Array.isArray(record.messages) ? record.messages : []);
    }
    const ids = Array.isArray(record.msgIndex)
      ? record.msgIndex.filter((/** @type {unknown} */ id) => typeof id === 'string') : [];
    const rows = typeof idb.getMany === 'function'
      ? await idb.getMany(MESSAGE_STORE, ids)
      : await Promise.all(ids.map((/** @type {string} */ id) => idb.get(MESSAGE_STORE, id)));
    return present(record, rows.filter(Boolean).map((row) => row.message));
  };

  return Object.freeze({
    /** @param {string} sessionId */
    get: async (sessionId) => assemble(await idb.get(SESSION_STORE, sessionId)),
    /** @param {string} sessionId */
    getMetadata: async (sessionId) => present(await idb.get(SESSION_STORE, sessionId)),
    /** @param {string} sessionId @param {Record<string,unknown>} fields */
    updateMetadata: async (sessionId, fields) => {
      if (typeof idb.patch !== 'function') throw new Error('session-atomic-update-unavailable');
      return present(await idb.patch(SESSION_STORE, sessionId, fields));
    },
    list: async () => {
      const records = await idb.getAll(SESSION_STORE);
      if (!records.length) return [];
      const external = records.some((record) => record?.messagesV2 === true)
        ? await idb.getAll(MESSAGE_STORE) : [];
      /** @type {Map<string, Map<string, any>>} */
      const rowsBySession = new Map();
      for (const row of external) {
        if (!row || typeof row.sessionId !== 'string' || typeof row.id !== 'string') continue;
        const rows = rowsBySession.get(row.sessionId) ?? new Map();
        rows.set(row.id, row.message);
        rowsBySession.set(row.sessionId, rows);
      }
      const sessions = records.map((record) => {
        if (record?.messagesV2 !== true) {
          return present(record, Array.isArray(record?.messages) ? record.messages : []);
        }
        const rows = rowsBySession.get(record.sessionId) ?? new Map();
        const messages = (Array.isArray(record.msgIndex) ? record.msgIndex : [])
          .map((/** @type {string} */ id) => rows.get(id)).filter(Boolean);
        return present(record, messages);
      });
      return sessions.sort((left, right) => right.createdAt - left.createdAt);
    },
    hasChat: async () => {
      const records = await idb.getAll(SESSION_STORE);
      for (const record of records) {
        if ((record?.kind ?? 'chat') !== 'chat') continue;
        if (record?.messagesV2 !== true) {
          if ((Array.isArray(record?.messages) ? record.messages : []).some(realUserMessage)) return true;
          continue;
        }
        const latest = record.latestNonSyntheticUserMessageId;
        if (typeof latest !== 'string' || !latest) continue;
        if (realUserMessage((await idb.get(MESSAGE_STORE, latest))?.message)) return true;
      }
      return false;
    },
  });
};
