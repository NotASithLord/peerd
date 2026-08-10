// @ts-check
// background/onboarding-reconcile.js: close the first-run latch for installs
// that are already in use.
//
// The home page BLOCKS on profile.onboardingComplete (the "meet your peer"
// funnel), but the side panel is a front door too (the toolbar icon opens it
// directly, the frontDoorView default) and it deliberately never gates
// first-run. So a panel-first user could build real chat history with the
// latch still open, and their first Home click mid-use landed on a blocking
// first-run funnel. why "history = onboarded": once the user has messaged
// their peer, first-run is over. The latch closes silently: peer name kept
// as-is, no memory seeded (unlike the funnel's 'onboarding/complete', which
// may write the user doc).
//
// Called from the snapshot builder's unlocked path: every surface renders
// from a snapshot, so no surface can show first-run to an established
// install, including installs whose history predates this rule. Cheap: it
// only does work while the latch is open (a short first-run window), and
// listMetadata reads session records only, never message bodies.

/**
 * @param {{
 *   profileState: {
 *     get: () => Promise<any>,
 *     completeOnboarding: (args: { peerName?: string }) => Promise<any>,
 *   },
 *   sessions: { listMetadata: () => Promise<any[]> },
 * }} deps
 * @returns {() => Promise<void>} reconcile, safe to call on every push
 */
export const makeOnboardingReconcile = ({ profileState, sessions }) => async () => {
  try {
    const profile = await profileState.get();
    if (!profile || profile.onboardingComplete) return;
    // Only kind:'chat' counts as history. Actor/spawned sessions can exist
    // without the user ever chatting (e.g. the dweb daemon actor woken by an
    // inbound mesh message), and those must not skip first-run for a user
    // who never messaged their peer. (Legacy records normalize to 'chat'.)
    const records = await sessions.listMetadata();
    if (!records.some((record) => record?.kind === 'chat')) return;
    await profileState.completeOnboarding({ peerName: profile.peerName });
  } catch (e) {
    // A reconcile failure must never break a state push. Worst case the
    // funnel shows once more and the next push retries.
    console.error('[sw] onboarding reconcile failed', e);
  }
};
