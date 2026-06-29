// @ts-check
// V1 agent loop with tool support.
//
// The loop is an async generator the SW drives forward by `.next()`.
// Each yielded value is an event the SW pushes to the side panel.
// The loop owns no IO directly — every external surface (model
// streaming, tool dispatch, session persistence, system prompt
// rendering, audit) is injected. That makes the loop unit-testable
// without spinning up the rest of the stack.
//
// Turn shape:
//
//   user-message added
//   ┌─ outer loop (max MAX_STEPS) ─────────────────────────────┐
//   │  assistant stub appended                                 │
//   │  stream model events: text-delta + tool-use-*            │
//   │  finalize assistant message                              │
//   │  yield stop                                              │
//   │  if no tool_use OR errored → break                       │
//   │  for each tool call: dispatch, collect result            │
//   │  append user message with tool_result blocks             │
//   │  yield state                                             │
//   └─ continue ────────────────────────────────────────────── ┘
//
// MAX_STEPS guards against pathological loops; we cap at 100
// (raised from 25 — real agentic browser tasks
// routinely want 30+ steps, and 25 false-positived on genuine work).

import { uuidv7 } from '/shared/util.js';
import { RuntimeContextIncompleteError } from '../errors.js';
import { redactToolResult } from './redact.js';
import { stripAttachments } from './attachments.js';
import { planTrim } from './trim.js';
import { planBodyCompaction } from './lineage-compaction.js';
import { partitionToolBatch } from './tool-batch.js';
import { injectResumeNotes } from './resume-notes.js';
import { RESUME_NUDGE } from './resume-detect.js';

/**
 * @typedef {import('../sessions/types.js').Session} Session
 * @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage
 * @typedef {import('/peerd-provider/types.js').ToolUseBlock} ToolUseBlock
 * @typedef {import('/peerd-provider/types.js').ToolResultBlock} ToolResultBlock
 * @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {import('/shared/tool-types.js').ToolResult} ToolResult
 */

/**
 * @typedef {{ type: 'state', session: Session }
 *        | { type: 'delta', sessionId: string, messageId: string, text: string }
 *        | { type: 'reasoning', sessionId: string, messageId: string, text: string }
 *        | { type: 'tool-use', sessionId: string, messageId: string, toolUseId: string, name: string, input: object }
 *        | { type: 'tool-result', sessionId: string, toolUseId: string, result: ToolResult }
 *        | { type: 'usage', sessionId: string, messageId: string, usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } }
 *        | { type: 'error', sessionId: string, messageId: string, error: string }
 *        | { type: 'stop',  sessionId: string, messageId: string, stopReason?: string }
 *        | { type: 'rate-limit-pause', sessionId: string, messageId: string, retryAfterMs: number, attempt: number }
 *        } LoopEvent
 */

// Outer-loop iteration cap. Each "step" is one model call + (optional)
// tool dispatch round. V1 introspection tasks finish in 1-3 steps;
// agentic browser tasks (read → think → click → read → click ...)
// regularly want 30+. 100 catches genuine infinite loops without
// false-positiving on real work.
const MAX_STEPS = 100;

const REQUIRED_CTX = [
  'callModel', 'getSecret', 'safeFetch',
  'sessions', 'getSystemPrompt', 'appendAudit',
];

// Tools safe to dispatch CONCURRENTLY by NAME, independent of permission
// classification. spawn_subagent orchestrates a child session that owns
// its own gate pipeline + session and shares no external mutable state with
// its siblings, so N spawns in one turn can run in parallel instead of
// one-at-a-time. Everything else earns concurrency only via the injected
// permission classifier (ctx.classifyToolCall → READ class), preserving
// peerd's single-writer posture for DOM / VM / file side effects (two
// clicks or two file edits must not interleave).
const CONCURRENT_TOOLS = new Set(['spawn_subagent']);

// Yield settled values in completion order. Each input promise MUST resolve
// (the dispatcher below never rejects), so there is no rejection branch —
// one sibling's failure becomes its own error result, never a batch reject.
// Exported as a test seam.
/**
 * @template T
 * @param {Promise<T>[]} promises
 * @returns {AsyncGenerator<T>}
 */
export async function* asCompleted(promises) {
  const pending = new Map(promises.map((p, i) => [i, p.then((value) => ({ i, value }))]));
  while (pending.size) {
    const { i, value } = await Promise.race(pending.values());
    pending.delete(i);
    yield value;
  }
}

