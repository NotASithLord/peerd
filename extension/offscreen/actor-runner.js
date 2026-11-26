// @ts-check
// offscreen/actor-runner.js — hosts EVERY offscreen agent loop in dedicated Workers
// (the heap split): ephemeral spawned reasoners AND bound actors alike (a reasoning
// child just carries no tools, so its worker never prepares a tool). Forks one
// Worker per turn, relays exact model-authority stream requests and tool-dispatch
// requests to the SW, forwards loop events, and resolves with the turn result.

import { ACTOR_WORKER_PROTOCOL, ACTOR_WORKER_STARTUP_MS, validActorWorkerRealm } from '/shared/actor-worker-protocol.js';
import {
  AGENT_PROGRAM,
  describeExecution,
} from '/shared/execution-protocol.js';
import {
  registerPageProgramSemanticOwner,
  releasePageProgramSemanticOwner,
  settlePageProgramSemanticResponse,
} from './page-program-semantic-owner.js';
import {
  registerAppProgramSemanticOwner,
  releaseAppProgramSemanticOwner,
  settleAppProgramSemanticResponse,
} from './app-program-semantic-owner.js';
import { parseContributorProjection } from '/shared/contributor-channel.js';
import { structuredClonePayloadBytes } from '/shared/structured-clone-size.js';
import { ACTOR_LOOP_EVENT_BYTES } from '/shared/actor-channel-protocol.js';
import { createEarlyAbortBuffer } from './early-aborts.js';

const MAX_CONCURRENT = 4;
let active = 0;
let seq = 0;
/** @type {Map<string, { worker: Worker, stop: () => void }>} */
const liveWorkers = new Map();
// actor/abort can beat actor/run while the offscreen command messages cross.
// Keep a short, bounded tombstone so that ordering race cannot launch a Worker
// after Stop. Run ids are SW-minted and never reused intentionally.
const earlyAborts = createEarlyAbortBuffer();
const rememberEarlyAbort = earlyAborts.remember;
const consumeEarlyAbort = earlyAborts.consume;
const MIB = 1024 * 1024;
const ACTOR_MODEL_MESSAGE_BYTES = 32 * MIB;
const ACTOR_EFFECT_MESSAGE_BYTES = 20 * MIB;
const ACTOR_RESULT_MESSAGE_BYTES = 2 * MIB;

const actorWorkerMessageLimit = (/** @type {unknown} */ type) =>
  type === 'loop-event' ? ACTOR_LOOP_EVENT_BYTES
    : type === 'done' || type === 'actor-call-complete-request'
      ? ACTOR_RESULT_MESSAGE_BYTES
      : type === 'model-open-inference-request' || type === 'model-open-local-request'
        ? ACTOR_MODEL_MESSAGE_BYTES : ACTOR_EFFECT_MESSAGE_BYTES;

