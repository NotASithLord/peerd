// @ts-check
// offscreen/actor-runner.js — hosts EVERY offscreen agent loop in dedicated Workers
// (the heap split): ephemeral spawned reasoners AND bound actors alike (a reasoning
// child just carries no tools, so its worker never sends a tool-request). Forks one
// Worker per turn, relays its model-call AND tool-dispatch requests to the SW (which
// holds the key, engine clients, instance pin, and gate), forwards its loop events,
// and resolves with the turn result.

import { ACTOR_WORKER_PROTOCOL, ACTOR_WORKER_STARTUP_MS, validActorWorkerRealm } from './actor-worker-protocol.js';

const MAX_CONCURRENT = 4;
let active = 0;
let seq = 0;
/** @type {Map<string, Worker>} */
const liveWorkers = new Map();
// actor/abort can beat actor/run while the offscreen command messages cross.
// Keep a short, bounded tombstone so that ordering race cannot launch a Worker
// after Stop. Run ids are SW-minted and never reused intentionally.
/** @type {Map<string, number>} runId → expiry */
const abortedEarly = new Map();
const EARLY_ABORT_MAX = 64;
const EARLY_ABORT_TTL_MS = 60_000;

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
  const w = liveWorkers.get(runId);
  if (w) { try { w.postMessage({ type: 'abort' }); } catch { /* gone */ } }
  else rememberEarlyAbort(runId);
};

/**
 * Run one BOUND-actor turn in a dedicated Worker.
 * @param {{ runId?: string, relayToken?: string, actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindow?: number, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, tabUrl?: string, origin?: string, inbound?: boolean }} job
 * @param {{ workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any>, createWorker?: (url: string) => Worker, startupMs?: number }} deps
 * @returns {Promise<{ ok: boolean, started?: boolean, phase?: string, code?: string, finalText?: string, newMessages?: any[], usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean, outcomeKnown?: boolean }>}
 */
