#!/usr/bin/env bun
// The E2E "states" — the single source of truth for what the verify loop drives
// and asserts. Each state is data + a run() that interacts with the LIVE side
// panel through one ctx (the harness). The single-Chrome verify runner
// (run-e2e-verify.mjs) executes every state against ONE Chrome — reset the
// session, swap the model responder, run — so a full pass is ~1 launch, not N.
//
// A state:
//   { name, kind: 'functional'|'visual', phase: 'pre-unlock'|'post-unlock',
//     responder, async run(ctx, rec) }
//   - responder: the per-call model behaviour (swapped in before run)
//   - run(ctx, rec): drives the panel and records via the recorder:
//       rec.check(name, pass, detail)   — a functional assertion
//       rec.shot(label)                 — a screenshot artifact (Claude can read)
//       rec.visual(name, opts)          — capture + baseline pixel-compare
//
// The recorder is what makes the loop legible to an agent: every state leaves a
// screenshot to look at and a structured pass/fail with the "why".

import { createServer } from 'node:http';
import { rpc, evalIn, waitFor, sseText, sseToolCall, PASSPHRASE } from './e2e-harness.mjs';

// A compact transcript probe shared by the functional states.
const probe = (ctx) => evalIn(ctx.page, `(() => {
  const u = document.querySelector('.message-user');
  const b = document.querySelector('.message-assistant .bubble');
  const err = document.querySelector('.error-line');
  const goalBar = !!document.querySelector('.goal-bar');
  const stopChip = !!document.querySelector('.stop-chip');
  const busy = !!(document.querySelector('.message-assistant.streaming') || document.querySelector('form.input-bar button.stop'));
  const capped = /hit the .*limit/i.test(document.body.innerText);
  return {
    userText: u ? u.textContent.trim() : null,
    assistantText: b ? b.textContent.trim() : null,
    errorText: err ? err.textContent.trim() : null,
    goalBar, stopChip, busy, capped,
  };
})()`);

const SMOKE_TEXT = 'e2e-smoke-ok';

// The local-first personal-data agent, end to end through the REAL stack: the
// faked model calls js_run, the sealed worker builds an on-device index in OPFS
// and queries it, and the agent reports the answer — every byte computed on
// device (the realm seal makes the worker incapable of egress).
const PDA_SCRIPT = `
const records = [
  { id: 'amazon:o1', date: '2025-02-03', merchant: 'Amazon', amount: 12.5 },
  { id: 'amazon:o2', date: '2025-06-20', merchant: 'Amazon', amount: 7.5 },
  { id: 'amazon:o3', date: '2025-11-03', merchant: 'Amazon', amount: 30 },
];
await peerd.self.writeFile('records/orders.jsonl', records.map((r) => JSON.stringify(r)).join('\\n'));
const text = await peerd.self.readFile('records/orders.jsonl');
const rows = text.split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const total = rows.reduce((a, r) => a + r.amount, 0);
return { total, count: rows.length, source: 'on-device OPFS index' };
`;

// Captures the model's SECOND request body (which carries the js_run tool result
// back to the model) so the state can prove the sealed worker REALLY computed the
// answer — not that the faked final turn merely claims it.
let pdaToolResultBody = '';

// Per-call capture for the actor-delegation probes. The ONE shared responder
// serves BOTH orchestrator and actor model calls, so we record each call's
// system-prompt markers to PROVE the cross-process flow (orchestrator delegate
// -> web-actor sub-loop -> async fenced reply re-entering the orchestrator).
// `delegates` is responder-side because the delegate is in the RESPONSE, not the
// request — and after the ack tool_result the orchestrator loop CONTINUES, so a
// real model delegates once then ends its turn (the ack says the reply lands
// later). We mirror that: delegate once, then return plain text.
let actorState = { delegates: 0, seen: [] };

// --- harvest: the FULL personal-data flow, incl. reading a real page ---------
// An order page served over localhost. The order lines are ANCHOR text so the
// web actor's read_page returns the item names + prices as visible page text.
const ORDERS_HTML = [
  '<!doctype html><html><head><title>My Orders</title></head><body>',
  '<h1>My Orders</h1><ul>',
  '<li><a href="/o/1001">Order #1001 - Coffee Mug - $12.00</a></li>',
  '<li><a href="/o/1002">Order #1002 - Notebook - $8.50</a></li>',
  '<li><a href="/o/1003">Order #1003 - Pen Set - $15.00</a></li>',
  '</ul></body></html>',
].join('\n');

