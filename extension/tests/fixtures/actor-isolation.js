// @ts-check
// Real-component fixture for the paused actor-execution UI.

import m from '/vendor/mithril/mithril.js';
import { ActorIsolationBanner } from '/sidepanel/components/actor-isolation-banner.js';
import { ChatView } from '/sidepanel/components/chat-view.js';

// why: settle the starter cards immediately so the screenshot checks layout,
// not the one-time typewriter animation.
window.matchMedia = () => /** @type {MediaQueryList} */ ({ matches: true });

/** @type {{ status: string, host: string|null, reason: string|null, retryable: boolean }} */
let capability = {
  status: 'temporarily_unavailable',
  host: 'background-page-worker',
  reason: 'fixture-private-worker-error',
  retryable: true,
};
let retryAttempts = 0;

/** @param {{ type?: string }} message */
const send = async (message) => {
  if (message.type === 'models/options') return { ok: true, options: [] };
  if (message.type === 'actor-isolation/retry') {
    retryAttempts += 1;
    if (retryAttempts === 1) return { ok: false, code: 'actor_worker_start_timeout' };
    capability = {
      status: 'available', host: 'background-page-worker', reason: null, retryable: false,
    };
    state.capabilities.actorExecution = capability;
    m.redraw();
    return { ok: true, capability };
  }
  return { ok: true };
};

const state = {
  session: {
    sessionId: null,
    messages: [],
    permission: { mode: 'act', confirmActions: false },
  },
  providers: { current: 'ollama', hasKey: true, model: '' },
  settings: { providerName: 'ollama', voiceOnboardingDismissed: true, voiceEnabled: false },
  capabilities: { actorExecution: capability },
  goalRuns: {},
  agentTabEvents: [],
  actors: {},
};

/** @type {any} */ (globalThis).actorIsolationFixtureShowUnknownOutcome = () => {
  const fixtureState = /** @type {any} */ (state);
  const messages = [
      {
        role: 'assistant', id: 'assistant-unknown', content: '',
        toolUses: [{ id: 'tool-unknown', name: 'message_actor', input: { to: 'web', message: 'submit the form' } }],
      },
      {
        role: 'user', id: 'result-unknown', content: '',
        toolResults: [{ tool_use_id: 'tool-unknown', is_error: false, content: 'Message delivered.' }],
      },
      {
        role: 'user', id: 'reply-unknown', synthetic: true,
        actorReply: { kind: 'web', instanceId: 'web', failed: true, outcomeKnown: false },
        content: 'The web actor did not complete cleanly. Its outcome is unknown. Do not retry automatically:\n\n<untrusted_web_content>peerd cannot confirm whether the previous request ran before the background host restarted. Check whether the requested action completed before trying again.</untrusted_web_content>',
      },
      {
        role: 'user', id: 'actor-recovery:chat-unknown-outcome:queued-1', synthetic: true,
        actorReply: {
          kind: 'app', instanceId: 'app-1', name: 'orders', failed: true,
          outcomeKnown: true, performed: false,
        },
        content: 'The app actor orders (app-1) could not complete your request:\n\n<untrusted_web_content>The background host restarted before this actor request was dispatched. It was not run. Re-issue it if it still matters.</untrusted_web_content>',
      },
      {
        role: 'assistant', id: 'assistant-spawn-unknown', content: '',
        toolUses: [{ id: 'spawn-unknown', name: 'actor_create', input: { task: 'update the record', sync: true } }],
      },
      {
        role: 'user', id: 'result-spawn-unknown', content: '',
        toolResults: [{
          tool_use_id: 'spawn-unknown', is_error: true,
          content: 'Actor execution did not complete. Its outcome is unknown. Do not retry automatically.',
        }],
      },
    ];
  // First mount the destination chat as ordinary history. Recovery receipts
  // then arrive on that same live chat, which is the event the transient status
  // is meant to announce. Reopening this finished history stays silent.
  fixtureState.session = {
    ...fixtureState.session,
    sessionId: 'chat-unknown-outcome',
    messages: messages.slice(0, 2),
  };
  m.redraw.sync();
  fixtureState.session = { ...fixtureState.session, messages };
  fixtureState.actors = {
    'tool-unknown': {
      kind: 'web', instanceId: 'web', streaming: false,
      error: 'The actor worker stopped. Its outcome is unknown.',
      outcomeKnown: false,
    },
  };
  m.redraw();
};

const Fixture = {
  view: () => m('.actor-isolation-fixture', [
    m(ActorIsolationBanner, { capability, send }),
    m(ChatView, { state, send, surface: 'sidepanel', activeTabIsWeb: false }),
  ]),
};

m.mount(document.getElementById('app'), Fixture);
