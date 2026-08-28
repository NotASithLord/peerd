// @ts-check
import { makeAppActorChatHandler } from './app-actor-chat.js';
import { makeKernelLazyOwner } from './kernel-lazy-owner.js';

/** @param {Record<string,any>} deps */
export const makeKernelAppActorChatRoutes = (deps) => {
  if (typeof deps.isAllowed !== 'function') {
    throw new TypeError('kernel-app-actor-chat-provenance-required');
  }
  const load = makeKernelLazyOwner(deps, (live) => typeof live.appActorChat === 'function'
    ? live.appActorChat : makeAppActorChatHandler(live));
  return Object.freeze({
    'app/actor-chat': async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => deps.isAllowed(sender, message)
      ? (await load())(message, sender)
      : { ok: false, error: 'app_actor_chat_unauthorized', outcomeKnown: true },
  });
};
