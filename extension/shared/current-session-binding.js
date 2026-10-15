// @ts-check
import { beginSessionAuthorityChange } from './session-authority-epoch.js';

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
  const finish = beginSessionAuthorityChange(sessionCache);
  try {
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
  } finally { finish(); }
};

/**
 * Resolve a durable owner without provider IO. Concurrent first launches share
 * creation; invalid existing claims never mint replacement authority.
 * @param {any} sessions
 * @param {any} cache
 */
export const createAppLaunchOwner = (sessions, cache) => {
  /** @type {Promise<any>|null} */
  let pending = null;
  return async (/** @type {string|null} */ claim) => {
    if (claim === null) {
      pending ??= (async () => {
        const current = await cache.sessionGet('currentSessionId');
        if (current) return current;
        const session = await sessions.create({
          permissionMode: DEFAULT_CHAT_PERMISSION.mode,
          confirmActions: DEFAULT_CHAT_PERMISSION.confirmActions,
        });
        await bindCurrentChat(cache, session);
        return session.sessionId;
      })().finally(() => { pending = null; });
      claim = await pending;
    }
    const root = await rootChatSession(sessions, claim);
    if (root) return root;
    throw new Error('app-owner-unavailable');
  };
};

/** @param {any} sessions @param {string|null} id */
export const rootChatSession = async (sessions, id) => {
  const seen = new Set();
  for (let depth = 0; id && depth < 32 && !seen.has(id); depth++) {
    seen.add(id);
    const session = await sessions.get(id);
    if (!session) return null;
    if (!session.parentSessionId) return id;
    id = session.parentSessionId;
  }
  return null;
};
