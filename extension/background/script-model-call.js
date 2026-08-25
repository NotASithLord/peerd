// @ts-check

const EM_DASH = String.fromCodePoint(0x2014);

const modelEffectValue = (/** @type {unknown} */ value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = /** @type {Record<string,any>} */ (value);
  const allowed = new Set(['text', 'stopReason', 'usage', 'cost']);
  if (Object.keys(result).some((key) => !allowed.has(key))
      || typeof result.text !== 'string'
      || (result.stopReason !== undefined && typeof result.stopReason !== 'string')
      || !Number.isFinite(result.cost) || result.cost < 0) return null;
  let usage = null;
  if (result.usage !== null && result.usage !== undefined) {
    if (typeof result.usage !== 'object' || Array.isArray(result.usage)
        || Object.keys(result.usage).some((key) => !['inputTokens', 'outputTokens'].includes(key))
        || !Number.isFinite(result.usage.inputTokens) || result.usage.inputTokens < 0
        || !Number.isFinite(result.usage.outputTokens) || result.usage.outputTokens < 0) return null;
    usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
  return {
    text: result.text,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    usage,
    cost: result.cost,
  };
};

/**
 * Build the key-bearing provider sub-call relay used by a provider-enabled
 * sealed script run. Every dependency is injected so the custody and accounting
 * order can be characterized without loading the service worker.
 *
 * @param {any} deps
 */
export const makeScriptModelCallRoute = (deps) => {
  const {
    isOffscreenSender, sessions, scriptRuns, validateProviderCallArgs,
    providerQuotaError, settingsStore, limitExceeded, normalizeTally,
    listProviders, hasPricing, contextSnapshots, callModel, getSecret,
    safeFetch, foldProviderEvents, costOf, foldSessionCost, auditLog,
  } = deps;
  const dispatchEffectsRequired = deps.dispatchEffectsRequired === true;

  return async (
    /** @type {{ ownerSessionId?: string, runId?: string, args?: unknown }} */ msg,
    /** @type {any} */ context,
  ) => {
    try {
      const effects = dispatchEffectsRequired ? context?.effects : null;
      if (dispatchEffectsRequired && (typeof effects?.call !== 'function'
          || !effects.signal || effects.signal.aborted
          || !Number.isFinite(effects.deadlineAt) || effects.deadlineAt <= Date.now())) {
        return { ok: false, error: 'provider: dispatch effects unavailable' };
      }
      if (!dispatchEffectsRequired && !isOffscreenSender(context)) {
        return { ok: false, error: 'provider: unauthorized relay' };
      }
      const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
      // Only an orchestrator chat owns the paid sub-call surface. A leaked job
      // parameter from a fenced actor must not buy access to the user's key.
      if (!owner || owner.kind === 'actor' || owner.kind === 'spawned') {
        return { ok: false, error: 'provider: only a chat session holds the sub-call surface' };
      }
      const runId = typeof msg.runId === 'string' ? msg.runId : '';
      if (!runId
        || scriptRuns.ownerFor(runId) !== msg.ownerSessionId
        || scriptRuns.allows(runId, 'provider') !== true) {
        return { ok: false, error: 'provider: unknown or finished run' };
      }
      let call;
      try { call = validateProviderCallArgs(msg.args); }
      catch (error) {
        return { ok: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
      }
      const quotaRefusal = providerQuotaError(scriptRuns.providerUsageFor(runId));
      if (quotaRefusal) return { ok: false, error: quotaRefusal.message };

      const spendLimit = settingsStore.get().spendLimitUsd;
      if (limitExceeded(normalizeTally(owner.cost).cost, spendLimit)) {
        return { ok: false, error: `provider quota exceeded: the session spend limit ($${spendLimit}) is reached` };
      }
      const provider = owner.provider;
      const providerEntry = listProviders().find((/** @type {any} */ entry) => entry.name === provider);
      if (!providerEntry) {
        return { ok: false, error: `provider: session provider not registered: ${provider}` };
      }
      const localProvider = !!providerEntry.keyless;
      const pricingOverrides = settingsStore.get().pricingOverrides;
      const model = call.model || owner.model;
      if (call.model && call.model !== owner.model
          && !localProvider && !hasPricing(call.model, pricingOverrides)) {
        return { ok: false, error: `provider.call: unknown model '${call.model}' ${EM_DASH} use the session's model, or an id with a rate card (Settings → pricing overrides)` };
      }
      const runSignal = scriptRuns.signalFor(runId);
      if (runSignal?.aborted || effects?.signal.aborted) return { ok: false, error: 'aborted' };

      // Admission reserves the clamped token request before the call flies, so
      // concurrent fan-out cannot evade the run-wide ceiling.
      scriptRuns.recordProviderCall(runId, call.maxTokens);
      /** @type {any} */
      let folded;
      let effectCost = null;
      /** @type {string | undefined} */
      let streamError;
      try {
        contextSnapshots.record({
          provider, model, system: call.system ?? '', messages: call.messages,
          maxTokens: call.maxTokens, sessionId: msg.ownerSessionId, label: 'script:sub-call',
        });
        if (effects) {
          const response = await effects.call('rich.model.call', {
            ownerSessionId: msg.ownerSessionId,
            runId,
            provider,
            model,
            system: call.system ?? '',
            messages: call.messages,
            maxTokens: call.maxTokens,
            ollamaHost: settingsStore.get().ollamaHost ?? '',
            pricingOverrides,
            localProvider,
          });
          if (response?.ok !== true || response.outcomeKnown !== true) {
            streamError = response?.error ?? response?.code ?? 'provider: model call failed';
          } else {
            const value = modelEffectValue(response.value);
            if (!value) streamError = 'provider: invalid model effect result';
            else {
              folded = value;
              effectCost = value.cost;
            }
          }
        } else {
          /** @type {any[]} */
          const events = [];
          for await (const event of callModel({
            provider, model, system: call.system ?? '', messages: call.messages,
            maxTokens: call.maxTokens, signal: runSignal ?? undefined,
            getSecret, safeFetch, ollamaHost: settingsStore.get().ollamaHost,
          })) events.push(event);
          folded = foldProviderEvents(events);
        }
      } catch (error) {
        streamError = runSignal?.aborted || effects?.signal.aborted
          ? 'aborted'
          : (/** @type {{ message?: string }} */ (error)?.message ?? String(error));
      }
      folded ??= {};
      scriptRuns.settleProviderCall(runId, call.maxTokens, folded.usage?.outputTokens ?? 0);
      const usage = folded.usage
        ? { inputTokens: folded.usage.inputTokens, outputTokens: folded.usage.outputTokens }
        : null;
      if (folded.usage) {
        let cost = 0;
        try {
          cost = effectCost ?? costOf(
            model, folded.usage, pricingOverrides, { localProvider },
          )?.cost ?? 0;
        }
        catch { cost = 0; }
        await foldSessionCost(msg.ownerSessionId, folded.usage, cost);
        if (!effects) {
          auditLog.append({
            type: 'provider_sub_call', sessionId: msg.ownerSessionId,
            details: { runId, provider, model, outputTokens: folded.usage.outputTokens, cost },
          }).catch(() => {});
        }
      }
      if (runSignal?.aborted || effects?.signal.aborted) {
        return { ok: false, error: 'aborted', ...(usage ? { usage } : {}) };
      }
      if (streamError) return { ok: false, error: streamError, ...(usage ? { usage } : {}) };
      if (folded.error) return { ok: false, error: folded.error, ...(usage ? { usage } : {}) };
      return {
        ok: true,
        value: {
          text: folded.text, model,
          ...(folded.stopReason !== undefined ? { stopReason: folded.stopReason } : {}),
          ...(usage ? { usage } : {}),
        },
      };
    } catch (error) {
      return { ok: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
    }
  };
};
