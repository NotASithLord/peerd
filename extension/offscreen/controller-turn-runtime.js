// @ts-check
// Lazy sealed-Worker handler for the orchestrator controller. The tiny prompt
// runtime imports this fixed package-local module only after a turn.run commit.

import {
  controllerHostsActorTool,
  controllerHostsPodTool,
  controllerHostsRepositoryTool,
  controllerHostsVmTool,
  controllerHostsNotebookTool,
  controllerHostsAppTool,
  controllerHostsPersistenceTool,
  executeControllerActorTool,
  executeControllerPodTool,
  executeControllerRepositoryTool,
  executeControllerVmTool,
  executeControllerNotebookTool,
  executeControllerAppTool,
  executeControllerPersistenceTool,
  runUserTurn,
} from '/peerd-runtime/controller-turn.js';
import { hydrateToolDescriptors } from '/peerd-runtime/semantic.js';
import { controllerHostsTool } from '/shared/controller-tool-manifest.js';
import { legacyToolAllowed } from '/shared/legacy-tool-allowlist.js';
import {
  callModel as callProviderModel,
  contextWindowFor,
  listProviders,
  planFailoverChain,
  providerMetadata,
  providerModelContextWindow,
  shouldFailover,
} from '/peerd-provider/controller.js';
import { createControllerModelEgress } from './model-egress-client.js';