// Table-driven exact-tool relay specs: maps worker `<name>-request` messages
// to their SW authority route, semantic operation, forwarded fields, and
// result-observation flag so every relay shares one audited forwarding path.
/** @type {Readonly<Record<string, readonly any[]>>} */
const EXACT_TOOL_RELAYS = Object.freeze({
  'actor-spawn-sync-request': Object.freeze(['actor/spawn-sync', 'turn.actor.spawn-sync', ['task', 'allowRecursion', 'grantedToolNames', 'grantedOperations'], ['tools', 'maxSteps', 'maxDepth']]),
  'actor-spawn-async-request': Object.freeze(['actor/spawn-async', 'turn.actor.spawn-async', ['task', 'allowRecursion', 'grantedToolNames', 'grantedOperations'], ['tools', 'maxSteps', 'maxDepth']]),
  'actor-tasks-read-request': Object.freeze(['actor/tasks-read', 'turn.actor.tasks', []]),
  'actor-task-cancel-request': Object.freeze(['actor/task-cancel', 'turn.actor.cancel', ['taskId']]),
  'actor-message-deliver-request': Object.freeze(['actor/message-deliver', 'turn.actor.message', ['to', 'message', 'oneShot', 'awaitReply', 'degradeToAsync', 'awaitCapMs']]),
  'pod-resolve-request': Object.freeze(['pod/resolve', 'turn.pod.resolve', ['podId'], [], ['command']]),
  'pod-read-remote-request': Object.freeze(['pod/read-remote', 'turn.pod.read-remote', ['podId']]),
  'pod-confirm-git-request': Object.freeze(['pod/confirm-git', 'turn.pod.confirm-git', ['op']]),
  'pod-exec-request': Object.freeze(['pod/exec', 'turn.pod.exec', ['command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant'], [], [], [], true]),
  'pod-status-request': Object.freeze(['pod/status', 'turn.pod.status', ['podId', 'jobId', 'stream', 'offset', 'limit']]),
  'pod-cancel-request': Object.freeze(['pod/cancel', 'turn.pod.cancel', ['podId', 'jobId']]),
  'pod-read-file-request': Object.freeze(['pod/read-file', 'turn.pod.read-file', ['podId', 'path']]),
  'pod-write-file-request': Object.freeze(['pod/write-file', 'turn.pod.write-file', ['podId', 'path', 'content'], [], [], [], true]),
  'repository-read-pod-request': Object.freeze(['repository/read-pod', 'turn.repository.read-pod', ['podId']]),
  'repository-destroy-pod-request': Object.freeze(['repository/destroy-pod', 'turn.repository.destroy-pod', ['podId'], [], [], [], true]),
  'repository-read-status-request': Object.freeze(['repository/read-status', 'turn.repository.read-status', []]),
  'repository-read-history-request': Object.freeze(['repository/read-history', 'turn.repository.read-history', ['depth']]),
  'repository-read-remote-request': Object.freeze(['repository/read-remote', 'turn.repository.read-remote', []]),
  'repository-read-diff-request': Object.freeze(['repository/read-diff', 'turn.repository.read-diff', ['from', 'to']]),
  'repository-confirm-restore-request': Object.freeze(['repository/confirm-restore', 'turn.repository.confirm-restore', ['to']]),
  'repository-checkpoint-request': Object.freeze(['repository/checkpoint', 'turn.repository.checkpoint', ['message'], [], [], [], true]),
  'repository-branch-request': Object.freeze(['repository/branch', 'turn.repository.branch', ['name'], [], [], [], true]),
  'repository-checkout-request': Object.freeze(['repository/checkout', 'turn.repository.checkout', ['name'], [], [], [], true]),
  'repository-restore-request': Object.freeze(['repository/restore', 'turn.repository.restore', ['to'], [], [], [], true]),
  'repository-confirm-remote-request': Object.freeze(['repository/confirm-remote', 'turn.repository.confirm-remote', ['op', 'target', 'branch'], [], ['url']]),
  'repository-link-request': Object.freeze(['repository/link', 'turn.repository.link', ['url'], [], [], [], true]),
  'repository-fetch-request': Object.freeze(['repository/fetch', 'turn.repository.fetch', ['target'], [], [], [], true]),
  'repository-push-request': Object.freeze(['repository/push', 'turn.repository.push', ['target', 'branch'], [], [], [], true]),
  'vm-read-request': Object.freeze(['vm/read', 'turn.vm.read', ['vmId']]),
  'vm-list-request': Object.freeze(['vm/list', 'turn.vm.list', []]),
  'vm-set-default-request': Object.freeze(['vm/set-default', 'turn.vm.set-default', ['vmId']]),
  'vm-run-request': Object.freeze(['vm/run', 'turn.vm.run', ['command', 'timeoutMs', 'vmId'], [], [], [], true]),
  'vm-import-file-request': Object.freeze(['vm/import-file', 'turn.vm.import-file', ['url', 'path', 'maxBytes'], [], [], [], true]),
  'vm-write-text-file-request': Object.freeze(['vm/write-text-file', 'turn.vm.write-text-file', ['path', 'content'], [], [], [], true]),
  'vm-destroy-request': Object.freeze(['vm/destroy', 'turn.vm.destroy', ['vmId'], [], [], [], true]),
  'notebook-read-request': Object.freeze(['notebook/read', 'turn.notebook.read', ['notebookId']]),
  'notebook-list-request': Object.freeze(['notebook/list', 'turn.notebook.list', []]),
  'notebook-set-default-request': Object.freeze(['notebook/set-default', 'turn.notebook.set-default', ['notebookId']]),
  'notebook-run-request': Object.freeze(['notebook/run', 'turn.notebook.run', ['code', 'timeoutMs', 'notebookId'], [], [], [], true]),
  'notebook-write-file-request': Object.freeze(['notebook/write-file', 'turn.notebook.write-file', ['path', 'content', 'notebookId'], [], [], [], true]),
  'notebook-read-file-request': Object.freeze(['notebook/read-file', 'turn.notebook.read-file', ['path', 'notebookId']]),
  'notebook-destroy-request': Object.freeze(['notebook/destroy', 'turn.notebook.destroy', ['notebookId'], [], [], [], true]),
  'app-update-request': Object.freeze(['app/update', 'turn.app.update', ['appId', 'name', 'html', 'tags', 'entryFile'], [], [], [], true]),
  'app-open-request': Object.freeze(['app/open', 'turn.app.open', ['appId'], [], [], [], true]),
  'app-search-request': Object.freeze(['app/search', 'turn.app.search', ['query']]),
  'app-read-request': Object.freeze(['app/read', 'turn.app.read', ['appId']]),
  'app-delete-request': Object.freeze(['app/delete', 'turn.app.delete', ['appId'], [], [], [], true]),
  'app-write-file-request': Object.freeze(['app/write-file', 'turn.app.write-file', ['appId', 'path', 'content'], [], [], [], true]),
  'app-read-file-request': Object.freeze(['app/read-file', 'turn.app.read-file', ['appId', 'path']]),
  'app-list-files-request': Object.freeze(['app/list-files', 'turn.app.list-files', ['appId']]),
  'app-delete-file-request': Object.freeze(['app/delete-file', 'turn.app.delete-file', ['appId', 'path'], [], [], [], true]),
  'app-observe-request': Object.freeze(['app/observe', 'turn.app.observe', []]),
  'app-act-request': Object.freeze(['app/act', 'turn.app.act', ['action', 'params'], [], [], [], true]),
  'memory-read-scope-request': Object.freeze(['memory/read-scope', 'turn.memory.read-scope', ['scope']]),
  'memory-read-subtree-request': Object.freeze(['memory/read-subtree', 'turn.memory.read-subtree', ['workspace', 'subpath']]),
  'memory-write-request': Object.freeze(['memory/write', 'turn.memory.write', ['scope', 'body'], [], [], [], true]),
  'todo-read-request': Object.freeze(['todo/read', 'turn.todo.read', []]),
  'todo-replace-request': Object.freeze(['todo/replace', 'turn.todo.replace', ['version', 'todos'], [], [], [], true]),
  'page-open-tab-request': Object.freeze(['page/open-tab', 'turn.page.open-tab', ['args'], [], [], [], true]),
  'page-read-request': Object.freeze(['page/read', 'turn.page.read', ['args']]),
  'page-snapshot-request': Object.freeze(['page/snapshot', 'turn.page.snapshot', ['args']]),
  'page-read-state-request': Object.freeze(['page/read-state', 'turn.page.read-state', ['args']]),
  'page-watch-changes-request': Object.freeze(['page/watch-changes', 'turn.page.watch-changes', ['args']]),
  'page-query-dom-request': Object.freeze(['page/query-dom', 'turn.page.query-dom', ['args']]),
  'page-navigate-request': Object.freeze(['page/navigate', 'turn.page.navigate', ['args'], [], [], [], true]),
  'page-fill-request': Object.freeze(['page/fill', 'turn.page.fill', ['args'], [], [], [], true]),
  'page-click-request': Object.freeze(['page/click', 'turn.page.click', ['args'], [], [], [], true]),
  'page-login-request': Object.freeze(['page/login', 'turn.page.login', ['args'], [], [], [], true]),
  'page-capture-foreground-request': Object.freeze(['page/capture-foreground', 'turn.page.capture-foreground', ['args']]),
  'page-capture-owned-request': Object.freeze(['page/capture-owned', 'turn.page.capture-owned', ['args']]),
  'resource-confirm-web-write-request': Object.freeze(['resource/confirm-web-write', 'turn.resource.confirm-web-write', ['url', 'method', 'headers', 'body'], [], [], [], true]),
  'resource-request-web-text-request': Object.freeze(['resource/request-web-text', 'turn.resource.request-web-text', ['url', 'method', 'headers', 'body'], [], [], [], true]),
  'resource-extract-markdown-request': Object.freeze(['resource/extract-markdown', 'turn.resource.extract-markdown', ['html', 'url']]),
  'resource-extract-document-request': Object.freeze(['resource/extract-document', 'turn.resource.extract-document', ['url', 'format', 'engine']]),
  'resource-spill-result-request': Object.freeze(['resource/spill-result', 'turn.resource.spill-result', ['url', 'format', 'text', 'producer', 'fenced', 'originLabel'], [], [], [], true]),
  'resource-read-result-request': Object.freeze(['resource/read-result', 'turn.resource.read-result', ['key']]),
  'site-client-read-request': Object.freeze(['site-client/read', 'turn.site-client.read', ['origin']]),
  'site-client-run-request': Object.freeze(['site-client/run', 'turn.site-client.run', ['origin', 'timeoutMs'], ['code', 'mode', 'clientOperation', 'input', 'revision'], [], [], true]),
  'site-client-commit-request': Object.freeze(['site-client/commit', 'turn.site-client.commit', ['origin'], ['auth', 'deriver', 'operations', 'validationCases'], ['summary', 'body'], ['endpoints'], true]),
  'site-client-capture-start-request': Object.freeze(['site-client/capture-start', 'turn.site-client.capture-start', [], [], [], [], true]),
  'site-client-capture-stop-request': Object.freeze(['site-client/capture-stop', 'turn.site-client.capture-stop', [], [], [], [], true]),
  'execution-create-webvm-request': Object.freeze(['execution/create-webvm', 'turn.execution.create-webvm', ['plan'], [], [], [], true]),
  'execution-create-notebook-request': Object.freeze(['execution/create-notebook', 'turn.execution.create-notebook', ['plan'], [], [], [], true]),
  'execution-create-pod-request': Object.freeze(['execution/create-pod', 'turn.execution.create-pod', ['plan'], [], [], [], true]),
  'execution-create-app-request': Object.freeze(['execution/create-app', 'turn.execution.create-app', ['plan'], [], [], [], true]),
  'execution-run-script-request': Object.freeze(['execution/run-script', 'turn.execution.run-script', ['code', 'actors', 'provider', 'workspace', 'timeoutMs'], [], [], [], true]),
  'execution-spill-script-request': Object.freeze(['execution/spill-script', 'turn.execution.spill-script', ['text', 'fenced', 'originLabel'], [], [], [], true]),
  'editing-read-target-request': Object.freeze(['editing/read-target', 'turn.editing.read-target', ['kind', 'targetId', 'path']]),
  'editing-write-target-request': Object.freeze(['editing/write-target', 'turn.editing.write-target', ['kind', 'targetId', 'path', 'content'], [], [], [], true]),
  'introspection-actor-roster-request': Object.freeze(['introspection/actor-roster', 'turn.introspection.actor-roster', []]),
  'introspection-provider-posture-request': Object.freeze(['introspection/provider-posture', 'turn.introspection.provider-posture', []]),
  'introspection-storage-snapshot-request': Object.freeze(['introspection/storage-snapshot', 'turn.introspection.storage-snapshot', ['prefix']]),
  'introspection-automatable-tabs-request': Object.freeze(['introspection/automatable-tabs', 'turn.introspection.automatable-tabs', []]),
  'introspection-denylist-patterns-request': Object.freeze(['introspection/denylist-patterns', 'turn.introspection.denylist-patterns', []]),
  'introspection-audit-entries-request': Object.freeze(['introspection/audit-entries', 'turn.introspection.audit-entries', []]),
  'introspection-installed-skill-request': Object.freeze(['introspection/installed-skill', 'turn.introspection.installed-skill', ['name']]),
  'schedule-read-routines-request': Object.freeze(['schedule/read-routines', 'turn.schedule.read-routines', []]),
  'schedule-arm-confirmed-routine-request': Object.freeze(['schedule/arm-confirmed-routine', 'turn.schedule.arm-confirmed-routine', ['prompt', 'every', 'dailyAt', 'mode'], [], [], [], true]),
  'schedule-cancel-routine-request': Object.freeze(['schedule/cancel-routine', 'turn.schedule.cancel-routine', ['id'], [], [], [], true]),
  'dweb-discover-apps-request': Object.freeze(['dweb/discover-apps', 'turn.dweb.discover-apps', []]),
  'dweb-publish-confirmed-app-request': Object.freeze(['dweb/publish-confirmed-app', 'turn.dweb.publish-confirmed-app', ['appId'], [], [], [], true]),
  'dweb-install-confirmed-app-request': Object.freeze(['dweb/install-confirmed-app', 'turn.dweb.install-confirmed-app', ['uri', 'name'], [], [], [], true]),
  'dweb-read-peers-request': Object.freeze(['dweb/read-peers', 'turn.dweb.read-peers', []]),
  'dweb-set-peer-blocked-request': Object.freeze(['dweb/set-peer-blocked', 'turn.dweb.set-peer-blocked', ['did', 'block', 'reason'], [], [], [], true]),
  'dweb-set-discovery-enabled-request': Object.freeze(['dweb/set-discovery-enabled', 'turn.dweb.set-discovery-enabled', ['enabled'], [], [], [], true]),
  'dweb-run-mesh-program-request': Object.freeze(['dweb/run-mesh-program', 'turn.dweb.run-mesh-program', ['code', 'timeoutMs'], [], [], [], true]),
});

