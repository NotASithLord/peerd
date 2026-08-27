// @ts-check
// offscreen/actor-runner.js — hosts EVERY offscreen agent loop in dedicated Workers
// (the heap split): ephemeral spawned reasoners AND bound actors alike (a reasoning
// child just carries no tools, so its worker never prepares a tool). Forks one
// Worker per turn, relays exact model-authority stream requests and tool-dispatch
// requests to the SW, forwards loop events, and resolves with the turn result.

import { ACTOR_WORKER_PROTOCOL, ACTOR_WORKER_STARTUP_MS, validActorWorkerRealm } from './actor-worker-protocol.js';
import {
  AGENT_PROGRAM,
  describeExecution,
} from '/shared/execution-protocol.js';
import {
  registerPageProgramSemanticOwner,
  releasePageProgramSemanticOwner,
  settlePageProgramSemanticResponse,
} from './page-program-semantic-owner.js';
import { parseContributorProjection } from '/shared/contributor-channel.js';

const MAX_CONCURRENT = 4;
let active = 0;
let seq = 0;
/** @type {Map<string, { worker: Worker, stop: () => void }>} */
const liveWorkers = new Map();
// actor/abort can beat actor/run while the offscreen command messages cross.
// Keep a short, bounded tombstone so that ordering race cannot launch a Worker
// after Stop. Run ids are SW-minted and never reused intentionally.
/** @type {Map<string, number>} runId → expiry */
const abortedEarly = new Map();
const EARLY_ABORT_MAX = 64;
const EARLY_ABORT_TTL_MS = 60_000;
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
  state: { messages: Array.isArray(job.priorMessages) ? job.priorMessages : [] },
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
    backing: job.backing,
    tabOrigin: job.tabOrigin,
    origin: job.origin,
    inbound: job.inbound === true,
    preflightReply: job.preflightReply,
  },
});

const pruneEarlyAborts = (now = Date.now()) => {
  for (const [runId, expiresAt] of abortedEarly) {
    if (expiresAt > now) break;
    abortedEarly.delete(runId);
  }
  while (abortedEarly.size > EARLY_ABORT_MAX) {
    const oldest = abortedEarly.keys().next().value;
    if (typeof oldest !== 'string') break;
    abortedEarly.delete(oldest);
  }
};

/** @param {string} runId */
const rememberEarlyAbort = (runId) => {
  const now = Date.now();
  pruneEarlyAborts(now);
  abortedEarly.delete(runId);
  abortedEarly.set(runId, now + EARLY_ABORT_TTL_MS);
  pruneEarlyAborts(now);
};