// The append+query the agent runs AFTER reading the page (records shaped from the
// harvested orders; total = 12 + 8.50 + 15 = 35.50).
const HARVEST_SCRIPT = `
const records = [
  { id: 'order:1001', item: 'Coffee Mug', amount: 12 },
  { id: 'order:1002', item: 'Notebook', amount: 8.5 },
  { id: 'order:1003', item: 'Pen Set', amount: 15 },
];
await peerd.self.writeFile('records/orders.jsonl', records.map((r) => JSON.stringify(r)).join('\\n'));
const rows = (await peerd.self.readFile('records/orders.jsonl')).split('\\n').filter(Boolean).map((l) => JSON.parse(l));
return { total: rows.reduce((a, r) => a + r.amount, 0), count: rows.length, source: 'harvested on-device index' };
`;

// harvest sequencing (post-#61 actor flow). The orchestrator delegates the read
// to the WEB ACTOR via message_actor; the web actor OWNS a tab, opens the fixture
// itself (navigate — not under the SSRF guard, which is fetch_url-only) and reads
// it (read_page). We capture the actor request that carries the read_page RESULT
// to PROVE the actor genuinely read the live page, and sequence the actor's
// navigate→read→report turns and the orchestrator's post-reply index→answer turns
// independently (interleaving slots make callIndex fragile).
let harvestActorSawPage = '';
let harvestActorTurn = 0;
let harvestOrchTurn = 0;
let harvestDelegated = false;
let harvestFixtureUrl = '';

