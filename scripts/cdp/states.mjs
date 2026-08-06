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
import { createSocket } from 'node:dgram';
import { rpc, evalIn, waitFor, sseText, sseToolCall, openExtPage, openWidePage, sleep, PASSPHRASE } from './e2e-harness.mjs';

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
const TRANSFER_EXPORT_VERSION = 2;

// Transfer routes require the exact options-page Port. Keep the live E2E on
// that production boundary instead of calling the generic dispatcher.
const privateTransferRpc = (page, message) => evalIn(page, `(async () => {
  const browser = (await import('/vendor/browser-polyfill.js')).default;
  const { makePrivateTransferClient } = await import('/options/private-transfer-client.js');
  globalThis.__peerdE2eTransferClient ??= makePrivateTransferClient({
    connect: () => browser.runtime.connect({ name: 'private-transfer' }),
  });
  return globalThis.__peerdE2eTransferClient.call(${JSON.stringify(message)});
})()`, true);

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
// heap-split phase 1: the offscreen pure-reasoning actor state.
let reasoningState = { spawned: 0, childCalls: 0 };
// heap-split phase 4: the offscreen TOOL-BEARING actor state.
let actorToolsState = { spawned: 0, childCalls: 0 };
// issue #324: an offscreen actor delegating FROM its granted script surface.
let actorCodeDelegatesState = {
  spawned: 0, childCalls: 0, webCalls: 0, sawComposedResult: false,
};
// heap-split phase 4: an offscreen actor DELEGATING to its own web actor.
let actorDelegatesState = { spawned: 0, childCalls: 0, webCalls: 0 };
// heap-split phase 4: an offscreen actor BUILDING an app (create + delegate).
let actorAppState = { spawned: 0, childCalls: 0, appCalls: 0, appId: null };
let actorAppProbeUrl = '';
let actorAppStunPort = 0;

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

