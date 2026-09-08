import { describe, expect, test } from 'bun:test';
import { createKernelTurnCustody } from '../../extension/background/kernel-turn-custody.js';

const deps = (marked = new Set<number>()) => ({
  browser: { tabs: {}, scripting: {} },
  idb: { get: async () => undefined },
  kv: {},
  sessionCache: {},
  vault: {},
  auditLog: {},
  settingsStore: {},
  uiPorts: {},
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
