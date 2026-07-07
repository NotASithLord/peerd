#!/usr/bin/env bun
// scripts/cdp/diagnose-actor-spend.mjs — $0 proof that a delegated (web-actor)
// task's spend reaches the eval scorecard's ACTOR bucket.
//
// why this exists: the fetch-suite measurement was blind twice for the same
// class of reason — the actor's activity/cost events never reached the eval
// page (first the async ack-scoring, then turn/actor-cost carrying only USD).
// This probe drives ONE delegated task with a wire-fake model (the fake SSE
// carries usage: prompt 1 / completion 2 per call) and asserts the scorecard's
// runner (ACTOR) tokens are non-zero. No key, no cost, ~30s.
//
// Run: bun scripts/cdp/diagnose-actor-spend.mjs   (exit 0 = proven)

import { launchPeerd, openExtPage, rpc, evalIn, waitFor, log, PASSPHRASE, sseText, sseToolCall } from './e2e-harness.mjs';

let orchDelegated = false;
let actorTurn = 0;
const modelResponder = (_i, request) => {
  const body = (request && request.postData) || '';
  if (body.includes('<actor_agent>')) {
    const t = actorTurn++;
    if (t === 0) return { sse: sseToolCall('navigate', { url: 'https://example.com/' }) };
    return { sse: sseText('The page says it is for use in illustrative examples in documents.') };
  }
  if (!orchDelegated) { orchDelegated = true; return { sse: sseToolCall('message_actor', { to: 'web', message: 'fetch example.com and report what the domain is for' }) }; }
  return { sse: sseText('The domain is for use in illustrative examples in documents.') };
};

const ctx = await launchPeerd({ modelResponder });
try {
  const vault = await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
  if (!vault?.ok) throw new Error(`vault/initialize failed: ${JSON.stringify(vault)}`);
  await rpc(ctx.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });
  await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'ollama' } });

  const evalPage = await openExtPage(ctx, 'eval/runner.html');
  if (!await waitFor(() => evalIn(evalPage, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 })) {
    throw new Error('eval/runner.html never exposed __peerdEval');
  }
  // One delegated task from the fetch suite; the wire fake stands in for the
  // model, so only the DELEGATION MACHINERY (and its cost events) is under test.
  await evalIn(evalPage, `(() => { window.__peerdEval.run({ suite: 'fetch', taskIds: ['fetch-nonarticle-fallback'] }); return true; })()`);
  const card = await waitFor(async () => {
    const err = await evalIn(evalPage, `window.__peerdEval.lastError`);
    if (err) throw new Error(`in-page: ${err}`);
    return evalIn(evalPage, `window.__peerdEval.lastCard`);
  }, { budgetMs: 120_000, pollMs: 2_000 });
  if (!card) throw new Error('no scorecard within budget');

  log(`avgRunnerTokens=${card.avgRunnerTokens}  avgRunnerCostUsd=${card.avgRunnerCostUsd}  passRate=${card.passRate}%`);
  if (!(card.avgRunnerTokens > 0)) {
    log('✗ ACTOR bucket is EMPTY — the actor\'s spend never reached the eval page.');
    ctx.close();
    process.exit(1);
  }
  log('✓ ACTOR spend reaches the scorecard — the fetch-suite measurement can see delegated work.');
  ctx.close();
  process.exit(0);
} catch (e) {
  console.error('[diagnose-actor-spend]', e?.message || e);
  try { ctx.close(); } catch { /* */ }
  process.exit(1);
}
