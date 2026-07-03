// @ts-check
// reasoning-worker-core — the PURE, worker-portable core of an offscreen
// reasoning subagent (heap-split phase 1).
//
// WHY THIS EXISTS. Until now every agent loop — orchestrator, actors, and
// subagents — ran in the ONE service-worker heap, cooperatively interleaved.
// The "actor fence" (untrusted data stays in the actor, only a fenced reply
// reaches the orchestrator) was a PROMPT boundary inside a shared heap, one
// property access from the vault DK. This module runs a PURE-REASONING subagent
// (a `tools:[]` child — no DOM, no chrome.*, no environment) in its OWN
// dedicated Worker: a real memory boundary. The model call is RELAYED back to
// the SW (which alone holds the key), so the key NEVER enters the worker heap —
// a compromised/injected reasoning child can reach neither the key nor the
// orchestrator's memory, only messages the SW gates.
//
// PURE / injected-IO so it is Bun-testable without a Worker: the imperative
// shell (offscreen/reasoning-worker.js) wires self.postMessage / onmessage to
// these functions; a test wires fakes. Nothing here imports chrome.* or DOM,
// and — critically — nothing imports the provider adapter: `callModel` arrives
// as a RELAY (the SW makes the real streaming call and hands back the events).

/**
 * The final assistant text of a completed session — the child's return value.
 * Inlined (not imported from spawn.js) so the worker never pulls spawn.js's
 * SW-side deps (manifests/permissions) into its heap. Same contract:
 * last assistant message with string content.
 * @param {{ messages?: Array<{ role: string, content: unknown }> }} session
 * @returns {string}
 */
export const finalAssistantText = (session) => {
  const messages = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) return m.content;
  }
  return '';
};

/**
 * A minimal in-memory `sessions` store — exactly the surface runUserTurn reads
 * on a tool-less child (get / appendMessage / updateAssistantMessage /
 * setTrimSummary / setCost). No IDB: the worker owns its child transcript in its
 * OWN heap and the SW persists the final messages after the run. Seeded with the
 * child record the SW created (its id/provider/model carry the lineage the SW
 * already stamped).
 *
 * @param {{ sessionId: string, provider?: string, model?: string, depth?: number }} seed
 */
export const makeInMemorySessions = (seed) => {
  /** @type {Map<string, any>} */
  const map = new Map();
  map.set(seed.sessionId, {
    sessionId: seed.sessionId,
    provider: seed.provider ?? 'anthropic',
    model: seed.model ?? '',
    kind: 'subagent',
    depth: seed.depth ?? 1,
    messages: /** @type {any[]} */ ([]),
  });
  const store = {
    get: async (/** @type {string} */ id) => map.get(id),
    create: async (/** @type {any} */ rec = {}) => {
      const s = { sessionId: rec.sessionId ?? seed.sessionId, messages: [], ...rec };
      map.set(s.sessionId, s);
      return s;
    },
    appendMessage: async (/** @type {string} */ id, /** @type {any} */ msg) => {
      const s = map.get(id); if (!s) return undefined;
      s.messages.push(msg); return s;
    },
    // The loop mutates an in-flight assistant message by id as it streams; find
    // and replace (or append if new). Mirrors the real store's contract enough
    // for the loop to accumulate a coherent transcript.
    updateAssistantMessage: async (/** @type {string} */ id, /** @type {any} */ msg) => {
      const s = map.get(id); if (!s) return undefined;
      const idx = msg?.id != null ? s.messages.findIndex((/** @type {any} */ m) => m.id === msg.id) : -1;
      if (idx >= 0) s.messages[idx] = { ...s.messages[idx], ...msg };
      else s.messages.push(msg);
      return s;
    },
    setTrimSummary: async () => {},
    setCost: async () => {},
  };
  return store;
};

