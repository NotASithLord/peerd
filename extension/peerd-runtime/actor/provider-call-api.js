// @ts-check
// provider-call-api.js — the PURE core for `peerd.provider.call` (design 5:
// model calls from inside a script run), the a2a-api.js twin for the sub-model
// lane.
//
// The script tool's "bash spawning `claude -p`" analogue: classify / extract /
// summarize INSIDE a data pipeline without surfacing every intermediate row
// back into the main context. Deliberately TEXT IN, TEXT OUT — no tools, no
// streaming, no thinking budget: a sub-call that could itself call tools would
// be an agent loop inside a capability we can't see into (that is what
// peerd.runtime.runAgent / the actors client are for, real gated delegation).
//
// Pure — values in, values out, no IO, no imports. The imperative shell (the
// worker bridge, the job-runner relay wall, the SW `script/model-call` route
// that adds the key + folds cost) lives elsewhere; keeping validation, quota
// arithmetic, and the event fold here makes the refusal matrix unit-testable
// without a browser or a live provider.

/** A refused call REJECTS in the realm like a thrown call — bad args, never quota. */
export class ProviderCallError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'ProviderCallError'; }
}

/** Quota overflow — a STRUCTURED refusal the script can catch and degrade on
 * (a fan-out should finish with partial results), never a worker kill. The
 * message always starts with 'provider quota exceeded' so realm code can
 * string-match it (the bridge re-raises plain Errors across the seam). */
export class ProviderQuotaError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'ProviderQuotaError'; }
}

// ── Per-RUN quota (design 5's policy decision) ─────────────────────────────
// Counted SW-side keyed by runId (script-runs.js) so a hostile/buggy realm
// cannot reset its own meter. No cross-run daily budget in v1 — the cost view
// + Stop + the session spend limit are the existing levers.
// why 20: enough fan-out for the target workload (map-reduce over ~a screen of
// rows, grading a candidate list) while keeping a runaway while-loop's worst
// case at one turn's order of spend — the design-doc proposal, owner-tunable.
export const PROVIDER_RUN_MAX_CALLS = 20;
// why 32k: "a ceiling in the same order as one normal turn's budget" — the
// turn's streamed output cap is 64k (to-anthropic.js maxTokens default), so
// half of it bounds sub-call output at the same order without letting the
// side-channel outspend the turn that caused it.
export const PROVIDER_RUN_MAX_OUTPUT_TOKENS = 32_768;
// why 8192: the per-call clamp — 2× the actor per-call default (spawn.js
// DEFAULT_MAX_OUTPUT_TOKENS), room for a real extraction, an order below the
// run ceiling so one call can't drain the whole run's budget.
export const PROVIDER_CALL_MAX_TOKENS = 8192;
// why 1024 default: the target calls are classify/extract/summarize — short
// answers; a script that wants a long generation says so with maxTokens.
export const PROVIDER_CALL_DEFAULT_MAX_TOKENS = 1024;
// why an INPUT cap too: the run ceiling above bounds only OUTPUT tokens, but
// input spends real credits as well — 20 uncapped calls each hauling a huge
// system+prompt would outspend the output ceiling invisibly. 200k chars is
// ~50k tokens: one long turn's order of context, far above the target
// workload (a screen of rows per call), so it only bites runaway inputs.
export const PROVIDER_CALL_MAX_INPUT_CHARS = 200_000;

// The whole accepted surface. Anything else — tools, stream, thinking,
// tool_choice, a future arg we haven't reviewed — is refused BY NAME, so the
// text-only contract can't erode one silently-ignored key at a time.
const ALLOWED_KEYS = Object.freeze(['system', 'prompt', 'messages', 'model', 'maxTokens']);

/**
 * Validate + normalize the realm's `peerd.provider.call(args)` into the shape
 * the relay hands callModel. Fail-closed: throws ProviderCallError on anything
 * outside the minimal text surface.
 *
 * @param {unknown} raw
 * @returns {{ system?: string, messages: Array<{ role: 'user'|'assistant', content: string }>, model?: string, maxTokens: number }}
 */
