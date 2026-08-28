// @ts-check
// actor-worker-core — the PURE, worker-portable core of THE offscreen agent-loop
// substrate (the "heap split"). ONE loop, ONE relay, ONE heap-isolation story for
// every non-orchestrator agent loop peerd runs:
//   - an EPHEMERAL reasoning actor — `tools:[]`, fire-once, no instance; and
//   - a BOUND actor — VM / Notebook / App / web, tool-bearing, stateful across
//     turns (its own accumulated transcript seeds each turn).
// Post-#137 these are ONE vocabulary (a spawned child IS an ephemeral actor), so they
// are ONE code path here: a reasoning child is just an actor that grants no tools
// and so never dispatches. (The offscreen/actor-worker.js host + the SW client
// serve both; see their headers.)
//
// TRUST PROPERTY — the whole point. Until the heap split, every agent loop ran in
// the ONE service-worker heap, cooperatively interleaved: the "actor fence" was a
// PROMPT boundary, one property access from the vault DK. Running each loop in its
// OWN dedicated Worker makes it a real MEMORY boundary. The worker holds NO key,
// NO engine clients, NO chrome.* — it ingests untrusted content (page DOM, VM
// stdout, API/response bodies) that can reach neither the orchestrator's memory
// nor the key. Its ONLY outward edges are two SW-gated relays:
//   - exact inference stream effects → fixed SW egress authority;
//   - a tool call → the SW builds the actor's instance-PINNED, gated tool context
//     and dispatches THERE (the pin + gate + audit + engine clients + tabs are ALL
//     SW-side). why the SW MUST re-pin+gate: the worker's `call` args are
//     attacker-influenceable (they derive from injected instance/page output), so
//     the SW never trusts them — it force-pins the bound instance and runs the
//     full gate, exactly as the privileged host policy requires.
//
// PURE / injected-IO → Bun-testable without a Worker: the imperative shell
// (offscreen/actor-worker.js) wires self.postMessage/onmessage to these functions;
// a test wires fakes. Nothing here imports chrome.*, DOM, or the provider adapter —
// `callModel` and `toolDispatch` arrive as RELAYS.

// The web/API actor's rolling-summary self-fence (below) is PURE (wrapUntrusted;
// no chrome.*/DOM) and lives in the same module dir → intra-module import, worker-
// portable, Bun-testable.
import { fenceWebActorSummary, fenceApiActorSummary } from './web-actor.js';
import { ActorCredentialBoundaryError } from '../errors.js';

/**
 * The final assistant text of a session — a loop's return value. Inlined (not
 * imported from spawn.js) so the worker never pulls spawn.js's SW-side deps
 * (manifests/permissions) into its heap. Last assistant message with string content.
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
 * A minimal in-memory `sessions` store — exactly the surface runUserTurn reads:
 * get / create / appendMessage / updateAssistantMessage / setTrimSummary / setCost.
 * No IDB: the worker owns its transcript in its OWN heap and the SW persists after
 * the run. Seeded with the child/actor record the SW created (its id/provider/model
 * carry the lineage the SW already stamped).
 *
 * @param {{ sessionId: string, provider?: string, model?: string, kind?:'actor'|'spawned', depth?: number, messages?: any[], trimSummary?:any }} seed
 *   `messages` seeds prior history — a BOUND actor is stateful across turns, so the
 *   worker reasons over its accumulated transcript. An ephemeral reasoning child
 *   omits it (fresh each spawn). The array is copied (the worker owns its heap's
 *   transcript; the SW's record is untouched).
 */