/** @param {unknown} message */
export const actorWorkerMessageFits = (message) => {
  if (!message || typeof message !== 'object') return false;
  const typeDescriptor = Object.getOwnPropertyDescriptor(message, 'type');
  const type = typeDescriptor && 'value' in typeDescriptor
    ? typeDescriptor.value : undefined;
  if (typeof type !== 'string') return false;
  const bytes = structuredClonePayloadBytes(message, {
    maxDepth: type === 'loop-event' ? 16 : 32,
    maxNodes: type === 'loop-event' ? 4_096 : 250_000,
  });
  return Number.isFinite(bytes) && bytes <= actorWorkerMessageLimit(type);
};
/**
 * Project the actor-specific job into the host-neutral execution description.
 * Tool descriptors still ride beside it for the model; SW grants remain the
 * sole authority and never come from this worker-visible data.
 * @param {any} job
 * @param {string} executionId
 */
export const describeActorExecution = (job, executionId) => describeExecution({
  id: executionId,
  program: {
    kind: AGENT_PROGRAM,
    systemPrompt: job.systemPrompt,
    provider: job.provider,
    model: job.model,
    maxSteps: job.maxSteps,
    maxOutputTokens: job.maxOutputTokens,
    reasoningEnabled: job.reasoningEnabled,
    reasoningEffort: job.reasoningEffort,
    contextWindowOverrides: job.contextWindowOverrides,
    pricingOverrides: job.pricingOverrides,
  },
  input: job.message,
  state: {
    messages: Array.isArray(job.priorMessages) ? job.priorMessages : [],
    ...(job.trimSummary && typeof job.trimSummary === 'object'
      ? { trimSummary: job.trimSummary } : {}),
  },
  capabilities: [
    'model',
    ...(Array.isArray(job.tools)
      ? job.tools.flatMap((/** @type {{ name?: unknown }} */ tool) =>
        typeof tool?.name === 'string' && tool.name ? [tool.name] : [])
      : []),
  ],
  metadata: {
    sessionId: job.actorSessionId,
    depth: job.depth,
    oneShot: job.oneShot === true,
    actorType: job.actorType,
    instanceId: job.instanceId,
    actorSurface: job.actorSurface,
    recordKind: job.recordKind,
    turnGeneration: job.turnGeneration,
    backing: job.backing,
    tabOrigin: job.tabOrigin,
    origin: job.origin,
    inbound: job.inbound === true,
    preflightReply: job.preflightReply,
  },
});

