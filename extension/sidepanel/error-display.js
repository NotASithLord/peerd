// @ts-check
// Error display — the PURE mapping of an error code / raw provider message
// to (a) a human-readable line and (b) which Settings section, if any, can
// actually remedy it.
//
// why a standalone module (not inline in chat-view): a component must hold
// no business logic, and this mapping is load-bearing + worth testing on its
// own. Errors reach the UI two ways — the SW's typed codes ("provider-http-
// 429") AND the loop's raw throw text ("Provider 'anthropic' HTTP 429: {…}")
// — so the matcher has to handle both, which is exactly the kind of thing
// that rots silently without a test.

/**
 * Map an error code OR a raw provider message into a clear, human line.
 *
 * @param {unknown} e
 * @returns {string}
 */
export const mapError = (e) => {
  if (typeof e !== 'string' || e.length === 0) return 'Something went wrong.';
  if (e === 'provider-key-missing') return 'No API key yet — add one in Settings.';
  if (e === 'unknown-provider') return 'No provider registered yet.';
  if (e === 'session-not-found') return 'Session was reset mid-turn.';
  if (e === 'spend-limit-reached') return 'Spend limit reached — the agent was halted. Raise the limit in Settings to continue.';

  // Hard account limit (out of credit / over a spend or usage cap). The SW's
  // typed mapping emits `provider-usage-limit[:detail]`; the loop's raw throw
  // is the self-explanatory ProviderUsageLimitError message — both land here.
  if (e.startsWith('provider-usage-limit')) {
    const detail = e.slice('provider-usage-limit'.length).replace(/^[:\s]+/, '').trim();
    const suffix = detail ? ` (${detail})` : '';
    return `Usage/credit limit reached — your provider account is out of credit or over a spend/usage cap. Check your Anthropic / OpenRouter billing & limits, then retry.${suffix}`;
  }

  const s = e.toLowerCase();
  /** @param {...string} needles */
  const has = (...needles) => needles.some((n) => s.includes(n));

  if (e.startsWith('provider-http-401') || has('http 401', 'authentication_error', 'invalid x-api-key')) {
    return 'API key rejected (401). Check or update it in Settings.';
  }
  // Account/credit/quota limits often arrive as 400/403 with a message,
  // not 429 — catch them by content before the generic HTTP fallback.
  if (has('credit balance', 'billing', 'quota', 'insufficient_quota', 'usage limit', 'plan limit')) {
    return 'Provider account limit — out of credit or over a usage cap. Check your Anthropic / OpenRouter billing, then retry.';
  }
  if (e.startsWith('provider-http-429') || has('http 429', 'rate_limit', 'rate limit')) {
    return 'Rate limited (429) — your provider is throttling, or your account hit a usage/credit limit. Wait a moment and retry; if it persists, check your provider account.';
  }
  if (e.startsWith('provider-http-529') || has('http 529', 'overloaded')) {
    return 'Provider overloaded — try again in a moment.';
  }
  if (e.startsWith('provider-http-')) return `Provider returned an error (${e.slice('provider-http-'.length)}).`;
  if (has('http 4', 'http 5')) return `Provider error — ${e}`;
  return e;
};

/**
 * Which Settings section, if any, can actually fix this error.
 *
 * why this gate: the banner used to offer "Open settings" for EVERY error,
 * which misdirects on the most common ones — a 429/529 throttle, a network
 * blip, or an external billing cap aren't fixable in peerd's Settings, so
 * sending the user there is a dead end. Only key/auth/config (→ providers)
 * and the spend limit (→ costs) live in Settings; for everything else the
 * banner shows the guidance copy alone (mapError already says "wait and
 * retry" / "check your provider billing").
 *
 * @param {unknown} e
 * @returns {{ section: string } | null}  null = no in-app remedy
 */
export const errorSettingsTarget = (e) => {
  if (typeof e !== 'string' || e.length === 0) return null;
  if (e === 'provider-key-missing' || e === 'unknown-provider') return { section: 'providers' };
  if (e === 'spend-limit-reached') return { section: 'costs' };
  const s = e.toLowerCase();
  if (e.startsWith('provider-http-401')
      || s.includes('http 401') || s.includes('authentication_error') || s.includes('invalid x-api-key')) {
    return { section: 'providers' };
  }
  // Transient (429/529/overloaded/network), external billing/usage caps, and
  // generic provider errors: no Settings page fixes them.
  return null;
};
