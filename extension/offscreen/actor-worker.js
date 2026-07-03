// @ts-check
// offscreen/actor-worker.js — the Worker that runs a BOUND-actor loop (VM /
// Notebook / App) in its own heap (heap-split phase 2). Imperative shell over
// actor-worker-core. Relays BOTH the model call AND every tool call to the SW
// (which holds the key, the engine clients, the instance pin, and the gate); the
// untrusted instance output stays in this heap. Module worker → strict.
import { runUserTurn } from '/peerd-runtime/loop/agent-loop.js';
import { makeInMemorySessions, makeRelayedCallModel, makeRelayedToolDispatch, runActorLoop } from '/peerd-runtime/subagent/actor-worker-core.js';

let seq = 0;
let runId = '';
/** @type {Map<string, (v: any) => void>} rid → pending model-call resolver */
const modelPending = new Map();
/** @type {Map<string, (v: any) => void>} rid → pending tool-dispatch resolver */
const toolPending = new Map();
const abort = new AbortController();

self.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
  const m = /** @type {any} */ (ev.data);
  if (!m || typeof m !== 'object') return;

  if (m.type === 'model-response') { modelPending.get(m.rid)?.({ events: m.events }); modelPending.delete(m.rid); return; }
  if (m.type === 'model-error') { modelPending.get(m.rid)?.({ error: m.error }); modelPending.delete(m.rid); return; }
  if (m.type === 'tool-response') { toolPending.get(m.rid)?.(m.reply); toolPending.delete(m.rid); return; }
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
    runId = m.runId;
    const requestModel = (/** @type {object} */ args) => new Promise((resolve) => {
      const rid = `mc-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({ type: 'model-request', rid, runId, args });
    });
    const requestTool = (/** @type {object} */ call) => new Promise((resolve) => {
      const rid = `tc-${++seq}`;
      toolPending.set(rid, resolve);
      self.postMessage({ type: 'tool-request', rid, runId, call });
    });
    try {
      // Seed the actor's PRIOR history — a bound actor is stateful across turns.
      const sessions = makeInMemorySessions({ sessionId: m.sessionId, provider: m.provider, model: m.model, depth: m.depth, messages: m.priorMessages });
      const callModel = makeRelayedCallModel(requestModel, m.maxOutputTokens);
      const toolDispatch = makeRelayedToolDispatch(requestTool);
      const result = await runActorLoop(
        {
          runUserTurn, sessions, callModel, toolDispatch,
          getSystemPrompt: () => m.systemPrompt,
          appendAudit: async () => {},
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
          tools: m.tools ?? [],
        },
        { sessionId: m.sessionId, userText: m.message, maxSteps: m.maxSteps, signal: abort.signal, reasoning: m.reasoning, contextWindow: m.contextWindow },
      );
      self.postMessage({ type: 'done', runId, result });
    } catch (e) {
      self.postMessage({ type: 'error', runId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
});