/**
 * Run a single user turn against the model. May iterate through several
 * model calls if the model uses tools (each tool result feeds into the
 * next call until stop_reason !== 'tool_use').
 *
 * @param {Object} ctx
 * @param {string} ctx.sessionId
 * @param {string} ctx.userText                   raw user input
 * @param {import('/peerd-provider/types.js').Attachment[]} [ctx.attachments]
 *   Validated user file attachments (loop/attachments.js shapes). The
 *   bytes ship to the model on THIS turn only; the persisted message
 *   carries the stripped metadata shape. text-kind payloads were already
 *   inlined into userText upstream.
 * @param {(args: object) => AsyncIterable<ProviderEvent>} ctx.callModel
 * @param {(name: string) => Promise<string | null>} ctx.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} ctx.safeFetch
 * @param {ReturnType<typeof import('../sessions/store.js').createSessionStore>} ctx.sessions
 * @param {() => Promise<string>} ctx.getSystemPrompt
 * @param {(entry: { type: string, sessionId?: string, details?: object }) => Promise<unknown>} ctx.appendAudit
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [ctx.tools]
 *   Tool descriptors passed to the provider. Optional.
 * @param {() => Promise<ReadonlyArray<{ name: string, description: string, schema: object }>>} [ctx.refreshTools]
 *   Optional. Called at the START of each step to recompute the advertised
 *   tools (progressive disclosure — an instance created this turn reveals its
 *   ops on the next step). When absent, ctx.tools is used unchanged for the
 *   whole turn (subagents / runners). A throw keeps the prior set.
 * @param {(call: { id: string, name: string, args: object }) => Promise<ToolResult>} [ctx.toolDispatch]
 *   Pre-bound dispatch fn. Required if tools are provided.
 * @param {(name: string) => (import('../permissions/policy.js').PermissionVerdict | null)} [ctx.classifyToolCall]
 *   Optional pure classifier for concurrent dispatch: given a tool name,
 *   returns the SAME decideAction verdict the dispatcher will enforce
 *   (action class + confirm), or null for unknown tools. READ-class,
 *   non-confirming calls may run concurrently; everything else stays
 *   serial. Omitted (subagent/runner loops today) → only the by-name
 *   CONCURRENT_TOOLS set (spawn_subagent) is treated as safe.
 * @param {{ enabled?: boolean, budgetTokens?: number, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }} [ctx.reasoning]
 *   Extended-thinking control, passed straight to the provider. When
 *   enabled, reasoning streams as `reasoning` loop events and signed
 *   thinking blocks are persisted on the assistant message for replay.
 * @param {AbortSignal} [ctx.signal]
 *   When fired, the loop stops at the next iteration boundary OR at
 *   the first stream chunk after abort, persists whatever was streamed,
 *   and yields a clean stop event with stopReason='aborted'.
 * @param {number} [ctx.maxSteps]
 *   Per-turn step cap. Defaults to MAX_STEPS. Subagents pass a smaller
 *   value (default 20) so a runaway child can't burn the parent's whole
 *   budget. Hitting it yields the same clean
 *   stopReason='max_steps' the default cap does.
 * @param {(req: { sessionId: string, state: object, newlyDropped: object[] }) => void} [ctx.enrichTrimSummary]
 *   Optional seam for model-quality trim-summary enrichment. Called
 *   fire-and-forget when the history trim drops NEW messages; the SW
 *   queues the request and runs the cheap summarisation call after the
 *   turn. Never awaited — the loop must never block on summarization.
 * @param {(summaryText: string) => string} [ctx.fenceActorSummary]
 *   DESIGN-17: present ONLY on a WEB-actor ctx (the SW injects it). Wraps the
 *   rolling trim-summary as untrusted data before it's folded back into history —
 *   the web actor self-fences its own page-derived accumulation. Passed straight
 *   through to planTrim's wrapSummary; absent everywhere else (verbatim summary).
 * @param {number} [ctx.contextWindow]
 *   The active model's context window in tokens (SW resolves it from
 *   session.model via peerd-provider/context-window.js). Enables the
 *   DYNAMIC token trigger in planTrim — trim scales to this window. When
 *   absent (window unknown), planTrim falls back to its message-count
 *   backstop alone.
 * @param {boolean} [ctx.synthetic]
 *   Mark the appended user message `synthetic` (API-sanctioned but hidden
 *   from the chat UI, like the truncation-continue path). Used by the
 *   async-subagent reintegration wake (DESIGN-11): the child's result
 *   re-enters its parent as a synthetic user turn rather than a real one.
 * @param {boolean} [ctx.resume]
 *   Auto-resume mode (loop/resume-detect.js): continue a turn the SW
 *   reclaimed mid-flight. No NEW user message is appended — the persisted
 *   history is the input. The loop finalizes a still-"streaming" interrupted
 *   assistant message and, only when the turn was cut off mid-ANSWER (not
 *   mid tool-dispatch), appends a synthetic RESUME_NUDGE so the next call
 *   sees a trailing USER turn. Ignores userText/attachments.
 * @param {() => number} [ctx.now]
 * @param {boolean} [ctx.persistDeltas]
 *   When false, skip the per-delta IDB rewrite of the partial transcript
 *   (browser-runners opt out — an ephemeral child's partial reply dies with
 *   the SW anyway). Defaults to true; finalization writes are unaffected.
 * @param {boolean} [ctx.oneShot]
 *   One-shot turn (actor delegations): after the FIRST clean tool round,
 *   synthesize the reply from the tool results and stop — no second model call
 *   to summarize. An errored round falls through to the normal loop. The caller
 *   (the orchestrator, via message_actor) sets it when one round suffices.
 * @returns {AsyncGenerator<LoopEvent>}
 */
