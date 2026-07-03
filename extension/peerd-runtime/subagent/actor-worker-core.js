// @ts-check
// actor-worker-core — the PURE, worker-portable core of an offscreen BOUND-ACTOR
// loop (heap-split phase 2). The reasoning sibling (phase 1) had no tools; a
// bound actor (VM / Notebook / App) HOLDS its kind's engine tools, so this core
// adds a RELAYED tool dispatch on top of phase 1's relayed model call.
//
// TRUST PROPERTY. A bound actor ingests UNTRUSTED INSTANCE OUTPUT — VM stdout,
// Notebook/App file contents. Running its loop in its OWN Worker heap makes that
// a memory boundary: the untrusted output can reach neither the orchestrator's
// memory nor the key. The worker holds NO key, NO engine clients, NO chrome.* —
// it relays BOTH the model call AND every tool call back to SW-gated routes:
//   - the model call → the SW adds getSecret + safeFetch (phase 1's route);
//   - a tool call → the SW builds the actor's instance-PINNED, gated tool context
//     and dispatches there (the pin + gate + audit + engine clients + tabs are
//     ALL SW-side). why the SW MUST re-pin+gate: the worker's `call` args are
//     attacker-influenceable (injected instance output), so the SW never trusts
//     them — it force-pins the bound instance and runs the full gate, exactly as
//     the in-SW actor path does today.
//
// PURE / injected-IO → Bun-testable. Reuses phase 1's session shim + relayed
// callModel (same module dir).

import { makeInMemorySessions, makeRelayedCallModel, finalAssistantText } from './reasoning-worker-core.js';

export { makeInMemorySessions, makeRelayedCallModel, finalAssistantText };

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
 * Drive one BOUND-actor turn to completion in the worker heap, returning the same
 * result shape spawn/actor-turn code expects. Accumulates usage, captures the
 * stop reason, surfaces a text-less error (so a failed run isn't a silent blank).
 *
 * @param {Object} deps
 * @param {(ctx: any) => AsyncIterable<any>} deps.runUserTurn
 * @param {ReturnType<typeof makeInMemorySessions>} deps.sessions
 * @param {(args: object) => AsyncIterable<any>} deps.callModel   the relayed callModel
 * @param {(call: object) => Promise<any>} deps.toolDispatch      the relayed toolDispatch
 * @param {() => (Promise<string> | string)} deps.getSystemPrompt
 * @param {(entry: object) => (Promise<unknown> | void)} [deps.appendAudit]
 * @param {(ev: object) => void} [deps.onEvent]
 * @param {Array<{ name: string, description: string, schema: object }>} deps.tools
 * @param {{ sessionId: string, userText: string, maxSteps?: number, signal?: AbortSignal, reasoning?: object, contextWindow?: number }} req
 * @returns {Promise<{ finalText: string, newMessages: any[], usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, stopReason: string|undefined, toolCalls: number, error?: string }>}
 */
export const runActorLoop = async (deps, req) => {
  const { runUserTurn, sessions, callModel, toolDispatch, getSystemPrompt, onEvent, tools } = deps;
  // Defensive (phase-1 lesson): the loop fire-and-forgets audits as
  // appendAudit(...).catch(...) — a sync stub returning undefined would crash it.
  const appendAudit = (/** @type {object} */ e) => Promise.resolve(deps.appendAudit?.(e));
  const { sessionId, userText, maxSteps, signal, reasoning, contextWindow } = req;
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
    getSecret: async () => { throw new Error('actor worker has no secret access'); },
    safeFetch: async () => { throw new Error('actor worker has no egress'); },
    sessions,
    getSystemPrompt,
    appendAudit,
    tools,
    toolDispatch,
    maxSteps,
    persistDeltas: false,
    ...(signal ? { signal } : {}),
    // maxSteps: omit when undefined so runUserTurn uses its OWN default (parity
    // with the in-SW actor path, which passes none). Only cap when the caller asks.
    ...(maxSteps != null ? { maxSteps } : {}),
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
