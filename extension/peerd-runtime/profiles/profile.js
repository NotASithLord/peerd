// @ts-check
// Profiles — pure functional core (no IO).
//
// ROADMAP "Profiles" was deprioritized by the owner to exactly this: a
// DEFAULT profile carrying the same record shape multi-profile will
// need later. Per-profile namespacing of vault/denylist/skills/memory/
// sessions hangs off the profile id WHEN profiles multiply — today
// everything stays GLOBAL. This module is the shape, not the
// namespacing.
//
// The one live field is peerName: the display name of the user's AI
// peer, set during first-run onboarding (the "Hello, I'm peerd"
// screen, where the name is inline-editable). It reflects ONLY in chat
// transcripts — the assistant row label in the side panel — never in
// the brand wordmark or any other surface (owner direction).

/**
 * A stored profile record. Minimal but extensible: multi-profile later
 * adds a user-facing label and per-profile namespacing keys WITHOUT
 * changing the existing fields.
 *
 * @typedef {Object} ProfileRecord
 * @property {string} id                  'default' today; unique per profile later
 * @property {string} peerName           display name of the AI peer (chat-transcript label only)
 * @property {number} createdAt          epoch ms
 * @property {boolean} onboardingComplete first-run onboarding latch — set true exactly once
 * @property {number} [onboardedAt]      epoch ms, when the latch flipped
 */

/** The reserved id of the implicit default profile. */
export const DEFAULT_PROFILE_ID = 'default';

/** Fallback peer display name — the brand, lowercase always. */
export const DEFAULT_PEER_NAME = 'peerd';

// why 32: the peer name renders in the chat transcript's narrow role
// gutter; longer strings deform every assistant row. Capped at the
// normalize chokepoint so a pasted paragraph can never persist.
export const PEER_NAME_MAX = 32;

/**
 * Normalize a peer-name candidate: collapse internal whitespace, trim,
 * cap the length, and fall back to the default when nothing usable
 * remains. Pure — the single chokepoint every write path goes through.
 *
 * @param {unknown} name
 * @returns {string}
 */
export const normalizePeerName = (name) => {
  if (typeof name !== 'string') return DEFAULT_PEER_NAME;
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, PEER_NAME_MAX).trim();
  return cleaned === '' ? DEFAULT_PEER_NAME : cleaned;
};

/**
 * Build a fresh default-profile record. Pure — the clock is injected
 * so tests are deterministic.
 *
 * why onboardingComplete:false even for installs that predate
 * onboarding: the welcome screen fires exactly once for everyone (it
 * is also the only place to name the peer), then the latch holds
 * forever. No migration heuristics — solo-dev convention.
 *
 * @param {Object} [opts]
 * @param {() => number} [opts.now]
 * @returns {ProfileRecord}
 */
export const defaultProfileRecord = ({ now = Date.now } = {}) => ({
  id: DEFAULT_PROFILE_ID,
  peerName: DEFAULT_PEER_NAME,
  createdAt: now(),
  onboardingComplete: false,
});
