// @ts-check
// Provider failover — the pure decision layer for switch-and-continue.
//
// why this exists: the adapters already ride out a transient blip (429/529/
// 500/503 with a capped backoff, connection-drop retry — see anthropic.js /
// connect-timeout.js). But when a provider stays overloaded past those
// retries, or returns a HARD account stop (out of credit / over a spend or
// usage cap — ProviderUsageLimitError), the turn currently just dies. If the
// user has a second provider configured (e.g. OpenRouter as a backup to
// Anthropic), the resilient move is to switch to it and keep going rather
// than fail the whole turn. That's this module.
//
// Two pure pieces, both Bun-tested:
//   - shouldFailover(error): is this failure one a DIFFERENT provider could
//     get past? (Exhausted overload / hard usage limit — yes. A bad request,
//     a user abort, a missing key on the PRIMARY — no.)
//   - planFailoverChain(start, fallbacks): the ordered list of {provider,
//     model} candidates to try, primary first, de-duplicated by provider.
//
// The imperative shell (service-worker.js) wraps the registry's callModel
// with these: it only ever switches BEFORE any model output has streamed
// (a mid-stream switch would replay consumed deltas), so failover composes
// cleanly with the adapter-level retries that run underneath it.

import { ProviderHttpError, ProviderUsageLimitError } from './errors.js';

// HTTP statuses that mean "the provider, not the request, is the problem":
// overload (529), brief unavailability (503), transient server fault (500).
// The adapter already retried these a few times; reaching the failover layer
// means they persisted, so a different provider is the next lever. A 429
// that survived the adapter's backoff is excluded here — it's a per-minute
// throttle that clears on its own, and switching providers to dodge a rate
// limit is the wrong reflex (the next turn rides the refilled bucket).
const FAILOVER_HTTP_STATUSES = new Set([500, 503, 529]);

/**
 * Is this provider error one that switching providers could get past?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export const shouldFailover = (error) => {
  // A hard account limit on the current provider won't clear by waiting; a
  // different provider with its own credit/key is exactly the escape hatch.
  if (error instanceof ProviderUsageLimitError) return true;
  // Persistent overload / server fault after the adapter's own retries.
  if (error instanceof ProviderHttpError) return FAILOVER_HTTP_STATUSES.has(error.status);
  return false;
};

/**
 * @typedef {{ provider: string, model: string }} ProviderModel
 */

/**
 * Build the ordered candidate chain: the active provider/model first, then
 * each configured fallback, skipping any whose provider already appears
 * earlier (you don't fail a provider over to itself). Fallbacks missing a
 * model are dropped — the shell resolves a provider's default model before
 * calling, so a model-less entry here is a bug we'd rather no-op than guess.
 *
 * Pure: values in, a frozen plan out.
 *
 * @param {ProviderModel} start                 the active {provider, model}
 * @param {ReadonlyArray<ProviderModel>} [fallbacks]
 * @returns {ProviderModel[]}                    primary first, never empty
 */
export const planFailoverChain = (start, fallbacks = []) => {
  /** @type {ProviderModel[]} */
  const chain = [];
  const seenProviders = new Set();
  /** @param {ProviderModel | null | undefined} cand */
  const push = (cand) => {
    if (!cand || typeof cand.provider !== 'string' || !cand.provider) return;
    if (typeof cand.model !== 'string' || !cand.model) return;
    if (seenProviders.has(cand.provider)) return;
    seenProviders.add(cand.provider);
    chain.push({ provider: cand.provider, model: cand.model });
  };
  push(start);
  for (const fb of fallbacks) push(fb);
  return chain;
};