export const runActor = async (job, {
  workerUrl,
  sendToSW,
  createWorker = (url) => new Worker(url, { type: 'module' }),
  startupMs = ACTOR_WORKER_STARTUP_MS,
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
  active++;
  // The SW-minted relay grant for this run. It stays in THIS scope — never posted to
  // the Worker — so the untrusted heap can't lift it, and every relay below carries it
  // as proof of which run is speaking. The SW derives the run + session from it and
  // ignores whatever the payload claims.
  const relayToken = job.relayToken;
  const budgetMs = Number.isFinite(job.budgetMs) && /** @type {number} */ (job.budgetMs) > 0 ? /** @type {number} */ (job.budgetMs) : 10 * 60_000;
  /** @type {Worker | null} */
  let worker = null;
  const canaryName = `__peerd_actor_host_${Math.random().toString(36).slice(2)}`;
  const canaryValue = Object.freeze({});
  try {
    Object.defineProperty(globalThis, canaryName, { value: canaryValue, configurable: true });
    worker = createWorker(workerUrl);
    liveWorkers.set(runId, worker);
    const w = worker;
    return await new Promise((resolve) => {
      let settled = false;
      let started = false;
      let relayedToolRequests = 0;
      /** @type {'awaiting-ready'|'awaiting-probe'|'ready'} */
      let readiness = 'awaiting-ready';
      let budgetTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
      const probeId = `probe-${runId}`;
      const finish = (/** @type {any} */ value) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (budgetTimer) clearTimeout(budgetTimer);
        try { w.terminate(); } catch { /* gone */ }
        try { delete globalThis[/** @type {keyof typeof globalThis} */ (canaryName)]; } catch { /* best effort */ }
        resolve(value);
      };
      const protocolFailure = (/** @type {string} */ error) => finish({
        ok: false, started, phase: started ? 'run' : 'startup',
        code: 'actor_worker_protocol_error', error,
      });
      const startupTimer = setTimeout(() => finish({
        ok: false, started: false, phase: 'startup',
        code: 'actor_worker_start_timeout', error: `actor worker did not become ready within ${startupMs}ms`,
      }), startupMs);

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
            finish({
              ok: true, started: false, phase: 'startup', code: 'actor_worker_ready',
              workerType: 'dedicated', realmVerified: true, extensionApisPresent: false,
            });
            return;
          }
          budgetTimer = setTimeout(() => finish({
            ok: false, started: true, phase: 'run', code: 'actor_worker_timeout', aborted: true,
            error: `actor timed out after ${budgetMs}ms`,
          }), budgetMs);
          started = true;
          w.postMessage({
            type: 'run', runId, sessionId: job.actorSessionId, message: job.message, systemPrompt: job.systemPrompt,
            provider: job.provider, model: job.model, depth: job.depth, tools: job.tools ?? [],
            priorMessages: job.priorMessages ?? [],
            maxSteps: job.maxSteps, maxOutputTokens: job.maxOutputTokens, reasoning: job.reasoning, contextWindow: job.contextWindow,
            oneShot: job.oneShot, actorType: job.actorType, backing: job.backing, tabUrl: job.tabUrl, origin: job.origin,
            inbound: job.inbound === true,
          });
          return;
        }
        if (readiness !== 'ready') {
          protocolFailure(`actor worker sent '${String(m.type)}' before readiness`);
          return;
        }
        if (m.type === 'model-request') {
          try {
            const resp = await sendToSW('actor/model-call', { relayToken, args: m.args });
            if (resp?.ok) w.postMessage({ type: 'model-response', rid: m.rid, events: resp.events ?? [] });
            else w.postMessage({ type: 'model-error', rid: m.rid, error: resp?.error ?? 'model call failed' });
          } catch (e) { w.postMessage({ type: 'model-error', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); }
          return;
        }
        if (m.type === 'tool-request') {
          // Count at the privileged relay boundary. The Worker result is not
          // trusted to report whether an external action may have started.
          relayedToolRequests += 1;
          try {
            // The SW pins the bound instance + gates + dispatches (never trusts the
            // worker's call args) and returns the ToolResult. The relay grant keys
            // the actor ctx it builds — the session is no longer sent at all, so
            // neither this runner nor any other first-party page can name one.
            const reply = await sendToSW('actor/tool-dispatch', { relayToken, call: m.call });
            w.postMessage({ type: 'tool-response', rid: m.rid, reply });
          } catch (e) { w.postMessage({ type: 'tool-response', rid: m.rid, reply: { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) } }); }
          return;
        }
        if (m.type === 'loop-event') { sendToSW('actor/loop-event', { relayToken, event: m.event }).catch(() => {}); return; }
        if (m.type === 'done') {
          const r = m.result ?? {};
          // No `aborted` here: a Stop-cascade is stamped at the SW client (which alone
          // sees signal.aborted AND whether a reply came back). The runner only marks
          // `aborted` for its OWN wall-clock timeout below.
          if (r.error) {
            const toolCalls = relayedToolRequests;
            finish({
              ok: false, started: true, error: r.error,
              finalText: r.finalText ?? '', newMessages: r.newMessages ?? [],
              usage: r.usage, stopReason: r.stopReason, toolCalls,
              // A graceful provider failure before any tool request has a known
              // outcome. Worker/protocol crashes use the separate error path and
              // remain unknown because their partial state cannot be trusted.
              outcomeKnown: relayedToolRequests === 0,
            });
          }
          else finish({ ok: true, started: true, finalText: r.finalText ?? '', newMessages: r.newMessages ?? [], usage: r.usage, stopReason: r.stopReason, toolCalls: relayedToolRequests });
        }
        if (m.type === 'error') {
          finish({ ok: false, started: true, phase: 'run', code: 'actor_worker_error', error: m.error ?? 'actor worker error' });
        }
      });
      w.addEventListener('error', (/** @type {any} */ e) => {
        finish({
          ok: false, started, phase: started ? 'run' : 'startup', code: 'actor_worker_crashed',
          error: `actor worker crashed: ${e?.message ?? 'no detail'}`,
        });
      });
      w.addEventListener('messageerror', () => {
        finish({
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