export async function* runUserTurn(ctx) {
  const ctxRecord = /** @type {Record<string, unknown>} */ (ctx);
  for (const k of REQUIRED_CTX) {
    if (ctxRecord[k] === undefined) throw new RuntimeContextIncompleteError(k);
  }
  const {
    sessionId, userText, synthetic, resume, callModel, getSecret, safeFetch,
    sessions, getSystemPrompt, appendAudit,
    tools, refreshTools, toolDispatch, signal, reasoning,
  } = ctx;
  // why: clamp to the hard ceiling so a caller can only ever lower the
  // cap, never raise it past the infinite-loop backstop.
  const requestedSteps = ctx.maxSteps;
  const maxSteps = typeof requestedSteps === 'number' && Number.isFinite(requestedSteps)
    ? Math.min(Math.max(1, Math.floor(requestedSteps)), MAX_STEPS)
    : MAX_STEPS;
  const now = ctx.now ?? Date.now;
  // why: per-delta persistence buys SW-crash recovery of a PARTIAL
  // transcript — worth a full-record IDB rewrite per chunk for the main
  // chat, pure waste for an ephemeral child whose awaiting parent dies
  // with the SW anyway. Callers opt OUT explicitly (browser-runners);
  // finalization writes are unaffected either way.
  const persistDeltas = ctx.persistDeltas !== false;
  const toolsArePresent = Array.isArray(tools) && tools.length > 0;
  if (toolsArePresent && typeof toolDispatch !== 'function') {
    throw new RuntimeContextIncompleteError('toolDispatch (required when tools provided)');
  }
  // why: the main turn passes refreshTools to recompute the advertised tool
  // list each step (progressive disclosure — an instance created this turn
  // reveals its ops on the next step). Without it, activeTools stays the
  // initial set (subagents / runners use a fixed narrowed toolset).
  let activeTools = tools;

  // 1. Persist the user's message and emit state.
  //
  // Send-once-then-strip (redact.js precedent, inverted in time): the
  // PERSISTED user message carries metadata-only attachment records
  // (stripped:true, no base64) so the bytes never re-ship on later
  // turns — one 5MB image is ~1.7M tokens of base64 if it rides the
  // history. The LIVE payload stays in this turn-local variable and is
  // spliced back into the history (by message id) for every model call
  // of THIS turn only. An SW restart mid-turn degrades to the stripped
  // shape — a valid prompt, just without the bytes. Validation happened
  // upstream (SW agent/send via loop/attachments.js).
  const liveAttachments = !resume && Array.isArray(ctx.attachments) && ctx.attachments.length > 0
    ? ctx.attachments
    : null;
  // Tool-result images (view screenshots): send-once-then-strip, tool-side. A
  // tool that returns `images` (tools/web/view.js) has its bytes stashed HERE,
  // keyed by tool_use_id — the PERSISTED result block stays bytes-free metadata.
  // The pixels are spliced into the wire history for the ONE model call that
  // consumes the result (the step right after capture), then cleared, so a
  // ~30k-token screenshot ships exactly once and never persists or re-ships (the
  // rate-limit cliff redact.js guards against for text, here for images).
  /** @type {Map<string, Array<{ mediaType: string, data: string }>>} */
  const liveToolImages = new Map();
  // Thinking-only truncation recovery: when a step ends at max_tokens
  // with NO text and NO tool_use (the model burned the whole output
  // ceiling on reasoning), the turn used to end SILENTLY — nothing in
  // chat, nothing durable, and a re-prompt restarted the same doomed
  // reasoning from scratch. Bounded so a pathological prompt can't loop
  // the provider forever; the 64k default ceiling makes this rare.
  const MAX_TRUNCATION_CONTINUES = 2;
  let truncationContinues = 0;
  /** @type {InternalMessage | null} */
  let userMsg = null;
  /** @type {Session} */
  let session;
  if (resume) {
    // Auto-resume: continue a turn the SW reclaimed mid-flight. No NEW user
    // message — the persisted history IS the input. We finalize a still-
    // "streaming" interrupted assistant message, then decide how to make the
    // history end on a valid trailing turn for the next model call:
    //   - cut off mid-ANSWER (assistant text, no pending tool_use) → append a
    //     synthetic RESUME_NUDGE so the trailing turn is a USER message (a
    //     trailing assistant would be a prefill, which 400s with thinking on);
    //   - cut off mid tool-dispatch (dangling tool_use) or with tool results
    //     already persisted → append NOTHING; the format layer's orphan-repair
    //     pairs the tool_use with a synth result, and the history is already
    //     continuable. See loop/resume-detect.js.
    session = /** @type {Session} */ (await sessions.get(sessionId));
    if (!session || session.messages.length === 0) return;
    const last = session.messages[session.messages.length - 1];
    if (last.role === 'assistant' && last.streaming) {
      await sessions.updateAssistantMessage(sessionId, last.id, { streaming: false });
    }
    const danglingToolUse = last.role === 'assistant'
      && Array.isArray(last.toolUses) && last.toolUses.length > 0;
    if (last.role === 'assistant' && !danglingToolUse) {
      /** @type {InternalMessage} */
      const nudge = {
        role: 'user', content: RESUME_NUDGE, synthetic: true,
        id: uuidv7(now), when: now(),
      };
      await sessions.appendMessage(sessionId, nudge);
    }
    session = /** @type {Session} */ (await sessions.get(sessionId));
    yield { type: 'state', session };
  } else {
    userMsg = {
      role: 'user',
      content: userText,
      ...(liveAttachments ? { attachments: stripAttachments(liveAttachments) } : {}),
      // why: an async-subagent reintegration wake (DESIGN-11) rides a
      // synthetic user turn — API-sanctioned, hidden from the chat UI like
      // the truncation-continue path below. The wake framing is trusted; the
      // child's result text inside it is wrapUntrusted by the caller.
      ...(synthetic ? { synthetic: true } : {}),
      id: uuidv7(now),
      when: now(),
    };
    session = await sessions.appendMessage(sessionId, userMsg);
    yield { type: 'state', session };
    if (session.messages.length === 1) {
      appendAudit({ type: 'session_started', sessionId }).catch(() => {});
    }
  }

  // 2. Render the system prompt once per turn. We don't re-render on
  // every step — the prompt assembly is provider-agnostic and depends
  // only on session-stable context (date).
  const system = await getSystemPrompt();

  // Helper: was the turn aborted? Used at iteration boundaries; the
  // stream catch block has its own AbortError handling.
  const wasAborted = () => signal?.aborted === true;

  // ---- Outer loop: model call → maybe tools → model call → ... -----------
  let step = 0;
  // One-shot latch: a clean first tool round short-circuits (no summarize turn);
  // an errored round clears this so the rest of the turn runs normally. Loop-scoped
  // so the latch survives across steps.
  let oneShotArmed = ctx.oneShot === true;
  /** @type {string | null} */
  let lastAssistantId = null;
  while (step < maxSteps) {
    step++;
    if (wasAborted()) {
      if (lastAssistantId) {
        await sessions.updateAssistantMessage(sessionId, lastAssistantId, {
          streaming: false, stopReason: 'aborted',
        });
        yield {
          type: 'stop', sessionId,
          messageId: lastAssistantId, stopReason: 'aborted',
        };
      }
      return;
    }

    // Progressive disclosure: recompute the advertised tools for THIS step so
    // an instance created earlier this turn reveals its ops now. refreshTools
    // also restamps the dispatch ctx's instanceState (SW side), keeping the
    // exposure gate in lockstep with what the model is shown. A failure keeps
    // the prior set — never break the turn on a tool refresh.
    if (typeof refreshTools === 'function') {
      try { activeTools = await refreshTools(); }
      catch { /* keep the prior tool set */ }
    }

    /** @type {InternalMessage} */
    const assistantStub = {
      role: 'assistant',
      content: '',
      id: uuidv7(now),
      when: now(),
      model: session.model,
      provider: session.provider,
      streaming: true,
    };
    session = await sessions.appendMessage(sessionId, assistantStub);
    lastAssistantId = assistantStub.id;
    yield { type: 'state', session };

    let textBuf = '';
    // Extended-thinking accumulators. `reasoningBuf` is the human-visible
    // running text (rendered as a collapsible "Reasoning" section);
    // `thinkingBlocks` holds the signed/redacted blocks verbatim so the
    // next tool-use turn can replay them back to the provider intact.
    let reasoningBuf = '';
    /** @type {Array<{ type: string, thinking?: string, signature?: string, data?: string }>} */
    const thinkingBlocks = [];
    /** @type {Map<string, { id: string, name: string, inputBuf: string }>} */
    const pendingToolUses = new Map();
    let stopReason;
    let errored = false;

    try {
      // why: planTrim is the backstop for sessions long enough that
      // the cached prefix outgrows the context window or rate-limit
      // budget even at ~10% cached cost. Under the soft cap it's a
      // no-op (returns a shallow copy). Over it, the oldest messages
      // collapse to a single synthesised summary user message rendered
      // from the ROLLING summary state — prior state + newly-dropped
      // turns folded mechanically (rolling-summary.js).
      // why: lineage body-compaction runs BEFORE the summary collapse —
      // shrink OLD tool-result bodies to their dispatcher-lineage spine
      // (deterministic, structure-safe, re-runnable). It usually brings the
      // estimate under budget on its own, so the lossy rolling summary fires
      // far less often. Only when we know the model's window (same signal as
      // the trim trigger); a no-op otherwise. Pure transform — the persisted
      // record keeps full bodies, only what's SENT shrinks.
      const preTrim = ctx.contextWindow
        ? planBodyCompaction(session.messages.slice(0, -1), {
            contextWindow: ctx.contextWindow,
            system,
          }).messages
        : session.messages.slice(0, -1);
      const trimPlan = planTrim(preTrim, {
        summaryState: session.trimSummary,
        // why: the DYNAMIC trigger — scale the trim threshold to THIS
        // model's context window (resolved by the SW from session.model).
        // Undefined (window unknown) → the message-count backstop alone,
        // i.e. the original behavior. system is counted toward the
        // estimate since it's part of the prompt the window must hold.
        contextWindow: ctx.contextWindow,
        system,
        // DESIGN-17: a WEB actor self-fences its OWN rolling summary on
        // re-insertion (its accumulation is 100% untrusted-provenance — every byte
        // is page-derived). The SW injects ctx.fenceActorSummary on a web-actor
        // ctx; absent everywhere else, so the summary renders verbatim as before.
        ...(typeof ctx.fenceActorSummary === 'function'
          ? { wrapSummary: ctx.fenceActorSummary }
          : {}),
      });
      // why: turns interrupted mid-reasoning (abort / max_tokens /
      // provider error) persist partial `thinking`, but the API strips
      // replayed thinking and the format layer drops thinking-only
      // messages — the next call would carry no trace of the attempt.
      // injectResumeNotes surfaces that thinking as visible resume notes;
      // since history is rebuilt from the session each step, this also
      // turns the max_tokens auto-continue below into a true resume.
      // why cast: planTrim's TrimmedMessage is a superset of InternalMessage
      // (it also models the converter's block-content variant). In the loop
      // path the messages are always loop-shaped InternalMessages, and
      // injectResumeNotes only ever reads assistant `thinking`, so narrowing
      // here is safe.
      let historyForModel = injectResumeNotes(
        /** @type {InternalMessage[]} */ (trimPlan.messages));
      // why: the model must see the attachment BYTES on the turn they
      // were sent (every step of it — history is rebuilt from the
      // session per step), while the persisted record stays stripped.
      // Shallow-swap this turn's user message only; everything older
      // keeps its stripped shape.
      if (liveAttachments && userMsg) {
        historyForModel = historyForModel.map((msg) =>
          msg.id === userMsg.id ? { ...msg, attachments: liveAttachments } : msg);
      }
      // why: deliver a freshly-captured screenshot's PIXELS to the model on the
      // ONE call that consumes its tool_result (the step after capture) by
      // splicing the live bytes into the wire copy of the result block. The
      // stash is cleared AFTER this model call succeeds (below the stream), not
      // here — so a transient call failure doesn't silently drop the image
      // before it was ever delivered (mirrors how liveAttachments survives a
      // failed step). The persisted block holds only bytes-free metadata.
      if (liveToolImages.size > 0) {
        historyForModel = historyForModel.map((msg) => {
          if (msg.role !== 'user') return msg;
          const trs = msg.toolResults;
          if (!Array.isArray(trs) || trs.length === 0) return msg;
          let changed = false;
          const toolResults = trs.map((tr) => {
            const imgs = liveToolImages.get(tr.tool_use_id);
            if (imgs && imgs.length > 0) { changed = true; return { ...tr, images: imgs }; }
            return tr;
          });
          return changed ? { ...msg, toolResults } : msg;
        });
      }
      // didTrim true ⇒ summaryState non-null (planTrim's contract); the
      // extra truthiness check is runtime-identical and narrows the type.
      if (trimPlan.didTrim && trimPlan.summaryState && trimPlan.newlyDropped.length > 0) {
        const summaryState = trimPlan.summaryState;
        // why persist NOW (before streaming starts): the state must
        // survive an SW restart, and this is the one point in the loop
        // where no other session write is in flight. setTrimSummary is
        // optional-chained + swallowed so older fakes/stores without it
        // — and any persist hiccup — degrade to "recompute next turn",
        // never a broken turn.
        try { await sessions.setTrimSummary?.(sessionId, summaryState); }
        catch { /* trim state is reconstructible; never break the turn */ }
        // why fire-and-forget: model-quality enrichment of the summary
        // is strictly optional. The injected seam (the SW queues it and
        // runs it AFTER the turn) is never awaited here, so the loop can
        // never block — or fail — on summarization. The mechanical fold
        // above is the always-available fallback.
        if (typeof ctx.enrichTrimSummary === 'function') {
          try {
            ctx.enrichTrimSummary({
              sessionId,
              state: summaryState,
              newlyDropped: trimPlan.newlyDropped,
            });
          } catch { /* enrichment is advisory */ }
        }
      }
      for await (const ev of callModel({
        provider: session.provider,
        model: session.model,
        messages: historyForModel,
        system,
        tools: activeTools,
        reasoning,
        getSecret,
        safeFetch,
        signal,
      })) {
        switch (ev.type) {
          case 'text-delta':
            textBuf += ev.text;
            if (persistDeltas) {
              await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
                content: textBuf,
              });
            }
            yield {
              type: 'delta', sessionId,
              messageId: assistantStub.id, text: ev.text,
            };
            break;
          case 'reasoning-delta':
            reasoningBuf += ev.text;
            // Persist per delta so a SW restart mid-stream keeps the
            // partial reasoning, same as text deltas above.
            if (persistDeltas) {
              await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
                thinking: reasoningBuf,
              });
            }
            yield {
              type: 'reasoning', sessionId,
              messageId: assistantStub.id, text: ev.text,
            };
            break;
          case 'reasoning-stop':
            // Capture the complete block for verbatim replay. Signed
            // thinking and redacted_thinking are stored in the shape the
            // provider expects back (see to-anthropic.js).
            if (ev.redacted) {
              thinkingBlocks.push({ type: 'redacted_thinking', data: ev.data ?? '' });
            } else if (typeof ev.text === 'string') {
              thinkingBlocks.push({ type: 'thinking', thinking: ev.text, signature: ev.signature ?? '' });
            }
            break;
          case 'tool-use-start':
            pendingToolUses.set(ev.id, { id: ev.id, name: ev.name, inputBuf: '' });
            break;
          case 'tool-use-delta': {
            const tu = pendingToolUses.get(ev.id);
            if (tu) tu.inputBuf += ev.partialJson;
            break;
          }
          case 'tool-use-stop':
            // No-op: input is complete; parsing happens below.
            break;
          case 'usage':
            // why: forward token usage straight through as a loop event.
            // The loop itself stays pricing-agnostic — the SW multiplies
            // by the local pricing table, accumulates per-turn/session,
            // and enforces the optional hard spend limit (feature 06).
            // Emitting per model call means a multi-step tool-using turn
            // reports each call's usage as it lands, so the meter ticks
            // up live instead of only at end-of-turn.
            yield {
              type: 'usage', sessionId,
              messageId: assistantStub.id, usage: ev.usage,
            };
            break;
          case 'message-stop':
            stopReason = ev.stopReason;
            // why: 'incomplete' means the SSE body closed without a
            // message_stop event -- typically a mid-stream provider
            // rate limit or a dropped connection. Without this yield
            // the loop would just return silently; the side panel
            // would see no error event and the user wonders why
            // generation stopped. Surface it as a real error so the
            // chat shows it and the next turn's orphan-repair can
            // tag tool_result content accordingly.
            if (stopReason === 'incomplete') {
              errored = true;
              await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
                content: textBuf,
                error: 'provider stream ended early (likely rate limit or network drop)',
              });
              yield {
                type: 'error', sessionId,
                messageId: assistantStub.id,
                error: 'provider stream ended early (likely rate limit or network drop)',
              };
            }
            break;
          case 'rate-limit-pause':
            // why: surface the pause to the UI so the side panel can
            // show a "rate-limited, retrying in Xs" hint instead of
            // looking frozen. The adapter is already sleeping; we just
            // forward the timing so the UI knows what to render.
            yield {
              type: 'rate-limit-pause', sessionId,
              messageId: assistantStub.id,
              retryAfterMs: ev.retryAfterMs,
              attempt: ev.attempt,
            };
            break;
          case 'error':
            errored = true;
            await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
              content: textBuf,
              streaming: false,
              error: ev.error,
            });
            yield {
              type: 'error', sessionId,
              messageId: assistantStub.id, error: ev.error,
            };
            // Don't return — let the stream finish so the final stop
            // event fires and any cleanup runs.
            break;
          default:
            break;
        }
      }
      // why: the screenshot bytes spliced above rode THIS model call, which
      // completed — clear now so the image ships exactly once and never re-ships
      // on a later step. A throw skips this (handled in catch) and the turn ends;
      // the turn-local stash is discarded either way, so bytes never persist.
      if (liveToolImages.size > 0) liveToolImages.clear();
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      // AbortError when the user clicks Stop or sends a new message
      // mid-stream. Not an error; mark message aborted and exit.
      if (wasAborted() || err?.name === 'AbortError' || /abort/i.test(err?.message ?? '')) {
        await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
          content: textBuf,
          streaming: false,
          stopReason: 'aborted',
        });
        yield {
          type: 'stop', sessionId,
          messageId: assistantStub.id, stopReason: 'aborted',
        };
        return;
      }
      errored = true;
      const message = err?.message ?? String(e);
      await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
        content: textBuf,
        streaming: false,
        error: message,
      });
      yield {
        type: 'error', sessionId,
        messageId: assistantStub.id, error: message,
      };
    }

    // Parse tool-use input JSON. Anthropic streams partial_json
    // fragments; we concatenate, then JSON.parse the whole thing. An
    // empty buffer means the model passed `{}` implicitly.
    /** @type {ToolUseBlock[]} */
    const toolUses = [];
    for (const tu of pendingToolUses.values()) {
      let input;
      try { input = tu.inputBuf ? JSON.parse(tu.inputBuf) : {}; }
      catch { input = {}; }
      toolUses.push({ id: tu.id, name: tu.name, input });
    }

    // Finalize the assistant message for this step.
    await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
      content: textBuf,
      ...(toolUses.length > 0 ? { toolUses } : {}),
      // why: `thinking` is the rendered reasoning text; `thinkingBlocks`
      // are the signed blocks the next tool-use turn must replay. Only
      // attach when present so non-thinking turns stay clean.
      ...(reasoningBuf.length > 0 ? { thinking: reasoningBuf } : {}),
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
      streaming: false,
      stopReason,
    });
    // Re-fetch the session so the next iteration sees the updated message.
    // why cast: the updateAssistantMessage above just succeeded (it throws
    // SessionNotFoundError otherwise), so the record provably exists here —
    // get's `Session | undefined` can only be the defined branch.
    session = /** @type {Session} */ (await sessions.get(sessionId));
    // why: push the FINALIZED assistant message (now carrying its tool_use
    // blocks) to the side panel BEFORE dispatch. Tool cards render only
    // from state snapshots; without this the next snapshot isn't emitted
    // until AFTER the dispatch block, so N parallel subagent cards stayed
    // invisible for the whole run (and their live transcripts had no card
    // to stream into). Now the cards appear pending the instant dispatch
    // starts and fill in live.
    yield { type: 'state', session };
    yield {
      type: 'stop', sessionId,
      messageId: assistantStub.id, stopReason,
    };

    if (errored) return;
    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      // Thinking-only truncation → auto-continue (see counter above).
      // Continuation rides a synthetic USER turn — the API-sanctioned
      // shape (a trailing assistant message would be a prefill, which
      // 400s on current models). `synthetic` hides it from the chat UI.
      if (
        stopReason === 'max_tokens'
        && toolUses.length === 0
        && textBuf.trim() === ''
        && truncationContinues < MAX_TRUNCATION_CONTINUES
      ) {
        truncationContinues += 1;
        /** @type {InternalMessage} */
        const continueMsg = {
          role: 'user',
          content: 'Your previous response hit the output token limit during '
            + 'internal reasoning and was cut off before any answer or tool '
            + 'call. Continue the task now — act through tool calls early '
            + 'instead of reasoning at length.',
          synthetic: true,
          id: uuidv7(now),
          when: now(),
        };
        session = await sessions.appendMessage(sessionId, continueMsg);
        yield { type: 'state', session };
        continue;
      }
      // Final assistant message — done.
      return;
    }
    if (!toolDispatch) {
      // Provider asked for tools but the SW didn't wire dispatch. Fail
      // loudly via an error event so the side panel surfaces it.
      yield {
        type: 'error', sessionId,
        messageId: assistantStub.id,
        error: 'agent loop: model requested tool_use but no toolDispatch was injected',
      };
      return;
    }

    // Re-check abort AFTER the stream ended, BEFORE any side-effecting dispatch.
    // why: a hard spend-limit halt / Stop / steer can abort() in the GAP between
    // the stream finishing and dispatch — the limit's abort() rides the `usage`
    // event, which adapters emit one event BEFORE `message-stop`, so the
    // for-await ends normally and the mid-stream AbortError branch (:563) never
    // sees it. Without this guard the loop would run every already-emitted
    // tool_use this step (writes / call_api / vm / edit / app side effects) and
    // persist their results before the next loop-top check (:303) finally
    // catches the abort. Mark the turn aborted — so detectInterruptedTurn treats
    // it as a deliberate stop, NOT a resumable tools-pending interruption — and
    // short-circuit before the dispatch waves.
    if (wasAborted()) {
      await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
        stopReason: 'aborted',
      });
      yield {
        type: 'stop', sessionId,
        messageId: assistantStub.id, stopReason: 'aborted',
      };
      return;
    }

    // ---- Dispatch tool calls --------------------------------------------
    // Dispatch ONE call and build its persisted result block. Never throws
    // — a failure (including a thrown dispatcher) becomes an error result,
    // so in a concurrent batch one sibling's failure can't reject the rest.
    /** @param {ToolUseBlock} tu */
    const dispatchOne = async (tu) => {
      /** @type {ToolResult} */
      let dispatchResult;
      try {
        dispatchResult = await toolDispatch({ id: tu.id, name: tu.name, args: tu.input });
      } catch (e) {
        dispatchResult = {
          ok: false,
          error: /** @type {{ message?: string }} */ (e)?.message ?? String(e),
          meta: { toolName: tu.name, primitive: 'unknown', gates: [], durationMs: 0 },
        };
      }
      // why: redact BEFORE persisting. Strips data:image base64 (one
      // 1280px PNG ≈ 25-30k tokens) and truncates over-long results with a
      // head+tail+elided marker. The live `tool-result` event carries the
      // UNREDACTED dispatchResult so the side panel renders the full
      // image/text this turn; only the persisted + re-sent copy is
      // redacted. See redact.js for the rate-limit rationale.
      const rawContent = dispatchResult.ok
        ? (typeof dispatchResult.content === 'string'
            ? dispatchResult.content
            : JSON.stringify(dispatchResult.content))
        : (dispatchResult.error ?? 'tool failed');
      // why: a tool that returned vision blocks (view) — stash the bytes for the
      // one-shot splice into the NEXT model call (above). The persisted block
      // stays bytes-free; only content (metadata) is kept here.
      if (dispatchResult.ok && Array.isArray(dispatchResult.images)) {
        const imgs = dispatchResult.images.filter(
          (im) => im && typeof im.mediaType === 'string'
            && typeof im.data === 'string' && im.data.length > 0);
        if (imgs.length > 0) liveToolImages.set(tu.id, imgs);
      }
      const block = {
        tool_use_id: tu.id,
        content: redactToolResult(rawContent),
        is_error: !dispatchResult.ok,
        meta: dispatchResult.meta,
      };
      return { tu, dispatchResult, block };
    };

    // Concurrency-safety per call. With the injected classifier this is the
    // EXISTING permission classification doing double duty as the scheduler:
    //   - READ class → safe (reads share no mutable state, and decideAction
    //     never confirms a read, so no modal can race another).
    //   - confirm:true → NEVER safe, even for spawn_subagent — a turn must
    //     not stack two confirmation modals (serialize confirms).
    //   - otherwise only the by-name CONCURRENT_TOOLS set (spawn_subagent)
    //     qualifies; every write stays strictly serial in emitted order.
    // Without a classifier (subagent/runner loops) we keep the original
    // spawn_subagent-only behavior.
    const classify = typeof ctx.classifyToolCall === 'function' ? ctx.classifyToolCall : null;
    /** @param {ToolUseBlock} tu */
    const isConcurrencySafe = (tu) => {
      if (!classify) return CONCURRENT_TOOLS.has(tu.name);
      let verdict = null;
      try { verdict = classify(tu.name); } catch { verdict = null; }
      if (!verdict || verdict.confirm === true) return false;
      if (verdict.actionClass === 'read') return true;
      return CONCURRENT_TOOLS.has(tu.name);
    };

    /** @type {ToolResultBlock[]} */
    const toolResults = [];
    // partitionToolBatch groups CONSECUTIVE safe calls into concurrent
    // waves and leaves everything else as single sequential waves, in the
    // model's emitted order — a safe call is never hoisted past an unsafe
    // one (the model may have sequenced "click, then read" on purpose).
    // For a concurrent wave: announce every card up front, then flip each
    // to its result the moment it lands (completion order). Hooks, audit
    // and lineage are untouched — every call still goes through the same
    // dispatchOne → toolDispatch pipeline, one invocation per call.
    let abortedMidBatch = false;
    for (const wave of partitionToolBatch(toolUses, isConcurrencySafe)) {
      // why recheck per wave: Stop (or a spend-limit halt) can land AFTER the
      // pre-dispatch guard (:683) while the batch is draining. Each non-READ call
      // is its own sequential wave, so checking here stops the NEXT side-effecting
      // wave from dispatching once the user pressed Stop — without this the only
      // other check is at the loop top, which runs only after the WHOLE batch ran
      // its side effects. (Already-dispatched calls can't be un-run; we stop here.)
      if (wasAborted()) { abortedMidBatch = true; break; }
      if (wave.concurrent) {
        for (const tu of wave.calls) {
          yield {
            type: 'tool-use', sessionId, messageId: assistantStub.id,
            toolUseId: tu.id, name: tu.name, input: tu.input,
          };
        }
        const blocksById = new Map();
        for await (const { tu, dispatchResult, block } of asCompleted(wave.calls.map(dispatchOne))) {
          yield { type: 'tool-result', sessionId, toolUseId: tu.id, result: dispatchResult };
          blocksById.set(tu.id, block);
        }
        // Persist in the model's emitted order for stable transcripts
        // (Anthropic pairs by tool_use_id, not position; the UI and the
        // history expect emitted order, so determinism here matters).
        for (const tu of wave.calls) toolResults.push(blocksById.get(tu.id));
      } else {
        for (const tu of wave.calls) {
          // belt-and-suspenders: a non-concurrent wave is one call today, but if
          // that ever changes, don't dispatch a second side effect after Stop.
          if (wasAborted()) { abortedMidBatch = true; break; }
          yield {
            type: 'tool-use', sessionId, messageId: assistantStub.id,
            toolUseId: tu.id, name: tu.name, input: tu.input,
          };
          const { dispatchResult, block } = await dispatchOne(tu);
          yield { type: 'tool-result', sessionId, toolUseId: tu.id, result: dispatchResult };
          toolResults.push(block);
        }
        if (abortedMidBatch) break;
      }
    }
    if (abortedMidBatch) {
      // Mirror the pre-dispatch abort guard (:683): mark a DELIBERATE stop (not a
      // resumable tools-pending interruption) and drop the partial tool_result
      // message, so the turn ends cleanly on the aborted assistant message and
      // detectInterruptedTurn won't re-drive it.
      await sessions.updateAssistantMessage(sessionId, assistantStub.id, {
        stopReason: 'aborted',
      });
      yield {
        type: 'stop', sessionId,
        messageId: assistantStub.id, stopReason: 'aborted',
      };
      return;
    }

    // Append the user message that carries tool results back to the
    // model. content is empty because the actual payload lives in the
    // toolResults blocks.
    /** @type {InternalMessage} */
    const resultMessage = {
      role: 'user',
      content: '',
      toolResults,
      id: uuidv7(now),
      when: now(),
    };
    session = await sessions.appendMessage(sessionId, resultMessage);
    yield { type: 'state', session };

    // One-shot turn (DESIGN-17 `oneShot`, actor delegations): the caller asserted
    // a single round suffices, so hand the tool result(s) straight back WITHOUT a
    // second model call to summarize them — that summarize inference is the
    // redundant cost a "run X and report" delegation otherwise pays. Synthesize the
    // reply from the results (deterministic, no inference) as a NORMAL assistant
    // message: it keeps the history ending on an assistant turn (a bare trailing
    // tool-result user message would collide with the next user message — the
    // converter only merges adjacent STRING content), and the caller reads it via
    // finalAssistantText exactly like any turn. why the no-error guard: if a tool
    // FAILED, one round did NOT suffice — disarm one-shot (below) so the model gets
    // its normal recover/explain turns for the REST of this turn. The first CLEAN
    // round short-circuits; multi-step work simply never sets the flag.
    if (oneShotArmed && toolResults.length > 0 && !toolResults.some((b) => b.is_error)) {
      const toolOut = toolResults
        .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
        .join('\n').trim();
      // Keep the model's OWN prose (a preamble or a direct answer it wrote alongside
      // the tool call this round) ahead of the raw tool output — don't silently drop it.
      const replyText = [textBuf.trim(), toolOut].filter(Boolean).join('\n\n')
        || '(the tool produced no output)';
      /** @type {InternalMessage} */
      const oneShotReply = {
        role: 'assistant', content: replyText,
        id: uuidv7(now), when: now(),
        model: session.model, provider: session.provider,
        streaming: false, stopReason: 'one_shot',
      };
      session = await sessions.appendMessage(sessionId, oneShotReply);
      yield { type: 'state', session };
      yield { type: 'stop', sessionId, messageId: oneShotReply.id, stopReason: 'one_shot' };
      return;
    }
    // This round did not cleanly short-circuit (a tool errored) — latch one-shot OFF
    // so a later recovery round runs as a NORMAL turn (recover AND explain) instead of
    // being silently short-circuited too.
    oneShotArmed = false;
    // Continue outer loop — next iteration calls the model with the
    // tool results in the history.
  }

  // Reached maxSteps without a natural stop. Emit a clean stop on the
  // last assistant message with stopReason='max_steps' so the
  // conversation continues naturally — the user can send another
  // message and the agent picks up where it left off. Surfaces in the
  // UI as a stopped (but not failed) turn.
  if (lastAssistantId) {
    await sessions.updateAssistantMessage(sessionId, lastAssistantId, {
      streaming: false, stopReason: 'max_steps',
    });
    yield {
      type: 'stop', sessionId,
      messageId: lastAssistantId, stopReason: 'max_steps',
    };
  }
}