// --- issue 251: the origin lock, end to end --------------------------------
//
// The unit tiers can prove the RULE and the STORE. What only this tier can prove
// is that a roaming web actor really is stopped by the live stack — real service
// worker, real actor loop, real tab, real DOM walk — and that the orchestrator is
// told something it can act on.
//
// The fixture is a SIGN-IN page, and that is the point rather than set dressing:
// nothing marks its origin sensitive up front. The actor walks the page, the walk
// sees `input[type=password]`, the classifier learns the origin, and the NEXT
// landing check hands off. So this state exercises the learned signal and the
// enforcement together — which is the only way to find out whether they agree.
//
// It is served on `*.localhost` (Chrome resolves it to loopback) because
// `normalizeApiOrigin` refuses a bare IP literal, so a 127.0.0.1 fixture could
// never be classified sensitive and the lock could never fire on it.
const LOGIN_HTML = `<!doctype html><html><head><title>Acme — Sign in</title></head><body>
<h1>Sign in to Acme</h1>
<form><label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>
</body></html>`;
const PLAIN_HTML = `<!doctype html><html><head><title>Acme — Public docs</title></head><body>
<h1>Public docs</h1><p>Nothing here needs an account.</p></body></html>`;
let siteActorTurn = 0;
let siteDelegated = false;
let siteReplyBody = '';
let siteActorSawPage = '';
let siteFixtureUrl = '';
let siteFixtureOrigin = '';
let lockActorTurn = 0;
let lockDelegated = false;
let lockReportBody = '';
let lockFixtureUrl = '';

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

  // --- functional: portable identity through the live SW + offscreen host ---
  {
    name: 'portable-identity', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const transferPage = await openWidePage(ctx, 'options/options.html#!/transfer', { ready: '#exppass' });
      let exported = await privateTransferRpc(transferPage, { type: 'transfer/export', passphrase: PASSPHRASE });
      if (!exported?.payload?.dweb?.identityRecord) {
        // The harness initializes a new vault but does not perform the later
        // unlock wake that normally starts the base network and mints its root.
        // Seed through the shipped encrypted restore surface. No raw root uses
        // the generic runtime-message dispatcher.
        const bootstrap = await evalIn(ctx.page, `(async () => {
          const dweb = await import('/peerd-distributed/index.js');
          let value = null;
          await dweb.createPersistentIdentity({
            getSecret: async () => null,
            setSecret: async (_name, next) => { value = next; },
          });
          const material = JSON.parse(value);
          return dweb.createDwebClient().identityRecordExport({
            material, passphrase: ${JSON.stringify(PASSPHRASE)},
          });
        })()`, true);
        const seeded = await privateTransferRpc(transferPage, {
          type: 'transfer/import', passphrase: PASSPHRASE,
          payload: {
            format: 'peerd-export', version: TRANSFER_EXPORT_VERSION, exportedAt: new Date(0).toISOString(), channel: 'preview',
            settings: {}, providerEndpoints: null, secrets: null, memory: null,
            hooks: [], skills: [], dweb: { identityRecord: bootstrap },
          },
        });
        rec.check('test fixture restores only through the encrypted transfer surface',
          seeded?.ok === true && seeded?.imported?.dwebIdentity === 1, JSON.stringify(seeded));
        exported = await privateTransferRpc(transferPage, { type: 'transfer/export', passphrase: PASSPHRASE });
      }
      const record = exported?.payload?.dweb?.identityRecord;
      const beforeDid = record?.did ?? null;
      rec.check('preview identity exists in the unlocked vault',
        typeof beforeDid === 'string' && beforeDid.startsWith('did:key:'), JSON.stringify(beforeDid));
      rec.check('live export includes an encrypted identity record',
        exported?.ok === true && typeof record?.capsule === 'string' && record?.did?.startsWith('did:key:'),
        JSON.stringify({ ok: exported?.ok, error: exported?.error, did: record?.did }));

      const inspected = await privateTransferRpc(transferPage, { type: 'transfer/inspectImport', payload: exported?.payload });
      rec.check('pre-flight names the identity and requires its passphrase',
        inspected?.ok === true && inspected.summary?.hasIdentityRecord === true
          && inspected.summary?.requiresPassphrase === true && inspected.summary?.identityDid === record?.did,
        JSON.stringify(inspected?.summary));

      const wrong = await privateTransferRpc(transferPage, {
        type: 'transfer/import', payload: exported?.payload, passphrase: `${PASSPHRASE}-wrong`,
      });
      rec.check('wrong identity passphrase fails closed',
        wrong?.ok === false && wrong?.error === 'wrong-passphrase', JSON.stringify(wrong));

      const restored = await privateTransferRpc(transferPage, {
        type: 'transfer/import', payload: exported?.payload, passphrase: PASSPHRASE,
      });
      const after = await privateTransferRpc(transferPage, { type: 'transfer/export', passphrase: PASSPHRASE });
      const afterDid = after?.payload?.dweb?.identityRecord?.did ?? null;
      rec.check('same-did restore authenticates without replacing the local root',
        restored?.ok === true && restored.imported?.dwebIdentity === 0
          && afterDid === beforeDid,
        JSON.stringify({ restored, beforeDid, afterDid }));

      const incoming = await evalIn(ctx.page, `(async () => {
        const dweb = await import('/peerd-distributed/index.js');
        let value = null;
        await dweb.createPersistentIdentity({
          getSecret: async () => null,
          setSecret: async (_name, next) => { value = next; },
        });
        const material = JSON.parse(value);
        const record = await dweb.createDwebClient().identityRecordExport({
          material, passphrase: ${JSON.stringify(PASSPHRASE)},
        });
        return { record, did: record.did };
      })()`, true);
      const replacementPayload = {
        ...exported.payload,
        settings: {}, providerEndpoints: null, secrets: null,
        memory: null, hooks: [], skills: [],
        dweb: { identityRecord: incoming.record },
      };
      const conflict = await privateTransferRpc(transferPage, {
        type: 'transfer/import', payload: replacementPayload, passphrase: PASSPHRASE,
      });
      rec.check('a different live identity stops for explicit approval',
        conflict?.ok === false && conflict?.error === 'dweb-identity-conflict'
          && conflict.conflict?.existingDid === record.did
          && conflict.conflict?.incomingDid === incoming.did,
        JSON.stringify(conflict));

      const replaced = await privateTransferRpc(transferPage, {
        type: 'transfer/import', payload: replacementPayload, passphrase: PASSPHRASE,
        replaceDwebIdentity: true,
        approvedExistingDwebDid: conflict?.conflict?.existingDid,
        approvedIncomingDwebDid: conflict?.conflict?.incomingDid,
      });
      const exportedAfterReplace = await privateTransferRpc(transferPage, {
        type: 'transfer/export', passphrase: PASSPHRASE,
      });
      const storedDid = exportedAfterReplace?.payload?.dweb?.identityRecord?.did ?? null;
      rec.check('approved replacement commits the incoming permanent identity',
        replaced?.ok === true && replaced.identityOutcome === 'replaced'
          && replaced.imported?.dwebIdentity === 1 && storedDid === incoming.did,
        JSON.stringify({ replaced, storedDid, incomingDid: incoming.did }));

      const restarted = await rpc(ctx.page, { type: 'dweb/base-host/start' });
      rec.check('the peer host starts under the restored identity after lease release',
        restarted?.ok === true && restarted?.running === true && restarted?.did === incoming.did,
        JSON.stringify(restarted));
      await rec.shot('final');
      try { transferPage.close(); } catch { /* */ }
    },
  },

  // --- visual: portable identity backup + destructive restore conflict ------
  {
    name: 'options-transfer', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/transfer');
      try {
        await waitFor(() => evalIn(page, `!!document.querySelector('#exppass')`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        await rec.visualPage('options-transfer', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'options-transfer-conflict', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const seedPage = await openWidePage(ctx, 'options/options.html#!/transfer', { ready: '#exppass' });
      const localExport = await privateTransferRpc(seedPage, { type: 'transfer/export', passphrase: PASSPHRASE });
      let localReady = !!localExport?.payload?.dweb?.identityRecord;
      if (!localReady) {
        const record = await evalIn(ctx.page, `(async () => {
          const dweb = await import('/peerd-distributed/index.js');
          let value = null;
          await dweb.createPersistentIdentity({ getSecret: async () => null, setSecret: async (_name, next) => { value = next; } });
          return dweb.createDwebClient().identityRecordExport({
            material: JSON.parse(value), passphrase: ${JSON.stringify(PASSPHRASE)},
          });
        })()`, true);
        await privateTransferRpc(seedPage, {
          type: 'transfer/import', passphrase: PASSPHRASE,
          payload: {
            format: 'peerd-export', version: TRANSFER_EXPORT_VERSION, exportedAt: new Date(0).toISOString(), channel: 'preview',
            settings: {}, providerEndpoints: null, secrets: null, memory: null,
            hooks: [], skills: [], dweb: { identityRecord: record },
          },
        });
        const postBootstrap = await privateTransferRpc(seedPage, {
          type: 'transfer/export', passphrase: PASSPHRASE,
        });
        localReady = !!postBootstrap?.payload?.dweb?.identityRecord;
      }
      try { seedPage.close(); } catch { /* */ }
      const incoming = await evalIn(ctx.page, `(async () => {
        const dweb = await import('/peerd-distributed/index.js');
        let value = null;
        await dweb.createPersistentIdentity({ getSecret: async () => null, setSecret: async (_name, next) => { value = next; } });
        const material = JSON.parse(value);
        const record = await dweb.createDwebClient().identityRecordExport({
          material, passphrase: ${JSON.stringify(PASSPHRASE)},
        });
        return { material, record };
      })()`, true);
      const payload = {
        format: 'peerd-export', version: TRANSFER_EXPORT_VERSION, exportedAt: new Date(0).toISOString(), channel: 'preview',
        // why: keep the complete-value disclosure in the same visual contract
        // as the destructive conflict. A long recognized array catches both
        // accidental truncation and wrapping regressions before the user acts.
        settings: {
          openrouterModels: [
            'review/complete-setting-value-that-must-remain-visible-without-ellipsis-or-clipping-0123456789',
            'review/second-model-preserves-the-array-shape-and-confirms-every-value-is-inspectable',
          ],
        },
        providerEndpoints: null, secrets: null, memory: null, hooks: [], skills: [],
        dweb: { identityRecord: incoming?.record },
      };
      const page = await openWidePage(ctx, 'options/options.html#!/transfer', { ready: '#peerd-backup-file' });
      try {
        await evalIn(page, `(() => {
          const file = new File([${JSON.stringify(JSON.stringify(payload))}], 'identity-backup.json', { type: 'application/json' });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const input = document.querySelector('#peerd-backup-file');
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(() => evalIn(page, `!!document.querySelector('#imppass')`),
          { budgetMs: 15_000, pollMs: 80 });
        await evalIn(page, `(() => {
          const input = document.querySelector('#imppass');
          input.value = ${JSON.stringify(PASSPHRASE)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(() => evalIn(page, `[...document.querySelectorAll('button')].some((button) => button.textContent === 'Apply import' && !button.disabled)`),
          { budgetMs: 5_000, pollMs: 50 });
        await evalIn(page, `[...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply import')?.click()`);
        await waitFor(() => evalIn(page, `!!document.querySelector('#identity-conflict')`),
          { budgetMs: 20_000, pollMs: 80 });
        await evalIn(page, `[...document.querySelectorAll('button')].find((button) => button.textContent === 'Review identity replacement')?.click()`);
        await waitFor(() => evalIn(page, `!!document.querySelector('#identity-replace-confirmation')`),
          { budgetMs: 5_000, pollMs: 80 });
        await evalIn(page, `document.querySelector('.import-setting-values > summary')?.click()`);
        await waitFor(() => evalIn(page, `(() => {
          const disclosure = document.querySelector('.import-setting-values');
          const value = disclosure?.querySelector('code')?.textContent ?? '';
          return disclosure?.open === true
            && value.includes('complete-setting-value-that-must-remain-visible')
            && value.includes('second-model-preserves-the-array-shape');
        })()`), { budgetMs: 5_000, pollMs: 80 });
        const state = await evalIn(page, `(() => ({
          conflict: document.querySelector('#identity-conflict')?.textContent,
          confirmation: document.querySelector('#identity-replace-confirmation')?.textContent,
          danger: !!document.querySelector('button.danger'),
          settingsDisclosureOpen: document.querySelector('.import-setting-values')?.open === true,
        }))()`);
        rec.check('destructive identity replacement requires a second confirmation',
          state?.danger === true && state?.settingsDisclosureOpen === true
            && /Existing peers will see a new identity/.test(state?.confirmation ?? ''),
          JSON.stringify({ local: localReady, incoming: !!incoming?.record, state }));
        await evalIn(page, `document.querySelector('#identity-replace-confirmation')?.scrollIntoView({ block: 'center' })`);
        await rec.visualPage('options-transfer-conflict', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual: idle unlocked panel -------------------------------------------
  {
    name: 'idle-unlocked', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) { await rec.visual('idle-unlocked'); },
  },

  // --- functional: the goal-mode autonomous loop -----------------------------
  // Also covers the plan-of-record (todo_init/todo_check → the visible
  // TodoCard) and the sticky Goal toggle (lit "running" while the run drives,
  // not untoggled on send). The faked model plans, ticks one item, then ends
  // the run — so the card renders 1/2 and the toggle reads running mid-flight.
  {
    name: 'goal', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => {
      if (callIndex === 0) return { delayMs: 200, sse: sseText('On it — planning the goal.') };
      if (callIndex === 1) return { delayMs: 200, sse: sseToolCall('todo_init', { items: [
        { text: 'tidy the repo', validation: 'no stray files' },
        { text: 'verify the build', validation: 'tests pass' },
      ] }) };
      if (callIndex === 2) return { delayMs: 200, sse: sseToolCall('todo_check', { id: 1 }) };
      if (callIndex === 3) return { delayMs: 200, sse: sseToolCall('complete_goal', { summary: 'all tidy' }) };
      return { delayMs: 120, sse: sseText('Goal complete.') };
    },
    async run(ctx, rec) {
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'tidy the repo', goal: true });
      rec.check('goal run started', sent?.ok && sent.handled === 'goal', JSON.stringify(sent));
      const goalBarSeen = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.goal-bar')`), { budgetMs: 10_000, pollMs: 50 });
      // The Goal toggle is the run's state light — it must read "running", not
      // fall back to unlit, the instant the run is live (the fix for "did it
      // even start?"). Best-effort snapshot while the run drives.
      const toggleRunning = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.goal-toggle.is-running')`),
        { budgetMs: 8_000, pollMs: 50 });
      // The plan-of-record card appears once todo_init lands and ticks to 1/2
      // after todo_check — the visible checklist that answers "is it working?".
      const todoSeen = await waitFor(
        () => evalIn(ctx.page, `/1\\/2/.test(document.querySelector('.todo-card .todo-card-meta')?.textContent || '')`),
        { budgetMs: 12_000, pollMs: 50 });
      if (goalBarSeen) await rec.shot('goal-bar');
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return !out.goalBar && !out.busy; }, { budgetMs: 25_000 });
      const calls = ctx.modelCallCount();
      rec.check('Goal bar appeared while driving', !!goalBarSeen);
      rec.check('Goal toggle read "running" while live (sticky, not untoggled)', !!toggleRunning);
      rec.check('TodoCard rendered the plan and ticked to 1/2 after todo_check', !!todoSeen);
      rec.check('loop drove >1 autonomous turn', calls >= 3, `model calls: ${calls}`);
      rec.check('complete_goal ended it cleanly (not the cap)', !out.capped && calls < 12, `capped=${out.capped} calls=${calls}`);
      rec.check('run reaches terminal: Goal bar cleared + idle', out.goalBar === false && out.busy === false);
      // The finished checklist stays as the run's receipt (does not vanish on end).
      const todoAfter = await evalIn(ctx.page, `!!document.querySelector('.todo-card')`);
      rec.check('TodoCard persists after the run as its receipt', !!todoAfter);
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

  // --- functional: issue 251 — the origin lock stops a roaming actor ----------
  {
    name: 'origin-lock', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The WEB ACTOR sub-loop. Drive it onto the sign-in page and then have it
      // keep working there. The FIRST snapshot is what teaches the classifier
      // (the walk sees the password field); the SECOND tool call is the one the
      // lock refuses — so the actor must be told to do something after looking.
      if (body.includes('<actor_agent>')) {
        const t = lockActorTurn++;
        if (t === 0) return { sse: sseToolCall('navigate', { url: `${lockFixtureUrl}login` }) };
        if (t === 1) return { sse: sseToolCall('snapshot', {}) };
        if (t === 2) return { sse: sseToolCall('snapshot', {}) };
        // If the lock works, the actor never reaches this — its turn is ended and
        // its reply is replaced by the report. Producing a confident answer here
        // is deliberate: it means a FAILURE of the lock shows up as this text
        // reaching the orchestrator, rather than as a silent pass.
        return { sse: sseText('LOCK-DID-NOT-FIRE: I read the signed-in page.') };
      }
      // ORCHESTRATOR: delegate once, then capture the request that carries the
      // actor's reply — which is where the report has to appear.
      if (!lockDelegated) {
        lockDelegated = true;
        return { sse: sseToolCall('message_actor', { to: 'web', message: `Open ${lockFixtureUrl}login and tell me what is on it` }) };
      }
      // A lock stop delivers as a FAILED reply, whose lead is "could not complete
      // your request" — not the success wording. Match both so this state cannot
      // pass vacuously by simply never seeing a reply at all.
      if (body.includes('could not complete your request') || body.includes('you messaged has replied')) {
        if (!lockReportBody) lockReportBody = body;
        return { sse: sseText('The helper was stopped at that site.') };
      }
      return { sse: sseText('Delegated; awaiting the reply.') };
    },
    async run(ctx, rec) {
      lockActorTurn = 0;
      lockDelegated = false;
      lockReportBody = '';
      const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(String(req.url).includes('login') ? LOGIN_HTML : PLAIN_HTML);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      // Chrome maps *.localhost to loopback (RFC 6761), and unlike a bare IP this
      // is a host normalizeApiOrigin will canonicalize — so it can be classified.
      lockFixtureUrl = `http://acme.localhost:${port}/`;
      const fixtureOrigin = `http://acme.localhost:${port}`;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Look at the Acme sign-in page for me.' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        await waitFor(() => lockReportBody.length > 0, { budgetMs: 45_000, pollMs: 100 });
        await ctx.page.send('Page.bringToFront').catch(() => {});

        // THE LOAD-BEARING ASSERTION: the actor was stopped, and what reached the
        // orchestrator is peerd's report — not the actor's own account of the page.
        // Requiring the body to be NON-EMPTY matters: an earlier version of this
        // check passed while nothing had arrived at all, which is the failure mode
        // a security test can least afford.
        rec.check('a reply actually reached the orchestrator', lockReportBody.length > 0);
        rec.check('the roaming actor was STOPPED at the credentialed origin (its own answer never arrived)',
          lockReportBody.length > 0 && !lockReportBody.includes('LOCK-DID-NOT-FIRE'),
          lockReportBody.slice(0, 300));
        rec.check('the orchestrator is told a helper was stopped',
          /was stopped when the tab arrived at|helper was stopped/i.test(lockReportBody),
          lockReportBody.slice(0, 300));
        // The successor has to be the SITE handle. The bare origin resolves to the
        // fetch-only API integration, which cannot log in or click — naming it
        // would route every handoff to an actor structurally unable to do the work.
        rec.check('the report names the site: successor handle',
          lockReportBody.includes(`site:${fixtureOrigin}`),
          lockReportBody.slice(0, 400));
        // Origins only. The landing URL is the one string an attacker controls at
        // that moment, so a path or query reaching the orchestrator would be a
        // free text channel out of a possibly-hijacked actor.
        //
        // Scoped to the REPORT, not the whole request: the body carries the full
        // conversation, including the orchestrator's own earlier message_actor
        // call, which legitimately contains the /login URL the USER's task named.
        // Asserting over everything conflated "the report leaked the path" with
        // "the orchestrator said it first", and failed on the innocent one.
        const leadAt = lockReportBody.indexOf('could not complete your request');
        const reportOnly = leadAt >= 0 ? lockReportBody.slice(leadAt, leadAt + 4000) : '';
        rec.check('the report itself was located in the reply', reportOnly.length > 0);
        rec.check('the report carries the ORIGIN only — no path from the refused page',
          reportOnly.length > 0 && !/acme\.localhost:\\?\/*\d*\/?login/.test(reportOnly) && !reportOnly.includes('/login'),
          reportOnly.slice(0, 600));

        // RECOVERY: the stop released the tab, so the same web actor still works.
        // Without the release, navigate judges the tab's CURRENT url first and is
        // refused on the very landing it is trying to leave — every later web
        // request in the chat gets the same handoff report, forever.
        const state = await rpc(ctx.page, { type: 'debug/originLock', origin: fixtureOrigin }).catch(() => null);
        rec.check('the refused tab was RELEASED (the actor is not bricked on it)',
          !state || state.ownedTabId == null,
          JSON.stringify(state));
        rec.check('the origin was LEARNED from the password field on the page',
          !state || state.learned === true,
          JSON.stringify(state));
        await rec.shot('final');
      } finally {
        server.close();
      }
    },
  },

  // --- functional: issue 251 — the SITE actor the handoff points at -----------
  //
  // The origin-lock state proves a roaming actor is STOPPED and that the report
  // names `site:<origin>`. That is only half a feature: a handoff that names a
  // successor nobody can address is a dead end dressed up as a route. This drives
  // the other half — the orchestrator follows the instruction, and the bound
  // helper actually does the work on the site the roaming one was refused.
  {
    name: 'site-actor', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>')) {
        if (body.includes('Members only')) siteActorSawPage = body;
        const t = siteActorTurn++;
        if (t === 0) return { sse: sseToolCall('navigate', { url: `${siteFixtureUrl}account` }) };
        if (t === 1) return { sse: sseToolCall('read_page', {}) };
        return { sse: sseText('The account page says: Members only — balance 42.') };
      }
      if (!siteDelegated) {
        siteDelegated = true;
        // Address the SITE handle directly, exactly as the handoff report tells
        // the orchestrator to. `site:` must beat the bare-origin branch in
        // resolveActor, or this reaches the fetch-only API integration instead.
        return { sse: sseToolCall('message_actor', { to: `site:${siteFixtureOrigin}`, message: `Read the account page at ${siteFixtureUrl}account and tell me the balance` }) };
      }
      if (body.includes('you messaged has replied') || body.includes('could not complete your request')) {
        if (!siteReplyBody) siteReplyBody = body;
        return { sse: sseText('The balance is 42.') };
      }
      return { sse: sseText('Delegated; awaiting the reply.') };
    },
    async run(ctx, rec) {
      siteActorTurn = 0;
      siteDelegated = false;
      siteReplyBody = '';
      siteActorSawPage = '';
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><head><title>Acme account</title></head><body>
<h1>Members only</h1><p>Your balance is 42.</p></body></html>`);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      siteFixtureUrl = `http://acct.localhost:${port}/`;
      siteFixtureOrigin = `http://acct.localhost:${port}`;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'What is my Acme balance?' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        await waitFor(() => siteReplyBody.length > 0, { budgetMs: 45_000, pollMs: 100 });
        await ctx.page.send('Page.bringToFront').catch(() => {});

        rec.check('the site: handle RESOLVED to a real actor that ran a turn',
          siteActorTurn >= 2, `actor turns: ${siteActorTurn}`);
        // Load-bearing: a fetch-only API integration has NO DOM tools, so read_page
        // returning the page's own text proves the handle reached a TAB-backed
        // helper — the distinction the whole `site:` prefix exists to make.
        rec.check('it is TAB-backed — it really drove a page (read_page returned the live text)',
          siteActorSawPage.includes('Members only'), siteActorSawPage.slice(0, 200));
        rec.check('the reply reached the orchestrator as a SUCCESS, not a lock stop',
          siteReplyBody.includes('you messaged has replied'), siteReplyBody.slice(0, 200));

        const state = await rpc(ctx.page, { type: 'debug/originLock', origin: siteFixtureOrigin }).catch(() => null);
        rec.check('the site actor is BOUND to that origin, not roaming',
          !state || state.siteActorState?.mode === 'bound', JSON.stringify(state));
        rec.check('and it owns exactly that origin',
          !state || state.siteActorState?.ownedOrigin === siteFixtureOrigin, JSON.stringify(state));
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

  // --- visual: the mode row in Plan mode (segmented Plan/Act + chips) ---------
  {
    name: 'mode-plan', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('planning only') }),
    async run(ctx, rec) {
      // The mode row renders once a session exists — send one turn, then flip
      // to Plan so the segmented control shows its active-Plan state.
      await rpc(ctx.page, { type: 'agent/send', text: 'what would you do?' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await rpc(ctx.page, { type: 'permission/set', mode: 'plan' });
      await waitFor(() => evalIn(ctx.page,
        `document.querySelector('.planact-mode[aria-pressed="true"]')?.textContent.trim() === 'Plan'`),
        { budgetMs: 8_000, pollMs: 50 });
      await rec.visual('mode-plan');
      // Restore Act so later states start from the default mode.
      await rpc(ctx.page, { type: 'permission/set', mode: 'act' });
    },
  },

  // --- visual: a goal run mid-flight (goal bar + plan todo card) --------------
  {
    name: 'goal-running', kind: 'visual', phase: 'post-unlock',
    // Set up the plan, tick one item, then HANG so the goal bar + todo card
    // stay on screen for the capture (resetSession aborts the pending call
    // before the next state).
    responder: (callIndex) => {
      if (callIndex === 0) return { delayMs: 150, sse: sseText('On it — planning.') };
      if (callIndex === 1) return { delayMs: 150, sse: sseToolCall('todo_init', { items: [
        { text: 'read the failing test output', validation: 'root cause named' },
        { text: 'reproduce in a linux VM', validation: 'repro confirmed' },
        { text: 'patch the retry wrapper', validation: 'gate no longer raw' },
      ] }) };
      if (callIndex === 2) return { delayMs: 150, sse: sseToolCall('todo_check', { id: 1 }) };
      return { delayMs: 60_000, sse: sseText('working…') };
    },
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'fix the failing test', goal: true });
      await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.goal-bar')`), { budgetMs: 10_000, pollMs: 50 });
      await waitFor(() => evalIn(ctx.page,
        `/1\\/3/.test(document.querySelector('.todo-card .todo-card-meta')?.textContent || '')`),
        { budgetMs: 12_000, pollMs: 50 });
      await rec.visual('goal-running');
    },
  },

  // --- visual: a failed turn (error banner + failure-class chip) --------------
  {
    name: 'error-turn', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'e2e injected provider error', type: 'invalid_request_error' } }) }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'trigger an error' });
      await waitFor(async () => { const o = await probe(ctx); return o.errorText && !o.busy; }, { budgetMs: 25_000 });
      await rec.visual('error-turn');
    },
  },

  // --- visual: a multi-exchange transcript (bubbles carry across turns) -------
  {
    name: 'multi-turn-transcript', kind: 'visual', phase: 'post-unlock',
    responder: (callIndex) => ({ sse: sseText(callIndex === 0
      ? 'The egress gate blocked api.payments.io — it is on your denylist. Want me to spin a VM and reproduce?'
      : 'Reproduced in a fresh Linux VM. The call throws before the retry wrapper, so the gate surfaces raw.') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'check the failing egress gate on the payments call' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await rpc(ctx.page, { type: 'agent/send', text: 'yes, reproduce it' });
      await waitFor(() => evalIn(ctx.page,
        `[...document.querySelectorAll('.message-assistant .bubble')].some((b) => /Reproduced/.test(b.textContent))`),
        { budgetMs: 20_000 });
      await waitFor(async () => { const o = await probe(ctx); return !o.busy; }, { budgetMs: 20_000 });
      await rec.visual('multi-turn-transcript');
    },
  },

  // --- visual: a turn mid-flight (thinking orb + Stop) ------------------------
  {
    name: 'busy-thinking', kind: 'visual', phase: 'post-unlock',
    // Hold before the first token so the pre-stream thinking state stays up;
    // resetSession aborts the pending call before the next state.
    responder: () => ({ delayMs: 60_000, sse: sseText('…') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'plan a fix for the failing test' });
      await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`), { budgetMs: 10_000, pollMs: 50 });
      await rec.visual('busy-thinking');
    },
  },

  // --- visual: the sessions / chats list -------------------------------------
  {
    name: 'sessions-list', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // Two chats so the list has rows to show, then open the chats view.
      await rpc(ctx.page, { type: 'agent/send', text: 'summarize the three PRs I opened today' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await rpc(ctx.page, { type: 'session/reset' });
      await rpc(ctx.page, { type: 'agent/send', text: 'spin up a linux VM and run uname -a' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await evalIn(ctx.page, `document.querySelector('.topbar-actions button[title="Chats"]')?.click()`);
      await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.sessions-list .session-row')`), { budgetMs: 8_000, pollMs: 50 });
      await rec.visual('sessions-list');
      // Return to the chat view for later states.
      await evalIn(ctx.page, `document.querySelector('.topbar-actions button[title="Chats"]')?.click()`);
    },
  },

  // --- visual: an expanded tool-call card (the lineage body) -----------------
  {
    name: 'tool-card-expanded', kind: 'visual', phase: 'post-unlock',
    responder: (callIndex) => callIndex === 0
      ? { sse: sseToolCall('read_page', { url: 'https://docs.rs/tokio' }) }
      : { sse: sseText('The page loaded — 214 sections indexed.') },
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'read the tokio docs' });
      await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.tool-call')`), { budgetMs: 20_000, pollMs: 50 });
      await waitFor(async () => { const o = await probe(ctx); return !o.busy; }, { budgetMs: 20_000 });
      // Expand the card's detail body.
      await evalIn(ctx.page, `document.querySelector('.tool-call-header')?.click()`);
      await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.tool-detail')`), { budgetMs: 5_000, pollMs: 50 });
      await rec.visual('tool-card-expanded');
    },
  },

  // --- visual (WIDE): the full-tab home SPA — the large in-browser view -------
  // Opened as its own browser tab (1280 wide), not the 400px side panel. The
  // vault is already unlocked in the SW, so home boots to its SPA.
  {
    name: 'home-fulltab', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'home/home.html');
      try {
        // Wait past the boot vault-gate/onboarding flash to the home surface.
        await waitFor(() => evalIn(page,
          `!!document.querySelector('.home-shell, .home-rail, .empty-state--home, .path-menu--home')`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        // …and then past the FIRST-RUN SEED INSTALL, which is what made this
        // state flaky. home.js seeds the commons app on first unlock and the
        // Library re-renders when it lands, so the camera raced it: some runs
        // photographed "1 app", others "No apps yet", and the 0.78% diff read as
        // a UI regression when it was a lifecycle race. The seed is a PACKAGED
        // asset, not a network fetch, so waiting for it is deterministic — it
        // always arrives; the only question was whether we waited for it.
        //
        // Bounded and swallowed on purpose: a build with the dweb pruned (the
        // store channel) installs nothing, and there an empty Library IS the
        // settled state. Falling through then is correct, not a miss.
        //
        // Known residual: the card carries a relative timestamp ("just now").
        // It is stable for anything under a minute, which every run is, but a
        // pathologically slow runner would drift it.
        await waitFor(() => evalIn(page, `document.querySelectorAll('.library-grid > *').length > 0`),
          { budgetMs: 10_000, pollMs: 100 }).catch(() => {});
        await rec.visualPage('home-fulltab', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): the full-tab options / settings page --------------------
  {
    name: 'options-fulltab', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html');
      try {
        await waitFor(() => evalIn(page, `document.querySelector('#app')?.children.length > 0`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        await rec.visualPage('options-fulltab', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): the two settings pages the redesign rebuilt -------------
  //
  // why these exist at all: `options-fulltab` above photographs the DEFAULT
  // route (Providers & models), so it is the only options screen under the
  // pixel gate — which meant a rewrite of Behavior and Denylist could land
  // reporting "no visual drift" because nothing ever looked at them. A gate that
  // cannot see the page it is meant to guard is worse than no gate: it reads as
  // proof. These two put the rebuilt surfaces under the same authority as the
  // rest.
  //
  // Both open a specific hash route, so they wait on that page's own first
  // element rather than `#app` having any child (which is true the moment the
  // shell mounts, before the section renders).
  {
    name: 'options-behavior', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/behavior');
      try {
        await waitFor(() => evalIn(page, `document.querySelectorAll('.set-row').length >= 11`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        await rec.visualPage('options-behavior', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'options-denylist', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/denylist');
      try {
        // The seed loads asynchronously in the SW, so wait for the GROUPS —
        // photographing an empty list would bake "no categories" into the
        // baseline and then never fail again.
        await waitFor(() => evalIn(page, `document.querySelectorAll('.denylist-group').length >= 8`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        await rec.visualPage('options-denylist', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  // --- visual: the STANDALONE TAB PAGES ---------------------------------------
  //
  // Coverage audit finding: every visual baseline photographed the side panel,
  // home or options, so five shipped pages — the three engine tabs, the mic
  // permission grant, and the eval runner — had NO pixel guard at all. These are
  // the cheap half of that gap: each renders fully with no instance, no seeding
  // and no model traffic, so they cost one openWidePage + a selector wait.
  //
  // The engine tabs are captured in their HARD-FAIL state, opened with no URL
  // hash. That is deliberate rather than a shortcut: the fail card IS the screen
  // a user meets when an id is stale, an image pin mismatches, or cross-origin
  // isolation is unavailable, and it is the only explanation they get for why
  // their VM/Notebook/App did not start. It is also the one state reachable
  // without booting CheerpX. The booted terminal / editor / render states remain
  // uncovered and want their own states with a seeded instance.
  {
    name: 'vm-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'engine-tabs/vm-tab/index.html', { ready: '.boot-card.is-failed, #boot-stage' });
      try {
        // The boot log stamps each line with the WALL CLOCK, so this baseline
        // would differ on every single run and the state would flap forever.
        // Pin it to a fixed time rather than hiding the line — the timestamp's
        // presence and position are part of what the baseline should guard, its
        // value is not. (The harness's UTC timezone override does not help: the
        // problem is the time advancing, not the zone.)
        const pinClock = () => evalIn(page, `(() => {
          for (const el of document.querySelectorAll('#boot-log, #boot-log *')) {
            for (const n of el.childNodes) {
              if (n.nodeType === 3) n.textContent = n.textContent.replace(/\\d{2}:\\d{2}:\\d{2}/g, '00:00:00');
            }
          }
          return true;
        })()`);

        // TWO different nondeterminisms live in this one card, and pinning only
        // ever addressed the first:
        //
        //   the VALUE of each timestamp — pinClock above; and
        //   HOW MANY lines exist when we shoot. `ready` fires on the failed
        //   boot-card, but the boot keeps appending for a little longer, so the
        //   capture could catch N or N+1 lines depending on runner speed.
        //
        // The second is what actually made this state flap on main (a dark-only
        // drift, because dark is the SECOND capture — a line landing between the
        // two shots reached dark alone, carrying an unpinned clock with it).
        // So: wait for the log to stop growing before shooting anything, and
        // re-pin before EACH theme via beforeShot, which closes the window
        // between the two captures rather than just the one before the first.
        // waitFor returns null on budget exhaustion rather than throwing. That is
        // the right shape here: a log that never settles should still produce a
        // shot (and a visible diff) rather than failing the whole state with a
        // timeout that says nothing about the render.
        const logLength = () => evalIn(page, `document.getElementById('boot-log')?.textContent?.length ?? 0`);
        await waitFor(async () => {
          const a = await logLength();
          await sleep(120);
          return a === await logLength();
        }, { budgetMs: 5000 });

        await pinClock();
        await rec.visualPage('vm-tab-failed', page, { beforeShot: pinClock });
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'notebook-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // notebook-tab replaces <body> wholesale with its red no-id paragraph, so
      // the probe cannot look for a page id — `body > p` is what actually lands.
      const page = await openWidePage(ctx, 'engine-tabs/notebook-tab/index.html', { ready: 'body > p, #notebook-boot' });
      try { await rec.visualPage('notebook-tab-failed', page); }
      finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'app-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'engine-tabs/app-tab/index.html', { ready: '#boot.is-failed, #boot-msg' });
      try { await rec.visualPage('app-tab-failed', page); }
      finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'mic-permission', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // A plain page with no hash, params or state — its whole value is its copy,
      // which is precisely what a pixel baseline protects.
      const page = await openWidePage(ctx, 'permissions/mic.html', { ready: 'button, h1' });
      try { await rec.visualPage('mic-permission', page); }
      finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'eval-runner', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // Dev-only and pruned from the store package, but it is a dense control
      // panel that renders fully at rest and is easy to break with a grid change.
      const page = await openWidePage(ctx, 'eval/runner.html', { ready: 'button, select' });
      try { await rec.visualPage('eval-runner', page); }
      finally { try { page.close(); } catch { /* */ } }
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
        // why all three: GOT proves the script shaped the value, the price
        // proves the actor reply entered the realm, and the fence proves code
        // could not launder that reply back into authoritative prompt text.
        hasScriptResult: body.includes('GOT:')
          && body.includes('WIDGET_PRICE_777')
          && body.includes('<untrusted_web_content'),
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
      if (body.includes('GOT:')
        && body.includes('WIDGET_PRICE_777')
        && body.includes('<untrusted_web_content')) return { sse: sseText('SCRIPT-FAN-DONE') };
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

  // --- functional: a pure-reasoning actor runs in its OWN offscreen heap ---
  // Heap-split phase 1. The orchestrator spawns a sync tools:[] actor; that
  // child's loop runs in a dedicated offscreen Worker (its own heap, no key),
  // relaying its model call back to the SW. Proof: the child model call happens
  // (its prompt carries the EPHEMERAL ACTOR block), the result round-trips into
  // the orchestrator's final answer, AND the actor_ran_offscreen audit marker
  // is present (it fired only on the offscreen path, never the in-SW fallback).
  {
    name: 'reasoning-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model call — its system prompt is the ephemeral-actor block.
      // why the IDENTITY line, not just "EPHEMERAL ACTOR": the ORCHESTRATOR prompt
      // also contains "EPHEMERAL ACTOR" (describing actor_create), so the broad
      // match mis-classified the orchestrator's own first call as the child.
      if (body.includes('You are an EPHEMERAL ACTOR')) { reasoningState.childCalls += 1; return { sse: sseText('REASONED-FOURTY-TWO') }; }
      // ORCHESTRATOR — spawn ONE sync pure-reasoning child, then (post tool-result) answer.
      if (reasoningState.spawned === 0) {
        reasoningState.spawned += 1;
        return { sse: sseToolCall('actor_create', { task: 'compute the answer to life', tools: [], sync: true }) };
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
      // actor_offscreen_fallback instead).
      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 500 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'actor_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'actor_offscreen_fallback');
      const actorTypes = entries.filter((e) => String(e.type).startsWith('spawned')).map((e) => e.type);
      rec.check('the child sub-loop ran (EPHEMERAL ACTOR prompt seen)', reasoningState.childCalls >= 1, `childCalls=${reasoningState.childCalls}`);
      rec.check('the pure-reasoning child ran in its OWN offscreen heap (actor_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack} bubbles=${JSON.stringify(out.bubbles)} actorAudits=${JSON.stringify(actorTypes)}`);
      rec.check('it did NOT silently fall back to the in-SW loop', fellBack === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-ANSWER-42'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: a TOOL-BEARING actor runs in its OWN offscreen heap ---
  // Heap-split phase 4. The orchestrator spawns a sync actor GRANTED script;
  // that child's loop runs in a dedicated offscreen Worker (its own heap, no key)
  // and RELAYS its script call back to the SW, which rebuilds the child's restricted
  // ctx from the persisted grantedTools and dispatches script in the offscreen
  // job-runner. Proof: the child looped (two model calls: emit script, then answer),
  // the actor_ran_offscreen audit fired (offscreen path, not the in-SW fallback),
  // AND a tool_executed audit for script is present (the relayed tool actually ran).
  {
    name: 'actor-tools-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model calls (ephemeral-actor prompt). First call emits script;
      // second call (after the tool result re-enters its heap) answers.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        actorToolsState.childCalls += 1;
        if (actorToolsState.childCalls === 1) return { sse: sseToolCall('script', { code: 'return 6 * 7;' }) };
        return { sse: sseText('CHILD-RAN-JS') };
      }
      // ORCHESTRATOR — spawn ONE sync actor granted script, then answer.
      if (actorToolsState.spawned === 0) {
        actorToolsState.spawned += 1;
        return { sse: sseToolCall('actor_create', { task: 'compute six times seven with script', tools: ['script'], sync: true }) };
      }
      return { sse: sseText('FINAL-WITH-CHILD') };
    },
    async run(ctx, rec) {
      actorToolsState = { spawned: 0, childCalls: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'use an actor to compute six times seven' });
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
      const ranOffscreen = entries.some((e) => e.type === 'actor_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'actor_offscreen_fallback');
      const jsRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'script');
      rec.check('the tool-bearing child looped in its heap (script emitted, then answered) — 2 child calls', actorToolsState.childCalls >= 2, `childCalls=${actorToolsState.childCalls}`);
      rec.check('the child ran in its OWN offscreen heap (actor_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack}`);
      rec.check('script actually executed via the SW-gated relay (tool_executed audit)', jsRan === true, `jsRan=${jsRan}`);
      rec.check('it did NOT fall back to the in-SW loop', fellBack === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-WITH-CHILD'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: a trusted spawned actor delegates FROM CODE (#324) -------
  // Direct message_actor already admitted this trusted lineage. This state proves
  // the code hand has exact parity: actor heap -> script worker -> actors.ask relay
  // -> web-actor heap -> reply back into code -> child -> orchestrator.
  {
    name: 'actor-code-delegates-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes("You are peerd's web actor")) {
        actorCodeDelegatesState.webCalls += 1;
        return { sse: sseText('WEB-CODE-PRICE-101') };
      }
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        actorCodeDelegatesState.childCalls += 1;
        if (body.includes('CODE:')
          && body.includes('WEB-CODE-PRICE-101')
          && body.includes('untrusted')) {
          actorCodeDelegatesState.sawComposedResult = true;
        }
        if (actorCodeDelegatesState.childCalls === 1) {
          return { sse: sseToolCall('script', {
            code: "const r = await actors.ask('web', 'get the code-path price'); return 'CODE:' + r.reply;",
          }) };
        }
        return { sse: sseText('CHILD-CODE-GOT-WEB') };
      }
      if (actorCodeDelegatesState.spawned === 0) {
        actorCodeDelegatesState.spawned += 1;
        return { sse: sseToolCall('actor_create', {
          task: 'use one script to ask the web actor for the price and report it',
          tools: ['script', 'message_actor'], sync: true,
        }) };
      }
      return { sse: sseText('FINAL-VIA-ACTOR-CODE') };
    },
    async run(ctx, rec) {
      actorCodeDelegatesState = {
        spawned: 0, childCalls: 0, webCalls: 0, sawComposedResult: false,
      };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'use an actor script to ask the web actor for the price' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-VIA-ACTOR-CODE') && !out.busy;
      }, { budgetMs: 45_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 800 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'actor_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'actor_offscreen_fallback');
      const jsRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'script');
      rec.check('the actor script ran through the SW-gated relay', jsRan === true, `jsRan=${jsRan}`);
      rec.check('the actor looped after code received the web reply', actorCodeDelegatesState.childCalls >= 2 && actorCodeDelegatesState.sawComposedResult, `childCalls=${actorCodeDelegatesState.childCalls} composed=${actorCodeDelegatesState.sawComposedResult}`);
      rec.check('actors.ask reached a real web-actor heap', actorCodeDelegatesState.webCalls >= 1, `webCalls=${actorCodeDelegatesState.webCalls}`);
      rec.check('the actor stayed in its isolated offscreen heap', ranOffscreen === true && fellBack === false, `offscreen=${ranOffscreen} fellBack=${fellBack}`);
      rec.check('the composed result reached the orchestrator', (out.bubbles || []).includes('FINAL-VIA-ACTOR-CODE'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: an offscreen actor DELEGATES to its own web actor ------
  // Heap-split phase 4, the deepest chain — two isolated heaps stacked. The
  // orchestrator spawns a sync actor granted message_actor; that actor's loop
  // runs in its OWN offscreen heap and calls message_actor({to:'web'}) — which relays
  // to the SW, dispatches actorMessaging from the child's restricted ctx, and (because
  // the sender is an actor) AWAITS the web actor's fenced reply into the child's tool
  // result. The web actor is ITSELF an offscreen heap (phase 3). Proof: the child looped
  // offscreen, a web-actor sub-loop ran, message_actor executed via the relay, and the
  // web reply round-tripped up through the child into the orchestrator's answer. This is
  // the delegation-from-a-heap path the unit tests can only stub.
  {
    name: 'actor-delegates-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The WEB ACTOR's model call (its own offscreen heap).
      if (body.includes("You are peerd's web actor")) {
        actorDelegatesState.webCalls += 1;
        return { sse: sseText('WEB-PRICE-99') };
      }
      // The ACTOR's model calls (ephemeral-actor prompt). First emits message_actor;
      // second (after the awaited web reply re-enters its heap) answers.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        actorDelegatesState.childCalls += 1;
        if (actorDelegatesState.childCalls === 1) return { sse: sseToolCall('message_actor', { to: 'web', message: 'get the price of widget X' }) };
        return { sse: sseText('CHILD-GOT-WEB') };
      }
      // ORCHESTRATOR — spawn ONE sync actor granted message_actor, then answer.
      if (actorDelegatesState.spawned === 0) {
        actorDelegatesState.spawned += 1;
        return { sse: sseToolCall('actor_create', { task: 'ask the web actor for the price and report it', tools: ['message_actor'], sync: true }) };
      }
      return { sse: sseText('FINAL-VIA-ACTOR') };
    },
    async run(ctx, rec) {
      actorDelegatesState = { spawned: 0, childCalls: 0, webCalls: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'use an actor to ask the web actor for the price' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-VIA-ACTOR') && !out.busy;
      }, { budgetMs: 40_000 });

      const audit = await rpc(ctx.page, { type: 'audit/list', limit: 800 });
      const entries = (audit && audit.entries) || [];
      const ranOffscreen = entries.some((e) => e.type === 'actor_ran_offscreen');
      const fellBack = entries.some((e) => e.type === 'actor_offscreen_fallback');
      const msgActorRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'message_actor');
      rec.check('the actor looped offscreen (message_actor emitted, then answered) — 2 child calls', actorDelegatesState.childCalls >= 2, `childCalls=${actorDelegatesState.childCalls}`);
      rec.check('the actor ran in its OWN offscreen heap (actor_ran_offscreen audit)', ranOffscreen === true, `offscreen=${ranOffscreen} fellBack=${fellBack}`);
      rec.check('the actor delegated via message_actor from its heap (tool_executed audit)', msgActorRan === true, `msgActorRan=${msgActorRan}`);
      rec.check('a WEB-ACTOR sub-loop ran (its own heap) for the child delegation', actorDelegatesState.webCalls >= 1, `webCalls=${actorDelegatesState.webCalls}`);
      rec.check('it did NOT fall back to the in-SW loop', fellBack === false);
      rec.check('the web reply round-tripped up through the actor into the final answer', (out.bubbles || []).includes('FINAL-VIA-ACTOR'));
      rec.check('the turn settles idle', out.busy === false);
      await rec.shot('final');
    },
  },

  // --- functional: an offscreen actor BUILDS an app (create + delegate) ------
  // Heap-split phase 4, the create-then-delegate chain. An actor is asked to build
  // an app. App-mutating tools (app_write_file) are actor-only, so the correct pattern
  // — for an actor exactly as for the main agent — is sandbox_create({kind:'app'}), then message_actor
  // the created app's actor to write the files. This proves: the actor's tool RESULT
  // (the new app id) re-enters its own heap correctly, and it can delegate to a freshly-
  // created instance's actor, which mints, runs offscreen, and writes.
  {
    name: 'actor-builds-app', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // APP ACTOR (owns the created app; holds app_write_file).
      if (body.includes('client-side App builder') || body.includes('Your App is a multi-file artifact')) {
        actorAppState.appCalls += 1;
        if (actorAppState.appCalls === 1) {
          const probe = JSON.stringify(actorAppProbeUrl);
          const blobPayload = `<script>try { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${actorAppStunPort}'}]}); p.createDataChannel('blob'); p.createOffer().then(o => p.setLocalDescription(o)); } catch (_) {}<\/script>`;
          const dataPayload = `<script>try { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${actorAppStunPort}'}]}); p.createDataChannel('data'); p.createOffer().then(o => p.setLocalDescription(o)); } catch (_) {} setTimeout(() => { location.href = URL.createObjectURL(new Blob([${JSON.stringify(blobPayload)}], {type:'text/html'})); }, 250);<\/script>`;
          const content = `<!DOCTYPE html><body>REAL LAVA LAMP
<img src="${actorAppProbeUrl}/image">
<script>
document.body.dataset.webrtc = String(typeof RTCPeerConnection);
fetch(${probe} + '/fetch').catch(() => {});
const worker = new Worker(URL.createObjectURL(new Blob([
  'fetch(' + JSON.stringify(${probe} + '/worker') + ').catch(() => {})',
], { type: 'application/javascript' })));
setTimeout(() => { location.href = ${probe} + '/navigate'; }, 50);
setTimeout(() => { location.href = 'data:text/html,' + encodeURIComponent(${JSON.stringify(dataPayload)}); }, 150);
setTimeout(() => { location.href = URL.createObjectURL(new Blob([${JSON.stringify(blobPayload)}], {type:'text/html'})); }, 300);
</script></body>`;
          return { sse: sseToolCall('app_write_file', { path: 'index.html', content }) };
        }
        return { sse: sseText('APP-ACTOR-WROTE') };
      }
      // ACTOR (ephemeral): create, capture the app id from the result, delegate.
      if (body.includes('You are an EPHEMERAL ACTOR')) {
        actorAppState.childCalls += 1;
        if (actorAppState.childCalls === 1) return { sse: sseToolCall('sandbox_create', { kind: 'app', name: 'Lava', files: { 'index.html': '<!-- placeholder -->' } }) };
        if (!actorAppState.appId) { const m = body.match(/app-[a-z0-9]+-[a-z0-9]+/); if (m) actorAppState.appId = m[0]; }
        if (actorAppState.childCalls === 2) return { sse: sseToolCall('message_actor', { to: actorAppState.appId || 'app-unknown', message: 'write the real lava lamp code into index.html' }) };
        return { sse: sseText('CHILD-BUILT-APP') };
      }
      // ORCHESTRATOR — spawn a DEFAULT-toolset actor (tools omitted) to build.
      if (actorAppState.spawned === 0) {
        actorAppState.spawned += 1;
        return { sse: sseToolCall('actor_create', { task: 'build a lava lamp app', sync: true }) };
      }
      return { sse: sseText('FINAL-APP-BUILT') };
    },
    async run(ctx, rec) {
      actorAppState = { spawned: 0, childCalls: 0, appCalls: 0, appId: null };
      let probeHits = 0;
      let stunHits = 0;
      const server = createServer((_req, res) => {
        probeHits += 1;
        res.writeHead(204); res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      actorAppProbeUrl = `http://127.0.0.1:${port}`;
      const stunServer = createSocket('udp4');
      stunServer.on('message', () => { stunHits += 1; });
      await new Promise((resolve) => stunServer.bind(0, '127.0.0.1', resolve));
      actorAppStunPort = /** @type {{ port: number }} */ (stunServer.address()).port;
      let appPage = null;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'spawn an actor to build a lava lamp app' });
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
      // the app id came back into the actor's heap → it could delegate to that exact app
        rec.check("the actor's sandbox_create result (the new app id) re-entered its heap", typeof actorAppState.appId === 'string' && actorAppState.appId.startsWith('app-'), `appId=${actorAppState.appId}`);
        rec.check('the actor reached the freshly-created app actor (delegation worked)', msgActorRan === true && actorAppState.appCalls >= 1, `msgActorRan=${msgActorRan} appActorCalls=${actorAppState.appCalls}`);
        rec.check('the app actor wrote the real file (app_write_file executed)', appWriteRan === true, `appWriteRan=${appWriteRan}`);
        rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('FINAL-APP-BUILT'));

        appPage = await openExtPage(ctx, `engine-tabs/app-tab/index.html#${actorAppState.appId}`);
        const rendered = await waitFor(() => evalIn(appPage, `
          document.title === 'peerd · Lava'
          && document.getElementById('boot')?.classList.contains('is-hidden')
          && !document.getElementById('boot')?.classList.contains('is-failed')
        `),
          { budgetMs: 12_000, pollMs: 200 });
        await sleep(1_200);
        rec.check('the real manifest-sandboxed App rendered', !!rendered);
        rec.check('fetch, passive resource, Worker fetch, and self-navigation made zero network hits', probeHits === 0, `hits=${probeHits}`);
        rec.check('the App frame stayed on the peerd runner after blocked self-navigation',
          await evalIn(appPage, `document.querySelector('#app-frame')?.src.includes('/runner.html')`) === true);
        rec.check('the WebRTC fail-closed preflight allowed App delivery', !!rendered);
        rec.check('data: and blob: replacement realms cannot emit WebRTC STUN traffic', stunHits === 0, `udpHits=${stunHits}`);
        await rec.shot('final');
      } finally {
        try { appPage?.close(); } catch { /* */ }
        await new Promise((resolve) => server.close(resolve));
        stunServer.close();
        actorAppProbeUrl = '';
        actorAppStunPort = 0;
      }
    },
  },
];
