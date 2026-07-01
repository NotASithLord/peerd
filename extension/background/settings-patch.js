// @ts-check
// background/settings-patch.js — the pure normalizer behind the
// `settings/update` route.
//
// why extracted: this was ~120 lines of per-key whitelist → validate →
// clamp → coerce logic living inside the service worker's message handler,
// where it could never be unit-tested (the SW can't be imported by the Bun
// suite, and the in-browser harness doesn't register it). It is pure values-
// in/values-out, so it belongs in the functional core (CLAUDE.md). The SW
// keeps the ONE side effect that isn't persistence — applying the idle
// auto-lock to the live vault — at the call site.
//
// Contract preserved exactly from the original handler: only whitelisted keys
// survive, every leaf is clamped/coerced so a bad value can never persist, and
// an absent/garbage key is simply dropped. The injected normalizers
// (normalizeVariant/normalizeEngine) and the provider/effort/dweb gates are
// passed in so this file imports nothing and stays Bun-importable.

/**
 * Normalize a settings patch into the subset of keys we accept, each
 * validated + clamped. Returns a plain object (possibly empty); the caller
 * decides what to do with an empty result and applies vaultAutoLockMs to the
 * live vault.
 *
 * @param {Record<string, unknown>} patch
 * @param {{
 *   knownProviderNames: string[],
 *   reasoningEffortLevels: readonly string[],
 *   dwebEnabled: boolean,
 *   normalizeVariant: (v: string) => string,
 *   normalizeEngine: (v: string) => string,
 * }} deps
 * @returns {Record<string, unknown>}
 */