/** @param {string} runId */
const consumeEarlyAbort = (runId) => {
  pruneEarlyAborts();
  if (!abortedEarly.has(runId)) return false;
  abortedEarly.delete(runId);
  return true;
};

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
 * @param {{ runId?: string, relayToken?: string, actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoningEnabled?: boolean, reasoningEffort?: string, contextWindowOverrides?:Record<string,number>, runtimeCapabilities?: object, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabOrigin?: string, origin?: string, inbound?: boolean, preflightReply?: string }} job
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
      let relayedUnknown = false;
      /** @type {boolean | undefined} */
      let relayedPerformed = undefined;
      let pendingToolRelays = 0;
      let pendingModelRelays = 0;
      let relayedLoopEvents = 0;
      /** @type {string|null} */
      let pageProgramSemanticToken = null;
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
        finish(relayedToolRequests > 0
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
          const result = options.observeResult ? reply?.result : undefined;
          if (reply?.outcomeKnown === false || result?.outcomeKnown === false) {
            relayedUnknown = true;
          }
          if (options.observeResult) {
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
        if (pageProgramSemanticToken
            && settlePageProgramSemanticResponse(pageProgramSemanticToken, m)) return;
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
              || m.canaryAbsent !== true || globalThis[/** @type {keyof typeof globalThis} */ (canaryName)] !== canaryValue) {
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
            runtimeCapabilities: job.runtimeCapabilities,
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
        if (m.type === 'actor-tool-prepare-request') {
          await relayExactToolMessage(m, 'actor-tool-prepare-response', () =>
            sendToSW('actor/tool-prepare', {
              ...(relayToken ? { relayToken } : {}), call: m.call,
              authorityClass: m.authorityClass,
              ...(m.pageProgramParentExecutionId
                ? { pageProgramParentExecutionId: m.pageProgramParentExecutionId }
                : {}),
            }), { countCall: true });
          return;
        }
        if (m.type === 'actor-spawn-sync-request') {
          await relayExactToolMessage(m, 'actor-spawn-sync-response', () =>
            sendToSW('actor/spawn-sync', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              task: m.task, allowRecursion: m.allowRecursion,
              ...(m.tools === undefined ? {} : { tools: m.tools }),
              ...(m.maxSteps === undefined ? {} : { maxSteps: m.maxSteps }),
              ...(m.maxDepth === undefined ? {} : { maxDepth: m.maxDepth }),
            }));
          return;
        }
        if (m.type === 'actor-spawn-async-request') {
          await relayExactToolMessage(m, 'actor-spawn-async-response', () =>
            sendToSW('actor/spawn-async', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              task: m.task, allowRecursion: m.allowRecursion,
              ...(m.tools === undefined ? {} : { tools: m.tools }),
              ...(m.maxSteps === undefined ? {} : { maxSteps: m.maxSteps }),
              ...(m.maxDepth === undefined ? {} : { maxDepth: m.maxDepth }),
            }));
          return;
        }
        if (m.type === 'actor-tasks-read-request') {
          await relayExactToolMessage(m, 'actor-tasks-read-response', () =>
            sendToSW('actor/tasks-read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'actor-task-cancel-request') {
          await relayExactToolMessage(m, 'actor-task-cancel-response', () =>
            sendToSW('actor/task-cancel', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              taskId: m.taskId,
            }));
          return;
        }
        if (m.type === 'actor-message-deliver-request') {
          await relayExactToolMessage(m, 'actor-message-deliver-response', () =>
            sendToSW('actor/message-deliver', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              to: m.to, message: m.message, oneShot: m.oneShot,
              awaitReply: m.awaitReply, degradeToAsync: m.degradeToAsync,
              awaitCapMs: m.awaitCapMs,
            }));
          return;
        }
        if (m.type === 'pod-resolve-request') {
          await relayExactToolMessage(m, 'pod-resolve-response', () =>
            sendToSW('pod/resolve', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId,
            }));
          return;
        }
        if (m.type === 'pod-read-remote-request') {
          await relayExactToolMessage(m, 'pod-read-remote-response', () =>
            sendToSW('pod/read-remote', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId,
            }));
          return;
        }
        if (m.type === 'pod-confirm-git-request') {
          await relayExactToolMessage(m, 'pod-confirm-git-response', () =>
            sendToSW('pod/confirm-git', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              op: m.op,
            }));
          return;
        }
        if (m.type === 'pod-exec-request') {
          await relayExactToolMessage(m, 'pod-exec-response', () =>
            sendToSW('pod/exec', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              command: m.command, podId: m.podId, timeoutMs: m.timeoutMs,
              background: m.background, remoteGitGrant: m.remoteGitGrant,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'pod-status-request') {
          await relayExactToolMessage(m, 'pod-status-response', () =>
            sendToSW('pod/status', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId, jobId: m.jobId, stream: m.stream,
              offset: m.offset, limit: m.limit,
            }));
          return;
        }
        if (m.type === 'pod-cancel-request') {
          await relayExactToolMessage(m, 'pod-cancel-response', () =>
            sendToSW('pod/cancel', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId, jobId: m.jobId,
            }));
          return;
        }
        if (m.type === 'pod-read-file-request') {
          await relayExactToolMessage(m, 'pod-read-file-response', () =>
            sendToSW('pod/read-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId, path: m.path,
            }));
          return;
        }
        if (m.type === 'pod-write-file-request') {
          await relayExactToolMessage(m, 'pod-write-file-response', () =>
            sendToSW('pod/write-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId, path: m.path, content: m.content,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-read-pod-request') {
          await relayExactToolMessage(m, 'repository-read-pod-response', () =>
            sendToSW('repository/read-pod', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId,
            }));
          return;
        }
        if (m.type === 'repository-destroy-pod-request') {
          await relayExactToolMessage(m, 'repository-destroy-pod-response', () =>
            sendToSW('repository/destroy-pod', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              podId: m.podId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-read-status-request') {
          await relayExactToolMessage(m, 'repository-read-status-response', () =>
            sendToSW('repository/read-status', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'repository-read-history-request') {
          await relayExactToolMessage(m, 'repository-read-history-response', () =>
            sendToSW('repository/read-history', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              depth: m.depth,
            }));
          return;
        }
        if (m.type === 'repository-read-remote-request') {
          await relayExactToolMessage(m, 'repository-read-remote-response', () =>
            sendToSW('repository/read-remote', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'repository-read-diff-request') {
          await relayExactToolMessage(m, 'repository-read-diff-response', () =>
            sendToSW('repository/read-diff', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              from: m.from, to: m.to,
            }));
          return;
        }
        if (m.type === 'repository-confirm-restore-request') {
          await relayExactToolMessage(m, 'repository-confirm-restore-response', () =>
            sendToSW('repository/confirm-restore', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              to: m.to,
            }));
          return;
        }
        if (m.type === 'repository-checkpoint-request') {
          await relayExactToolMessage(m, 'repository-checkpoint-response', () =>
            sendToSW('repository/checkpoint', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              message: m.message,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-branch-request') {
          await relayExactToolMessage(m, 'repository-branch-response', () =>
            sendToSW('repository/branch', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              name: m.name,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-checkout-request') {
          await relayExactToolMessage(m, 'repository-checkout-response', () =>
            sendToSW('repository/checkout', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              name: m.name,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-restore-request') {
          await relayExactToolMessage(m, 'repository-restore-response', () =>
            sendToSW('repository/restore', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              to: m.to,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-confirm-remote-request') {
          await relayExactToolMessage(m, 'repository-confirm-remote-response', () =>
            sendToSW('repository/confirm-remote', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              op: m.op, target: m.target, branch: m.branch,
            }));
          return;
        }
        if (m.type === 'repository-link-request') {
          await relayExactToolMessage(m, 'repository-link-response', () =>
            sendToSW('repository/link', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-fetch-request') {
          await relayExactToolMessage(m, 'repository-fetch-response', () =>
            sendToSW('repository/fetch', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              target: m.target,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'repository-push-request') {
          await relayExactToolMessage(m, 'repository-push-response', () =>
            sendToSW('repository/push', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              target: m.target, branch: m.branch,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'vm-read-request') {
          await relayExactToolMessage(m, 'vm-read-response', () =>
            sendToSW('vm/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              vmId: m.vmId,
            }));
          return;
        }
        if (m.type === 'vm-list-request') {
          await relayExactToolMessage(m, 'vm-list-response', () =>
            sendToSW('vm/list', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'vm-set-default-request') {
          await relayExactToolMessage(m, 'vm-set-default-response', () =>
            sendToSW('vm/set-default', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              vmId: m.vmId,
            }));
          return;
        }
        if (m.type === 'vm-run-request') {
          await relayExactToolMessage(m, 'vm-run-response', () =>
            sendToSW('vm/run', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              command: m.command, timeoutMs: m.timeoutMs, vmId: m.vmId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'vm-import-file-request') {
          await relayExactToolMessage(m, 'vm-import-file-response', () =>
            sendToSW('vm/import-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url, path: m.path, maxBytes: m.maxBytes,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'vm-write-text-file-request') {
          await relayExactToolMessage(m, 'vm-write-text-file-response', () =>
            sendToSW('vm/write-text-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              path: m.path, content: m.content,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'vm-destroy-request') {
          await relayExactToolMessage(m, 'vm-destroy-response', () =>
            sendToSW('vm/destroy', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              vmId: m.vmId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'notebook-read-request') {
          await relayExactToolMessage(m, 'notebook-read-response', () =>
            sendToSW('notebook/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              notebookId: m.notebookId,
            }));
          return;
        }
        if (m.type === 'notebook-list-request') {
          await relayExactToolMessage(m, 'notebook-list-response', () =>
            sendToSW('notebook/list', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'notebook-set-default-request') {
          await relayExactToolMessage(m, 'notebook-set-default-response', () =>
            sendToSW('notebook/set-default', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              notebookId: m.notebookId,
            }));
          return;
        }
        if (m.type === 'notebook-run-request') {
          await relayExactToolMessage(m, 'notebook-run-response', () =>
            sendToSW('notebook/run', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              code: m.code, timeoutMs: m.timeoutMs, notebookId: m.notebookId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'notebook-write-file-request') {
          await relayExactToolMessage(m, 'notebook-write-file-response', () =>
            sendToSW('notebook/write-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              path: m.path, content: m.content, notebookId: m.notebookId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'notebook-read-file-request') {
          await relayExactToolMessage(m, 'notebook-read-file-response', () =>
            sendToSW('notebook/read-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              path: m.path, notebookId: m.notebookId,
            }));
          return;
        }
        if (m.type === 'notebook-destroy-request') {
          await relayExactToolMessage(m, 'notebook-destroy-response', () =>
            sendToSW('notebook/destroy', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              notebookId: m.notebookId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-update-request') {
          await relayExactToolMessage(m, 'app-update-response', () =>
            sendToSW('app/update', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId, name: m.name, html: m.html, tags: m.tags,
              entryFile: m.entryFile,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-open-request') {
          await relayExactToolMessage(m, 'app-open-response', () =>
            sendToSW('app/open', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-search-request') {
          await relayExactToolMessage(m, 'app-search-response', () =>
            sendToSW('app/search', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              query: m.query,
            }));
          return;
        }
        if (m.type === 'app-read-request') {
          await relayExactToolMessage(m, 'app-read-response', () =>
            sendToSW('app/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId,
            }));
          return;
        }
        if (m.type === 'app-delete-request') {
          await relayExactToolMessage(m, 'app-delete-response', () =>
            sendToSW('app/delete', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-write-file-request') {
          await relayExactToolMessage(m, 'app-write-file-response', () =>
            sendToSW('app/write-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId, path: m.path, content: m.content,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-read-file-request') {
          await relayExactToolMessage(m, 'app-read-file-response', () =>
            sendToSW('app/read-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId, path: m.path,
            }));
          return;
        }
        if (m.type === 'app-list-files-request') {
          await relayExactToolMessage(m, 'app-list-files-response', () =>
            sendToSW('app/list-files', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId,
            }));
          return;
        }
        if (m.type === 'app-delete-file-request') {
          await relayExactToolMessage(m, 'app-delete-file-response', () =>
            sendToSW('app/delete-file', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId, path: m.path,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-observe-request') {
          await relayExactToolMessage(m, 'app-observe-response', () =>
            sendToSW('app/observe', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'app-act-request') {
          await relayExactToolMessage(m, 'app-act-response', () =>
            sendToSW('app/act', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              action: m.action, params: m.params,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'app-run-code-request') {
          await relayExactToolMessage(m, 'app-run-code-response', () =>
            sendToSW('app/run-code', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              code: m.code, timeoutMs: m.timeoutMs,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'memory-read-scope-request') {
          await relayExactToolMessage(m, 'memory-read-scope-response', () =>
            sendToSW('memory/read-scope', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              scope: m.scope,
            }));
          return;
        }
        if (m.type === 'memory-read-subtree-request') {
          await relayExactToolMessage(m, 'memory-read-subtree-response', () =>
            sendToSW('memory/read-subtree', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              workspace: m.workspace, subpath: m.subpath,
            }));
          return;
        }
        if (m.type === 'memory-write-request') {
          await relayExactToolMessage(m, 'memory-write-response', () =>
            sendToSW('memory/write', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              scope: m.scope, body: m.body,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'todo-read-request') {
          await relayExactToolMessage(m, 'todo-read-response', () =>
            sendToSW('todo/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'todo-replace-request') {
          await relayExactToolMessage(m, 'todo-replace-response', () =>
            sendToSW('todo/replace', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              version: m.version, todos: m.todos,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'page-open-tab-request') {
          await relayExactToolMessage(m, 'page-open-tab-response', () =>
            sendToSW('page/open-tab', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'page-read-request') {
          await relayExactToolMessage(m, 'page-read-response', () =>
            sendToSW('page/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-snapshot-request') {
          await relayExactToolMessage(m, 'page-snapshot-response', () =>
            sendToSW('page/snapshot', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-read-state-request') {
          await relayExactToolMessage(m, 'page-read-state-response', () =>
            sendToSW('page/read-state', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-watch-changes-request') {
          await relayExactToolMessage(m, 'page-watch-changes-response', () =>
            sendToSW('page/watch-changes', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-query-dom-request') {
          await relayExactToolMessage(m, 'page-query-dom-response', () =>
            sendToSW('page/query-dom', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-navigate-request') {
          await relayExactToolMessage(m, 'page-navigate-response', () =>
            sendToSW('page/navigate', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'page-fill-request') {
          await relayExactToolMessage(m, 'page-fill-response', () =>
            sendToSW('page/fill', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'page-click-request') {
          await relayExactToolMessage(m, 'page-click-response', () =>
            sendToSW('page/click', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'page-login-request') {
          await relayExactToolMessage(m, 'page-login-response', () =>
            sendToSW('page/login', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
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
          pageProgramSemanticToken = registerPageProgramSemanticOwner(w, m.executionId);
          try {
            await relayExactToolMessage(m, 'page-run-program-response', () =>
              sendToSW('page/run-program', {
                ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
                pageProgramSemanticToken,
              }), { observeResult: true });
          } finally {
            if (pageProgramSemanticToken) {
              releasePageProgramSemanticOwner(pageProgramSemanticToken);
              pageProgramSemanticToken = null;
            }
          }
          return;
        }
        if (m.type === 'page-capture-foreground-request') {
          await relayExactToolMessage(m, 'page-capture-foreground-response', () =>
            sendToSW('page/capture-foreground', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'page-capture-owned-request') {
          await relayExactToolMessage(m, 'page-capture-owned-response', () =>
            sendToSW('page/capture-owned', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'resource-confirm-web-write-request') {
          await relayExactToolMessage(m, 'resource-confirm-web-write-response', () =>
            sendToSW('resource/confirm-web-write', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url, method: m.method,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'resource-request-web-text-request') {
          await relayExactToolMessage(m, 'resource-request-web-text-response', () =>
            sendToSW('resource/request-web-text', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url, method: m.method, headers: m.headers, body: m.body,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'resource-extract-markdown-request') {
          await relayExactToolMessage(m, 'resource-extract-markdown-response', () =>
            sendToSW('resource/extract-markdown', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              html: m.html, url: m.url,
            }));
          return;
        }
        if (m.type === 'resource-extract-document-request') {
          await relayExactToolMessage(m, 'resource-extract-document-response', () =>
            sendToSW('resource/extract-document', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url, format: m.format, engine: m.engine,
            }));
          return;
        }
        if (m.type === 'resource-spill-result-request') {
          await relayExactToolMessage(m, 'resource-spill-result-response', () =>
            sendToSW('resource/spill-result', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              url: m.url, format: m.format, text: m.text, producer: m.producer,
              fenced: m.fenced, originLabel: m.originLabel,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'resource-read-result-request') {
          await relayExactToolMessage(m, 'resource-read-result-response', () =>
            sendToSW('resource/read-result', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              key: m.key,
            }));
          return;
        }
        if (m.type === 'site-client-read-request') {
          await relayExactToolMessage(m, 'site-client-read-response', () =>
            sendToSW('site-client/read', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              origin: m.origin,
            }));
          return;
        }
        if (m.type === 'site-client-run-request') {
          await relayExactToolMessage(m, 'site-client-run-response', () =>
            sendToSW('site-client/run', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              origin: m.origin, code: m.code, timeoutMs: m.timeoutMs,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'site-client-commit-request') {
          await relayExactToolMessage(m, 'site-client-commit-response', () =>
            sendToSW('site-client/commit', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              origin: m.origin,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'site-client-capture-start-request') {
          await relayExactToolMessage(m, 'site-client-capture-start-response', () =>
            sendToSW('site-client/capture-start', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'site-client-capture-stop-request') {
          await relayExactToolMessage(m, 'site-client-capture-stop-response', () =>
            sendToSW('site-client/capture-stop', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-create-webvm-request') {
          await relayExactToolMessage(m, 'execution-create-webvm-response', () =>
            sendToSW('execution/create-webvm', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              plan: m.plan,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-create-notebook-request') {
          await relayExactToolMessage(m, 'execution-create-notebook-response', () =>
            sendToSW('execution/create-notebook', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              plan: m.plan,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-create-pod-request') {
          await relayExactToolMessage(m, 'execution-create-pod-response', () =>
            sendToSW('execution/create-pod', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              plan: m.plan,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-create-app-request') {
          await relayExactToolMessage(m, 'execution-create-app-response', () =>
            sendToSW('execution/create-app', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              plan: m.plan,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-run-script-request') {
          await relayExactToolMessage(m, 'execution-run-script-response', () =>
            sendToSW('execution/run-script', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              code: m.code, actors: m.actors, provider: m.provider,
              workspace: m.workspace, timeoutMs: m.timeoutMs,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'execution-spill-script-request') {
          await relayExactToolMessage(m, 'execution-spill-script-response', () =>
            sendToSW('execution/spill-script', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              text: m.text, fenced: m.fenced, originLabel: m.originLabel,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'editing-read-target-request') {
          await relayExactToolMessage(m, 'editing-read-target-response', () =>
            sendToSW('editing/read-target', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              kind: m.kind, targetId: m.targetId, path: m.path,
            }));
          return;
        }
        if (m.type === 'editing-write-target-request') {
          await relayExactToolMessage(m, 'editing-write-target-response', () =>
            sendToSW('editing/write-target', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              kind: m.kind, targetId: m.targetId, path: m.path, content: m.content,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'introspection-actor-roster-request') {
          await relayExactToolMessage(m, 'introspection-actor-roster-response', () =>
            sendToSW('introspection/actor-roster', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'introspection-provider-posture-request') {
          await relayExactToolMessage(m, 'introspection-provider-posture-response', () =>
            sendToSW('introspection/provider-posture', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'introspection-storage-snapshot-request') {
          await relayExactToolMessage(m, 'introspection-storage-snapshot-response', () =>
            sendToSW('introspection/storage-snapshot', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              prefix: m.prefix,
            }));
          return;
        }
        if (m.type === 'introspection-automatable-tabs-request') {
          await relayExactToolMessage(m, 'introspection-automatable-tabs-response', () =>
            sendToSW('introspection/automatable-tabs', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'introspection-denylist-patterns-request') {
          await relayExactToolMessage(m, 'introspection-denylist-patterns-response', () =>
            sendToSW('introspection/denylist-patterns', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'introspection-audit-entries-request') {
          await relayExactToolMessage(m, 'introspection-audit-entries-response', () =>
            sendToSW('introspection/audit-entries', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'introspection-installed-skill-request') {
          await relayExactToolMessage(m, 'introspection-installed-skill-response', () =>
            sendToSW('introspection/installed-skill', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              name: m.name,
            }));
          return;
        }
        if (m.type === 'schedule-read-routines-request') {
          await relayExactToolMessage(m, 'schedule-read-routines-response', () =>
            sendToSW('schedule/read-routines', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'schedule-arm-confirmed-routine-request') {
          await relayExactToolMessage(m, 'schedule-arm-confirmed-routine-response', () =>
            sendToSW('schedule/arm-confirmed-routine', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              prompt: m.prompt, every: m.every, dailyAt: m.dailyAt, mode: m.mode,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'schedule-cancel-routine-request') {
          await relayExactToolMessage(m, 'schedule-cancel-routine-response', () =>
            sendToSW('schedule/cancel-routine', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId, id: m.id,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'dweb-discover-apps-request') {
          await relayExactToolMessage(m, 'dweb-discover-apps-response', () =>
            sendToSW('dweb/discover-apps', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'dweb-publish-confirmed-app-request') {
          await relayExactToolMessage(m, 'dweb-publish-confirmed-app-response', () =>
            sendToSW('dweb/publish-confirmed-app', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              appId: m.appId,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'dweb-install-confirmed-app-request') {
          await relayExactToolMessage(m, 'dweb-install-confirmed-app-response', () =>
            sendToSW('dweb/install-confirmed-app', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              uri: m.uri, name: m.name,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'dweb-read-peers-request') {
          await relayExactToolMessage(m, 'dweb-read-peers-response', () =>
            sendToSW('dweb/read-peers', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
            }));
          return;
        }
        if (m.type === 'dweb-set-peer-blocked-request') {
          await relayExactToolMessage(m, 'dweb-set-peer-blocked-response', () =>
            sendToSW('dweb/set-peer-blocked', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              did: m.did, block: m.block, reason: m.reason,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'dweb-set-discovery-enabled-request') {
          await relayExactToolMessage(m, 'dweb-set-discovery-enabled-response', () =>
            sendToSW('dweb/set-discovery-enabled', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              enabled: m.enabled,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'dweb-run-mesh-program-request') {
          await relayExactToolMessage(m, 'dweb-run-mesh-program-response', () =>
            sendToSW('dweb/run-mesh-program', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              code: m.code, timeoutMs: m.timeoutMs,
            }), { observeResult: true });
          return;
        }
        if (m.type === 'actor-tool-settle-request') {
          await relayExactToolMessage(m, 'actor-tool-settle-response', () =>
            sendToSW('actor/tool-settle', {
              ...(relayToken ? { relayToken } : {}), executionId: m.executionId,
              result: m.result,
            }), { observeResult: true });
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
