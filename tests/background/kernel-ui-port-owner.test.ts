import { describe, expect, test } from 'bun:test';
import { createKernelUiPortOwner } from '../../extension/background/kernel-port-owners.js';
import { makeUiPorts } from '../../extension/background/ui-ports.js';

const makePort = (name = 'sidepanel') => {
  const messages: any[] = [];
  let disconnect: (() => void) | null = null;
  return {
    name, messages,
    postMessage: (message: any) => { messages.push(message); },
    onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } },
    close: () => disconnect?.(),
  };
};

describe('kernel UI Port owner', () => {
  test('takes custody and replays every non-snapshot live projection after hydration', async () => {
    const uiPorts = makeUiPorts();
    const calls: string[] = [];
    const port = makePort();
    const owner = createKernelUiPortOwner({
      uiPorts,
      pushState: () => { calls.push('state'); },
      broadcastSurfaces: () => { calls.push('surfaces'); },
      broadcastAgentTab: () => { calls.push('agent-tab'); },
      activeGoalStates: () => [
        { type: 'goal/state', sessionId: 'a', phase: 'running' },
        { type: 'goal/state', sessionId: 'b', phase: 'running' },
      ],
      onUiConnect: () => { calls.push('update'); },
    });
    expect(owner.attach(port)).toBeUndefined();
    expect(uiPorts.hasNamed('sidepanel')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['state', 'surfaces', 'agent-tab', 'update']);
    expect(calls.filter((call) => call === 'state')).toHaveLength(1);
    expect(port.messages).toEqual([
      { type: 'goal/state', sessionId: 'a', phase: 'running' },
      { type: 'goal/state', sessionId: 'b', phase: 'running' },
    ]);
  });

  test('disconnect broadcasts surface custody, releases update hold, and hints once', async () => {
    const uiPorts = makeUiPorts();
    const calls: string[] = [];
    const port = makePort();
    const owner = createKernelUiPortOwner({
      uiPorts,
      pushState: () => {},
      broadcastSurfaces: () => { calls.push('surfaces'); },
      broadcastAgentTab: () => {},
      activeGoalStates: () => [],
      onQuiet: () => { calls.push('quiet'); },
      getActiveTab: async () => ({ id: 41 }),
      showWebTabHint: (tabId: number) => { calls.push(`hint:${tabId}`); },
    });
    owner.attach(port);
    calls.length = 0;
    port.close();
    port.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(uiPorts.hasNamed('sidepanel')).toBe(false);
    expect(calls).toEqual(['surfaces', 'quiet', 'hint:41']);
  });

  test('keeps a remaining sidepanel authoritative and never hints for home', async () => {
    const uiPorts = makeUiPorts();
    const hints: number[] = [];
    const owner = createKernelUiPortOwner({
      uiPorts,
      pushState: () => {}, broadcastSurfaces: () => {}, broadcastAgentTab: () => {},
      activeGoalStates: () => [],
      getActiveTab: async () => ({ id: 9 }),
      showWebTabHint: (id: number) => { hints.push(id); },
    });
    const first = makePort();
    const second = makePort();
    const home = makePort('home');
    owner.attach(first); owner.attach(second); owner.attach(home);
    first.close(); home.close();
    await Promise.resolve();
    expect(uiPorts.hasNamed('sidepanel')).toBe(true);
    expect(hints).toEqual([]);
  });

  test('captures live state immediately but publishes it only after snapshot hydration', async () => {
    const uiPorts = makeUiPorts();
    let settleState = () => {};
    let settleRuntime = () => {};
    const state = new Promise<void>((resolve) => { settleState = resolve; });
    const runtime = new Promise<void>((resolve) => { settleRuntime = resolve; });
    let runtimeStarted = false;
    let runtimePublished = false;
    const port = makePort();
    const owner = createKernelUiPortOwner({
      uiPorts,
      pushState: () => state,
      broadcastSurfaces: () => {},
      broadcastAgentTab: () => {},
      activeGoalStates: () => [{ type: 'goal/state', sessionId: 'live' }],
      onUiConnect: async (_port: any, hydrated: Promise<unknown>) => {
        runtimeStarted = true;
        await hydrated;
        runtimePublished = true;
        return runtime;
      },
    });

    expect(owner.attach(port)).toBeUndefined();
    expect(uiPorts.hasNamed('sidepanel')).toBe(true);
    expect(port.messages).toEqual([{ type: 'goal/state', sessionId: 'live' }]);
    expect(runtimeStarted).toBe(true);
    expect(runtimePublished).toBe(false);
    settleState();
    await state;
    await Promise.resolve();
    expect(runtimePublished).toBe(true);
    settleRuntime();
    await Promise.all([state, runtime]);
  });

  test('rejects incomplete dependencies, malformed ports, and malformed goal replay', () => {
    expect(() => createKernelUiPortOwner({} as any))
      .toThrow('kernel-ui-port-owner-config-invalid');
    const deps = {
      uiPorts: makeUiPorts(), pushState: () => {}, broadcastSurfaces: () => {},
      broadcastAgentTab: () => {}, activeGoalStates: () => [],
    };
    const owner = createKernelUiPortOwner(deps);
    expect(() => owner.attach({})).toThrow('kernel-ui-port-invalid');
    const malformed = createKernelUiPortOwner({ ...deps, activeGoalStates: () => null as any });
    expect(() => malformed.attach(makePort())).toThrow('kernel-ui-goal-state-invalid');
  });
});
