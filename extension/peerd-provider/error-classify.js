// @ts-check
// Pure classification of provider HTTP error bodies.
//
// Distinguishes a HARD account limit (out of credit / over a spend or usage
// cap / a billing stop) from a TRANSIENT throttle (per-minute rate limit,
// brief overload). The cloud adapters use this to decide whether to RETRY
// (transient) or fail FAST and explicitly (hard) — so a usage limit surfaces
// as itself instead of three silent retries followed by a generic, misleading
// "rate limited, try again".
//
// Functional core, no IO, no provider coupling — Bun-tested. (DESIGN: the
// adapters are the imperative shell; the keyword judgment lives here.)

// why: these substrings name an account-side stop that waiting won't clear.
// Deliberately NARROW — 'rate limit' / 'per-minute' / 'overloaded' are
// EXCLUDED so a genuine transient 429 still rides the retry path. Anthropic's
// monthly-spend stop ("…would exceed your monthly spend limit") and
// OpenRouter's insufficient-credits 402 both land here.
const HARD_LIMIT_NEEDLES = Object.freeze([
  'credit balance',
  'out of credit',
  'insufficient credit',
  'insufficient_quota',
  'insufficient funds',
  'billing',
  'payment required',
  'spending limit',
  'spend limit',
  'monthly limit',
  'usage limit',
  'plan limit',
  'quota',
  'budget',
]);

/**
 * Does this non-2xx response represent a HARD account limit (vs a transient
 * throttle worth retrying)? HTTP 402 (Payment Required — OpenRouter's
 * insufficient-credits status) is always hard; otherwise we look for a
 * billing / credit / quota signal in the body text.
 *
 * @param {number} status
 * @param {string} [bodyText]  raw response body (JSON or plain text)
 * @returns {boolean}
 */
export const isUsageLimitResponse = (status, bodyText = '') => {
  if (status === 402) return true;
  const s = String(bodyText ?? '').toLowerCase();
  if (!s) return false;
  return HARD_LIMIT_NEEDLES.some((needle) => s.includes(needle));
};

/**
 * Pull the human-readable message out of a provider error body (Anthropic /
 * OpenAI shape: `{ error: { message } }` or `{ error: string }`), trimmed for
 * display. Falls back to a short slice of the raw text. Returns undefined when
 * there's nothing useful to show.
 *
 * @param {string} [bodyText]
 * @param {number} [maxLen]
 * @returns {string | undefined}
 */
export const apiErrorMessage = (bodyText = '', maxLen = 240) => {
  const raw = String(bodyText ?? '').trim();
  if (!raw) return undefined;
  let msg;
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error;
    msg = typeof err === 'string' ? err
      : typeof err?.message === 'string' ? err.message
        : typeof parsed?.message === 'string' ? parsed.message
          : undefined;
  } catch { /* not JSON — fall through to the raw slice */ }
  const out = String(msg ?? raw).trim();
  if (!out) return undefined;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
};
