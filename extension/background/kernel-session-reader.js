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

/** @param {unknown} value */
export const kernelToolManifestLabel = (value) => {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'custom (0 tools)';
  const raw = /** @type {{preset?:unknown,allow?:unknown}} */ (value);
  const preset = typeof raw.preset === 'string' && raw.preset.trim()
    ? raw.preset.trim() : null;
  const allow = Array.isArray(raw.allow)
    ? raw.allow.filter((name) => typeof name === 'string' && name.length > 0)
    : null;
  if (preset) return `${preset}${allow?.length ? ` +${allow.length}` : ''}`;
  const count = allow?.length ?? 0;
  return `custom (${count} tool${count === 1 ? '' : 's'})`;
};

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

/** @param {{
 *   vault:{isLocked:()=>boolean},
 *   sessions:{get:(id:string)=>Promise<any>,list:()=>Promise<any[]>,
 *     updateMetadata?:(id:string,fields:Record<string,unknown>)=>Promise<any>},
 *   ready?:Promise<unknown>,
 *   sessionCache?:{sessionGet:(key:string)=>Promise<any>,sessionSet?:(key:string,value:any)=>Promise<void>},
 *   auditLog?:{append:(event:any)=>Promise<any>},
 *   contextSnapshots?:{snapshotsFor:(id:string)=>any[]},
 *   resolvePermission?:(session:any,mode:unknown,confirm:unknown)=>{mode:string,confirmActions:boolean},
 *   pushState?:()=>Promise<any>|any,
 * }} deps */
export const makeKernelSessionRoutes = ({
  vault, sessions, contextSnapshots, ready = Promise.resolve(), sessionCache, auditLog,
  resolvePermission = (session, mode, confirm) => ({
    mode: (session?.permissionMode ?? mode) === 'act' ? 'act' : 'plan',
    confirmActions: session?.confirmActions ?? (confirm !== false),
  }), pushState,
}) => Object.freeze({
  'session/list': async () => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    const all = await sessions.list();
    return {
      ok: true,
      sessions: all.filter((session) => {
        const kind = session.kind ?? 'chat';
        return kind !== 'spawned' && kind !== 'actor';
      }).map((session) => ({
        sessionId: session.sessionId,
        title: session.title ?? null,
        createdAt: session.createdAt,
        lastMessageAt: session.messages[session.messages.length - 1]?.when
          ?? session.createdAt,
        messageCount: session.messages.length,
        archived: session.archivedAt !== undefined,
        provider: session.provider,
        model: session.model,
        hasCustomSystemPrompt: typeof session.customSystemPrompt === 'string'
          && session.customSystemPrompt.length > 0,
        toolManifestLabel: kernelToolManifestLabel(session.toolManifest),
      })),
    };
  },
  'session/get': async (/** @type {{sessionId?:unknown}} */ { sessionId } = {}) => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId-required' };
    }
    const session = await sessions.get(sessionId);
    return session ? { ok: true, session } : { ok: false, error: 'session-not-found' };
  },
  'session/contextSnapshots': async (
    /** @type {{sessionId?:unknown}} */ { sessionId } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId-required' };
    }
    return {
      ok: true,
      snapshots: contextSnapshots?.snapshotsFor(sessionId) ?? [],
    };
  },
  'session/setModel': async (
    /** @type {{sessionId?:unknown,model?:unknown}} */ { sessionId = null, model } = {},
  ) => {
    await ready;
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    const sid = typeof sessionId === 'string' && sessionId
      ? sessionId : await sessionCache?.sessionGet('currentSessionId');
    if (!sid) return { ok: false, error: 'no-session' };
    if (typeof model !== 'string' || !model.trim()) {
      return { ok: false, error: 'invalid-model' };
    }
    if (typeof sessions.updateMetadata !== 'function') {
      throw new Error('session-atomic-update-unavailable');
    }
    const next = model.trim().slice(0, 200);
    const updated = await sessions.updateMetadata(sid, { model: next });
    if (!updated) return { ok: false, error: 'session-not-found' };
    void auditLog?.append({
      type: 'session_model_changed', sessionId: sid, details: { model: next },
    }).catch(() => {});
    void Promise.resolve(pushState?.()).catch(() => {});
    return { ok: true, model: next };
  },
  'permission/set': async (
    /** @type {{mode?:unknown,confirmActions?:unknown}} */ { mode, confirmActions } = {},
  ) => {
    await ready;
    if (mode === undefined && confirmActions === undefined)
      return { ok: false, error: 'no-mode-or-confirm' };
    if (typeof sessionCache?.sessionSet !== 'function') {
      throw new Error('session-cache-write-unavailable');
    }
    const patch = /** @type {Record<string,'plan'|'act'|boolean>} */ ({});
    if (mode !== undefined) patch.permissionMode = mode === 'act' || mode === 'plan' ? mode : 'plan';
    if (confirmActions !== undefined) patch.confirmActions = confirmActions !== false;
    try {
      for (const [key, value] of /** @type {const} */ ([
        ['currentPermissionMode', patch.permissionMode],
        ['currentConfirmActions', patch.confirmActions],
      ])) {
        if (value === undefined) continue;
        await sessionCache.sessionSet(key, value);
      }
      const [sid, cachedMode, cachedConfirm] = await Promise.all([
        sessionCache.sessionGet('currentSessionId'),
        sessionCache.sessionGet('currentPermissionMode'),
        sessionCache.sessionGet('currentConfirmActions'),
      ]);
      let session;
      if (typeof sid === 'string' && sid && !vault.isLocked()) {
        if (typeof sessions.updateMetadata !== 'function')
          throw new Error('session-atomic-update-unavailable');
        session = await sessions.updateMetadata(sid, patch);
      }
      const permission = resolvePermission(session, cachedMode, cachedConfirm);
      void auditLog?.append({
        type: 'mode_changed', sessionId: typeof sid === 'string' ? sid : null,
        details: permission,
      }).catch(() => {});
      void Promise.resolve(pushState?.()).catch(() => {});
      return { ok: true, permission };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      Object.assign(error, { outcomeKnown: false, retryable: false });
      throw error;
    }
  },
});
