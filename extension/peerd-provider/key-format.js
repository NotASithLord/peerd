// @ts-check
// API-key format sanity - the cheap "looks like a real key" check applied at
// save time so a wrong paste is caught immediately instead of silently
// failing on the first chat.
//
// why a shared module: the options Providers card and the onboarding
// provider step (§5h) apply the SAME rule, and the spec's constraint is that
// the step calls the shipped plumbing rather than forking it. Pure: value in,
// verdict out - the send/save sequencing stays with each surface.

/** @type {Readonly<Record<string, string>>} */
export const KEY_PREFIX = Object.freeze({
  anthropic: 'sk-ant-',
  openrouter: 'sk-or-',
  openai: 'sk-',
});

/**
 * Check a pasted key's shape for one provider. Absence from KEY_PREFIX means
 * no prefix rule (fails open - same posture the options card shipped with).
 *
 * @param {string} provider
 * @param {string|null|undefined} value
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export const checkApiKeyFormat = (provider, value) => {
  const v = (value ?? '').trim();
  if (v.length < 8) return { ok: false, message: 'Paste a complete API key.' };
  const prefix = KEY_PREFIX[provider];
  if (prefix && !v.startsWith(prefix)) {
    return {
      ok: false,
      message: `That doesn't look like this provider's API key - it should start with "${prefix}".`,
    };
  }
  return { ok: true, value: v };
};
