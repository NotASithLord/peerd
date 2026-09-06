// @ts-check
// peerd-runtime/profiles — public surface.
//
// The DEFAULT profile shape (ROADMAP "Profiles", deprioritized by the owner).
// Current onboarding state is held by the vault posture and settings owners;
// this pure shape remains shared with the UI.
// peerName is the AI peer's display name — chat-transcript label ONLY.
// The user doc ("doc on the user") does NOT live here: it is the
// memory system's 'user' scope (see memory/user-doc.js).

export {
  DEFAULT_PROFILE_ID,
  DEFAULT_PEER_NAME,
  PEER_NAME_MAX,
  normalizePeerName,
  defaultProfileRecord,
} from './profile.js';