/**
 * Carry the controller-minted call identity unchanged to the authority host.
 * The SW validates every field against the run grant before doing any work.
 * @param {any} message
 * @param {string} operation
 */
const exactEffectBinding = (message, operation) => ({
  operation,
  callId: message.callId,
  effectId: message.effectId,
  effectSequence: message.effectSequence,
  turnGeneration: message.turnGeneration,
  ...(typeof message.parentCallId === 'string'
    ? { parentCallId: message.parentCallId }
    : {}),
});

/** @param {string} runId */
export const abortActor = (runId) => {
  const live = liveWorkers.get(runId);
  if (live) {
    try { live.worker.postMessage({ type: 'abort' }); } catch { /* gone */ }
    live.stop();
  }
  else rememberEarlyAbort(runId);
};

/**
 * Run one BOUND-actor turn in a dedicated Worker.
 * @param {{ runId?: string, relayToken?: string, turnGeneration?: string, actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], programTools?:any[], programOperations?:string[], priorMessages?: any[], reasoningEnabled?: boolean, reasoningEffort?: string, contextWindowOverrides?:Record<string,number>, runtimeCapabilities?: object, budgetMs?: number, oneShot?: boolean, actorType?: string, instanceId?:string, actorSurface?:'tools'|'code', recordKind?:'actor'|'spawned', backing?: string, tabOrigin?: string, origin?: string, inbound?: boolean, preflightReply?: string, semanticPolicy?:object }} job
 * @param {{ workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any>, onRelayDrain?: () => void, createWorker?: (url: string) => Worker, startupMs?: number, relayDrainMs?: number, maxLoopEvents?: number }} deps
 * @returns {Promise<{ ok: boolean, started?: boolean, phase?: string, code?: string, finalText?: string, newMessages?: any[], usage?: object, price?:{cost:number,estimated:boolean}, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean, performed?: boolean, outcomeKnown?: boolean, retryable?: boolean, contributor?:{providerCode:number,modelFamilyCode:number,outcome:string,failure:string,actions:string[]} }>}
 */
