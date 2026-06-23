// @ts-check
// background/routes/providers.js — provider key + model routes.
//
// The 5 routes here close over no reassigned module state (session/setModel
// and the local-model/* routes, which mutate activeSession / localModelAvailable,
// stay inline in the SW). Bodies are byte-identical to the originals; deps
// injected; imports none. See routes/vault.js for the pattern and
// tests/meta/sw-routes-wiring.test.ts for the wiring guarantee.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeProviderRoutes = (deps) => {
  const {
    vault, auditLog, pushState,
    listProviders, listProviderModels, listOpenRouterModels, OPENROUTER_POPULAR,
    callModel, getSecret, safeFetch, secretNameForProvider, maskKey, buildModelOptions,
    ProviderHttpError, ProviderKeyMissingError, VaultLockedError,
  } = deps;

  return {
    // Validate a saved provider key with a minimal 1-token ping on the REAL
    // endpoint, so an onboarding tester learns the key works BEFORE sending a real
    // message (instead of hitting a 401 on the first turn). The adapter's
    // connect-timeout applies, so the test itself can't hang.
    'provider/test': async ({ provider }) => {
      const adapter = listProviders().find((/** @type {any} */ p) => p.name === provider);
      // Keyless local provider (Ollama): "does the daemon answer" is the
      // meaningful test, not a model turn — /api/tags responds instantly
      // and doesn't load a multi-GB model into memory just for a ping.
      if (adapter?.keyless && adapter.liveModels) {
        try {
          const models = await listProviderModels(provider, { safeFetch });
          auditLog.append({ type: 'provider_validated', details: { provider } }).catch(() => {});
          return { ok: true, models: models?.length ?? 0 };
        } catch (e) {
          return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? 'unreachable' };
        }
      }
      // A keyless provider with NO live inventory (local-webgpu) has no daemon to
      // ping — its readiness is "is the model downloaded?", surfaced by its own
      // card (local-model/status), not this 1-token probe. Bail cleanly instead
      // of falling through to the key path and lying with a "no-key" error.
      if (adapter?.keyless) return { ok: false, error: 'no-live-test' };
      let key;
      try { key = await vault.getSecret(secretNameForProvider(provider)); }
      catch { return { ok: false, error: 'locked' }; }
      if (!key) return { ok: false, error: 'no-key' };
      try {
        const gen = callModel({
          provider,
          model: adapter?.defaultModel,
          messages: [{ role: 'user', content: 'hi' }],
          system: '',
          maxTokens: 1,
          getSecret,
          safeFetch,
        });
        // First yielded event (or a clean finish) means the key authenticated.
        // A 401/invalid key THROWS (ProviderHttpError) on first iteration.
        for await (const ev of gen) {
          if (ev?.type === 'error') return { ok: false, error: ev.error ?? 'test-failed' };
          break;
        }
        auditLog.append({ type: 'provider_validated', details: { provider } }).catch(() => {});
        return { ok: true };
      } catch (e) {
        // why cast: the provider error classes arrive via the `any` deps bag,
        // so instanceof can't narrow `e` — read .status/.message off a view.
        const ev = /** @type {{ status?: number, message?: string }} */ (e);
        if (e instanceof ProviderHttpError) return { ok: false, error: ev.status === 401 ? 'invalid-key' : `http-${ev.status}` };
        if (e instanceof ProviderKeyMissingError) return { ok: false, error: 'no-key' };
        return { ok: false, error: ev?.message ?? 'test-failed' };
      }
    },

    'provider/status': async () => {
      const providers = [];
      for (const p of listProviders()) {
        // Keyless (local) providers: no vault lookup — hasKey is true so
        // selectors treat them as usable; `keyless` lets the Settings card
        // render "no key needed" instead of a key form.
        if (p.keyless) {
          providers.push({
            name: p.name, label: p.label, defaultModel: p.defaultModel,
            hasKey: true, keyless: true, keyPreview: null,
            // liveModels marks a daemon the card can probe (Ollama /api/tags) —
            // so the badge can read "connected" only when it actually answers,
            // never default-green.
            liveModels: !!p.liveModels,
          });
          continue;
        }
        let key = null;
        try { key = await vault.getSecret(p.vaultSecretName); }
        catch { key = null; }
        providers.push({
          name: p.name, label: p.label, defaultModel: p.defaultModel,
          hasKey: !!key,
          keyless: false,
          liveModels: !!p.liveModels,
          // Masked preview so the user can verify the RIGHT key is stored and
          // isn't whitespace-padded (a frequent cause of provider 401s),
          // without exposing the secret.
          keyPreview: key ? maskKey(key) : null,
        });
      }
      return { ok: true, providers };
    },

    // Per-chat model options + the selected value. With a sessionId, scoped to
    // that session's provider (model-only mid-session switch); without, the full
    // cross-provider set for a fresh chat. `sessionProvider` is non-null only in
    // the locked (mid-session) case, so the UI knows which write to make.
    'models/options': async ({ sessionId = null } = {}) => {
      const { options, selected, sessionProvider } = await buildModelOptions({ sessionId });
      return { ok: true, options, selected, sessionProvider };
    },

    // OpenRouter live catalog for the Settings model-curation picker. Doubles as
    // the key-verify probe: a 200 with models means the saved key authenticates
    // (a 401/403 throws ProviderHttpError → surfaced as a verify failure). The
    // `popular` seed is the default-shown subset before the user searches.
    'openrouter/models': async () => {
      try {
        const models = await listOpenRouterModels({ safeFetch, getSecret });
        return { ok: true, models, popular: OPENROUTER_POPULAR };
      } catch (e) {
        const ev = /** @type {{ status?: number, message?: string }} */ (e);
        const status = e instanceof ProviderHttpError ? ev.status : null;
        return {
          ok: false,
          status,
          error: status === 401 || status === 403 ? 'invalid-key' : (ev?.message ?? 'unreachable'),
        };
      }
    },

    'provider/setKey': async ({ provider, plaintext }) => {
      try {
        const adapter = listProviders().find((/** @type {any} */ p) => p.name === provider);
        if (!adapter) return { ok: false, error: 'unknown-provider' };
        // Local providers have no key — refuse instead of vaulting a value
        // nothing will ever read.
        if (adapter.keyless) return { ok: false, error: 'keyless-provider' };
        // why: trim server-side too. A pasted key often carries a trailing
        // newline/space; stored verbatim it reaches the provider as a malformed
        // `x-api-key` → a 401 "invalid key" (not a clean "key missing"). Strip
        // ALL surrounding whitespace so any save path (incl. legacy/untrimmed)
        // persists a clean key.
        const key = typeof plaintext === 'string' ? plaintext.trim() : '';
        if (key.length < 8) return { ok: false, error: 'key-too-short' };
        await vault.setSecret(adapter.vaultSecretName, key);
        auditLog.append({ type: 'provider_added', details: { provider } }).catch(() => {});
        // Push fresh state so UI flips its "no key" affordance.
        pushState();
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultLockedError) return { ok: false, error: 'locked' };
        throw e;
      }
    },
  };
};
