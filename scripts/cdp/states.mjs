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
// faked model calls script, the sealed worker builds an on-device index in OPFS
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

// Captures the model's SECOND request body (which carries the script tool result
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
let scriptFanState = { scripts: 0, seen: [] };
let dwebActorState = { delegates: 0, actorCalls: 0 };
let a2aState = { delegates: 0, actorCalls: 0 };
// heap-split phase 1: the offscreen pure-reasoning subagent state.
let reasoningState = { spawned: 0, childCalls: 0 };
// heap-split phase 4: the offscreen TOOL-BEARING subagent state.
let subagentToolsState = { spawned: 0, childCalls: 0 };
// heap-split phase 4: an offscreen subagent DELEGATING to its own web actor.
let subagentDelegatesState = { spawned: 0, childCalls: 0, webCalls: 0 };
// heap-split phase 4: an offscreen subagent BUILDING an app (create + delegate).
let subagentAppState = { spawned: 0, childCalls: 0, appCalls: 0, appId: null };

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
      if (callIndex === 0) return { sse: sseToolCall('script', { code: PDA_SCRIPT }) };
      // call 1 carries the script tool result back — capture it for the assertion.
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
      rec.check('the agent ran the script tool loop (>=2 model calls)', calls >= 2, `model calls: ${calls}`);
      // the load-bearing proof: the sealed worker actually built + queried the
      // OPFS index — the computed total/count only exist in the worker's result
      // JSON, not in PDA_SCRIPT's source text or the code argument echoed back.
      // why parse, not substring-match the raw body: pdaToolResultBody is the
      // raw request postData, where the script result is a JSON string NESTED in
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
      rec.check('script REALLY computed on-device (computed total in tool result, not script source)',
        /"total"\s*:\s*50\b/.test(pdaResult) && /"count"\s*:\s*3\b/.test(pdaResult),
        `script tool result: ${pdaResult.slice(0, 200)}`);
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
      if (ot === 0) return { sse: sseToolCall('script', { code: HARVEST_SCRIPT }) };
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
      // The failure-class chip: the classified neighborhood renders next to
      // the raw error, and an injected provider HTTP failure classifies as
      // 'provider' (the debug surface's triage contract).
      const chip = await evalIn(ctx.page,
        `document.querySelector('.message-assistant .failure-kind-chip')?.textContent ?? null`);
      rec.check("the failure-class chip renders and reads 'provider'", chip === 'provider', JSON.stringify(chip));
      await rec.shot('final');
    },
  },

  // --- functional: the debug surface (bundle export + context capture) -------
  // Proves the chain the observability PR adds: a real turn is captured into
  // the SW's context-snapshot ring, the session/debugBundle route assembles
  // transcript + audit slice + snapshots + secret-free settings with honest
  // provenance, and the chat's debug flyout renders its export actions.
  {
    name: 'debug-bundle', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('debug-bundle-reply') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'say something for the bundle' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });

      const rows = await rpc(ctx.page, { type: 'session/list' });
      const sessionId = rows?.sessions?.[0]?.sessionId;
      rec.check('session/list yields the live chat', !!sessionId, JSON.stringify(sessionId));

      const reply = await rpc(ctx.page, { type: 'session/debugBundle', sessionId });
      rec.check('session/debugBundle returns ok', reply?.ok === true, JSON.stringify(reply?.error));
      const bundle = reply?.bundle ?? {};
      rec.check('the bundle carries the format stamp + the transcript',
        bundle.format === 'peerd-debug-bundle' && (bundle.session?.messages?.length ?? 0) >= 2,
        `format=${bundle.format} messages=${bundle.session?.messages?.length}`);
      rec.check('the ORCHESTRATOR model call was captured into the context ring (live capture proof)',
        (bundle.contextSnapshots ?? []).some((s) => s.label === 'main'),
        `snapshots=${(bundle.contextSnapshots ?? []).length}`);
      rec.check('the bundle states its provenance (what absence means)',
        typeof bundle.provenance?.contextSnapshots === 'string' && typeof bundle.provenance?.secrets === 'string');
      const settingsJson = JSON.stringify(bundle.settings ?? {});
      rec.check('the settings snapshot is secret-free (no key-shaped fields)',
        !/apiKey|api_key|secret|passphrase/i.test(settingsJson), settingsJson.slice(0, 120));

      // The chat's debug flyout: chip-button opens the two export actions.
      await evalIn(ctx.page, `document.querySelector('.debug-export-btn')?.click()`);
      let menu = {};
      await waitFor(async () => {
        menu = await evalIn(ctx.page, `(() => ({
          open: !!document.querySelector('.debug-menu'),
          items: [...document.querySelectorAll('.debug-menu-item')].map((b) => b.textContent),
        }))()`) || {};
        return menu.open === true;
      }, { budgetMs: 5_000 });
      rec.check('the debug flyout opens with the bundle + OTel export actions',
        menu.open === true && (menu.items || []).length >= 2, JSON.stringify(menu.items));
      await rec.shot('debug-menu-open');

      // devMode adds the context inspector; the modal renders the live
      // snapshot captured above (label 'main'), proving ring → route → view.
      await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
      let inspector = {};
      await waitFor(async () => {
        // why click-in-loop: the 'context inspector' item only renders after
        // the devMode state push lands — a one-shot click can race it.
        inspector = await evalIn(ctx.page, `(() => {
          if (!document.querySelector('.context-inspector')) {
            if (!document.querySelector('.debug-menu')) document.querySelector('.debug-export-btn')?.click();
            [...document.querySelectorAll('.debug-menu-item')]
              .find((b) => b.textContent === 'context inspector')?.click();
          }
          return {
            open: !!document.querySelector('.context-inspector'),
            snaps: [...document.querySelectorAll('.ctx-snap-label')].map((el) => el.textContent),
          };
        })()`) || {};
        return inspector.open === true && (inspector.snaps || []).length > 0;
      }, { budgetMs: 8_000 });
      rec.check("the context inspector opens on the live 'main' snapshot (devMode)",
        inspector.open === true && (inspector.snaps || []).includes('main'), JSON.stringify(inspector.snaps));
      await rec.shot('context-inspector');
      await evalIn(ctx.page, `document.querySelector('.ctx-close')?.click()`);
      await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });
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

  // --- functional: the ORCHESTRATOR delegates from CODE (script + actors.ask) ----
  // The actors-in-script surface end to end: the model writes ONE script whose
  // code awaits actors.ask('web', …); the ask relays offscreen-worker → SW
  // actors/call → messageActor(awaitReply) → a REAL web-actor turn, and the
  // reply resolves back INTO the running script, which returns a value derived
  // from it. Proves: the bridge chain, the [DELEGATIONS] trace + fencing in the
  // tool result, and the live op feed on the script card.
  {
    name: 'script-fanout', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      const isActor = body.includes('<actor_agent>');
      scriptFanState.seen.push({
        isActor,
        isWebActor: body.includes("You are peerd's web actor"),
        // why GOT: (not '[DELEGATIONS]'): the prompt lore itself mentions the
        // trace header now, so every request body contains it — the round-trip
        // VALUE marker (built by the script FROM the actor's reply) is the
        // discriminator that proves the reply entered the script's realm.
        hasScriptResult: body.includes('GOT:WIDGET_PRICE_777'),
      });
      // WEB ACTOR turn (spawned by the script's ask): answer in plain text.
      // why delayMs: the live-feed check below observes the PENDING script
      // card; with an instant actor reply the pending window can close faster
      // than a redraw + 100ms DOM poll on a slow CI runner (flaked in CI on
      // 2026-07-05). Holding the actor's model call open guarantees the feed
      // a real lifetime — the run is slower, never racy.
      if (isActor) return { sse: sseText('WIDGET_PRICE_777'), delayMs: 1500 };
      // ORCHESTRATOR sees the script result (value derived from the reply) →
      // final answer.
      if (body.includes('GOT:WIDGET_PRICE_777')) return { sse: sseText('SCRIPT-FAN-DONE') };
      // ORCHESTRATOR first step: ONE script that asks the web actor and
      // returns a value computed FROM the reply (proves the reply entered
      // the script's realm, not just the chat).
      if (scriptFanState.scripts === 0) {
        scriptFanState.scripts += 1;
        return { sse: sseToolCall('script', {
          code: "const r = await actors.ask('web', 'price of widget X?'); return 'GOT:' + r.reply + ':' + r.failed;",
        }) };
      }
      return { sse: sseText('unexpected extra orchestrator step') };
    },
    async run(ctx, rec) {
      scriptFanState = { scripts: 0, seen: [] };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'script-check the widget price' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      // The live delegation feed appears on the pending script card.
      const opsSeen = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call .script-ops .script-op')`),
        { budgetMs: 20_000, pollMs: 100 });
      rec.check('the live delegation feed renders on the pending script card', !!opsSeen);
      if (opsSeen) await rec.shot('script-ops-live');
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          const results = [...document.querySelectorAll('.tool-call .tool-result')].map((r) => r.textContent || '');
          const cardOk = !!document.querySelector('.tool-call.tool-ok .tool-name') &&
            [...document.querySelectorAll('.tool-call .tool-name')].some((n) => n.textContent === 'script');
          return { bubbles, busy, results, cardOk };
        })()`) || {};
        return (out.bubbles || []).includes('SCRIPT-FAN-DONE') && !out.busy;
      }, { budgetMs: 45_000 });

      const seen = scriptFanState.seen;
      const actorTurns = seen.filter((s) => s.isActor && s.isWebActor);
      const resultTurn = seen.filter((s) => !s.isActor && s.hasScriptResult);
      rec.check('the model called script exactly once', scriptFanState.scripts === 1, `scripts=${scriptFanState.scripts}`);
      rec.check("the script's actors.ask spawned a REAL web-actor turn", actorTurns.length >= 1, `actorTurns=${actorTurns.length}`);
      rec.check("the orchestrator read a result whose value was built FROM the actor's reply", resultTurn.length >= 1, `resultTurns=${resultTurn.length}`);
      rec.check('the final orchestrator answer landed', (out.bubbles || []).includes('SCRIPT-FAN-DONE'));
      rec.check('the script card settled ok', out.cardOk === true);
      await rec.shot('script-fanout-done');
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
          const replies = [...document.querySelectorAll('.message-actor-reply')].map((r) => ({
            role: r.querySelector('.role')?.textContent || '',
            body: r.querySelector('.bubble')?.textContent || '',
          }));
          return { bubbles, cardOk, name, busy, users, replies };
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
      rec.check('the wake never renders as a USER bubble (only the original user message shows)',
        (out.users || []).length === 1 && (out.users[0] || '').includes('find the cheapest widget X'), JSON.stringify(out.users));
      // The trickle-up: the actor reply surfaces at the bottom of the chat as its
      // OWN attributed bubble — fence-stripped body, no trusted-lead duplication.
      const reply = (out.replies || [])[0] || {};
      rec.check('the actor reply surfaces as its OWN attributed bubble', (out.replies || []).length === 1, JSON.stringify(out.replies));
      rec.check('the bubble is attributed to the web actor', (reply.role || '').includes('web actor'), JSON.stringify(reply.role));
      rec.check('the bubble carries the reply text, fence-stripped',
        (reply.body || '').includes('PRICE_IS_42') && !(reply.body || '').includes('<untrusted_web_content'), JSON.stringify((reply.body || '').slice(0, 120)));
      rec.check('the orchestrator emitted the final user-visible answer', (out.bubbles || []).includes('FINAL-ORCH-REPLY'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: the DWEB ACTOR round-trip (opt-in mesh operator) ----------
  // Enable the agent toggle, delegate via message_actor("dweb"), and prove: the
  // handle resolves (opt-in), the actor's turn runs on the tuned mesh-operator
  // prompt in its own heap, and the reply re-enters fenced as an attributed
  // "dweb actor" bubble. The actor answers in TEXT (no tool call) so the state
  // never touches the real mesh — the allow-set/gate are unit-pinned.
  {
    name: 'dweb-actor-delegate', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      const isDweb = body.includes("peerd's mesh operator");
      if (isDweb) { dwebActorState.actorCalls += 1; return { sse: sseText('MESH_OPERATOR_REPLY') }; }
      if (body.includes('you messaged has replied')) return { sse: sseText('DWEB-FINAL') };
      if (dwebActorState.delegates === 0) {
        dwebActorState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'dweb', message: 'who is on the mesh?' }) };
      }
      return { sse: sseText('Delegated to the dweb actor; awaiting its reply.') };
    },
    async run(ctx, rec) {
      dwebActorState = { delegates: 0, actorCalls: 0 };
      const upd = await rpc(ctx.page, { type: 'settings/update', patch: { dwebAgentEnabled: true } });
      rec.check('the dweb agent toggle flips on', !!upd?.ok, JSON.stringify(upd));
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'check the mesh' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const replies = [...document.querySelectorAll('.message-actor-reply')].map((r) => ({
            role: r.querySelector('.role')?.textContent || '',
            body: r.querySelector('.bubble')?.textContent || '',
          }));
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, replies, busy };
        })()`) || {};
        return (out.bubbles || []).includes('DWEB-FINAL') && !out.busy;
      }, { budgetMs: 30_000 });
      rec.check('the dweb actor loop ran on the mesh-operator prompt', dwebActorState.actorCalls >= 1, `actorCalls=${dwebActorState.actorCalls}`);
      const reply = (out.replies || []).find((r) => (r.role || '').includes('dweb actor')) || {};
      rec.check('the reply surfaces as a "dweb actor" bubble', !!reply.role, JSON.stringify(out.replies));
      rec.check('the bubble carries the actor reply, fence-stripped', (reply.body || '').includes('MESH_OPERATOR_REPLY'), JSON.stringify((reply.body || '').slice(0, 80)));
      rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('DWEB-FINAL'));
      await rec.shot('final');
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebAgentEnabled: false } });
    },
  },

  // --- functional: the A2A code surface runs end to end ----------------------
  // The dweb actor answers a "check the mesh" delegation by calling a2a_run with
  // a real script (`await mesh.peers()`). That runs for REAL: sealed keyless
  // worker → the mesh bridge (a2a-request) → the SW a2a/call route → the mesh
  // dispatch → base-host peers → back, fenced, into the actor's heap. No live
  // second peer in one Chrome (roster is empty), so this proves the whole CODE
  // PIPE (the ask/reply correlation itself is unit-proven in a2a-dispatch); the
  // tool_executed audit for a2a_run is the ground truth that the code ran.
  {
    name: 'a2a-code-surface', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      const isDweb = body.includes("peerd's mesh operator");
      if (isDweb) {
        a2aState.actorCalls += 1;
        // First dweb-actor turn: write + run a mesh script. Second (after the
        // fenced tool result re-enters its heap): report.
        if (a2aState.actorCalls === 1) {
          return { sse: sseToolCall('a2a_run', { code: 'const peers = await mesh.peers(); return { count: peers.length, peers };' }) };
        }
        return { sse: sseText('MESH_CHECKED') };
      }
      if (body.includes('you messaged has replied')) return { sse: sseText('A2A-FINAL') };
      if (a2aState.delegates === 0) {
        a2aState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'dweb', message: 'check who is on the mesh' }) };
      }
      return { sse: sseText('Delegated to the dweb actor.') };
    },
    async run(ctx, rec) {
      a2aState = { delegates: 0, actorCalls: 0 };
      const upd = await rpc(ctx.page, { type: 'settings/update', patch: { dwebAgentEnabled: true } });
      rec.check('the dweb agent toggle flips on', !!upd?.ok, JSON.stringify(upd));
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'ask your agent who is on the mesh' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('A2A-FINAL') && !out.busy;
      }, { budgetMs: 40_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 500 });
      const entries = (audit && audit.entries) || [];
      const a2aRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'a2a_run');
      rec.check('the dweb actor wrote + ran a mesh script (2 actor turns)', a2aState.actorCalls >= 2, `actorCalls=${a2aState.actorCalls}`);
      rec.check('a2a_run EXECUTED — the code surface ran through the mesh bridge + SW route (tool_executed audit)', a2aRan === true, `a2aRan=${a2aRan}`);
      rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('A2A-FINAL'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebAgentEnabled: false } });
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

  // --- functional: a pure-reasoning subagent runs in its OWN offscreen heap ---
  // Heap-split phase 1. The orchestrator spawns a sync tools:[] subagent; that
  // child's loop runs in a dedicated offscreen Worker (its own heap, no key),
  // relaying its model call back to the SW. Proof: the child model call happens
  // (its prompt carries the EPHEMERAL ACTOR block), the result round-trips into
  // the orchestrator's final answer, AND the subagent_ran_offscreen audit marker
  // is present (it fired only on the offscreen path, never the in-SW fallback).
  {
    name: 'reasoning-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model call — its system prompt is the ephemeral-actor block.
      // why the IDENTITY line, not just "EPHEMERAL ACTOR": the ORCHESTRATOR prompt
      // also contains "EPHEMERAL ACTOR" (describing spawn_subagent), so the broad
      // match mis-classified the orchestrator's own first call as the child.
      if (body.includes('You are an EPHEMERAL ACTOR')) { reasoningState.childCalls += 1; return { sse: sseText('REASONED-FOURTY-TWO') }; }
      // ORCHESTRATOR — spawn ONE sync pure-reasoning child, then (post tool-result) answer.
      if (reasoningState.spawned === 0) {
        reasoningState.spawned += 1;
        return { sse: sseToolCall('spawn_subagent', { task: 'compute the answer to life', tools: [], sync: true }) };
      }
      return { sse: sseText('FINAL-ANSWER-42') };
    },
    async run(ctx, rec) {
      reasoningState = { spawned: 0, childCalls: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'reason about the answer to life' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-ANSWER-42') && !out.busy;
      }, { budgetMs: 30_000 });

      // The offscreen PROOF: the child ran in its own worker heap (this audit
      // type is appended ONLY on the offscreen path; the in-SW fallback appends
      // subagent_offscreen_fallback instead).
      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 500 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'subagent_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'subagent_offscreen_fallback');
      const subagentTypes = entries.filter((e) => String(e.type).startsWith('subagent')).map((e) => e.type);
      rec.check('the child sub-loop ran (EPHEMERAL ACTOR prompt seen)', reasoningState.childCalls >= 1, `childCalls=${reasoningState.childCalls}`);
      rec.check('the pure-reasoning child ran in its OWN offscreen heap (subagent_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack} bubbles=${JSON.stringify(out.bubbles)} subagentAudits=${JSON.stringify(subagentTypes)}`);
      rec.check('it did NOT silently fall back to the in-SW loop', fellBack === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-ANSWER-42'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: a TOOL-BEARING subagent runs in its OWN offscreen heap ---
  // Heap-split phase 4. The orchestrator spawns a sync subagent GRANTED script;
  // that child's loop runs in a dedicated offscreen Worker (its own heap, no key)
  // and RELAYS its script call back to the SW, which rebuilds the child's restricted
  // ctx from the persisted grantedTools and dispatches script in the offscreen
  // job-runner. Proof: the child looped (two model calls: emit script, then answer),
  // the subagent_ran_offscreen audit fired (offscreen path, not the in-SW fallback),
  // AND a tool_executed audit for script is present (the relayed tool actually ran).
  {
    name: 'subagent-tools-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model calls (ephemeral-actor prompt). First call emits script;
      // second call (after the tool result re-enters its heap) answers.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        subagentToolsState.childCalls += 1;
        if (subagentToolsState.childCalls === 1) return { sse: sseToolCall('script', { code: 'return 6 * 7;' }) };
        return { sse: sseText('CHILD-RAN-JS') };
      }
      // ORCHESTRATOR — spawn ONE sync subagent granted script, then answer.
      if (subagentToolsState.spawned === 0) {
        subagentToolsState.spawned += 1;
        return { sse: sseToolCall('spawn_subagent', { task: 'compute six times seven with script', tools: ['script'], sync: true }) };
      }
      return { sse: sseText('FINAL-WITH-CHILD') };
    },
    async run(ctx, rec) {
      subagentToolsState = { spawned: 0, childCalls: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'use a subagent to compute six times seven' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-WITH-CHILD') && !out.busy;
      }, { budgetMs: 30_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 500 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'subagent_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'subagent_offscreen_fallback');
      const jsRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'script');
      rec.check('the tool-bearing child looped in its heap (script emitted, then answered) — 2 child calls', subagentToolsState.childCalls >= 2, `childCalls=${subagentToolsState.childCalls}`);
      rec.check('the child ran in its OWN offscreen heap (subagent_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack}`);
      rec.check('script actually executed via the SW-gated relay (tool_executed audit)', jsRan === true, `jsRan=${jsRan}`);
      rec.check('it did NOT fall back to the in-SW loop', fellBack === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-WITH-CHILD'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: an offscreen subagent DELEGATES to its own web actor ------
  // Heap-split phase 4, the deepest chain — two isolated heaps stacked. The
  // orchestrator spawns a sync subagent granted message_actor; that subagent's loop
  // runs in its OWN offscreen heap and calls message_actor({to:'web'}) — which relays
  // to the SW, dispatches actorMessaging from the child's restricted ctx, and (because
  // the sender is a subagent) AWAITS the web actor's fenced reply into the child's tool
  // result. The web actor is ITSELF an offscreen heap (phase 3). Proof: the child looped
  // offscreen, a web-actor sub-loop ran, message_actor executed via the relay, and the
  // web reply round-tripped up through the child into the orchestrator's answer. This is
  // the delegation-from-a-heap path the unit tests can only stub.
  {
    name: 'subagent-delegates-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The WEB ACTOR's model call (its own offscreen heap).
      if (body.includes("You are peerd's web actor")) {
        subagentDelegatesState.webCalls += 1;
        return { sse: sseText('WEB-PRICE-99') };
      }
      // The SUBAGENT's model calls (ephemeral-actor prompt). First emits message_actor;
      // second (after the awaited web reply re-enters its heap) answers.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        subagentDelegatesState.childCalls += 1;
        if (subagentDelegatesState.childCalls === 1) return { sse: sseToolCall('message_actor', { to: 'web', message: 'get the price of widget X' }) };
        return { sse: sseText('CHILD-GOT-WEB') };
      }
      // ORCHESTRATOR — spawn ONE sync subagent granted message_actor, then answer.
      if (subagentDelegatesState.spawned === 0) {
        subagentDelegatesState.spawned += 1;
        return { sse: sseToolCall('spawn_subagent', { task: 'ask the web actor for the price and report it', tools: ['message_actor'], sync: true }) };
      }
      return { sse: sseText('FINAL-VIA-SUBAGENT') };
    },
    async run(ctx, rec) {
      subagentDelegatesState = { spawned: 0, childCalls: 0, webCalls: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'use a subagent to ask the web actor for the price' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-VIA-SUBAGENT') && !out.busy;
      }, { budgetMs: 40_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 800 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'subagent_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'subagent_offscreen_fallback');
      const msgActorRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'message_actor');
      rec.check('the subagent looped offscreen (message_actor emitted, then answered) — 2 child calls', subagentDelegatesState.childCalls >= 2, `childCalls=${subagentDelegatesState.childCalls}`);
      rec.check('the subagent ran in its OWN offscreen heap (subagent_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack}`);
      rec.check('the subagent delegated via message_actor from its heap (tool_executed audit)', msgActorRan === true, `msgActorRan=${msgActorRan}`);
      rec.check('a WEB-ACTOR sub-loop ran (its own heap) for the child delegation', subagentDelegatesState.webCalls >= 1, `webCalls=${subagentDelegatesState.webCalls}`);
      rec.check('it did NOT fall back to the in-SW loop', fellBack === false);
      rec.check('the web reply round-tripped up through the subagent into the final answer', (out.bubbles || []).includes('FINAL-VIA-SUBAGENT'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: an offscreen subagent BUILDS an app (create + delegate) ------
  // Heap-split phase 4, the create-then-delegate chain. A subagent is asked to build
  // an app. App-mutating tools (app_write_file) are actor-only, so the correct pattern
  // — for a subagent exactly as for the main agent — is sandbox_create({kind:'app'}), then message_actor
  // the created app's actor to write the files. This proves: the subagent's tool RESULT
  // (the new app id) re-enters its own heap correctly, and it can delegate to a freshly-
  // created instance's actor, which mints, runs offscreen, and writes.
  {
    name: 'subagent-builds-app', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // APP ACTOR (owns the created app; holds app_write_file).
      if (body.includes('client-side App builder') || body.includes('Your App is a multi-file artifact')) {
        subagentAppState.appCalls += 1;
        if (subagentAppState.appCalls === 1) return { sse: sseToolCall('app_write_file', { path: 'index.html', content: '<!DOCTYPE html><body>REAL LAVA LAMP</body>' }) };
        return { sse: sseText('APP-ACTOR-WROTE') };
      }
      // SUBAGENT (ephemeral): create, capture the app id from the result, delegate.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        subagentAppState.childCalls += 1;
        if (subagentAppState.childCalls === 1) return { sse: sseToolCall('sandbox_create', { kind: 'app', name: 'Lava', files: { 'index.html': '<!-- placeholder -->' } }) };
        if (!subagentAppState.appId) { const m = body.match(/app-[a-z0-9]+-[a-z0-9]+/); if (m) subagentAppState.appId = m[0]; }
        if (subagentAppState.childCalls === 2) return { sse: sseToolCall('message_actor', { to: subagentAppState.appId || 'app-unknown', message: 'write the real lava lamp code into index.html' }) };
        return { sse: sseText('CHILD-BUILT-APP') };
      }
      // ORCHESTRATOR — spawn a DEFAULT-toolset subagent (tools omitted) to build.
      if (subagentAppState.spawned === 0) {
        subagentAppState.spawned += 1;
        return { sse: sseToolCall('spawn_subagent', { task: 'build a lava lamp app', sync: true }) };
      }
      return { sse: sseText('FINAL-APP-BUILT') };
    },
    async run(ctx, rec) {
      subagentAppState = { spawned: 0, childCalls: 0, appCalls: 0, appId: null };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'spawn a subagent to build a lava lamp app' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-APP-BUILT') && !out.busy;
      }, { budgetMs: 45_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 1000 });
      const entries = (audit && audit.entries) || [];
      const msgActorRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'message_actor');
      const appWriteRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'app_write_file');
      // the app id came back into the subagent's heap → it could delegate to that exact app
      rec.check("the subagent's sandbox_create result (the new app id) re-entered its heap", typeof subagentAppState.appId === 'string' && subagentAppState.appId.startsWith('app-'), `appId=${subagentAppState.appId}`);
      rec.check('the subagent reached the freshly-created app actor (delegation worked)', msgActorRan === true && subagentAppState.appCalls >= 1, `msgActorRan=${msgActorRan} appActorCalls=${subagentAppState.appCalls}`);
      rec.check('the app actor wrote the real file (app_write_file executed)', appWriteRan === true, `appWriteRan=${appWriteRan}`);
      rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('FINAL-APP-BUILT'));
      await rec.shot('final');
    },
  },
];
