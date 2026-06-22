// @ts-check
// peerd-runtime/profiles — public surface.
//
// The DEFAULT profile (ROADMAP "Profiles", deprioritized by the owner
// to the shape multi-profile will reuse). One record, id 'default':
//
//   const profiles = createProfileStore({ idb })   // bind IO once
//   await profiles.ensureDefault()                 // idempotent create
//   await profiles.completeOnboarding({ peerName })// onboarding latch
//
// peerName is the AI peer's display name — chat-transcript label ONLY.
// The user doc ("doc on the user") does NOT live here: it is the
// memory system's 'user' scope (see memory/user-doc.js).

export { createProfileStore } from './store.js';
export {
  DEFAULT_PROFILE_ID,
  DEFAULT_PEER_NAME,
  PEER_NAME_MAX,
  normalizePeerName,
  defaultProfileRecord,
} from './profile.js';
