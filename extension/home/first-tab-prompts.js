// @ts-check
// home/first-tab-prompts.js - the one-time prompts for "Keep peerd as the
// first tab": the turn-on after the first setup with its notice, and the hint
// in the pinned tab. The rules are in first-tab.js; home.js and the side panel
// decide when each one shows.

import m from '/vendor/mithril/mithril.js';
import { composerForState } from '/sidepanel/provider-readiness.js';
import {
  firstTabAutoDue, firstTabNoticeVisible, firstTabPatch, firstTabsToClose,
} from './first-tab.js';

/** @typedef {(message: { type: string, patch: Record<string, boolean> }) => Promise<unknown>} Send */
/** @typedef {{ firstTabEnabled?: unknown, firstTabOffered?: unknown }} FirstTabSettings */
/**
 * @typedef {{ query: (query: { pinned: boolean }) => Promise<{ id?: number, pinned?: boolean,
 *   url?: string, pendingUrl?: string }[]>, remove: (ids: number[]) => Promise<unknown> }} TabsApi
 */

/**
 * Close the pinned Home tabs, all but the tab `keepId`.
 * @param {TabsApi} tabs @param {string} homeUrl @param {number} [keepId]
 */
export const closeFirstTabs = async (tabs, homeUrl, keepId) => {
  const ids = firstTabsToClose(await tabs.query({ pinned: true }), homeUrl, keepId);
  if (ids.length) await tabs.remove(ids);
};

/**
 * After the first setup, peerd turns the first tab on by itself, once. The
 * kernel then adds the tabs. A notice says what changed. "Turn off" turns the
 * setting off and takes the tabs back; "Got it" only closes the notice.
 * @param {Object} deps
 * @param {Send} deps.send
 * @param {() => Promise<void>} [deps.pinFirst] runs before the setting (Home pins its own tab)
 * @param {() => Promise<void>} [deps.unpin] takes back what pinFirst did
 * @param {() => Promise<void>} [deps.closeTabs] closes the tabs that the kernel added
 * @param {() => void} [deps.onChange] runs after the turn-on, and after "Turn off"
 * @param {() => void} [deps.afterClose] runs once the notice closed (the surface moves focus)
 */
export const makeFirstTabAuto = ({
  send, pinFirst, unpin, closeTabs, onChange = () => {}, afterClose = () => {},
}) => {
  /** @type {import('./first-tab.js').FirstTabPhase} */
  let phase = 'idle';
  let busy = false;
  let offFailed = false;
  /** @param {boolean} on */
  const update = async (on) => {
    try {
      const reply = await send({ type: 'settings/update', patch: firstTabPatch(on) });
      return /** @type {{ ok?: unknown } | null} */ (reply)?.ok === true;
    } catch { return false; }
  };
  /** @param {(() => Promise<void>) | undefined} step */
  const attempt = async (step) => { try { await step?.(); } catch { /* the tabs stay */ } };
  const turnOn = async () => {
    await attempt(pinFirst);
    phase = await update(true) ? 'on' : 'failed';
    // why: a failed turn-on must not leave the tab that pinFirst pinned.
    if (phase === 'failed') await attempt(unpin);
    onChange();
    m.redraw();
  };
  const close = () => { phase = 'done'; afterClose(); };
  const turnOff = async () => {
    busy = true;
    offFailed = false;
    const off = await update(false);
    busy = false;
    if (off) {
      await attempt(unpin);
      await attempt(closeTabs);
      onChange();
      close();
    } else offFailed = true;
    m.redraw();
  };
  return {
    /**
     * Each new state comes here. why the phase changes at once: the turn-on
     * runs one time, whatever number of states come while it runs.
     * @param {{ sawSetup: boolean, ready: boolean, settings?: FirstTabSettings | null }} input
     */
    note: ({ sawSetup, ready, settings }) => {
      if (!firstTabAutoDue({ sawSetup, ready, phase, settings })) return;
      phase = 'turning';
      void turnOn();
    },
    /** @param {{ messages?: number }} [input] */
    view: ({ messages = 0 } = {}) => !firstTabNoticeVisible({ phase, messages }) ? null
      : m('section.first-tab-offer', { 'aria-labelledby': 'first-tab-offer-title' }, [
        m('.first-tab-offer-text', { role: 'status' }, phase === 'failed' ? [
          m('h2#first-tab-offer-title', 'Keep peerd as the first tab'),
          m('p.error', 'peerd could not turn this on. Turn it on in Settings.'),
        ] : [
          m('h2#first-tab-offer-title', 'peerd is now the first tab in every window.'),
          m('p', 'You can change this in Settings.'),
          offFailed ? m('p.error', { role: 'alert' },
            'peerd could not turn this off. Turn it off in Settings.') : null,
        ]),
        m('.first-tab-offer-actions', [
          m('button.first-tab-ok', { type: 'button', disabled: busy, onclick: close }, 'Got it'),
          phase === 'on' ? m('button.secondary.first-tab-off', {
            type: 'button', disabled: busy, onclick: turnOff,
          }, busy ? 'Saving…' : 'Turn off') : null,
        ]),
      ]),
  };
};

/**
 * The side panel does it too, because most people set peerd up there. It does
 * it once, in the panel that showed the first vault setup, and only when peerd
 * can answer, so the notice never stacks on the provider setup.
 * @param {{ send: Send, tabs?: TabsApi, homeUrl?: string, afterClose?: () => void }} deps
 *   afterClose - runs once the notice closed (the panel moves focus)
 */
export const makePanelFirstTab = ({ send, tabs, homeUrl, afterClose }) => {
  const auto = makeFirstTabAuto({
    send, afterClose,
    closeTabs: tabs && homeUrl ? () => closeFirstTabs(tabs, homeUrl) : undefined,
  });
  return {
    /** @param {{ settings?: Record<string, unknown> | null }} state */
    note: (state) => auto.note({
      sawSetup: true, ready: composerForState(state).canSend, settings: state.settings,
    }),
    /** @param {{ session?: { messages?: unknown[] } | null }} state */
    view: (state) => auto.view({ messages: state.session?.messages?.length ?? 0 }),
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
