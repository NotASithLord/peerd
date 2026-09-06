// @ts-check
// why: the MV3 adapter needs state, lifecycle, and actor custody without semantic registries.

export {
  AUTH_BOUNDARY_STOPPED_MESSAGE,
  AUTH_STATE_UNAVAILABLE_MESSAGE,
  AUTH_WAITING_FOR_USER_MESSAGE,
} from './actor/auth-wait.js';
export { makeMeshDispatch } from './actor/a2a-dispatch.js';
export { makeActorMessaging } from './actor/actor-messaging.js';
export { makeAsyncActors } from './actor/async-actors.js';
export { createConversationRegistry } from './actor/conversation-registry.js';
export { buildAncestry } from './actor/delegation-lineage.js';
export { isKnownIdp, isKnownIdpHost } from './actor/idp-registry.js';
export {
  actorIsolationAvailable,
  actorIsolationCapability,
  actorIsolationRefusal,
  actorIsolationSpawnRefusal,
  actorIsolationTemporarilyUnavailable,
} from './actor/isolation.js';
export { makeLearnedOrigins } from './actor/learned-origins.js';
export {
  decideNumericTabAuthority,
  IDENTITY_PROVIDER_TRANSIT_ONLY_CODE,
  numericTabAuthorityRefusal,
} from './actor/numeric-tab-authority.js';
export {
  authorizeSiteClientRelayOrigin,
  hasDurableSiteClientState,
  makeCredentialScope,
  makeFixedSiteClientOriginGuard,
  makeJudgeLanding,
  makeSignInExcursionAuthorizer,
  makeSignInExcursionRevoker,
  makeSignInOriginAuthorizer,
  makeSiteClientOriginAuthorizer,
  makeSiteClientOriginGuard,
} from './actor/origin-lock.js';
export { learnedOriginCovers } from './actor/origin-sensitivity.js';
export { makeOriginStateStore } from './actor/origin-state-store.js';
export { isUgcHost } from './actor/ugc-registry.js';
export {
  makeApiActorBindings,
  makeWebActorRegistry,
  makeWebActorTabBindings,
  retireStoppedRoamingWebActorDurably,
} from './actor/web-actor.js';
export { createCommandStore } from './composer/command-store.js';
export { createRefRegistry } from './dom/ref-registry.js';
export { SessionNotFoundError } from './errors.js';
export { makeLifecycleBoot } from './lifecycle/boot.js';
export { makeDispatchTracker, makeFailClosedTracker } from './lifecycle/dispatch-tracking.js';
export { makeEngineLiveness, groupResourceLossNotices } from './lifecycle/engine-liveness.js';
export { retryClassForTool } from './lifecycle/tool-retry-class.js';
export { makePrewalkController } from './loop/prewalk-controller.js';
export { makeTurnAuthorityDriver } from './loop/turn-authority-driver.js';
export { assembleDebugBundle, childSessionIdsOf } from './observability/debug-bundle.js';
export { classifyFailure } from './observability/failure-classify.js';
export { resolveRuntimeCapabilities } from './runtime-capabilities.js';
export { createSiteClientStore } from './site-clients/store.js';
export {
  buildClientWriteProposal,
  normalizeSiteOrigin,
} from './site-clients/core.js';
export { createSkillStore } from './skills/store.js';
export { isAddressableBrowserTab } from './tools/browser-automation-policy.js';
export { isDenylistedTab } from './browser-authority/dom-helpers.js';
export { createResultStore } from './tools/result-store.js';