export const validateProviderCallArgs = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderCallError('provider.call(args): args must be an object');
  }
  const args = /** @type {Record<string, unknown>} */ (raw);
  const unknown = Object.keys(args).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length) {
    throw new ProviderCallError(
      `provider.call: unsupported arg(s) ${unknown.join(', ')} — this is a text-only surface `
      + '(no tools, no streaming); for a tool-using subtask delegate to an actor instead');
  }
  const hasPrompt = args.prompt !== undefined;
  const hasMessages = args.messages !== undefined;
  if (hasPrompt === hasMessages) {
    throw new ProviderCallError('provider.call: pass exactly one of prompt or messages');
  }
  /** @type {Array<{ role: 'user'|'assistant', content: string }>} */
  let messages;
  if (hasPrompt) {
    if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
      throw new ProviderCallError('provider.call: prompt must be a non-empty string');
    }
    messages = [{ role: 'user', content: args.prompt }];
  } else {
    if (!Array.isArray(args.messages) || args.messages.length === 0) {
      throw new ProviderCallError('provider.call: messages must be a non-empty array of { role, content }');
    }
    messages = args.messages.map((m, i) => {
      const role = /** @type {{ role?: unknown }} */ (m)?.role;
      const content = /** @type {{ content?: unknown }} */ (m)?.content;
      if (role !== 'user' && role !== 'assistant') {
        throw new ProviderCallError(`provider.call: messages[${i}].role must be 'user' or 'assistant'`);
      }
      // why string-only content: block arrays are where tool_result / images /
      // thinking ride — the text-only contract is enforced at the SHAPE.
      if (typeof content !== 'string' || content.length === 0) {
        throw new ProviderCallError(`provider.call: messages[${i}].content must be a non-empty string`);
      }
      return { role, content };
    });
  }
  if (args.system !== undefined && typeof args.system !== 'string') {
    throw new ProviderCallError('provider.call: system must be a string');
  }
  const inputChars = (typeof args.system === 'string' ? args.system.length : 0)
    + messages.reduce((total, m) => total + m.content.length, 0);
  if (inputChars > PROVIDER_CALL_MAX_INPUT_CHARS) {
    throw new ProviderCallError(
      `provider.call: input too large (${inputChars} chars > ${PROVIDER_CALL_MAX_INPUT_CHARS}) — batch fewer rows per call`);
  }
  if (args.model !== undefined && (typeof args.model !== 'string' || args.model.length === 0)) {
    throw new ProviderCallError('provider.call: model must be a non-empty string');
  }
  let maxTokens = PROVIDER_CALL_DEFAULT_MAX_TOKENS;
  if (args.maxTokens !== undefined) {
    if (typeof args.maxTokens !== 'number' || !Number.isFinite(args.maxTokens) || args.maxTokens < 1) {
      throw new ProviderCallError('provider.call: maxTokens must be a positive number');
    }
    maxTokens = Math.min(Math.floor(args.maxTokens), PROVIDER_CALL_MAX_TOKENS);
  }
  return {
    ...(typeof args.system === 'string' && args.system.length ? { system: args.system } : {}),
    messages,
    ...(typeof args.model === 'string' ? { model: args.model } : {}),
    maxTokens,
  };
};

/**
 * The per-run quota check — pure over the SW-side counters. Returns the
 * ProviderQuotaError to refuse with, or null when the run may call again.
 * Counters are read BEFORE a call and the call is counted before it flies, so
 * a concurrent fan-out can overshoot the token ceiling only by its in-flight
 * calls' clamped output — bounded, by construction.
 *
 * @param {{ calls?: number, outputTokens?: number } | null | undefined} used
 * @returns {ProviderQuotaError | null}
 */
export const providerQuotaError = (used) => {
  const calls = used?.calls ?? 0;
  const outputTokens = used?.outputTokens ?? 0;
  if (calls >= PROVIDER_RUN_MAX_CALLS) {
    return new ProviderQuotaError(
      `provider quota exceeded: ${PROVIDER_RUN_MAX_CALLS} sub-calls per run — reduce the fan-out or batch rows per call`);
  }
  if (outputTokens >= PROVIDER_RUN_MAX_OUTPUT_TOKENS) {
    return new ProviderQuotaError(
      `provider quota exceeded: ${PROVIDER_RUN_MAX_OUTPUT_TOKENS} output tokens per run — lower maxTokens or summarize tighter`);
  }
  return null;
};

/**
 * Fold a completed provider event stream into the text-only result. Pure over
 * the collected events (the relay drains the async stream, then folds), so the
 * text/usage/error semantics are provable without a live adapter. Multiple
 * usage events sum (the accumulator's rule); reasoning/tool events — which a
 * text-only call should never produce — are ignored rather than trusted.
 *
 * @param {ReadonlyArray<{ type: string, text?: string, error?: string, stopReason?: string, usage?: { inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number } }>} events
 * @returns {{ text: string, usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } | null, stopReason?: string, error?: string }}
 */
export const foldProviderEvents = (events) => {
  let text = '';
  /** @type {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } | null} */
  let usage = null;
  /** @type {string | undefined} */
  let error;
  /** @type {string | undefined} */
  let stopReason;
  for (const ev of events ?? []) {
    if (ev.type === 'text-delta' && typeof ev.text === 'string') text += ev.text;
    else if (ev.type === 'usage' && ev.usage) {
      usage = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      usage.inputTokens += ev.usage.inputTokens ?? 0;
      usage.outputTokens += ev.usage.outputTokens ?? 0;
      usage.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
    } else if (ev.type === 'error' && error === undefined) error = ev.error ?? 'provider error';
    else if (ev.type === 'message-stop') stopReason = ev.stopReason;
  }
  return { text, usage, ...(stopReason !== undefined ? { stopReason } : {}), ...(error !== undefined ? { error } : {}) };
};