export const STATES = [
  // --- visual: the pre-unlock setup screen (must capture BEFORE unlock) -------
  {
    name: 'initial-screen', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) { await rec.visual('initial-screen'); },
  },

  // --- functional: one full happy-path turn ----------------------------------
  {
    name: 'smoke', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText(SMOKE_TEXT) }),
    async run(ctx, rec) {
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'ping from e2e' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return out.assistantText && !out.busy; }, { budgetMs: 25_000 });
      rec.check('model call intercepted (no real egress)', ctx.modelCallCount() > 0);
      rec.check('user message round-trips', !!out.userText && out.userText.includes('ping from e2e'), JSON.stringify(out.userText));
      rec.check('assistant turn renders the streamed text', out.assistantText === SMOKE_TEXT, JSON.stringify(out.assistantText));
      rec.check('turn reaches a terminal/idle state', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- visual: idle unlocked panel -------------------------------------------
  {
    name: 'idle-unlocked', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) { await rec.visual('idle-unlocked'); },
  },

  // --- functional: the goal-mode autonomous loop -----------------------------
  {
    name: 'goal', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => {
      if (callIndex === 0) return { delayMs: 250, sse: sseText('On it — starting the goal.') };
      if (callIndex === 1) return { delayMs: 250, sse: sseToolCall('complete_goal', { summary: 'all tidy' }) };
      return { delayMs: 120, sse: sseText('Goal complete.') };
    },
    async run(ctx, rec) {
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'tidy the repo', goal: true });
      rec.check('goal run started', sent?.ok && sent.handled === 'goal', JSON.stringify(sent));
      const goalBarSeen = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.goal-bar')`), { budgetMs: 10_000, pollMs: 50 });
      // Snapshot WHILE the bar is up (best-effort — the loop is quick).
      if (goalBarSeen) await rec.shot('goal-bar');
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return !out.goalBar && !out.busy; }, { budgetMs: 25_000 });
      const calls = ctx.modelCallCount();
      rec.check('Goal bar appeared while driving', !!goalBarSeen);
      rec.check('loop drove >1 autonomous turn', calls >= 3, `model calls: ${calls}`);
      rec.check('complete_goal ended it cleanly (not the cap)', !out.capped && calls < 10, `capped=${out.capped} calls=${calls}`);
      rec.check('run reaches terminal: Goal bar cleared + idle', out.goalBar === false && out.busy === false);
      rec.check('submitted goal text round-trips as the first user message', !!out.userText && out.userText.includes('tidy the repo'), JSON.stringify(out.userText));
      await rec.shot('final');
    },
  },

  // --- functional: the local-first personal-data agent (code-mode over OPFS) --
  {
    name: 'personal-data', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      if (callIndex === 0) return { sse: sseToolCall('js_run', { code: PDA_SCRIPT }) };
      // call 1 carries the js_run tool result back — capture it for the assertion.
      if (callIndex === 1) pdaToolResultBody = (request && request.postData) || '';
      return { sse: sseText('You spent $50.00 across 3 orders — computed on-device, nothing left your machine.') };
    },
    async run(ctx, rec) {
      pdaToolResultBody = '';
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Index my orders and tell me what I spent.' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return out.assistantText && !out.busy; }, { budgetMs: 30_000 });
      const calls = ctx.modelCallCount();
      rec.check('the agent ran the js_run tool loop (>=2 model calls)', calls >= 2, `model calls: ${calls}`);
      // the load-bearing proof: the sealed worker actually built + queried the
      // OPFS index — the computed total/count only exist in the worker's result
      // JSON, not in PDA_SCRIPT's source text or the code argument echoed back.
      // why parse, not substring-match the raw body: pdaToolResultBody is the
      // raw request postData, where the js_run result is a JSON string NESTED in
      // the request JSON — so its quotes are escaped (\"total\":50) and a raw
      // `"total":50` check never matches (this is why the check was red). Parse
      // the request, pull the tool-result message content (now unescaped), and
      // assert the computed values live THERE — the load-bearing proof the
      // sealed worker built + queried the OPFS index (total/count exist only in
      // its result, not in PDA_SCRIPT's source or the echoed code arg).
      let pdaResult = '';
      try {
        const reqBody = JSON.parse(pdaToolResultBody);
        pdaResult = (reqBody.messages || [])
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .find((c) => c.includes('on-device OPFS index')) || '';
      } catch { /* leave '' — the check fails with a clear detail */ }
      rec.check('js_run REALLY computed on-device (computed total in tool result, not script source)',
        /"total"\s*:\s*50\b/.test(pdaResult) && /"count"\s*:\s*3\b/.test(pdaResult),
        `js_run tool result: ${pdaResult.slice(0, 200)}`);
      rec.check('the on-device answer renders to the user', !!out.assistantText && /50/.test(out.assistantText), JSON.stringify(out.assistantText));
      await rec.shot('final');
    },
  },

  // --- functional: HARVEST — the agent reads a real page, then indexes it ------
  {
    name: 'harvest', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The WEB ACTOR sub-loop (post-#61): the orchestrator delegated the read to
      // it, and it OWNS a tab. Drive it navigate → read_page → report. Capture the
      // request that carries the read_page RESULT (the page's own order text rides
      // back here) as the load-bearing proof it genuinely read the live page.
      if (body.includes('<actor_agent>')) {
        if (body.includes('Coffee Mug')) harvestActorSawPage = body;
        const t = harvestActorTurn++;
        if (t === 0) return { sse: sseToolCall('navigate', { url: harvestFixtureUrl }) };
        if (t === 1) return { sse: sseToolCall('read_page', {}) };
        return { sse: sseText('Order #1001 — Coffee Mug — $12.00; Order #1002 — Notebook — $8.50; Order #1003 — Pen Set — $15.00') };
      }
      // ORCHESTRATOR: delegate the read to the web actor ONCE (it opens + reads the
      // page itself), end the turn (the ack says the reply lands later). When the
      // reply re-enters as a fenced wake, index the orders on-device, then report.
      if (!harvestDelegated) {
        harvestDelegated = true;
        return { sse: sseToolCall('message_actor', { to: 'web', message: `Open ${harvestFixtureUrl} and list every order with its item and price` }) };
      }
      if (!body.includes('you messaged has replied')) {
        return { sse: sseText('Delegated to the web actor; awaiting the page read.') };
      }
      const ot = harvestOrchTurn++;
      if (ot === 0) return { sse: sseToolCall('js_run', { code: HARVEST_SCRIPT }) };
      return { sse: sseText('You spent $35.50 across 3 orders — Coffee Mug, Notebook, Pen Set — harvested from the page and indexed on-device.') };
    },
    async run(ctx, rec) {
      harvestActorSawPage = '';
      harvestActorTurn = 0;
      harvestOrchTurn = 0;
      harvestDelegated = false;
      // Serve the order page over localhost; the WEB ACTOR opens + reads it ITSELF
      // through the real actor-model path. navigate is NOT under the private-network
      // SSRF guard (that's fetch_url-only) and localhost isn't denylisted, so the
      // actor's own tab really loads the fixture — no out-of-band /json/new tab.
      const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ORDERS_HTML); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const fxPort = /** @type {{ port: number }} */ (server.address()).port;
      harvestFixtureUrl = `http://127.0.0.1:${fxPort}/`;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Index my orders from my orders page and tell me what I spent.' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        // Wait until the actor has READ the page (its read_page result captured).
        await waitFor(() => harvestActorSawPage.length > 0, { budgetMs: 30_000, pollMs: 100 });
        // The actor opens its OWN tab, which can background the side panel; bring it
        // back to front so its Mithril view un-throttles and renders the rest of the
        // turn (a backgrounded tab throttles rAF-driven redraws, staling the DOM).
        await ctx.page.send('Page.bringToFront').catch(() => {});
        let out = {};
        await waitFor(async () => {
          out = await evalIn(ctx.page, `(() => {
            const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
            const busy = !!document.querySelector('form.input-bar button.stop');
            return { bubbles, busy };
          })()`) || {};
          // Wait for the FINAL answer specifically: the orchestrator renders an
          // intermediate "delegated; awaiting" bubble and goes idle BEFORE the
          // actor's reply wakes it to index + report, so a generic idle check is
          // too eager and would settle on the intermediate bubble.
          return (out.bubbles || []).some((b) => /35\.50/.test(b)) && !out.busy;
        }, { budgetMs: 40_000 });

        rec.check('the orchestrator delegated the read via message_actor', harvestDelegated === true);
        rec.check('the web-actor sub-loop ran (navigate → read_page, ≥2 actor model calls)', harvestActorTurn >= 2, `actor turns: ${harvestActorTurn}`);
        // load-bearing proof: the web actor REALLY read the live page — the page's
        // own order text rode back into the actor's model request via read_page.
        rec.check('the web actor REALLY read the live page (real order data in its read result)',
          harvestActorSawPage.includes('Coffee Mug') && harvestActorSawPage.includes('12.00'),
          harvestActorSawPage.slice(0, 220));
        rec.check('the harvested on-device answer renders', (out.bubbles || []).some((b) => /35\.50/.test(b)), JSON.stringify(out.bubbles));
        await rec.shot('final');
      } finally {
        server.close();
      }
    },
  },

  // --- functional: Stop a turn mid-flight -------------------------------------
  {
    name: 'stop', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ delayMs: 12_000, sse: sseText('this-should-never-render') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'start a long turn' });
      const busySeen = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`), { budgetMs: 15_000, pollMs: 100 });
      rec.check('turn went busy (Stop button appeared)', !!busySeen);
      if (busySeen) await rec.shot('busy');
      const stopped = await rpc(ctx.page, { type: 'agent/stop' });
      rec.check('agent/stop accepted', !!stopped?.ok);
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return !out.busy; }, { budgetMs: 15_000 });
      rec.check('Stop returns the turn to idle', out.busy === false);
      rec.check('the aborted model response never renders', !(out.assistantText || '').includes('never-render'));
      rec.check('the aborted turn shows a "stopped" chip', out.stopChip === true);
      await rec.shot('final');
    },
  },

  // --- functional: a provider error surfaces + idles --------------------------
  {
    name: 'error', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'e2e injected provider error', type: 'invalid_request_error' } }) }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'trigger an error' });
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return out.errorText && !out.busy; }, { budgetMs: 25_000 });
      rec.check('model call intercepted', ctx.modelCallCount() > 0);
      rec.check('a provider error surfaces inline (error-line)', !!out.errorText, JSON.stringify(out.errorText));
      rec.check('the error names the HTTP failure honestly', /HTTP 400/.test(out.errorText || ''));
      rec.check('the failed turn comes to rest (not stuck busy)', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: a multi-turn conversation (history carries) ---------------
  {
    name: 'multi-turn', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => ({ sse: sseText(callIndex === 0 ? 'first reply' : 'second reply') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'first question' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText === 'first reply' && !o.busy; }, { budgetMs: 20_000 });
      await rpc(ctx.page, { type: 'agent/send', text: 'second question' });
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const users = [...document.querySelectorAll('.message-user')].map((u) => u.textContent.trim());
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { users, bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('second reply') && !out.busy;
      }, { budgetMs: 20_000 });
      rec.check('both user messages persist in the transcript', out.users?.length === 2
        && out.users.some((u) => u.includes('first question')) && out.users.some((u) => u.includes('second question')), JSON.stringify(out.users));
      rec.check('both assistant replies render (history carried across turns)',
        out.bubbles?.includes('first reply') && out.bubbles?.includes('second reply'), JSON.stringify(out.bubbles));
      rec.check('settles idle after the second turn', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: the Plan/Act mode toggle ----------------------------------
  {
    name: 'mode-toggle', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('ack') }),
    async run(ctx, rec) {
      // A session must exist for the mode row to render — send one turn first.
      await rpc(ctx.page, { type: 'agent/send', text: 'hi' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      const activeMode = () => evalIn(ctx.page, `(() => { const b = document.querySelector('.planact-mode[aria-pressed="true"]'); return b ? b.textContent.trim() : null; })()`);
      await rpc(ctx.page, { type: 'permission/set', mode: 'plan' });
      await waitFor(async () => (await activeMode()) === 'Plan', { budgetMs: 8_000 });
      rec.check('Plan becomes the active mode', (await activeMode()) === 'Plan');
      await rec.shot('plan');
      await rpc(ctx.page, { type: 'permission/set', mode: 'act' });
      await waitFor(async () => (await activeMode()) === 'Act', { budgetMs: 8_000 });
      rec.check('toggles back to Act', (await activeMode()) === 'Act');
    },
  },

  // --- functional: vault lock → gate, unlock → ready (restores unlocked) ------
  {
    name: 'vault-lock', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'vault/lock' });
      const locked = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.vault-brand') && !document.querySelector('form.input-bar')`), { budgetMs: 8_000 });
      rec.check('locking flips the panel to the vault gate', !!locked);
      await rec.shot('locked');
      // Unlock again so later states start from a ready, unlocked panel.
      await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE });
      const ready = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar')`), { budgetMs: 10_000 });
      rec.check('unlocking restores the ready composer', !!ready);
    },
  },

  // (A rate-limit/retry-banner state is deferred: the keyless Ollama adapter
  // doesn't retry 429 — only the keyed OpenRouter/Anthropic adapters do — so
  // exercising the retry banner needs a keyed provider wired into the harness.
  // Likewise tool-use rendering is already covered by the goal state's
  // complete_goal card; a distinct safe-tool state is a later add.)

  // --- visual: a completed assistant turn ------------------------------------
  {
    name: 'completed-turn', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText(SMOKE_TEXT) }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'hello there' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await rec.visual('completed-turn');
    },
  },

  // --- functional: the actor-model delegation flow (message_actor end to end) --
  // The headline of #61: the orchestrator delegates a web read to the chat's web
  // actor via message_actor, gets a SYNC ack and ends its turn (async-everything,
  // never blocks), the web-actor sub-loop runs on its own slot and replies, and
  // deliver() re-enters the orchestrator on a LATER synthetic+trusted wake turn
  // carrying the fenced reply. The actor reply is plain text (no fetch_url) so
  // there is ZERO real egress — the whole cross-process path runs under the
  // faked wire. The responder tells orchestrator vs actor turns apart by the
  // actor system-prompt marker (callIndex is fragile — the two slots interleave).
  {
    name: 'actor-delegate', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      const isActor = body.includes('<actor_agent>');
      actorState.seen.push({
        isActor,
        isWebActor: body.includes("You are peerd's web actor"),
        hasReplyLead: body.includes('you messaged has replied'),
        hasFence: body.includes('<untrusted_web_content'),
        hasActorText: body.includes('PRICE_IS_42'),
      });
      // ACTOR sub-loop turn: plain text, no tool call → no fetch_url → no egress.
      if (isActor) return { sse: sseText('PRICE_IS_42') };
      // ORCHESTRATOR — the async wake turn carrying the fenced reply: final answer.
      if (body.includes('you messaged has replied')) return { sse: sseText('FINAL-ORCH-REPLY') };
      // ORCHESTRATOR — delegate ONCE; then the post-ack step ends the turn (the
      // ack tells the model the reply arrives later, so a real model stops here).
      if (actorState.delegates === 0) {
        actorState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'web', message: 'get the price of widget X' }) };
      }
      return { sse: sseText('Delegated to the web actor; awaiting its reply.') };
    },
    async run(ctx, rec) {
      actorState = { delegates: 0, seen: [] };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'find the cheapest widget X' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      const cardSeen = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.message-assistant .tool-call.tool-actor')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('an inline message_actor card mounts under the orchestrator turn', !!cardSeen);
      if (cardSeen) await rec.shot('actor-card');
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const cardOk = !!document.querySelector('.tool-call.tool-actor.tool-ok');
          const name = document.querySelector('.tool-actor .tool-name')?.textContent || '';
          const busy = !!document.querySelector('form.input-bar button.stop');
          const users = [...document.querySelectorAll('.message-user')].map((u) => u.textContent.trim());
          return { bubbles, cardOk, name, busy, users };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-ORCH-REPLY') && !out.busy;
      }, { budgetMs: 30_000 });

      const seen = actorState.seen;
      const actor = seen.filter((s) => s.isActor && s.isWebActor);
      const wake = seen.filter((s) => !s.isActor && s.hasReplyLead && s.hasFence);
      rec.check('the orchestrator delegated via message_actor exactly once', actorState.delegates === 1, `delegates=${actorState.delegates}`);
      rec.check('the web-actor sub-loop ran (actor_agent + web-actor prompt)', actor.length >= 1, `actorCalls=${actor.length}`);
      rec.check('the card header names message_actor', out.name === 'message_actor', JSON.stringify(out.name));
      rec.check('the reply re-entered the orchestrator ASYNC as a fenced wake turn', wake.length >= 1, `wakeCalls=${wake.length}`);
      rec.check('the fenced wake carried the actor reply text (cross-process proof)', wake.some((s) => s.hasActorText));
      rec.check('the actor card flipped pending → ok after the reply landed', out.cardOk === true);
      rec.check('the synthetic wake stays hidden (only the original user bubble shows)',
        (out.users || []).length === 1 && (out.users[0] || '').includes('find the cheapest widget X'), JSON.stringify(out.users));
      rec.check('the orchestrator emitted the final user-visible answer', (out.bubbles || []).includes('FINAL-ORCH-REPLY'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: Stop cascades to an in-flight actor -----------------------
  // The orchestrator delegates and ends its turn; the web actor hangs mid-run.
  // agent/stop must cascade to the in-flight actor (DESIGN-17 Stop-cascade), so
  // the actor card flips to cancelled and the chat returns to idle.
  {
    name: 'actor-stop', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>')) return { delayMs: 20_000, sse: sseText('this-never-renders') };
      if (body.includes('you messaged has replied')) return { sse: sseText('should-not-reach-wake') };
      // delegate once, then end the orchestrator turn (so it doesn't re-delegate
      // on the post-ack step) — leaving exactly one hung actor for Stop to cancel.
      if (actorState.delegates === 0) {
        actorState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'web', message: 'do a slow web read' }) };
      }
      return { sse: sseText('Delegated; awaiting the slow web read.') };
    },
    async run(ctx, rec) {
      actorState = { delegates: 0, seen: [] };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'slowly read the page' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      const pending = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call.tool-actor.tool-pending')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('the actor card is working (pending) before Stop', !!pending);
      if (pending) await rec.shot('actor-working');
      const stopped = await rpc(ctx.page, { type: 'agent/stop' });
      rec.check('agent/stop accepted', !!stopped?.ok, JSON.stringify(stopped));
      const cancelled = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call.tool-actor.tool-cancelled')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('Stop cascades to the in-flight actor — card flips to cancelled', !!cancelled);
      let busy = true;
      await waitFor(async () => { busy = await evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`); return !busy; }, { budgetMs: 12_000 });
      rec.check('Stop returns the chat to idle', busy === false);
      const noLeak = await evalIn(ctx.page, `![...document.querySelectorAll('.message-assistant .bubble')].some((b) => b.textContent.includes('this-never-renders'))`);
      rec.check('the hung actor reply never renders', noLeak === true);
      await rec.shot('final');
    },
  },
];
