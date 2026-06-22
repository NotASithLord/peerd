import { describe, test, expect } from 'bun:test';
import { makeProfileState } from '../../extension/background/profile-state.js';

describe('profile-state', () => {
  test('get() ensures once, then caches (no second IDB read)', async () => {
    let ensures = 0;
    const s = makeProfileState({ profiles: { ensureDefault: async () => { ensures += 1; return { id: 'default' }; }, completeOnboarding: async () => ({}) } });
    expect(await s.get()).toEqual({ id: 'default' });
    await s.get();
    expect(ensures).toBe(1);
  });
  test('completeOnboarding refreshes the cache', async () => {
    const s = makeProfileState({
      profiles: {
        ensureDefault: async () => ({ id: 'default', onboardingComplete: false }),
        completeOnboarding: async ({ peerName }: any) => ({ id: 'default', peerName, onboardingComplete: true }),
      },
    });
    await s.get();
    const after = await s.completeOnboarding({ peerName: 'Ada' });
    expect(after).toEqual({ id: 'default', peerName: 'Ada', onboardingComplete: true });
    expect(await s.get()).toEqual(after); // cache now reflects onboarding
  });
});
