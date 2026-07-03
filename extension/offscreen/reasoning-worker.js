// @ts-check
// offscreen/reasoning-worker.js — the Worker that runs a PURE-REASONING
// subagent loop in its OWN heap (heap-split phase 1). This is the imperative
// shell: it wires self.postMessage / onmessage to the pure, tested
// reasoning-worker-core. It imports the agent loop directly (worker-portable —
// the loop's transitive imports touch no chrome.* / DOM), but the model call is
// RELAYED to the SW through the offscreen host, so the model key NEVER enters
// this heap. A prompt-injected reasoning child here can reach neither the key
// nor the orchestrator's memory — only the messages the SW gates.
//
// Module worker (type:'module') → strict by default, no 'use strict' needed.
import { runUserTurn } from '/peerd-runtime/loop/agent-loop.js';
import { makeInMemorySessions, makeRelayedCallModel, runReasoningLoop } from '/peerd-runtime/subagent/reasoning-worker-core.js';

let seq = 0;
let runId = '';
/** @type {Map<string, (v: { events?: any[], error?: string }) => void>} rid → pending model-call resolver */
const pending = new Map();
// One controller for the whole run — the host aborts (Stop / cancel / timeout)
// by posting {type:'abort'}; the loop unwinds through its normal abort branch.
const abort = new AbortController();

self.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
  const m = /** @type {any} */ (ev.data);
  if (!m || typeof m !== 'object') return;

  // The SW's accumulated model events (or an error), routed back by the host.
  if (m.type === 'model-response') { pending.get(m.rid)?.({ events: m.events }); pending.delete(m.rid); return; }
  if (m.type === 'model-error') { pending.get(m.rid)?.({ error: m.error }); pending.delete(m.rid); return; }
  if (m.type === 'abort') {
    abort.abort();
    // Reject EVERY outstanding model-call so a worker BLOCKED awaiting the SW
    // actually unwinds (abort alone doesn't settle the pending relay promise —
    // the loop would stay parked until the host's budget timer terminated it).
    for (const resolve of pending.values()) resolve({ error: 'aborted' });
    pending.clear();
    return;
  }

  if (m.type === 'run') {
    runId = m.runId;
    // Relay one model call across the boundary: post the (serializable) args and
    // resolve when the host hands back the SW's accumulated events. runId rides
    // along so the SW can correlate + abort THIS run's in-flight provider call.
    const requestModel = (/** @type {object} */ args) => new Promise((resolve) => {
      const rid = `mc-${++seq}`;
      pending.set(rid, resolve);
      self.postMessage({ type: 'model-request', rid, runId, args });
    });
    try {
      const sessions = makeInMemorySessions({ sessionId: m.sessionId, provider: m.provider, model: m.model, depth: m.depth });
      const callModel = makeRelayedCallModel(requestModel, m.maxOutputTokens);
      const result = await runReasoningLoop(
        {
          runUserTurn, sessions, callModel,
          getSystemPrompt: () => m.systemPrompt,
          // MUST return a promise: the loop fire-and-forgets audits as
          // appendAudit(...).catch(...) — a bare () => {} returns undefined and
          // `.catch` throws, killing the run before its first model call.
          appendAudit: async () => {},
          // Forward each loop event so the SW re-emits it to the subagent card +
          // cost meter (otherwise an offscreen child's card is blank and its cost
          // counts as zero).
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
        },
        { sessionId: m.sessionId, task: m.task, maxSteps: m.maxSteps, signal: abort.signal, reasoning: m.reasoning, contextWindow: m.contextWindow },
      );
      self.postMessage({ type: 'done', runId, result });
    } catch (e) {
      self.postMessage({ type: 'error', runId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
});
