// @ts-check
// offscreen/actor-worker.js — the ONE Worker that runs any non-orchestrator agent
// loop in its own heap (the heap split): an ephemeral reasoning subagent (tools:[],
// so the tool-relay below never fires) OR a bound actor (VM / Notebook / App / web,
// tool-bearing). Imperative shell over actor-worker-core. Relays BOTH the model call
// AND every tool call to the SW (which holds the key, the engine clients, the
// instance pin, and the gate); the untrusted instance/page output stays in this
// heap. Module worker → strict.
import { runUserTurn } from '/peerd-runtime/loop/agent-loop.js';
import { makeInMemorySessions, makeRelayedCallModel, makeRelayedToolDispatch, runActorLoop, makeActorSummaryFence } from '/peerd-runtime/subagent/actor-worker-core.js';

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
      // Phase 3: a WEB/API actor self-fences its own untrusted-provenance rolling
      // summary. The SW's closure (over the live tab url) can't cross postMessage,
      // so rebuild it here from the pure fence fns using the turn-start provenance.
      const fenceActorSummary = makeActorSummaryFence({ actorType: m.actorType, backing: m.backing, tabUrl: m.tabUrl, origin: m.origin });
      const result = await runActorLoop(
        {
          runUserTurn, sessions, callModel, toolDispatch,
          getSystemPrompt: () => m.systemPrompt,
          appendAudit: async () => {},
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
          tools: m.tools ?? [],
          ...(fenceActorSummary ? { fenceActorSummary } : {}),
        },
        { sessionId: m.sessionId, userText: m.message, maxSteps: m.maxSteps, oneShot: m.oneShot, signal: abort.signal, reasoning: m.reasoning, contextWindow: m.contextWindow },
      );
      // A Stop/cancel unwinds the loop CLEANLY (the aborted model relay rejects, the
      // loop stops with no error event and an empty reply) — indistinguishable from a
      // natural end at the result shape. The worker's OWN abort controller is the
      // authoritative signal, so stamp it: the caller renders the card 'cancelled'
      // (not a blank 'ok') and spawn.js records stopReason 'aborted'.
      self.postMessage({ type: 'done', runId, result: { ...result, aborted: abort.signal.aborted } });
    } catch (e) {
      self.postMessage({ type: 'error', runId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
});
