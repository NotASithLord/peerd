// @ts-check
// Trusted App parent -> bound actor. Re-pin the live tab, owner root, and
// current manifest binding; App code never receives browser/provider access.

const DEFAULT_MESSAGE_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 180_000;

/** @param {any} deps */
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

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('App actor reply timed out')),
    timeoutMs,
  );
  const interrupted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const bounded = (/** @type {Promise<any>} */ operation) => Promise.race([operation, interrupted]);
  try {
    const actorSessionId = await bounded(Promise.resolve(
      ensureAppActorBinding(appId, ownerClaim),
    ));
    if (!actorSessionId) return { ok: false, error: 'app_actor_chat_actor_unavailable' };
    const actor = await bounded(Promise.resolve(sessions.get(actorSessionId)));
    const ownerRoot = actor?.parentSessionId;
    if (typeof ownerRoot !== 'string'
        || appTabTracker.getOwnedTabId(appId, ownerRoot) !== tabId) {
      return { ok: false, error: 'app_actor_chat_owner_mismatch' };
    }
    return await bounded(Promise.resolve(messageActor({
      to: appId,
      message: prompt,
      senderSessionId: ownerRoot,
      inbound: false,
      awaitReply: true,
      bareReply: true,
      trustedAppTab: true,
      via: 'app-native',
      awaitSignal: controller.signal,
    })));
  } catch (cause) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: 'app_actor_chat_outcome_unconfirmed',
        code: 'app-actor-chat-timeout',
        outcomeKnown: false,
        outcomeKind: 'unknown',
        retryable: false,
      };
    }
    void cause;
    return { ok: false, error: 'app_actor_chat_actor_unavailable' };
  } finally {
    clearTimeout(timer);
  }
};
