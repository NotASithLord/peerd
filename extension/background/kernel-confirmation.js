// @ts-check

import { makeConfirmCoordinator } from '/peerd-egress/confirm/protocol.js';

/** @param {Record<string, any>} deps */
export const makeConfirmAnswerRoute = ({
  confirmCoordinator, sessionCache, isSidepanelSender, isHomeSender,
}) => async (/** @type {any} */ {
  id, answer, ownerSessionId, sessionId, dispatchId,
}, /** @type {unknown} */ sender) => {
  const fromSidepanel = isSidepanelSender(sender) === true;
  const fromHome = isHomeSender(sender) === true;
  if (!fromSidepanel && !fromHome) {
    return { ok: false, error: 'confirm-answer-unauthorized-sender' };
  }
  const activeOwnerSessionId = await sessionCache.sessionGet('currentSessionId');
  if ((activeOwnerSessionId ?? null) !== (ownerSessionId ?? null)) {
    return { ok: false, error: 'confirm-answer-foreign-owner' };
  }
  const resolved = confirmCoordinator.resolve({
    id, ownerSessionId, sessionId, dispatchId,
  }, answer, fromHome ? 'home' : 'sidepanel');
  return resolved ? { ok: true } : { ok: false, error: 'confirm-answer-stale-or-foreign' };
};

/** @param {any} deps */
export const createKernelConfirmation = (deps) => {
  let delivery = Promise.resolve();
  let pendingCount = 0;
  let badgeRevision = 0;
  const refreshBadge = async () => {
    const revision = ++badgeRevision;
    try {
      let working = false;
      if (pendingCount === 0) {
        try { working = await deps.readStreaming?.() === true; } catch {}
      }
      if (revision !== badgeRevision) return;
      await deps.browser.action?.setBadgeText?.({ text: pendingCount > 0 ? String(pendingCount) : working ? '…' : '' });
      if (pendingCount > 0 || working) {
        await deps.browser.action?.setBadgeBackgroundColor?.({ color: pendingCount > 0 ? '#F59E0B' : '#20252E' });
      }
    } catch {}
  };
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
      pendingCount = count;
      void refreshBadge();
    },
  });
  const answer = makeConfirmAnswerRoute({ ...deps, confirmCoordinator: coordinator });
  return Object.freeze({
    coordinator,
    refreshBadge,
    routes: Object.freeze({ 'confirm/answer': answer }),
  });
};
