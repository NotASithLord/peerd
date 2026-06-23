#!/usr/bin/env bun
// END-TO-END smoke test for peerd: loads the ACTUAL unpacked extension and
// drives the live side panel through one full agent turn. The CDP plumbing,
// model interception, and vault/onboarding/provider setup now live in the
// shared e2e-harness.mjs; this file is just the smoke scenario on top of it
// (the first of several — see run-e2e-goal/stop/error.mjs).
//
// What it proves:
//   load real extension → open side panel → create+unlock vault (passphrase)
//   → select the keyless Ollama provider → send one message → a stubbed
//   assistant turn renders and reaches a terminal (idle) state.
//
// HOW the model is stubbed without a key, a daemon, or any shipped test code:
// the keyless Ollama provider's one network call (POST 11434/v1/chat/completions)
// is intercepted over CDP's Fetch domain and fulfilled with a canned OpenAI SSE
// body. This exercises the REAL adapter + safeFetch + stream parser + agent
// loop — only the wire bytes are faked. Zero test-only code in any shipped file.
//
// Usage:  CHROME_PATH=<chrome-for-testing> bun scripts/cdp/run-e2e-sidepanel.mjs
// Exit:   0 if the smoke turn renders + idles, 1 otherwise.

import { runScenario, unlockAndReady, rpc, evalIn, waitFor, sseText, log } from './e2e-harness.mjs';

const FAKE_TEXT = 'e2e-smoke-ok';

// One probe returns the transcript shape; the harness asserts each facet as a
// named check (the pattern the goal/stop/error scenarios reuse).
const PROBE = `(() => {
  const u = document.querySelector('.message-user');
  const b = document.querySelector('.message-assistant .bubble');
  const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
  return { userText: u ? u.textContent.trim() : null, assistantText: b ? b.textContent.trim() : null, busy };
})()`;

await runScenario('sidepanel-smoke', async (ctx, checks) => {
  await unlockAndReady(ctx.page);

  const sent = await rpc(ctx.page, { type: 'agent/send', text: 'ping from e2e' });
  if (!sent?.ok) throw new Error('agent/send failed: ' + JSON.stringify(sent));
  log('message sent; awaiting assistant turn...');

  let out = {};
  await waitFor(async () => {
    out = (await evalIn(ctx.page, PROBE)) || {};
    return out.assistantText && !out.busy; // terminal: text rendered + not streaming
  }, { budgetMs: 25_000 });

  checks.check('model call intercepted (no real network egress)', ctx.modelCallCount() > 0);
  checks.check('user message round-trips into the transcript', !!out.userText && out.userText.includes('ping from e2e'), JSON.stringify(out.userText));
  checks.check('assistant turn renders the streamed text', out.assistantText === FAKE_TEXT, JSON.stringify(out.assistantText));
  checks.check('turn reaches a terminal/idle state', out.busy === false);
}, { modelResponder: () => ({ sse: sseText(FAKE_TEXT) }) });
