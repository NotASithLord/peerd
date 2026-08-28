// @ts-check
// offscreen/actor-worker-runtime.js — the ONE runtime that runs any non-orchestrator agent
// loop in its own heap (the heap split): an ephemeral reasoning actor (tools:[],
// so the tool-relay below never fires) OR a bound actor (VM / Notebook / App / web,
// tool-bearing). Imperative shell over actor-worker-core. Provider semantics run
// HERE and pull from an exact SW-owned inference stream; tool effects still relay
// to the SW, which holds the key, engine clients, instance pin, and gate. The
// untrusted instance/page output stays in this heap. Module worker → strict.
import {
  controllerHostsLocalTool,
  controllerHostsActorTool,
  controllerHostsPodTool,
  controllerHostsRepositoryTool,
  controllerHostsVmTool,
  controllerHostsNotebookTool,
  controllerHostsAppTool,
  controllerHostsPersistenceTool,
  controllerHostsPageTool,
  controllerHostsResourceTool,
  controllerHostsSiteClientTool,
  controllerHostsExecutionTool,
  controllerHostsEditingTool,
  controllerHostsIntrospectionTool,
  controllerHostsScheduleTool,
  controllerHostsDwebTool,
  controllerHostsTool,
  controllerOperationsForSpawnedTools,
  decideAction,
  dispatchToolCall,
  executeControllerLocalTool,
  executeControllerActorTool,
  executeControllerPodTool,
  executeControllerRepositoryTool,
  executeControllerVmTool,
  executeControllerNotebookTool,
  executeControllerAppTool,
  executeControllerPersistenceTool,
  executeControllerPageTool,
  executeControllerResourceTool,
  executeControllerSiteClientTool,
  executeControllerExecutionTool,
  executeControllerEditingTool,
  executeControllerIntrospectionTool,
  executeControllerScheduleTool,
  executeControllerDwebTool,
  reasoningForTurn,
  runUserTurn,
  semanticHooksFor,
} from '/peerd-runtime/controller-turn.js';
import { makeInMemorySessions, runActorLoop, makeActorSummaryFence } from '/peerd-runtime/actor/actor-worker-core.js';
import { hydrateToolDescriptors } from '/peerd-runtime/semantic.js';
import {
  callModel as callProviderModel,
  costOf,
  contextWindowFor,
  providerMetadata,
  providerModelContextWindow,
} from '/peerd-provider/controller.js';
import { AGENT_PROGRAM, isExecutionDescription } from '/shared/execution-protocol.js';
import { originOf } from '/shared/url-origin.js';
import { createActorModelEgress } from './actor-model-egress.js';
import { ACTOR_WORKER_PROTOCOL } from './actor-worker-protocol.js';
import { nestedActorProgramCallId } from '/shared/actor-channel-protocol.js';
import { normalizeSemanticToolFailure } from '/shared/semantic-tool-failure.js';

const recoveredPrototypeCapabilityBlocked = async (
  /** @type {any} */ target, /** @type {string} */ name, /** @type {unknown} */ argument,
) => {
  for (let object = Object.getPrototypeOf(target); object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) continue;
    try {
      const recovered = typeof descriptor.get === 'function'
        ? descriptor.get.call(target) : descriptor.value;
      if (typeof recovered === 'function') {
        await Promise.resolve(recovered.call(target, argument)).catch(() => {});
      } else if (recovered && typeof recovered.getDirectory === 'function') {
        await Promise.resolve(recovered.getDirectory()).catch(() => {});
      }
    } catch { /* a throwing recovered primitive is still a reachable primitive */ }
    return false;
  }
  return true;
};

const pageProgramRequest = (/** @type {any} */ message) => {
  if (message.type === 'page-program-navigate-request') {
    return { response: 'page-program-navigate-response', tool: 'navigate' };
  }
  if (message.type === 'page-program-click-request') {
    return { response: 'page-program-click-response', tool: 'click' };
  }
  if (message.type === 'page-program-fill-request') {
    return { response: 'page-program-fill-response', tool: 'type' };
  }
  if (message.type === 'page-program-snapshot-request') {
    return { response: 'page-program-snapshot-response', tool: 'snapshot' };
  }
  if (message.type === 'page-program-read-request') {
    return { response: 'page-program-read-response', tool: 'read_page' };
  }
  if (message.type === 'page-program-read-state-request') {
    return { response: 'page-program-read-state-response', tool: 'read_state' };
  }
  if (message.type === 'page-program-watch-changes-request') {
    return { response: 'page-program-watch-changes-response', tool: 'watch_changes' };
  }
  if (message.type === 'page-program-query-request') {
    return { response: 'page-program-query-response', tool: 'query_dom' };
  }
  if (message.type === 'page-program-view-request') {
    return { response: 'page-program-view-response', tool: 'view' };
  }
  if (message.type === 'page-program-login-request') {
    return { response: 'page-program-login-response', tool: 'login' };
  }
  if (message.type === 'page-program-fetch-request') {
    return { response: 'page-program-fetch-response', tool: 'fetch_url' };
  }
  if (message.type === 'page-program-read-document-request') {
    return { response: 'page-program-read-document-response', tool: 'read_doc' };
  }
  if (message.type === 'page-program-read-result-request') {
    return { response: 'page-program-read-result-response', tool: 'read_result' };
  }
  if (message.type === 'page-program-site-client-read-request') {
    return { response: 'page-program-site-client-read-response', tool: 'site_client_read' };
  }
  if (message.type === 'page-program-site-client-write-request') {
    return { response: 'page-program-site-client-write-response', tool: 'site_client_write' };
  }
  if (message.type === 'page-program-site-capture-request') {
    return { response: 'page-program-site-capture-response', tool: 'site_capture' };
  }
  return null;
};