export const normalizeSettingsPatch = (patch, {
  knownProviderNames,
  reasoningEffortLevels,
  dwebEnabled,
  normalizeVariant,
  normalizeEngine,
}) => {
  // Whitelist the keys we accept. Anything else is ignored — keeps
  // the surface small and prevents UI bugs from setting arbitrary
  // storage keys.
  /** @type {Record<string, unknown>} */
  const next = {};
  if (typeof patch.voiceEnabled === 'boolean') {
    next.voiceEnabled = patch.voiceEnabled;
  }
  if (typeof patch.voiceVariant === 'string') {
    // One model ships; coerce anything to it so a bad value can never
    // persist (normalizeVariant — the single chokepoint).
    next.voiceVariant = normalizeVariant(patch.voiceVariant);
  }
  if (typeof patch.voiceEngine === 'string') {
    // 'auto' | 'web-speech' | 'moonshine' — coerce unknowns to 'auto'.
    next.voiceEngine = normalizeEngine(patch.voiceEngine);
  }
  // why typeof: Number.isFinite already implies a number (it never coerces),
  // so the guard is behavior-preserving and just narrows the type for tsc.
  if (typeof patch.voiceSilenceMs === 'number' && Number.isFinite(patch.voiceSilenceMs)) {
    // why: clamp to a sensible range; same bounds as voice/settings.js.
    next.voiceSilenceMs = Math.max(250, Math.min(30_000, Math.round(patch.voiceSilenceMs)));
  }
  if (typeof patch.voiceOnboardingDismissed === 'boolean') {
    next.voiceOnboardingDismissed = patch.voiceOnboardingDismissed;
  }
  if (typeof patch.devMode === 'boolean') {
    next.devMode = patch.devMode;
  }
  if (typeof patch.reasoningEnabled === 'boolean') {
    next.reasoningEnabled = patch.reasoningEnabled;
  }
  // Anthropic reasoning effort (output_config.effort). Plain enum
  // setting with a CHANNEL_DEFAULTS value ('medium'); anything else is
  // ignored, same posture as the other whitelisted keys.
  if (typeof patch.reasoningEffort === 'string'
      && reasoningEffortLevels.includes(patch.reasoningEffort)) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (typeof patch.providerName === 'string'
      && knownProviderNames.includes(patch.providerName)) {
    next.providerName = patch.providerName;
  }
  if (typeof patch.providerModel === 'string') {
    // Trim; empty string is valid and means "use the adapter default".
    next.providerModel = patch.providerModel.trim().slice(0, 200);
  }
  if (Array.isArray(patch.openrouterModels)) {
    // Curated OpenRouter model ids available in the chat picker. Normalize:
    // strings only, trimmed, de-duped, capped — a bad value can never bloat
    // storage or smuggle a non-string into the picker.
    const seen = new Set();
    const cleaned = [];
    for (const raw of patch.openrouterModels) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (!id || id.length > 200 || seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
      if (cleaned.length >= 200) break;
    }
    next.openrouterModels = cleaned;
  }
  if (typeof patch.advancedAutomationEnabled === 'boolean') {
    // Whether tool contexts get the CDP pool (the `debugger` permission
    // itself is required at install — Chrome forbids listing it as
    // optional). Takes effect on the next tool dispatch.
    next.advancedAutomationEnabled = patch.advancedAutomationEnabled;
  }
  if (typeof patch.autoMemoryEnabled === 'boolean') {
    // Auto-memory: wrap-up extraction of durable-note suggestions.
    // Default ON; suggestions still require per-note approval, so the
    // off switch is about the background model calls, not writes.
    next.autoMemoryEnabled = patch.autoMemoryEnabled;
  }
  if (typeof patch.confirmWebWrites === 'boolean') {
    // #53: anti-exfil gate. When OFF, non-GET web egress (fetch_url + the WebVM
    // bridge) is auto-approved (risk-acknowledged); ON (default) confirms.
    next.confirmWebWrites = patch.confirmWebWrites;
  }
  if (typeof patch.autoResumeInterruptedTurns === 'boolean') {
    // #72: auto-resume a turn the SW reclaimed mid-flight (only genuine
    // infrastructure interruptions; a user Stop is never resumed).
    next.autoResumeInterruptedTurns = patch.autoResumeInterruptedTurns;
  }
  if (typeof patch.providerFailoverEnabled === 'boolean') {
    // #72: provider failover (switch-and-continue). A no-op until a fallback is
    // listed below, so flipping this alone changes nothing on its own.
    next.providerFailoverEnabled = patch.providerFailoverEnabled;
  }
  if (Array.isArray(patch.providerFallbacks)) {
    // #72: ordered fallback provider NAMES. Keep only registered, de-duped
    // names, capped — a bad value can never name an unknown adapter or bloat
    // storage. (The chain de-dupes the active provider at use time.)
    const valid = new Set(knownProviderNames);
    next.providerFallbacks = [...new Set(patch.providerFallbacks)]
      .filter((n) => typeof n === 'string' && valid.has(n))
      .slice(0, 8);
  }
  if (typeof patch.runnerModel === 'string') {
    // Web actor model override. '' = inherit the chat model. Must be a model
    // id of the SAME provider as the chat (the web actor inherits the owner
    // chat's provider). The settings KEY stays `runnerModel` for continuity
    // with saved settings; resolveRunnerModel reads this pin.
    next.runnerModel = patch.runnerModel.trim().slice(0, 200);
  }
  // Idle vault auto-lock interval (ms). 0 = never; otherwise clamp to a
  // sane range [1min, 24h]. The caller applies this to the live vault so
  // the change takes effect without an SW restart.
  if (patch.vaultAutoLockMs !== undefined) {
    const v = Number(patch.vaultAutoLockMs);
    next.vaultAutoLockMs = (Number.isFinite(v) && v > 0)
      ? Math.min(Math.max(v, 60_000), 24 * 60 * 60 * 1000)
      : 0;
  }
  // Cost telemetry (feature 06). spendLimitUsd: clamp to a sane,
  // non-negative range; 0 disables the hard limit. NaN/garbage → 0.
  if (patch.spendLimitUsd !== undefined) {
    const v = Number(patch.spendLimitUsd);
    next.spendLimitUsd = Number.isFinite(v) && v > 0 ? Math.min(v, 100_000) : 0;
  }
  // pricingOverrides: accept a flat { model: { input, output, cacheRead,
  // cacheWrite } } map. Sanitize every leaf to a finite non-negative
  // number so a bad paste can't NaN the meter or inject non-rate keys.
  if (patch.pricingOverrides && typeof patch.pricingOverrides === 'object') {
    /** @type {Record<string, Record<string, number>>} */
    const clean = {};
    for (const [model, rates] of Object.entries(patch.pricingOverrides)) {
      if (!rates || typeof rates !== 'object') continue;
      /** @type {Record<string, number>} */
      const r = {};
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const n = Number(/** @type {Record<string, unknown>} */ (rates)[k]);
        if (Number.isFinite(n) && n >= 0) r[k] = n;
      }
      if (Object.keys(r).length > 0) clean[String(model).slice(0, 200)] = r;
    }
    next.pricingOverrides = clean;
  }
  // Dweb participation (preview packages only; §12 opt-in). Gated
  // on the build flag IN ADDITION to the key's absence from the store
  // build's CHANNEL_DEFAULTS — two layers, don't rely on one.
  if (dwebEnabled && typeof patch.dwebEnabled === 'boolean') {
    next.dwebEnabled = patch.dwebEnabled;
  }
  // Ollama host (issue #104). Accept ONLY a well-formed http(s) ORIGIN, stored
  // normalized (origin-only — scheme + host + port, no path/query). why strict:
  // this value is added to the egress allowlist and fetched with no key, so a
  // malformed or non-http(s) value must never persist. `new URL(...).origin`
  // both validates and canonicalizes (drops any path, lowercases the host). A
  // garbage/non-string/non-http value drops the key, leaving the prior host.
  if (typeof patch.ollamaHost === 'string') {
    try {
      const u = new URL(patch.ollamaHost.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') next.ollamaHost = u.origin;
    } catch { /* not a valid URL — drop the key */ }
  }
  return next;
};
