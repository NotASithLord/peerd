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
 * Allocate an owner for a user-opened App without requiring a model call or key.
 * Existing claims remain exact: an invalid claim must never mint a replacement.
 * @param {{current:()=>Promise<string|null>, resolve:(id:string)=>Promise<string|null>,
 * create:()=>Promise<{sessionId:string}>, bind:(session:{sessionId:string})=>Promise<void>}} deps
 */
export const createAppLaunchOwner = ({ current, resolve, create, bind }) => {
  /** @type {Promise<string>|null} */
  let pending = null;
  const requireRoot = async (/** @type {string} */ claim) => {
    const root = await resolve(claim);
    if (typeof root !== 'string' || !root) throw new Error('app-owner-unavailable');
    return root;
  };
  return async (/** @type {string|null} */ claim) => {
    if (claim !== null) return requireRoot(claim);
    // why: simultaneous first opens share one durable chat owner. Failure is
    // propagated to every waiter and never authorizes an ownerless tab.
    if (!pending) {
      pending = (async () => {
        const existing = await current();
        if (existing) return requireRoot(existing);
        const session = await create();
        await bind(session);
        return requireRoot(session.sessionId);
      })().finally(() => { pending = null; });
    }
    return pending;
  };
};
