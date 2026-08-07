import { describe, expect, test } from 'bun:test';
import { makeContributorRoutes } from '../../extension/background/routes/contributor-metrics.js';

const optionsSender = { surface: 'options' };
const sidepanelSender = { surface: 'sidepanel' };
const homeSender = { surface: 'home' };
const engineSender = { surface: 'engine' };

const session = {
  sessionId: 'chat-1',
  kind: 'chat',
  messages: [
    { role: 'user', id: 'user-1', content: 'browse this', toolResults: [] },
    { role: 'assistant', id: 'assistant-call', content: 'I will check.', toolUses: [
      { id: 'web-tool-1', name: 'message_actor', input: { goal: 'secret page content' } },
    ] },
    { role: 'user', id: 'tool-results', content: '', toolResults: [], synthetic: true },
    { role: 'assistant', id: 'assistant-final', content: 'Done.', toolUses: [], stopReason: 'end_turn' },
  ],
};

const harness = ({ channel = 'preview', busy = false, actorsInFlight = false, activeSession = session }: {
  channel?: string;
  busy?: boolean;
  actorsInFlight?: boolean;
  activeSession?: any;
} = {}) => {
  const calls: any[] = [];
  const contributorStore = {
    status: async () => ({ enabled: false, disclosureVersion: 1 }),
    enable: async () => ({ enabled: true, disclosureVersion: 1 }),
    disableAndClear: async () => ({ enabled: false, disclosureVersion: 1 }),
    recordFeedback: async (value: any) => { calls.push(value); return { recorded: true, reason: null }; },
  };
  const routes = makeContributorRoutes({
    contributorStore,
    sessions: { get: async (id: string) => id === activeSession.sessionId ? activeSession : null },
    isActualOptionsSender: (sender: any) => sender === optionsSender,
    isActualSidepanelSender: (sender: any) => sender === sidepanelSender,
    isActualHomeSender: (sender: any) => sender === homeSender,
    isSessionBusy: () => busy,
    hasInFlightFor: () => actorsInFlight,
    channel,
  });
  return { routes, calls };
};

describe('Contributor Metrics human-only routes', () => {
  test('only the exact Options sender can inspect or change consent', async () => {
    const { routes } = harness();
    for (const type of ['contributor/status', 'contributor/enable', 'contributor/disable'] as const) {
      expect((await routes[type]({}, optionsSender)).ok).toBe(true);
      expect((await routes[type]({}, sidepanelSender)).ok).toBe(false);
      expect((await routes[type]({}, engineSender)).ok).toBe(false);
      expect((await routes[type]({}, undefined)).ok).toBe(false);
    }
  });

  test('feedback accepts binary values from the exact sidepanel and Home senders', async () => {
    const { routes, calls } = harness();
    const request = {
      sessionId: 'chat-1', messageId: 'assistant-final', verdict: 'worked',
    };
    expect((await routes['contributor/feedback'](request, sidepanelSender)).ok).toBe(true);
    expect(calls).toEqual([{
      selectionKey: 'chat-1:user-1',
      verdict: 'worked',
      candidateContextKeys: ['chat-1:web-tool-1'],
    }]);
    expect((await routes['contributor/feedback']({ ...request, verdict: 'didnt_work' }, homeSender)).ok)
      .toBe(true);
    expect(calls[1]).toEqual({
      selectionKey: 'chat-1:user-1',
      verdict: 'didnt_work',
      candidateContextKeys: ['chat-1:web-tool-1'],
    });
    expect((await routes['contributor/feedback'](request, optionsSender)).ok).toBe(false);
    expect((await routes['contributor/feedback']({ ...request, verdict: 'maybe' }, sidepanelSender)).ok).toBe(false);
  });

  test('busy chats and chats with acknowledged actor work in flight cannot receive feedback', async () => {
    const request = {
      sessionId: 'chat-1', messageId: 'assistant-final', verdict: 'worked',
    };
    const busyHarness = harness({ busy: true });
    expect((await busyHarness.routes['contributor/feedback'](request, sidepanelSender)).ok).toBe(false);
    expect(busyHarness.calls).toHaveLength(0);

    const actorHarness = harness({ actorsInFlight: true });
    expect((await actorHarness.routes['contributor/feedback'](request, sidepanelSender)).ok).toBe(false);
    expect(actorHarness.calls).toHaveLength(0);
  });

  test('only an end_turn assistant record can receive feedback', async () => {
    const request = { sessionId: 'chat-1', messageId: 'candidate', verdict: 'worked' };
    for (const stopReason of ['tool_use', 'incomplete', 'aborted', 'max_tokens', 'max_steps', 'one_shot']) {
      const nonTerminalHarness = harness({
        activeSession: {
        ...session,
        messages: [
          session.messages[0],
          {
            role: 'assistant', id: 'candidate', content: 'Not a completed answer.',
            stopReason,
            toolUses: stopReason === 'tool_use'
              ? [{ id: 'tool-1', name: 'message_actor', input: {} }]
              : [],
          },
        ],
      },
      });
      expect((await nonTerminalHarness.routes['contributor/feedback'](request, homeSender)).ok)
        .toBe(false);
      expect(nonTerminalHarness.calls).toHaveLength(0);
    }
  });

  test('store and web channels expose no contributor routes', () => {
    expect(Object.keys(harness({ channel: 'store' }).routes)).toEqual([]);
    expect(Object.keys(harness({ channel: 'web' }).routes)).toEqual([]);
    expect(Object.keys(harness({ channel: 'dev' }).routes)).toContain('contributor/enable');
  });

  test('forged session/message targets fail without touching the store', async () => {
    const { routes, calls } = harness();
    expect((await routes['contributor/feedback']({
      sessionId: 'missing', messageId: 'assistant-final', verdict: 'worked',
    }, sidepanelSender)).ok).toBe(false);
    expect((await routes['contributor/feedback']({
      sessionId: 'chat-1', messageId: 'user-1', verdict: 'didnt_work',
    }, sidepanelSender)).ok).toBe(false);
    expect((await routes['contributor/feedback']({
      sessionId: 'chat-1', messageId: 'assistant-call', verdict: 'didnt_work',
    }, sidepanelSender)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
