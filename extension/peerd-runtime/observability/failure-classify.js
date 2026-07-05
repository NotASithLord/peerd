// @ts-check
// observability/failure-classify.js — the failure-reason classifier.
//
// One pure function that maps the error strings this codebase actually
// produces (named TypedError messages, stable tool-result prefixes,
// provider HTTP shapes, actor-reply failure leads) onto a SMALL stable
// taxonomy. Consumed three ways: the side panel renders the kind as a
// chip on failed cards/turns, the debug bundle annotates every failure,
// and the OTel export stamps it as a span attribute.
//
// why a string classifier and not error-class dispatch: by the time a
// failure is visible anywhere (transcript, audit, bundle) it has been
// serialized to a string — the classes are long gone. The stable
// surface IS the message text, so the taxonomy keys off the prefixes
// and phrases the code deliberately keeps stable.
//
// Pure (values in, values out) — bun-tested.

/**
 * The taxonomy. Small on purpose: a debugging user needs the NEIGHBORHOOD
 * of the failure (whose fault, roughly), not a per-error label — the raw
 * message is always right next to the chip.
 * - policy       — a peerd gate refused it (exposure, sender gate, denylist, egress)
 * - auth         — locked vault / missing or rejected credentials
 * - limits       — spend/usage/rate limits (yours or the provider's)
 * - provider     — the model API failed (HTTP errors, dead streams, unreachable local host)
 * - timeout      — a bounded wait expired
 * - aborted      — Stop / cancellation ended it on purpose
 * - environment  — the world didn't cooperate (page element missing, sandbox/VM trouble)
 * - agent        — the delegated agent ran and reported failure in its own words
 * - internal     — everything else: an unclassified bug
 * @typedef {'policy'|'auth'|'limits'|'provider'|'timeout'|'aborted'|'environment'|'agent'|'internal'} FailureKind
 */

export const FAILURE_KINDS = Object.freeze([
  'policy', 'auth', 'limits', 'provider', 'timeout', 'aborted', 'environment', 'agent', 'internal',
]);

/** @type {Array<{ kind: FailureKind, test: RegExp }>} */
const RULES = [
  // ORDER MATTERS: earlier rows win. Deliberate precedence:
  // aborted beats timeout ("aborted (timeout or cancel)" is a Stop shape),
  // limits beat provider (an HTTP 429 is a limit before it is an HTTP error),
  // auth beats provider (a 401 is a key problem before an API problem).
  { kind: 'aborted', test: /^script_aborted:|stopped before the (actor|run)|aborted \(Stop\)|aborted \(timeout or cancel\)|\bstop was pressed\b/i },
  { kind: 'aborted', test: /^the turn was stopped\b|\bcancelled by the user\b/i },
  { kind: 'policy', test: /^message_actor:|^subagent refused\b|^tool_blocked\b|not on the main agent's surface/i },
  { kind: 'policy', test: /\begress denied\b|\bdenylist\b|\bblocked by (policy|the allowlist|plan mode)\b|EgressDeniedError|NotebookEgressBlocked/i },
  { kind: 'auth', test: /\bvault is locked\b|VaultLockedError|\bunlock the vault\b/i },
  { kind: 'auth', test: /\bAPI key\b.*\b(missing|not set|invalid|rejected)\b|ProviderKeyMissingError|HTTP 40[13]\b/i },
  // why this row sits ABOVE limits: the canned early-EOF string is
  // "provider stream ended early (likely rate limit or network drop)" —
  // the guess in the parenthetical must not reclassify a dead stream.
  { kind: 'provider', test: /\bprovider stream ended early\b/i },
  { kind: 'limits', test: /HTTP 402\b|HTTP 429\b|\busage limit\b|\bspend limit\b|\brate.?limit/i },
  { kind: 'timeout', test: /\btimed? ?out\b|VMRunTimeoutError|\bwall.?clock\b.*\bexceeded\b/i },
  { kind: 'provider', test: /^Provider '.+' HTTP \d+|OllamaNotRunning|\bOllama\b.*\b(not running|unreachable)\b/i },
  { kind: 'environment', test: /^no_option_matching:|\bno element matching\b|\bactor tool relay failed\b/i },
  { kind: 'environment', test: /VM(NotReady|BootFailed|TabClosed|NetworkDenied)|\bthe VM tab (was )?closed\b|\bsandbox\b.*\b(crash|failed to boot)\b|\bworker (crashed|terminated unexpectedly)\b/i },
  { kind: 'agent', test: /\bcould not complete your request\b|\bthe actor turn failed\b|\bREPORTED FAILURE\b|\bproduced no text reply\b/i },
];

/**
 * Classify one failure. Accepts the serialized error text plus optional
 * context that can settle ambiguity without string-sniffing.
 * @param {unknown} error  the error text (or an Error-like with .message)
 * @param {{ stopReason?: string }} [context]
 * @returns {{ kind: FailureKind, label: string }}
 */
export const classifyFailure = (error, context = {}) => {
  // A turn the user stopped is 'aborted' regardless of what text survived.
  if (context.stopReason === 'aborted') return { kind: 'aborted', label: 'aborted' };
  // why the slice: the chip render path classifies raw transcript strings on
  // every redraw; the class is always decided in the first bytes, and a
  // bounded input keeps regex work O(1) even on a megabyte error dump.
  const text = (typeof error === 'string'
    ? error
    : String(/** @type {{ message?: unknown }} */ (error)?.message ?? error ?? '')).slice(0, 4000);
  for (const rule of RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, label: rule.kind };
  }
  return { kind: 'internal', label: 'internal' };
};
