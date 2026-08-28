// @ts-check

import { applyComposer } from './composer/apply.js';
import { buildMintInjection, resolveSiteUrl } from './site-clients/core.js';
import {
  confirmActionsFromRecord,
  normalizeConfirmActions,
  normalizeMode,
  PERMISSION_MODES,
} from './permissions/policy.js';
import { createSkillRegistry } from './skills/registry.js';
import { DOC_TEXT_MAX_CHARS, prepareUserAttachmentsWithDocs } from './loop/attachments.js';
import { GOAL_MAX_ITERATIONS, makeGoalRunner } from './loop/goal-runner.js';
import { finalActorTurnReply, finalAssistantText, makeSpawnActor } from './actor/spawn.js';
import { formatDocBody } from './doc/format.js';
import { localStoreSource, mergeSources, skillRegistrySource } from './composer/command-sources.js';
import { makeInitOrchestrator } from './memory/init-orchestrator.js';
import { makeScheduler } from './loop/scheduler.js';
import { makeCheapCall } from './actor/cheap-call.js';
import { makeAutoMemory } from './memory/auto-memory-orchestrator.js';
import { createSuggestionStore } from './memory/suggestions.js';
import { makeTrimEnricher } from './loop/summary-enrichment.js';
import { makeToolsCommand } from './tools/manifest-command.js';
import { limitExceeded, normalizeTally } from './cost/accumulator.js';
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

// why: the authority shell has four fixed lifecycle collaborators, not a
// growing feature function bag. Tool/provider definitions and implementations
// remain absent, while each cohesive owner can be reasoned about independently.
export const createControllerTurnSemantics = () => Object.freeze({
  actor: Object.freeze({
    describeLandingStop,
    fenceApiActorSummary,
    fenceWebActorSummary,
    finalActorTurnReply,
    finalAssistantText,
    landingStopCard,
    makeSpawnActor,
    meshCallToOp,
    normalizeApiOrigin,
    originPhrase,
    parseSiteHandle,
    safeWebActorSummaryOrigin,
    shapeMeshResult,
    siteHandleFor,
    wrapUntrusted,
  }),
  policy: Object.freeze({
    PERMISSION_MODES,
    confirmActionsFromRecord,
    limitExceeded,
    normalizeConfirmActions,
    normalizeMode,
    normalizeTally,
  }),
  site: Object.freeze({
    buildMintInjection,
    digestCapture,
    drainFetchTapInjected,
    installFetchTapInjected,
    parseAppManifest,
    resolveSiteUrl,
  }),
  turn: Object.freeze({
    DOC_TEXT_MAX_CHARS,
    GOAL_MAX_ITERATIONS,
    applyComposer,
    createSkillRegistry,
    createSuggestionStore,
    formatDocBody,
    localStoreSource,
    makeAutoMemory,
    makeCheapCall,
    makeGoalRunner,
    makeInitOrchestrator,
    makeScheduler,
    makeToolsCommand,
    makeTrimEnricher,
    mergeSources,
    prepareUserAttachmentsWithDocs,
    skillRegistrySource,
  }),
});
