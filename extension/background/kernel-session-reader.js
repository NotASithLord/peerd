// @ts-check
const SESSION_STORE = 'sessions';
const MESSAGE_STORE = 'session_messages';
const MUTABLE_METADATA_FIELDS = new Set([
  'provider', 'model', 'permissionMode', 'confirmActions', 'cost',
]);

/** @param {any} record @param {any[]|undefined} [messages] */
const present = (record, messages = undefined) => {
  if (!record) return undefined;
  const {
    msgIndex: _index,
    messagesV2: _v2,
    messages: _inline,
    latestNonSyntheticUserMessageId: _latest,
    messageCount: _messageCount,
    lastMessageAt: _lastMessageAt,
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
 *   mutate?:(store:string,key:string,transform:(current:any)=>any)=>Promise<any|undefined>,
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
    return present(record, rows.flatMap((row, index) => row?.id === ids[index]
        && row.sessionId === record.sessionId ? [row.message] : []));
  };

  return Object.freeze({
    /** @param {string} sessionId */
    get: async (sessionId) => assemble(await idb.get(SESSION_STORE, sessionId)),
    /** @param {string} sessionId */
    getMetadata: async (sessionId) => present(await idb.get(SESSION_STORE, sessionId)),
    /** @param {string} sessionId @param {Record<string,unknown>} fields */
    updateMetadata: async (sessionId, fields) => {
      if (typeof idb.patch !== 'function') throw new Error('session-atomic-update-unavailable');
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)
          || Object.keys(fields).some((field) => !MUTABLE_METADATA_FIELDS.has(field))) {
        throw new TypeError('kernel-session-update-field-invalid');
      }
      return present(await idb.patch(SESSION_STORE, sessionId, fields));
    },
    listMetadata: async () => (await idb.getAll(SESSION_STORE))
      .map((record) => present(record))
      .sort((left, right) => right.createdAt - left.createdAt),
    listSummaries: async () => {
      const records = (await idb.getAll(SESSION_STORE))
        .filter((record) => (record?.kind ?? 'chat') === 'chat');
      const legacyV2 = records.filter((record) => record?.messagesV2 === true
        && (!Number.isSafeInteger(record.messageCount) || record.messageCount < 0
          || !Number.isFinite(record.lastMessageAt)));
      const refs = legacyV2.flatMap((record) => (
        Array.isArray(record.msgIndex) ? record.msgIndex : []
      ).flatMap((/** @type {unknown} */ id) => typeof id === 'string'
        ? [{ record, id }] : []));
      const keys = refs.map(({ id }) => id);
      const rows = keys.length === 0 ? [] : typeof idb.getMany === 'function'
        ? await idb.getMany(MESSAGE_STORE, keys)
        : await Promise.all(keys.map((key) => idb.get(MESSAGE_STORE, key)));
      /** @type {Map<string,{count:number,last:any}>} */
      const legacyStats = new Map(legacyV2.map((record) => [
        record.sessionId, { count: 0, last: undefined },
      ]));
      for (const [index, { record, id }] of refs.entries()) {
        const row = rows[index];
        if (row?.id !== id || row.sessionId !== record.sessionId) continue;
        const stats = legacyStats.get(record.sessionId);
        if (!stats) continue;
        stats.count += 1;
        stats.last = row.message;
      }
      if (typeof idb.mutate === 'function') await Promise.allSettled(legacyV2.map((record) => {
        const expected = (Array.isArray(record.msgIndex) ? record.msgIndex : [])
          .filter((/** @type {unknown} */ id) => typeof id === 'string');
        const stats = legacyStats.get(record.sessionId);
        return idb.mutate?.(SESSION_STORE, record.sessionId, (current) => {
          if (Number.isSafeInteger(current.messageCount) && current.messageCount >= 0
              && Number.isFinite(current.lastMessageAt)) return current;
          const currentIds = (Array.isArray(current.msgIndex) ? current.msgIndex : [])
            .filter((/** @type {unknown} */ id) => typeof id === 'string');
          if (currentIds.length !== expected.length
              || currentIds.some((/** @type {string} */ id,
                /** @type {number} */ index) => id !== expected[index])) {
            return current;
          }
          const lastWhen = stats?.last?.when;
          return {
            ...current,
            messageCount: stats?.count ?? 0,
            lastMessageAt: Number.isFinite(lastWhen)
              ? lastWhen : Number.isFinite(current.createdAt) ? current.createdAt : 0,
          };
        });
      }));
      const summaries = records.map((record) => {
        const inline = record?.messagesV2 === true
          ? [] : Array.isArray(record?.messages) ? record.messages : [];
        const stats = legacyStats.get(record?.sessionId);
        const last = stats?.last ?? inline.at(-1);
        const summarized = Number.isSafeInteger(record?.messageCount)
          && record.messageCount >= 0 && Number.isFinite(record?.lastMessageAt);
        return {
          kind: record?.kind ?? 'chat',
          sessionId: record?.sessionId,
          title: record?.title ?? null,
          createdAt: record?.createdAt,
          lastMessageAt: summarized ? record.lastMessageAt : last?.when ?? record?.createdAt,
          messageCount: summarized ? record.messageCount
            : record?.messagesV2 === true ? stats?.count ?? 0 : inline.length,
          archivedAt: record?.archivedAt,
          provider: record?.provider,
          model: record?.model,
          hasCustomSystemPrompt: typeof record?.customSystemPrompt === 'string'
            && record.customSystemPrompt.length > 0,
          toolManifest: record?.toolManifest,
        };
      });
      return summaries.sort((left, right) => right.createdAt - left.createdAt);
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
