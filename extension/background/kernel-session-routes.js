// @ts-check

export const kernelToolManifestLabel = (/** @type {unknown} */ value) => {
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

/** @param {any} deps */
export const makeKernelSessionRoutes = ({
  vault, sessions, contextSnapshots, ready = Promise.resolve(), sessionCache, auditLog,
  resolvePermission = (/** @type {any} */ session, /** @type {any} */ mode,
    /** @type {any} */ confirm) => ({
    mode: (session?.permissionMode ?? mode) === 'act' ? 'act' : 'plan',
    confirmActions: session?.confirmActions ?? (confirm !== false),
  }), pushState,
}) => Object.freeze({
  'session/list': async () => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    const all = await sessions.list();
    return {
      ok: true,
      sessions: all.filter((/** @type {any} */ session) => {
        const kind = session.kind ?? 'chat';
        return kind !== 'spawned' && kind !== 'actor';
      }).map((/** @type {any} */ session) => ({
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
    return { ok: true, snapshots: contextSnapshots?.snapshotsFor(sessionId) ?? [] };
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
    if (mode === undefined && confirmActions === undefined) {
      return { ok: false, error: 'no-mode-or-confirm' };
    }
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
        if (typeof sessions.updateMetadata !== 'function') {
          throw new Error('session-atomic-update-unavailable');
        }
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