export const runActor = async (job, {
  workerUrl,
  sendToSW,
  onRelayDrain = () => {},
  createWorker = (url) => new Worker(url, { type: 'module' }),
  startupMs = ACTOR_WORKER_STARTUP_MS,
  relayDrainMs = 5_000,
  maxLoopEvents = 256,
}) => {
  const runId = job.runId ?? `aw-${++seq}`;
  if (consumeEarlyAbort(runId)) {
    return {
      ok: false, started: true, phase: 'startup', code: 'actor_run_aborted',
      aborted: true, error: 'actor aborted before worker start',
    };
  }
  if (active >= MAX_CONCURRENT) return {
    ok: false, started: false, phase: 'admission', code: 'actor_worker_busy',
    error: `actor worker rejected: ${MAX_CONCURRENT} already running`,
  };
  const execution = describeActorExecution(job, runId);
  active++;
  // The SW-minted relay grant for this run. It stays in THIS scope — never posted to
  // the Worker — so the untrusted heap can't lift it, and every relay below carries it
  // as proof of which run is speaking. The SW derives the run + session from it and
  // ignores whatever the payload claims.
  const relayToken = job.relayToken;
  const budgetMs = Number.isFinite(job.budgetMs) && /** @type {number} */ (job.budgetMs) > 0 ? /** @type {number} */ (job.budgetMs) : 10 * 60_000;
  const loopEventLimit = Number.isFinite(maxLoopEvents) && maxLoopEvents > 0
    ? Math.floor(maxLoopEvents) : 256;
  /** @type {Worker | null} */
  let worker = null;
  const canaryName = `__peerd_actor_host_${Math.random().toString(36).slice(2)}`;
  const canaryValue = Object.freeze({});
  try {
    Object.defineProperty(globalThis, canaryName, { value: canaryValue, configurable: true });
    worker = createWorker(workerUrl);
    const w = worker;
    return await new Promise((resolve) => {
      let settled = false;
      let started = false;
      let relayedToolRequests = 0;
      let relayedAuthorityEffects = 0;
      let relayedUnknown = false;
      /** @type {boolean | undefined} */
      let relayedPerformed = undefined;
      let pendingToolRelays = 0;
      let pendingModelRelays = 0;
      let relayedLoopEvents = 0;
      /** @type {string|null} */
      let pageProgramSemanticToken = null;
      /** @type {string|null} */
      let appProgramSemanticToken = null;
      let relayedModelUnknown = false;
      /** @type {string | null} */
      let relayedModelFailure = null;
      /** @type {any} */
      let terminal = null;
      /** @type {'awaiting-ready'|'awaiting-probe'|'ready'} */
      let readiness = 'awaiting-ready';
      let budgetTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
      let relayDrainTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
      const probeId = `probe-${runId}`;
      const finish = (/** @type {any} */ value) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (budgetTimer) clearTimeout(budgetTimer);
        if (relayDrainTimer) clearTimeout(relayDrainTimer);
        if (pageProgramSemanticToken) {
          releasePageProgramSemanticOwner(pageProgramSemanticToken);
          pageProgramSemanticToken = null;
        }
        if (appProgramSemanticToken) {
          releaseAppProgramSemanticOwner(appProgramSemanticToken);
          appProgramSemanticToken = null;
        }
        try { w.terminate(); } catch { /* gone */ }
        try { delete globalThis[/** @type {keyof typeof globalThis} */ (canaryName)]; } catch { /* best effort */ }
        const contributor = job.actorType === 'web' && job.backing === 'tab'
          ? parseContributorProjection(value?.contributor) : null;
        if (!Object.hasOwn(value ?? {}, 'contributor')) resolve(value);
        else {
          const { contributor: _untrustedContributor, ...settledValue } = value;
          resolve(contributor ? { ...settledValue, contributor } : settledValue);
        }
      };
      const settleTerminal = () => {
        if (!terminal || pendingToolRelays > 0 || pendingModelRelays > 0) return;
        if (relayedUnknown) {
          finish({
            ok: false, started: true,
            code: 'actor_tool_outcome_unknown',
            error: 'outcome_unknown: Verify the target before retrying.',
            finalText: terminal.finalText ?? '', newMessages: terminal.newMessages ?? [],
            usage: terminal.usage, price: terminal.price, stopReason: terminal.stopReason,
            toolCalls: relayedToolRequests,
            ...(relayedPerformed === true ? { performed: true } : {}),
            outcomeKnown: false, retryable: false,
          });
          return;
        }
        if (relayedModelUnknown) {
          finish({
            ok: false, started: true,
            code: 'actor_model_outcome_unknown',
            error: 'outcome_unknown: Verify before retrying.',
            finalText: terminal.finalText ?? '', newMessages: terminal.newMessages ?? [],
            usage: terminal.usage, price: terminal.price, stopReason: terminal.stopReason,
            toolCalls: relayedToolRequests,
            ...(relayedPerformed === true ? { performed: true } : {}),
            outcomeKnown: false, retryable: false,
          });
          return;
        }
        if (relayedModelFailure && terminal.ok) {
          terminal = { ...terminal, ok: false, error: relayedModelFailure, outcomeKnown: true };
        }
        finish(relayedToolRequests > 0 || relayedAuthorityEffects > 0
          ? {
              ...terminal,
              ...(typeof relayedPerformed === 'boolean' ? { performed: relayedPerformed } : {}),
              outcomeKnown: terminal.outcomeKnown !== false,
            }
          : terminal);
      };
      const requestFinish = (/** @type {any} */ value) => {
        if (settled || terminal) return;
        terminal = value;
        clearTimeout(startupTimer);
        if (budgetTimer) clearTimeout(budgetTimer);
        if (pendingToolRelays > 0 || pendingModelRelays > 0) {
          relayDrainTimer = setTimeout(() => {
            const toolUnknown = pendingToolRelays > 0 || relayedUnknown;
            finish({
              ok: false, started: true,
              code: toolUnknown ? 'actor_tool_outcome_unknown' : 'actor_model_outcome_unknown',
              error: toolUnknown
                ? 'outcome_unknown: Verify the target before retrying.'
                : 'outcome_unknown: Verify before retrying.',
              finalText: terminal?.finalText ?? '', newMessages: terminal?.newMessages ?? [],
              usage: terminal?.usage, stopReason: terminal?.stopReason,
              toolCalls: relayedToolRequests,
              ...(relayedPerformed === true ? { performed: true } : {}),
              outcomeKnown: false, retryable: false,
            });
          }, Math.max(1, relayDrainMs));
          try { onRelayDrain(); } catch { /* host watchdog is best-effort */ }
        }
        settleTerminal();
      };
      const protocolFailure = (/** @type {string} */ error) => requestFinish({
        ok: false, started, phase: started ? 'run' : 'startup',
        code: 'actor_worker_protocol_error', error,
      });
      const relayExactToolMessage = async (
        /** @type {any} */ message,
        /** @type {string} */ responseType,
        /** @type {()=>Promise<any>} */ send,
        /** @type {{countCall?:boolean,observeResult?:boolean}} */ options = {},
      ) => {
        if (options.countCall) relayedToolRequests += 1;
        pendingToolRelays += 1;
        try {
          const reply = await send();
          const authorityReceipt = reply?.value?.authorityReceipt
            ?? reply?.authorityReceipt ?? null;
          if (authorityReceipt && typeof authorityReceipt === 'object') {
            relayedAuthorityEffects += 1;
            if (authorityReceipt.outcomeKnown === false
                || authorityReceipt.outcome === 'unknown') relayedUnknown = true;
            if (authorityReceipt.performed === true) relayedPerformed = true;
            else if (relayedPerformed !== true) relayedPerformed = false;
          }
          const result = options.observeResult ? reply?.result : undefined;
          if (!authorityReceipt
              && (reply?.outcomeKnown === false || result?.outcomeKnown === false)) {
            relayedUnknown = true;
          }
          if (options.observeResult && !authorityReceipt) {
            const performed = typeof reply?.performed === 'boolean'
              ? reply.performed
              : typeof result?.performed === 'boolean'
                ? result.performed
                : reply?.ok === true && result?.ok === true
                  ? true
                  : reply?.ok === false && reply?.outcomeKnown !== false
                    ? false
                    : undefined;
            if (performed === true || (performed === false && relayedPerformed !== true)) {
              relayedPerformed = performed;
            }
          }
          if (!terminal) w.postMessage({ type: responseType, rid: message.rid, reply });
        } catch (cause) {
          const detail = /** @type {{message?:string,code?:string,outcomeKnown?:boolean,performed?:boolean}} */ (cause);
          relayedUnknown ||= detail?.outcomeKnown !== true;
          if (detail?.performed === true
              || (detail?.performed === false && relayedPerformed !== true)) {
            relayedPerformed = detail.performed;
          }
          if (!terminal) w.postMessage({
            type: responseType, rid: message.rid,
            reply: {
              ok: false, error: detail?.message ?? String(cause),
              ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
              outcomeKnown: detail?.outcomeKnown === true,
              ...(typeof detail?.performed === 'boolean' ? { performed: detail.performed } : {}),
              ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
            },
          });
        } finally {
          pendingToolRelays -= 1;
          settleTerminal();
        }
      };
      const startupTimer = setTimeout(() => requestFinish({
        ok: false, started: false, phase: 'startup',
        code: 'actor_worker_start_timeout', error: `actor worker did not become ready within ${startupMs}ms`,
      }), startupMs);
      liveWorkers.set(runId, {
        worker: w,
        stop: () => requestFinish(started
          ? {
              ok: true, started: true, phase: 'run', finalText: '', newMessages: [],
              stopReason: 'aborted', toolCalls: relayedToolRequests,
            }
          : {
              ok: false, started: false, phase: 'startup', code: 'actor_run_aborted',
              error: 'actor aborted before worker start', outcomeKnown: true,
            }),
      });

      w.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
        const m = /** @type {any} */ (ev.data);
        if (!m || typeof m !== 'object') return;
        // why: the actor Worker is the untrusted semantic heap. Reject before a
        // second structured clone to the SW so one sparse/deep/shared-backed
        // message cannot turn a small relay-count budget into unbounded memory.
        if (!actorWorkerMessageFits(m)) {
          protocolFailure('actor worker message exceeds its structured-clone boundary');
          return;
        }
        if (pageProgramSemanticToken
            && settlePageProgramSemanticResponse(pageProgramSemanticToken, m)) return;
        if (appProgramSemanticToken
            && settleAppProgramSemanticResponse(appProgramSemanticToken, m)) return;
        if (m.type === 'ready') {
          if (readiness !== 'awaiting-ready' || m.protocol !== ACTOR_WORKER_PROTOCOL || !validActorWorkerRealm(m.realm)) {
            protocolFailure('actor worker returned an invalid readiness proof');
            return;
          }
          readiness = 'awaiting-probe';
          w.postMessage({ type: 'probe', protocol: ACTOR_WORKER_PROTOCOL, rid: probeId, canaryName });
          return;
        }
        if (m.type === 'probe-response') {
          if (readiness !== 'awaiting-probe' || m.protocol !== ACTOR_WORKER_PROTOCOL || m.rid !== probeId
              || m.canaryAbsent !== true || !validActorWorkerRealm(m.realm)
              || m.prototypeFetchBlocked !== true || m.prototypeStorageBlocked !== true
              || globalThis[/** @type {keyof typeof globalThis} */ (canaryName)] !== canaryValue) {
            protocolFailure('actor worker failed the separate-realm probe');
            return;
          }
          readiness = 'ready';
          clearTimeout(startupTimer);
          if (job.probeOnly === true) {
            requestFinish({
              ok: true, started: false, phase: 'startup', code: 'actor_worker_ready',
              workerType: 'dedicated', realmVerified: true, extensionApisPresent: false,
            });
            return;
          }
          budgetTimer = setTimeout(() => requestFinish({
            ok: false, started: true, phase: 'run', code: 'actor_worker_timeout', aborted: true,
            error: `actor timed out after ${budgetMs}ms`,
          }), budgetMs);
          started = true;
          w.postMessage({
            type: 'run', execution, tools: job.tools ?? [],
            programTools: job.programTools ?? [],
            runtimeCapabilities: job.runtimeCapabilities,
            semanticPolicy: job.semanticPolicy,
          });
          return;
        }
        if (readiness !== 'ready') {
          protocolFailure(`actor worker sent '${String(m.type)}' before readiness`);
          return;
        }
        if (terminal) return;
        if (m.type === 'model-open-inference-request') {
          pendingModelRelays += 1;
          try {
            const resp = await sendToSW('actor/model-open-inference', {
              ...(relayToken ? { relayToken } : {}),
              providerId: m.providerId,
              modelId: m.modelId,
              nativeBody: m.nativeBody,
            });
            if (resp?.outcomeKnown === false) relayedModelUnknown = true;
            if (!resp?.ok) relayedModelFailure ??= resp?.error ?? 'model inference open failed';
            if (!terminal) w.postMessage({
              type: 'model-open-inference-response', rid: m.rid, reply: resp,
            });
          } catch (e) {
            const detail = /** @type {{ message?: string, outcomeKnown?: boolean }} */ (e);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            relayedModelFailure ??= detail?.message ?? String(e);
            if (!terminal) w.postMessage({
              type: 'model-open-inference-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(e),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-read-inference-chunk-request') {
          pendingModelRelays += 1;
          try {
            const resp = await sendToSW('actor/model-read-inference-chunk', {
              ...(relayToken ? { relayToken } : {}), streamId: m.streamId,
            });
            if (resp?.outcomeKnown === false) relayedModelUnknown = true;
            if (!resp?.ok) relayedModelFailure ??= resp?.error ?? 'model inference read failed';
            if (!terminal) w.postMessage({
              type: 'model-read-inference-chunk-response', rid: m.rid, reply: resp,
            });
          } catch (e) {
            const detail = /** @type {{ message?: string, outcomeKnown?: boolean }} */ (e);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            relayedModelFailure ??= detail?.message ?? String(e);
            if (!terminal) w.postMessage({
              type: 'model-read-inference-chunk-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(e),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-cancel-inference-request') {
          pendingModelRelays += 1;
          try {
            const resp = await sendToSW('actor/model-cancel-inference', {
              ...(relayToken ? { relayToken } : {}), streamId: m.streamId,
            });
            if (resp?.outcomeKnown === false) relayedModelUnknown = true;
            if (!resp?.ok) relayedModelFailure ??= resp?.error ?? 'model inference cancel failed';
            if (!terminal) w.postMessage({
              type: 'model-cancel-inference-response', rid: m.rid, reply: resp,
            });
          } catch (e) {
            const detail = /** @type {{ message?: string, outcomeKnown?: boolean }} */ (e);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            relayedModelFailure ??= detail?.message ?? String(e);
            if (!terminal) w.postMessage({
              type: 'model-cancel-inference-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(e),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-read-context-request') {
          pendingModelRelays += 1;
          try {
            const reply = await sendToSW('actor/model-read-context', {
              ...(relayToken ? { relayToken } : {}),
              providerId: m.providerId,
              modelId: m.modelId,
            });
            if (reply?.outcomeKnown === false) relayedModelUnknown = true;
            if (!terminal) w.postMessage({
              type: 'model-read-context-response', rid: m.rid, reply,
            });
          } catch (cause) {
            const detail = /** @type {{message?:string,outcomeKnown?:boolean}} */ (cause);
            if (!terminal) w.postMessage({
              type: 'model-read-context-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(cause),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-open-local-request') {
          pendingModelRelays += 1;
          try {
            const reply = await sendToSW('actor/model-open-local', {
              ...(relayToken ? { relayToken } : {}),
              providerId: m.providerId,
              modelId: m.modelId,
              messages: m.messages,
              system: m.system,
              tools: m.tools,
              maxTokens: m.maxTokens,
            });
            if (reply?.outcomeKnown === false) relayedModelUnknown = true;
            if (!reply?.ok) relayedModelFailure ??= reply?.error ?? 'local model open failed';
            if (!terminal) w.postMessage({
              type: 'model-open-local-response', rid: m.rid, reply,
            });
          } catch (cause) {
            const detail = /** @type {{message?:string,outcomeKnown?:boolean}} */ (cause);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            if (!terminal) w.postMessage({
              type: 'model-open-local-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(cause),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-read-local-request') {
          pendingModelRelays += 1;
          try {
            const reply = await sendToSW('actor/model-read-local', {
              ...(relayToken ? { relayToken } : {}), streamId: m.streamId,
            });
            if (reply?.outcomeKnown === false) relayedModelUnknown = true;
            if (!reply?.ok) relayedModelFailure ??= reply?.error ?? 'local model read failed';
            if (!terminal) w.postMessage({
              type: 'model-read-local-response', rid: m.rid, reply,
            });
          } catch (cause) {
            const detail = /** @type {{message?:string,outcomeKnown?:boolean}} */ (cause);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            if (!terminal) w.postMessage({
              type: 'model-read-local-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(cause),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        if (m.type === 'model-cancel-local-request') {
          pendingModelRelays += 1;
          try {
            const reply = await sendToSW('actor/model-cancel-local', {
              ...(relayToken ? { relayToken } : {}), streamId: m.streamId,
            });
            if (reply?.outcomeKnown === false) relayedModelUnknown = true;
            if (!terminal) w.postMessage({
              type: 'model-cancel-local-response', rid: m.rid, reply,
            });
          } catch (cause) {
            const detail = /** @type {{message?:string,outcomeKnown?:boolean}} */ (cause);
            relayedModelUnknown ||= detail?.outcomeKnown !== true;
            if (!terminal) w.postMessage({
              type: 'model-cancel-local-response', rid: m.rid,
              reply: {
                ok: false, error: detail?.message ?? String(cause),
                outcomeKnown: detail?.outcomeKnown === true,
                ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
              },
            });
          } finally {
            pendingModelRelays -= 1;
            settleTerminal();
          }
          return;
        }
        const exactRelay = typeof m.type === 'string' && Object.hasOwn(EXACT_TOOL_RELAYS, m.type)
          ? EXACT_TOOL_RELAYS[m.type] : null;
        if (exactRelay) {
          const [route, op, fields, optFields, strFields, arrFields, observeResult] = exactRelay;
          const responseType = `${m.type.slice(0, -8)}-response`;
          await relayExactToolMessage(m, responseType, () => {
            /** @type {Record<string, unknown>} */
            const payload = {
              ...(relayToken ? { relayToken } : {}),
              ...exactEffectBinding(m, op),
            };
            for (const key of fields) payload[key] = m[key];
            if (optFields) {
              for (const key of optFields) {
                if (m[key] !== undefined) payload[key] = m[key];
              }
            }
            if (strFields) {
              for (const key of strFields) {
                if (typeof m[key] === 'string') payload[key] = m[key];
              }
            }
            if (arrFields) {
              for (const key of arrFields) {
                if (Array.isArray(m[key])) payload[key] = m[key];
              }
            }
            return sendToSW(route, payload);
          }, observeResult ? { observeResult: true } : undefined);
          return;
        }
        if (m.type === 'app-run-code-request') {
          if (appProgramSemanticToken) {
            w.postMessage({
              type: 'app-run-code-response', rid: m.rid,
              reply: {
                ok: false, error: 'an app program is already active for this actor',
                outcomeKnown: true,
              },
            });
            return;
          }
          appProgramSemanticToken = registerAppProgramSemanticOwner(w, m.effectId);
          try {
            await relayExactToolMessage(m, 'app-run-code-response', () =>
              sendToSW('app/run-code', {
                ...(relayToken ? { relayToken } : {}), ...exactEffectBinding(m, 'turn.app.run-code'),
                code: m.code, timeoutMs: m.timeoutMs, appProgramSemanticToken,
              }), { observeResult: true });
          } finally {
            if (appProgramSemanticToken) {
              releaseAppProgramSemanticOwner(appProgramSemanticToken);
              appProgramSemanticToken = null;
            }
          }
          return;
        }
        if (m.type === 'page-run-program-request') {
          if (pageProgramSemanticToken) {
            w.postMessage({
              type: 'page-run-program-response', rid: m.rid,
              reply: {
                ok: false, error: 'a page program is already active for this actor',
                outcomeKnown: true,
              },
            });
            return;
          }
          pageProgramSemanticToken = registerPageProgramSemanticOwner(w, m.effectId);
          try {
            await relayExactToolMessage(m, 'page-run-program-response', () =>
              sendToSW('page/run-program', {
                ...(relayToken ? { relayToken } : {}), ...exactEffectBinding(m, 'turn.page.run-program'),
                args: m.args, pageProgramSemanticToken,
              }), { observeResult: true });
          } finally {
            if (pageProgramSemanticToken) {
              releasePageProgramSemanticOwner(pageProgramSemanticToken);
              pageProgramSemanticToken = null;
            }
          }
          return;
        }
        if (m.type === 'actor-call-complete-request') {
          await relayExactToolMessage(m, 'actor-call-complete-response', () =>
            sendToSW('actor/call-complete', {
              ...(relayToken ? { relayToken } : {}),
              callId: m.callId,
              turnGeneration: m.turnGeneration,
              result: m.result,
            }), { countCall: true, observeResult: true });
          return;
        }
        if (m.type === 'loop-event') {
          if (relayedLoopEvents >= loopEventLimit) return;
          relayedLoopEvents += 1;
          sendToSW('actor/loop-event', {
            ...(relayToken ? { relayToken } : {}), event: m.event,
          }).catch(() => {});
          return;
        }
        if (m.type === 'done') {
          const r = m.result ?? {};
          const semanticToolRequests = Number.isSafeInteger(r.toolCalls)
            && r.toolCalls >= 0 && r.toolCalls <= loopEventLimit
            ? r.toolCalls : relayedToolRequests;
          relayedToolRequests = semanticToolRequests;
          // No `aborted` here: a Stop-cascade is stamped at the SW client (which alone
          // sees signal.aborted AND whether a reply came back). The runner only marks
          // `aborted` for its OWN wall-clock timeout below.
          if (r.error) {
            const toolCalls = relayedToolRequests;
            requestFinish({
              ok: false, started: true, error: r.error,
              finalText: r.finalText ?? '', newMessages: r.newMessages ?? [],
              usage: r.usage, price: r.price, stopReason: r.stopReason, toolCalls,
              ...(r.contributor ? { contributor: r.contributor } : {}),
              outcomeKnown: true,
            });
          }
          else requestFinish({
            ok: true, started: true,
            finalText: r.finalText ?? '', newMessages: r.newMessages ?? [],
            usage: r.usage, price: r.price, stopReason: r.stopReason,
            toolCalls: relayedToolRequests,
            ...(r.contributor ? { contributor: r.contributor } : {}),
          });
        }
        if (m.type === 'error') {
          requestFinish({ ok: false, started: true, phase: 'run', code: 'actor_worker_error', error: m.error ?? 'actor worker error' });
        }
      });
      w.addEventListener('error', (/** @type {any} */ e) => {
        requestFinish({
          ok: false, started, phase: started ? 'run' : 'startup', code: 'actor_worker_crashed',
          error: `actor worker crashed: ${e?.message ?? 'no detail'}`,
        });
      });
      w.addEventListener('messageerror', () => {
        requestFinish({
          ok: false, started, phase: started ? 'run' : 'startup', code: 'actor_worker_message_error',
          error: 'actor worker sent a message that could not be decoded',
        });
      });
    });
  } catch (e) {
    return {
      ok: false, started: false, phase: 'startup', code: 'actor_worker_spawn_failed',
      error: `actor worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
    };
  } finally {
    try { delete globalThis[/** @type {keyof typeof globalThis} */ (canaryName)]; } catch { /* best effort */ }
    liveWorkers.delete(runId);
    active--;
  }
};
