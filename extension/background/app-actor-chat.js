// @ts-check
// Trusted App-tab human → bound App actor bridge.
//
// The sandbox cannot reach browser.runtime. Only the extension-owned parent
// shell can call this handler, and every call is re-pinned to its URL, live tab,
// owner root, and current manifest actor before one human-authored message is
// admitted. The actor reply returns to host UI as plain data; no provider or
// credential surface crosses into App code.

const DEFAULT_MESSAGE_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * @param {object} deps
 * @param {(sender: any) => boolean} deps.isTrustedSender
 * @param {{ parseIdFromUrl: (url?: string) => string|null, parseOwnerFromUrl: (url?: string) => string|null, getTabId: (appId:string) => number|null|undefined, getOwnedTabId: (appId:string, ownerRoot:string) => number|null|undefined }} deps.appTabTracker
 * @param {(appId:string, ownerSessionId:string) => Promise<string|null>} deps.ensureAppActorBinding
 * @param {{ get: (sessionId:string) => Promise<any> }} deps.sessions
 * @param {(req:any) => Promise<any>} deps.messageActor
 * @param {number} [deps.messageChars]
 * @param {number} [deps.timeoutMs]
 */
export const makeAppActorChatHandler = ({
  isTrustedSender,
  appTabTracker,
  ensureAppActorBinding,
  sessions,
  messageActor,
  messageChars = DEFAULT_MESSAGE_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => async (/** @type {any} */ msg, /** @type {any} */ sender) => {
  if (msg?.type !== 'app/actor-chat') return false;
  if (!isTrustedSender(sender)) return { ok: false, error: 'app_actor_chat_unauthorized' };

  const tabId = sender?.tab?.id;
  const tabUrl = sender?.tab?.url;
  const urlAppId = appTabTracker.parseIdFromUrl(tabUrl);
  const appId = typeof msg.appId === 'string' ? msg.appId : '';
  if (!appId || appId !== urlAppId || tabId == null || appTabTracker.getTabId(appId) !== tabId) {
    return { ok: false, error: 'app_actor_chat_tab_mismatch' };
  }
  const ownerClaim = appTabTracker.parseOwnerFromUrl(tabUrl);
  if (!ownerClaim) return { ok: false, error: 'app_actor_chat_owner_missing' };

  const prompt = typeof msg.message === 'string' ? msg.message.trim() : '';
  if (!prompt) return { ok: false, error: 'app_actor_chat_message_required' };
  if (prompt.length > messageChars) return { ok: false, error: 'app_actor_chat_message_too_large' };

  const actorSessionId = await ensureAppActorBinding(appId, ownerClaim).catch(() => null);
  if (!actorSessionId) return { ok: false, error: 'app_actor_chat_actor_unavailable' };
  const actor = await sessions.get(actorSessionId).catch(() => null);
  const ownerRoot = actor?.parentSessionId;
  if (typeof ownerRoot !== 'string'
      || appTabTracker.getOwnedTabId(appId, ownerRoot) !== tabId) {
    return { ok: false, error: 'app_actor_chat_owner_mismatch' };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('App actor reply timed out')),
    timeoutMs,
  );
  try {
    return await messageActor({
      to: appId,
      message: prompt,
      senderSessionId: ownerRoot,
      inbound: false,
      awaitReply: true,
      bareReply: true,
      trustedAppTab: true,
      via: 'app-native',
      awaitSignal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};