/**
 * Build the RELAYED callModel the worker hands to runUserTurn. It is an
 * async-generator that DELEGATES the actual streaming call to the SW: it strips
 * the non-serializable fields (getSecret, signal) — the SW adds its OWN getSecret
 * so the key stays there — hands the rest to `requestModel`, and yields back the
 * events the SW accumulated. Correct regardless of batching: the loop consumes an
 * async-gen the same whether events arrive one-by-one or together (phase 1 relays
 * them as one accumulated array; live token streaming is a phase-2 refinement).
 *
 * @param {(args: object) => Promise<{ events?: any[], error?: string }>} requestModel
 *   Post a model-call request across the boundary; resolves with the SW's
 *   accumulated ProviderEvents (or an error string).
 * @param {number} [maxOutputTokens]  injected as maxTokens (the output cap), mirroring spawn.js.
 */
export const makeRelayedCallModel = (requestModel, maxOutputTokens) =>
  async function* relayedCallModel(/** @type {any} */ args) {
    // Drop everything non-serializable / secret before it crosses postMessage.
    // getSecret is a function AND the key path — it must never leave the SW.
    const { getSecret, signal, ...serializable } = args ?? {};
    void getSecret; void signal;
    if (maxOutputTokens != null) serializable.maxTokens = maxOutputTokens;
    const reply = await requestModel(serializable);
    if (reply?.error) throw new Error(reply.error);
    for (const ev of reply?.events ?? []) yield ev;
  };

/**
 * Drive one pure-reasoning subagent turn to completion in the worker heap, and
 * return the same result shape makeSpawnSubagent produces for the in-SW path
 * (so the SW branch that replaces it stays a drop-in). Accumulates usage across
 * relayed calls and captures the stop reason.
 *
 * @param {Object} deps
 * @param {(ctx: any) => AsyncIterable<any>} deps.runUserTurn
 *   The agent loop — `ctx: any` (bivariant) so BOTH the strict real loop and a
 *   test fake assign cleanly; the loop runtime-checks REQUIRED_CTX anyway.
 * @param {ReturnType<typeof makeInMemorySessions>} deps.sessions
 * @param {(args: object) => AsyncIterable<any>} deps.callModel  the relayed callModel
 * @param {() => (Promise<string> | string)} deps.getSystemPrompt
 * @param {(entry: object) => (Promise<unknown> | void)} deps.appendAudit
 * @param {{ sessionId: string, task: string, maxSteps: number, signal?: AbortSignal, reasoning?: object, contextWindow?: number }} req
 * @returns {Promise<{ finalText: string, usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, stopReason: string|undefined, toolCalls: number }>}
 */
export const runReasoningLoop = async (deps, req) => {
  const { runUserTurn, sessions, callModel, getSystemPrompt, appendAudit } = deps;
  const { sessionId, task, maxSteps, signal, reasoning, contextWindow } = req;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let toolCalls = 0;
  let stopReason;
  for await (const ev of runUserTurn({
    sessionId,
    userText: task,
    callModel,
    // A pure-reasoning child grants NO tools, so getSecret/safeFetch are never
    // consumed — the loop requires them in its signature, so pass throwing
    // stubs: if a bug ever routed a secret/egress read here, it fails LOUD in
    // the worker (which has no key) rather than silently.
    getSecret: async () => { throw new Error('reasoning subagent has no secret access'); },
    safeFetch: async () => { throw new Error('reasoning subagent has no egress'); },
    sessions,
    getSystemPrompt,
    appendAudit,
    tools: [],
    // no toolDispatch — a tools:[] child never dispatches.
    maxSteps,
    persistDeltas: false,
    ...(signal ? { signal } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
  })) {
    if (ev.type === 'tool-use') toolCalls++;
    if (ev.type === 'stop') stopReason = ev.stopReason;
    if (ev.type === 'usage' && ev.usage) {
      usage.inputTokens += ev.usage.inputTokens || 0;
      usage.outputTokens += ev.usage.outputTokens || 0;
      usage.cacheReadTokens += ev.usage.cacheReadTokens || 0;
      usage.cacheWriteTokens += ev.usage.cacheWriteTokens || 0;
    }
  }
  const finalText = finalAssistantText(await sessions.get(sessionId));
  return { finalText, usage, stopReason, toolCalls };
};
