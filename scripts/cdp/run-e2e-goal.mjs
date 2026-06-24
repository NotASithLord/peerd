#!/usr/bin/env bun
// E2E: the GOAL-MODE autonomous loop (loop/goal-runner.js), end to end through
// the real side panel. Sends a goal, lets the loop drive MULTIPLE agent turns,
// and has the model call complete_goal to end it — proving the whole chassis
// (SW goal wiring, complete_goal exposure + dispatch, the Goal bar UI, clean
// termination) that the unit tier (goal-runner.test.ts) can only fake.
//
// This is the newest, most autonomous surface and the one hardened in #55/#56,
// so it earns real end-to-end coverage. The model is faked at the wire only:
//   call 0  iteration 1 (the VISIBLE goal)         → plain text, no tool
//   call 1  iteration 2 (a synthetic continuation) → calls complete_goal
//   call 2  the tool-result follow-up              → final text, ends the turn
// Small delays keep the Goal bar observable to the poller. If complete_goal
// never ended the run it would drive to the 40-turn cap — which the checks
// below would catch.
//
// Usage:  CHROME_PATH=<chrome-for-testing> bun scripts/cdp/run-e2e-goal.mjs

import { runScenario, unlockAndReady, rpc, evalIn, waitFor, sseText, sseToolCall, log } from './e2e-harness.mjs';

const GOAL = 'tidy the repo';

const modelResponder = (callIndex) => {
  if (callIndex === 0) return { delayMs: 350, sse: sseText('On it — starting the goal.') };
  if (callIndex === 1) return { delayMs: 350, sse: sseToolCall('complete_goal', { summary: 'all tidy' }) };
  return { delayMs: 150, sse: sseText('Goal complete.') };
};

await runScenario('goal-mode', async (ctx, checks) => {
  await unlockAndReady(ctx.page);

  const sent = await rpc(ctx.page, { type: 'agent/send', text: GOAL, goal: true });
  if (!sent?.ok || sent.handled !== 'goal') throw new Error('goal agent/send failed: ' + JSON.stringify(sent));
  log('goal sent; awaiting the autonomous loop...');

  // The Goal bar must appear while the loop is driving (poll tight + early).
  const goalBarSeen = await waitFor(
    () => evalIn(ctx.page, `!!document.querySelector('.goal-bar')`),
    { budgetMs: 10_000, pollMs: 50 },
  );

  // Then the run must terminate CLEANLY: Goal bar cleared + idle + some output.
  let out = {};
  await waitFor(async () => {
    out = (await evalIn(ctx.page, `(() => {
      const u = document.querySelector('.message-user');
      const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
      const goalBar = !!document.querySelector('.goal-bar');
      const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
      const capped = /hit the .*limit/i.test(document.body.innerText);
      return { userText: u ? u.textContent.trim() : null, bubbles, goalBar, busy, capped };
    })()`)) || {};
    return !out.goalBar && !out.busy && out.bubbles?.length; // ended: bar gone, idle, assistant output present
  }, { budgetMs: 25_000 });

  const calls = ctx.modelCallCount();
  checks.check('goal sent as a visible first user message', !!out.userText && out.userText.includes(GOAL), JSON.stringify(out.userText));
  checks.check('Goal bar appears while the loop drives', !!goalBarSeen);
  checks.check('the loop drove >1 autonomous turn', calls >= 3, `model calls: ${calls}`);
  checks.check('complete_goal ended it cleanly (not the 40-turn cap)', !out.capped && calls < 10, `capped=${out.capped} calls=${calls}`);
  checks.check('run reaches terminal: Goal bar cleared + idle', out.goalBar === false && out.busy === false);
}, { modelResponder });
