// @ts-check
// why: these fixed mixed owners support actor delivery, Goal continuation,
// scheduling, attachment conversion, and custody presentation in the MV3
// host. This is deliberately not the growing controller/tool surface. Its
// exact exports and transitive graph are frozen by ownership tests.

export { meshCallToOp, shapeMeshResult } from './actor/a2a-api.js';
export { makeCheapCall } from './actor/cheap-call.js';
export { describeLandingStop, landingStopCard, originPhrase } from './actor/origin-lock-report.js';
export { finalActorTurnReply, finalAssistantText, makeSpawnActor } from './actor/spawn.js';
export {
  fenceApiActorSummary,
  fenceWebActorSummary,
  normalizeApiOrigin,
  parseSiteHandle,
  safeWebActorSummaryOrigin,
  siteHandleFor,
} from './actor/web-actor.js';
export { limitExceeded, normalizeTally } from './cost/accumulator.js';
export { formatDocBody } from './doc/format.js';
export { drainFetchTapInjected, installFetchTapInjected } from './dom/fetch-tap-injected.js';
export { DOC_TEXT_MAX_CHARS, prepareUserAttachmentsWithDocs } from './loop/attachments.js';
export { GOAL_MAX_ITERATIONS, makeGoalRunner } from './loop/goal-runner.js';
export { makeScheduler } from './loop/scheduler.js';
export { makeTrimEnricher } from './loop/summary-enrichment.js';
export { makeAutoMemory } from './memory/auto-memory-orchestrator.js';
export { createSuggestionStore } from './memory/suggestions.js';
export {
  confirmActionsFromRecord,
  normalizeConfirmActions,
  normalizeMode,
  PERMISSION_MODES,
} from './permissions/policy.js';
export { buildMintInjection, resolveSiteUrl } from './site-clients/core.js';
export { digestCapture } from './site-clients/digest.js';
export { createSkillRegistry } from './skills/registry.js';
export { wrapUntrusted } from './tools/prompt-wrap.js';
