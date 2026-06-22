// @ts-check
// background/profile-state.js — the default-profile cache, behind a store so
// the onboarding route reaches it via deps instead of a reassigned
// `let defaultProfile`.
//
// why a store (step 2 of the SW decomposition): defaultProfile was a per-SW
// cache over profiles.ensureDefault(), reassigned by onboarding/complete and
// read by buildStateSnapshot. Wrapping it lets onboarding/complete move out.
// The profiles store (IDB) is injected. Imports nothing.

/**
 * @param {{ profiles: { ensureDefault: () => Promise<any>, completeOnboarding: (a: any) => Promise<any> } }} deps
 */
export const makeProfileState = ({ profiles }) => {
  /** @type {any} */
  let current = null;
  return {
    /** The default profile, ensured + cached (pushState reads it every push). */
    async get() {
      if (!current) current = await profiles.ensureDefault();
      return current;
    },
    /**
     * Latch onboarding complete (names the peer); refreshes the cache.
     * @param {any} args
     */
    async completeOnboarding(args) {
      current = await profiles.completeOnboarding(args);
      return current;
    },
  };
};
