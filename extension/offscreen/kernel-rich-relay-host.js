// @ts-check

import {
  limitExceeded,
  normalizeTally,
  validateProviderCallArgs,
} from '/peerd-runtime/background.js';
import { hasPricing, listProviders } from '/peerd-provider/background.js';
import {
  parseRuntimeRichAdmitProjection,
  parseRuntimeRichModelValue,
} from '/shared/kernel-runtime-policy.js';

const EM_DASH = String.fromCodePoint(0x2014);
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const message = (/** @type {unknown} */ value, /** @type {string} */ route) => {
  const input = record(value);
  if (!input || (input.type !== undefined && input.type !== route)) return null;
  const allowed = route === 'script/model-call'
    ? new Set(['type', 'ownerSessionId', 'runId', 'args', 'deadlineAt'])
    : new Set(['type', 'ownerSessionId', 'runId']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  if (route === 'script/model-call' && input.deadlineAt !== undefined
      && !Number.isSafeInteger(input.deadlineAt)) return null;
  return input;
};
const complete = (/** @type {unknown} */ value) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failed = (/** @type {any} */ result) => Object.freeze({
  ok: false,
  code: typeof result?.code === 'string' ? result.code : 'runtime-rich-effect-failed',
  error: typeof result?.error === 'string' ? result.error : 'Operation outcome could not be confirmed.',
  outcomeKnown: result?.outcomeKnown === true,
  phase: 'run',
});

/** @param {unknown} input @param {{effects:any}} context */
export const dispatchKernelRichRelay = async (input, context) => {
  const request = record(input);
  const route = request?.route;
  if ((route !== 'script/model-call' && route !== 'script-run/abort')
      || !context?.effects?.signal || context.effects.signal.aborted
      || typeof context.effects.call !== 'function') {
    return { ok: false, code: 'runtime-rich-relay-invalid', outcomeKnown: true };
  }
  const body = message(request?.message, route);
  if (!body || typeof body.ownerSessionId !== 'string' || !body.ownerSessionId
      || typeof body.runId !== 'string' || !body.runId) {
    return complete({ ok: false, error: route === 'script/model-call'
      ? 'provider: unknown or finished run'
      : 'script_run_abort_unknown_finished_or_foreign_run' });
  }
  if (route === 'script-run/abort') {
    const result = await context.effects.call('rich.script.abort', {
      ownerSessionId: body.ownerSessionId, runId: body.runId,
    });
    return result?.ok === true && result.outcomeKnown === true
      ? complete({ ok: true }) : failed(result);
  }
  let call;
  try { call = validateProviderCallArgs(body.args); }
  catch (cause) {
    return complete({
      ok: false,
      error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
    });
  }
  const admitted = await context.effects.call('rich.script.admit', {
    ownerSessionId: body.ownerSessionId,
    runId: body.runId,
    maxTokens: call.maxTokens,
    requestedModel: call.model ?? null,
  });
  if (admitted?.ok !== true || admitted.outcomeKnown !== true) return failed(admitted);
  const projection = parseRuntimeRichAdmitProjection(admitted.value);
  if (!projection) return failed({ code: 'runtime-rich-admission-invalid', outcomeKnown: false });
  if (limitExceeded(
    normalizeTally(projection.owner.cost).cost,
    projection.settings.spendLimitUsd,
  )) {
    return complete({
      ok: false,
      error: `provider quota exceeded: the session spend limit ($${projection.settings.spendLimitUsd}) is reached`,
    });
  }
  const provider = projection.owner.provider;
  const providerEntry = listProviders().find((entry) => entry.name === provider);
  if (!providerEntry) {
    return complete({ ok: false, error: `provider: session provider not registered: ${provider}` });
  }
  const localProvider = providerEntry.keyless === true;
  const model = call.model || projection.owner.model;
  if (call.model && call.model !== projection.owner.model
      && !localProvider && !hasPricing(call.model, projection.settings.pricingOverrides)) {
    return complete({
      ok: false,
      error: `provider.call: unknown model '${call.model}' ${EM_DASH} use the session's model, or an id with a rate card (Settings → pricing overrides)`,
    });
  }
  const result = await context.effects.call('rich.model.call', {
    token: projection.token,
    ownerSessionId: body.ownerSessionId,
    runId: body.runId,
    provider,
    model,
    system: call.system ?? '',
    messages: call.messages,
    maxTokens: call.maxTokens,
    ollamaHost: projection.settings.ollamaHost,
    pricingOverrides: projection.settings.pricingOverrides,
    localProvider,
  });
  if (result?.ok !== true || result.outcomeKnown !== true) return failed(result);
  const value = parseRuntimeRichModelValue(result.value);
  if (!value) return failed({ code: 'runtime-rich-model-result-invalid', outcomeKnown: false });
  if (context.effects.signal.aborted) {
    return complete({
      ok: false, error: 'aborted', ...(value.usage ? { usage: value.usage } : {}),
    });
  }
  if (value.error !== undefined) {
    return complete({
      ok: false, error: value.error, ...(value.usage ? { usage: value.usage } : {}),
    });
  }
  return complete({
    ok: true,
    value: {
      text: value.text,
      model,
      ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
      ...(value.usage ? { usage: value.usage } : {}),
    },
  });
};