export const makeInMemorySessions = (seed) => {
  /** @type {Map<string, any>} */
  const map = new Map();
  map.set(seed.sessionId, {
    sessionId: seed.sessionId,
    provider: seed.provider ?? 'anthropic',
    model: seed.model ?? '',
    kind: seed.kind === 'actor' ? 'actor' : 'spawned',
    depth: seed.depth ?? 1,
    messages: /** @type {any[]} */ (Array.isArray(seed.messages) ? [...seed.messages] : []),
    ...(seed.trimSummary && typeof seed.trimSummary === 'object'
      ? { trimSummary: structuredClone(seed.trimSummary) } : {}),
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
    // The loop mutates an in-flight assistant message by id as it streams. The store
    // contract is (sessionId, messageId, patch) — 3-arg (sessions/store.js). A 2-arg
    // shim silently dropped the patch (which holds the final content), so
    // finalAssistantText always returned '' — the child produced a blank answer.
    updateAssistantMessage: async (/** @type {string} */ sessionId, /** @type {string} */ messageId, /** @type {any} */ patch) => {
      const s = map.get(sessionId); if (!s) return undefined;
      const idx = s.messages.findIndex((/** @type {any} */ m) => m.id === messageId);
      if (idx >= 0) s.messages[idx] = { ...s.messages[idx], ...patch };
      else s.messages.push({ id: messageId, ...patch });
      return s;
    },
    setTrimSummary: async (/** @type {string} */ id, /** @type {any} */ state) => {
      const s = map.get(id); if (!s) return undefined;
      s.trimSummary = state && typeof state === 'object' ? structuredClone(state) : null;
      return s;
    },
    setCost: async () => {},
  };
  return store;
};

/**
 * Reconstruct a WEB/API actor's rolling-summary SELF-FENCE for the worker loop ctx
 * (heap-split phase 3). The loop reads `ctx.fenceActorSummary` when it TRIMS context,
 * wrapping the actor's own (100%-untrusted-provenance) rolling summary so a laundered
 * injection that survives compression re-enters as DATA, not a command. The SW builds
 * this closure over the policy-reduced active-tab origin on the in-SW path; that
 * closure can't cross postMessage, so the worker rebuilds it here from the PURE fence fns.
 *
 * why the origin/tabOrigin is turn-START, not live: it's the fence's provenance TAG only
 * (`web-actor(<origin>)`); the BODY-wrap, which is the security function, is applied regardless,
 * so a tag that lags a mid-turn navigate is cosmetic. An API actor's origin is FIXED
 * for its whole life, so it never lags. Returns undefined for a non-web actor (no
 * self-fence. A VM/Notebook/App actor's summary renders verbatim, as in-SW).
 *
 * @param {{ actorType?: string, backing?: string, tabOrigin?: string, origin?: string }} [o]
 * @returns {((text: string) => string) | undefined}
 */
export const makeActorSummaryFence = ({ actorType, backing, tabOrigin, origin } = {}) => {
  if (actorType !== 'web') return undefined;
  if (backing === 'api') return (/** @type {string} */ text) => fenceApiActorSummary(text, { origin });
  return (/** @type {string} */ text) => fenceWebActorSummary(text, { tabOrigin });
};

/**
 * Build the RELAYED toolDispatch the actor worker hands to runUserTurn. Each tool
 * call is delegated across the boundary to the SW, which pins + gates + dispatches
 * it and returns the ToolResult. The call object ({ name, args, id }) is
 * serializable; the result is a plain ToolResult (serializable). A relay failure
 * surfaces as a tool error (never throws the loop).
 *
 * @param {(call: object) => Promise<{ ok?: boolean, result?: any, error?: string }>} requestTool
 */
export const makeRelayedToolDispatch = (requestTool) =>
  async (/** @type {any} */ call) => {
    try {
      const reply = await requestTool({ name: call?.name, args: call?.args, id: call?.id });
      if (reply && reply.ok && reply.result !== undefined) return reply.result;
      // Shape a relay/dispatch failure into a ToolResult the loop can carry.
      return {
        ok: false,
        error: reply?.error ?? 'actor tool relay failed',
        meta: { toolName: call?.name, primitive: 'unknown', gates: [], durationMs: 0 },
      };
    } catch (e) {
      return {
        ok: false,
        error: `actor tool relay threw: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
        meta: { toolName: call?.name, primitive: 'unknown', gates: [], durationMs: 0 },
      };
    }
  };

/**
 * Drive one agent-loop turn to completion in the worker heap — a BOUND actor turn
 * (tools + relayed dispatch + prior-history statefulness) OR an ephemeral reasoning
 * actor (tools:[] → the relayed dispatch is never invoked). Returns the result
 * shape both spawn.js and the actor-turn code expect. Accumulates usage, captures the
 * stop reason, surfaces a text-less error (so a failed run isn't a silent blank).
 *
 * @param {Object} deps
 * @param {(ctx: any) => AsyncIterable<any>} deps.runUserTurn
 * @param {ReturnType<typeof makeInMemorySessions>} deps.sessions
 * @param {(args: object) => AsyncIterable<any>} deps.callModel   the relayed callModel
 * @param {(call: object) => Promise<any>} deps.toolDispatch      the relayed toolDispatch
 * @param {(name: string) => (import('../permissions/policy.js').PermissionVerdict | null)} [deps.classifyToolCall]
 *   sealed descriptor + pinned-permission scheduler classification
 * @param {() => (Promise<string> | string)} deps.getSystemPrompt
 * @param {(entry: object) => (Promise<unknown> | void)} [deps.appendAudit]
 * @param {(ev: object) => void} [deps.onEvent]
 * @param {Array<{ name: string, description: string, schema: object }>} deps.tools
 * @param {((text: string) => string)} [deps.fenceActorSummary]  a web/API actor's
 *   rolling-summary self-fence (heap-split phase 3); absent for engine actors.
 * @param {{ sessionId: string, userText: string, maxSteps?: number, oneShot?: boolean, signal?: AbortSignal, reasoning?: object, contextWindow?: number, inbound?: boolean, preflightReply?: string }} req
 * @returns {Promise<{ finalText: string, newMessages: any[], usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, stopReason: string|undefined, toolCalls: number, error?: string }>}
 */
export const runActorLoop = async (deps, req) => {
  const {
    runUserTurn, sessions, callModel, toolDispatch, classifyToolCall,
    getSystemPrompt, onEvent, tools, fenceActorSummary,
  } = deps;
  // Defensive (phase-1 lesson): the loop fire-and-forgets audits as
  // appendAudit(...).catch(...) — a sync stub returning undefined would crash it.
  const appendAudit = (/** @type {object} */ e) => Promise.resolve(deps.appendAudit?.(e));
  const { sessionId, userText, maxSteps, oneShot, signal, reasoning, contextWindow, inbound, preflightReply } = req;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let toolCalls = 0;
  let stopReason;
  let errorEvent;
  // Per-turn scoping (the in-SW path's `before`/slice guard): the worker session
  // is SEEDED with the actor's prior history (statefulness), so finalAssistantText
  // over the WHOLE transcript would return a PRIOR turn's reply when THIS turn
  // emits none (Stop/error) — the stale-reply bug. Capture the length BEFORE the
  // turn and read only the messages it adds.
  const before = (await sessions.get(sessionId))?.messages?.length ?? 0;
  for await (const ev of runUserTurn({
    sessionId,
    userText,
    callModel,
    // A bound actor is keyless/egress-less in its own heap: getSecret/safeFetch
    // are never consumed by its tools (they relay to the SW). Throwing stubs make
    // any accidental use fail LOUD in the worker (which has neither).
    getSecret: async () => { throw new ActorCredentialBoundaryError('secret'); },
    safeFetch: async () => { throw new ActorCredentialBoundaryError('provider-network'); },
    sessions,
    getSystemPrompt,
    appendAudit,
    tools,
    toolDispatch,
    ...(classifyToolCall ? { classifyToolCall } : {}),
    persistDeltas: false,
    // Preserve the SW's inbound provenance in the loop request as well as the
    // relay grant. These are strict literals derived from one monotonic bit; the
    // worker cannot turn an inbound peer wake into a trusted continuation.
    ...(inbound === true ? { synthetic: true, trusted: false, inbound: true } : {}),
    ...(signal ? { signal } : {}),
    // maxSteps: omit when undefined so runUserTurn uses its OWN default. Only
    // cap when the caller asks.
    ...(maxSteps != null ? { maxSteps } : {}),
    // oneShot: a message_actor delegation may ask the loop to synthesize its reply
    // from the first clean tool round and stop (no summarize inference) — parity
    // with the bound-actor contract.
    ...(oneShot === true ? { oneShot: true } : {}),
    ...(typeof preflightReply === 'string' ? { preflightReply } : {}),
    // A web/API actor self-fences its own untrusted-provenance rolling summary on a
    // context trim (heap-split phase 3); absent for engine actors → summary verbatim.
    ...(fenceActorSummary ? { fenceActorSummary } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
  })) {
    if (ev.type === 'tool-use') toolCalls++;
    if (ev.type === 'stop') stopReason = ev.stopReason;
    if (ev.type === 'error') errorEvent = ev.error;
    if (ev.type === 'usage' && ev.usage) {
      usage.inputTokens += ev.usage.inputTokens || 0;
      usage.outputTokens += ev.usage.outputTokens || 0;
      usage.cacheReadTokens += ev.usage.cacheReadTokens || 0;
      usage.cacheWriteTokens += ev.usage.cacheWriteTokens || 0;
    }
    onEvent?.(ev);
  }
  // Only THIS turn's messages — the full transcript slice (user + assistant
  // rounds + tool_use/tool_result), so the SW can persist the WHOLE exchange to
  // the real session (not a lossy user+finalText pair) and statefulness holds.
  const all = (await sessions.get(sessionId))?.messages ?? [];
  const newMessages = all.slice(before);
  const finalText = finalAssistantText({ messages: newMessages });
  const error = (!finalText && errorEvent) ? String(errorEvent) : undefined;
  return { finalText, newMessages, usage, stopReason, toolCalls, ...(error ? { error } : {}) };
};
