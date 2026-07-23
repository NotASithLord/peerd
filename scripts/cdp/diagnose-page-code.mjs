#!/usr/bin/env bun
// scripts/cdp/diagnose-page-code.mjs — GROUND TRUTH for the code-REPL arm.
//
// The web-actor A/B kept regressing in ways that looked like page_code failing,
// but the scorecard only shows tool NAMES, not the actor's tool RESULTS — so we
// were diagnosing by inference. This drives ONE page_code call end to end via
// the wire fake (no real model, no API cost) and prints EXACTLY what page.goto +
// page.content returned, by capturing the actor's follow-up model request (which
// carries the page_code tool_result) — the same trick the harvest e2e state uses.
//
// Run: bun scripts/cdp/diagnose-page-code.mjs

import { launchPeerd, rpc, waitFor, log, PASSPHRASE, sseText, sseToolCall } from './e2e-harness.mjs';
import { startWebFixtureServer } from './fixtures/web-suite.mjs';

// Pull the tool_result content(s) out of an OpenAI-format request body.
const toolResultsIn = (postData) => {
  try {
    const body = JSON.parse(postData);
    const out = [];
    for (const m of body.messages || []) {
      if (m.role === 'tool') out.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      // Anthropic-ish user tool_result blocks, just in case:
      if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
    }
    return out;
  } catch { return []; }
};

main();

async function main() {
  const fixture = await startWebFixtureServer();
  log(`fixture → ${fixture.url}`);

  let actorTurns = 0;
  const captured = [];       // page_code tool_result texts seen in actor requests
  let scriptSent = false;

  const modelResponder = (callIndex, request) => {
    const body = (request && request.postData) || '';
    const isActor = body.includes('<actor_agent>');
    if (isActor) {
      actorTurns++;
      // Any tool_results already in this actor request = results of prior page_code.
      for (const r of toolResultsIn(body)) captured.push(r);
      if (!scriptSent) {
        scriptSent = true;
        // The one page_code we want ground truth on: open the fixture + read it.
        const code = `await page.goto(${JSON.stringify(fixture.url + '/products')}); const s = await page.snapshot(); const c = await page.content(); return { snapshot: String(s).slice(0, 120), content: String(c).slice(0, 120) };`;
        return { sse: sseToolCall('page_code', { code }) };
      }
      // Second actor turn: it now holds the page_code result → wrap up.
      return { sse: sseText('actor: reported the page_code result.') };
    }
    // Orchestrator: delegate once to the code-surface web actor, then finish.
    if (!body.includes('you messaged has replied') && callIndex === 0) {
      return { sse: sseToolCall('message_actor', { to: 'web', message: `Open ${fixture.url}/products and return the page text via page_code.` }) };
    }
    return { sse: sseText('orchestrator: done.') };
  };

  const ctx = await launchPeerd({ modelResponder });
  try {
    await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
    await rpc(ctx.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });
    await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'ollama', webActorActionSurface: 'code' } });
    log('web actor action surface: code');

    await rpc(ctx.page, { type: 'agent/send', text: 'Read my products page.' });
    // Wait until the actor has run page_code and its result was captured (or a budget).
    const ok = await waitFor(() => captured.length > 0, { budgetMs: 60_000, pollMs: 200 }).catch(() => false);

    log(`\n===== GROUND TRUTH: page_code result (${captured.length} captured, actorTurns=${actorTurns}) =====`);
    captured.forEach((r, i) => log(`\n--- page_code result #${i + 1} ---\n${r}`));
    const result = captured[0] || '';
    // A working page_code returns the fixture's read_page/snapshot content; a
    // broken one returns 'page_code_unavailable' / a ReferenceError / times out.
    const healthy = ok && /Peerdmart|untrusted_web_content/.test(result)
      && !/unavailable|ReferenceError|not defined|no_target_tab|no_owned_tab|timed out/.test(result);
    log(`\n===== VERDICT: ${healthy ? 'page_code WORKS end to end ✓' : 'page_code BROKEN ✗'} =====`);

    await fixture.close().catch(() => {});
    ctx.close();
    process.exit(healthy ? 0 : 1);
  } catch (e) {
    console.error('[diagnose]', e?.message || e);
    await fixture.close().catch(() => {});
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}
