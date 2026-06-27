// @ts-check
// local-webgpu adapter — the on-device runner endpoint (FEATURE-LOCAL-WEBGPU
// Deliverable B). Gemma runs in the OFFSCREEN doc via Transformers.js / ORT-Web
// on WebGPU; THIS module is the thin provider-side shim that re-yields the
// engine's token stream as the same ProviderEvent stream every other adapter
// emits, so the agent loop + runner consume it identically.
//
// KEYLESS + zero-cost + provider-independent: no vault, no network, no $ — the
// page content never leaves the device for inference. The runner is the target
// (resolveRunnerModel step 2): a narrow ~9-tool job a small model can do.
//
// THE LOAD-BEARING UNKNOWN (parse, below): Transformers.js templates the `tools`
// into the prompt but leaves tool-call PARSING to us. We parse the documented
// `<tool_call>{json}</tool_call>` convention out of the token stream → tool-use
// events; everything else is prose. Whether Gemma actually emits exactly this
// is what the eval A/B (M0) measures — if scores are low, the lever is the
// constrained-output format (§3.3), tuned from real runs. The PARSER itself is
// pure + Bun-tested here so a format change is a localized edit, not a rewrite.
//
// The engine bridge is INJECTED (`setLocalGenerate`) rather than imported, so
// (a) the SW wires the real offscreen RPC at boot, and (b) this module is fully
// unit-testable with a mock token stream — no WebGPU needed to test the shim.

import { MODEL_SPECS } from '../local-model-capability.js';
import { asWindow } from '../model-window.js';

// The resident on-device model id (also the adapter's defaultRunnerModel). The
// offscreen engine answers to it; pricing is $0.
export const LOCAL_MODEL_ID = 'gemma-4-e2b';

/**
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {(opts: { messages: readonly object[], system: string, tools?: readonly object[],
 *   model?: string, signal?: AbortSignal }) => AsyncIterable<string>} LocalGenerate
 */

/**
 * The offscreen-engine bridge, wired by the SW at boot.
 * @type {LocalGenerate | null}
 */
let generateLocal = null;
/** @param {LocalGenerate | null} fn */
export const setLocalGenerate = (fn) => { generateLocal = fn; };

/**
 * Optional bridge to the resident model's LIVE config — the on-device analog
 * of the cloud Models APIs. When the offscreen engine is loaded it knows the
 * model's real `max_position_embeddings` (and could expose an effective,
 * memory-bounded window), so this lets the on-device runner report its
 * window through the SAME provider seam as Anthropic/OpenRouter/Ollama. Until
 * the SW wires it, fetchLocalContextWindow falls back to the static
 * MODEL_SPECS value — so the unified schema works today and sharpens later.
 *
 * @typedef {(model: string) => (number | null | Promise<number | null>)} LocalModelContextWindow
 * @type {LocalModelContextWindow | null}
 */
let localModelContextWindow = null;
/** @param {LocalModelContextWindow | null} fn */
export const setLocalModelInfo = (fn) => { localModelContextWindow = fn; };

/**
 * Live context window for the on-device model, unified with the API
 * providers' `contextWindow` seam (providerModelContextWindow). Prefers the
 * engine-reported value when the bridge is wired; otherwise the static
 * MODEL_SPECS nominal. Best-effort: any failure → null → static table.
 *
 * @param {{ model?: string }} args
 * @returns {Promise<number | null>}
 */
export const fetchLocalContextWindow = async ({ model = LOCAL_MODEL_ID } = {}) => {
  if (typeof localModelContextWindow === 'function') {
    try {
      const live = asWindow(await localModelContextWindow(model));
      if (live !== null) return live;
    } catch { /* fall through to the spec */ }
  }
  // MODEL_SPECS has no index signature; the cast lets an arbitrary model id
  // be looked up (?. handles the miss, returning a static-table null).
  const specs = /** @type {Record<string, import('../local-model-capability.js').ModelSpec | undefined>} */ (MODEL_SPECS);
  return asWindow(specs[model]?.contextWindow);
};

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

