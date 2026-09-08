// @ts-check

export const DEFAULT_CHAT_PERMISSION = Object.freeze({
  mode: 'act', confirmActions: false,
});

/** @param {any} session */
export const durableChatPermission = (session) => {
  const storedConfirm = typeof session?.confirmActions === 'boolean'
    ? session.confirmActions
    : typeof session?.actTier === 'string' && session.actTier
      ? session.actTier !== 'full-auto' : DEFAULT_CHAT_PERMISSION.confirmActions;
  return Object.freeze({
    mode: session?.permissionMode === 'plan' ? 'plan' : DEFAULT_CHAT_PERMISSION.mode,
    confirmActions: storedConfirm,
  });
};

/**
 * Make the active-chat pointer visible only after its permission cache is
 * complete. Durable session fields remain authoritative; the cache exists for
 * the parentless new-chat projection and must never inherit the prior chat.
 * @param {{sessionSet:Function,sessionDelete:Function}} sessionCache
 * @param {any|null} session
 */
export const bindCurrentChat = async (sessionCache, session) => {
  const permission = session ? durableChatPermission(session) : DEFAULT_CHAT_PERMISSION;
  await Promise.all([
    sessionCache.sessionSet('currentPermissionMode', permission.mode),
    sessionCache.sessionSet('currentConfirmActions', permission.confirmActions),
  ]);
  if (typeof session?.sessionId === 'string' && session.sessionId) {
    await sessionCache.sessionSet('currentSessionId', session.sessionId);
  } else {
    await sessionCache.sessionDelete('currentSessionId');
  }
  return permission;
};