const appProgramRequest = (/** @type {any} */ message) => {
  if (message.type === 'app-program-observe-request') {
    return { response: 'app-program-observe-response', tool: 'app_observe' };
  }
  if (message.type === 'app-program-act-request') {
    return { response: 'app-program-act-response', tool: 'app_act' };
  }
  return null;
};

/** Start one actor Worker with an optional target-owned result projection. */
export const startActorWorker = (
  /** @type {null|((result:any,program:any,metadata:any)=>any)} */
  projectResult = null,
  /** @type {(()=>Record<string, boolean>)|null} */
  realmProbe = null,
) => {
let seq = 0;
let runId = '';
/** @type {Map<string, (v: any) => void>} rid → pending model-authority resolver */
const modelPending = new Map();
/** @type {Map<string, (v: any) => void>} rid → pending tool-dispatch resolver */
const toolPending = new Map();
const abort = new AbortController();
let hasRun = false;
/** @type {((call:any,options?:{programParentExecutionId?:string})=>Promise<any>)|null} */
let executeOwnedTool = null;
self.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
  const m = /** @type {any} */ (ev.data);
  if (!m || typeof m !== 'object') return;

  if (m.type === 'probe') {
    // why: readiness is not just a one-time snapshot. Attempt the same ambient
    // sabotage hostile semantic code would use, then require the bootstrap's
    // closure to prove every non-configurable denial is still installed.
    for (const name of [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
      'RTCPeerConnection', 'Worker', 'SharedWorker', 'BroadcastChannel',
      'indexedDB', 'caches', 'importScripts',
    ]) {
      const ambient = /** @type {Record<string, any>} */ (globalThis);
      try { ambient[name] = () => {}; } catch { /* sealed */ }
      try { delete ambient[name]; } catch { /* sealed */ }
    }
    const ambientNavigator = /** @type {Record<string, any>} */ (/** @type {unknown} */ (navigator));
    for (const name of ['sendBeacon', 'storage', 'serviceWorker', 'locks']) {
      try { ambientNavigator[name] = {}; } catch { /* sealed */ }
      try { delete ambientNavigator[name]; } catch { /* sealed */ }
    }
    const prototypeFetchBlocked = await recoveredPrototypeCapabilityBlocked(
      globalThis, 'fetch', 'data:text/plain,actor-seal-probe',
    );
    const prototypeStorageBlocked = await recoveredPrototypeCapabilityBlocked(
      navigator, 'storage', undefined,
    );
    self.postMessage({
      type: 'probe-response',
      protocol: ACTOR_WORKER_PROTOCOL,
      rid: m.rid,
      canaryAbsent: typeof m.canaryName === 'string' && !(m.canaryName in globalThis),
      realm: realmProbe?.() ?? null,
      prototypeFetchBlocked,
      prototypeStorageBlocked,
    });
    return;
  }

  if (m.type === 'model-open-inference-response'
      || m.type === 'model-read-inference-chunk-response'
      || m.type === 'model-cancel-inference-response'
      || m.type === 'model-open-local-response'
      || m.type === 'model-read-local-response'
      || m.type === 'model-cancel-local-response'
      || m.type === 'model-read-context-response') {
    modelPending.get(m.rid)?.(m.reply);
    modelPending.delete(m.rid);
    return;
  }
  if (m.type === 'actor-spawn-sync-response'
      || m.type === 'actor-spawn-async-response'
      || m.type === 'actor-tasks-read-response'
      || m.type === 'actor-task-cancel-response'
      || m.type === 'actor-message-deliver-response'
      || m.type === 'pod-resolve-response'
      || m.type === 'pod-read-remote-response'
      || m.type === 'pod-confirm-git-response'
      || m.type === 'pod-exec-response'
      || m.type === 'pod-status-response'
      || m.type === 'pod-cancel-response'
      || m.type === 'pod-read-file-response'
      || m.type === 'pod-write-file-response'
      || m.type === 'repository-read-pod-response'
      || m.type === 'repository-destroy-pod-response'
      || m.type === 'repository-read-status-response'
      || m.type === 'repository-read-history-response'
      || m.type === 'repository-read-remote-response'
      || m.type === 'repository-read-diff-response'
      || m.type === 'repository-confirm-restore-response'
      || m.type === 'repository-checkpoint-response'
      || m.type === 'repository-branch-response'
      || m.type === 'repository-checkout-response'
      || m.type === 'repository-restore-response'
      || m.type === 'repository-confirm-remote-response'
      || m.type === 'repository-link-response'
      || m.type === 'repository-fetch-response'
      || m.type === 'repository-push-response'
      || m.type === 'vm-read-response'
      || m.type === 'vm-list-response'
      || m.type === 'vm-set-default-response'
      || m.type === 'vm-run-response'
      || m.type === 'vm-import-file-response'
      || m.type === 'vm-write-text-file-response'
      || m.type === 'vm-destroy-response'
      || m.type === 'notebook-read-response'
      || m.type === 'notebook-list-response'
      || m.type === 'notebook-set-default-response'
      || m.type === 'notebook-run-response'
      || m.type === 'notebook-write-file-response'
      || m.type === 'notebook-read-file-response'
      || m.type === 'notebook-destroy-response'
      || m.type === 'app-update-response'
      || m.type === 'app-open-response'
      || m.type === 'app-search-response'
      || m.type === 'app-read-response'
      || m.type === 'app-delete-response'
      || m.type === 'app-write-file-response'
      || m.type === 'app-read-file-response'
      || m.type === 'app-list-files-response'
      || m.type === 'app-delete-file-response'
      || m.type === 'app-observe-response'
      || m.type === 'app-act-response'
      || m.type === 'app-run-code-response'
      || m.type === 'memory-read-scope-response'
      || m.type === 'memory-read-subtree-response'
      || m.type === 'memory-write-response'
      || m.type === 'todo-read-response'
      || m.type === 'todo-replace-response'
      || m.type === 'page-open-tab-response'
      || m.type === 'page-read-response'
      || m.type === 'page-snapshot-response'
      || m.type === 'page-read-state-response'
      || m.type === 'page-watch-changes-response'
      || m.type === 'page-query-dom-response'
      || m.type === 'page-navigate-response'
      || m.type === 'page-fill-response'
      || m.type === 'page-click-response'
      || m.type === 'page-login-response'
      || m.type === 'page-run-program-response'
      || m.type === 'page-capture-foreground-response'
      || m.type === 'page-capture-owned-response'
      || m.type === 'resource-confirm-web-write-response'
      || m.type === 'resource-request-web-text-response'
      || m.type === 'resource-extract-markdown-response'
      || m.type === 'resource-extract-document-response'
      || m.type === 'resource-spill-result-response'
      || m.type === 'resource-read-result-response'
      || m.type === 'site-client-read-response'
      || m.type === 'site-client-run-response'
      || m.type === 'site-client-commit-response'
      || m.type === 'site-client-capture-start-response'
      || m.type === 'site-client-capture-stop-response'
      || m.type === 'execution-create-webvm-response'
      || m.type === 'execution-create-notebook-response'
      || m.type === 'execution-create-pod-response'
      || m.type === 'execution-create-app-response'
      || m.type === 'execution-run-script-response'
      || m.type === 'execution-spill-script-response'
      || m.type === 'editing-read-target-response'
      || m.type === 'editing-write-target-response'
      || m.type === 'introspection-actor-roster-response'
      || m.type === 'introspection-provider-posture-response'
      || m.type === 'introspection-storage-snapshot-response'
      || m.type === 'introspection-automatable-tabs-response'
      || m.type === 'introspection-denylist-patterns-response'
      || m.type === 'introspection-audit-entries-response'
      || m.type === 'introspection-installed-skill-response'
      || m.type === 'schedule-read-routines-response'
      || m.type === 'dweb-run-mesh-program-response'
      || m.type === 'schedule-arm-confirmed-routine-response'
      || m.type === 'schedule-cancel-routine-response'
      || m.type === 'dweb-discover-apps-response'
      || m.type === 'dweb-publish-confirmed-app-response'
      || m.type === 'dweb-install-confirmed-app-response'
      || m.type === 'dweb-read-peers-response'
      || m.type === 'dweb-set-peer-blocked-response'
      || m.type === 'dweb-set-discovery-enabled-response'
      || m.type === 'actor-call-complete-response') {
    toolPending.get(m.rid)?.(m.reply);
    toolPending.delete(m.rid);
    return;
  }
  const nestedProgram = pageProgramRequest(m) ?? appProgramRequest(m);
  if (nestedProgram) {
    const result = executeOwnedTool
      ? await executeOwnedTool({
          id: nestedActorProgramCallId(
            runId, String(m.parentExecutionId ?? ''), String(m.rid ?? ''),
          ),
          name: nestedProgram.tool,
          args: m.args ?? {},
        }, { programParentExecutionId: m.parentExecutionId })
      : {
          ok: false, error: 'program semantic owner is not ready',
          outcomeKnown: true,
        };
    self.postMessage({
      type: nestedProgram.response, rid: m.rid, result,
    });
    return;
  }
  if (m.type === 'abort') {
    abort.abort();
    // Unwind a worker BLOCKED awaiting the SW (model OR tool) so it doesn't park
    // until the host's budget timer.
    for (const resolve of modelPending.values()) resolve({ error: 'aborted' });
    for (const resolve of toolPending.values()) resolve({ ok: false, error: 'aborted' });
    modelPending.clear(); toolPending.clear();
    return;
  }

  if (m.type === 'run') {
    if (hasRun) {
      self.postMessage({ type: 'error', runId, error: 'actor worker refused a second run' });
      return;
    }
    hasRun = true;
    const execution = m.execution;
    const program = execution?.program;
    const state = execution?.state;
    const metadata = execution?.metadata;
    if (!isExecutionDescription(execution)
        || program?.kind !== AGENT_PROGRAM
        || typeof execution.input !== 'string'
        || typeof metadata?.sessionId !== 'string'
        || !state || typeof state !== 'object'
        || !Array.isArray(state.messages)) {
      self.postMessage({ type: 'error', runId: execution?.id ?? '', error: 'actor worker received an invalid execution description' });
      return;
    }
    runId = execution.id;
    const hydratedTools = hydrateToolDescriptors(
      Array.isArray(m.tools) ? m.tools : [], m.runtimeCapabilities,
    );
    const programTools = hydrateToolDescriptors(
      Array.isArray(m.programTools) ? m.programTools : [], m.runtimeCapabilities,
    );
    const descriptorsByName = new Map(
      [...hydratedTools, ...programTools].map((tool) => [tool.name, tool]),
    );
    const visibleToolNames = new Set(hydratedTools.map((tool) => tool.name));
    const childOperationsFor = (/** @type {any} */ request) =>
      controllerOperationsForSpawnedTools(
        visibleToolNames, request.tools, request.allowRecursion === true,
      );
    const semanticPolicy = m.semanticPolicy && typeof m.semanticPolicy === 'object'
      ? m.semanticPolicy : {};
    const semanticHooks = semanticHooksFor(semanticPolicy.userHookRecords);
    const ownedSiteClientOrigin = metadata.backing === 'api'
      ? metadata.instanceId : metadata.tabOrigin;
    const canUseSiteClientOrigin = (/** @type {unknown} */ candidate) => {
      if (typeof candidate !== 'string') return false;
      try {
        const candidateOrigin = originOf(candidate);
        // API actors own one immutable origin. A tab actor can legitimately
        // navigate and rebind during this same turn; semantic code validates
        // the origin shape while exact SW authority rechecks the live binding.
        return metadata.backing === 'api'
          ? typeof ownedSiteClientOrigin === 'string'
            && candidateOrigin === originOf(ownedSiteClientOrigin)
          : metadata.backing !== 'api';
      }
      catch { return false; }
    };
    /** @type {any} */
    let semanticSession = null;
    const openInference = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mo-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-open-inference-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
        nativeBody: request.nativeBody,
      });
    });
    const readInferenceChunk = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mr-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-inference-chunk-request', rid, runId,
        streamId: request.streamId,
      });
    });
    const cancelInference = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mx-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-cancel-inference-request', rid, runId,
        streamId: request.streamId,
      });
    });
    const readModelContext = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mw-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-context-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
      });
    });
    const openLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lo-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-open-local-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        maxTokens: request.maxTokens,
      });
    });
    const readLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lr-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-local-request', rid, runId, streamId: request.streamId,
      });
    });
    const cancelLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lx-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-cancel-local-request', rid, runId, streamId: request.streamId,
      });
    });
    const actorToolRequest = (
      /** @type {string} */ type, /** @type {Record<string,unknown>} */ payload,
    ) => new Promise((resolve) => {
      const rid = `ta-${++seq}`;
      toolPending.set(rid, resolve);
      self.postMessage({ type, rid, runId, ...payload });
    });
    const authorityValue = async (/** @type {Promise<any>} */ pending) => {
      const reply = await pending;
      if (reply?.ok === true && reply.value?.authorityReceipt
          && Object.hasOwn(reply.value, 'authorityValue')) {
        return reply.value.authorityValue;
      }
      const error = new Error(reply?.error ?? 'actor authority operation failed');
      Object.assign(error, {
        code: reply?.code ?? 'actor-authority-failed',
        outcomeKnown: reply?.outcomeKnown === true,
        retryable: reply?.retryable,
      });
      throw error;
    };
    const executeActorTool = async (
      /** @type {any} */ call,
      /** @type {{programParentExecutionId?:string,semanticPrepared?:boolean,effectCounter?:{count:number}}} */ options = {},
    ) => {
      if (!controllerHostsTool(call?.name) || typeof call?.id !== 'string') {
        return {
          ok: false, error: 'actor tool has no controller semantic owner', outcomeKnown: true,
          meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
        };
      }
      if (options.semanticPrepared !== true) {
        const descriptor = descriptorsByName.get(call.name);
        if (!descriptor) return {
          ok: false, error: `unknown_tool: ${String(call.name)}`, outcomeKnown: true,
        };
        const effectCounter = { count: 0 };
        const boundActor = metadata.recordKind === 'actor';
        const dispatched = await dispatchToolCall(call, {
          ...semanticPolicy,
          exposure: boundActor ? 'actor' : undefined,
          actorType: boundActor ? metadata.actorType : undefined,
          // why: code-surface actors expose page_code to the model, but the
          // hidden page-program helpers are ordinary page tools semantically.
          // Only a live parent execution can switch this one nested dispatch
          // to the tools surface; direct model calls remain code-gated.
          actorSurface: boundActor
            ? options.programParentExecutionId ? 'tools' : metadata.actorSurface
            : undefined,
          backing: boundActor ? metadata.backing : undefined,
          actorBacking: boundActor ? metadata.backing : undefined,
          actorInstanceId: boundActor ? metadata.instanceId : undefined,
          activeTab: boundActor
            ? semanticPolicy.activeTab ?? (metadata.tabOrigin
              ? { origin: metadata.tabOrigin } : undefined)
            : undefined,
          canUseSiteClientOrigin,
          hooks: semanticHooks,
          session: semanticSession ? {
            ...semanticSession,
            messageCount: semanticSession.messages?.length ?? 0,
            trimCovered: semanticSession.trimSummary?.covered ?? 0,
          } : {
            sessionId: metadata.sessionId,
            kind: metadata.recordKind === 'spawned' ? 'spawned' : 'actor',
            messageCount: 0, trimCovered: 0,
          },
          abortSignal: abort.signal,
          authorityOwnsLifecycle: true,
          runtimeCapabilities: m.runtimeCapabilities,
          audit: async () => {},
        }, {
          descriptor,
          execute: (prepared) => executeActorTool(
            { ...call, args: prepared.args }, {
              ...options, semanticPrepared: true, effectCounter,
            },
          ),
        });
        if (effectCounter.count === 0) return dispatched;
        const settled = await actorToolRequest('actor-call-complete-request', {
          callId: call.id, turnGeneration: metadata.turnGeneration, result: dispatched,
        });
        if (settled?.ok === true) return settled.result;
        return {
          ok: false, error: settled?.error ?? 'actor call completion failed',
          outcomeKnown: settled?.outcomeKnown === true,
          ...(settled?.outcomeKnown === true ? {} : { retryable: false }),
          meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
        };
      }
      let effectSequence = 0;
      const effectBinding = () => {
        effectSequence += 1;
        if (options.effectCounter) options.effectCounter.count += 1;
        return {
          callId: call.id,
          effectId: `${call.id}:${effectSequence}`,
          effectSequence,
          turnGeneration: metadata.turnGeneration,
          ...(options.programParentExecutionId
            ? { parentCallId: options.programParentExecutionId }
            : {}),
        };
      };
      const projection = {
        sessionId: metadata.sessionId,
        sessionDepth: metadata.depth ?? 0,
        sessionKind: metadata.recordKind === 'spawned' ? 'spawned' : 'actor',
        messageCount: semanticSession?.messages?.length ?? 0,
        trimCovered: semanticSession?.trimSummary?.covered ?? 0,
        messages: semanticSession?.messages ?? [],
        inbound: metadata.inbound === true,
        actorType: metadata.actorType,
        actorBacking: metadata.backing,
        actorInstanceId: metadata.instanceId,
        activeTabOrigin: metadata.tabOrigin,
        runtimeCapabilities: m.runtimeCapabilities,
      };
      const actorAuthority = Object.freeze({
        spawnSync: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-spawn-sync-request', {
            ...effectBinding(), task: request.task,
            allowRecursion: request.allowRecursion === true,
            grantedOperations: childOperationsFor(request),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          },
        )),
        spawnAsync: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-spawn-async-request', {
            ...effectBinding(), task: request.task,
            allowRecursion: request.allowRecursion === true,
            grantedOperations: childOperationsFor(request),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          },
        )),
        listTasks: () => authorityValue(actorToolRequest(
          'actor-tasks-read-request', effectBinding(),
        )),
        cancelTask: (/** @type {string} */ taskId) => authorityValue(actorToolRequest(
          'actor-task-cancel-request', { ...effectBinding(), taskId },
        )),
        message: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-message-deliver-request', {
            ...effectBinding(), to: request.to, message: request.message,
            oneShot: request.oneShot === true,
            awaitReply: request.awaitReply === true,
            degradeToAsync: request.degradeToAsync === true,
            awaitCapMs: Number(request.awaitCapMs),
          },
        )),
      });
      let result;
      try {
        if (controllerHostsLocalTool(call.name)) {
          result = await executeControllerLocalTool(call.name, call.args, Object.freeze({
            completeGoal: async () => {
              throw Object.assign(new Error('goal completion is unavailable to this actor'), {
                code: 'actor-goal-completion-denied', outcomeKnown: true,
              });
            },
          }));
        } else if (controllerHostsActorTool(call.name)) {
          result = await executeControllerActorTool(
            call.name, call.args, projection, actorAuthority,
            { callId: call.id, signal: abort.signal },
          );
        } else if (controllerHostsPodTool(call.name)) {
          const podAuthority = Object.freeze({
            resolve: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-resolve-request', {
                ...effectBinding(), podId: request?.podId,
                ...(typeof call.args?.command === 'string'
                  ? { command: call.args.command } : {}),
              },
            )),
            readRemote: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'pod-read-remote-request', { ...effectBinding(), podId },
            )),
            confirmGit: (/** @type {string} */ op) => authorityValue(actorToolRequest(
              'pod-confirm-git-request', { ...effectBinding(), op },
            )),
            executeCommand: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-exec-request', {
                ...effectBinding(), command: request.command, podId: request.podId,
                timeoutMs: request.timeoutMs, background: request.background === true,
                remoteGitGrant: request.remoteGitGrant ?? null,
              },
            )),
            readStatus: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-status-request', {
                ...effectBinding(), podId: request.podId, jobId: request.jobId,
                stream: request.stream, offset: request.offset, limit: request.limit,
              },
            )),
            cancelJob: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-cancel-request', {
                ...effectBinding(), podId: request.podId, jobId: request.jobId,
              },
            )),
            readFile: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-read-file-request', {
                ...effectBinding(), podId: request.podId, path: request.path,
              },
            )),
            writeFile: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-write-file-request', {
                ...effectBinding(), podId: request.podId, path: request.path,
                content: request.content,
              },
            )),
          });
          result = await executeControllerPodTool(
            call.name, call.args, projection, podAuthority,
            { signal: abort.signal },
          );
        } else if (controllerHostsRepositoryTool(call.name)) {
          const repositoryAuthority = Object.freeze({
            readPod: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'repository-read-pod-request', { ...effectBinding(), podId },
            )),
            destroyPod: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'repository-destroy-pod-request', { ...effectBinding(), podId },
            )),
            readStatus: () => authorityValue(actorToolRequest(
              'repository-read-status-request', effectBinding(),
            )),
            readHistory: (/** @type {number} */ depth) => authorityValue(actorToolRequest(
              'repository-read-history-request', { ...effectBinding(), depth },
            )),
            readRemote: () => authorityValue(actorToolRequest(
              'repository-read-remote-request', effectBinding(),
            )),
            readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) =>
              authorityValue(actorToolRequest(
                'repository-read-diff-request', { ...effectBinding(), from, to },
              )),
            confirmRestore: (/** @type {string} */ to) => authorityValue(actorToolRequest(
              'repository-confirm-restore-request', { ...effectBinding(), to },
            )),
            checkpoint: (/** @type {string} */ message) => authorityValue(actorToolRequest(
              'repository-checkpoint-request', { ...effectBinding(), message },
            )),
            branch: (/** @type {string} */ name) => authorityValue(actorToolRequest(
              'repository-branch-request', { ...effectBinding(), name },
            )),
            checkout: (/** @type {string} */ name) => authorityValue(actorToolRequest(
              'repository-checkout-request', { ...effectBinding(), name },
            )),
            restore: (/** @type {string} */ to) => authorityValue(actorToolRequest(
              'repository-restore-request', { ...effectBinding(), to },
            )),
            confirmRemote: (/** @type {string} */ op, /** @type {string} */ target,
              /** @type {string|undefined} */ branch) => authorityValue(actorToolRequest(
              'repository-confirm-remote-request', {
                ...effectBinding(), op, target, branch,
                ...(typeof call.args?.url === 'string' ? { url: call.args.url } : {}),
              },
            )),
            link: (/** @type {string} */ url) => authorityValue(actorToolRequest(
              'repository-link-request', { ...effectBinding(), url },
            )),
            fetch: (/** @type {string} */ target) => authorityValue(actorToolRequest(
              'repository-fetch-request', { ...effectBinding(), target },
            )),
            push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) =>
              authorityValue(actorToolRequest(
                'repository-push-request', { ...effectBinding(), target, branch },
              )),
          });
          result = await executeControllerRepositoryTool(
            call.name, call.args, projection, repositoryAuthority,
            { signal: abort.signal },
          );
        } else if (controllerHostsVmTool(call.name)) {
          const vmAuthority = Object.freeze({
            readVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-read-request', { ...effectBinding(), vmId },
            )),
            listVms: () => authorityValue(actorToolRequest(
              'vm-list-request', effectBinding(),
            )),
            setDefaultVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-set-default-request', { ...effectBinding(), vmId },
            )),
            runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
              /** @type {string|undefined} */ vmId) => authorityValue(actorToolRequest(
              'vm-run-request', { ...effectBinding(), command, timeoutMs, vmId },
            )),
            importFile: (/** @type {string} */ url, /** @type {string} */ path,
              /** @type {number} */ maxBytes) => authorityValue(actorToolRequest(
              'vm-import-file-request', { ...effectBinding(), url, path, maxBytes },
            )),
            writeTextFile: (/** @type {string} */ path, /** @type {string} */ content) =>
              authorityValue(actorToolRequest(
                'vm-write-text-file-request', { ...effectBinding(), path, content },
              )),
            destroyVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-destroy-request', { ...effectBinding(), vmId },
            )),
          });
          result = await executeControllerVmTool(
            call.name, call.args, vmAuthority,
          );
        } else if (controllerHostsNotebookTool(call.name)) {
          const notebookAuthority = Object.freeze({
            readNotebook: (/** @type {string} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-read-request', { ...effectBinding(), notebookId },
            )),
            listNotebooks: () => authorityValue(actorToolRequest(
              'notebook-list-request', effectBinding(),
            )),
            setDefaultNotebook: (/** @type {string} */ notebookId) =>
              authorityValue(actorToolRequest(
                'notebook-set-default-request', { ...effectBinding(), notebookId },
              )),
            runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-run-request', { ...effectBinding(), code, timeoutMs, notebookId },
            )),
            writeFile: (/** @type {string} */ path, /** @type {string} */ content,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-write-file-request', { ...effectBinding(), path, content, notebookId },
            )),
            readFile: (/** @type {string} */ path,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-read-file-request', { ...effectBinding(), path, notebookId },
            )),
            destroyNotebook: (/** @type {string} */ notebookId) =>
              authorityValue(actorToolRequest(
                'notebook-destroy-request', { ...effectBinding(), notebookId },
              )),
          });
          result = await executeControllerNotebookTool(
            call.name, call.args, notebookAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsAppTool(call.name)) {
          const appAuthority = Object.freeze({
            updateApp: (
              /** @type {string|undefined} */ appId,
              /** @type {string|undefined} */ name,
              /** @type {string|undefined} */ html,
              /** @type {string[]|undefined} */ tags,
              /** @type {string|undefined} */ entryFile,
            ) => authorityValue(actorToolRequest(
              'app-update-request', { ...effectBinding(), appId, name, html, tags, entryFile },
            )),
            openApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-open-request', { ...effectBinding(), appId },
            )),
            searchApps: (/** @type {string} */ query) => authorityValue(actorToolRequest(
              'app-search-request', { ...effectBinding(), query },
            )),
            readApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-read-request', { ...effectBinding(), appId },
            )),
            deleteApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-delete-request', { ...effectBinding(), appId },
            )),
            writeFile: (
              /** @type {string|undefined} */ appId,
              /** @type {string} */ path,
              /** @type {unknown} */ content,
            ) => authorityValue(actorToolRequest(
              'app-write-file-request', { ...effectBinding(), appId, path, content },
            )),
            readFile: (
              /** @type {string|undefined} */ appId, /** @type {string} */ path,
            ) => authorityValue(actorToolRequest(
              'app-read-file-request', { ...effectBinding(), appId, path },
            )),
            listFiles: (/** @type {string|undefined} */ appId) =>
              authorityValue(actorToolRequest(
                'app-list-files-request', { ...effectBinding(), appId },
              )),
            deleteFile: (
              /** @type {string|undefined} */ appId, /** @type {string} */ path,
            ) => authorityValue(actorToolRequest(
              'app-delete-file-request', { ...effectBinding(), appId, path },
            )),
            observeRuntime: () => authorityValue(actorToolRequest(
              'app-observe-request', effectBinding(),
            )),
            actRuntime: (
              /** @type {string} */ action,
              /** @type {Record<string,unknown>} */ params,
            ) => authorityValue(actorToolRequest(
              'app-act-request', { ...effectBinding(), action, params },
            )),
            runCode: (/** @type {string} */ code, /** @type {number} */ timeoutMs) =>
              authorityValue(actorToolRequest(
                'app-run-code-request', { ...effectBinding(), code, timeoutMs },
              )),
          });
          result = await executeControllerAppTool(
            call.name, call.args, appAuthority, projection,
          );
        } else if (controllerHostsPersistenceTool(call.name)) {
          const persistenceAuthority = Object.freeze({
            readMemoryScope: (/** @type {any} */ scope) => authorityValue(actorToolRequest(
              'memory-read-scope-request', { ...effectBinding(), scope },
            )),
            readMemorySubtree: (/** @type {string} */ workspace,
              /** @type {string} */ subpath) => authorityValue(actorToolRequest(
              'memory-read-subtree-request', { ...effectBinding(), workspace, subpath },
            )),
            writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) =>
              authorityValue(actorToolRequest(
                'memory-write-request', { ...effectBinding(), scope, body },
              )),
            readTodos: () => authorityValue(actorToolRequest(
              'todo-read-request', effectBinding(),
            )),
            replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) =>
              authorityValue(actorToolRequest(
                'todo-replace-request', { ...effectBinding(), version, todos },
              )),
          });
          result = await executeControllerPersistenceTool(
            call.name, call.args, projection, persistenceAuthority,
          );
        } else if (controllerHostsPageTool(call.name)) {
          const request = (/** @type {string} */ type) => authorityValue(actorToolRequest(
            type, { ...effectBinding(), args: call.args },
          ));
          const pageAuthority = Object.freeze({
            openProtectedBackgroundTab: () => request('page-open-tab-request'),
            readOwnedPage: () => request('page-read-request'),
            captureOwnedAccessibilityTree: () => request('page-snapshot-request'),
            readOwnedFrameworkState: () => request('page-read-state-request'),
            drainOwnedDomChanges: () => request('page-watch-changes-request'),
            queryOwnedDom: () => request('page-query-dom-request'),
            navigateOwnedTab: () => request('page-navigate-request'),
            fillOwnedTarget: () => request('page-fill-request'),
            clickOwnedTarget: () => request('page-click-request'),
            performConfirmedOwnedLogin: () => request('page-login-request'),
            runOwnedPageProgram: () => request('page-run-program-request'),
            captureForegroundPixels: () => request('page-capture-foreground-request'),
            captureOwnedTabPixels: () => request('page-capture-owned-request'),
          });
          result = await executeControllerPageTool(
            call.name, call.args, pageAuthority,
          );
        } else if (controllerHostsResourceTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const resourceAuthority = Object.freeze({
            confirmWebWrite: (/** @type {any} */ webRequest) =>
              request('resource-confirm-web-write-request', webRequest),
            requestWebText: (/** @type {any} */ webRequest) =>
              request('resource-request-web-text-request', webRequest),
            extractReadableMarkdown: (/** @type {string} */ html,
              /** @type {string} */ url) =>
              request('resource-extract-markdown-request', { html, url }),
            extractDocument: (/** @type {any} */ documentRequest) =>
              request('resource-extract-document-request', documentRequest),
            spillResult: (/** @type {any} */ record) =>
              request('resource-spill-result-request', record),
            readResult: (/** @type {string} */ key) =>
              request('resource-read-result-request', { key }),
          });
          result = await executeControllerResourceTool(
            call.name, call.args, resourceAuthority, projection,
          );
        } else if (controllerHostsSiteClientTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const siteClientAuthority = Object.freeze({
            readStoredClient: (/** @type {string} */ origin) =>
              request('site-client-read-request', { origin }),
            runStoredClient: (/** @type {string} */ origin, /** @type {string} */ code,
              /** @type {number} */ timeoutMs) =>
              request('site-client-run-request', { origin, code, timeoutMs }),
            commitConfirmedClient: (/** @type {string} */ origin) =>
              request('site-client-commit-request', {
                origin,
                ...(typeof call.args?.summary === 'string'
                  ? { summary: call.args.summary } : {}),
                ...(Array.isArray(call.args?.endpoints)
                  ? { endpoints: call.args.endpoints } : {}),
                ...(call.args?.auth !== undefined ? { auth: call.args.auth } : {}),
                ...(call.args?.deriver !== undefined ? { deriver: call.args.deriver } : {}),
                ...(typeof call.args?.body === 'string' ? { body: call.args.body } : {}),
              }),
            startOwnedCapture: () => request('site-client-capture-start-request'),
            stopOwnedCapture: () => request('site-client-capture-stop-request'),
          });
          result = await executeControllerSiteClientTool(
            call.name, call.args, siteClientAuthority,
          );
        } else if (controllerHostsExecutionTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const executionAuthority = Object.freeze({
            createWebVm: (/** @type {any} */ plan) =>
              request('execution-create-webvm-request', { plan }),
            createNotebook: (/** @type {any} */ plan) =>
              request('execution-create-notebook-request', { plan }),
            createPod: (/** @type {any} */ plan) =>
              request('execution-create-pod-request', { plan }),
            createApp: (/** @type {any} */ plan) =>
              request('execution-create-app-request', { plan }),
            runHeadlessScript: (/** @type {any} */ scriptRequest) =>
              request('execution-run-script-request', scriptRequest),
            spillScriptValue: (/** @type {any} */ record) =>
              request('execution-spill-script-request', record),
          });
          result = await executeControllerExecutionTool(
            call.name, call.args, executionAuthority, projection,
          );
        } else if (controllerHostsEditingTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const editingAuthority = Object.freeze({
            readEditTarget: (/** @type {any} */ target) =>
              request('editing-read-target-request', target),
            writeEditTarget: (/** @type {any} */ target) =>
              request('editing-write-target-request', target),
          });
          result = await executeControllerEditingTool(
            call.name, call.args, editingAuthority,
          );
        } else if (controllerHostsIntrospectionTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const introspectionAuthority = Object.freeze({
            readActorRoster: () => request('introspection-actor-roster-request'),
            readProviderPosture: () => request('introspection-provider-posture-request'),
            readStorageSnapshot: (/** @type {string|undefined} */ prefix) =>
              request('introspection-storage-snapshot-request', { prefix }),
            readAutomatableTabs: () => request('introspection-automatable-tabs-request'),
            readDenylistPatterns: () => request('introspection-denylist-patterns-request'),
            readAuditEntries: () => request('introspection-audit-entries-request'),
            readInstalledSkill: (/** @type {string} */ name) =>
              request('introspection-installed-skill-request', { name }),
          });
          result = await executeControllerIntrospectionTool(
            call.name, call.args, projection,
            introspectionAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsScheduleTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const scheduleAuthority = Object.freeze({
            readRoutines: () => request('schedule-read-routines-request'),
            armConfirmedRoutine: (/** @type {any} */ routine) =>
              request('schedule-arm-confirmed-routine-request', routine),
            cancelRoutine: (/** @type {string} */ id) =>
              request('schedule-cancel-routine-request', { id }),
          });
          result = await executeControllerScheduleTool(
            call.name, call.args, scheduleAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsDwebTool(call.name)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { ...effectBinding(), ...value }));
          const dwebAuthority = Object.freeze({
            discoverApps: () => request('dweb-discover-apps-request'),
            publishConfirmedApp: (/** @type {string} */ appId) =>
              request('dweb-publish-confirmed-app-request', { appId }),
            installConfirmedApp: (/** @type {string} */ uri,
              /** @type {string|undefined} */ name) =>
              request('dweb-install-confirmed-app-request', { uri, name }),
            readPeers: () => request('dweb-read-peers-request'),
            setPeerBlocked: (/** @type {string} */ did, /** @type {boolean} */ block,
              /** @type {string|undefined} */ reason) =>
              request('dweb-set-peer-blocked-request', { did, block, reason }),
            setDiscoveryEnabled: (/** @type {boolean} */ enabled) =>
              request('dweb-set-discovery-enabled-request', { enabled }),
            runMeshProgram: (/** @type {string} */ code,
              /** @type {number} */ timeoutMs) =>
              request('dweb-run-mesh-program-request', { code, timeoutMs }),
          });
          result = await executeControllerDwebTool(
            call.name, call.args, projection,
            dwebAuthority, { signal: abort.signal },
          );
        } else throw Object.assign(new Error('controller tool has no semantic owner'), {
          code: 'controller-tool-execution-owner-missing', outcomeKnown: true,
        });
      } catch (cause) {
        const failure = normalizeSemanticToolFailure(cause, {
          effectCount: options.effectCounter?.count ?? 0,
        });
        result = {
          ok: false,
          ...failure,
          code: failure.code ?? 'controller-tool-execution-failed',
        };
      }
      return result;
    };
    executeOwnedTool = executeActorTool;
    try {
      // Seed the actor's PRIOR history — a bound actor is stateful across turns.
      const sessions = makeInMemorySessions({
        sessionId: metadata.sessionId,
        provider: program.provider,
        model: program.model,
        kind: metadata.recordKind === 'spawned' ? 'spawned' : 'actor',
        depth: metadata.depth,
        messages: state.messages,
        trimSummary: state.trimSummary,
      });
      semanticSession = await sessions.get(metadata.sessionId);
      const modelEgress = createActorModelEgress({
        openInference, readInferenceChunk, cancelInference, readModelContext,
        openLocalGeneration, readLocalGeneration, cancelLocalGeneration,
      });
      const liveWindow = await providerModelContextWindow(program.provider, program.model, {
        modelEgress, signal: abort.signal,
      });
      const contextWindow = contextWindowFor(program.model, {
        overrides: program.contextWindowOverrides,
        live: liveWindow ?? undefined,
      });
      // Provider/model/output policy is pinned twice: this SW-authored program
      // fixes semantic selection here, and the SW grant independently rejects a
      // mismatched native request before credentials or network are reachable.
      const callModel = (/** @type {any} */ args) => callProviderModel({
        ...args,
        provider: program.provider,
        model: program.model,
        ...(program.maxOutputTokens != null
          ? { maxTokens: program.maxOutputTokens }
          : {}),
        modelEgress,
      });
      const toolDispatch = (/** @type {any} */ call) => controllerHostsTool(call?.name)
        ? executeActorTool(call)
        : Promise.resolve({
          ok: false, error: 'actor tool has no controller owner', outcomeKnown: true,
        });
      // Phase 3: a WEB/API actor self-fences its own untrusted-provenance rolling
      // summary. The SW's closure (over a policy-reduced live tab origin) can't
      // cross postMessage, so rebuild it here from the pure fence fns using the
      // turn-start provenance.
      const fenceActorSummary = makeActorSummaryFence({
        actorType: metadata.actorType,
        backing: metadata.backing,
        tabOrigin: metadata.tabOrigin,
        origin: metadata.origin,
      });
      const result = await runActorLoop(
        {
          runUserTurn, sessions, callModel, toolDispatch,
          // Scheduling is semantic, not authority. Classify the exact hydrated
          // descriptor the actor was shown under the immutable permission
          // projection pinned for this run, matching the main controller.
          classifyToolCall: (/** @type {string} */ name) => {
            const descriptor = descriptorsByName.get(name);
            if (!descriptor || !visibleToolNames.has(name)) return null;
            return decideAction({
              mode: semanticPolicy.permission?.mode,
              confirmActions: semanticPolicy.permission?.confirmActions,
              tool: descriptor,
            });
          },
          getSystemPrompt: () => program.systemPrompt,
          appendAudit: async () => {},
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
          tools: hydratedTools,
          ...(fenceActorSummary ? { fenceActorSummary } : {}),
        },
        {
          sessionId: metadata.sessionId,
          userText: execution.input,
          maxSteps: program.maxSteps,
          oneShot: metadata.oneShot,
          signal: abort.signal,
          reasoning: reasoningForTurn(program),
          ...(contextWindow == null ? {} : { contextWindow }),
          inbound: metadata.inbound === true,
          preflightReply: metadata.preflightReply,
        },
      );
      // why the worker does NOT stamp `aborted`: a Stop unwinds the loop cleanly (the
      // relay rejects, the loop stops with an empty reply), but whether that counts as
      // a cancellation vs a raced-but-completed turn is decided at the SW client, which
      // sees BOTH the authoritative Stop signal AND whether any reply came back
      // (signal.aborted && !finalText). A stamp here — ignorant of finalText — would
      // mislabel a turn that produced a real reply just before Stop as 'cancelled'.
      const projectedResult = projectResult === null
        ? result : projectResult(result, program, metadata);
      self.postMessage({
        type: 'done', runId,
        result: {
          ...projectedResult,
          price: costOf(program.model, result.usage, program.pricingOverrides, {
            localProvider: providerMetadata(program.provider)?.keyless === true,
          }),
        },
      });
    } catch (e) {
      self.postMessage({ type: 'error', runId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
});

// Posted only after the complete module graph evaluated and the listener above
// was installed. The host validates this plus a per-run realm canary before it
// sends any model input or grants tool relays.
self.postMessage({
  type: 'ready',
  protocol: ACTOR_WORKER_PROTOCOL,
  realm: realmProbe?.() ?? null,
});
};
