// @ts-check

const EM_DASH = String.fromCodePoint(0x2014);

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

  return async (
    /** @type {{ ownerSessionId?: string, runId?: string, args?: unknown }} */ msg,
    /** @type {unknown} */ sender,
  ) => {
    try {
      if (!isOffscreenSender(sender)) {
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
      if (runSignal?.aborted) return { ok: false, error: 'aborted' };

      // Admission reserves the clamped token request before the call flies, so
      // concurrent fan-out cannot evade the run-wide ceiling.
      scriptRuns.recordProviderCall(runId, call.maxTokens);
      /** @type {any[]} */
      const events = [];
      /** @type {string | undefined} */
      let streamError;
      try {
        contextSnapshots.record({
          provider, model, system: call.system ?? '', messages: call.messages,
          maxTokens: call.maxTokens, sessionId: msg.ownerSessionId, label: 'script:sub-call',
        });
        for await (const event of callModel({
          provider, model, system: call.system ?? '', messages: call.messages,
          maxTokens: call.maxTokens, signal: runSignal ?? undefined,
          getSecret, safeFetch, ollamaHost: settingsStore.get().ollamaHost,
        })) events.push(event);
      } catch (error) {
        streamError = runSignal?.aborted
          ? 'aborted'
          : (/** @type {{ message?: string }} */ (error)?.message ?? String(error));
      }
      const folded = foldProviderEvents(events);
      scriptRuns.settleProviderCall(runId, call.maxTokens, folded.usage?.outputTokens ?? 0);
      const usage = folded.usage
        ? { inputTokens: folded.usage.inputTokens, outputTokens: folded.usage.outputTokens }
        : null;
      if (folded.usage) {
        let cost = 0;
        try { cost = costOf(model, folded.usage, pricingOverrides, { localProvider })?.cost ?? 0; }
        catch { cost = 0; }
        await foldSessionCost(msg.ownerSessionId, folded.usage, cost);
        auditLog.append({
          type: 'provider_sub_call', sessionId: msg.ownerSessionId,
          details: { runId, provider, model, outputTokens: folded.usage.outputTokens, cost },
        }).catch(() => {});
      }
      if (runSignal?.aborted) return { ok: false, error: 'aborted', ...(usage ? { usage } : {}) };
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
