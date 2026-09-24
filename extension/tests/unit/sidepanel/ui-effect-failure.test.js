// @ts-check

import { describe, it, expect } from '../../framework.js';
import m from '/vendor/mithril/mithril.js';
import { NoticeBar } from '/sidepanel/components/app.js';
import { ChatView } from '/sidepanel/components/chat-view.js';
import { InputBar } from '/sidepanel/components/input-bar.js';
import { SkillsView } from '/sidepanel/components/skills-view.js';
import {
  makeReconciledUiSender, putUiEffectFailureNotice, settleUiEffect,
} from '/shared/ui-effects.js';

/** @param {(message:any)=>Promise<any>} runtimeSend @param {(send:any)=>any} [render] */
const mount = (runtimeSend, render = () => null) => {
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
  m.mount(root, { view: () => [render(send), m(NoticeBar, { notices })] });
  m.redraw.sync();
  return {
    root, send, events, calls: () => calls,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

/** @param {string} selector @param {any} message @param {(send:any)=>any} render */
const expectSettledFailure = async (selector, message, render) => {
  /** @type {any[]} */
  const sent = [];
  const failure = Object.assign(new Error('lost effect receipt'), { outcomeKnown: false });
  const harness = mount(async (value) => { sent.push(value); throw failure; }, render);
  try {
    /** @type {HTMLButtonElement} */ (harness.root.querySelector(selector)).click();
    await flush();
    expect(sent).toEqual([message]);
    expect(harness.events).toEqual(['send', 'reconcile', 'notice']);
    expect(harness.root.querySelectorAll('.notice').length).toBe(1);
  } finally { harness.unmount(); }
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

  it('reconciles each failed skill mutation with one list read and one notice', async () => {
    for (const rejected of [true, false]) {
      const failure = Object.assign(new Error('transport detail'), { outcomeKnown: false });
      /** @type {string[]} */
      const messages = [];
      /** @type {any[]} */
      let notices = [];
      let reconciles = 0;
      const send = makeReconciledUiSender({
        send: async (message) => {
          messages.push(message.type);
          if (message.type === 'skills/list') return { ok: true, skills: [] };
          if (rejected) throw failure;
          return { ok: false, error: 'refused' };
        },
        fold: () => {},
        reconcile: async () => { reconciles += 1; },
        afterReply: () => false,
        onEffectFailure: (_message, cause) => {
          notices = putUiEffectFailureNotice(notices, cause);
        },
      });
      const vnode = /** @type {any} */ ({ attrs: { send }, state: {} });

      if (rejected) SkillsView.toggle(vnode, 'reader', false);
      else SkillsView.remove(vnode, 'reader');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(messages).toEqual([
        rejected ? 'skills/setEnabled' : 'skills/remove', 'skills/list',
      ]);
      expect(reconciles).toBe(rejected ? 1 : 0);
      expect(notices.length).toBe(1);
    }
  });

  it('settles both rendered goal Stop surfaces once without replay', async () => {
    const state = /** @type {any} */ ({
      vault: { locked: true },
      session: { sessionId: 'goal-stop', messages: [], permission: { mode: 'act' } },
      providers: { hasKey: false },
      settings: { voiceOnboardingDismissed: true, voiceEnabled: false },
      capabilities: {},
      goalRuns: {
        'goal-stop': { active: true, iteration: 2, maxIterations: 10, goal: 'finish' },
      },
    });
    /** @type {(send:any)=>any} */
    const render = (send) => m(ChatView, {
      state, send, voiceManager: null, uiActions: {},
    });
    for (const selector of ['.goal-toggle', '.goal-bar-stop']) {
      await expectSettledFailure(selector, { type: 'agent/stop' }, render);
    }
  });

  it('settles the composer Stop once without replay', async () => {
    const state = /** @type {any} */ ({
      streaming: true,
      session: { sessionId: 'composer-stop', provider: 'anthropic' },
      providers: { hasKey: false, current: 'anthropic' },
      composer: { provider: 'anthropic', model: '', canSend: false, reason: 'missing-key' },
      capabilities: {},
    });
    await expectSettledFailure('button.stop', { type: 'agent/stop' },
      (send) => m(InputBar, { state, send, voiceManager: null }));
  });

  it('settles the voice-onboarding dismissal once without replay', async () => {
    const state = /** @type {any} */ ({
      vault: { locked: true },
      session: { sessionId: 'voice-dismiss', messages: [], permission: { mode: 'act' } },
      providers: { hasKey: true, current: 'anthropic' },
      composer: { provider: 'anthropic', model: 'claude', canSend: true, reason: null },
      settings: { voiceOnboardingDismissed: false, voiceEnabled: false },
      capabilities: { moonshineVoiceHost: { status: 'available' } },
      goalRuns: {},
    });
    await expectSettledFailure('.onboarding-card button.secondary', {
      type: 'settings/update', patch: { voiceOnboardingDismissed: true },
    }, (send) => m(ChatView, { state, send, voiceManager: null, uiActions: {} }));
  });
});
