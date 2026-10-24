// @ts-check
// Trusted App parent -> bound actor. Re-pin the live tab, owner root, and
// current manifest binding; App code never receives browser/provider access.

import { withDeadline } from '../shared/cold-util.js';

const DEFAULT_MESSAGE_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 180_000;

/** @param {any} deps */
export const makeAppActorChatHandler = ({
  isTrustedSender,
  isVaultLocked = () => false,
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
  const appId = typeof msg.appId === 'string' ? msg.appId : '';
  if (!appId || appId !== appTabTracker.parseIdFromUrl(tabUrl) || tabId == null || appTabTracker.getTabId(appId) !== tabId) {
    return { ok: false, error: 'app_actor_chat_tab_mismatch' };
  }
  const ownerClaim = appTabTracker.parseOwnerFromUrl(tabUrl);
  if (!ownerClaim) return { ok: false, error: 'app_actor_chat_owner_missing' };
  if (isVaultLocked()) return { ok: false, error: 'vault-locked', outcomeKnown: true };

  const prompt = typeof msg.message === 'string' ? msg.message.trim() : '';
  if (!prompt) return { ok: false, error: 'app_actor_chat_message_required' };
  if (prompt.length > messageChars) return { ok: false, error: 'app_actor_chat_message_too_large' };

  const controller = new AbortController();
  try {
    return await withDeadline(async () => {
      const actorSessionId = await ensureAppActorBinding(appId, ownerClaim);
      controller.signal.throwIfAborted();
      if (!actorSessionId) return { ok: false, error: 'app_actor_chat_actor_unavailable' };
      const ownerRoot = (await sessions.get(actorSessionId))?.parentSessionId;
      controller.signal.throwIfAborted();
      if (typeof ownerRoot !== 'string'
          || appTabTracker.getOwnedTabId(appId, ownerRoot) !== tabId) {
        return { ok: false, error: 'app_actor_chat_owner_mismatch' };
      }
      return messageActor({
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
    }, timeoutMs, () => controller.abort());
  } catch {
    return controller.signal.aborted ? {
      ok: false,
      error: 'app_actor_chat_outcome_unconfirmed',
      code: 'app-actor-chat-timeout',
      outcomeKnown: false,
      outcomeKind: 'unknown',
      retryable: false,
    } : { ok: false, error: 'app_actor_chat_actor_unavailable' };
  }
};
