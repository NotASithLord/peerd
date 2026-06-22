// @ts-check
// Shared envelope for the adapters' live context-window lookups.
//
// Anthropic / OpenRouter / Ollama each fetch the model's window from their
// own endpoint, but the IO envelope is identical: fetch (reject → null),
// drain a non-OK body → null, parse JSON → null, run a provider-specific
// `extract`, then guard the result to a positive integer. Centralising it
// here means a fix to that envelope (or the positive-number guard) is one
// edit, not three — only the URL, request init, and `extract` differ per
// provider. `safeFetch` is injected (DI rule); this module never imports
// peerd-egress.

/**
 * A positive finite integer, or null. The single guard all callers share.
 * @param {unknown} w
 * @returns {number | null}
 */
export const asWindow = (w) =>
  typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.floor(w) : null;

/**
 * Fetch a model's context window from a JSON endpoint. Best-effort: every
 * failure path returns null so the caller falls back to the static table.
 * Never throws.
 *
 * @param {Object} args
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {string} args.url
 * @param {RequestInit} [args.init]               method/headers/body (signal merged in)
 * @param {(body: any) => (number | null | undefined)} args.extract  provider-specific field pluck
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const fetchModelWindow = async ({ safeFetch, url, init = {}, extract, signal }) => {
  let res;
  try { res = await safeFetch(url, { ...init, signal }); }
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