/**
 * Stream-parse a Gemma token stream into ProviderEvents. Pure (an async-gen
 * over an async-iterable of token strings). Prose → text-delta; a
 * `<tool_call>{json}</tool_call>` block → tool-use-start/-delta/-stop with the
 * JSON's `name`/`arguments`. Tolerant: an unparseable block is surfaced as text
 * (never throws — a malformed call shouldn't kill the turn).
 *
 * @param {AsyncIterable<string>} tokens
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* parseLocalStream(tokens) {
  let buf = '';
  let inCall = false;
  let callJson = '';
  let callSeq = 0;

  // Emit any complete prose run that precedes the next (possible) tool tag,
  // but hold back a tail that could be the start of a split-across-tokens tag.
  /** @returns {Generator<ProviderEvent>} */
  const flushProse = function* () {
    // keep the last (TOOL_OPEN.length - 1) chars in case a tag is mid-split
    const safe = buf.length - (TOOL_OPEN.length - 1);
    if (safe > 0) {
      const text = buf.slice(0, safe);
      buf = buf.slice(safe);
      if (text) yield { type: 'text-delta', text };
    }
  };

  for await (const tok of tokens) {
    buf += tok;
    // Drain as many complete tags as the buffer holds this step.
    for (;;) {
      if (!inCall) {
        const open = buf.indexOf(TOOL_OPEN);
        if (open === -1) { yield* flushProse(); break; }
        const before = buf.slice(0, open);
        if (before) yield { type: 'text-delta', text: before };
        buf = buf.slice(open + TOOL_OPEN.length);
        inCall = true; callJson = '';
      } else {
        const close = buf.indexOf(TOOL_CLOSE);
        if (close === -1) {
          // Hold back a tail that could be a close tag split across tokens
          // (the symmetric guard to flushProse for the open tag).
          const safe = buf.length - (TOOL_CLOSE.length - 1);
          if (safe > 0) { callJson += buf.slice(0, safe); buf = buf.slice(safe); }
          break;
        }
        callJson += buf.slice(0, close);
        buf = buf.slice(close + TOOL_CLOSE.length);
        inCall = false;
        yield* emitToolCall(callJson, ++callSeq);
        callJson = '';
      }
    }
  }
  // End of stream: flush any remaining prose (and an unterminated call as text).
  if (inCall && callJson) yield { type: 'text-delta', text: TOOL_OPEN + callJson };
  if (buf) yield { type: 'text-delta', text: buf };
}

/**
 * @param {string} json   the JSON text between the tool tags
 * @param {number} seq    1-indexed call counter (→ the synthetic id)
 * @returns {Generator<ProviderEvent>}
 */
function* emitToolCall(json, seq) {
  let parsed;
  try { parsed = JSON.parse(json.trim()); } catch { parsed = null; }
  if (!parsed || typeof parsed.name !== 'string') {
    // Not a usable call — surface verbatim so the model's intent isn't lost.
    yield { type: 'text-delta', text: TOOL_OPEN + json + TOOL_CLOSE };
    return;
  }
  const id = `local-${seq}`;
  const args = parsed.arguments ?? parsed.args ?? {};
  yield { type: 'tool-use-start', id, name: parsed.name };
  yield { type: 'tool-use-delta', id, partialJson: JSON.stringify(args) };
  yield { type: 'tool-use-stop', id };
}

/**
 * Adapter `call` — same signature as the cloud adapters; `getSecret`/`safeFetch`
 * are accepted and ignored (keyless, on-device). Routes to the offscreen engine
 * and re-yields its stream as ProviderEvents, closing with a synthetic usage +
 * message-stop.
 *
 * @param {Object} args
 * @param {readonly object[]} args.messages
 * @param {string} args.system
 * @param {string} [args.model]
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 * @param {AbortSignal} [args.signal]
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* callLocalWebgpu({ messages, system, model = LOCAL_MODEL_ID, tools, signal }) {
  if (typeof generateLocal !== 'function') {
    yield { type: 'error', error: 'local model is not loaded — download it in Settings → Local model first.' };
    return;
  }
  let outTokens = 0;
  try {
    const tokenStream = (async function* () {
      for await (const tok of generateLocal({ messages, system, tools, model, signal })) {
        outTokens += 1; // ~one streamer chunk ≈ one token (good enough for the cost split)
        yield tok;
      }
    })();
    yield* parseLocalStream(tokenStream);
  } catch (e) {
    // why the cast (not `e instanceof Error`): a DOMException isn't an
    // instanceof Error in browsers but does carry `.message`, and WebGPU
    // rejects with DOMExceptions — so keep the original `e?.message ?? String(e)`
    // exactly, just typed (the cast is erased at runtime).
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    yield { type: 'error', error: `local inference failed: ${msg}` };
    return;
  }
  // why synthetic usage: on-device generation has no billed token counts, but the
  // eval scorecard's "runner tokens" split needs a number to stay honest about
  // where work went (output tokens only; prefill is local + free).
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: outTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  yield { type: 'message-stop', stopReason: 'end_turn' };
}

/**
 * Adapter descriptor. keyless + zero-cost; `defaultRunnerModel` = the resident
 * model so resolveRunnerModel step 2 (local-when-available) resolves to it with
 * no per-provider key. `available` is flipped by the SW once the engine reports
 * the model resident (it's NOT a static catalog).
 */
export const localWebgpuAdapter = Object.freeze({
  name: 'local-webgpu',
  label: 'Local (WebGPU)',
  endpoint: null,
  defaultModel: LOCAL_MODEL_ID,
  defaultRunnerModel: LOCAL_MODEL_ID,
  vaultSecretName: null,
  keyless: true,
  call: callLocalWebgpu,
  // unified context-window seam: on-device window via the engine (when wired)
  // or the static MODEL_SPECS nominal. Same dispatch as the cloud adapters.
  contextWindow: fetchLocalContextWindow,
});
