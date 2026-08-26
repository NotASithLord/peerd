// @ts-check
// offscreen/actor-runner.js — hosts EVERY offscreen agent loop in dedicated Workers
// (the heap split): ephemeral spawned reasoners AND bound actors alike (a reasoning
// child just carries no tools, so its worker never sends a tool-request). Forks one
// Worker per turn, relays exact model-authority stream requests and tool-dispatch
// requests to the SW, forwards loop events, and resolves with the turn result.

import { ACTOR_WORKER_PROTOCOL, ACTOR_WORKER_STARTUP_MS, validActorWorkerRealm } from './actor-worker-protocol.js';
import {
  AGENT_PROGRAM,
  describeExecution,
} from '/shared/execution-protocol.js';

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
    reasoning: job.reasoning,
    contextWindowOverrides: job.contextWindowOverrides,
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
 * @param {{ runId?: string, relayToken?: string, actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindowOverrides?:Record<string,number>, runtimeCapabilities?: object, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabOrigin?: string, origin?: string, inbound?: boolean, preflightReply?: string }} job
 * @param {{ workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any>, onRelayDrain?: () => void, createWorker?: (url: string) => Worker, startupMs?: number, relayDrainMs?: number, maxLoopEvents?: number }} deps
 * @returns {Promise<{ ok: boolean, started?: boolean, phase?: string, code?: string, finalText?: string, newMessages?: any[], usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean, performed?: boolean, outcomeKnown?: boolean, retryable?: boolean }>}
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
        try { w.terminate(); } catch { /* gone */ }
        try { delete globalThis[/** @type {keyof typeof globalThis} */ (canaryName)]; } catch { /* best effort */ }
        resolve(value);
      };
      const settleTerminal = () => {
        if (!terminal || pendingToolRelays > 0 || pendingModelRelays > 0) return;
        if (relayedUnknown) {
          finish({
            ok: false, started: true,
            code: 'actor_tool_outcome_unknown',
            error: 'outcome_unknown: Verify the target before retrying.',
            finalText: terminal.finalText ?? '', newMessages: terminal.newMessages ?? [],
            usage: terminal.usage, stopReason: terminal.stopReason,
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
            usage: terminal.usage, stopReason: terminal.stopReason,
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
        if (m.type === 'tool-request') {
          // Count at the privileged relay boundary. The Worker result is not
          // trusted to report whether an external action may have started.
          relayedToolRequests += 1;
          pendingToolRelays += 1;
          try {
            // The SW pins the bound instance + gates + dispatches (never trusts the
            // worker's call args) and returns the ToolResult. The relay grant keys
            // the actor ctx it builds — the session is no longer sent at all, so
            // neither this runner nor any other first-party page can name one.
            const reply = await sendToSW('actor/tool-dispatch', {
              ...(relayToken ? { relayToken } : {}), call: m.call,
            });
            const result = reply?.result;
            if (reply?.outcomeKnown === false || result?.outcomeKnown === false) relayedUnknown = true;
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
            if (!terminal) w.postMessage({ type: 'tool-response', rid: m.rid, reply });
          } catch (e) {
            const detail = /** @type {{ message?: string, code?: string, outcomeKnown?: boolean, performed?: boolean }} */ (e);
            relayedUnknown ||= detail?.outcomeKnown !== true;
            if (detail?.performed === true || (detail?.performed === false && relayedPerformed !== true)) {
              relayedPerformed = detail.performed;
            }
            if (!terminal) {
              w.postMessage({
                type: 'tool-response', rid: m.rid,
                reply: {
                  ok: false, error: detail?.message ?? String(e),
                  ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
                  outcomeKnown: detail?.outcomeKnown === true,
                  ...(typeof detail?.performed === 'boolean' ? { performed: detail.performed } : {}),
                  ...(detail?.outcomeKnown === true ? {} : { retryable: false }),
                },
              });
            }
          } finally {
            pendingToolRelays -= 1;
            settleTerminal();
          }
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
              usage: r.usage, stopReason: r.stopReason, toolCalls,
              outcomeKnown: true,
            });
          }
          else requestFinish({ ok: true, started: true, finalText: r.finalText ?? '', newMessages: r.newMessages ?? [], usage: r.usage, stopReason: r.stopReason, toolCalls: relayedToolRequests });
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
