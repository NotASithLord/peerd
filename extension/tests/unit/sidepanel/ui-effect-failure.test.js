// @ts-check

import { describe, it, expect } from '../../framework.js';
import m from '/vendor/mithril/mithril.js';
import { NoticeBar } from '/sidepanel/components/app.js';
import { SkillsView } from '/sidepanel/components/skills-view.js';
import {
  makeReconciledUiSender, putUiEffectFailureNotice, settleUiEffect,
} from '/shared/ui-runtime-client.js';

/** @param {(message:any)=>Promise<any>} runtimeSend */
const mount = (runtimeSend) => {
  const root = document.createElement('div');
  document.body.append(root);
  /** @type {any[]} */
  let notices = [];
  /** @type {string[]} */
  const events = [];
  let calls = 0;
  const send = makeReconciledUiSender({
    send: async (message) => {
      calls += 1;
      events.push('send');
      return runtimeSend(message);
    },
    fold: () => { events.push('fold'); },
    reconcile: async () => { events.push('reconcile'); },
    afterReply: () => false,
    onEffectFailure: (_message, cause) => {
      events.push('notice');
      notices = putUiEffectFailureNotice(notices, cause);
      m.redraw.sync();
    },
  });
  m.mount(root, { view: () => m(NoticeBar, { notices }) });
  m.redraw.sync();
  return {
    root, send, events, calls: () => calls,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

describe('sidepanel fire-and-forget effect failures', () => {
  it('shows a known settings refusal once', async () => {
    const harness = mount(async () => ({ ok: false, error: 'settings-refused' }));
    try {
      const effect = harness.send({
        type: 'settings/update', patch: { reasoningEffort: 'high' },
      });
      settleUiEffect(effect);
      await effect;
      expect(harness.calls()).toBe(1);
      expect(harness.root.querySelectorAll('.notice').length).toBe(1);
      expect(harness.root.textContent).toContain('could not apply that change');
      expect(harness.events).toEqual(['send', 'fold', 'notice']);
    } finally { harness.unmount(); }
  });

  it('reconciles a rejected lock before showing its unknown outcome', async () => {
    const failure = Object.assign(new Error('transport detail'), { outcomeKnown: false });
    const harness = mount(async () => { throw failure; });
    try {
      const effect = harness.send({ type: 'vault/lock' });
      settleUiEffect(effect);
      await effect.catch(() => {});
      expect(harness.calls()).toBe(1);
      expect(harness.root.querySelectorAll('.notice').length).toBe(1);
      expect(harness.root.textContent).toContain('could not confirm whether that change finished');
      expect(harness.root.textContent?.includes('transport detail')).toBe(false);
      expect(harness.events).toEqual(['send', 'reconcile', 'notice']);
    } finally { harness.unmount(); }
  });

  it('surfaces rejected skill toggles and removals without replay', async () => {
    const failure = Object.assign(new Error('transport detail'), { outcomeKnown: false });
    /** @type {string[]} */
    const messages = [];
    /** @type {any[]} */
    let notices = [];
    const send = makeReconciledUiSender({
      send: async (message) => { messages.push(message.type); throw failure; },
      fold: () => {}, reconcile: async () => {}, afterReply: () => false,
      onEffectFailure: (_message, cause) => {
        notices = putUiEffectFailureNotice(notices, cause);
      },
    });
    const vnode = /** @type {any} */ ({ attrs: { send }, state: {} });

    SkillsView.toggle(vnode, 'reader', false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    SkillsView.remove(vnode, 'reader');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toEqual(['skills/setEnabled', 'skills/remove']);
    expect(notices.length).toBe(1);
    expect(notices[0].text).toContain('could not confirm whether that change finished');
  });
});
