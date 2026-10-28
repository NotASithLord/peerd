// @ts-check
// home/first-tab-prompts.js - the one-time prompts for "Keep peerd as the
// first tab": the offer after the first setup, and the hint in the pinned tab.
// The rules are in first-tab.js; home.js and the side panel decide when each
// one shows.

import m from '/vendor/mithril/mithril.js';
import { composerForState } from '/sidepanel/provider-readiness.js';
import { firstTabKeptVisible, firstTabOfferPatch, firstTabOfferVisible } from './first-tab.js';

/** @typedef {(message: { type: string, patch: Record<string, boolean> }) => Promise<unknown>} Send */
/** @typedef {'keep'|'later'} Answer */

/**
 * "Keep it" turns the setting on, and the kernel then adds the tabs. "Not now"
 * only records the answer. Either answer hides the offer for good.
 */
export const FirstTabOffer = () => {
  let busy = false;
  let failed = false;
  /**
   * @param {Send} send @param {(answer: Answer) => void} onAnswered
   * @param {(() => Promise<void>) | undefined} beforeKeep
   */
  const keep = async (send, onAnswered, beforeKeep) => {
    busy = true;
    failed = false;
    /** @type {unknown} */
    let reply = null;
    try {
      await beforeKeep?.();
      reply = await send({ type: 'settings/update', patch: firstTabOfferPatch('keep') });
    } catch { reply = null; }
    busy = false;
    if (/** @type {{ ok?: unknown } | null} */ (reply)?.ok === true) onAnswered('keep');
    else failed = true;
    m.redraw();
  };
  /** @param {Send} send @param {(answer: Answer) => void} onAnswered */
  const later = (send, onAnswered) => {
    onAnswered('later');
    void send({ type: 'settings/update', patch: firstTabOfferPatch('later') }).catch(() => {});
  };
  return {
    /**
     * @param {{ attrs: { send: Send, onAnswered: (answer: Answer) => void,
     *   beforeKeep?: () => Promise<void> } }} vnode
     */
    view: ({ attrs: { send, onAnswered, beforeKeep } }) =>
      m('section.first-tab-offer', { 'aria-labelledby': 'first-tab-offer-title' }, [
        m('.first-tab-offer-text', [
          m('h2#first-tab-offer-title', 'Keep peerd as the first tab?'),
          m('p', 'It stays at the start of your tabs in every window, so peerd is one click away.'),
          m('p', 'You can turn this on later in Settings.'),
          failed ? m('p.error', { role: 'alert' },
            'peerd could not turn this on. Try again, or turn it on in Settings.') : null,
        ]),
        m('.first-tab-offer-actions', [
          m('button.first-tab-keep', {
            type: 'button', disabled: busy, onclick: () => keep(send, onAnswered, beforeKeep),
          }, busy ? 'Saving…' : 'Keep it'),
          m('button.secondary.first-tab-later', {
            type: 'button', disabled: busy, onclick: () => later(send, onAnswered),
          }, 'Not now'),
        ]),
      ]),
  };
};

/** The side panel's answer to "Keep it": the new tabs open out of sight. */
export const FirstTabKept = {
  view: () => m('p.first-tab-kept', { role: 'status' }, 'peerd is now the first tab in every window.'),
};

/**
 * The side panel asks too, because most people set peerd up there. It asks
 * once, in the panel that showed the first vault setup, and only when peerd
 * can answer, so it never stacks on the provider setup.
 * @param {{ send: Send, afterAnswer?: () => void }} deps
 *   afterAnswer - runs once the offer has its answer (the panel moves focus)
 */
export const makePanelFirstTab = ({ send, afterAnswer = () => {} }) => {
  let answered = false;
  let kept = false;
  /** @param {Answer} answer */
  const onAnswered = (answer) => { answered = true; kept = answer === 'keep'; afterAnswer(); };
  return {
    /**
     * @param {{ settings?: Record<string, unknown> | null,
     *   session?: { messages?: unknown[] } | null }} state
     */
    view: (state) => {
      if (firstTabKeptVisible({ kept, messages: state.session?.messages?.length ?? 0 })) {
        return m(FirstTabKept);
      }
      return firstTabOfferVisible({ sawSetup: true, answered, settings: state.settings })
        && composerForState(state).canSend ? m(FirstTabOffer, { send, onAnswered }) : null;
    },
  };
};

/**
 * The tab strip is browser UI, so the hint shows inside peerd, at the top of
 * the pinned tab. Escape works like "Got it".
 */
export const FirstTabHint = {
  /** @param {{ attrs: { onDismiss: () => void } }} vnode */
  view: ({ attrs: { onDismiss } }) => m('section.first-tab-hint', {
    'aria-labelledby': 'first-tab-hint-title',
    onkeydown: (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    },
  }, [
    m('h2#first-tab-hint-title', 'peerd lives here.'),
    m('p', 'Click P anytime to ask peerd or open your apps.'),
    m('.first-tab-hint-actions',
      m('button.first-tab-hint-ok', { type: 'button', onclick: onDismiss }, 'Got it')),
  ]),
};
