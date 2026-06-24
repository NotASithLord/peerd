#!/usr/bin/env bun
// E2E VISUAL regression: capture the live side panel at stable, representative
// states and pixel-compare each against a committed baseline
// (scripts/cdp/baselines/). Catches unintended UI changes the functional
// scenarios can't see — a CSS regression, a layout shift, a colour drift.
//
// Self-contained: CDP Page.captureScreenshot + an npm-free PNG decoder + a
// tolerant pixel diff (visual.mjs). No Playwright, no npm — the same house
// posture as the rest of scripts/cdp/. Animations are frozen before capture so
// each shot is deterministic run-to-run.
//
//   bun scripts/cdp/run-e2e-visual.mjs                    # compare to baselines
//   UPDATE_BASELINES=1 bun scripts/cdp/run-e2e-visual.mjs # (re)write baselines
//
// Regenerate baselines (UPDATE_BASELINES=1) after an INTENTIONAL UI change and
// commit the new PNGs. Note: baselines are environment-specific (headless font
// rendering differs across machines); the per-pixel tolerance + diff threshold
// absorb minor noise, but large environment shifts may need a regenerate.

import { runScenario, unlockAndReady, rpc, evalIn, waitFor, visualCheck, sseText, sleep, log } from './e2e-harness.mjs';

const FAKE_TEXT = 'e2e-smoke-ok';

await runScenario('visual', async (ctx, checks) => {
  // 1) The initial pre-unlock screen (fresh profile → vault setup). The first
  //    thing a new user sees; a stable, animation-frozen baseline.
  await sleep(500);
  await visualCheck(ctx, checks, 'initial-screen');

  // 2) The idle, unlocked, ready panel — empty composer, no turn in flight.
  await unlockAndReady(ctx.page);
  await sleep(500);
  await visualCheck(ctx, checks, 'idle-unlocked');

  // 3) A completed assistant turn (fixed stubbed text, idle).
  const sent = await rpc(ctx.page, { type: 'agent/send', text: 'hello there' });
  if (!sent?.ok) throw new Error('agent/send failed: ' + JSON.stringify(sent));
  await waitFor(
    () => evalIn(ctx.page, `(() => {
      const b = document.querySelector('.message-assistant .bubble');
      const busy = !!document.querySelector('form.input-bar button.stop');
      return !!b && !busy;
    })()`),
    { budgetMs: 20_000 },
  );
  await sleep(400);
  await visualCheck(ctx, checks, 'completed-turn');

  log('visual states captured');
}, { modelResponder: () => ({ sse: sseText(FAKE_TEXT) }) });
