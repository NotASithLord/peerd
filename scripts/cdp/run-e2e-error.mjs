#!/usr/bin/env bun
// E2E: a model-side ERROR surfaces visibly on the failed turn and leaves it
// idle (not stuck "thinking"). The intercepted model call is fulfilled with an
// HTTP 400 + an OpenAI-style error body; the real adapter maps it, the agent
// loop yields an error, and the failed assistant turn renders an inline
// .error-line ("Provider 'ollama' HTTP 400: …"). Exercises the provider-error
// → reducer → transcript path end to end (the load-bearing honesty guarantee:
// a failed turn never silently disappears or hangs).
//
// 400 (not 500) on purpose: it is non-retryable, so the failure is immediate
// and the test doesn't wait out the adapter's retry/backoff schedule.
//
// Usage:  CHROME_PATH=<chrome-for-testing> bun scripts/cdp/run-e2e-error.mjs

import { runScenario, unlockAndReady, rpc, evalIn, waitFor, log } from './e2e-harness.mjs';

const ERR_BODY = JSON.stringify({ error: { message: 'e2e injected provider error', type: 'invalid_request_error' } });

const modelResponder = () => ({ status: 400, contentType: 'application/json', body: ERR_BODY });

await runScenario('model-error', async (ctx, checks) => {
  await unlockAndReady(ctx.page);

  const sent = await rpc(ctx.page, { type: 'agent/send', text: 'trigger an error' });
  if (!sent?.ok) throw new Error('agent/send failed: ' + JSON.stringify(sent));
  log('message sent; awaiting the error banner...');

  let out = {};
  await waitFor(async () => {
    out = (await evalIn(ctx.page, `(() => {
      const line = document.querySelector('.error-line');
      const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
      return { hasError: !!line, errorText: line ? line.textContent.trim() : null, busy };
    })()`)) || {};
    return out.hasError && !out.busy; // error surfaced and the turn came to rest
  }, { budgetMs: 25_000 });

  checks.check('model call intercepted (no real network egress)', ctx.modelCallCount() > 0);
  checks.check('a provider error surfaces on the turn (inline error-line)', out.hasError === true, JSON.stringify(out.errorText));
  checks.check('the error names the HTTP failure honestly', !!out.errorText && /HTTP 400/.test(out.errorText));
  checks.check('the failed turn comes to rest (not stuck busy)', out.busy === false);
}, { modelResponder });
