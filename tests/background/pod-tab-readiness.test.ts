import { describe, test, expect } from 'bun:test';
import { createPodTabTracker } from '../../extension/background/tab-tracker.js';

// A fresh Pod tab first adopts (pending), then reports ready. Agent RPC waits
// on the tracker's readiness, so the Pod's first command can only start once
// the ready report is handled. This pins the tracker half of that contract with
// the real tracker (unchanged by the fix; it documents why the route matters).
// The regression test for the fix itself is the pod/tab-ready route case in
// kernel-turn-authority-adapter.test.ts.

const fakeTabs = () => {
  const physical = new Map<number, any>();
  let next = 70;
  return {
    physical,
    tabs: {
      create: async (spec: any) => { const tab = { id: ++next, ...spec }; physical.set(tab.id, tab); return tab; },
      get: async (id: number) => physical.get(id),
      remove: async (id: number) => { physical.delete(id); },
      query: async () => [],
    } as any,
  };
};

describe('Pod tab readiness', () => {
  test('adoption alone leaves the Pod pending; the ready report releases waiting callers', async () => {
    const { tabs } = fakeTabs();
    const tracker = createPodTabTracker({ tabs });
    const opening = tracker.ensureTab('pod-1', { active: false });
    let settled = false;
    opening.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tabId = tracker.getTabId('pod-1');
    expect(tabId).toBe(71);

    // pod/tab-adopt → onTabPending: still not ready, nothing released.
    tracker.onTabPending('pod-1', tabId!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.isReady('pod-1')).toBe(false);
    expect(settled).toBe(false);

    // pod/tab-ready → onTabReady: the waiting first command proceeds.
    tracker.onTabReady('pod-1', tabId!);
    await expect(opening).resolves.toBe(71);
    expect(tracker.isReady('pod-1')).toBe(true);
  });

  test('a live, ready Pod tab is reused without waiting', async () => {
    const { tabs } = fakeTabs();
    const tracker = createPodTabTracker({ tabs });
    const opening = tracker.ensureTab('pod-1', { active: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    tracker.onTabReady('pod-1', tracker.getTabId('pod-1')!);
    await opening;
    await expect(tracker.ensureTab('pod-1', { active: false })).resolves.toBe(71);
  });
});
