// @ts-check

import {
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
  actorsCallToOp,
  askOutcome,
  shapeActorsResult,
} from './actor/actors-api.js';
import {
  actorAllowedToolsFor,
  EXPOSURE_ACTOR,
  mainAgentDescriptors,
  pinActorCall,
} from './tools/exposure.js';
import { applyComposer } from './composer/apply.js';
import { buildMintInjection, resolveSiteUrl } from './site-clients/core.js';
import {
  canonicalCodeTraceLabel,
  DWEB_INBOUND_TOOL_NAMES,
  resolveWebActorSurface,
} from './actor/capability-manifest.js';
import {
  confirmActionsFromRecord,
  normalizeConfirmActions,
  normalizeMode,
  PERMISSION_MODES,
} from './permissions/policy.js';
import { createSkillRegistry } from './skills/registry.js';
import {
  dispatchToolCall,
  prepareToolCall,
  settleToolCall,
} from './tools/dispatcher.js';
import { DOC_TEXT_MAX_CHARS, prepareUserAttachmentsWithDocs } from './loop/attachments.js';
import { GOAL_MAX_ITERATIONS, makeGoalRunner } from './loop/goal-runner.js';
import { finalActorTurnReply, finalAssistantText, makeSpawnActor, restrictCtxCapabilities } from './actor/spawn.js';
import { formatDocBody } from './doc/format.js';
import { localStoreSource, mergeSources, skillRegistrySource } from './composer/command-sources.js';
import { makeInitOrchestrator } from './memory/init-orchestrator.js';
import { makeScheduler } from './loop/scheduler.js';
import { makeCheapCall } from './actor/cheap-call.js';
import { makeAutoMemory } from './memory/auto-memory-orchestrator.js';
import { createSuggestionStore } from './memory/suggestions.js';
import { makeTrimEnricher } from './loop/summary-enrichment.js';
import { makeToolsCommand } from './tools/manifest-command.js';
import { manifestLabel, resolveManifestAllow } from './tools/manifests.js';
import { limitExceeded, normalizeTally } from './cost/accumulator.js';
import { filterByRuntimeCapabilities } from './runtime-capabilities.js';
import { meshCallToOp, shapeMeshResult } from './actor/a2a-api.js';
import {
  fenceApiActorSummary,
  fenceWebActorSummary,
  normalizeApiOrigin,
  parseSiteHandle,
  safeWebActorSummaryOrigin,
  siteHandleFor,
} from './actor/web-actor.js';
import { describeLandingStop, landingStopCard, originPhrase } from './actor/origin-lock-report.js';
import { wrapUntrusted } from './tools/prompt-wrap.js';
import { digestCapture } from './site-clients/digest.js';
import { drainFetchTapInjected, installFetchTapInjected } from './dom/fetch-tap-injected.js';
import { parseAppManifest } from '/peerd-engine/app-manifest.js';

// why: T1 makes semantic ownership explicit while preserving the one live call
// path. This owner receives no authority dependencies and can move intact later.
export const createControllerTurnSemantics = () => Object.freeze({
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
  actorsCallToOp,
  askOutcome,
  actorAllowedToolsFor,
  applyComposer,
  buildMintInjection,
  canonicalCodeTraceLabel,
  confirmActionsFromRecord,
  createSkillRegistry,
  dispatchToolCall,
  DOC_TEXT_MAX_CHARS,
  DWEB_INBOUND_TOOL_NAMES,
  EXPOSURE_ACTOR,
  filterByRuntimeCapabilities,
  finalActorTurnReply,
  finalAssistantText,
  formatDocBody,
  GOAL_MAX_ITERATIONS,
  limitExceeded,
  localStoreSource,
  mainAgentDescriptors,
  makeAutoMemory,
  makeCheapCall,
  makeInitOrchestrator,
  makeGoalRunner,
  makeScheduler,
  makeSpawnActor,
  makeToolsCommand,
  makeTrimEnricher,
  manifestLabel,
  mergeSources,
  meshCallToOp,
  normalizeApiOrigin,
  normalizeConfirmActions,
  normalizeMode,
  normalizeTally,
  originPhrase,
  parseAppManifest,
  parseSiteHandle,
  PERMISSION_MODES,
  pinActorCall,
  prepareToolCall,
  prepareUserAttachmentsWithDocs,
  resolveManifestAllow,
  resolveSiteUrl,
  resolveWebActorSurface,
  restrictCtxCapabilities,
  safeWebActorSummaryOrigin,
  settleToolCall,
  shapeActorsResult,
  shapeMeshResult,
  skillRegistrySource,
  siteHandleFor,
  createSuggestionStore,
  describeLandingStop,
  digestCapture,
  drainFetchTapInjected,
  fenceApiActorSummary,
  fenceWebActorSummary,
  installFetchTapInjected,
  landingStopCard,
  wrapUntrusted,
});
