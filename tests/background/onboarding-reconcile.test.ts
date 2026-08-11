import { describe, test, expect } from 'bun:test';
import { makeOnboardingReconcile } from '../../extension/background/onboarding-reconcile.js';

// The first-run latch reconcile: an install with chat history is onboarded,
// whatever the latch says. The side panel is a front door that never gates
// first-run, so history can exist with the latch still open, and the home
// funnel must not re-trigger mid-use (the sidebar-onboarding-retrigger bug).

type Profile = { id: string; peerName: string; onboardingComplete: boolean };

const makeDeps = (opts: {
  profile?: Profile | null;
  sessionCount?: number;
  sessionKind?: string;
  listThrows?: boolean;
}) => {
  const calls: Array<{ op: string; args?: unknown }> = [];
  const profileState = {
    get: async () => {
      calls.push({ op: 'get' });
      return opts.profile === undefined
        ? { id: 'default', peerName: 'peerd', onboardingComplete: false }
        : opts.profile;
    },
    completeOnboarding: async (args: { peerName?: string }) => {
      calls.push({ op: 'completeOnboarding', args });
      return { ...(opts.profile ?? {}), onboardingComplete: true };
    },
  };
  const sessions = {
    listMetadata: async () => {
      calls.push({ op: 'listMetadata' });
      if (opts.listThrows) throw new Error('idb unavailable');
      return Array.from({ length: opts.sessionCount ?? 0 }, (_, i) => ({
        sessionId: `s${i}`,
        kind: opts.sessionKind ?? 'chat',
      }));
    },
  };
  return { profileState, sessions, calls };
};

describe('onboarding-reconcile', () => {
  test('latch open + chat history → latches, keeping the current peer name', async () => {
    const deps = makeDeps({
      profile: { id: 'default', peerName: 'Ada', onboardingComplete: false },
      sessionCount: 2,
    });
    await makeOnboardingReconcile(deps)();
    expect(deps.calls).toContainEqual({ op: 'completeOnboarding', args: { peerName: 'Ada' } });
  });

  test('latch open + NO history (genuinely fresh install) → leaves the latch open', async () => {
    const deps = makeDeps({ sessionCount: 0 });
    await makeOnboardingReconcile(deps)();
    expect(deps.calls.some((c) => c.op === 'completeOnboarding')).toBe(false);
  });

  test('latch already closed → does not even list sessions (cheap on every push)', async () => {
    const deps = makeDeps({
      profile: { id: 'default', peerName: 'peerd', onboardingComplete: true },
      sessionCount: 5,
    });
    await makeOnboardingReconcile(deps)();
    expect(deps.calls.some((c) => c.op === 'listMetadata')).toBe(false);
    expect(deps.calls.some((c) => c.op === 'completeOnboarding')).toBe(false);
  });

  test('actor-only history (e.g. the dweb daemon woken by a mesh message) does not count as usage', async () => {
    const deps = makeDeps({ sessionCount: 3, sessionKind: 'actor' });
    await makeOnboardingReconcile(deps)();
    expect(deps.calls.some((c) => c.op === 'completeOnboarding')).toBe(false);
  });

  test('missing profile → no-op', async () => {
    const deps = makeDeps({ profile: null, sessionCount: 3 });
    await makeOnboardingReconcile(deps)();
    expect(deps.calls.some((c) => c.op === 'completeOnboarding')).toBe(false);
  });

  test('a store failure never throws out of a state push', async () => {
    const deps = makeDeps({ listThrows: true });
    await expect(makeOnboardingReconcile(deps)()).resolves.toBeUndefined();
  });
});
