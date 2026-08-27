// @ts-check
// offscreen/actor-worker.js — the ONE Worker that runs any non-orchestrator agent
// loop in its own heap (the heap split): an ephemeral reasoning actor (tools:[],
// so the tool-relay below never fires) OR a bound actor (VM / Notebook / App / web,
// tool-bearing). Imperative shell over actor-worker-core. Provider semantics run
// HERE and pull from an exact SW-owned inference stream; tool effects still relay
// to the SW, which holds the key, engine clients, instance pin, and gate. The
// untrusted instance/page output stays in this heap. Module worker → strict.
import {
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
  controllerAuthorityClassForTool,
  controllerHostsTool,
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
import { createActorModelEgress } from './actor-model-egress.js';
import { ACTOR_WORKER_PROTOCOL } from './actor-worker-protocol.js';
import { projectContributorSettlement } from '/peerd-runtime/controller-contributor.js';

let seq = 0;
let runId = '';
/** @type {Map<string, (v: any) => void>} rid → pending model-authority resolver */
const modelPending = new Map();
/** @type {Map<string, (v: any) => void>} rid → pending tool-dispatch resolver */
const toolPending = new Map();
const abort = new AbortController();
let hasRun = false;
/** @type {((call:any,options?:{pageProgramParentExecutionId?:string})=>Promise<any>)|null} */
let executeOwnedTool = null;

const pageProgramRequest = (/** @type {any} */ message) => {
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

self.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
  const m = /** @type {any} */ (ev.data);
  if (!m || typeof m !== 'object') return;

  if (m.type === 'probe') {
    self.postMessage({
      type: 'probe-response',
      protocol: ACTOR_WORKER_PROTOCOL,
      rid: m.rid,
      canaryAbsent: typeof m.canaryName === 'string' && !(m.canaryName in globalThis),
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
  if (m.type === 'actor-tool-prepare-response'
      || m.type === 'actor-spawn-sync-response'
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
      || m.type === 'actor-tool-settle-response') {
    toolPending.get(m.rid)?.(m.reply);
    toolPending.delete(m.rid);
    return;
  }
  const nestedPageProgram = pageProgramRequest(m);
  if (nestedPageProgram) {
    const result = executeOwnedTool
      ? await executeOwnedTool({
          id: `${runId}:${String(m.rid ?? '')}`,
          name: nestedPageProgram.tool,
          args: m.args ?? {},
        }, { pageProgramParentExecutionId: m.parentExecutionId })
      : {
          ok: false, error: 'page program semantic owner is not ready',
          outcomeKnown: true,
        };
    self.postMessage({
      type: nestedPageProgram.response, rid: m.rid, result,
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
      if (reply?.ok === true) return reply.value;
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
      /** @type {{pageProgramParentExecutionId?:string}} */ options = {},
    ) => {
      const authorityClass = controllerAuthorityClassForTool(call?.name);
      if (authorityClass === null) {
        return {
          ok: false, error: 'actor tool has no controller authority class', outcomeKnown: true,
          meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
        };
      }
      const prepared = await actorToolRequest(
        'actor-tool-prepare-request', {
          call, authorityClass,
          ...(options.pageProgramParentExecutionId
            ? { pageProgramParentExecutionId: options.pageProgramParentExecutionId }
            : {}),
        },
      );
      if (prepared?.ok !== true) {
        return {
          ok: false, error: prepared?.error ?? 'actor tool preparation failed',
          outcomeKnown: prepared?.outcomeKnown === true,
          ...(prepared?.outcomeKnown === true ? {} : { retryable: false }),
          meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
        };
      }
      if (prepared.mode === 'result') return prepared.result;
      if (prepared.mode !== 'execute' || typeof prepared.executionId !== 'string') {
        return {
          ok: false, error: 'actor tool preparation was invalid', outcomeKnown: true,
          meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
        };
      }
      const executionId = prepared.executionId;
      const actorAuthority = Object.freeze({
        spawnSync: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-spawn-sync-request', {
            executionId, task: request.task,
            allowRecursion: request.allowRecursion === true,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          },
        )),
        spawnAsync: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-spawn-async-request', {
            executionId, task: request.task,
            allowRecursion: request.allowRecursion === true,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          },
        )),
        listTasks: () => authorityValue(actorToolRequest(
          'actor-tasks-read-request', { executionId },
        )),
        cancelTask: (/** @type {string} */ taskId) => authorityValue(actorToolRequest(
          'actor-task-cancel-request', { executionId, taskId },
        )),
        message: (/** @type {any} */ request) => authorityValue(actorToolRequest(
          'actor-message-deliver-request', {
            executionId, to: request.to, message: request.message,
            oneShot: request.oneShot === true,
            awaitReply: request.awaitReply === true,
            degradeToAsync: request.degradeToAsync === true,
            awaitCapMs: Number(request.awaitCapMs),
          },
        )),
      });
      let result;
      try {
        if (controllerHostsActorTool(prepared.toolName)) {
          result = await executeControllerActorTool(
            prepared.toolName, prepared.args, prepared.projection, actorAuthority,
            { callId: prepared.callId, signal: abort.signal },
          );
        } else if (controllerHostsPodTool(prepared.toolName)) {
          const podAuthority = Object.freeze({
            resolve: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-resolve-request', { executionId, podId: request?.podId },
            )),
            readRemote: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'pod-read-remote-request', { executionId, podId },
            )),
            confirmGit: (/** @type {string} */ op) => authorityValue(actorToolRequest(
              'pod-confirm-git-request', { executionId, op },
            )),
            executeCommand: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-exec-request', {
                executionId, command: request.command, podId: request.podId,
                timeoutMs: request.timeoutMs, background: request.background === true,
                remoteGitGrant: request.remoteGitGrant ?? null,
              },
            )),
            readStatus: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-status-request', {
                executionId, podId: request.podId, jobId: request.jobId,
                stream: request.stream, offset: request.offset, limit: request.limit,
              },
            )),
            cancelJob: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-cancel-request', {
                executionId, podId: request.podId, jobId: request.jobId,
              },
            )),
            readFile: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-read-file-request', {
                executionId, podId: request.podId, path: request.path,
              },
            )),
            writeFile: (/** @type {any} */ request) => authorityValue(actorToolRequest(
              'pod-write-file-request', {
                executionId, podId: request.podId, path: request.path,
                content: request.content,
              },
            )),
          });
          result = await executeControllerPodTool(
            prepared.toolName, prepared.args, prepared.projection, podAuthority,
            { signal: abort.signal },
          );
        } else if (controllerHostsRepositoryTool(prepared.toolName)) {
          const repositoryAuthority = Object.freeze({
            readPod: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'repository-read-pod-request', { executionId, podId },
            )),
            destroyPod: (/** @type {string} */ podId) => authorityValue(actorToolRequest(
              'repository-destroy-pod-request', { executionId, podId },
            )),
            readStatus: () => authorityValue(actorToolRequest(
              'repository-read-status-request', { executionId },
            )),
            readHistory: (/** @type {number} */ depth) => authorityValue(actorToolRequest(
              'repository-read-history-request', { executionId, depth },
            )),
            readRemote: () => authorityValue(actorToolRequest(
              'repository-read-remote-request', { executionId },
            )),
            readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) =>
              authorityValue(actorToolRequest(
                'repository-read-diff-request', { executionId, from, to },
              )),
            confirmRestore: (/** @type {string} */ to) => authorityValue(actorToolRequest(
              'repository-confirm-restore-request', { executionId, to },
            )),
            checkpoint: (/** @type {string} */ message) => authorityValue(actorToolRequest(
              'repository-checkpoint-request', { executionId, message },
            )),
            branch: (/** @type {string} */ name) => authorityValue(actorToolRequest(
              'repository-branch-request', { executionId, name },
            )),
            checkout: (/** @type {string} */ name) => authorityValue(actorToolRequest(
              'repository-checkout-request', { executionId, name },
            )),
            restore: (/** @type {string} */ to) => authorityValue(actorToolRequest(
              'repository-restore-request', { executionId, to },
            )),
            confirmRemote: (/** @type {string} */ op, /** @type {string} */ target,
              /** @type {string|undefined} */ branch) => authorityValue(actorToolRequest(
              'repository-confirm-remote-request', { executionId, op, target, branch },
            )),
            link: (/** @type {string} */ url) => authorityValue(actorToolRequest(
              'repository-link-request', { executionId, url },
            )),
            fetch: (/** @type {string} */ target) => authorityValue(actorToolRequest(
              'repository-fetch-request', { executionId, target },
            )),
            push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) =>
              authorityValue(actorToolRequest(
                'repository-push-request', { executionId, target, branch },
              )),
          });
          result = await executeControllerRepositoryTool(
            prepared.toolName, prepared.args, prepared.projection, repositoryAuthority,
            { signal: abort.signal },
          );
        } else if (controllerHostsVmTool(prepared.toolName)) {
          const vmAuthority = Object.freeze({
            readVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-read-request', { executionId, vmId },
            )),
            listVms: () => authorityValue(actorToolRequest(
              'vm-list-request', { executionId },
            )),
            setDefaultVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-set-default-request', { executionId, vmId },
            )),
            runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
              /** @type {string|undefined} */ vmId) => authorityValue(actorToolRequest(
              'vm-run-request', { executionId, command, timeoutMs, vmId },
            )),
            importFile: (/** @type {string} */ url, /** @type {string} */ path,
              /** @type {number} */ maxBytes) => authorityValue(actorToolRequest(
              'vm-import-file-request', { executionId, url, path, maxBytes },
            )),
            writeTextFile: (/** @type {string} */ path, /** @type {string} */ content) =>
              authorityValue(actorToolRequest(
                'vm-write-text-file-request', { executionId, path, content },
              )),
            destroyVm: (/** @type {string} */ vmId) => authorityValue(actorToolRequest(
              'vm-destroy-request', { executionId, vmId },
            )),
          });
          result = await executeControllerVmTool(
            prepared.toolName, prepared.args, vmAuthority,
          );
        } else if (controllerHostsNotebookTool(prepared.toolName)) {
          const notebookAuthority = Object.freeze({
            readNotebook: (/** @type {string} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-read-request', { executionId, notebookId },
            )),
            listNotebooks: () => authorityValue(actorToolRequest(
              'notebook-list-request', { executionId },
            )),
            setDefaultNotebook: (/** @type {string} */ notebookId) =>
              authorityValue(actorToolRequest(
                'notebook-set-default-request', { executionId, notebookId },
              )),
            runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-run-request', { executionId, code, timeoutMs, notebookId },
            )),
            writeFile: (/** @type {string} */ path, /** @type {string} */ content,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-write-file-request', { executionId, path, content, notebookId },
            )),
            readFile: (/** @type {string} */ path,
              /** @type {string|undefined} */ notebookId) => authorityValue(actorToolRequest(
              'notebook-read-file-request', { executionId, path, notebookId },
            )),
            destroyNotebook: (/** @type {string} */ notebookId) =>
              authorityValue(actorToolRequest(
                'notebook-destroy-request', { executionId, notebookId },
              )),
          });
          result = await executeControllerNotebookTool(
            prepared.toolName, prepared.args, notebookAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsAppTool(prepared.toolName)) {
          const appAuthority = Object.freeze({
            updateApp: (
              /** @type {string|undefined} */ appId,
              /** @type {string|undefined} */ name,
              /** @type {string|undefined} */ html,
              /** @type {string[]|undefined} */ tags,
              /** @type {string|undefined} */ entryFile,
            ) => authorityValue(actorToolRequest(
              'app-update-request', { executionId, appId, name, html, tags, entryFile },
            )),
            openApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-open-request', { executionId, appId },
            )),
            searchApps: (/** @type {string} */ query) => authorityValue(actorToolRequest(
              'app-search-request', { executionId, query },
            )),
            readApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-read-request', { executionId, appId },
            )),
            deleteApp: (/** @type {string} */ appId) => authorityValue(actorToolRequest(
              'app-delete-request', { executionId, appId },
            )),
            writeFile: (
              /** @type {string|undefined} */ appId,
              /** @type {string} */ path,
              /** @type {unknown} */ content,
            ) => authorityValue(actorToolRequest(
              'app-write-file-request', { executionId, appId, path, content },
            )),
            readFile: (
              /** @type {string|undefined} */ appId, /** @type {string} */ path,
            ) => authorityValue(actorToolRequest(
              'app-read-file-request', { executionId, appId, path },
            )),
            listFiles: (/** @type {string|undefined} */ appId) =>
              authorityValue(actorToolRequest(
                'app-list-files-request', { executionId, appId },
              )),
            deleteFile: (
              /** @type {string|undefined} */ appId, /** @type {string} */ path,
            ) => authorityValue(actorToolRequest(
              'app-delete-file-request', { executionId, appId, path },
            )),
            observeRuntime: () => authorityValue(actorToolRequest(
              'app-observe-request', { executionId },
            )),
            actRuntime: (
              /** @type {string} */ action,
              /** @type {Record<string,unknown>} */ params,
            ) => authorityValue(actorToolRequest(
              'app-act-request', { executionId, action, params },
            )),
            runCode: (/** @type {string} */ code, /** @type {number} */ timeoutMs) =>
              authorityValue(actorToolRequest(
                'app-run-code-request', { executionId, code, timeoutMs },
              )),
          });
          result = await executeControllerAppTool(
            prepared.toolName, prepared.args, appAuthority, prepared.projection,
          );
        } else if (controllerHostsPersistenceTool(prepared.toolName)) {
          const persistenceAuthority = Object.freeze({
            readMemoryScope: (/** @type {any} */ scope) => authorityValue(actorToolRequest(
              'memory-read-scope-request', { executionId, scope },
            )),
            readMemorySubtree: (/** @type {string} */ workspace,
              /** @type {string} */ subpath) => authorityValue(actorToolRequest(
              'memory-read-subtree-request', { executionId, workspace, subpath },
            )),
            writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) =>
              authorityValue(actorToolRequest(
                'memory-write-request', { executionId, scope, body },
              )),
            readTodos: () => authorityValue(actorToolRequest(
              'todo-read-request', { executionId },
            )),
            replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) =>
              authorityValue(actorToolRequest(
                'todo-replace-request', { executionId, version, todos },
              )),
          });
          result = await executeControllerPersistenceTool(
            prepared.toolName, prepared.args, prepared.projection, persistenceAuthority,
          );
        } else if (controllerHostsPageTool(prepared.toolName)) {
          const request = (/** @type {string} */ type) => authorityValue(actorToolRequest(
            type, { executionId },
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
            prepared.toolName, prepared.args, pageAuthority,
          );
        } else if (controllerHostsResourceTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
          const resourceAuthority = Object.freeze({
            confirmWebWrite: (/** @type {string} */ url, /** @type {string} */ method) =>
              request('resource-confirm-web-write-request', { url, method }),
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
            prepared.toolName, prepared.args, resourceAuthority, prepared.projection,
          );
        } else if (controllerHostsSiteClientTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
          const siteClientAuthority = Object.freeze({
            readStoredClient: (/** @type {string} */ origin) =>
              request('site-client-read-request', { origin }),
            runStoredClient: (/** @type {string} */ origin, /** @type {string} */ code,
              /** @type {number} */ timeoutMs) =>
              request('site-client-run-request', { origin, code, timeoutMs }),
            commitConfirmedClient: (/** @type {string} */ origin) =>
              request('site-client-commit-request', { origin }),
            startOwnedCapture: () => request('site-client-capture-start-request'),
            stopOwnedCapture: () => request('site-client-capture-stop-request'),
          });
          result = await executeControllerSiteClientTool(
            prepared.toolName, prepared.args, siteClientAuthority,
          );
        } else if (controllerHostsExecutionTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
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
            prepared.toolName, prepared.args, executionAuthority, prepared.projection,
          );
        } else if (controllerHostsEditingTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
          const editingAuthority = Object.freeze({
            readEditTarget: (/** @type {any} */ target) =>
              request('editing-read-target-request', target),
            writeEditTarget: (/** @type {any} */ target) =>
              request('editing-write-target-request', target),
          });
          result = await executeControllerEditingTool(
            prepared.toolName, prepared.args, editingAuthority,
          );
        } else if (controllerHostsIntrospectionTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
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
            prepared.toolName, prepared.args, prepared.projection,
            introspectionAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsScheduleTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
          const scheduleAuthority = Object.freeze({
            readRoutines: () => request('schedule-read-routines-request'),
            armConfirmedRoutine: (/** @type {any} */ routine) =>
              request('schedule-arm-confirmed-routine-request', routine),
            cancelRoutine: (/** @type {string} */ id) =>
              request('schedule-cancel-routine-request', { id }),
          });
          result = await executeControllerScheduleTool(
            prepared.toolName, prepared.args, scheduleAuthority, { signal: abort.signal },
          );
        } else if (controllerHostsDwebTool(prepared.toolName)) {
          const request = (/** @type {string} */ type, /** @type {any} */ value = {}) =>
            authorityValue(actorToolRequest(type, { executionId, ...value }));
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
            prepared.toolName, prepared.args, prepared.projection,
            dwebAuthority, { signal: abort.signal },
          );
        } else throw Object.assign(new Error('controller tool has no semantic owner'), {
          code: 'controller-tool-execution-owner-missing', outcomeKnown: true,
        });
      } catch (cause) {
        const failure = /** @type {{message?:string,code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
        result = {
          ok: false,
          error: failure?.message ?? String(cause),
          ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
          outcomeKnown: failure?.outcomeKnown === true,
          retryable: failure?.outcomeKnown === true && failure?.retryable !== false,
        };
      }
      const settled = await actorToolRequest('actor-tool-settle-request', {
        executionId, result,
      });
      if (settled?.ok === true) return settled.result;
      return {
        ok: false, error: settled?.error ?? 'actor tool settlement failed',
        outcomeKnown: settled?.outcomeKnown === true,
        ...(settled?.outcomeKnown === true ? {} : { retryable: false }),
        meta: { toolName: call?.name, primitive: 'spawned', gates: [], durationMs: 0 },
      };
    };
    executeOwnedTool = executeActorTool;
    try {
      // Seed the actor's PRIOR history — a bound actor is stateful across turns.
      const sessions = makeInMemorySessions({
        sessionId: metadata.sessionId,
        provider: program.provider,
        model: program.model,
        depth: metadata.depth,
        messages: state.messages,
      });
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
          getSystemPrompt: () => program.systemPrompt,
          appendAudit: async () => {},
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
          tools: hydrateToolDescriptors(
            Array.isArray(m.tools) ? m.tools : [], m.runtimeCapabilities,
          ),
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
      const contributor = metadata.actorType === 'web' && metadata.backing === 'tab'
        ? projectContributorSettlement(result, program.provider, program.model)
        : null;
      self.postMessage({
        type: 'done', runId,
        result: {
          ...result,
          ...(contributor ? { contributor } : {}),
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
  realm: {
    dedicatedWorker: globalThis.constructor?.name === 'DedicatedWorkerGlobalScope',
    window: typeof window !== 'undefined',
    document: typeof document !== 'undefined',
    browser: 'browser' in globalThis,
    chrome: 'chrome' in globalThis,
  },
});
