// @ts-check
// Shared response envelope for adapters' live context-window lookups.
//
// Anthropic / OpenRouter / Ollama each fetch the model's window from their
// own authority operation, but the response envelope is identical: read
// (reject → null),
// drain a non-OK body → null, parse JSON → null, run a provider-specific
// `extract`, then guard the result to a positive integer. Centralising it
// here means a fix to that envelope (or the positive-number guard) is one
// edit, not three — only the URL, request init, and `extract` differ per
// provider. Destination, authentication, and request shape remain hidden in
// the injected named effect.

/**
 * A positive finite integer, or null. The single guard all callers share.
 * @param {unknown} w
 * @returns {number | null}
 */
export const asWindow = (w) =>
  typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.floor(w) : null;

/**
 * Read a model's context window from a JSON response. Best-effort: every
 * failure path returns null so the caller falls back to the static table.
 * Never throws.
 *
 * @param {Object} args
 * @param {(signal?: AbortSignal) => Promise<Response>} args.readResponse
 * @param {(body: any) => (number | null | undefined)} args.extract  provider-specific field pluck
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const readModelWindow = async ({ readResponse, extract, signal }) => {
  let res;
  try { res = await readResponse(signal); }
  catch { return null; }
  if (!res.ok) {
    try { await res.text(); } catch { /* drain so the socket can be reused */ }
    return null;
  }
  let body;
  try { body = await res.json(); }
  catch { return null; }
  let w;
  try { w = extract(body); }
  catch { return null; }
  return asWindow(w);
};
