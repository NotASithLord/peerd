// @ts-check
// peerd-provider errors.
//
// Module-local errors inherit from the shared TypedError base so
// `.name` survives structured-clone across the SW/port boundary.

import { TypedError } from '/shared/errors.js';

/** Generic provider failure (non-2xx, malformed body, parse error). */
export class ProviderError extends TypedError {
  /**
   * @param {string} provider
   * @param {string} message
   */
  constructor(provider, message) {
    super(`Provider '${provider}': ${message}`);
    this.provider = provider;
  }
}

/**
 * Provider was asked to run but no API key is in the vault. UI surfaces
 * a "set your API key" prompt when this fires.
 */
export class ProviderKeyMissingError extends TypedError {
  /** @param {string} provider */
  constructor(provider) {
    super(`Provider '${provider}' has no API key in vault.`);
    this.provider = provider;
  }
}

/**
 * Provider returned a non-2xx HTTP response. Body is captured (trimmed)
 * so the UI can show the real failure mode without a separate fetch.
 */
export class ProviderHttpError extends TypedError {
  /**
   * @param {string} provider
   * @param {number} status
   * @param {string} bodyExcerpt
   */
  constructor(provider, status, bodyExcerpt) {
    super(`Provider '${provider}' HTTP ${status}: ${bodyExcerpt}`);
    this.provider = provider;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/**
 * A HARD account-side limit: out of credit, over a spend / usage cap, or a
 * billing / quota stop (HTTP 402, or a 4xx/429 whose body names a credit /
 * billing / quota / spend condition — see error-classify.js). DISTINCT from a
 * transient per-minute rate limit (429 `rate_limit_error`, retryable): a usage
 * limit will NOT clear by waiting a few seconds, so the adapters throw this
 * immediately instead of burning the retry budget and then mislabeling the
 * failure as "throttling, try again". The message is self-explanatory so the
 * chat names the real cause even before the UI's mapError touches it.
 */
export class ProviderUsageLimitError extends TypedError {
  /**
   * @param {string} provider
   * @param {{ status?: number, detail?: string }} [opts]
   */
  constructor(provider, { status, detail } = {}) {
    const label = typeof provider === 'string' && provider.length
      ? provider[0].toUpperCase() + provider.slice(1)
      : 'Provider';
    const suffix = detail ? ` (${detail})` : '';
    super(`${label} usage limit reached — your account is out of credit or over a spend/usage cap. Check your ${label} account billing & limits, then try again.${suffix}`);
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

/** Provider name not registered in the registry. */
export class UnknownProviderError extends TypedError {
  /** @param {string} provider */
  constructor(provider) {
    super(`Unknown provider '${provider}' — register it first.`);
    this.provider = provider;
  }
}

/**
 * The local Ollama daemon refused the connection. A raw "Failed to
 * fetch" here would read like a peerd bug; the actual fix is one shell
 * command away, so the message says exactly that. The message is set
 * AFTER super() so the UI shows the friendly line verbatim, without the
 * generic "Provider 'ollama':" prefix.
 */
export class OllamaNotRunningError extends ProviderError {
  constructor() {
    super('ollama', 'daemon unreachable');
    this.message = 'Ollama isn’t running — start it with `ollama serve` (or open the Ollama app), then try again.';
  }
}
