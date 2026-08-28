// @ts-check
// Lazy sealed-Worker handler for the orchestrator controller. The tiny prompt
// runtime imports this fixed package-local module only after a turn.run commit.

import {
  controllerHostsActorTool,
  controllerHostsLocalTool,
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
  controllerOperationsForSpawnedTools,
  decideAction,
  dispatchToolCall,
  executeControllerActorTool,
  executeControllerLocalTool,
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
  projectControllerToolSurface,
  planToolsCommand,
  reasoningForTurn,
  runUserTurn,
  semanticHooksFor,
} from '/peerd-runtime/controller-turn.js';
import { hydrateToolDescriptors } from '/peerd-runtime/semantic.js';
import { buildTemporalBlock, buildTemporalContext } from '/peerd-runtime/controller.js';
import {
  callModel as callProviderModel,
  costOf,
  contextWindowFor,
  listProviders,
  planFailoverChain,
  providerFailureCode,
  providerMetadata,
  providerModelContextWindow,
  shouldFailover,
} from '/peerd-provider/controller.js';
import { createControllerModelEgress } from './model-egress-client.js';
import { normalizeSemanticToolFailure } from '/shared/semantic-tool-failure.js';

const isRecord = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const parseJson = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (typeof value !== 'string') throw new Error(`${label} wire payload is invalid`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} wire payload is invalid`); }
};

const TOOL_RPC_CONCURRENCY = 64;

/** @param {Record<string, any>} ctx */
const contextMessageForTurn = (ctx) => {
  if (!Number.isFinite(ctx.turnNow)
      || !(ctx.previousTurnAt === null || Number.isFinite(ctx.previousTurnAt))
      || !(ctx.activeTabContext === null || (isRecord(ctx.activeTabContext)
        && typeof ctx.activeTabContext.url === 'string'
        && ctx.activeTabContext.url.length <= 2048
        && (ctx.activeTabContext.title === undefined
          || typeof ctx.activeTabContext.title === 'string')))
      || !(ctx.protectedTabContext === null
        || ctx.protectedTabContext === 'private_network'
        || ctx.protectedTabContext === 'sensitive_site')
      || !(ctx.recoveryBlock === undefined || (typeof ctx.recoveryBlock === 'string'
        && ctx.recoveryBlock.length <= 16 * 1024))) {
    throw new Error('turn context projection is invalid');
  }
  const temporalBlock = buildTemporalBlock({
    lastTurnAt: ctx.previousTurnAt,
    nowMs: ctx.turnNow,
  });
  return [buildTemporalContext({
    temporalBlock,
    activeTab: ctx.activeTabContext,
    protectedTab: ctx.protectedTabContext,
  }), ctx.recoveryBlock].filter(Boolean).join('\n\n');
};

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
    ...(typeof result?.retryable === 'boolean' ? { retryable: result.retryable } : {}),
    ...(result?.authorityReceipt ? { authorityReceipt: result.authorityReceipt } : {}),
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
    && Number.isSafeInteger(input.turnGeneration);
};

/**
 * Production turn handler. All non-pure operations are reverse RPCs into the
 * exact run-scoped authority closure in controller-turn-bridge.js.
 * @param {unknown} payload
 * @param {{ signal: AbortSignal, authority?: unknown,
 *   kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} options
 */
const runControllerTurnWith = async (payload, options) => {
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
  let descriptorsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const childOperationsFor = (/** @type {any} */ request) =>
    controllerOperationsForSpawnedTools(
      descriptorsByName.keys(), request.tools, request.allowRecursion === true,
    );
  const semanticPolicy = isRecord(ctx.semanticPolicy) ? ctx.semanticPolicy : {};
  const semanticHooks = semanticHooksFor(semanticPolicy.userHookRecords);
  const effectSequences = new Map();
  const effectBinding = (/** @type {string} */ callId) => {
    const effectSequence = (effectSequences.get(callId) ?? 0) + 1;
    effectSequences.set(callId, effectSequence);
    return Object.freeze({
      callId, effectId: `${callId}:${effectSequence}`,
      effectSequence, turnGeneration: input.turnGeneration,
    });
  };
  const withToolSlot = makeToolBackpressure(options.signal);
  const runId = input.runId;
  let nestedUnknown = false;
  let abortFinalized = false;
  const rpc = async (/** @type {string} */ operation, /** @type {unknown} */ value) => {
    try {
      const reply = await turnValue(
        kernelCall, operation, { runId, value }, () => { nestedUnknown = true; },
      );
      return isRecord(reply?.authorityReceipt) ? reply.authorityValue : reply;
    } catch (cause) { throw cause; }
  };
  /** @type {Set<Promise<unknown>>} */
  const advisory = new Set();
  const trackAdvisory = (/** @type {Promise<unknown>} */ promise) => {
    advisory.add(promise);
    promise.finally(() => advisory.delete(promise)).catch(() => {});
    return promise;
  };
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
          const provider = providerMetadata(candidate.provider);
          yield event?.type === 'usage' ? {
            ...event,
            price: costOf(candidate.model, event.usage, ctx.pricingOverrides, {
              localProvider: provider?.keyless === true,
            }),
          } : event;
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
      contextMessage: contextMessageForTurn(ctx),
      reasoning: reasoningForTurn(ctx),
      contextWindow,
      sessionId: input.sessionId,
      tools,
      signal: options.signal,
      sessions,
      callModel,
      getSecret: async () => { throw new Error('credential access is kernel-owned'); },
      safeFetch: async () => { throw new Error('egress is kernel-owned'); },
      getSystemPrompt: () => rpc('turn.prompt.get', {}),
      // Semantic diagnostics stay in bounded tool results. Durable audit facts
      // are derived by the exact host authority from validated effects.
      appendAudit: async () => {},
      refreshTools: async () => {
        const refreshed = await rpc('turn.tools.refresh', {});
        if (typeof refreshed?.toolsJson !== 'string') return [];
        const projection = parseJson(refreshed.toolsJson, 'turn tools');
        if (!Array.isArray(projection)) throw new Error('turn tools wire payload is invalid');
        const refreshedTools = hydrateToolDescriptors(projection, ctx.runtimeCapabilities);
        descriptorsByName = new Map(refreshedTools.map((tool) => [tool.name, tool]));
        return refreshedTools;
      },
      toolDispatch: (/** @type {unknown} */ call) => withToolSlot(async () => {
        const localName = /** @type {any} */ (call)?.name;
        const descriptor = descriptorsByName.get(localName);
        if (!descriptor || !controllerHostsTool(localName)) {
          throw Object.assign(new Error('tool has no execution owner'), {
            code: 'tool-execution-owner-missing', outcomeKnown: true,
          });
        }
        return dispatchToolCall(/** @type {any} */ (call), {
          ...semanticPolicy,
          hooks: semanticHooks,
          session,
          abortSignal: options.signal,
          authorityOwnsLifecycle: true,
          runtimeCapabilities: ctx.runtimeCapabilities,
          audit: async () => {},
        }, {
          descriptor,
          execute: async (prepared) => {
            const request = {
              toolName: localName,
              args: prepared.args,
              projection: {
                sessionId: session?.sessionId,
                sessionDepth: session?.depth ?? 0,
                sessionKind: session?.kind ?? 'chat',
                inbound: semanticPolicy.inbound === true,
                activeTabOrigin: semanticPolicy.activeTab?.origin,
                goalActive: semanticPolicy.goalActive === true,
                runtimeCapabilities: ctx.runtimeCapabilities,
                messageCount: semanticPolicy.messageCount ?? 0,
                trimCovered: semanticPolicy.trimCovered ?? 0,
                // why: use the already-fetched, externally sanitized session.
                // The outer turn policy must never duplicate raw transcript or
                // attachment bytes beside the opaque-token session channel.
                messages: Array.isArray(session?.messages) ? session.messages : [],
                dwebAvailable: semanticPolicy.dwebAvailable === true,
                actorType: semanticPolicy.actorType,
                actorInstanceId: semanticPolicy.actorInstanceId,
              },
            };
            let effectCount = 0;
            const binding = () => {
              effectCount += 1;
              return effectBinding(/** @type {any} */ (call).id);
            };
            try {
          if (controllerHostsLocalTool(request.toolName)) {
            const value = await executeControllerLocalTool(
              request.toolName,
              request.args,
              Object.freeze({
                completeGoal: async (/** @type {string} */ summary) => ({
                  ok: true,
                  outcomeKnown: true,
                  value: await rpc('turn.goal.complete', { ...binding(), summary }),
                }),
              }),
            );
            return value;
          } else if (controllerHostsActorTool(request.toolName)) {
            const actorAuthority = Object.freeze({
              spawnSync: (/** @type {any} */ actorRequest) => rpc('turn.actor.spawn-sync', {
                ...binding(),
                task: actorRequest.task,
                allowRecursion: actorRequest.allowRecursion === true,
                grantedOperations: childOperationsFor(actorRequest),
                ...(actorRequest.tools === undefined ? {} : { tools: actorRequest.tools }),
                ...(actorRequest.maxSteps === undefined ? {} : { maxSteps: actorRequest.maxSteps }),
                ...(actorRequest.maxDepth === undefined ? {} : { maxDepth: actorRequest.maxDepth }),
              }),
              spawnAsync: (/** @type {any} */ actorRequest) => rpc('turn.actor.spawn-async', {
                ...binding(),
                task: actorRequest.task,
                allowRecursion: actorRequest.allowRecursion === true,
                grantedOperations: childOperationsFor(actorRequest),
                ...(actorRequest.tools === undefined ? {} : { tools: actorRequest.tools }),
                ...(actorRequest.maxSteps === undefined ? {} : { maxSteps: actorRequest.maxSteps }),
                ...(actorRequest.maxDepth === undefined ? {} : { maxDepth: actorRequest.maxDepth }),
              }),
              listTasks: () => rpc('turn.actor.tasks', binding()),
              cancelTask: (/** @type {string} */ taskId) =>
                rpc('turn.actor.cancel', { ...binding(), taskId }),
              message: (/** @type {any} */ actorRequest) => rpc('turn.actor.message', {
                ...binding(),
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
              { callId: /** @type {any} */ (call).id, signal: options.signal },
            );
            return value;
          } else if (controllerHostsPodTool(request.toolName)) {
            const podAuthority = Object.freeze({
              resolve: (/** @type {any} */ podRequest) => rpc('turn.pod.resolve', {
                ...binding(), podId: podRequest?.podId,
                ...(typeof request.args?.command === 'string'
                  ? { command: request.args.command } : {}),
              }),
              readRemote: (/** @type {string} */ podId) => rpc('turn.pod.read-remote', {
                ...binding(), podId,
              }),
              confirmGit: (/** @type {string} */ op) => rpc('turn.pod.confirm-git', {
                ...binding(), op,
              }),
              executeCommand: (/** @type {any} */ podRequest) => rpc('turn.pod.exec', {
                ...binding(),
                command: podRequest.command,
                podId: podRequest.podId,
                timeoutMs: podRequest.timeoutMs,
                background: podRequest.background === true,
                remoteGitGrant: podRequest.remoteGitGrant ?? null,
              }),
              readStatus: (/** @type {any} */ podRequest) => rpc('turn.pod.status', {
                ...binding(),
                podId: podRequest.podId,
                jobId: podRequest.jobId,
                stream: podRequest.stream,
                offset: podRequest.offset,
                limit: podRequest.limit,
              }),
              cancelJob: (/** @type {any} */ podRequest) => rpc('turn.pod.cancel', {
                ...binding(), podId: podRequest.podId, jobId: podRequest.jobId,
              }),
              readFile: (/** @type {any} */ podRequest) => rpc('turn.pod.read-file', {
                ...binding(), podId: podRequest.podId, path: podRequest.path,
              }),
              writeFile: (/** @type {any} */ podRequest) => rpc('turn.pod.write-file', {
                ...binding(), podId: podRequest.podId, path: podRequest.path,
                content: podRequest.content,
              }),
            });
            const value = await executeControllerPodTool(
              request.toolName, request.args, request.projection, podAuthority,
              { signal: options.signal },
            );
            return value;
          } else if (controllerHostsRepositoryTool(request.toolName)) {
            const repositoryAuthority = Object.freeze({
              readPod: (/** @type {string} */ podId) => rpc('turn.repository.read-pod', {
                ...binding(), podId,
              }),
              destroyPod: (/** @type {string} */ podId) => rpc('turn.repository.destroy-pod', {
                ...binding(), podId,
              }),
              readStatus: () => rpc('turn.repository.read-status', binding()),
              readHistory: (/** @type {number} */ depth) => rpc('turn.repository.read-history', {
                ...binding(), depth,
              }),
              readRemote: () => rpc('turn.repository.read-remote', binding()),
              readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) =>
                rpc('turn.repository.read-diff', { ...binding(), from, to }),
              confirmRestore: (/** @type {string} */ to) =>
                rpc('turn.repository.confirm-restore', { ...binding(), to }),
              checkpoint: (/** @type {string} */ message) =>
                rpc('turn.repository.checkpoint', { ...binding(), message }),
              branch: (/** @type {string} */ name) =>
                rpc('turn.repository.branch', { ...binding(), name }),
              checkout: (/** @type {string} */ name) =>
                rpc('turn.repository.checkout', { ...binding(), name }),
              restore: (/** @type {string} */ to) =>
                rpc('turn.repository.restore', { ...binding(), to }),
              confirmRemote: (/** @type {string} */ op, /** @type {string} */ target,
                /** @type {string|undefined} */ branch) =>
                rpc('turn.repository.confirm-remote', {
                  ...binding(), op, target, branch,
                  ...(typeof request.args?.url === 'string' ? { url: request.args.url } : {}),
                }),
              link: (/** @type {string} */ url) =>
                rpc('turn.repository.link', { ...binding(), url }),
              fetch: (/** @type {string} */ target) =>
                rpc('turn.repository.fetch', { ...binding(), target }),
              push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) =>
                rpc('turn.repository.push', { ...binding(), target, branch }),
            });
            const value = await executeControllerRepositoryTool(
              request.toolName, request.args, request.projection, repositoryAuthority,
              { signal: options.signal },
            );
            return value;
          } else if (controllerHostsVmTool(request.toolName)) {
            const vmAuthority = Object.freeze({
              readVm: (/** @type {string} */ vmId) => rpc('turn.vm.read', {
                ...binding(), vmId,
              }),
              listVms: () => rpc('turn.vm.list', binding()),
              setDefaultVm: (/** @type {string} */ vmId) => rpc('turn.vm.set-default', {
                ...binding(), vmId,
              }),
              runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
                /** @type {string|undefined} */ vmId) => rpc('turn.vm.run', {
                ...binding(), command, timeoutMs, vmId,
              }),
              importFile: (/** @type {string} */ url, /** @type {string} */ path,
                /** @type {number} */ maxBytes) => rpc('turn.vm.import-file', {
                ...binding(), url, path, maxBytes,
              }),
              writeTextFile: (/** @type {string} */ path, /** @type {string} */ content) =>
                rpc('turn.vm.write-text-file', { ...binding(), path, content }),
              destroyVm: (/** @type {string} */ vmId) => rpc('turn.vm.destroy', {
                ...binding(), vmId,
              }),
            });
            const value = await executeControllerVmTool(
              request.toolName, request.args, vmAuthority,
            );
            return value;
          } else if (controllerHostsNotebookTool(request.toolName)) {
            const notebookAuthority = Object.freeze({
              readNotebook: (/** @type {string} */ notebookId) => rpc('turn.notebook.read', {
                ...binding(), notebookId,
              }),
              listNotebooks: () => rpc('turn.notebook.list', binding()),
              setDefaultNotebook: (/** @type {string} */ notebookId) =>
                rpc('turn.notebook.set-default', { ...binding(), notebookId }),
              runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
                /** @type {string|undefined} */ notebookId) => rpc('turn.notebook.run', {
                ...binding(), code, timeoutMs, notebookId,
              }),
              writeFile: (/** @type {string} */ path, /** @type {string} */ content,
                /** @type {string|undefined} */ notebookId) =>
                rpc('turn.notebook.write-file', { ...binding(), path, content, notebookId }),
              readFile: (/** @type {string} */ path,
                /** @type {string|undefined} */ notebookId) =>
                rpc('turn.notebook.read-file', { ...binding(), path, notebookId }),
              destroyNotebook: (/** @type {string} */ notebookId) =>
                rpc('turn.notebook.destroy', { ...binding(), notebookId }),
            });
            const value = await executeControllerNotebookTool(
              request.toolName, request.args, notebookAuthority, { signal: options.signal },
            );
            return value;
          } else if (controllerHostsAppTool(request.toolName)) {
            const appAuthority = Object.freeze({
              updateApp: (
                /** @type {string|undefined} */ appId,
                /** @type {string|undefined} */ name,
                /** @type {string|undefined} */ html,
                /** @type {string[]|undefined} */ tags,
                /** @type {string|undefined} */ entryFile,
              ) => rpc('turn.app.update', {
                ...binding(), appId, name, html, tags, entryFile,
              }),
              openApp: (/** @type {string} */ appId) => rpc('turn.app.open', {
                ...binding(), appId,
              }),
              searchApps: (/** @type {string} */ query) => rpc('turn.app.search', {
                ...binding(), query,
              }),
              readApp: (/** @type {string} */ appId) => rpc('turn.app.read', {
                ...binding(), appId,
              }),
              deleteApp: (/** @type {string} */ appId) => rpc('turn.app.delete', {
                ...binding(), appId,
              }),
              writeFile: (
                /** @type {string|undefined} */ appId,
                /** @type {string} */ path,
                /** @type {unknown} */ content,
              ) => rpc('turn.app.write-file', { ...binding(), appId, path, content }),
              readFile: (
                /** @type {string|undefined} */ appId, /** @type {string} */ path,
              ) => rpc('turn.app.read-file', { ...binding(), appId, path }),
              listFiles: (/** @type {string|undefined} */ appId) =>
                rpc('turn.app.list-files', { ...binding(), appId }),
              deleteFile: (
                /** @type {string|undefined} */ appId, /** @type {string} */ path,
              ) => rpc('turn.app.delete-file', { ...binding(), appId, path }),
              observeRuntime: () => rpc('turn.app.observe', binding()),
              actRuntime: (
                /** @type {string} */ action,
                /** @type {Record<string,unknown>} */ params,
              ) => rpc('turn.app.act', { ...binding(), action, params }),
              runCode: (/** @type {string} */ code, /** @type {number} */ timeoutMs) =>
                rpc('turn.app.run-code', { ...binding(), code, timeoutMs }),
            });
            const value = await executeControllerAppTool(
              request.toolName, request.args, appAuthority, request.projection,
            );
            return value;
          } else if (controllerHostsPersistenceTool(request.toolName)) {
            const persistenceAuthority = Object.freeze({
              readMemoryScope: (/** @type {any} */ scope) =>
                rpc('turn.memory.read-scope', { ...binding(), scope }),
              readMemorySubtree: (/** @type {string} */ workspace,
                /** @type {string} */ subpath) => rpc('turn.memory.read-subtree', {
                ...binding(), workspace, subpath,
              }),
              writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) =>
                rpc('turn.memory.write', { ...binding(), scope, body }),
              readTodos: () => rpc('turn.todo.read', binding()),
              replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) =>
                rpc('turn.todo.replace', { ...binding(), version, todos }),
            });
            const value = await executeControllerPersistenceTool(
              request.toolName, request.args, request.projection, persistenceAuthority,
            );
            return value;
          } else if (controllerHostsPageTool(request.toolName)) {
            const pageAuthority = Object.freeze({
              openProtectedBackgroundTab: () => rpc('turn.page.open-tab', {
                ...binding(), args: prepared.args,
              }),
              readOwnedPage: () => rpc('turn.page.read', {
                ...binding(), args: prepared.args,
              }),
              captureOwnedAccessibilityTree: () => rpc('turn.page.snapshot', {
                ...binding(), args: prepared.args,
              }),
              readOwnedFrameworkState: () => rpc('turn.page.read-state', {
                ...binding(), args: prepared.args,
              }),
              drainOwnedDomChanges: () => rpc('turn.page.watch-changes', {
                ...binding(), args: prepared.args,
              }),
              queryOwnedDom: () => rpc('turn.page.query-dom', {
                ...binding(), args: prepared.args,
              }),
              navigateOwnedTab: () => rpc('turn.page.navigate', {
                ...binding(), args: prepared.args,
              }),
              fillOwnedTarget: () => rpc('turn.page.fill', {
                ...binding(), args: prepared.args,
              }),
              clickOwnedTarget: () => rpc('turn.page.click', {
                ...binding(), args: prepared.args,
              }),
              performConfirmedOwnedLogin: () => rpc('turn.page.login', {
                ...binding(), args: prepared.args,
              }),
              runOwnedPageProgram: () => rpc('turn.page.run-program', {
                ...binding(), args: prepared.args,
              }),
              captureForegroundPixels: () => rpc('turn.page.capture-foreground', {
                ...binding(), args: prepared.args,
              }),
              captureOwnedTabPixels: () => rpc('turn.page.capture-owned', {
                ...binding(), args: prepared.args,
              }),
            });
            const value = await executeControllerPageTool(
              request.toolName, request.args, pageAuthority,
            );
            return value;
          } else if (controllerHostsResourceTool(request.toolName)) {
            const resourceAuthority = Object.freeze({
              confirmWebWrite: (/** @type {any} */ webRequest) =>
                rpc('turn.resource.confirm-web-write', { ...binding(), ...webRequest }),
              requestWebText: (/** @type {any} */ webRequest) =>
                rpc('turn.resource.request-web-text', { ...binding(), ...webRequest }),
              extractReadableMarkdown: (/** @type {string} */ html,
                /** @type {string} */ url) => rpc('turn.resource.extract-markdown', {
                ...binding(), html, url,
              }),
              extractDocument: (/** @type {any} */ documentRequest) =>
                rpc('turn.resource.extract-document', { ...binding(), ...documentRequest }),
              spillResult: (/** @type {any} */ record) =>
                rpc('turn.resource.spill-result', { ...binding(), ...record }),
              readResult: (/** @type {string} */ key) =>
                rpc('turn.resource.read-result', { ...binding(), key }),
            });
            const value = await executeControllerResourceTool(
              request.toolName, request.args, resourceAuthority, request.projection,
            );
            return value;
          } else if (controllerHostsSiteClientTool(request.toolName)) {
            const siteClientAuthority = Object.freeze({
              readStoredClient: (/** @type {string} */ origin) =>
                rpc('turn.site-client.read', { ...binding(), origin }),
              runStoredClient: (/** @type {string} */ origin, /** @type {string} */ code,
                /** @type {number} */ timeoutMs) =>
                rpc('turn.site-client.run', { ...binding(), origin, code, timeoutMs }),
              commitConfirmedClient: (/** @type {string} */ origin) =>
                rpc('turn.site-client.commit', {
                  ...binding(), origin,
                  ...(typeof request.args?.summary === 'string'
                    ? { summary: request.args.summary } : {}),
                  ...(Array.isArray(request.args?.endpoints)
                    ? { endpoints: request.args.endpoints } : {}),
                  ...(request.args?.auth !== undefined ? { auth: request.args.auth } : {}),
                  ...(request.args?.deriver !== undefined
                    ? { deriver: request.args.deriver } : {}),
                  ...(typeof request.args?.body === 'string' ? { body: request.args.body } : {}),
                }),
              startOwnedCapture: () => rpc('turn.site-client.capture-start', binding()),
              stopOwnedCapture: () => rpc('turn.site-client.capture-stop', binding()),
            });
            const value = await executeControllerSiteClientTool(
              request.toolName, request.args, siteClientAuthority,
            );
            return value;
          } else if (controllerHostsExecutionTool(request.toolName)) {
            const executionAuthority = Object.freeze({
              createWebVm: (/** @type {any} */ plan) =>
                rpc('turn.execution.create-webvm', { ...binding(), plan }),
              createNotebook: (/** @type {any} */ plan) =>
                rpc('turn.execution.create-notebook', { ...binding(), plan }),
              createPod: (/** @type {any} */ plan) =>
                rpc('turn.execution.create-pod', { ...binding(), plan }),
              createApp: (/** @type {any} */ plan) =>
                rpc('turn.execution.create-app', { ...binding(), plan }),
              runHeadlessScript: (/** @type {any} */ scriptRequest) =>
                rpc('turn.execution.run-script', { ...binding(), ...scriptRequest }),
              spillScriptValue: (/** @type {any} */ record) =>
                rpc('turn.execution.spill-script', { ...binding(), ...record }),
            });
            const value = await executeControllerExecutionTool(
              request.toolName, request.args, executionAuthority, request.projection,
            );
            return value;
          } else if (controllerHostsEditingTool(request.toolName)) {
            const editingAuthority = Object.freeze({
              readEditTarget: (/** @type {any} */ target) =>
                rpc('turn.editing.read-target', { ...binding(), ...target }),
              writeEditTarget: (/** @type {any} */ target) =>
                rpc('turn.editing.write-target', { ...binding(), ...target }),
            });
            const value = await executeControllerEditingTool(
              request.toolName, request.args, editingAuthority,
            );
            return value;
          } else if (controllerHostsIntrospectionTool(request.toolName)) {
            const introspectionAuthority = Object.freeze({
              readActorRoster: () => rpc('turn.introspection.actor-roster', binding()),
              readProviderPosture: () => rpc('turn.introspection.provider-posture', binding()),
              readStorageSnapshot: (/** @type {string|undefined} */ prefix) =>
                rpc('turn.introspection.storage-snapshot', { ...binding(), prefix }),
              readAutomatableTabs: () =>
                rpc('turn.introspection.automatable-tabs', binding()),
              readDenylistPatterns: () =>
                rpc('turn.introspection.denylist-patterns', binding()),
              readAuditEntries: () => rpc('turn.introspection.audit-entries', binding()),
              readInstalledSkill: (/** @type {string} */ name) =>
                rpc('turn.introspection.installed-skill', { ...binding(), name }),
            });
            const value = await executeControllerIntrospectionTool(
              request.toolName, request.args, request.projection,
              introspectionAuthority, { signal: options.signal },
            );
            return value;
          } else if (controllerHostsScheduleTool(request.toolName)) {
            const scheduleAuthority = Object.freeze({
              readRoutines: () => rpc('turn.schedule.read-routines', binding()),
              armConfirmedRoutine: (/** @type {any} */ routine) =>
                rpc('turn.schedule.arm-confirmed-routine', { ...binding(), ...routine }),
              cancelRoutine: (/** @type {string} */ id) =>
                rpc('turn.schedule.cancel-routine', { ...binding(), id }),
            });
            const value = await executeControllerScheduleTool(
              request.toolName, request.args, scheduleAuthority, { signal: options.signal },
            );
            return value;
          } else if (controllerHostsDwebTool(request.toolName)) {
            const dwebAuthority = Object.freeze({
              discoverApps: () => rpc('turn.dweb.discover-apps', binding()),
              publishConfirmedApp: (/** @type {string} */ appId) =>
                rpc('turn.dweb.publish-confirmed-app', { ...binding(), appId }),
              installConfirmedApp: (/** @type {string} */ uri,
                /** @type {string|undefined} */ name) =>
                rpc('turn.dweb.install-confirmed-app', { ...binding(), uri, name }),
              readPeers: () => rpc('turn.dweb.read-peers', binding()),
              setPeerBlocked: (/** @type {string} */ did, /** @type {boolean} */ block,
                /** @type {string|undefined} */ reason) =>
                rpc('turn.dweb.set-peer-blocked', { ...binding(), did, block, reason }),
              setDiscoveryEnabled: (/** @type {boolean} */ enabled) =>
                rpc('turn.dweb.set-discovery-enabled', { ...binding(), enabled }),
              runMeshProgram: (/** @type {string} */ code,
                /** @type {number} */ timeoutMs) =>
                rpc('turn.dweb.run-mesh-program', { ...binding(), code, timeoutMs }),
            });
            const value = await executeControllerDwebTool(
              request.toolName, request.args, request.projection,
              dwebAuthority, { signal: options.signal },
            );
            return value;
          } else throw Object.assign(new Error('controller tool executor unavailable'), {
            code: 'controller-tool-executor-unavailable', outcomeKnown: true,
          });
        } catch (cause) {
          const failure = normalizeSemanticToolFailure(cause, { effectCount });
          return {
            ok: false,
            error: failure.error,
            code: failure.code ?? 'controller-tool-execution-failed',
            outcomeKnown: failure.outcomeKnown,
            retryable: failure.retryable,
          };
        }
          },
        });
      }),
      // Name/descriptor scheduling stays inside this sealed semantic heap. The
      // authority host receives only exact operation requests and never a tool
      // classification table.
      classifyToolCall: (/** @type {string} */ name) => {
        const descriptor = descriptorsByName.get(name);
        if (!descriptor) return null;
        return decideAction({
          mode: semanticPolicy.permission?.mode,
          confirmActions: semanticPolicy.permission?.confirmActions,
          tool: descriptor,
        });
      },
      finalizeAbort: async (/** @type {any} */ value) => {
        await rpc('turn.abort.finalize', value);
        abortFinalized = true;
      },
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
    const modelFailure = providerFailureCode(cause);
    return {
      ok: false,
      code: detail?.outcomeKnown === false && typeof detail.code === 'string' ? detail.code
        : options.signal.aborted ? 'controller-call-aborted'
        : modelFailure ?? detail?.code ?? 'turn-run-failed',
      outcomeKnown: detail?.outcomeKnown === false ? false
        : options.signal.aborted && !abortFinalized ? false : !nestedUnknown,
      ...(detail?.retryable === false ? { retryable: false } : {}),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/**
 * Bind the single controller turn path. Tool semantics import only their exact
 * domain clients; no generic tool loader or effect dispatcher sits beside it.
 */
export const createControllerTurnRuntime = () => Object.freeze({
  projectTools: (/** @type {unknown} */ payload) => projectControllerToolSurface(payload),
  planToolsCommand: (/** @type {unknown} */ payload) => {
    if (!isRecord(payload)) {
      return { ok: false, code: 'turn-tools-command-invalid', outcomeKnown: true };
    }
    const input = /** @type {Record<string,any>} */ (payload);
    if (!Object.keys(input).every((key) => ['argument', 'currentManifest'].includes(key))
        || typeof input.argument !== 'string' || input.argument.length > 4096) {
      return { ok: false, code: 'turn-tools-command-invalid', outcomeKnown: true };
    }
    return {
      ok: true,
      plan: planToolsCommand(input.argument, input.currentManifest),
      outcomeKnown: true,
    };
  },
  runControllerTurn: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
    runControllerTurnWith(payload, options),
});

export const runControllerTurn = (
  /** @type {unknown} */ payload,
  /** @type {{signal:AbortSignal,authority?:unknown,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options,
) =>
  runControllerTurnWith(payload, options);
