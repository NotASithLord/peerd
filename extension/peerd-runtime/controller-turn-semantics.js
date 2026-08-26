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
  actorDescriptors,
  EXPOSURE_ACTOR,
  EXPOSURE_REVIEW,
  filterByDwebActive,
  filterByDwebEnabled,
  filterByGoalActive,
  mainAgentDescriptors,
  pinActorCall,
} from './tools/exposure.js';
import { applyComposer } from './composer/apply.js';
import { buildMintInjection, resolveSiteUrl } from './site-clients/core.js';
import { buildTemporalBlock } from './clock/context.js';
import {
  canonicalCodeTraceLabel,
  DWEB_INBOUND_TOOL_NAMES,
  resolveWebActorSurface,
} from './actor/capability-manifest.js';
import {
  ACTION_CLASSES,
  classifyAction,
  confirmActionsFromRecord,
  decideAction,
  normalizeConfirmActions,
  normalizeMode,
  PERMISSION_MODES,
} from './permissions/policy.js';
import { createSkillRegistry } from './skills/registry.js';
import { detectInterruptedTurn } from './loop/resume-detect.js';
import {
  dispatchToolCall,
  prepareToolCall,
  settleToolCall,
} from './tools/dispatcher.js';
import { DOC_TEXT_MAX_CHARS, prepareUserAttachmentsWithDocs } from './loop/attachments.js';
import { GOAL_MAX_ITERATIONS, makeGoalRunner } from './loop/goal-runner.js';
import { finalActorTurnReply, finalAssistantText, makeSpawnActor, restrictCtxCapabilities } from './actor/spawn.js';
import { formatDocBody } from './doc/format.js';
import {
  getTool,
  getToolDescriptor,
  listTools,
  listToolDescriptors,
  registerMetadataInventory,
  registerTool,
} from './tools/registry.js';
import { LEGACY_TOOL_IMPLEMENTATIONS } from './tools/legacy-implementations.js';
import { localStoreSource, mergeSources, skillRegistrySource } from './composer/command-sources.js';
import { makeInitOrchestrator } from './memory/init-orchestrator.js';
import { makeRequestReview } from './review/orchestrator.js';
import { isReadOnlyTool } from './review/read-only.js';
import { makeScheduler } from './loop/scheduler.js';
import { makeCheapCall } from './actor/cheap-call.js';
import { makeAutoMemory } from './memory/auto-memory-orchestrator.js';
import { createSuggestionStore } from './memory/suggestions.js';
import { makeTrimEnricher } from './loop/summary-enrichment.js';
import { makeToolsCommand } from './tools/manifest-command.js';
import { makeTurnCostTracker } from './cost/turn-tracker.js';
import { makeTurnDriver } from './loop/turn-driver.js';
import {
  filterDescriptorsByManifest,
  manifestLabel,
  resolveManifestAllow,
} from './tools/manifests.js';
import { limitExceeded, normalizeTally } from './cost/accumulator.js';
import { projectToolAuthority } from './tools/metadata/descriptor.js';
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
import { makeToolboxParseCheck } from './toolbox/core.js';
import { wrapUntrusted } from './tools/prompt-wrap.js';
import { digestCapture } from './site-clients/digest.js';
import { drainFetchTapInjected, installFetchTapInjected } from './dom/fetch-tap-injected.js';
import { listProviderMetadata as listProviders } from '/peerd-provider/metadata.js';
import { costOf } from '/peerd-provider/pricing.js';
import { parseAppManifest } from '/peerd-engine/app-manifest.js';

const REASONING_BUDGET_TOKENS = 2048;
const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
let toolsRegistered = false;

const registerTools = () => {
  if (toolsRegistered) return;
  registerMetadataInventory();
  for (const tool of LEGACY_TOOL_IMPLEMENTATIONS) {
    registerTool(/** @type {any} */ (tool));
  }
  toolsRegistered = true;
};

const projectActorTurnTools = (/** @type {{
 * kind:string,
 * backing?:'tab'|'api',
 * actorSurface?:'code'|'tools',
 * toolManifest?:unknown,
 * runtimeCapabilities:ReturnType<typeof import('./runtime-capabilities.js').resolveRuntimeCapabilities>,
 * inbound?:boolean,
 * }} */ input) => {
  const descriptors = filterByRuntimeCapabilities(filterDescriptorsByManifest(
    actorDescriptors(listToolDescriptors(), input.kind, input.backing, input.actorSurface),
    resolveManifestAllow(input.toolManifest),
  ), input.runtimeCapabilities);
  const inboundTools = new Set(DWEB_INBOUND_TOOL_NAMES);
  return (input.inbound === true && input.kind === 'dweb'
    ? descriptors.filter((descriptor) => inboundTools.has(descriptor.name)) : descriptors)
    .map(projectToolAuthority);
};

// why: T1 makes semantic ownership explicit while preserving the one live call
// path. This owner receives no authority dependencies and can move intact later.
export const createControllerTurnSemantics = () => Object.freeze({
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
  ACTION_CLASSES,
  actorsCallToOp,
  askOutcome,
  actorAllowedToolsFor,
  actorDescriptors,
  applyComposer,
  buildMintInjection,
  buildTemporalBlock,
  canonicalCodeTraceLabel,
  classifyAction,
  confirmActionsFromRecord,
  createSkillRegistry,
  decideAction,
  detectInterruptedTurn,
  dispatchToolCall,
  DOC_TEXT_MAX_CHARS,
  DWEB_INBOUND_TOOL_NAMES,
  EXPOSURE_ACTOR,
  EXPOSURE_REVIEW,
  filterByDwebActive,
  filterByDwebEnabled,
  filterByGoalActive,
  filterByRuntimeCapabilities,
  filterDescriptorsByManifest,
  finalActorTurnReply,
  finalAssistantText,
  formatDocBody,
  getTool,
  getToolDescriptor,
  GOAL_MAX_ITERATIONS,
  isReadOnlyTool,
  limitExceeded,
  listProviders,
  listTools,
  listToolDescriptors,
  localStoreSource,
  mainAgentDescriptors,
  makeAutoMemory,
  makeCheapCall,
  makeInitOrchestrator,
  makeGoalRunner,
  makeRequestReview,
  makeScheduler,
  makeSpawnActor,
  makeToolboxParseCheck,
  makeToolsCommand,
  makeTrimEnricher,
  makeTurnCostTracker,
  makeTurnDriver,
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
  projectToolAuthority,
  registerTools,
  REASONING_BUDGET_TOKENS,
  REASONING_EFFORT_LEVELS,
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
  costOf,
  createSuggestionStore,
  describeLandingStop,
  digestCapture,
  drainFetchTapInjected,
  fenceApiActorSummary,
  fenceWebActorSummary,
  installFetchTapInjected,
  landingStopCard,
  projectActorTurnTools,
  wrapUntrusted,
});