const isRecord = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const parseJson = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (typeof value !== 'string') throw new Error(`${label} wire payload is invalid`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} wire payload is invalid`); }
};

const TOOL_RPC_CONCURRENCY = 64;

/**
 * Backpressure large read-only waves before they enter private-channel
 * custody. This narrows resource use without reducing the loop's batch size.
 * @param {AbortSignal} signal
 */
const makeToolBackpressure = (signal) => {
  let active = 0;
  /** @type {Array<{resolve:()=>void,reject:(cause:unknown)=>void}>} */
  const waiting = [];
  const drain = () => {
    if (signal.aborted) {
      const cause = new DOMException('controller turn aborted', 'AbortError');
      while (waiting.length > 0) waiting.shift()?.reject(cause);
      return;
    }
    while (active < TOOL_RPC_CONCURRENCY && waiting.length > 0) {
      active += 1;
      waiting.shift()?.resolve();
    }
  };
  signal.addEventListener('abort', drain, { once: true });
  return async (/** @type {()=>Promise<any>} */ operation) => {
    if (signal.aborted) throw new DOMException('controller turn aborted', 'AbortError');
    if (active >= TOOL_RPC_CONCURRENCY) {
      await new Promise((resolve, reject) => {
        waiting.push({ resolve: () => resolve(undefined), reject });
      });
    } else {
      active += 1;
    }
    try { return await operation(); }
    finally { active = Math.max(0, active - 1); drain(); }
  };
};

const turnValue = async (
  /** @type {(operation:string, payload:unknown)=>Promise<any>} */ kernelCall,
  /** @type {string} */ operation,
  /** @type {unknown} */ payload,
  /** @type {() => void} */ markUnknown,
) => {
  const result = await kernelCall(operation, payload);
  if (result?.ok === true) return result.value;
  if (result?.outcomeKnown !== true) markUnknown();
  const error = new Error(result?.error ?? result?.code ?? `kernel ${operation} failed`);
  Object.assign(error, {
    code: result?.code ?? 'kernel-call-failed',
    outcomeKnown: result?.outcomeKnown === true,
  });
  throw error;
};

/** @param {unknown} value */
const isTurnPayload = (value) => {
  if (!isRecord(value)) return false;
  const input = /** @type {Record<string, any>} */ (value);
  return typeof input.runId === 'string' && input.runId.length >= 8 && input.runId.length <= 512
    && typeof input.sessionId === 'string' && input.sessionId.length > 0
    && input.sessionId.length <= 512
    && typeof input.ctxJson === 'string'
    && typeof input.toolsJson === 'string'
    && isRecord(input.classifications);
};

/**
 * Production turn handler. All non-pure operations are reverse RPCs into the
 * exact run-scoped authority closure in controller-turn-bridge.js.
 * @param {unknown} payload
 * @param {{ signal: AbortSignal, authority?: unknown,
 *   kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} options
 * @param {((request:unknown,options:{signal:AbortSignal,authority:unknown,
 *   deadlineAt:number,kernelCall:(operation:string,payload:unknown)=>Promise<any>})=>
 *   Promise<any>)|undefined} executeToolCall
 */
const runControllerTurnWith = async (payload, options, executeToolCall) => {
  if (!isTurnPayload(payload) || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'turn-payload-invalid', outcomeKnown: true };
  }
  const input = /** @type {Record<string, any>} */ (payload);
  const authority = /** @type {Record<string, any>} */ (options.authority ?? {});
  if (authority.sessionId !== input.sessionId || authority.target !== 'orchestrator-turn'
      || authority.replayClass !== 'E') {
    return { ok: false, code: 'turn-authority-invalid', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  const ctx = parseJson(input.ctxJson, 'turn context');
  const toolProjection = parseJson(input.toolsJson, 'turn tools');
  if (!isRecord(ctx) || !Array.isArray(toolProjection)) {
    return { ok: false, code: 'turn-payload-invalid', outcomeKnown: true };
  }
  const tools = hydrateToolDescriptors(toolProjection, ctx.runtimeCapabilities);
  const withToolSlot = makeToolBackpressure(options.signal);
  const runId = input.runId;
  let nestedUnknown = false;
  let abortFinalized = false;
  const rpc = (/** @type {string} */ operation, /** @type {unknown} */ value) =>
    turnValue(kernelCall, operation, { runId, value }, () => { nestedUnknown = true; });
  /** @type {Set<Promise<unknown>>} */
  const advisory = new Set();
  const trackAdvisory = (/** @type {Promise<unknown>} */ promise) => {
    advisory.add(promise);
    promise.finally(() => advisory.delete(promise)).catch(() => {});
    return promise;
  };
  let classifications = /** @type {Record<string, any>} */ ({ ...input.classifications });
  const modelEgress = createControllerModelEgress({ call: rpc });
  const providersByName = new Map(listProviders().map((provider) => [provider.name, provider]));
  const configuredFallbacks = ctx.providerFailoverEnabled === true
    && Array.isArray(ctx.providerFallbacks)
    ? ctx.providerFallbacks.flatMap((/** @type {unknown} */ name) => {
      const provider = typeof name === 'string' ? providersByName.get(name) : null;
      return provider ? [{ provider: provider.name, model: provider.defaultModel }] : [];
    }) : [];
  /** @type {{provider:string,model:string}|null} */
  let failoverLastGood = null;
  /** @type {{provider:string,model:string}[]|null} */
  let boundCandidates = null;
  const bindCandidates = async (/** @type {{provider:string,model:string}} */ primary) => {
    if (boundCandidates) return boundCandidates;
    const candidates = planFailoverChain(primary, configuredFallbacks);
    const bound = await rpc('turn.model.bind', { candidates });
    if (!Array.isArray(bound?.candidates)) throw new Error('kernel model plan did not bind');
    boundCandidates = candidates;
    return candidates;
  };
  const callModel = async function* (/** @type {Record<string, any>} */ args) {
    const {
      getSecret: _getSecret, safeFetch: _safeFetch, signal: _signal, ...modelRequest
    } = args;
    const requestedProvider = String(modelRequest.provider ?? '');
    const requestedMetadata = providerMetadata(requestedProvider);
    const requestedModel = String(modelRequest.model ?? '') || requestedMetadata?.defaultModel || '';
    const primary = failoverLastGood ?? {
      provider: requestedProvider,
      model: requestedModel,
    };
    await bindCandidates({ provider: requestedProvider, model: requestedModel });
    const chain = planFailoverChain(primary, configuredFallbacks);
    let lastError;
    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      let streamedContent = false;
      try {
        for await (const event of callProviderModel(/** @type {any} */ ({
          ...modelRequest,
          provider: candidate.provider,
          model: candidate.model,
          signal: options.signal,
          modelEgress,
        }))) {
          if (event?.type === 'tool-use-start') {
            await rpc('turn.model.observe-event', {
              type: event.type, id: event.id, name: event.name,
            });
          } else if (event?.type === 'tool-use-delta') {
            await rpc('turn.model.observe-event', {
              type: event.type, id: event.id, partialJson: event.partialJson,
            });
          }
          if (event?.type !== 'rate-limit-pause') streamedContent = true;
          yield event;
        }
        failoverLastGood = candidate;
        return;
      } catch (cause) {
        lastError = cause;
        const final = index === chain.length - 1;
        const aborted = options.signal.aborted
          || /** @type {{name?:string}} */ (cause)?.name === 'AbortError';
        if (aborted || streamedContent || final || (index === 0 && !shouldFailover(cause))) {
          throw cause;
        }
        const next = chain[index + 1];
        await rpc('turn.model.observe-failover', {
          from: candidate, to: next,
          reason: /** @type {{name?:string}} */ (cause)?.name ?? 'error',
        });
      }
    }
    throw lastError;
  };
  const sessions = {
    get: async (/** @type {string} */ sessionId) => parseJson(
      await rpc('turn.session.get', { sessionId }), 'session',
    ),
    appendMessage: async (/** @type {string} */ sessionId, /** @type {unknown} */ message) =>
      parseJson(await rpc('turn.session.append', {
        sessionId, messageJson: JSON.stringify(message),
      }), 'session'),
    updateAssistantMessage: (
      /** @type {string} */ sessionId,
      /** @type {string} */ messageId,
      /** @type {unknown} */ patch,
    ) => rpc('turn.session.update-assistant', {
      sessionId, messageId, patchJson: JSON.stringify(patch),
    }),
    setTrimSummary: (/** @type {string} */ sessionId, /** @type {unknown} */ state) =>
      rpc('turn.session.set-trim', { sessionId, stateJson: JSON.stringify(state) }),
  };
  try {
    const session = await sessions.get(input.sessionId);
    const metadata = providerMetadata(session?.provider);
    const model = String(session?.model ?? '') || metadata?.defaultModel || '';
    if (!metadata || !model) throw new Error('controller model selection unavailable');
    await bindCandidates({ provider: metadata.name, model });
    const liveWindow = await providerModelContextWindow(metadata.name, model, {
      modelEgress, signal: options.signal,
    });
    const contextWindow = contextWindowFor(model, {
      overrides: isRecord(ctx.contextWindowOverrides)
        ? /** @type {Record<string,number>} */ (ctx.contextWindowOverrides) : undefined,
      live: liveWindow ?? undefined,
    });
    for await (const event of runUserTurn({
      ...ctx,
      contextWindow,
      sessionId: input.sessionId,
      tools,
      signal: options.signal,
      sessions,
      callModel,
      getSecret: async () => { throw new Error('credential access is kernel-owned'); },
      safeFetch: async () => { throw new Error('egress is kernel-owned'); },
      getSystemPrompt: () => rpc('turn.prompt.get', {}),
      appendAudit: (/** @type {unknown} */ entry) =>
        trackAdvisory(rpc('turn.audit.append', { entry })),
      refreshTools: async () => {
        const refreshed = await rpc('turn.tools.refresh', {});
        classifications = isRecord(refreshed?.classifications)
          ? { ...refreshed.classifications } : {};
        if (typeof refreshed?.toolsJson !== 'string') return [];
        const projection = parseJson(refreshed.toolsJson, 'turn tools');
        if (!Array.isArray(projection)) throw new Error('turn tools wire payload is invalid');
        return hydrateToolDescriptors(projection, ctx.runtimeCapabilities);
      },
      toolDispatch: (/** @type {unknown} */ call) => withToolSlot(async () => {
        const legacyDispatch = async () => parseJson(await rpc('turn.tool.dispatch', {
          callJson: JSON.stringify(call),
        }), 'tool result');
        if (!controllerHostsTool(/** @type {any} */ (call)?.name)
            && !legacyToolAllowed(/** @type {any} */ (call)?.name)) {
          throw Object.assign(new Error('tool has no execution owner'), {
            code: 'tool-execution-owner-missing', outcomeKnown: true,
          });
        }
        if (typeof executeToolCall !== 'function') {
          if (controllerHostsTool(/** @type {any} */ (call)?.name)) {
            throw Object.assign(new Error('controller tool executor unavailable'), {
              code: 'controller-tool-executor-unavailable', outcomeKnown: true,
            });
          }
          const result = await legacyDispatch();
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        const prepared = await rpc('turn.tool.prepare', {
          callJson: JSON.stringify(call),
        });
        if (prepared?.mode === 'legacy') {
          if (controllerHostsTool(/** @type {any} */ (call)?.name)) {
            throw Object.assign(new Error('controller tool preparation unavailable'), {
              code: 'controller-tool-preparation-unavailable', outcomeKnown: true,
            });
          }
          const result = await legacyDispatch();
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        if (prepared?.mode === 'result') {
          const result = parseJson(prepared.resultJson, 'tool result');
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        if (prepared?.mode !== 'execute' || typeof prepared.requestJson !== 'string'
            || !Number.isSafeInteger(prepared.deadlineAt)) {
          throw new Error('kernel tool preparation is invalid');
        }
        const request = parseJson(prepared.requestJson, 'tool execution request');
        if (!isRecord(request) || typeof request.executionId !== 'string'
            || typeof request.argsDigest !== 'string'
            || !Number.isSafeInteger(request.turnGeneration)
            || typeof request.toolName !== 'string') {
          throw new Error('kernel tool execution request is invalid');
        }
        let execution;
        try {
          const binding = {
            executionId: request.executionId,
            argsDigest: request.argsDigest,
            turnGeneration: request.turnGeneration,
          };
          if (controllerHostsActorTool(request.toolName)) {
            const actorAuthority = Object.freeze({
              spawnSync: (/** @type {any} */ actorRequest) => rpc('turn.actor.spawn-sync', {
                ...binding,
                task: actorRequest.task,
                allowRecursion: actorRequest.allowRecursion === true,
                ...(actorRequest.tools === undefined ? {} : { tools: actorRequest.tools }),
                ...(actorRequest.maxSteps === undefined ? {} : { maxSteps: actorRequest.maxSteps }),
                ...(actorRequest.maxDepth === undefined ? {} : { maxDepth: actorRequest.maxDepth }),
              }),
              spawnAsync: (/** @type {any} */ actorRequest) => rpc('turn.actor.spawn-async', {
                ...binding,
                task: actorRequest.task,
                allowRecursion: actorRequest.allowRecursion === true,
                ...(actorRequest.tools === undefined ? {} : { tools: actorRequest.tools }),
                ...(actorRequest.maxSteps === undefined ? {} : { maxSteps: actorRequest.maxSteps }),
                ...(actorRequest.maxDepth === undefined ? {} : { maxDepth: actorRequest.maxDepth }),
              }),
              listTasks: () => rpc('turn.actor.tasks', binding),
              cancelTask: (/** @type {string} */ taskId) =>
                rpc('turn.actor.cancel', { ...binding, taskId }),
              message: (/** @type {any} */ actorRequest) => rpc('turn.actor.message', {
                ...binding,
                to: actorRequest.to,
                message: actorRequest.message,
                oneShot: actorRequest.oneShot === true,
                awaitReply: actorRequest.awaitReply === true,
                degradeToAsync: actorRequest.degradeToAsync === true,
                awaitCapMs: Number(actorRequest.awaitCapMs),
              }),
            });
            const value = await executeControllerActorTool(
              request.toolName, request.args, request.projection, actorAuthority,
              { callId: request.callId, signal: options.signal },
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsPodTool(request.toolName)) {
            const podAuthority = Object.freeze({
              resolve: (/** @type {any} */ podRequest) => rpc('turn.pod.resolve', {
                ...binding, podId: podRequest?.podId,
              }),
              readRemote: (/** @type {string} */ podId) => rpc('turn.pod.read-remote', {
                ...binding, podId,
              }),
              confirmGit: (/** @type {string} */ op) => rpc('turn.pod.confirm-git', {
                ...binding, op,
              }),
              executeCommand: (/** @type {any} */ podRequest) => rpc('turn.pod.exec', {
                ...binding,
                command: podRequest.command,
                podId: podRequest.podId,
                timeoutMs: podRequest.timeoutMs,
                background: podRequest.background === true,
                remoteGitGrant: podRequest.remoteGitGrant ?? null,
              }),
              readStatus: (/** @type {any} */ podRequest) => rpc('turn.pod.status', {
                ...binding,
                podId: podRequest.podId,
                jobId: podRequest.jobId,
                stream: podRequest.stream,
                offset: podRequest.offset,
                limit: podRequest.limit,
              }),
              cancelJob: (/** @type {any} */ podRequest) => rpc('turn.pod.cancel', {
                ...binding, podId: podRequest.podId, jobId: podRequest.jobId,
              }),
              readFile: (/** @type {any} */ podRequest) => rpc('turn.pod.read-file', {
                ...binding, podId: podRequest.podId, path: podRequest.path,
              }),
              writeFile: (/** @type {any} */ podRequest) => rpc('turn.pod.write-file', {
                ...binding, podId: podRequest.podId, path: podRequest.path,
                content: podRequest.content,
              }),
            });
            const value = await executeControllerPodTool(
              request.toolName, request.args, request.projection, podAuthority,
              { signal: options.signal },
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsRepositoryTool(request.toolName)) {
            const repositoryAuthority = Object.freeze({
              readPod: (/** @type {string} */ podId) => rpc('turn.repository.read-pod', {
                ...binding, podId,
              }),
              destroyPod: (/** @type {string} */ podId) => rpc('turn.repository.destroy-pod', {
                ...binding, podId,
              }),
              readStatus: () => rpc('turn.repository.read-status', binding),
              readHistory: (/** @type {number} */ depth) => rpc('turn.repository.read-history', {
                ...binding, depth,
              }),
              readRemote: () => rpc('turn.repository.read-remote', binding),
              readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) =>
                rpc('turn.repository.read-diff', { ...binding, from, to }),
              confirmRestore: (/** @type {string} */ to) =>
                rpc('turn.repository.confirm-restore', { ...binding, to }),
              checkpoint: (/** @type {string} */ message) =>
                rpc('turn.repository.checkpoint', { ...binding, message }),
              branch: (/** @type {string} */ name) =>
                rpc('turn.repository.branch', { ...binding, name }),
              checkout: (/** @type {string} */ name) =>
                rpc('turn.repository.checkout', { ...binding, name }),
              restore: (/** @type {string} */ to) =>
                rpc('turn.repository.restore', { ...binding, to }),
              confirmRemote: (/** @type {string} */ op, /** @type {string} */ target,
                /** @type {string|undefined} */ branch) =>
                rpc('turn.repository.confirm-remote', { ...binding, op, target, branch }),
              link: (/** @type {string} */ url) =>
                rpc('turn.repository.link', { ...binding, url }),
              fetch: (/** @type {string} */ target) =>
                rpc('turn.repository.fetch', { ...binding, target }),
              push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) =>
                rpc('turn.repository.push', { ...binding, target, branch }),
            });
            const value = await executeControllerRepositoryTool(
              request.toolName, request.args, request.projection, repositoryAuthority,
              { signal: options.signal },
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsVmTool(request.toolName)) {
            const vmAuthority = Object.freeze({
              readVm: (/** @type {string} */ vmId) => rpc('turn.vm.read', {
                ...binding, vmId,
              }),
              listVms: () => rpc('turn.vm.list', binding),
              setDefaultVm: (/** @type {string} */ vmId) => rpc('turn.vm.set-default', {
                ...binding, vmId,
              }),
              runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
                /** @type {string|undefined} */ vmId) => rpc('turn.vm.run', {
                ...binding, command, timeoutMs, vmId,
              }),
              importFile: (/** @type {string} */ url, /** @type {string} */ path,
                /** @type {number} */ maxBytes) => rpc('turn.vm.import-file', {
                ...binding, url, path, maxBytes,
              }),
              writeTextFile: (/** @type {string} */ path, /** @type {string} */ content) =>
                rpc('turn.vm.write-text-file', { ...binding, path, content }),
              destroyVm: (/** @type {string} */ vmId) => rpc('turn.vm.destroy', {
                ...binding, vmId,
              }),
            });
            const value = await executeControllerVmTool(
              request.toolName, request.args, vmAuthority,
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsNotebookTool(request.toolName)) {
            const notebookAuthority = Object.freeze({
              readNotebook: (/** @type {string} */ notebookId) => rpc('turn.notebook.read', {
                ...binding, notebookId,
              }),
              listNotebooks: () => rpc('turn.notebook.list', binding),
              setDefaultNotebook: (/** @type {string} */ notebookId) =>
                rpc('turn.notebook.set-default', { ...binding, notebookId }),
              runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
                /** @type {string|undefined} */ notebookId) => rpc('turn.notebook.run', {
                ...binding, code, timeoutMs, notebookId,
              }),
              writeFile: (/** @type {string} */ path, /** @type {string} */ content,
                /** @type {string|undefined} */ notebookId) =>
                rpc('turn.notebook.write-file', { ...binding, path, content, notebookId }),
              readFile: (/** @type {string} */ path,
                /** @type {string|undefined} */ notebookId) =>
                rpc('turn.notebook.read-file', { ...binding, path, notebookId }),
              destroyNotebook: (/** @type {string} */ notebookId) =>
                rpc('turn.notebook.destroy', { ...binding, notebookId }),
            });
            const value = await executeControllerNotebookTool(
              request.toolName, request.args, notebookAuthority, { signal: options.signal },
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsAppTool(request.toolName)) {
            const appAuthority = Object.freeze({
              updateApp: (
                /** @type {string|undefined} */ appId,
                /** @type {string|undefined} */ name,
                /** @type {string|undefined} */ html,
                /** @type {string[]|undefined} */ tags,
                /** @type {string|undefined} */ entryFile,
              ) => rpc('turn.app.update', {
                ...binding, appId, name, html, tags, entryFile,
              }),
              openApp: (/** @type {string} */ appId) => rpc('turn.app.open', {
                ...binding, appId,
              }),
              searchApps: (/** @type {string} */ query) => rpc('turn.app.search', {
                ...binding, query,
              }),
              readApp: (/** @type {string} */ appId) => rpc('turn.app.read', {
                ...binding, appId,
              }),
              deleteApp: (/** @type {string} */ appId) => rpc('turn.app.delete', {
                ...binding, appId,
              }),
              writeFile: (
                /** @type {string|undefined} */ appId,
                /** @type {string} */ path,
                /** @type {unknown} */ content,
              ) => rpc('turn.app.write-file', { ...binding, appId, path, content }),
              readFile: (
                /** @type {string|undefined} */ appId, /** @type {string} */ path,
              ) => rpc('turn.app.read-file', { ...binding, appId, path }),
              listFiles: (/** @type {string|undefined} */ appId) =>
                rpc('turn.app.list-files', { ...binding, appId }),
              deleteFile: (
                /** @type {string|undefined} */ appId, /** @type {string} */ path,
              ) => rpc('turn.app.delete-file', { ...binding, appId, path }),
              observeRuntime: () => rpc('turn.app.observe', binding),
              actRuntime: (
                /** @type {string} */ action,
                /** @type {Record<string,unknown>} */ params,
              ) => rpc('turn.app.act', { ...binding, action, params }),
              runCode: (/** @type {string} */ code, /** @type {number} */ timeoutMs) =>
                rpc('turn.app.run-code', { ...binding, code, timeoutMs }),
            });
            const value = await executeControllerAppTool(
              request.toolName, request.args, appAuthority, request.projection,
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else if (controllerHostsPersistenceTool(request.toolName)) {
            const persistenceAuthority = Object.freeze({
              readMemoryScope: (/** @type {any} */ scope) =>
                rpc('turn.memory.read-scope', { ...binding, scope }),
              readMemorySubtree: (/** @type {string} */ workspace,
                /** @type {string} */ subpath) => rpc('turn.memory.read-subtree', {
                ...binding, workspace, subpath,
              }),
              writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) =>
                rpc('turn.memory.write', { ...binding, scope, body }),
              readTodos: () => rpc('turn.todo.read', binding),
              replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) =>
                rpc('turn.todo.replace', { ...binding, version, todos }),
            });
            const value = await executeControllerPersistenceTool(
              request.toolName, request.args, request.projection, persistenceAuthority,
            );
            execution = {
              protocol: request.protocol,
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              ok: true,
              outcomeKnown: true,
              effectEntered: true,
              value,
            };
          } else execution = await executeToolCall(request, {
            signal: options.signal,
            authority: {
              ownerId: runId,
              sessionId: input.sessionId,
              target: `tool:${request.toolName}`,
              replayClass: 'E',
            },
            deadlineAt: prepared.deadlineAt,
            kernelCall: (operation, effectPayload) => rpc('turn.tool.effect', {
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              turnGeneration: request.turnGeneration,
              operation,
              effectPayload,
            }),
          });
        } catch (cause) {
          const error = /** @type {{message?:string,code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
          execution = {
            protocol: request.protocol,
            executionId: request.executionId,
            argsDigest: request.argsDigest,
            ok: false,
            code: error?.code ?? 'tool-execution-host-lost',
            error: error?.message ?? 'Tool execution interrupted.',
            outcomeKnown: error?.outcomeKnown !== false,
            effectEntered: false,
            retryable: error?.retryable ?? error?.outcomeKnown !== false,
            phase: 'run',
          };
        }
        const result = parseJson(await rpc('turn.tool.settle', {
          executionId: request.executionId,
          argsDigest: request.argsDigest,
          turnGeneration: request.turnGeneration,
          resultJson: JSON.stringify(execution),
        }), 'tool result');
        if (result?.outcomeKnown === false) nestedUnknown = true;
        return result;
      }),
      finalizeAbort: async (/** @type {any} */ value) => {
        await rpc('turn.abort.finalize', value);
        abortFinalized = true;
      },
      classifyToolCall: (/** @type {string} */ name) => classifications[name] ?? null,
      enrichTrimSummary: (/** @type {unknown} */ request) => {
        trackAdvisory(rpc('turn.trim.enrich', { request })).catch(() => {});
      },
    })) {
      try { await rpc('turn.event', { eventJson: JSON.stringify(event) }); }
      catch (cause) {
        if (!options.signal.aborted) throw cause;
      }
    }
    if (advisory.size > 0) await Promise.allSettled([...advisory]);
    await rpc('turn.finalize', {});
    if (nestedUnknown) throw new Error('a dispatched kernel operation has an unknown outcome');
    if (options.signal.aborted && !abortFinalized) {
      throw Object.assign(new Error('controller turn aborted before finalization'), {
        outcomeKnown: false,
      });
    }
    return { ok: true, outcomeKnown: true };
  } catch (cause) {
    const detail = /** @type {{code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
    return {
      ok: false,
      code: detail?.outcomeKnown === false && typeof detail.code === 'string' ? detail.code
        : options.signal.aborted ? 'controller-call-aborted'
        : detail?.code ?? 'turn-run-failed',
      outcomeKnown: detail?.outcomeKnown === false ? false
        : options.signal.aborted && !abortFinalized ? false : !nestedUnknown,
      ...(detail?.retryable === false ? { retryable: false } : {}),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/**
 * Bind a lazy local tool executor without placing its implementation graph in
 * the default turn module. The plain export remains the compatibility path.
 * @param {{executeToolCall?:(request:unknown,options:{signal:AbortSignal,
 *   authority:unknown,deadlineAt:number,
 *   kernelCall:(operation:string,payload:unknown)=>Promise<any>})=>Promise<any>}} [deps]
 */
export const createControllerTurnRuntime = ({ executeToolCall } = {}) => Object.freeze({
  runControllerTurn: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
    runControllerTurnWith(payload, options, executeToolCall),
});

export const runControllerTurn = (
  /** @type {unknown} */ payload,
  /** @type {{signal:AbortSignal,authority?:unknown,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options,
) =>
  runControllerTurnWith(payload, options, undefined);
