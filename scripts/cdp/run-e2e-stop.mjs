#!/usr/bin/env bun
// E2E: STOP a turn mid-flight. The model response is held open (a delayed
// fulfill) so the turn is genuinely in flight; the test clicks Stop
// (agent/stop) and asserts the turn aborts to a terminal/idle state without
// ever rendering the model's (late) response. Exercises the real turn-slot
// abort + the agent loop's abort path end to end — the seam the unit tier
// (agent-loop.test.js) covers only with fakes.
//
// Usage:  CHROME_PATH=<chrome-for-testing> bun scripts/cdp/run-e2e-stop.mjs

import { runScenario, unlockAndReady, rpc, evalIn, waitFor, sseText, log } from './e2e-harness.mjs';

const LATE_TEXT = 'this-should-never-render';

// Hold the model response open long enough to Stop mid-turn. The abort tears
// the request down before this resolves; the canned text must never appear.
const modelResponder = () => ({ delayMs: 15_000, sse: sseText(LATE_TEXT) });

await runScenario('stop-mid-turn', async (ctx, checks) => {
  await unlockAndReady(ctx.page);

  const sent = await rpc(ctx.page, { type: 'agent/send', text: 'start a long turn' });
  if (!sent?.ok) throw new Error('agent/send failed: ' + JSON.stringify(sent));
  log('message sent; waiting for the turn to go busy...');

  const busySeen = await waitFor(
    () => evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`),
    { budgetMs: 15_000, pollMs: 100 },
  );
  if (!busySeen) throw new Error('turn never went busy (Stop button never appeared)');
  log('turn busy; sending Stop...');

  const stopped = await rpc(ctx.page, { type: 'agent/stop' });
  if (!stopped?.ok) throw new Error('agent/stop failed: ' + JSON.stringify(stopped));

  let out = {};
  await waitFor(async () => {
    out = (await evalIn(ctx.page, `(() => {
      const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
      const stopChip = !!document.querySelector('.stop-chip');
      return { busy, stopChip, hasLate: document.body.innerText.includes(${JSON.stringify(LATE_TEXT)}) };
    })()`)) || {};
    return !out.busy;
  }, { budgetMs: 15_000 });

  checks.check('turn went busy (Stop button appeared)', !!busySeen);
  checks.check('Stop returns the turn to idle', out.busy === false);
  checks.check('the aborted model response never renders', out.hasLate === false);
  checks.check('the aborted turn shows a "stopped" chip', out.stopChip === true);
}, { modelResponder });
