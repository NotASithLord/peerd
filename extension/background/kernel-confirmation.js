// @ts-check

import { makeConfirmCoordinator } from '/peerd-egress/confirm/protocol.js';
import { makeConfirmAnswerRoute } from './routes/vault.js';

/** @param {any} deps */
export const createKernelConfirmation = (deps) => {
  let delivery = Promise.resolve();
  const deliver = (/** @type {any} */ prompt, /** @type {(prompt:any)=>void} */ send) => {
    delivery = delivery.then(async () => {
      const current = await deps.sessionCache.sessionGet('currentSessionId');
      if ((current ?? null) === (prompt?.ownerSessionId ?? null)) send(prompt);
    }).catch(() => {});
  };
  const coordinator = makeConfirmCoordinator({
    isChannelOpen: () => deps.uiPorts.size > 0,
    notifySidePanel: (prompt) => deliver(prompt, (owned) => {
      deps.uiPorts.broadcast({ type: 'confirm/request', prompt: owned });
    }),
    onSettled: (id, prompt, outcome) => deliver(prompt, () => {
      deps.uiPorts.broadcast({ type: 'confirm/resolved', id, outcome });
    }),
    onPendingChange: (count) => {
      try {
        deps.browser.action?.setBadgeText?.({ text: count > 0 ? String(count) : '' });
        if (count > 0) deps.browser.action?.setBadgeBackgroundColor?.({ color: '#F59E0B' });
      } catch {}
    },
  });
  const answer = makeConfirmAnswerRoute({
    confirmCoordinator: coordinator,
    sessionCache: deps.sessionCache,
    isActualSidepanelSender: deps.isSidepanelSender,
    isActualHomeSender: deps.isHomeSender,
  });
  return Object.freeze({
    coordinator,
    routes: Object.freeze({ 'confirm/answer': answer }),
  });
};
