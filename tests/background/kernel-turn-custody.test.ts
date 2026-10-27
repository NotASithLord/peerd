import { describe, expect, test } from 'bun:test';
import { INITIAL_STATE, reduceChat } from '../../extension/sidepanel/chat-reducer.js';
import { createKernelTurnCustody } from '../../extension/background/kernel-turn-custody.js';

const deps = (marked = new Set<number>()) => ({
  browser: { tabs: {}, scripting: {} },
  idb: { get: async () => undefined },
  kv: {},
  sessionCache: {},
  vault: {},
  auditLog: {},
  settingsStore: {},
  uiPorts: { broadcast: (_message: any) => {} },
  turnForceReleaseMs: 1,
  makePageActivity: () => ({
    markedTabs: () => [...marked],
    release: async (tabId: number) => { marked.delete(tabId); },
  }),
});

describe('kernel turn custody', () => {
  test('owns stable turn state and releases one exact runtime', async () => {
    const marked = new Set([7]);
    const custody = createKernelTurnCustody(deps(marked));
    const runtime = { onSessionMessageAppended: () => {} };
    const release = custody.bindActorRuntime(runtime);
    expect(() => custody.bindActorRuntime({})).toThrow(
      'kernel-turn-custody-runtime-invalid',
    );
    const claim = custody.shared.turnSlots.claim('session:1');
    expect(custody.isActivityStopSender(
      { tab: { id: 7 } }, { type: 'agent/stop', activity: 'live' },
    )).toBe(true);
    await release();
    expect(claim.controller.signal.aborted).toBe(true);
    expect(marked.size).toBe(0);
    expect(custody.shared.sessions).toBeDefined();
    expect(custody.shared.memory).toBeDefined();
  });

  test('rejects a partial kernel graph', () => {
    expect(() => createKernelTurnCustody({})).toThrow(
      'kernel-turn-custody-config-invalid',
    );
  });
});


test('passive actor receipt clears replayed busy state after Stop', () => {
  let state: any = { ...INITIAL_STATE, session: { sessionId: 'parent', messages: [] },
    projection: { generation: 1, authorityEpoch: 'kernel' } };
  const input = deps();
  const messages: any[] = [];
  input.uiPorts.broadcast = (message) => {
    messages.push(message);
    state = reduceChat(state, message);
  };
  const slots = createKernelTurnCustody(input).shared.turnSlots;
  const parent = slots.claim('parent');
  let receipt: { release: () => void } | undefined;
  slots.runWhenIdleClaimed('parent', (lease) => { receipt = lease; });
  slots.stop('parent');
  parent.release();
  expect(slots.isBusy('parent')).toBe(true);
  state = reduceChat(state, { type: 'turn/streaming', sessionId: 'parent', streaming: true, replay: true, projection: state.projection });
  expect(state.streaming).toBe(true);
  expect(messages).toEqual([]);
  receipt!.release();
  expect(slots.isBusy('parent')).toBe(false);
  expect(state.streaming).toBe(false);
  expect(messages).toEqual([{ type: 'turn/streaming', sessionId: 'parent', streaming: false }]);
  receipt!.release();
  expect(messages).toHaveLength(1);
});

test('slot handoff keeps the replacement busy and rejects a stale release', async () => {
  const input = deps();
  const messages: any[] = [];
  input.uiPorts.broadcast = (message) => { messages.push(message); };
  const slots = createKernelTurnCustody(input).shared.turnSlots;
  const parent = slots.claim('parent');
  let replacement: { release: () => void } | undefined;
  slots.stop('parent');
  slots.runWhenIdleClaimed('parent', (lease) => { replacement = lease; });
  parent.release();
  parent.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(slots.isBusy('parent')).toBe(true);
  expect(messages).toEqual([]);
  replacement!.release();
  expect(messages).toEqual([{ type: 'turn/streaming', sessionId: 'parent', streaming: false }]);
});

test('watchdog reports idle only when no queued turn takes the slot', async () => {
  const input = deps();
  const messages: any[] = [];
  input.uiPorts.broadcast = (message) => { messages.push(message); };
  const slots = createKernelTurnCustody(input).shared.turnSlots;
  const stale = slots.claim('parent');
  slots.claim('other');
  slots.stop('parent');
  await new Promise((resolve) => setTimeout(resolve, 10));
  stale.release();
  expect(slots.isBusy('parent')).toBe(false);
  expect(slots.isBusy('other')).toBe(true);
  expect(messages).toEqual([{ type: 'turn/streaming', sessionId: 'parent', streaming: false }]);
});

test('watchdog keeps a queued replacement busy', async () => {
  const input = deps();
  const messages: any[] = [];
  input.uiPorts.broadcast = (message) => { messages.push(message); };
  const slots = createKernelTurnCustody(input).shared.turnSlots;
  const stale = slots.claim('parent');
  slots.stop('parent');
  let replacement: { release: () => void } | undefined;
  slots.runWhenIdleClaimed('parent', (lease) => { replacement = lease; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(slots.isBusy('parent')).toBe(true);
  expect(messages).toEqual([]);
  stale.release();
  expect(messages).toEqual([]);
  replacement!.release();
  expect(messages).toEqual([{ type: 'turn/streaming', sessionId: 'parent', streaming: false }]);
});
