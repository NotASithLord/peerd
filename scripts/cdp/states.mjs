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
import {
  rpc, evalIn, waitFor, sseText, sseToolCall, sseToolCalls, openExtPage, openWidePage, attach,
  sleep, setEmulatedTheme, PASSPHRASE, PANEL_METRICS, NARROW_PANEL_METRICS,
  NETWORK_GUARD_CONTROLLER_PORT,
} from './e2e-harness.mjs';

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

const auditEntries = async (ctx, limit = 800) => {
  const audit = await rpc(ctx.page, { type: 'audit/list', limit });
  return (audit && audit.entries) || [];
};

const actorIsolationEvidence = (entries) => {
  const isolated = entries.filter((entry) => entry.type === 'actor_ran_isolated');
  return {
    isolated,
    exactProof: isolated.length > 0 && isolated.every((entry) =>
      entry.details?.workerType === 'dedicated'
        && entry.details?.realmVerified === true),
    backgroundRefused: entries.some((entry) => entry.type === 'actor_background_turn_refused'),
    isolationFailed: entries.some((entry) => entry.type === 'actor_isolation_failure'),
  };
};

// Transfer routes require the exact options-page channel. Keep the live E2E on
// that production boundary instead of calling the generic dispatcher.
const privateTransferRpc = (page, message) => evalIn(page, `(async () => {
  const { callPrivateTransfer } = await import('/options/private-transfer-session.js');
  return callPrivateTransfer(${JSON.stringify(message)});
})()`, true);

// The raw CDP handle's close() disconnects the debugger but does not close the
// tab. Navigate private-transfer fixtures away first so the next exact-client
// assertion cannot inherit an old options document from an earlier state.
const retirePrivateTransferPage = async (page) => {
  await page.send('Page.navigate', { url: 'about:blank' });
  const retired = await waitFor(() => evalIn(page, `location.href === 'about:blank'`),
    { budgetMs: 5_000, pollMs: 50 });
  if (!retired) throw new Error('private transfer fixture did not retire');
  try { page.close(); } catch { /* */ }
};

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
let actorBoundaryState = { delegates: 0 };
let scriptFanState = { scripts: 0, seen: [] };
let dwebActorState = { delegates: 0, actorCalls: 0 };
let a2aState = { delegates: 0, actorCalls: 0 };
// heap-split phase 1: the offscreen pure-reasoning actor state.
let reasoningState = { spawned: 0, childCalls: 0 };
let actorChannelTargetState = { spawned: 0, childCalls: 0 };
// heap-split phase 4: the offscreen TOOL-BEARING actor state.
let actorToolsState = { spawned: 0, childCalls: 0 };
// issue #324: an offscreen actor delegating FROM its granted script surface.
let actorCodeDelegatesState = {
  spawned: 0, childCalls: 0, webCalls: 0, sawComposedResult: false,
};
// heap-split phase 4: an offscreen actor DELEGATING to its own web actor.
let actorDelegatesState = { spawned: 0, childCalls: 0, webCalls: 0 };
let actorFabricHierarchyState = {
  spawned: 0, nestedCalls: 0, siblingCalls: 0, webCalls: 0,
};
let actorOverviewState = {
  alphaSpawned: 0, betaSpawned: 0,
  liveGate: Promise.resolve(), releaseLive: () => {},
};
// heap-split phase 4: an offscreen actor BUILDING an app (create + delegate).
let actorAppState = { spawned: 0, childCalls: 0, appCalls: 0, appId: null };
let actorAppProbeUrl = '';
let actorAppStunPort = 0;

const toolResultsIn = (postData) => {
  try {
    const body = JSON.parse(postData);
    return (body.messages ?? [])
      .filter((message) => message?.role === 'tool')
      .map((message) => typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content));
  } catch { return []; }
};

// --- harvest: the FULL personal-data flow, incl. reading a real page ---------
// An order page served locally through a reserved public-looking .test name.
// The order lines are anchor text so the web actor returns them as visible text.
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
// itself and reads
// it (read_page). We capture the actor request that carries the read_page RESULT
// to PROVE the actor genuinely read the live page, and sequence the actor's
// navigate→read→report turns and the orchestrator's post-reply index→answer turns
// independently (interleaving slots make callIndex fragile).
let harvestActorSawPage = '';
let harvestActorTurn = 0;
let harvestOrchTurn = 0;
let harvestDelegated = false;
let harvestActorUsedCode = false;
let harvestFixtureUrl = '';
let numericTabAuthorityState = {
  addressed: false,
  tabId: null, refusalBody: '', actorCallsAfterAddress: 0,
};
let numericTabAuthorityRequestBodies = [];
let numericTabAuthorityRedirectUrl = '';
let idpTransitState = { addressed: 0, siteRefusal: '', bareRefusal: '', actorCalls: 0 };
let idpTransitRequestBodies = [];
let networkGuardActorTurn = 0;
let networkGuardDelegated = false;
let networkGuardActorReady = false;
let networkGuardActorResult = '';
let networkGuardFixtureUrl = '';
let networkGuardActorTask = 'open';
let networkGuardTrustedBurstComplete = false;
let networkGuardWakeSettled = false;

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
// The harness maps reserved `*.peerd.test` names to loopback. This keeps the
// fixture public under the product's lexical host policy while remaining local.
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
let siteNumericTarget = null;
let siteNumericAddressed = false;
let siteNumericRefusalBody = '';
let siteNumericActorCalls = 0;
let lockActorTurn = 0;
let lockDelegated = false;
let lockReportBody = '';
let lockFixtureUrl = '';

const captureHomeLibraryGit = async (ctx, rec, { visualName, metrics, revealPanel = false }) => {
  const imported = await evalIn(ctx.page, `(async () => {
    const { buildAppExport } = await import('/peerd-engine/index.js');
    const envelope = await buildAppExport({
      record: { name: 'Versioned App', entryFile: 'index.html', tags: ['visual-fixture'] },
      files: { 'index.html': '<!doctype html><title>Versioned App</title><main>Hello</main>' },
    });
    return chrome.runtime.sendMessage({ type: 'import/apply', envelope });
  })()`, true);
  rec.check('visual fixture App imported with a Git repository', imported?.ok && imported?.kind === 'app', JSON.stringify(imported));
  const appId = imported?.id ?? '';
  const cardSelector = `.library-card[data-app-id="${appId}"]`;
  let page = null;
  try {
    const branched = appId ? await evalIn(ctx.page,
      `chrome.runtime.sendMessage({ type: 'apps/repository/branch', appId: ${JSON.stringify(appId)}, name: 'feature/visual', checkout: true })`, true) : null;
    rec.check('visual fixture exposes existing-branch switching', branched?.ok === true, JSON.stringify(branched));
    page = await openWidePage(ctx, 'home/home.html#library', { metrics });
    const libraryReady = await waitFor(() => evalIn(page, `
      document.querySelector('[data-home-view="library"]')?.getAttribute('aria-current') === 'page'
        && !!document.querySelector('.library-grid')
    `), { budgetMs: 15_000, pollMs: 80 });
    rec.check('visual fixture opens the Library route', !!libraryReady);
    const appReady = await waitFor(() => evalIn(page,
      `!!document.querySelector(${JSON.stringify(cardSelector)})`),
    { budgetMs: 20_000, pollMs: 80 });
    rec.check('visual fixture App appears in the Library', !!appReady);
    await evalIn(page, `document.querySelector(${JSON.stringify(cardSelector)})?.querySelector('.library-kebab')?.click()`);
    const historyActionReady = await waitFor(() => evalIn(page, `!![...document.querySelector(${JSON.stringify(cardSelector)})?.querySelectorAll('.library-menu-item') ?? []].find((button) => button.textContent === 'History & Git')`),
      { budgetMs: 5_000, pollMs: 50 });
    rec.check('visual fixture exposes the History and Git action', !!historyActionReady);
    await evalIn(page, `[...document.querySelector(${JSON.stringify(cardSelector)})?.querySelectorAll('.library-menu-item') ?? []].find((button) => button.textContent === 'History & Git')?.click()`);
    const historyReady = await waitFor(() => evalIn(page,
      `!!document.querySelector(${JSON.stringify(`${cardSelector} .library-repository .library-commit`)})`),
    { budgetMs: 20_000, pollMs: 80 });
    rec.check('visual fixture renders repository history', !!historyReady);
    // Git commit IDs include the commit timestamp, and the rows carry RELATIVE
    // times, so this visual fixture must normalize both before capture. The
    // surrounding branch, history, controls, and layout remain
    // production-rendered; only the inherently run-specific values are replaced.
    const pinVisualState = () => evalIn(page, `(() => {
      const card = document.querySelector(${JSON.stringify(cardSelector)});
      const fixedOid = '0000000000';
      const fixedWhen = 'just now';
      const head = card?.querySelector('.library-repository-head .muted');
      if (head) head.textContent = head.textContent.replace(/[0-9a-f]{10}$/i, fixedOid);
      for (const oid of card?.querySelectorAll('.library-commit code') ?? []) oid.textContent = fixedOid;
      // why: fmtWhen rounds to the nearest minute, so 'just now' becomes '1m ago'
      // at 30s, well inside this state's ~60s of waitFor budget. Unpinned, it
      // flips either between runs (both themes drift) or between the two shots
      // ~100ms apart (dark alone drifts, and the state flaps on dark forever).
      for (const when of card?.querySelectorAll('.library-commit > span.muted') ?? []) when.textContent = fixedWhen;
      // The app row renders fmtWhen as a bare leading text node followed by an
      // optional ' · source' sibling, so replace that node rather than the box.
      const meta = card?.querySelector('.library-meta');
      const metaWhen = meta?.firstChild;
      if (metaWhen?.nodeType === 3 && metaWhen.nodeValue.trim()) metaWhen.nodeValue = fixedWhen;
      const commit = card?.querySelector('.library-commit');
      const scroller = card?.closest('.home-content');
      if (${JSON.stringify(revealPanel)} && commit && scroller) {
        const commitRect = commit.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        scroller.scrollTop += commitRect.top - scrollerRect.top
          - Math.max(0, (scroller.clientHeight - commitRect.height) / 2);
      }
      const commitRect = commit?.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      return {
        commitTop: commitRect?.top ?? null,
        commitBottom: commitRect?.bottom ?? null,
        scrollerTop: scrollerRect?.top ?? null,
        scrollerBottom: scrollerRect?.bottom ?? null,
      };
    })()`);
    const settleNarrowCamera = async () => {
      await pinVisualState();
      await sleep(80);
      return pinVisualState();
    };
    const visualState = revealPanel ? await settleNarrowCamera() : await pinVisualState();
    if (revealPanel) {
      // why the explicit number guard: the rects are `?? null` on a miss, and
      // `null >= null` coerces to `0 >= 0`, i.e. true. Without it a missing
      // commit row or scroller passes this check silently.
      const framed = [visualState?.commitTop, visualState?.commitBottom,
        visualState?.scrollerTop, visualState?.scrollerBottom].every((v) => typeof v === 'number');
      rec.check('visual fixture keeps the narrow commit row in frame',
        framed
          && visualState.commitTop >= visualState.scrollerTop
          && visualState.commitBottom <= visualState.scrollerBottom,
        JSON.stringify(visualState));
    }
    // why: a peer notification landing mid-capture leaks an unread badge into the
    // top bar. That is global chrome, nothing to do with this fixture, and it is
    // exactly the drift that reaches the SECOND shot alone. home-fulltab already
    // quiets them the same way before each theme.
    const quietNotifications = async () => {
      await evalIn(page, `import('/shared/peer-notifications.js')
        .then(({ peerNotifications }) => peerNotifications.clear())`, true);
      await waitFor(() => evalIn(page, `!document.querySelector('.notif-badge, .notif-banner')`),
        { budgetMs: 2_000, pollMs: 25 });
    };
    // why beforeShot on BOTH paths: the two theme captures are ~100ms apart, so
    // the pinned oid and relative times have to be re-applied for the second one
    // or whatever moved in that window lands in the dark shot alone.
    const beforeShot = async () => {
      await quietNotifications();
      return revealPanel ? settleNarrowCamera() : pinVisualState();
    };
    await rec.visualPage(visualName, page, { beforeShot });
  } finally {
    try { page?.close(); } catch { /* */ }
    if (appId) {
      const deleted = await evalIn(ctx.page,
        `chrome.runtime.sendMessage({ type: 'apps/delete', appId: ${JSON.stringify(appId)} })`, true)
        .catch(() => null);
      rec.check('visual fixture App removed after capture', deleted?.ok === true, JSON.stringify(deleted));
    }
  }
};

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
    },
  },

  // --- functional: Chrome accepts and installs the private-network floor ---
  {
    name: 'browser-network-rules', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const result = await evalIn(ctx.page, `(async () => {
          const rules = await import(chrome.runtime.getURL('peerd-egress/denylist/dnr-rules.js'));
          const validations = await Promise.all(
            rules.PRIVATE_NETWORK_REGEX_RULES.map(async ({ id, regex }) => ({
              id,
              ...await chrome.declarativeNetRequest.isRegexSupported({
                regex,
                isCaseSensitive: false,
              }),
            })),
          );
          const tab = await chrome.tabs.getCurrent();
          const testIdOffset = 1000;
          const candidates = rules.buildPrivateNetworkBlockRules({
            tabIds: [tab.id],
            resourceTypes: rules.CHROME_DNR_RESOURCE_TYPES,
          })
            .map((rule) => ({ ...rule, id: rule.id + testIdOffset }));
          const testRuleIds = candidates.map((rule) => rule.id);
          try {
            await chrome.declarativeNetRequest.updateSessionRules({
              removeRuleIds: testRuleIds,
              addRules: candidates,
            });
            const installed = await chrome.declarativeNetRequest.getSessionRules();
            return {
              validations,
              expectedRuleIds: testRuleIds,
              privateRuleIds: installed
                .filter((rule) => testRuleIds.includes(rule.id))
                .map((rule) => rule.id)
                .sort((left, right) => left - right),
            };
          } finally {
            await chrome.declarativeNetRequest.updateSessionRules({
              removeRuleIds: testRuleIds,
            });
          }
        })()`, true);
      const evaluationDetail = JSON.stringify(result);
      rec.check('Chrome accepts every private-network request regex',
        result?.validations?.every(({ isSupported }) => isSupported === true) === true,
        JSON.stringify(result?.validations) ?? evaluationDetail);
      rec.check('all private-network session rules are installed',
        JSON.stringify(result?.privateRuleIds) === JSON.stringify(result?.expectedRuleIds), evaluationDetail);
    },
  },

  // --- functional: private targets never receive a driven-tab request -----
  {
    name: 'browser-network-floor', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>')) {
        if (networkGuardActorTurn > 0) {
          const results = toolResultsIn(body).join('\n');
          networkGuardActorResult = results;
          if (networkGuardActorTask === 'open' && results.includes('network-guard-controller')) {
            networkGuardActorReady = true;
          }
          if (networkGuardActorTask === 'trusted-blank-burst' && results.includes('clicked')) {
            networkGuardTrustedBurstComplete = true;
          }
        }
        const turn = networkGuardActorTurn++;
        if (body.includes('tools: page_code')) {
          if (turn === 0) {
            return { sse: sseToolCall('page_code', {
              code: networkGuardActorTask === 'trusted-blank-burst'
                ? 'await page.snapshot(); return await page.click("@e1");'
                : `await page.goto(${JSON.stringify(networkGuardFixtureUrl)}); return await page.content();`,
            }) };
          }
          return { sse: sseText('The network guard controller is ready.') };
        }
        if (turn === 0) return { sse: sseToolCall('navigate', { url: networkGuardFixtureUrl }) };
        if (turn === 1) return { sse: sseToolCall('read_page', {}) };
        return { sse: sseText('The network guard controller is ready.') };
      }
      if (networkGuardActorReady) networkGuardWakeSettled = true;
      if (!networkGuardDelegated) {
        networkGuardDelegated = true;
        return { sse: sseToolCall('message_actor', {
          to: 'web',
          message: networkGuardActorTask === 'trusted-blank-burst'
            ? 'Click the only button on the current controller page.'
            : `Open ${networkGuardFixtureUrl} and report when the controller is ready.`,
        }) };
      }
      return { sse: sseText('The browser network test is delegated.') };
    },
    async run(ctx, rec) {
      networkGuardActorTurn = 0;
      networkGuardDelegated = false;
      networkGuardActorReady = false;
      networkGuardActorResult = '';
      networkGuardActorTask = 'open';
      networkGuardTrustedBurstComplete = false;
      networkGuardWakeSettled = false;
      let probeConnections = 0;
      let probeRequests = [];
      let controllerRequests = 0;
      let ordinaryControllerRequests = 0;
      let sensitiveChildRequests = 0;
      const controllerAttempts = new Set();
      const probeServer = createServer((req, res) => {
        probeRequests.push(req.url ?? '/');
        res.writeHead(204, { connection: 'close' });
        res.end();
      });
      probeServer.on('connection', () => { probeConnections += 1; });
      probeServer.on('upgrade', (req, socket) => {
        probeRequests.push(req.url ?? '/');
        socket.destroy();
      });
      const controllerServer = createServer((req, res) => {
        controllerRequests += 1;
        const requestUrl = new URL(req.url ?? '/', 'http://orders.peerd.test');
        if (requestUrl.pathname === '/sensitive-child') {
          sensitiveChildRequests += 1;
          res.end('<!doctype html><title>sensitive-child-leaked</title>');
          return;
        }
        if (requestUrl.pathname === '/ordinary-quarantine') {
          ordinaryControllerRequests += 1;
          const fetchTarget = `http://127.0.0.1:${probePort}/probe?vector=ordinary-fetch`;
          const socketTarget = `ws://127.0.0.1:${probePort}/probe?vector=ordinary-websocket`;
          res.end(`<!doctype html><title>ordinary-quarantine-ready</title>
            <main>ordinary-quarantine-ready</main><script>
              fetch(${JSON.stringify(fetchTarget)}, { mode: 'no-cors' }).catch(() => {});
              const socket = new WebSocket(${JSON.stringify(socketTarget)});
              socket.addEventListener('error', () => {}, { once: true });
            <\/script>`);
          return;
        }
        if (requestUrl.pathname === '/attempt') {
          controllerAttempts.add(requestUrl.searchParams.get('vector') ?? '');
          res.writeHead(204);
          res.end();
          return;
        }
        if (requestUrl.pathname === '/worker.js') {
          res.writeHead(200, {
            'content-type': 'application/javascript',
            'service-worker-allowed': '/',
            'cache-control': 'no-store',
          });
          res.end(`self.addEventListener('install', () => self.skipWaiting());
            self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
            self.addEventListener('message', (event) => {
              const { fetchUrl, socketUrl, token } = event.data || {};
              event.waitUntil((async () => {
                await fetch('/attempt?vector=worker-' + encodeURIComponent(token)
                  + '-websocket-' + typeof WebSocket, { cache: 'no-store' });
                const fetchDone = fetch(fetchUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
                const socketDone = new Promise((resolve) => {
                  let socket;
                  const timer = setTimeout(resolve, 4_000);
                  const finish = () => { clearTimeout(timer); try { socket?.close(); } catch {} resolve(); };
                  try {
                    socket = new WebSocket(socketUrl);
                    socket.addEventListener('open', finish, { once: true });
                    socket.addEventListener('error', finish, { once: true });
                  } catch { finish(); }
                });
                await Promise.all([fetchDone, socketDone]);
                event.source?.postMessage({ peerdNetworkGuardToken: token });
              })());
            });`);
          return;
        }
        res.setHeader('content-type', 'text/html');
        res.setHeader('connection', 'close');
        if (requestUrl.pathname === '/redirect') {
          const target = `http://127.0.0.1:${probePort}/probe?vector=redirect`;
          res.writeHead(302, { location: target });
          res.end();
          return;
        }
        if (requestUrl.pathname === '/meta') {
          const target = `http://127.0.0.1:${probePort}/probe?vector=meta`;
          res.end(`<!doctype html><meta http-equiv="refresh" content="0;url=${target}">`);
          return;
        }
        if (requestUrl.pathname === '/script') {
          const target = `http://127.0.0.1:${probePort}/probe?vector=script`;
          res.end(`<!doctype html><script>location.href=${JSON.stringify(target)}<\/script>`);
          return;
        }
        if (requestUrl.pathname === '/cross-frame-popup') {
          const target = `http://127.0.0.1:${probePort}/probe?vector=cross-frame-popup`;
          res.end(`<!doctype html><script>
            navigator.sendBeacon('/attempt?vector=cross-frame-popup');
            const link = document.createElement('a');
            link.href = ${JSON.stringify(target)};
            link.target = '_blank';
            document.body.append(link);
            link.click();
          <\/script>`);
          return;
        }
        if (requestUrl.pathname === '/cross-frame-blank') {
          const target = `http://127.0.0.1:${probePort}/probe?vector=cross-frame-blank`;
          res.end(`<!doctype html><script>
            const name = 'private-child-' + Math.random();
            const link = document.createElement('a');
            link.href = 'about:blank';
            link.target = name;
            document.body.append(link);
            link.click();
            const child = window.open('', name);
            if (child) {
              navigator.sendBeacon('/attempt?vector=cross-frame-blank');
              child.fetch(${JSON.stringify(target)}, { mode: 'no-cors' }).catch(() => {});
            }
          <\/script>`);
          return;
        }
        const trustedTarget = `http://127.0.0.1:${probePort}/probe?vector=trusted-click-blank`;
        const sensitiveTarget = `http://chase.com:${NETWORK_GUARD_CONTROLLER_PORT}/sensitive-child`;
        const dataTarget = `data:text/html,${encodeURIComponent(`<script>fetch(${JSON.stringify(
          `http://127.0.0.1:${probePort}/probe?vector=data-child`,
        )}).catch(()=>{})</script>`)}`;
        res.end(`<!doctype html><title>network-guard-controller</title>
          <h1>network-guard-controller</h1>
          <button id="trusted-blank-burst">Open child</button>
          <script>
            navigator.serviceWorker.register('/worker.js');
            document.querySelector('#trusted-blank-burst').addEventListener('click', () => {
              const child = window.open(${JSON.stringify(trustedTarget)}, 'trusted-private-child');
              if (child) {
                navigator.sendBeacon('/attempt?vector=trusted-click-blank');
                child.fetch(${JSON.stringify(trustedTarget)}, { mode: 'no-cors' }).catch(() => {});
              }
              const sensitive = window.open(${JSON.stringify(sensitiveTarget)}, 'trusted-sensitive-child');
              if (sensitive) navigator.sendBeacon('/attempt?vector=trusted-sensitive-child');
              const opaque = window.open(${JSON.stringify(dataTarget)}, 'trusted-data-child');
              if (opaque) navigator.sendBeacon('/attempt?vector=trusted-data-child');
            });
          <\/script>`);
      });
      await Promise.all([
        new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve)),
        new Promise((resolve, reject) => controllerServer
          .once('error', reject)
          .listen(NETWORK_GUARD_CONTROLLER_PORT, '127.0.0.1', resolve)),
      ]);
      const probePort = /** @type {{ port: number }} */ (probeServer.address()).port;
      networkGuardFixtureUrl = `http://orders.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT}/`;
      const resetProbe = async () => {
        await sleep(100);
        probeConnections = 0;
        probeRequests = [];
      };
      try {
        const fixtureTab = await evalIn(ctx.page, `(async () => {
          const tab = await chrome.tabs.create({ active: false });
          try {
            const updated = await chrome.tabs.update(tab.id, {
              url: ${JSON.stringify(networkGuardFixtureUrl)},
            });
            return { tab, updated };
          } catch (error) {
            return { tab, error: String(error) };
          }
        })()`, true);
        // Cold Chrome can spend several seconds resolving the synthetic .test
        // host before the first byte reaches this fixture. This probes routing,
        // not latency; keep the budget above the measured cold-start tail.
        await waitFor(() => controllerRequests > 0, { budgetMs: 15_000, pollMs: 25 });
        rec.check('the public-looking controller fixture resolves locally',
          controllerRequests > 0, JSON.stringify({ controllerRequests, fixtureTab }));
        if (typeof fixtureTab?.tab?.id === 'number') {
          await evalIn(ctx.page, `chrome.tabs.remove(${fixtureTab.tab.id})`, true).catch(() => {});
        }

        const sent = await rpc(ctx.page, {
          type: 'agent/send',
          text: 'Open the browser network test controller and wait.',
        });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        const actorReady = await waitFor(() => networkGuardActorReady, {
          budgetMs: 30_000, pollMs: 100,
        });
        rec.check('the web actor loaded the public controller',
          actorReady === true, networkGuardActorResult.slice(0, 2000));
        await waitFor(async () => networkGuardWakeSettled && !(await probe(ctx)).busy,
          { budgetMs: 15_000, pollMs: 50 });
        const tabs = await evalIn(ctx.page, `chrome.tabs.query({}).then((items) => items.map(({ id, url, openerTabId }) => ({ id, url, openerTabId })))`, true);
        const drivenTab = tabs.find((tab) => tab.url?.startsWith(networkGuardFixtureUrl));
        const networkGuardDiagnostics = typeof drivenTab?.id === 'number'
          ? null
          : await evalIn(ctx.page, `(async () => {
            const definitions = await import(chrome.runtime.getURL('peerd-egress/denylist/dnr-rules.js'));
            const rules = (await chrome.declarativeNetRequest.getSessionRules())
              .filter((rule) => definitions.PRIVATE_NETWORK_RULE_IDS.includes(rule.id));
            const guardedTabIds = [...new Set(rules.flatMap((rule) => rule.condition?.tabIds ?? []))];
            const matches = [];
            for (const tabId of guardedTabIds) {
              matches.push({
                tabId,
                outcome: await chrome.declarativeNetRequest.testMatchOutcome({
                  url: ${JSON.stringify(networkGuardFixtureUrl)},
                  type: 'main_frame',
                  tabId,
                }),
              });
            }
            return { guardedTabIds, matches, rules };
          })()`, true).catch((error) => ({ error: String(error) }));
        rec.check('the controller is owned by the production web actor',
          typeof drivenTab?.id === 'number', JSON.stringify({ tabs, networkGuardDiagnostics }));
        if (typeof drivenTab?.id !== 'number') throw new Error('driven controller tab not found');
        const productionRules = await evalIn(ctx.page, `(async () => {
          const rules = await import(chrome.runtime.getURL('peerd-egress/denylist/dnr-rules.js'));
          const installed = await chrome.declarativeNetRequest.getSessionRules();
          return {
            expected: rules.PRIVATE_NETWORK_RULE_IDS,
            scoped: installed
              .filter((rule) => rules.PRIVATE_NETWORK_RULE_IDS.includes(rule.id)
                && rule.condition?.tabIds?.includes(${drivenTab.id}))
              .map((rule) => rule.id)
              .sort((left, right) => left - right),
          };
        })()`, true);
        rec.check('production private-network rules are scoped to the driven tab',
          JSON.stringify(productionRules.scoped) === JSON.stringify(productionRules.expected),
          JSON.stringify(productionRules));

        const baselineUrl = `http://127.0.0.1:${probePort}/probe?vector=user-tab`;
        const userTab = await evalIn(ctx.page, `chrome.tabs.create({ url: ${JSON.stringify(baselineUrl)}, active: false })`, true);
        await waitFor(() => probeRequests.length > 0, { budgetMs: 5_000, pollMs: 25 });
        rec.check('an ordinary user tab can still reach the private probe',
          probeRequests.length > 0 && probeConnections > 0,
          JSON.stringify({ probeConnections, probeRequests }));
        if (typeof userTab?.id === 'number') {
          await evalIn(ctx.page, `chrome.tabs.remove(${userTab.id})`, true).catch(() => {});
        }

        await resetProbe();
        networkGuardActorTask = 'trusted-blank-burst';
        networkGuardActorTurn = 0;
        networkGuardDelegated = false;
        networkGuardActorResult = '';
        networkGuardTrustedBurstComplete = false;
        networkGuardWakeSettled = false;
        const burstTabIdsBefore = new Set((await evalIn(ctx.page,
          'chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))', true))
          .filter((id) => typeof id === 'number'));
        const burstSent = await rpc(ctx.page, {
          type: 'agent/send',
          text: 'Click the controller button once.',
        });
        rec.check('trusted child-burst turn accepted', !!burstSent?.ok, JSON.stringify(burstSent));
        const burstComplete = await waitFor(() => networkGuardTrustedBurstComplete, {
          budgetMs: 30_000, pollMs: 100,
        });
        await sleep(800);
        const burstTabs = await evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) =>
          tabs.map(({ id, openerTabId, url, pendingUrl, status }) => ({ id, openerTabId, url, pendingUrl, status })))`, true);
        const burstObserved = {
          completed: burstComplete === true,
          attempted: controllerAttempts.has('trusted-click-blank'),
          connections: probeConnections,
          requests: [...probeRequests],
          tabs: burstTabs,
        };
        rec.check('the trusted click reaches its about:blank child action',
          burstObserved.completed && burstObserved.attempted, JSON.stringify(burstObserved));
        rec.check('Chrome immediate-child private requests do not reach the network',
          burstObserved.connections === 0 && burstObserved.requests.length === 0
            && sensitiveChildRequests === 0,
          JSON.stringify(burstObserved));
        rec.check('the trusted click exercised private, sensitive, and opaque child paths',
          ['trusted-click-blank', 'trusted-sensitive-child', 'trusted-data-child']
            .every((vector) => controllerAttempts.has(vector)),
          JSON.stringify([...controllerAttempts]));
        rec.check('the protected child is closed instead of left as a blank tab',
          !burstTabs.some((tab) => !burstTabIdsBefore.has(tab.id) && tab.openerTabId === drivenTab.id),
          JSON.stringify(burstTabs));
        rec.check('the source actor receives the fixed child policy outcome',
          networkGuardActorResult.includes('protected_child_navigation')
            && networkGuardActorResult.includes('closed')
            && burstObserved.connections === 0 && burstObserved.requests.length === 0
            && !networkGuardActorResult.includes(`127.0.0.1:${probePort}`),
          networkGuardActorResult.slice(0, 2000));

        await resetProbe();
        const activeBeforeOrdinary = await evalIn(ctx.page,
          'chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.id)', true);
        const ordinaryUrl = `http://acct.peerd.test:${NETWORK_GUARD_CONTROLLER_PORT}/ordinary-quarantine`;
        const ordinaryStartedAt = Date.now();
        const ordinaryTab = await evalIn(ctx.page,
          `chrome.tabs.create({ url: ${JSON.stringify(ordinaryUrl)}, active: false })`, true);
        const ordinaryReady = typeof ordinaryTab?.id === 'number' && await waitFor(() =>
          evalIn(ctx.page, `chrome.scripting.executeScript({
            target: { tabId: ${ordinaryTab.id} },
            func: () => ({ title: document.title, body: document.body?.innerText ?? '',
              historyLength: history.length }),
          }).then((rows) => rows[0]?.result).catch(() => null)`, true).then((value) =>
            value?.title === 'ordinary-quarantine-ready' ? value : null), {
          budgetMs: 5_000, pollMs: 25,
        });
        await waitFor(() => probeRequests.filter((request) =>
          request.includes('ordinary-')).length >= 2, { budgetMs: 5_000, pollMs: 25 });
        const activeAfterOrdinary = await evalIn(ctx.page,
          'chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.id)', true);
        const ordinaryObserved = {
          elapsedMs: Date.now() - ordinaryStartedAt,
          routeRequests: ordinaryControllerRequests,
          probeRequests: probeRequests.filter((request) => request.includes('ordinary-')),
          page: ordinaryReady,
          activeBeforeOrdinary,
          activeAfterOrdinary,
        };
        rec.check('an ordinary post-arm page loads once without an error document',
          ordinaryObserved.routeRequests === 1
            && ordinaryReady?.title === 'ordinary-quarantine-ready'
            && ordinaryReady?.body.includes('ordinary-quarantine-ready')
            && ordinaryReady?.historyLength >= 1,
          JSON.stringify(ordinaryObserved));
        rec.check('the ordinary page keeps focus and its first localhost fetch and socket',
          activeAfterOrdinary === activeBeforeOrdinary
            && ordinaryObserved.probeRequests.filter((request) =>
              request.includes('ordinary-fetch')).length === 1
            && ordinaryObserved.probeRequests.filter((request) =>
              request.includes('ordinary-websocket')).length === 1
            && ordinaryObserved.elapsedMs < 5_000,
          JSON.stringify(ordinaryObserved));
        if (typeof ordinaryTab?.id === 'number') {
          await evalIn(ctx.page, `chrome.tabs.remove(${ordinaryTab.id})`, true).catch(() => {});
        }

        const runVector = async (vector) => {
          await resetProbe();
          const target = `${vector === 'websocket' ? 'ws' : 'http'}://127.0.0.1:${probePort}/probe?vector=${vector}`;
          await evalIn(ctx.page, `(async () => chrome.scripting.executeScript({
            target: { tabId: ${drivenTab.id} },
            world: 'MAIN',
            func: (kind, privateTarget, publicBase) => {
              const frame = (url, name = '') => {
                const node = document.createElement('iframe');
                if (name) node.name = name;
                node.hidden = true;
                node.src = url;
                document.body.append(node);
                return node;
              };
              if (kind === 'fetch') fetch(privateTarget).catch(() => {});
              if (kind === 'websocket') new WebSocket(privateTarget);
              if (kind === 'image') {
                const image = new Image();
                image.src = privateTarget;
                document.body.append(image);
              }
              if (kind === 'form') {
                const name = 'private-probe-frame';
                frame('about:blank', name);
                const form = document.createElement('form');
                form.method = 'post';
                form.action = privateTarget;
                form.target = name;
                document.body.append(form);
                form.submit();
              }
              if (['redirect', 'meta', 'script'].includes(kind)) {
                frame(publicBase + kind);
              }
              if (kind === 'popup') {
                const link = document.createElement('a');
                link.href = privateTarget;
                link.target = '_blank';
                document.body.append(link);
                link.click();
              }
              if (kind === 'cross-frame-popup') {
                const crossOrigin = publicBase.replace('orders.peerd.test', 'acct.peerd.test');
                frame(crossOrigin + 'cross-frame-popup');
              }
              if (kind === 'cross-frame-blank') {
                const crossOrigin = publicBase.replace('orders.peerd.test', 'acct.peerd.test');
                frame(crossOrigin + 'cross-frame-blank');
              }
              if (kind === 'location') location.href = privateTarget;
            },
            args: [${JSON.stringify(vector)}, ${JSON.stringify(target)}, ${JSON.stringify(networkGuardFixtureUrl)}],
          }))()`, true);
          await sleep(800);
          const observed = {
            connections: probeConnections,
            requests: [...probeRequests],
            attempted: controllerAttempts.has(vector),
          };
          if (['popup', 'cross-frame-popup', 'cross-frame-blank'].includes(vector)) {
            const children = await evalIn(ctx.page, `chrome.tabs.query({}).then((items) => items.filter((tab) => tab.openerTabId === ${drivenTab.id}).map((tab) => tab.id))`, true);
            for (const childId of children) {
              await evalIn(ctx.page, `chrome.tabs.remove(${childId})`, true).catch(() => {});
            }
          }
          return observed;
        };

        for (const vector of [
          'fetch', 'websocket', 'image', 'form', 'redirect', 'meta', 'script',
          'popup', 'cross-frame-popup', 'cross-frame-blank', 'location',
        ]) {
          const observed = await runVector(vector);
          if (vector === 'cross-frame-popup') {
            rec.check(`${vector} reaches its cross-origin action`, observed.attempted === true,
              JSON.stringify(observed));
          }
          rec.check(`${vector} causes no private TCP or HTTP side effect`,
            observed.connections === 0 && observed.requests.length === 0,
            JSON.stringify(observed));
        }

        // A blocked top-level navigation can leave Chrome displaying its
        // network error document. Return to the controlled fixture before the
        // worker lane so the test exercises the page worker, not an error page.
        await evalIn(ctx.page,
          `chrome.tabs.update(${drivenTab.id}, { url: ${JSON.stringify(networkGuardFixtureUrl)} })`, true);
        await waitFor(() => evalIn(ctx.page, `chrome.tabs.get(${drivenTab.id}).then((tab) =>
          tab.status === 'complete' && tab.url === ${JSON.stringify(networkGuardFixtureUrl)})`, true), {
          budgetMs: 5_000, pollMs: 25,
        });

        const workerRuleShape = await evalIn(ctx.page, `(async () => {
          const policy = await import(chrome.runtime.getURL('peerd-egress/index.js'));
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          return rules.filter((rule) => policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
        })()`, true);
        rec.check('the worker fetch floor is no-tab and limited to a visited page domain',
          workerRuleShape.length > 0 && workerRuleShape.every((rule) =>
            JSON.stringify(rule.condition?.tabIds) === JSON.stringify([-1])
              && JSON.stringify(rule.condition?.initiatorDomains) === JSON.stringify(['orders.peerd.test'])),
          JSON.stringify(workerRuleShape));
        const initiatorOutcomes = await evalIn(ctx.page, `Promise.all([
          chrome.declarativeNetRequest.testMatchOutcome({
            url: ${JSON.stringify(`http://127.0.0.1:${probePort}/probe?vector=dnr-match`)},
            type: 'xmlhttprequest', tabId: -1,
            initiator: ${JSON.stringify(new URL(networkGuardFixtureUrl).origin)},
          }),
          chrome.declarativeNetRequest.testMatchOutcome({
            url: ${JSON.stringify(`http://127.0.0.1:${probePort}/probe?vector=dnr-miss`)},
            type: 'xmlhttprequest', tabId: -1,
            initiator: ${JSON.stringify(new URL(networkGuardFixtureUrl.replace('orders.peerd.test', 'acct.peerd.test')).origin)},
          }),
          chrome.declarativeNetRequest.testMatchOutcome({
            url: ${JSON.stringify(`ws://127.0.0.1:${probePort}/probe?vector=dnr-socket-match`)},
            type: 'websocket', tabId: -1,
            initiator: ${JSON.stringify(new URL(networkGuardFixtureUrl).origin)},
          }),
        ])`, true).catch((error) => ({ error: String(error) }));
        rec.check('Chrome matches the no-tab rule only for the custodied initiator',
          Array.isArray(initiatorOutcomes)
            && initiatorOutcomes[0]?.matchedRules?.length > 0
            && initiatorOutcomes[1]?.matchedRules?.length === 0
            && initiatorOutcomes[2]?.matchedRules?.some(({ ruleId }) => ruleId >= 100),
          JSON.stringify(initiatorOutcomes));

        const attachWorkerMonitor = async (origin) => {
          const target = await waitFor(async () => {
            const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
            return targets.find((candidate) => candidate.type === 'service_worker'
              && candidate.url === `${origin}/worker.js`);
          }, { budgetMs: 5_000, pollMs: 25 });
          if (!target) return null;
          const events = [];
          const requests = new Map();
          const connection = await attach(target.webSocketDebuggerUrl, (method, params) => {
            if (method === 'Network.requestWillBeSent') {
              requests.set(params.requestId, params.request?.url ?? '');
            }
            if (method === 'Network.loadingFailed') {
              events.push({
                url: requests.get(params.requestId) ?? '',
                blockedReason: params.blockedReason ?? '',
                errorText: params.errorText ?? '',
              });
            }
            if (method === 'Network.webSocketCreated') {
              events.push({
                url: params.url ?? '',
                webSocketCreated: true,
                initiator: params.initiator ?? null,
              });
            }
          });
          await connection.send('Network.enable');
          return { connection, events };
        };
        const networkFailureFor = (monitor, token) => monitor?.events
          .find((event) => event.url.includes(token));
        const ordersWorkerMonitor = await attachWorkerMonitor(new URL(networkGuardFixtureUrl).origin);
        rec.check('Chrome exposes the fixture service worker to the network test',
          ordersWorkerMonitor !== null, JSON.stringify({ monitored: ordersWorkerMonitor !== null }));

        const triggerWorker = async (tabId, token) => evalIn(ctx.page, `(async () => {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: ${tabId} },
            world: 'MAIN',
            func: async (fetchUrl, socketUrl, workerToken) => {
              const registration = await navigator.serviceWorker.ready;
              const completed = new Promise((resolve) => {
                const finish = (value) => {
                  clearTimeout(timer);
                  navigator.serviceWorker.removeEventListener('message', onMessage);
                  resolve(value);
                };
                const onMessage = (event) => {
                  if (event.data?.peerdNetworkGuardToken === workerToken) finish(true);
                };
                const timer = setTimeout(() => finish(false), 6_000);
                navigator.serviceWorker.addEventListener('message', onMessage);
              });
              registration.active.postMessage({ fetchUrl, socketUrl, token: workerToken });
              return { secure: isSecureContext, active: !!registration.active, completed: await completed };
            },
            args: [
              ${JSON.stringify(`http://127.0.0.1:${probePort}/probe?vector=worker-fetch-${token}`)},
              ${JSON.stringify(`ws://127.0.0.1:${probePort}/probe?vector=worker-websocket-${token}`)},
              ${JSON.stringify(token)},
            ],
          });
          return injection?.result;
        })()`, true);

        await resetProbe();
        const guardedWorker = await triggerWorker(drivenTab.id, 'guarded');
        await waitFor(() => [...controllerAttempts]
          .some((value) => value === 'worker-guarded-websocket-function'), {
          budgetMs: 5_000, pollMs: 25,
        });
        await waitFor(() => networkFailureFor(ordersWorkerMonitor, 'worker-fetch-guarded')
          && probeRequests.some((request) => request.includes('worker-websocket-guarded')), {
          budgetMs: 5_000, pollMs: 25,
        });
        const guardedNetworkFailure = networkFailureFor(ordersWorkerMonitor, 'worker-fetch-guarded');
        rec.check('the public fixture has an active service worker with WebSocket support',
          guardedWorker?.secure === true && guardedWorker?.active === true
            && controllerAttempts.has('worker-guarded-websocket-function'),
          JSON.stringify({ guardedWorker, attempts: [...controllerAttempts] }));
        rec.check('the custodied page worker fetch causes no private-network side effect',
          !probeRequests.some((request) => request.includes('worker-fetch-guarded')),
          JSON.stringify({ probeConnections, probeRequests, events: ordersWorkerMonitor?.events }));
        rec.check('Chrome reports the custodied worker request as browser-policy blocked',
          guardedNetworkFailure?.errorText === 'net::ERR_BLOCKED_BY_CLIENT',
          JSON.stringify(guardedNetworkFailure));

        rec.check('Chrome worker WebSocket bypass remains visible to the regression test',
          probeRequests.some((request) => request.includes('worker-websocket-guarded')),
          JSON.stringify({ probeConnections, probeRequests, events: ordersWorkerMonitor?.events }));

        // Characterize the browser boundary directly. If even an unscoped
        // WebSocket rule does not see this request, adding wider peerd custody
        // cannot close the gap and would only disrupt unrelated browsing.
        await evalIn(ctx.page, `chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [4999],
          addRules: [{
            id: 4999,
            priority: 10,
            action: { type: 'block' },
            condition: {
              regexFilter: ${JSON.stringify('^wss?://(?:[^/]+@)?127\\.')},
              resourceTypes: ['websocket'],
            },
          }],
        })`, true);
        await resetProbe();
        await triggerWorker(drivenTab.id, 'unscoped-diagnostic');
        const unscopedAttempted = await waitFor(() => controllerAttempts
          .has('worker-unscoped-diagnostic-websocket-function'), {
          budgetMs: 5_000, pollMs: 25,
        });
        const unscopedReached = await waitFor(() => probeRequests
          .some((request) => request.includes('worker-websocket-unscoped-diagnostic')), {
          budgetMs: 5_000, pollMs: 25,
        });
        // This is a browser-characterization probe, not a peerd invariant.
        // Chrome 151 defers this service-worker socket until the unscoped rule
        // is removed; older lanes let it through. The strict product assertions
        // above and below remain scoped-rule isolation and unrelated browsing.
        rec.check('Chrome unscoped worker-WebSocket behavior is explicitly classified',
          unscopedAttempted === true,
          JSON.stringify({ mode: unscopedReached ? 'bypassed' : 'blocked-or-deferred',
            probeConnections, probeRequests, events: ordersWorkerMonitor?.events }));
        await evalIn(ctx.page, `chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [4999],
        })`, true);
        if (!unscopedReached) {
          await waitFor(() => probeRequests
            .some((request) => request.includes('worker-websocket-unscoped-diagnostic')), {
            budgetMs: 2_000, pollMs: 25,
          });
        }

        rec.check('the page-domain worker rule does not intercept the extension local provider',
          ctx.modelCallCount() > 0,
          JSON.stringify({ modelCalls: ctx.modelCallCount() }));

        const unrelatedUrl = networkGuardFixtureUrl.replace('orders.peerd.test', 'acct.peerd.test');
        const unrelatedTab = await evalIn(ctx.page,
          `chrome.tabs.create({ url: ${JSON.stringify(unrelatedUrl)}, active: false })`, true);
        await waitFor(async () => {
          if (!Number.isInteger(unrelatedTab?.id)) return false;
          const tab = await evalIn(ctx.page, `chrome.tabs.get(${unrelatedTab.id})`, true).catch(() => null);
          return tab?.status === 'complete';
        }, { budgetMs: 5_000, pollMs: 25 });
        await resetProbe();
        const unrelatedWorkerMonitor = await attachWorkerMonitor(new URL(unrelatedUrl).origin);
        const unrelatedWorker = await triggerWorker(unrelatedTab.id, 'unrelated');
        await waitFor(() => controllerAttempts.has('worker-unrelated-websocket-function')
          && probeRequests.some((request) => request.includes('worker-fetch-unrelated'))
          && probeRequests.some((request) => request.includes('worker-websocket-unrelated')),
        { budgetMs: 10_000, pollMs: 25 });
        const unrelatedNetworkFailure = networkFailureFor(unrelatedWorkerMonitor, 'worker-fetch-unrelated');
        rec.check('a different-origin user service worker remains outside peerd DNR custody',
          unrelatedWorker?.secure === true && unrelatedWorker?.completed === true
            && probeRequests.some((request) => request.includes('worker-fetch-unrelated'))
            && probeRequests.some((request) => request.includes('worker-websocket-unrelated')),
          JSON.stringify({ unrelatedWorker, unrelatedNetworkFailure, probeConnections, probeRequests }));
        unrelatedWorkerMonitor?.connection.close();
        await evalIn(ctx.page, `chrome.tabs.remove(${unrelatedTab.id})`, true).catch(() => {});

        await evalIn(ctx.page,
          `chrome.tabs.update(${drivenTab.id}, { url: ${JSON.stringify(unrelatedUrl)} })`, true);
        const retainedScope = await waitFor(() => evalIn(ctx.page, `(async () => {
          const policy = await import(chrome.runtime.getURL('peerd-egress/index.js'));
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          const workerRules = rules.filter((rule) => policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
          return workerRules.length > 0
            && workerRules.every((rule) =>
              JSON.stringify(rule.condition?.initiatorDomains) === JSON.stringify(['acct.peerd.test', 'orders.peerd.test']));
        })()`, true), { budgetMs: 5_000, pollMs: 25 });
        rec.check('navigation retains prior worker domains and adds the committed domain',
          retainedScope === true, JSON.stringify({ retainedScope }));

        const oldOriginTab = await evalIn(ctx.page,
          `chrome.tabs.create({ url: ${JSON.stringify(networkGuardFixtureUrl)}, active: false })`, true);
        await sleep(500);
        await resetProbe();
        const retainedWorker = await triggerWorker(oldOriginTab.id, 'retained');
        await waitFor(() => controllerAttempts.has('worker-retained-websocket-function'), {
          budgetMs: 5_000, pollMs: 25,
        });
        await waitFor(() => networkFailureFor(ordersWorkerMonitor, 'worker-fetch-retained')
          && probeRequests.some((request) => request.includes('worker-websocket-retained')), {
          budgetMs: 5_000, pollMs: 25,
        });
        const retainedNetworkFailure = networkFailureFor(ordersWorkerMonitor, 'worker-fetch-retained');
        rec.check('a previously visited worker domain remains guarded after navigation',
          retainedWorker?.secure === true
            && retainedNetworkFailure?.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
            && !probeRequests.some((request) => request.includes('worker-fetch-retained'))
            && probeRequests.some((request) => request.includes('worker-websocket-retained')),
          JSON.stringify({ retainedWorker, retainedNetworkFailure, probeConnections, probeRequests }));

        await evalIn(ctx.page, `chrome.tabs.remove(${drivenTab.id})`, true).catch(() => {});
        const releasedScope = await waitFor(() => evalIn(ctx.page, `(async () => {
          const policy = await import(chrome.runtime.getURL('peerd-egress/index.js'));
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          return rules.every((rule) =>
            !policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
        })()`, true), { budgetMs: 5_000, pollMs: 25 });
        rec.check('closing custody removes every visited worker-domain rule',
          releasedScope === true, JSON.stringify({ releasedScope }));

        await resetProbe();
        const releasedWorker = await triggerWorker(oldOriginTab.id, 'released');
        await waitFor(() => probeRequests.some((request) => request.includes('worker-fetch-released'))
          && probeRequests.some((request) => request.includes('worker-websocket-released')),
        { budgetMs: 5_000, pollMs: 25 });
        rec.check('after custody closes, worker fetch and WebSocket both reach the private probe',
          releasedWorker?.secure === true
            && probeRequests.some((request) => request.includes('worker-fetch-released'))
            && probeRequests.some((request) => request.includes('worker-websocket-released')),
          JSON.stringify({ releasedWorker, probeConnections, probeRequests }));
        await evalIn(ctx.page, `chrome.tabs.remove(${oldOriginTab.id})`, true).catch(() => {});
        ordersWorkerMonitor?.connection.close();
      } finally {
        probeServer.closeAllConnections?.();
        controllerServer.closeAllConnections?.();
        probeServer.close();
        controllerServer.close();
      }
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

      const restarted = await rpc(ctx.page, { type: 'dweb/base/start' });
      rec.check('the peer host starts under the restored identity after lease release',
        restarted?.ok === true && restarted?.running === true && restarted?.did === incoming.did,
        JSON.stringify(restarted));
      await retirePrivateTransferPage(transferPage);
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
      } finally { await retirePrivateTransferPage(page); }
    },
  },
  {
    name: 'options-transfer-conflict', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const seedPage = await openWidePage(ctx, 'options/options.html#!/transfer', { ready: '#exppass' });
      const localExport = await privateTransferRpc(seedPage, { type: 'transfer/export', passphrase: PASSPHRASE });
      let localDid = localExport?.payload?.dweb?.identityRecord?.did ?? null;
      let localReady = !!localDid;
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
        localDid = postBootstrap?.payload?.dweb?.identityRecord?.did ?? null;
        localReady = !!localDid;
      }
      await retirePrivateTransferPage(seedPage);
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
        const importReady = await waitFor(() => evalIn(page, `!!document.querySelector('#imppass')`),
          { budgetMs: 15_000, pollMs: 80 });
        if (!importReady) {
          const importState = await evalIn(page, `(() => ({
            alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
            fileCount: document.querySelector('#peerd-backup-file')?.files?.length ?? 0,
          }))()`);
          throw new Error(`backup inspection did not settle: ${JSON.stringify(importState)}`);
        }
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
        const pinIdentityText = () => evalIn(page, `(() => {
          const fixedExisting = 'did:key:z6MkqSmkPkM5RvkHP9izceLBE3trfq8XZFaLvUA7dgEcon8t';
          const fixedIncoming = 'did:key:z6MkeWmmVApVUxSNWsrKKvN21QdEpVcHLXG96hfLdrJyKfiC';
          const replacements = [
            [${JSON.stringify(localDid)}, fixedExisting],
            [${JSON.stringify(incoming?.record?.did ?? null)}, fixedIncoming],
          ].filter(([from]) => typeof from === 'string' && from.length > 0);
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            let text = node.textContent ?? '';
            for (const [from, to] of replacements) text = text.split(from).join(to);
            if (text !== node.textContent) node.textContent = text;
          }
          const rendered = document.body.textContent ?? '';
          return rendered.includes(fixedExisting) && rendered.includes(fixedIncoming);
        })()`);
        // why: the encrypted identities above must be real to exercise the
        // conflict path, but fresh keys make the rendered DIDs change on every
        // run. Pin only their displayed, same-length text after the security
        // flow completes so the visual gate still guards wrapping and emphasis.
        const identityTextReady = await waitFor(pinIdentityText, { budgetMs: 5000, pollMs: 50 });
        if (!identityTextReady) throw new Error('identity conflict text did not settle');
        await rec.visualPage('options-transfer-conflict', page, { beforeShot: pinIdentityText });
      } finally { await retirePrivateTransferPage(page); }
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
        () => evalIn(ctx.page, `(() => {
          const toggle = document.querySelector('.goal-toggle.is-running');
          if (!toggle) return null;
          return {
            bar: !!document.querySelector('.goal-bar'),
            label: toggle.textContent,
            session: document.querySelector('.message-list')?.getAttribute('data-session-id') ?? null,
          };
        })()`),
        { budgetMs: 8_000, pollMs: 50 });
      // The plan-of-record card appears once todo_init lands and ticks to 1/2
      // after todo_check — the visible checklist that answers "is it working?".
      const todoSeen = await waitFor(
        () => evalIn(ctx.page, `/1\\/2/.test(document.querySelector('.todo-card .todo-card-meta')?.textContent || '')`),
        { budgetMs: 30_000, pollMs: 50 });
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return !out.goalBar && !out.busy; }, { budgetMs: 25_000 });
      const calls = ctx.modelCallCount();
      rec.check('Goal bar appeared while driving', !!goalBarSeen);
      rec.check('Goal toggle read "running" while live (sticky, not untoggled)', !!toggleRunning,
        JSON.stringify(toggleRunning));
      rec.check('TodoCard rendered the plan and ticked to 1/2 after todo_check', !!todoSeen);
      rec.check('loop drove >1 autonomous turn', calls >= 3, `model calls: ${calls}`);
      rec.check('complete_goal ended it cleanly (not the cap)', !out.capped && calls < 12, `capped=${out.capped} calls=${calls}`);
      rec.check('run reaches terminal: Goal bar cleared + idle', out.goalBar === false && out.busy === false);
      // The finished checklist stays as the run's receipt (does not vanish on end).
      const todoAfter = await evalIn(ctx.page, `!!document.querySelector('.todo-card')`);
      rec.check('TodoCard persists after the run as its receipt', !!todoAfter);
      rec.check('submitted goal text round-trips as the first user message', !!out.userText && out.userText.includes('tidy the repo'), JSON.stringify(out.userText));
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
        if (harvestActorTurn > 0) harvestActorSawPage = toolResultsIn(body).join('\n');
        const t = harvestActorTurn++;
        if (body.includes('tools: page_code')) {
          harvestActorUsedCode = true;
          if (t === 0) return { sse: sseToolCall('page_code', {
            code: `await page.goto(${JSON.stringify(harvestFixtureUrl)}); return await page.content();`,
          }) };
          return { sse: sseText('Order #1001 — Coffee Mug — $12.00; Order #1002 — Notebook — $8.50; Order #1003 — Pen Set — $15.00') };
        }
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
      harvestActorUsedCode = false;
      // The web actor opens and reads the locally served fixture through the
      // real actor-model path. The harness maps the reserved .test host to this
      // server, so product localhost blocking remains active.
      const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ORDERS_HTML); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const fxPort = /** @type {{ port: number }} */ (server.address()).port;
      harvestFixtureUrl = `http://orders.peerd.test:${fxPort}/`;
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
        }, { budgetMs: 60_000 });

        rec.check('the orchestrator delegated the read via message_actor', harvestDelegated === true);
        rec.check('the web-actor sub-loop ran (page code + report, ≥2 actor model calls)', harvestActorTurn >= 2, `actor turns: ${harvestActorTurn}`);
        rec.check('the preview web actor used the code-first page surface', harvestActorUsedCode === true);
        // load-bearing proof: the web actor REALLY read the live page — the page's
        // own order text rode back into the actor's model request via read_page.
        rec.check('the web actor REALLY read the live page (real order data in its read result)',
          harvestActorSawPage.includes('Coffee Mug') && harvestActorSawPage.includes('12.00'),
          harvestActorSawPage.slice(0, 2000));
        rec.check('the harvested on-device answer renders', (out.bubbles || []).some((b) => /35\.50/.test(b)), JSON.stringify(out.bubbles));
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
        if (body.includes('tools: page_code')) {
          if (t === 0) return { sse: sseToolCall('page_code', {
            code: `await page.goto(${JSON.stringify(`${lockFixtureUrl}login`)}); return await page.snapshot();`,
          }) };
          if (t === 1) return { sse: sseToolCall('page_code', { code: 'return await page.snapshot();' }) };
          return { sse: sseText('LOCK-DID-NOT-FIRE: I read the signed-in page.') };
        }
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
      lockFixtureUrl = `http://acme.peerd.test:${port}/`;
      const fixtureOrigin = `http://acme.peerd.test:${port}`;
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
          reportOnly.length > 0 && !/acme\.peerd\.test:\\?\/*\d*\/?login/.test(reportOnly) && !reportOnly.includes('/login'),
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
      } finally {
        server.close();
      }
    },
  },

  // --- functional: issue 263, a redirected numeric id cannot mint authority --
  {
    name: 'numeric-tab-authority', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = (request && request.postData) || '';
      numericTabAuthorityRequestBodies.push(body);
      if (body.includes('<actor_agent>')) {
        numericTabAuthorityState.actorCallsAfterAddress++;
        return { sse: sseText('NUMERIC-ACTOR-RAN-ON-SENSITIVE-TAB') };
      }
      if (!numericTabAuthorityState.addressed && Number.isInteger(numericTabAuthorityState.tabId)) {
        numericTabAuthorityState.addressed = true;
        return { sse: sseToolCall('message_actor', {
          to: String(numericTabAuthorityState.tabId), message: 'Read this page',
        }) };
      }
      if (numericTabAuthorityState.addressed && body.includes('actor_sensitive_tab_requires_site')) {
        numericTabAuthorityState.refusalBody = body;
        return { sse: sseText('The redirected numeric tab was refused before actor work.') };
      }
      return { sse: sseText('Waiting for the security boundary result.') };
    },
    async run(ctx, rec) {
      numericTabAuthorityState = {
        addressed: false,
        tabId: null, refusalBody: '', actorCallsAfterAddress: 0,
      };
      let redirectRequests = 0;
      let loginRequests = 0;
      let authenticatedInboxRequests = 0;
      const server = createServer((req, res) => {
        const host = String(req.headers.host || '').split(':')[0];
        if (host === 'acme.peerd.test' && req.url === '/redirect') {
          redirectRequests++;
          const port = /** @type {{ port: number }} */ (server.address()).port;
          res.writeHead(302, { location: `http://acct.peerd.test:${port}/inbox` });
          res.end();
          return;
        }
        if (host === 'acct.peerd.test' && req.url === '/login') {
          loginRequests++;
          res.writeHead(200, {
            'content-type': 'text/html',
            'set-cookie': 'peerd263=authenticated; Path=/; SameSite=Lax',
          });
          res.end(LOGIN_HTML);
          return;
        }
        if (host === 'acct.peerd.test' && req.url === '/inbox'
            && String(req.headers.cookie || '').includes('peerd263=authenticated')) {
          authenticatedInboxRequests++;
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>Account inbox</title><p>NUMERIC-SECRET-263</p>');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PLAIN_HTML);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      numericTabAuthorityRedirectUrl = `http://acme.peerd.test:${port}/redirect`;
      const accountOrigin = `http://acct.peerd.test:${port}`;
      numericTabAuthorityRequestBodies = [];
      try {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
        const seeded = await rpc(ctx.page, {
          type: 'debug/originLock', origin: accountOrigin, seedReason: 'password-field',
        });
        rec.check('the browser probe seeded the production learned-origin policy',
          seeded?.learned === true, JSON.stringify(seeded));
        const alternatePort = await rpc(ctx.page, {
          type: 'debug/originLock', origin: 'https://acct.peerd.test:9443',
        });
        const descendant = await rpc(ctx.page, {
          type: 'debug/originLock', origin: 'https://child.acct.peerd.test',
        });
        const sibling = await rpc(ctx.page, {
          type: 'debug/originLock', origin: 'https://other.peerd.test',
        });
        rec.check('Chrome applies a learned host across schemes and ports',
          alternatePort?.learned === true, JSON.stringify(alternatePort));
        rec.check('Chrome applies a learned parent host to descendants',
          descendant?.learned === true, JSON.stringify(descendant));
        rec.check('Chrome does not spread a learned host to siblings',
          sibling?.learned === false, JSON.stringify(sibling));
        const loginTabId = await evalIn(ctx.page, `(async () => {
          const browser = (await import('/vendor/browser-polyfill.js')).default;
          const tab = await browser.tabs.create({ active: false, url: ${JSON.stringify(`${accountOrigin}/login`)} });
          return tab.id;
        })()`, true);
        await waitFor(() => loginRequests > 0, { budgetMs: 10_000, pollMs: 50 });
        if (Number.isInteger(loginTabId)) {
          await evalIn(ctx.page, `(async () => {
            const browser = (await import('/vendor/browser-polyfill.js')).default;
            await browser.tabs.remove(${JSON.stringify(loginTabId)}).catch(() => {});
          })()`, true);
        }
        numericTabAuthorityState.tabId = await evalIn(ctx.page, `(async () => {
          const browser = (await import('/vendor/browser-polyfill.js')).default;
          const tab = await browser.tabs.create({ active: false, url: ${JSON.stringify(numericTabAuthorityRedirectUrl)} });
          return tab.id;
        })()`, true);
        await waitFor(() => authenticatedInboxRequests > 0, { budgetMs: 10_000, pollMs: 50 });
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Test the redirected account tab.' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        await waitFor(() => numericTabAuthorityState.refusalBody.length > 0,
          { budgetMs: 60_000, pollMs: 100 });
        rec.check('the ordinary page issued its cross-origin redirect',
          redirectRequests > 0, `redirect requests: ${redirectRequests}`);
        rec.check('the destination loaded authenticated content before addressing',
          authenticatedInboxRequests > 0, `authenticated requests: ${authenticatedInboxRequests}`);
        rec.check('numeric addressing returned the stable pre-effect refusal',
          numericTabAuthorityState.refusalBody.includes('actor_sensitive_tab_requires_site'),
          numericTabAuthorityState.refusalBody.slice(0, 600));
        rec.check('no actor model turn started after the numeric address',
          numericTabAuthorityState.actorCallsAfterAddress === 0,
          `actor calls: ${numericTabAuthorityState.actorCallsAfterAddress}`);
        rec.check('the sensitive destination never entered an actor model request',
          !numericTabAuthorityRequestBodies.some((body) => body.includes('<actor_agent>')
            || body.includes('NUMERIC-SECRET-263')),
          numericTabAuthorityRequestBodies.find((body) => body.includes('<actor_agent>')
            || body.includes('NUMERIC-SECRET-263'))?.slice(0, 300));
        rec.check('the recovery is origin-only and requires explicit user intent',
          numericTabAuthorityState.refusalBody.includes(`site:${accountOrigin}`)
            && numericTabAuthorityState.refusalBody.includes('requiresUserIntent')
            && !numericTabAuthorityState.refusalBody.includes('/inbox'),
          numericTabAuthorityState.refusalBody.slice(0, 900));
        const audits = await auditEntries(ctx);
        rec.check('the refusal was audited without minting a numeric actor',
          audits.some((entry) => entry.type === 'actor_tab_authority_refused'
            && entry.details?.performed === false)
            && !audits.some((entry) => entry.type === 'actor_minted'
              && entry.details?.instanceId === String(numericTabAuthorityState.tabId)),
          JSON.stringify(audits.slice(-20)));
        const disclosureBefore = await waitFor(() => evalIn(ctx.page, `(() => {
          const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
            .filter((node) => node.querySelector('.tool-name')?.textContent === 'message_actor'
              && node.innerText.includes('Read this page')
              && node.innerText.includes('Not run'))
            .at(-1);
          const collapsed = header?.innerText ?? '';
          const initiallyExpanded = header?.getAttribute('aria-expanded') ?? null;
          if (!header || initiallyExpanded !== 'false' || !collapsed.includes('Not run')) return null;
          header?.click();
          return { collapsed, initiallyExpanded };
        })()`), { budgetMs: 15_000, pollMs: 50 });
        const disclosureAfter = await waitFor(() => evalIn(ctx.page, `(() => {
          const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
            .filter((node) => node.querySelector('.tool-name')?.textContent === 'message_actor'
              && node.innerText.includes('Read this page')
              && node.innerText.includes('Not run'))
            .at(-1);
          const value = {
            detail: header?.parentElement?.querySelector('.actor-body .error-line')?.textContent ?? '',
            expanded: header?.getAttribute('aria-expanded') ?? null,
          };
          return value.expanded === 'true' && value.detail ? value : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the human sees a collapsed Not run disclosure with a plain explanation',
          disclosureBefore?.initiallyExpanded === 'false'
            && disclosureBefore?.collapsed.includes('Not run')
            && disclosureAfter?.expanded === 'true'
            && disclosureAfter?.detail === 'No actor work was started. Review the request before trying again.'
            && !disclosureAfter.detail.includes('actor_sensitive_tab_requires_site'),
          JSON.stringify({ disclosureBefore, disclosureAfter }));
        // No screenshot here: Chrome 151 can deadlock Page.captureScreenshot
        // on this side-panel target after the long network/identity prefix.
        // The exact collapsed and expanded disclosure states are asserted above.
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
        if (Number.isInteger(numericTabAuthorityState.tabId)) {
          await evalIn(ctx.page, `(async () => {
            const browser = (await import('/vendor/browser-polyfill.js')).default;
            await browser.tabs.remove(${JSON.stringify(numericTabAuthorityState.tabId)}).catch(() => {});
          })()`, true).catch(() => {});
        }
        server.close();
      }
    },
  },

  // --- functional: issue 265, identity providers are transit-only ----------
  {
    name: 'idp-transit-authority', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = (request && request.postData) || '';
      idpTransitRequestBodies.push(body);
      if (body.includes('<actor_agent>')) {
        idpTransitState.actorCalls++;
        return { sse: sseText('IDP-STANDALONE-ACTOR-SHOULD-NOT-RUN') };
      }
      if (idpTransitState.addressed === 0) {
        idpTransitState.addressed = 1;
        return { sse: sseToolCall('message_actor', {
          to: 'site:https://accounts.google.com',
          message: 'Work directly on this sign-in service',
        }) };
      }
      const latestToolResult = toolResultsIn(body).at(-1) ?? '';
      if (latestToolResult) {
        if (idpTransitState.addressed === 1) {
          idpTransitState.siteRefusal = latestToolResult;
          idpTransitState.addressed = 2;
          return { sse: sseToolCall('message_actor', {
            to: 'https://accounts.google.com',
            message: 'Use this sign-in service as an API integration',
          }) };
        }
        idpTransitState.bareRefusal = latestToolResult;
        return { sse: sseText('The sign-in service was kept transit-only.') };
      }
      return { sse: sseText('Waiting for the identity-provider boundary result.') };
    },
    async run(ctx, rec) {
      idpTransitState = { addressed: 0, siteRefusal: '', bareRefusal: '', actorCalls: 0 };
      idpTransitRequestBodies = [];
      const sent = await rpc(ctx.page, {
        type: 'agent/send',
        text: 'Test direct identity-provider actor authority.',
      });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      await waitFor(() => idpTransitState.siteRefusal && idpTransitState.bareRefusal,
        { budgetMs: 60_000, pollMs: 100 });
      const refusalBody = idpTransitState.bareRefusal;
      rec.check('site and bare-origin addressing returned the transit-only refusal',
        [idpTransitState.siteRefusal, idpTransitState.bareRefusal].every((result) =>
          result.includes('actor_identity_provider_transit_only')
            && result.includes('requiresRelyingSite')
            && result.includes('suggestedHandle') === false),
        refusalBody.slice(0, 900));
      rec.check('the recovery routes through the relying site, not an IdP helper',
        refusalBody.includes('relying site already named')
          && refusalBody.includes('If none was named'),
        refusalBody.slice(0, 900));
      rec.check('no IdP actor model turn started',
        idpTransitState.actorCalls === 0
          && idpTransitRequestBodies.every((body) => !body.includes('<actor_agent>')),
        `actor calls: ${idpTransitState.actorCalls}`);
      const audits = await auditEntries(ctx);
      rec.check('the refusal was audited before actor mint',
        audits.filter((entry) => entry.type === 'actor_idp_authority_refused'
          && entry.details?.origin === 'https://accounts.google.com'
          && entry.details?.performed === false).length >= 2
          && !audits.some((entry) => entry.type === 'actor_minted'
            && ['site:https://accounts.google.com', 'https://accounts.google.com'].includes(entry.details?.instanceId)),
        JSON.stringify(audits.slice(-20)));
      const disclosureReady = await waitFor(() => evalIn(ctx.page, `(() => {
        const headers = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')];
        const header = headers.at(-1);
        if (!header?.innerText.includes('Not run')) return null;
        header.click();
        return {
          label: header.innerText,
          args: header.querySelector('.tool-args')?.textContent ?? '',
          cardClass: header.parentElement?.className ?? '',
          dotClass: header.querySelector('.tool-status-dot')?.className ?? '',
        };
      })()`), { budgetMs: 5_000, pollMs: 50 });
      const disclosure = disclosureReady ? await waitFor(() => evalIn(ctx.page, `(() => {
        const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')].at(-1);
        const detail = header?.parentElement?.querySelector('.actor-body .error-line')?.textContent ?? '';
        return header?.getAttribute('aria-expanded') === 'true' && detail
          ? { expanded: 'true', detail }
          : null;
      })()`), { budgetMs: 5_000, pollMs: 50 }) : null;
      rec.check('the human sees a generic host-proven Not run explanation',
        disclosureReady?.label.includes('actor')
          && disclosureReady?.args === 'actor: "Use this sign-in service as an API inte…"'
          && disclosureReady?.cardClass.includes('tool-not-run')
          && disclosureReady?.dotClass.includes('dot-not-run')
          && disclosure?.expanded === 'true'
          && disclosure?.detail === 'No actor work was started. Review the request before trying again.'
          && !disclosure.detail.includes('actor_identity_provider_transit_only'),
        JSON.stringify({ disclosureReady, disclosure }));
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
      if (Number.isInteger(siteNumericTarget)) {
        if (body.includes('<actor_agent>')) {
          siteNumericActorCalls++;
          return { sse: sseText('SITE-NUMERIC-ACTOR-SHOULD-NOT-RUN') };
        }
        if (!siteNumericAddressed) {
          siteNumericAddressed = true;
          return { sse: sseToolCall('message_actor', {
            to: String(siteNumericTarget), message: 'Read the bound account page',
          }) };
        }
        if (body.includes('actor_sensitive_tab_requires_site')) {
          siteNumericRefusalBody = body;
          return { sse: sseText('The existing site actor stayed bound.') };
        }
        return { sse: sseText('Waiting for the preserved site binding result.') };
      }
      if (body.includes('<actor_agent>')) {
        if (siteActorTurn > 0) siteActorSawPage = toolResultsIn(body).join('\n');
        const t = siteActorTurn++;
        if (body.includes('tools: page_code')) {
          if (t === 0) return { sse: sseToolCall('page_code', {
            code: `await page.goto(${JSON.stringify(`${siteFixtureUrl}account`)}); return await page.content();`,
          }) };
          return { sse: sseText('The account page says: Members only — balance 42.') };
        }
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
      siteNumericTarget = null;
      siteNumericAddressed = false;
      siteNumericRefusalBody = '';
      siteNumericActorCalls = 0;
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><head><title>Acme account</title></head><body>
<h1>Members only</h1><p>Your balance is 42.</p></body></html>`);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      siteFixtureUrl = `http://acct.peerd.test:${port}/`;
      siteFixtureOrigin = `http://acct.peerd.test:${port}`;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'What is my Acme balance?' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        await waitFor(() => siteReplyBody.length > 0, { budgetMs: 45_000, pollMs: 100 });
        await ctx.page.send('Page.bringToFront').catch(() => {});

        rec.check('the site: handle RESOLVED to a real actor that ran a turn',
          siteActorTurn >= 2, `actor turns: ${siteActorTurn}`);
        // Load-bearing: a fetch-only API integration has NO page client, so page
        // content returning the live text proves the handle reached a TAB-backed
        // helper — the distinction the whole `site:` prefix exists to make.
        rec.check('it is TAB-backed — it really drove a page (page content returned the live text)',
          siteActorSawPage.includes('Members only'), siteActorSawPage.slice(0, 200));
        rec.check('the reply reached the orchestrator as a SUCCESS, not a lock stop',
          siteReplyBody.includes('you messaged has replied'), siteReplyBody.slice(0, 200));

        const state = await rpc(ctx.page, { type: 'debug/originLock', origin: siteFixtureOrigin }).catch(() => null);
        rec.check('the site actor is BOUND to that origin, not roaming',
          !state || state.siteActorState?.mode === 'bound', JSON.stringify(state));
        rec.check('and it owns exactly that origin',
          !state || state.siteActorState?.ownedOrigin === siteFixtureOrigin, JSON.stringify(state));
        rec.check('the site actor exposes its browser-owned tab id only to the debug probe',
          Number.isInteger(state?.siteActorTabId), JSON.stringify(state));

        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
        const seeded = await rpc(ctx.page, {
          type: 'debug/originLock', origin: siteFixtureOrigin, seedReason: 'password-field',
        });
        siteNumericTarget = seeded?.siteActorTabId;
        const beforeNumeric = seeded?.siteActorState;
        await waitFor(async () => !(await probe(ctx)).busy,
          { budgetMs: 10_000, pollMs: 100 });
        const numericSent = await rpc(ctx.page, {
          type: 'agent/send', text: 'Test the existing account tab by numeric id.',
        });
        rec.check('the existing-binding numeric probe starts',
          numericSent?.ok === true && Number.isInteger(siteNumericTarget), JSON.stringify(numericSent));
        await waitFor(() => siteNumericRefusalBody.length > 0,
          { budgetMs: 45_000, pollMs: 100 });
        const afterNumeric = await rpc(ctx.page, {
          type: 'debug/originLock', origin: siteFixtureOrigin,
        });
        rec.check('numeric refusal starts no actor turn against the existing site tab',
          siteNumericActorCalls === 0, `actor calls: ${siteNumericActorCalls}`);
        rec.check('numeric refusal preserves the existing site actor binding and origin lock',
          afterNumeric?.siteActorTabId === siteNumericTarget
            && afterNumeric?.siteActorState?.mode === 'bound'
            && afterNumeric?.siteActorState?.ownedOrigin === siteFixtureOrigin
            && JSON.stringify(afterNumeric.siteActorState) === JSON.stringify(beforeNumeric),
          JSON.stringify({ beforeNumeric, afterNumeric }));
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
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
      const busySeen = await waitFor(async () => ctx.modelCallCount() > 0
        && await evalIn(ctx.page, `!!document.querySelector('.message-assistant.streaming') && !!document.querySelector('form.input-bar button.stop')`),
      { budgetMs: 15_000, pollMs: 100 });
      rec.check('turn went busy (Stop button appeared)', !!busySeen);
      const stopped = await rpc(ctx.page, { type: 'agent/stop' });
      rec.check('agent/stop accepted', !!stopped?.ok);
      let out = {};
      await waitFor(async () => { out = await probe(ctx); return !out.busy; }, { budgetMs: 15_000 });
      rec.check('Stop returns the turn to idle', out.busy === false);
      rec.check('the aborted model response never renders', !(out.assistantText || '').includes('never-render'));
      rec.check('the aborted turn shows a "stopped" chip', out.stopChip === true);
      rec.check('Stop surfaces no error state', out.errorText === null, JSON.stringify(out.errorText));
      const callsAfterStop = ctx.modelCallCount();
      await sleep(750);
      rec.check('Stop makes exactly one model call and never replays it',
        callsAfterStop === 1 && ctx.modelCallCount() === 1,
        `after stop: ${callsAfterStop}; after quiet window: ${ctx.modelCallCount()}`);
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
      await evalIn(ctx.page, `document.querySelector('.ctx-close')?.click()`);
      await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });
    },
  },

  // --- functional: the first real turn crosses the sealed controller ----------
  {
    name: 'first-turn', kind: 'functional', phase: 'post-unlock', preserveFreshSession: true,
    responder: () => ({ sse: sseText('first turn ready') }),
    async run(ctx, rec) {
      const state = await rpc(ctx.page, { type: 'state/get' });
      rec.check('the first turn starts with unlocked vault custody',
        state?.state?.vault?.locked === false, state?.error ?? JSON.stringify(state));
      const accepted = await rpc(ctx.page, { type: 'agent/send', text: 'first turn probe' });
      rec.check('the first turn is accepted by the live kernel', accepted?.ok !== false,
        JSON.stringify(accepted));
      const settled = await waitFor(async () => {
        const out = await probe(ctx);
        return out.assistantText === 'first turn ready' && !out.busy ? out : null;
      }, { budgetMs: 20_000 });
      const finalProbe = settled ?? await probe(ctx);
      rec.check('the first turn reaches a controller reply and settles idle', !!settled,
        JSON.stringify(finalProbe));
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
      // Unlock again so later states start from a ready, unlocked panel.
      await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE });
      const ready = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar')`), { budgetMs: 10_000 });
      rec.check('unlocking restores the ready composer', !!ready);
    },
  },

  // --- functional: Contributor Metrics human consent lifecycle --------------
  {
    name: 'contributor-consent-lifecycle', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/contributor-metrics');
      const stored = () => evalIn(page, `(async () => {
        const browser = (await import('/vendor/browser-polyfill.js')).default;
        return browser.storage.local.get(['contributor_metrics.aggregate.v1']);
      })()`, true);
      try {
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-metrics') !== null`),
          { budgetMs: 15_000, pollMs: 80 });
        const before = await stored();
        rec.check('fresh/default and prior actor/model activity create no contribution state',
          Object.keys(before ?? {}).length === 0, JSON.stringify(before));

        // A tab-hosted copy of the panel is first-party, but it is not the
        // browser-owned side panel. Its observed feedback command must buy no
        // consent capability and must not create aggregate state.
        const forged = await evalIn(ctx.page, `(async () => {
          const browser = (await import('/vendor/browser-polyfill.js')).default;
          return browser.runtime.sendMessage({ type: 'contributor/enable' });
        })()`, true);
        rec.check('non-Options first-party pages cannot enable contribution',
          forged?.ok === false && forged?.error === 'trusted-options-sender-required',
          JSON.stringify(forged));
        rec.check('a rejected enable remains storage-inert',
          Object.keys(await stored()).length === 0, JSON.stringify(await stored()));

        await evalIn(page, `(() => [...document.querySelectorAll('button')]
          .find((button) => button.textContent === 'Enable Contributor Metrics')?.click())()`);
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-payload') !== null`),
          { budgetMs: 8_000, pollMs: 80 });
        const active = await stored();
        const record = active?.['contributor_metrics.aggregate.v1'];
        rec.check('the exact Options button creates one atomic consent+aggregate record',
          Object.keys(active ?? {}).length === 1
            && record?.version === 1
            && record?.consent?.enabled === true
            && record?.consent?.schemaVersion === 1
            && record?.consent?.disclosureVersion === 1
            && record?.aggregate?.version === 1
            && Object.keys(record?.aggregate?.rows ?? {}).length === 0,
          JSON.stringify(active));

        await evalIn(page, `(() => [...document.querySelectorAll('button')]
          .find((button) => button.textContent === 'Disable and clear')?.click())()`);
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-payload') === null`),
          { budgetMs: 8_000, pollMs: 80 });
        const cleared = await stored();
        rec.check('disable revokes consent and clears all pending local state',
          Object.keys(cleared ?? {}).length === 0, JSON.stringify(cleared));
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // (A rate-limit/retry-banner state is deferred: the keyless Ollama adapter
  // doesn't retry 429 — only the keyed OpenRouter/Anthropic adapters do — so
  // exercising the retry banner needs a keyed provider wired into the harness.
  // Likewise tool-use rendering is already covered by the goal state's
  // complete_goal card; a distinct safe-tool state is a later add.)

  // Functional and rendered coverage for the page-aware fresh-chat starter.
  // A protected foreground page must produce a readable policy receipt, not a
  // task that the host will refuse after the user clicks it.
  {
    name: 'protected-page-starter', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('Starter custody settled.') }),
    async run(ctx, rec) {
      const callLogKey = 'peerd.e2e.protected-starter-calls';
      const interceptorSource = `(() => {
        if (globalThis.__peerdProtectedStarterOriginal) return true;
        const runtime = globalThis.chrome?.runtime;
        if (!runtime?.sendMessage) return false;
        const original = runtime.sendMessage.bind(runtime);
        globalThis.__peerdProtectedStarterOriginal = original;
        runtime.sendMessage = async (message, ...args) => {
          const calls = JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]');
          const loseReceipt = message?.type === 'agent/send' && message?.checkOnly !== true
            && !calls.some((call) => call.type === 'agent/send' && call.checkOnly !== true);
          if (message?.type === 'agent/send') {
            calls.push({
              type: message.type,
              checkOnly: message.checkOnly === true,
              operationId: message.operationId ?? null,
            });
            localStorage.setItem(${JSON.stringify(callLogKey)}, JSON.stringify(calls));
          }
          const reply = await original(message, ...args);
          if (loseReceipt) throw Object.assign(new Error('e2e receipt lost'), {
            outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
          });
          return reply;
        };
        return true;
      })()`;
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Private fixture</title><p>private fixture</p>');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const privateUrl = `http://127.0.0.1:${/** @type {{ port: number }} */ (server.address()).port}/private`;
      const priorActive = await evalIn(ctx.page, `(async () =>
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null)()`, true);
      let protectedTabId = null;
      let interceptorId = null;
      try {
        await evalIn(ctx.page, `localStorage.removeItem(${JSON.stringify(callLogKey)})`);
        const armed = await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', {
          source: interceptorSource,
        });
        interceptorId = armed.identifier ?? null;
        rec.check('the starter receipt-loss seam is installed',
          await evalIn(ctx.page, interceptorSource) === true);
        protectedTabId = await evalIn(ctx.page, `(async () =>
          (await chrome.tabs.create({ url: ${JSON.stringify(privateUrl)}, active: true })).id)()`, true);
        const starter = await waitFor(() => evalIn(ctx.page, `(() => {
          const card = [...document.querySelectorAll('button.path-card')]
            .find((candidate) => candidate.dataset.path === 'web');
          if (!card || !card.textContent.includes('Protected')) return null;
          const style = getComputedStyle(card);
          return {
            text: card.textContent.trim(),
            disabled: card.disabled,
            label: card.getAttribute('aria-label') || '',
            opacity: style.opacity,
            filter: style.filter,
          };
        })()`), { budgetMs: 8_000, pollMs: 50 });
        const diagnostics = starter ?? await evalIn(ctx.page, `(async () => ({
          activeTabs: (await chrome.tabs.query({ active: true, currentWindow: true }))
            .map((tab) => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl })),
          status: document.querySelector('.empty-state')?.dataset.activeTabStatus || '',
          cards: [...document.querySelectorAll('button.path-card')]
            .map((card) => ({ path: card.dataset.path, text: card.textContent.trim() })),
        }))()`, true);
        rec.check('a private foreground page replaces the summarize starter',
          starter?.disabled === true
            && starter?.text.includes('private-network page')
            && !starter?.text.includes('Summarize the current page'),
          JSON.stringify(diagnostics));
        rec.check('the protected starter remains readable and names the policy',
          starter?.opacity === '1'
            && starter?.filter === 'none'
            && starter?.label.includes('peerd will not read or automate it'),
          JSON.stringify(diagnostics));
        // The harness hosts the side panel in a tab. Bringing that tab to the
        // foreground would correctly replace the private-page receipt before
        // capture, unlike a real side panel which stays beside the active tab.

        const clicked = await evalIn(ctx.page, `(() => {
          const card = [...document.querySelectorAll('button.path-card')]
            .find((candidate) => candidate.dataset.path === 'ask');
          if (!card || card.disabled) return false;
          card.click();
          return true;
        })()`);
        rec.check('the safe starter remains available beside a protected page', clicked === true);
        const pending = await waitFor(() => evalIn(ctx.page, `(() => {
          const calls = JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]');
          const send = calls.find((call) => call.type === 'agent/send' && call.checkOnly !== true);
          if (!send?.operationId) return null;
          const stored = [...Array(localStorage.length).keys()]
            .map((index) => localStorage.key(index))
            .filter((key) => key?.startsWith('peerd.unconfirmed-send.'))
            .map((key) => JSON.parse(localStorage.getItem(key) || 'null'))
            .find((value) => value?.operationId === send.operationId);
          return stored ? { operationId: send.operationId } : null;
        })()`), { budgetMs: 10_000, pollMs: 50 });
        rec.check('a lost starter receipt leaves one durable delivery fence',
          typeof pending?.operationId === 'string', JSON.stringify(pending));
        const pendingOperationId = pending?.operationId ?? '';
        const settled = await waitFor(async () => {
          const receipt = await evalIn(ctx.page, `(async () => {
            const stored = await chrome.storage.session.get('agentSendReceipts.v1');
            return stored['agentSendReceipts.v1']?.[${JSON.stringify(pendingOperationId)}]?.status ?? null;
          })()`, true);
          const modelCalls = ctx.modelCallCount();
          return receipt === 'settled' && modelCalls === 1 ? { receipt, modelCalls } : null;
        }, { budgetMs: 30_000, pollMs: 50 });
        rec.check('the accepted starter settles without a replay',
          settled?.receipt === 'settled' && settled?.modelCalls === 1,
          JSON.stringify(settled));

        await ctx.page.send('Page.bringToFront');
        await ctx.page.send('Page.reload', { ignoreCache: true });
        const checkReady = await waitFor(() => evalIn(ctx.page, `(() => {
          const button = [...document.querySelectorAll('button')]
            .find((candidate) => candidate.textContent === 'Check delivery');
          const calls = JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]');
          return button ? { operationId: calls[0]?.operationId ?? null } : null;
        })()`), { budgetMs: 15_000, pollMs: 50 });
        const reloadDiagnostics = checkReady ?? await evalIn(ctx.page, `(() => ({
          readyState: document.readyState,
          bootStage: document.documentElement.dataset.peerdBootStage ?? null,
          text: document.body.innerText.slice(0, 500),
          calls: JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]'),
          pending: [...Array(localStorage.length).keys()]
            .map((index) => localStorage.key(index))
            .filter((key) => key?.startsWith('peerd.unconfirmed-send.')),
        }))()`);
        rec.check('the reloaded panel offers Check delivery for the same operation',
          checkReady?.operationId === pending?.operationId, JSON.stringify(reloadDiagnostics));
        await evalIn(ctx.page, `(() => [...document.querySelectorAll('button')]
          .find((button) => button.textContent === 'Check delivery')?.click())()`);
        const reconciled = await waitFor(() => evalIn(ctx.page, `(() => {
          const calls = JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]');
          const stillPending = [...Array(localStorage.length).keys()]
            .map((index) => localStorage.key(index))
            .filter((key) => key?.startsWith('peerd.unconfirmed-send.'))
            .map((key) => JSON.parse(localStorage.getItem(key) || 'null'))
            .some((value) => value?.operationId === calls[0]?.operationId);
          return calls.length >= 2 && !stillPending ? calls : null;
        })()`), { budgetMs: 10_000, pollMs: 50 });
        const sends = (reconciled ?? []).filter((call) => call.type === 'agent/send');
        const nonChecks = sends.filter((call) => call.checkOnly !== true);
        const checks = sends.filter((call) => call.checkOnly === true);
        rec.check('Check delivery preserves custody without replaying the starter',
          nonChecks.length === 1
            && checks.length === 1
            && nonChecks[0]?.operationId === pending?.operationId
            && checks[0]?.operationId === pending?.operationId
            && ctx.modelCallCount() === 1,
          JSON.stringify({ sends, modelCalls: ctx.modelCallCount() }));
      } finally {
        if (interceptorId) {
          await ctx.page.send('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: interceptorId,
          }).catch(() => {});
        }
        await evalIn(ctx.page, `(() => {
          const original = globalThis.__peerdProtectedStarterOriginal;
          if (original) chrome.runtime.sendMessage = original;
          delete globalThis.__peerdProtectedStarterOriginal;
          const calls = JSON.parse(localStorage.getItem(${JSON.stringify(callLogKey)}) || '[]');
          const operationId = calls[0]?.operationId;
          for (const key of [...Array(localStorage.length).keys()].map((index) => localStorage.key(index))) {
            if (!key?.startsWith('peerd.unconfirmed-send.')) continue;
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            if (value?.operationId === operationId) localStorage.removeItem(key);
          }
          localStorage.removeItem(${JSON.stringify(callLogKey)});
        })()`).catch(() => {});
        if (Number.isInteger(protectedTabId)) {
          await evalIn(ctx.page, `chrome.tabs.remove(${JSON.stringify(protectedTabId)}).catch(() => {})`, true).catch(() => {});
        }
        if (Number.isInteger(priorActive)) {
          await evalIn(ctx.page, `chrome.tabs.update(${JSON.stringify(priorActive)}, { active: true }).catch(() => {})`, true).catch(() => {});
        }
        await new Promise((resolve) => server.close(resolve));
      }
    },
  },

  // --- functional + visual artifact: protected-tab notice ------------------
  {
    name: 'protected-tab-notice', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => callIndex === 0
      ? { sse: sseToolCall('open_tab', {}) }
      : { sse: sseText('The protected tab is ready.') },
    async run(ctx, rec) {
      const before = await evalIn(ctx.page, `(async () =>
        (await chrome.tabs.query({})).map((tab) => tab.id).filter(Number.isInteger))()`);
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Open a protected blank tab.' });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        const notice = await waitFor(() => evalIn(ctx.page, `(() => {
          const row = document.querySelector('.agent-tab-notice');
          return row ? {
            primary: row.querySelector('.agent-tab-notice-text')?.textContent?.trim() || '',
            detail: row.querySelector('.agent-tab-notice-detail')?.textContent?.trim() || '',
            go: row.querySelector('.agent-tab-notice-go')?.textContent?.trim() || '',
          } : null;
        })()`), { budgetMs: 20_000 });
        rec.check('the notice identifies the task tab without warning language',
          notice?.primary?.includes('task tab')
            && !notice.primary.includes('protected'), JSON.stringify(notice));
        rec.check('the notice explains safeguards without unsupported isolation claims',
          notice?.detail === 'This task tab uses additional browser safeguards.',
          JSON.stringify(notice));
        rec.check('the Go action remains available', notice?.go === 'Go ↗', JSON.stringify(notice));
      } finally {
        await evalIn(ctx.page, `(async () => {
          const before = new Set(${JSON.stringify(before)});
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && !before.has(tab.id))
            .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        })()`, true).catch(() => {});
      }
    },
  },

  // --- visual: a completed assistant turn ------------------------------------
  {
    name: 'completed-turn', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText(SMOKE_TEXT) }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'agent/send', text: 'hello there' });
      await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      await rec.visual('completed-turn');
      const beforeCount = await evalIn(ctx.page, `document.querySelectorAll('.message').length`);
      await evalIn(ctx.page, `[...document.querySelectorAll('.task-feedback button')]
        .find((button) => button.textContent === 'worked')?.click()`);
      await waitFor(() => evalIn(ctx.page,
        `document.querySelector('.task-feedback-note')?.textContent.includes('not recorded') === true`),
      { budgetMs: 4_000, pollMs: 50 });
      const after = await evalIn(ctx.page, `({
        pressed: document.querySelector('.task-feedback button[aria-pressed="true"]')?.textContent,
        notice: document.querySelector('.task-feedback-note')?.textContent,
        messageCount: document.querySelectorAll('.message').length,
        freeText: document.querySelector('.task-feedback input, .task-feedback textarea') !== null,
      })`);
      rec.check('disabled feedback is declined honestly without mutating the transcript',
        !after?.pressed && after?.notice?.includes('not recorded')
          && after?.messageCount === beforeCount && after?.freeText === false,
        JSON.stringify({ beforeCount, after }));
    },
  },

  // --- visual: verified SSO names both relying site and provider ----------
  {
    name: 'login-confirm', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.createElement('div');
          host.id = 'e2e-login-confirm';
          document.body.appendChild(host);
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-login', kind: 'login', tool: 'login', method: 'sso',
            provider: 'Okta', verified: true,
            origins: ['https://app.example'], idpOrigin: 'https://acme.okta.com',
          } }));
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => ({
          title: document.querySelector('#e2e-login-confirm h3')?.textContent,
          relyingSite: document.querySelector('#e2e-login-confirm .login-hero .host')?.textContent,
          provider: document.querySelector('#e2e-login-confirm .login-destination strong')?.textContent,
          allowDisabled: document.querySelector('#e2e-login-confirm button:not(.secondary)')?.disabled,
        }))()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('verified SSO consent names both exact origins before approval',
          rendered?.title === 'Approve sign-in'
            && rendered?.relyingSite === 'app.example'
            && rendered?.provider === 'acme.okta.com'
            && rendered?.allowDisabled === false,
          JSON.stringify(rendered));
        await rec.visual('login-confirm');
      } finally {
        await evalIn(ctx.page, `document.querySelector('#e2e-login-confirm')?.remove()`);
      }
    },
  },

  // --- rendered: unknown-outcome approval names its immutable claim --------
  {
    name: 'unknown-outcome-confirm', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.createElement('div');
          host.id = 'e2e-unknown-outcome-confirm';
          document.body.appendChild(host);
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-unknown-outcome', tool: 'submit_payment',
            actionClass: 'external', sideEffect: 'mutate_external',
            lifecycleTarget: 'https://payments.example',
            oneShot: true,
            note: 'A matching earlier action has an unknown outcome. Verify the target before approving this repeat.',
            summary: 'submit_payment({ orderId: "order-7" })', origins: [],
          } }));
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => {
          const claim = document.querySelector('#e2e-unknown-outcome-confirm [aria-label="Unknown-outcome repeat approval"]');
          const button = document.querySelector('#e2e-unknown-outcome-confirm .lifecycle-confirm-allow');
          const style = button ? getComputedStyle(button) : null;
          return claim ? {
            labels: [...claim.querySelectorAll('span')].map((node) => node.textContent),
            values: [...claim.querySelectorAll('code')].map((node) => node.textContent),
            buttons: [...document.querySelectorAll('#e2e-unknown-outcome-confirm .peerd-modal-actions button')]
              .map((node) => node.textContent),
            foreground: style?.color ?? null,
            background: style?.backgroundColor ?? null,
          } : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        const channel = (value) => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (color) => {
          const rgb = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
          return rgb.length === 3
            ? 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
            : Number.NaN;
        };
        const foreground = luminance(rendered?.foreground);
        const background = luminance(rendered?.background);
        const contrast = (Math.max(foreground, background) + 0.05)
          / (Math.min(foreground, background) + 0.05);
        rec.check('unknown-outcome consent shows the exact bound target and action',
          JSON.stringify(rendered?.labels) === JSON.stringify(['Exact target', 'Action'])
            && JSON.stringify(rendered?.values)
              === JSON.stringify(['https://payments.example', 'submit_payment']),
          JSON.stringify(rendered));
        rec.check('unknown-outcome consent is one-shot',
          JSON.stringify(rendered?.buttons) === JSON.stringify(['Reject', 'Allow once']),
          JSON.stringify(rendered?.buttons));
        rec.check('unknown-outcome approval text meets WCAG AA contrast',
          contrast >= 4.5, `${contrast} (${rendered?.foreground} on ${rendered?.background})`);
      } finally {
        await evalIn(ctx.page, `document.querySelector('#e2e-unknown-outcome-confirm')?.remove()`);
      }
    },
  },

  // --- visual: persisted runnable site-client confirmation -----------------
  {
    name: 'site-client-confirm', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.createElement('div');
          host.id = 'e2e-site-client-confirm';
          document.body.appendChild(host);
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-site-client',
            kind: 'site_client_write',
            tool: 'site_client_write',
            origins: ['https://shop.example'],
            proposal: {
              op: 'create',
              body: 'return { currentOrder: async () => {\\n  const response = await site.fetch("/api/orders/current");\\n  return response.json;\\n} };',
              bodyBytesBefore: 0,
              bodyBytesAfter: 132,
              dossier: {
                origin: 'https://shop.example',
                summary: 'Read the current order status.',
                endpoints: [{ method: 'GET', path: '/api/orders/current' }],
                auth: 'session',
                deriver: 'capture-cdp',
              },
            },
          } }));
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => ({
          title: document.querySelector('#e2e-site-client-confirm h3')?.textContent,
          code: document.querySelector('[aria-label="Proposed site-client code"]')?.textContent,
          endpoints: document.querySelector('[aria-label="Proposed site-client endpoints"]')?.textContent,
          buttons: [...document.querySelectorAll('#e2e-site-client-confirm button')].map((button) => button.textContent),
        }))()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('site-client consent exposes its dossier and runnable bytes',
          rendered?.title === 'Confirm site client'
            && rendered?.code?.includes('/api/orders/current')
            && rendered?.endpoints === 'GET /api/orders/current'
            && JSON.stringify(rendered?.buttons) === JSON.stringify(['Reject', 'Save client']),
          JSON.stringify(rendered));
        await rec.visual('site-client-confirm');
        const maximum = await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.querySelector('#e2e-site-client-confirm');
          const endpoints = Array.from({ length: 60 }, (_, index) => ({
            method: 'GET', path: '/api/' + String(index).padStart(2, '0') + '/' + 'segment'.repeat(20),
          }));
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-site-client-maximum', kind: 'site_client_write', tool: 'site_client_write',
            origins: ['https://shop.example'],
            proposal: {
              op: 'update', prevBody: 'return { currentOrder: async () => null };',
              body: 'return { currentOrder: async () => ({ ok: true }) };',
              endpointDelta: { added: 60, removed: 0 },
              dossier: {
                origin: 'https://shop.example', summary: 'purpose '.repeat(500), endpoints,
                auth: 'session', deriver: 'capture-cdp',
              },
            },
          } }));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const modal = host.querySelector('.confirm-modal');
          const actions = host.querySelector('.peerd-modal-actions');
          const modalRect = modal.getBoundingClientRect();
          const actionRect = actions.getBoundingClientRect();
          return {
            viewport: innerHeight,
            modalTop: modalRect.top, modalBottom: modalRect.bottom,
            actionTop: actionRect.top, actionBottom: actionRect.bottom,
            scrollable: modal.scrollHeight > modal.clientHeight,
            overflow: getComputedStyle(modal).overflowY,
            actionPosition: getComputedStyle(actions).position,
          };
        })()`, true);
        rec.check('maximum site-client dossier keeps Reject and Save reachable',
          maximum?.modalTop >= 0 && maximum?.modalBottom <= maximum?.viewport
            && maximum?.actionTop >= maximum?.modalTop && maximum?.actionBottom <= maximum?.viewport
            && maximum?.scrollable && maximum?.overflow === 'auto'
            && maximum?.actionPosition === 'sticky',
          JSON.stringify(maximum));
      } finally {
        await evalIn(ctx.page, `document.querySelector('#e2e-site-client-confirm')?.remove()`);
      }
    },
  },

  // --- visual: the confirm modal, standard shape (§4d) ----------------------
  // Component-render like login-confirm above: the modal's STRUCTURE is the
  // subject - the honest session-grant label (verb + true scope) and, second
  // pass, the helper-raised variant where the absence is explained, not silent.
  {
    name: 'sidepanel-confirm', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.createElement('div');
          host.id = 'e2e-sidepanel-confirm';
          document.body.appendChild(host);
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-confirm', tool: 'write_file', actionClass: 'workspace_write',
            summary: 'write_file notes/2026-08.md',
            origins: ['https://notes.example.com'],
          } }));
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => ({
          title: document.querySelector('#e2e-sidepanel-confirm h3')?.textContent,
          buttons: [...document.querySelectorAll('#e2e-sidepanel-confirm .peerd-modal-actions button')]
            .map((b) => b.textContent.trim().replace(/\\s+/g, ' ')),
          scope: document.querySelector('#e2e-sidepanel-confirm .confirm-grant-scope')?.textContent,
        }))()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the session button names the grant and its true scope (§4d)',
          rendered?.title === 'Confirm action'
            && rendered?.buttons?.[0] === 'Reject'
            && String(rendered?.buttons?.[1] ?? '').startsWith('Allow all writes')
            && rendered?.buttons?.[2] === 'Allow once'
            && rendered?.scope === 'this chat, this site',
          JSON.stringify(rendered));
        await rec.visual('sidepanel-confirm');
        // Second pass - helper-raised (ephemeral): the session button is gone
        // AND the quiet line says why; a control that grants nothing must not
        // render, and its absence must not be silent.
        const ephemeral = await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ConfirmModal } = await import('/sidepanel/components/app.js');
          const host = document.querySelector('#e2e-sidepanel-confirm');
          m.render(host, null);
          m.render(host, m(ConfirmModal, { prompt: {
            id: 'e2e-confirm-eph', tool: 'click', actionClass: 'external',
            summary: 'click "Confirm booking"', ephemeral: true,
            origins: ['https://rooms.example.com'],
          } }));
          return {
            buttons: [...document.querySelectorAll('#e2e-sidepanel-confirm .peerd-modal-actions button')]
              .map((b) => b.textContent.trim()),
            note: document.querySelector('#e2e-sidepanel-confirm .confirm-ephemeral-note')?.textContent ?? null,
          };
        })()`, true);
        rec.check('a helper-raised confirm hides the session grant and explains the absence',
          ephemeral?.buttons?.length === 2
            && ephemeral?.buttons?.[0] === 'Reject'
            && ephemeral?.buttons?.[1] === 'Allow once'
            && typeof ephemeral?.note === 'string'
            && ephemeral.note.includes('approved a single time'),
          JSON.stringify(ephemeral));
      } finally {
        await evalIn(ctx.page, `document.querySelector('#e2e-sidepanel-confirm')?.remove()`);
      }
    },
  },

  // --- visual: the origin-lock stop card (§4c) ------------------------------
  // One state per family: the variants differ by string, and the gate exists to
  // catch layout regressions, not to inventory copy. HANDOFF carries the one
  // action (composer prefill), so it is the layout-complete member.
  {
    name: 'sidepanel-stop-card', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { MessageList } = await import('/sidepanel/components/message-list.js');
          const { landingStopCard } = await import('/peerd-runtime/index.js');
          const host = document.createElement('div');
          host.id = 'e2e-stop-card';
          // why fixed over the viewport: an appended host lands below the home
          // content, off-frame - the visual would photograph nothing.
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
          document.body.appendChild(host);
          const card = landingStopCard({
            action: 'handoff',
            reason: 'this is a site you have an account on, so its own helper should do the work',
            from: null, to: 'https://mail.example.com/inbox?x=1',
            handoffTo: 'https://mail.example.com',
          });
          m.render(host, m(MessageList, { messages: [{
            id: 'e2e-stop-1', role: 'user', synthetic: true,
            content: 'The web actor could not complete your request:\\n\\n(fenced report)',
            actorReply: { kind: 'web', instanceId: 'web', failed: true, landingStop: card },
          }] }));
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => ({
          chip: document.querySelector('#e2e-stop-card .landing-stop-chip')?.textContent,
          group: document.querySelector('#e2e-stop-card .landing-stop-group')?.textContent,
          headline: document.querySelector('#e2e-stop-card .landing-stop-headline')?.textContent,
          unknownLabel: document.querySelector('#e2e-stop-card .landing-stop-unknown-label')?.textContent,
          action: document.querySelector('#e2e-stop-card .landing-stop-action')?.textContent,
          proseHidden: !document.querySelector('#e2e-stop-card .bubble'),
        }))()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the stop card renders four slots, origin-only, with the one action',
          rendered?.chip === 'STOPPED'
            && rendered?.group === 'HANDOFF'
            && rendered?.headline === 'The web helper was stopped when the tab arrived at https://mail.example.com'
            && !String(rendered?.headline).includes('/inbox')
            && rendered?.unknownLabel === 'WHAT PEERD DOESN’T KNOW'
            && rendered?.action === 'Try reading it without signing in'
            && rendered?.proseHidden === true,
          JSON.stringify(rendered));
        await rec.visual('sidepanel-stop-card');
      } finally {
        await evalIn(ctx.page, `document.querySelector('#e2e-stop-card')?.remove()`);
      }
    },
  },

  // --- visual: first-run provider choice -----------------------------------
  // Component-rendered before the harness completes vault bootstrap because
  // normal E2E startup deliberately closes onboarding before post-unlock
  // states run. The production component and provider inventory shape are
  // real; only the status/probe replies are fixed so the screenshot never
  // contacts a daemon.
  {
    name: 'onboarding-provider', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ProviderStep } = await import('/sidepanel/components/onboarding-provider-step.js');
          const host = document.createElement('div');
          host.id = 'e2e-onboarding-provider';
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
          document.body.appendChild(host);
          const providers = [
            { name: 'anthropic', label: 'Anthropic', keyless: false },
            { name: 'openrouter', label: 'OpenRouter', keyless: false },
            { name: 'openai', label: 'OpenAI', keyless: false },
            { name: 'glm', label: 'GLM', keyless: false },
            { name: 'ollama', label: 'Ollama', keyless: true, liveModels: true },
            { name: 'local-webgpu', label: 'Local WebGPU', keyless: true, liveModels: false },
          ];
          const send = async (message) => message.type === 'provider/status'
            ? { ok: true, providers }
            : message.type === 'provider/test' && message.provider === 'ollama'
              ? { ok: true, reachable: true, models: 2 }
              : { ok: true };
          m.mount(host, { view: () => m('.onboarding-view', m('.card.onboarding-card', [
            m(ProviderStep, { send, onDone: () => {} }),
            m('.onb-dots', { 'aria-label': 'Step 1 of 4' }, [0, 1, 2, 3].map((i) =>
              m('span.onb-dot', { class: i === 0 ? 'is-on' : '', 'aria-current': i === 0 ? 'step' : undefined }))),
          ])) });
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => {
          const rows = document.querySelectorAll('#e2e-onboarding-provider .onb-provider-row').length;
          if (rows === 0) return null;
          return {
            title: document.querySelector('#e2e-onboarding-provider h3')?.textContent,
            rows,
            selected: document.querySelector('#e2e-onboarding-provider [aria-checked="true"]')?.textContent,
            keyType: document.querySelector('#e2e-onboarding-provider #onb-key')?.type,
            copy: document.querySelector('#e2e-onboarding-provider .onb-provider-sub')?.textContent,
          };
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the provider front door is complete and honest',
          rendered?.title === 'Choose a provider'
            && rendered?.rows === 6
            && String(rendered?.selected).includes('Anthropic')
            && rendered?.keyType === 'password'
            && String(rendered?.copy).includes('sent only to the provider you choose')
            && !String(rendered?.copy).includes('never leaves this browser'),
          JSON.stringify(rendered));
        await rec.visual('onboarding-provider');
      } finally {
        await evalIn(ctx.page, `(async () => {
          const host = document.querySelector('#e2e-onboarding-provider');
          if (!host) return;
          const m = (await import('/vendor/mithril/mithril.js')).default;
          m.mount(host, null);
          host.remove();
        })()`, true);
      }
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
      const goalReady = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.goal-bar')`), { budgetMs: 10_000, pollMs: 50 });
      if (!goalReady) throw new Error('goal-running bar did not become ready');
      const planReady = await waitFor(() => evalIn(ctx.page,
        `/1\\/3/.test(document.querySelector('.todo-card .todo-card-meta')?.textContent || '')`),
        { budgetMs: 30_000, pollMs: 50 });
      if (!planReady) throw new Error('goal-running plan did not become ready');
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
        // why: live dweb notifications are unrelated to this quiet-instance
        // contract and can arrive between the light and dark captures.
        const pinQuietHome = async () => {
          await evalIn(page, `import('/shared/peer-notifications.js')
            .then(({ peerNotifications }) => peerNotifications.clear())`, true);
          await waitFor(() => evalIn(page, `!document.querySelector('.notif-badge, .notif-banner')`),
            { budgetMs: 2_000, pollMs: 25 });
        };
        await rec.visualPage('home-fulltab', page, { beforeShot: pinQuietHome });
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): browser-native Git history on an App -------------------
  // Creates through the real import→App→Git path, then opens the Library's
  // developer panel. Import avoids opening a second tab during the visual state,
  // while still exercising the production App client and OPFS repository init.
  // This covers what assertions cannot see: dense log rows, remote controls,
  // and the restore affordance in both themes.
  {
    name: 'home-library-git', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await captureHomeLibraryGit(ctx, rec, { visualName: 'home-library-git' });
    },
  },
  // why: the dense History and Git panel has its own narrow breakpoint, so the
  // installed sidebar width needs a companion pixel contract to the wide view.
  {
    name: 'home-library-git-narrow', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await captureHomeLibraryGit(ctx, rec, {
        visualName: 'home-library-git-narrow',
        metrics: NARROW_PANEL_METRICS,
        revealPanel: true,
      });
    },
  },

  // Functional rendered coverage for committed success warnings. This takes a
  // screenshot without creating a local visual authority baseline. CI remains
  // the only source of Linux pixel baselines.
  {
    name: 'home-committed-warnings', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openExtPage(ctx, 'tests/fixtures/home-warning.html');
      try {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 320,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const ready = await waitFor(() => evalIn(page, `
          !![...document.querySelectorAll('.library-card button')].find((button) => button.textContent === 'Update')
          && !![...document.querySelectorAll('.disc-card button')].find((button) => button.textContent === 'Update')
        `), { budgetMs: 8_000, pollMs: 80 });
        rec.check('the narrow warning fixture renders both update actions', !!ready);

        await evalIn(page, `
          [...document.querySelectorAll('.disc-card button')]
            .find((button) => button.textContent === 'Update')?.click()
        `);
        const discoverWarning = await waitFor(() => evalIn(page, `
          document.querySelector('.disc-card [role="status"]')?.textContent ?? ''
        `), { budgetMs: 4_000, pollMs: 50 });

        await evalIn(page, `
          [...document.querySelectorAll('.library-card button')]
            .find((button) => button.textContent === 'Update')?.click()
        `);
        const warningLayout = await waitFor(() => evalIn(page, `(() => {
          const statuses = [
            document.querySelector('section[aria-labelledby="library-warning-heading"] p.muted[role="status"]'),
            document.querySelector('.disc-card [role="status"]'),
          ].filter(Boolean);
          if (statuses.length !== 2) return null;
          return {
            texts: statuses.map((status) => status.textContent ?? ''),
            viewportWidth: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            withinViewport: statuses.every((status) => {
              const rect = status.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth;
            }),
          };
        })()`), { budgetMs: 4_000, pollMs: 50 });
        const warningText = warningLayout?.texts?.join(' ') ?? '';
        rec.check('Library and Discover render both committed warning details',
          warningText.includes('security audit entry could not be written')
            && (warningText.match(/Older shared bytes will be cleaned up/g) ?? []).length === 2,
          JSON.stringify({ discoverWarning, warningLayout }));
        rec.check('combined warning statuses fit the narrow viewport',
          warningLayout?.documentWidth <= warningLayout?.viewportWidth
            && warningLayout?.withinViewport === true,
          JSON.stringify(warningLayout));
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // The Firefox startup check is a user-controlled install offer, never an
  // automatic navigation. Exercise the shared NoticeBar at side-panel and
  // full-page widths so both hosts keep the action and dismissal reachable.
  {
    name: 'update-notice-ui', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openExtPage(ctx, 'tests/fixtures/update-notice.html');
      try {
        const inspectAt = async (width) => {
          await page.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: 500,
            deviceScaleFactor: 1,
            mobile: false,
          });
          return waitFor(() => evalIn(page, `(() => {
            const notice = document.querySelector('.notice');
            const install = document.querySelector('.notice-action');
            const dismiss = document.querySelector('.notice-dismiss');
            if (!notice || !install || !dismiss) return null;
            install.focus();
            const noticeRect = notice.getBoundingClientRect();
            const installRect = install.getBoundingClientRect();
            const dismissRect = dismiss.getBoundingClientRect();
            return {
              width: innerWidth,
              documentWidth: document.documentElement.scrollWidth,
              text: notice.textContent ?? '',
              install: install.textContent?.trim() ?? '',
              dismissLabel: dismiss.getAttribute('aria-label'),
              installFocused: document.activeElement === install,
              installHeight: installRect.height,
              dismissWidth: dismissRect.width,
              dismissHeight: dismissRect.height,
              inside: [noticeRect, installRect, dismissRect]
                .every((rect) => rect.left >= 0 && rect.right <= innerWidth),
            };
          })()`), { budgetMs: 4_000, pollMs: 50 });
        };

        const narrow = await inspectAt(310);
        rec.check('the narrow Firefox update notice keeps both controls reachable',
          narrow?.documentWidth <= narrow?.width
            && narrow?.inside === true
            && narrow?.install === 'Install update'
            && narrow?.dismissLabel === 'Dismiss notice'
            && narrow?.installHeight >= 32
            && narrow?.dismissWidth >= 32
            && narrow?.dismissHeight >= 32,
          JSON.stringify(narrow));
        rec.check('the update action is keyboard focusable', narrow?.installFocused === true,
          JSON.stringify(narrow));

        await evalIn(page, `document.querySelector('.notice-action')?.click()`);
        const opened = await evalIn(page, `({
          url: document.body.dataset.openedUrl,
          target: document.body.dataset.openedTarget,
          features: document.body.dataset.openedFeatures,
        })`);
        rec.check('the explicit action opens only the expected HTTPS release asset',
          opened?.url === 'https://github.com/NotASithLord/peerd/releases/download/v0.7.0/peerd-preview-firefox.xpi'
            && opened?.target === '_blank'
            && opened?.features === 'noopener',
          JSON.stringify(opened));

        const wide = await inspectAt(900);
        rec.check('the full-page notice remains compact and within its viewport',
          wide?.documentWidth <= wide?.width && wide?.inside === true,
          JSON.stringify(wide));

        await evalIn(page, `document.querySelector('.notice-dismiss')?.click()`);
        const dismissed = await waitFor(() => evalIn(page,
          `document.querySelector('[role="status"]')?.textContent === 'Notice dismissed.'`),
        { budgetMs: 2_000, pollMs: 50 });
        rec.check('Dismiss removes the update offer', dismissed === true);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // Functional + rendered coverage for the actor-execution failure posture.
  // It uses the real banner and chat components without forcing a worker crash
  // into the shared live extension state.
  {
    name: 'actor-isolation-ui', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openExtPage(ctx, 'tests/fixtures/actor-isolation.html');
      try {
        await page.send('Page.bringToFront');
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 400,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const rendered = await waitFor(() => evalIn(page, `(() => {
          const banner = document.querySelector('.actor-isolation-banner');
          const retry = banner?.querySelector('button');
          const cards = [...document.querySelectorAll('button.path-card')];
          if (!banner || !retry || cards.length !== 6) return null;
          retry.focus();
          const rect = retry.getBoundingClientRect();
          return {
            role: banner.getAttribute('role'),
            live: banner.getAttribute('aria-live'),
            text: banner.textContent ?? '',
            retryFocused: document.activeElement === retry,
            retryWidth: rect.width,
            retryHeight: rect.height,
            askDisabled: cards[0].disabled,
            actorCardsDisabled: cards.slice(1).every((card) => card.disabled),
            actorCardFilters: cards.slice(1).map((card) => getComputedStyle(card).filter),
            actorLabels: cards.slice(1).map((card) => card.getAttribute('aria-label') ?? ''),
          };
        })()`), { budgetMs: 5_000, pollMs: 50 });

        rec.check('paused actor work is a polite persistent status',
          rendered?.role === 'status'
            && rendered?.live === 'polite'
            && rendered?.text.includes('Actor work is paused'));
        rec.check('the user-facing notice hides the raw worker failure',
          !!rendered && !rendered.text.includes('fixture-private-worker-error'));
        rec.check('retry is keyboard focusable with a 44px target',
          rendered?.retryFocused === true
            && rendered?.retryWidth >= 44
            && rendered?.retryHeight >= 44,
          JSON.stringify(rendered));
        rec.check('Ask remains available while every actor starter is unavailable and named honestly',
          rendered?.askDisabled === false
            && rendered?.actorCardsDisabled === true
            && rendered?.actorCardFilters.every((filter) => filter !== 'none')
            && rendered?.actorLabels.every((label) => label.includes('unavailable while actor work is paused')),
          JSON.stringify(rendered));
        // The real starter cards have a one-time staggered reveal. Let its
        // longest icon/label delay settle so the screenshot captures the
        // disabled state, not an intermediate animation frame.
        await sleep(1_200);
        await setEmulatedTheme(page, 'light');
        await sleep(80);
        await setEmulatedTheme(page, 'dark');
        await sleep(80);

        await evalIn(page, `document.querySelector('.actor-isolation-banner button')?.click()`);
        const retryFailed = await waitFor(() => evalIn(page, `(() => {
          const status = document.querySelector('.actor-isolation-banner');
          return status?.textContent?.includes('Actor work is still paused')
            ? { text: status.textContent ?? '', live: status.getAttribute('aria-live') }
            : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('failed retry is announced without raw worker details',
          retryFailed?.live === 'polite'
            && retryFailed?.text.includes('Actor execution could not be restored')
            && !retryFailed?.text.includes('actor_worker_start_timeout'),
          JSON.stringify(retryFailed));

        await evalIn(page, `document.querySelector('.actor-isolation-banner button')?.click()`);
        const recovered = await waitFor(() => evalIn(page, `(() => {
          const status = document.querySelector('.actor-isolation-banner.is-recovered');
          return status ? {
            text: status.textContent ?? '',
            focused: document.activeElement === status,
            retryPresent: !!status.querySelector('button'),
          } : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('successful retry moves focus to an honest recovery status',
          recovered?.focused === true
            && recovered?.retryPresent === false
            && recovered?.text.includes('Actor work is ready'),
          JSON.stringify(recovered));

        const onwardFocus = await evalIn(page, `(() => {
          const target = document.querySelector('button.path-card:not([disabled])');
          target?.focus();
          return {
            found: !!target,
            moved: document.activeElement === target,
            active: document.activeElement?.className ?? '',
          };
        })()`);
        const recoveryDismissed = await waitFor(() => evalIn(page,
          `!document.querySelector('.actor-isolation-banner')`),
        { budgetMs: 5_000, pollMs: 50 });
        rec.check('the recovery status clears after the user moves focus onward',
          onwardFocus?.moved === true && recoveryDismissed === true,
          JSON.stringify(onwardFocus));

        await evalIn(page, `globalThis.actorIsolationFixtureShowUnknownOutcome()`);
        const unknownOutcome = await waitFor(() => evalIn(page, `(() => {
          const card = document.querySelector('.tool-actor > button.tool-call-header');
          const reply = document.querySelector('.message-actor-reply');
          const announcement = document.querySelector('.actor-recovery-announcement[role="status"]');
          if (!card || !reply) return null;
          return {
            card: card.textContent ?? '',
            role: reply.querySelector('.role')?.textContent ?? '',
            body: reply.querySelector('.bubble')?.textContent ?? '',
            liveRole: announcement?.getAttribute('role') ?? null,
            live: announcement?.getAttribute('aria-live') ?? null,
            atomic: announcement?.getAttribute('aria-atomic') ?? null,
            announcement: announcement?.textContent ?? '',
            replyLive: reply.getAttribute('aria-live'),
          };
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('a post-start failure is labeled Outcome unknown, never Not run or done',
          unknownOutcome?.card.includes('Outcome unknown')
            && unknownOutcome?.role.includes('Outcome unknown')
            && !unknownOutcome?.card.includes('Not run')
            && !unknownOutcome?.card.includes('done'),
          JSON.stringify(unknownOutcome));
        rec.check('unknown-outcome recovery guidance remains visible to the user',
          unknownOutcome?.body.includes('peerd cannot confirm whether the actor ran or completed')
            && unknownOutcome?.body.includes('Check the target before trying again')
            && !unknownOutcome?.body.includes('Do not retry automatically'),
          JSON.stringify(unknownOutcome));
        const queuedRecovery = await evalIn(page, `(() => {
          const replies = [...document.querySelectorAll('.message-actor-reply')];
          const reply = replies.find((node) => node.querySelector('.role')?.textContent?.includes('Not run'));
          return reply ? {
            role: reply.querySelector('.role')?.textContent ?? '',
            body: reply.querySelector('.bubble')?.textContent ?? '',
            replyLive: reply.getAttribute('aria-live'),
            nestedStatuses: reply.querySelectorAll('[role="status"]').length,
          } : null;
        })()`);
        rec.check('a queued recovery receipt is labeled Not run, never failed or unknown',
          queuedRecovery?.role.includes('Not run')
            && !queuedRecovery?.role.includes('failed')
            && !queuedRecovery?.role.includes('Outcome unknown')
            && queuedRecovery?.body === 'No actor work was started. Review the request before trying again.',
          JSON.stringify(queuedRecovery));
        rec.check('recovery receipts use one transient polite atomic announcement',
          unknownOutcome?.liveRole === 'status'
            && unknownOutcome?.live === 'polite'
            && unknownOutcome?.atomic === 'true'
            && unknownOutcome?.announcement.includes('Actor outcome unknown')
            && unknownOutcome?.announcement.includes('Actor request not run')
            && unknownOutcome?.replyLive === null
            && queuedRecovery?.replyLive === null
            && queuedRecovery?.nestedStatuses === 0,
          JSON.stringify(unknownOutcome));
        const spawnedUnknown = await evalIn(page, `(() => {
          const cards = [...document.querySelectorAll('.tool-actor')];
          const card = cards.find((node) => node.querySelector('.tool-name')?.textContent === 'actor_create');
          const header = card?.querySelector('button.tool-call-header');
          header?.click();
          const announcement = document.querySelector('.actor-recovery-announcement[role="status"]');
          return {
            label: header?.textContent ?? '',
            permanentStatuses: card?.querySelectorAll('[role="status"]').length ?? 0,
            live: announcement?.getAttribute('aria-live'),
            atomic: announcement?.getAttribute('aria-atomic'),
            liveLabel: announcement?.textContent ?? '',
          };
        })()`);
        const spawnedUnknownBody = await waitFor(() => evalIn(page, `(() => {
          const cards = [...document.querySelectorAll('.tool-actor')];
          const card = cards.find((node) => node.querySelector('.tool-name')?.textContent === 'actor_create');
          return card?.querySelector('.actor-body')?.textContent ?? '';
        })()`), { budgetMs: 2_000, pollMs: 50 });
        rec.check('sync actor_create also labels the failure Outcome unknown',
          spawnedUnknown?.label.includes('Outcome unknown')
            && !spawnedUnknown?.label.includes('done'),
          JSON.stringify(spawnedUnknown));
        rec.check('sync actor_create shows only the human recovery step',
          spawnedUnknownBody?.includes('Check the target before trying again')
            && !spawnedUnknownBody?.includes('Do not retry automatically'),
          JSON.stringify({ ...spawnedUnknown, body: spawnedUnknownBody }));
        rec.check('sync actor_create uses the shared transient unknown-outcome announcement',
          spawnedUnknown?.permanentStatuses === 0
            && spawnedUnknown?.live === 'polite'
            && spawnedUnknown?.atomic === 'true'
            && spawnedUnknown?.liveLabel?.includes('Actor outcome unknown'),
          JSON.stringify(spawnedUnknown));
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
        // why: the keyless probe resolves just after mount; capture only its
        // settled contract so light and dark cannot split across probe states.
        const ollamaReady = await waitFor(() => evalIn(page, `(() => {
          const card = [...document.querySelectorAll('.provider-card')]
            .find((node) => node.querySelector('.provider-card-name')?.textContent === 'Ollama');
          return card?.querySelector('.key-badge')?.textContent?.trim() === '✓ Connected';
        })()`), { budgetMs: 5_000, pollMs: 50 });
        if (!ollamaReady) throw new Error('options full-tab Ollama probe did not settle');
        await rec.visualPage('options-fulltab', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  // --- the on-device model cards ------------------------------------------
  // options-fulltab captures the providers page from the top, which leaves the
  // Local (WebGPU) card below the fold - so the multi-model list it now renders
  // had no visual coverage at all. This state scrolls to that card and asserts
  // the two gates it stacks: a model the vendored Transformers.js can load
  // (offered, with a hardware test) and one it cannot (locked, no buttons).
  // why the real stack and not a stub: the support verdict comes from looking
  // the model class up on the actual vendored bundle in the offscreen document
  // - the one thing the unit tier has to fake.
  {
    name: 'options-local-models', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html');
      try {
        const cardReady = await waitFor(() => evalIn(page, `(() => {
          const card = document.querySelector('.provider-card-local .local-models');
          return (card?.querySelectorAll('.lm-model').length ?? 0) >= 2
            && [...card.querySelectorAll('.lm-state')].every((node) => !!node.textContent?.trim());
        })()`), { budgetMs: 20_000, pollMs: 100 });
        rec.check('local model cards render for every registered model', cardReady);

        const cards = await evalIn(page, `(() => {
          const rows = [...document.querySelectorAll('.provider-card-local .lm-model')];
          return JSON.stringify(rows.map((row) => ({
            name: row.querySelector('.lm-name')?.textContent ?? '',
            state: row.querySelector('.lm-state')?.textContent ?? '',
            buttons: [...row.querySelectorAll('button')].map((b) => ({ label: b.textContent?.trim() ?? '', disabled: b.disabled })),
          })));
        })()`);
        const rows = JSON.parse(cards || '[]');
        const gemma = rows.find((/** @type {any} */ r) => r.name.includes('Gemma'));
        const glimmer = rows.find((/** @type {any} */ r) => r.name.includes('Muse Glimmer'));
        rec.check('a runnable model offers its hardware test',
          !!gemma?.buttons?.some((/** @type {any} */ b) => /Test hardware/.test(b.label)));
        // The muse card's runtime gate is decided by the vendored runtime's own
        // device check, so its verdict is ENVIRONMENT-DEPENDENT (this harness
        // machine may or may not expose WebGPU). Both legitimate postures are
        // accepted; what must NEVER happen is an undecided/empty card, or a
        // download reachable without a passing hardware test.
        const glimmerLocked = !!glimmer && glimmer.buttons.length === 0 && /\S/.test(glimmer.state);
        const glimmerTestable = !!glimmer && glimmer.buttons.some((/** @type {any} */ b) => /Test hardware/.test(b.label));
        rec.check('the muse card reaches a decided posture (locked with a reason, or testable)',
          glimmerLocked !== glimmerTestable, JSON.stringify(glimmer));
        rec.check('no download is enabled before a passing hardware test',
          rows.every((/** @type {any} */ r) => r.buttons.every((/** @type {any} */ b) => !/^Download/.test(b.label) || b.disabled)),
          cards);
        rec.check('an uninstalled 12 GB model never reads as installed',
          !!glimmer && !/Installed|Downloaded/i.test(glimmer.state), JSON.stringify(glimmer));

        const focusCard = async () => {
          await evalIn(page, `document.querySelector('.provider-card-local')?.scrollIntoView({ block: 'center' })`);
        };
        await rec.visualPage('options-local-models', page, { beforeShot: focusCard });
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'options-voice-capabilities', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/voice');
      try {
        const posture = await waitFor(() => evalIn(page, `(() => {
          const voice = document.querySelector('.voice-section');
          const ocr = document.querySelector('.ocr-section');
          if (!voice || !ocr) return null;
          return {
            voice: voice.textContent,
            ocr: ocr.textContent,
            buttons: [...document.querySelectorAll('button')].map((button) => button.textContent),
          };
        })()`), { budgetMs: 15_000, pollMs: 80 });
        rec.check('Chrome Voice and OCR settings expose only hosted facilities',
          !posture?.voice?.includes('unavailable in this browser')
            && !posture?.ocr?.includes('unavailable in this browser')
            && posture?.buttons?.some((label) => label.includes('Enable voice')),
          JSON.stringify(posture));
        await setEmulatedTheme(page, 'dark');
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
  {
    name: 'options-learned-sites', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      let priorEntries = null;
      let page;
      try {
        const prior = await rpc(ctx.page, { type: 'learned/list' });
        if (!prior?.ok || !Array.isArray(prior.origins)) {
          throw new Error(`could not snapshot learned hosts: ${prior?.error ?? 'unknown error'}`);
        }
        priorEntries = prior.origins;
        await rpc(ctx.page, { type: 'learned/clear' });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
        await rpc(ctx.page, {
          type: 'debug/originLock',
          origin: 'https://accounts.acme.test:8443',
          seedReason: 'password-field',
        });
        await rpc(ctx.page, {
          type: 'debug/originLock',
          origin: 'http://portal.globex.test:9080',
          seedReason: 'confirmed-write',
        });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });

        page = await openWidePage(ctx, 'options/options.html#!/learned-sites');
        await waitFor(() => evalIn(page, `(() => {
          const text = document.body.innerText;
          return text.includes('accounts.acme.test')
            && text.includes('portal.globex.test')
            && text.includes('every port and its subdomains');
        })()`), { budgetMs: 15_000, pollMs: 80 });
        await rec.visualPage('options-learned-sites', page);
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
        if (priorEntries) {
          await rpc(ctx.page, { type: 'learned/clear' }).catch(() => {});
          await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } }).catch(() => {});
          for (const { host, reason } of priorEntries) {
            await rpc(ctx.page, {
              type: 'debug/originLock', origin: `https://${host}`, seedReason: reason,
            }).catch(() => {});
          }
          await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
        }
        try { page?.close(); } catch { /* */ }
      }
    },
  },
  {
    name: 'options-contributor-metrics', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/contributor-metrics');
      try {
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-metrics') !== null`),
          { budgetMs: 15_000, pollMs: 80 });
        // Exercise the exact human route through its real button so the capture
        // includes both the active disclosure state and the canonical bytes.
        await evalIn(page, `(() => {
          const button = [...document.querySelectorAll('button')]
            .find((entry) => entry.textContent === 'Enable Contributor Metrics');
          button?.click();
        })()`);
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-payload') !== null`),
          { budgetMs: 8_000, pollMs: 80 });
        const preview = await evalIn(page, `({
          readOnly: document.querySelector('.contributor-payload')?.readOnly,
          bytes: document.querySelector('.contributor-payload')?.value,
          uploadControls: [...document.querySelectorAll('button')]
            .some((entry) => /upload|send now/i.test(entry.textContent ?? '')),
        })`);
        rec.check('Contributor Metrics preview is exact, read-only, and has no upload action',
          preview?.readOnly === true
            && preview?.bytes === '{"schemaVersion":1,"rows":[]}'
            && preview?.uploadControls === false,
          JSON.stringify(preview));
        await rec.visualPage('options-contributor-metrics', page);
      } finally {
        try {
          await evalIn(page, `(() => {
            const button = [...document.querySelectorAll('button')]
              .find((entry) => entry.textContent === 'Disable and clear');
            button?.click();
          })()`);
          await waitFor(() => evalIn(page, `document.querySelector('.contributor-payload') === null`),
            { budgetMs: 4_000, pollMs: 80 });
        } catch { /* best-effort fixture cleanup */ }
        try { page.close(); } catch { /* */ }
      }
    },
  },
  {
    name: 'options-dweb-stop-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // The failure needs a live stop error that normal E2E cannot safely force.
      // This fixture mounts the real section and returns the real route shape.
      const page = await openWidePage(ctx, 'tests/fixtures/options-dweb-stop-failed.html', {
        ready: '[role="alert"]',
      });
      try {
        const status = await evalIn(page, `({
          warning: document.querySelector('[role="alert"]')?.textContent ?? '',
          retry: [...document.querySelectorAll('button')]
            .some((button) => button.textContent === 'Retry stopping dweb'),
        })`);
        rec.check('failed live stop stays visible',
          status?.warning.includes('live network could not be stopped'), status?.warning);
        rec.check('failed live stop remains retryable', status?.retry === true);
        await rec.visualPage('options-dweb-stop-failed', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  // --- visual: the STANDALONE TAB PAGES ---------------------------------------
  //
  // Coverage audit finding: every visual baseline photographed the side panel,
  // home or options, so six shipped pages - the four engine tabs, the mic
  // permission grant, and the eval runner — had NO pixel guard at all. These are
  // the cheap half of that gap: each renders fully with no instance, no seeding
  // and no model traffic, so they cost one openWidePage + a selector wait.
  //
  // The engine tabs are captured in their HARD-FAIL state, opened with no URL
  // hash. That is deliberate rather than a shortcut: the fail card IS the screen
  // a user meets when an id is stale, an image pin mismatches, or cross-origin
  // isolation is unavailable, and it is the only explanation they get for why
  // their VM/Notebook/App/Pod did not start. It is also the one state reachable
  // without booting CheerpX. The booted terminal / editor / render states remain
  // uncovered and want their own states with a seeded instance.
  {
    name: 'vm-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'engine-tabs/vm-tab/index.html', { ready: '.boot-card.is-failed' });
      try {
        // The boot log stamps each line with the WALL CLOCK, so this baseline
        // would differ on every single run and the state would flap forever.
        // Pin it to a fixed time rather than hiding the line — the timestamp's
        // presence and position are part of what the baseline should guard, its
        // value is not. (The harness's UTC timezone override does not help: the
        // problem is the time advancing, not the zone.)
        const pinVisualState = () => evalIn(page, `(() => {
          for (const el of document.querySelectorAll('#boot-log, #boot-log *')) {
            for (const n of el.childNodes) {
              if (n.nodeType === 3) n.textContent = n.textContent.replace(/\\d{2}:\\d{2}:\\d{2}/g, '00:00:00');
            }
          }
          const pullIn = document.querySelector('.peerd-pull');
          if (!pullIn) return false;
          // why: Chrome can omit a fixed backdrop-filter layer while the root
          // compositor pump is active. The failed VM screen is uniform behind
          // this chip, so removing only its blur preserves the intended render
          // and keeps the control in both theme captures.
          pullIn.style.backdropFilter = 'none';
          pullIn.style.webkitBackdropFilter = 'none';
          pullIn.getBoundingClientRect();
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

        const visualReady = await waitFor(pinVisualState, { budgetMs: 5000 });
        if (!visualReady) throw new Error('VM failure controls did not settle');
        await rec.visualPage('vm-tab-failed', page, { beforeShot: pinVisualState });
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'notebook-remote-restricted', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const notebookId = 'e2e-remote-restricted';
      const page = await openWidePage(
        ctx, `engine-tabs/notebook-tab/index.html#${notebookId}`,
        { ready: '#notebook-app:not([hidden])' },
      );
      try {
        // The production command path is service worker -> Notebook tab. These
        // states execute after the vault/worker boot gate, but on slow local
        // hosts the raw page can paint before its js/tab-ready announcement has
        // reached the worker. Wait for that exact round-trip before dispatch.
        const commandReady = await waitFor(async () => {
          const reply = await evalIn(ctx.swConn, `(async () => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
            if (!tab?.id) return null;
            return chrome.tabs.sendMessage(tab.id, {
              type: 'js/list-files', notebookId: ${JSON.stringify(notebookId)},
            }).catch(() => null);
          })()`, true);
          return reply?.ok === true;
        }, { budgetMs: 10_000, pollMs: 50 });
        if (!commandReady) throw new Error('Notebook command host did not become ready');
        const remoteSource = `
          export const probe = async () => {
            const attempts = {};
            const tryCall = async (name, fn) => {
              try { await fn(); attempts[name] = 'unexpected success'; }
              catch (error) { attempts[name] = String(error && error.message || error); }
            };
            for (const envelope of [
              { type: 'actor-request', rid: 'forged-actor', args: { task: 'leak' } },
              { type: 'fetch-request', rid: 'forged-fetch', url: 'https://sink.example/', method: 'GET' },
              { type: 'opfs-request', rid: 'forged-opfs', op: 'write', args: { path: 'canary.txt', content: 'changed' } },
              { type: 'distributed-request', rid: 'forged-dweb', method: 'peers' },
            ]) postMessage(envelope);
            await tryCall('egress', () => peerd.egress.fetch('https://sink.example/'));
            await tryCall('opfs', () => peerd.self.writeFile('canary.txt', 'changed'));
            await tryCall('subagent', () => peerd.runtime.runAgent({ task: 'leak' }));
            await tryCall('dweb', () => peerd.distributed.peers());
            return attempts;
          };
        `;
        const injected = await evalIn(page, `(async () => {
          const browser = (await import('/vendor/browser-polyfill.js')).default;
          const original = browser.runtime.sendMessage.bind(browser.runtime);
          globalThis.__remoteRestrictedCalls = [];
          browser.runtime.sendMessage = (message) => {
            globalThis.__remoteRestrictedCalls.push(message?.type ?? 'unknown');
            if (message?.type === 'sw/web-fetch') {
              return Promise.resolve({
                ok: true, status: 200,
                bodyB64: btoa(${JSON.stringify(remoteSource)}),
              });
            }
            return original(message);
          };
          return true;
        })()`, true);
        rec.check('the Notebook remote-fetch test seam is installed', injected === true);

        // Execute the command from the attached service-worker realm. The
        // Notebook host deliberately rejects the side-panel page as a command
        // source; evaluating here preserves the real browser-owned sender
        // provenance while still letting this state inspect the raw reply.
        const outcome = await evalIn(ctx.swConn, `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
          if (!tab?.id) return { error: 'Notebook tab not found' };
          await chrome.tabs.sendMessage(tab.id, {
            type: 'js/write-file', notebookId: ${JSON.stringify(notebookId)},
            path: 'canary.txt', content: 'unchanged',
          });
          const run = await chrome.tabs.sendMessage(tab.id, {
            type: 'js/eval', notebookId: ${JSON.stringify(notebookId)},
            code: "import { probe } from 'https://modules.example/probe.js'; return probe();",
            timeoutMs: 10_000,
          });
          const canary = await chrome.tabs.sendMessage(tab.id, {
            type: 'js/read-file', notebookId: ${JSON.stringify(notebookId)}, path: 'canary.txt',
          });
          return { run, canary };
        })()`, true);
        const calls = await evalIn(page, 'globalThis.__remoteRestrictedCalls ?? []');
        const view = await evalIn(page, `(() => ({
          status: document.getElementById('run-status')?.textContent ?? '',
          output: document.getElementById('console-output')?.textContent ?? '',
        }))()`);
        rec.check('the visible Notebook carries remote provenance',
          outcome?.run?.result?.usedRemoteModules === true, JSON.stringify(outcome));
        rec.check('remote code keeps only compute in the visible Notebook',
          ['egress', 'opfs', 'subagent', 'dweb'].every((key) =>
            String(outcome?.run?.result?.value?.[key] ?? '').includes('remote_module_capability_blocked')),
          JSON.stringify(outcome?.run?.result?.value));
        rec.check('direct forged relays never leave the Notebook host',
          Array.isArray(calls) && calls.filter((type) => type === 'sw/web-fetch').length === 1
            && !calls.some((type) => ['actor/spawn', 'dweb/distributed/info'].includes(type)),
          JSON.stringify(calls));
        rec.check('remote code cannot change the Notebook file canary',
          outcome?.canary?.content === 'unchanged', JSON.stringify(outcome?.canary));
        rec.check('the human sees a neutral restricted status and explanation',
          /Remote code ran with restricted access/.test(view?.status ?? '')
            && /Remote imports run with compute only/.test(view?.output ?? ''),
          JSON.stringify(view));
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'notebook-stop-control', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const notebookId = 'e2e-stop-control';
      const page = await openWidePage(
        ctx, `engine-tabs/notebook-tab/index.html#${notebookId}`,
        { ready: '#notebook-app:not([hidden])' },
      );
      try {
        const commandReady = await waitFor(async () => {
          const reply = await evalIn(ctx.swConn, `(async () => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
            if (!tab?.id) return null;
            return chrome.tabs.sendMessage(tab.id, {
              type: 'js/list-files', notebookId: ${JSON.stringify(notebookId)},
            }).catch(() => null);
          })()`, true);
          return reply?.ok === true;
        }, { budgetMs: 10_000, pollMs: 50 });
        if (!commandReady) throw new Error('Notebook command host did not become ready');
        const dispatched = await evalIn(ctx.swConn, `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
          if (!tab?.id) return false;
          chrome.tabs.sendMessage(tab.id, {
            type: 'js/eval', notebookId: ${JSON.stringify(notebookId)},
            runId: 'e2e-stop-control-run', code: 'while (true) {}', timeoutMs: 20_000,
          }).catch(() => {});
          return true;
        })()`, true);
        rec.check('the infinite Notebook run is dispatched', dispatched === true);
        const started = await evalIn(page, `(async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const button = document.getElementById('run-btn');
            if (button?.getAttribute('aria-label') === 'Stop notebook run') {
              button.focus();
              return {
                label: button.getAttribute('aria-label'),
                text: button.textContent,
                focused: document.activeElement === button,
              };
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          }
          return null;
        })()`, true);
        rec.check('the Notebook exposes one focused Stop control while code runs',
          started?.label === 'Stop notebook run'
            && /Stop notebook run/.test(started?.text ?? '')
            && started?.focused === true,
          JSON.stringify(started));

        const stopped = await evalIn(ctx.swConn, `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
          if (!tab?.id) return null;
          return chrome.tabs.sendMessage(tab.id, {
            type: 'js/abort', notebookId: ${JSON.stringify(notebookId)},
            runId: 'e2e-stop-control-run',
          });
        })()`, true);
        const outcome = await evalIn(page, `(async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const button = document.getElementById('run-btn');
            if (button?.getAttribute('aria-label') === 'Run notebook.js') {
              return {
                idleLabel: button.getAttribute('aria-label'),
                focused: document.activeElement === button,
                status: document.getElementById('run-status')?.textContent ?? '',
              };
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          }
          return {};
        })()`, true);
        rec.check('Stop terminates the exact run and restores the focused Run control',
          stopped?.stopped === true
            && outcome?.idleLabel === 'Run notebook.js'
            && outcome?.focused === true
            && outcome?.status === 'Notebook run stopped.',
          JSON.stringify({ stopped, outcome }));

        const importedFailure = await evalIn(ctx.swConn, `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
          if (!tab?.id) return null;
          await chrome.tabs.sendMessage(tab.id, {
            type: 'js/write-file', path: 'lib/failure.js',
            content: 'throw new Error("imported failure canary");',
          });
          return chrome.tabs.sendMessage(tab.id, {
            type: 'js/eval', notebookId: ${JSON.stringify(notebookId)},
            runId: 'e2e-imported-failure',
            code: 'import "./lib/failure.js"; return true;', timeoutMs: 10_000,
          });
        })()`, true);
        const failureView = await evalIn(page, `({
          status: document.getElementById('run-status')?.textContent ?? '',
          output: document.getElementById('console-output')?.textContent ?? '',
        })`, true);
        rec.check('Chrome maps an imported-module failure to its source without a generated URL',
          importedFailure?.result?.error?.includes('./lib/failure.js:1')
            && !/blob:|data:/.test(importedFailure?.result?.error ?? '')
            && failureView?.status === 'Notebook run failed.'
            && failureView?.output?.includes('./lib/failure.js:1')
            && !/blob:|data:/.test(failureView?.output ?? ''),
          JSON.stringify({ importedFailure, failureView }));
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'notebook-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // notebook-tab replaces <body> wholesale with its red no-id paragraph, so
      // the probe cannot look for a page id — `body > p` is what actually lands.
      const page = await openWidePage(ctx, 'engine-tabs/notebook-tab/index.html', { ready: 'body > p' });
      try { await rec.visualPage('notebook-tab-failed', page); }
      finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'app-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // The message node exists in the initial loading frame. Wait for the
      // failure class so the light capture cannot race the module startup.
      const page = await openWidePage(ctx, 'engine-tabs/app-tab/index.html', { ready: '#boot.is-failed' });
      try { await rec.visualPage('app-tab-failed', page); }
      finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'pod-tab-failed', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // The boot card exists before startup settles. Wait for the production
      // failure class so both theme captures contain the final no-id error state.
      const page = await openWidePage(ctx, 'engine-tabs/pod-tab/index.html', { ready: '#pod-boot.is-failed' });
      const pinVisualState = async () => {
        // why: CDP keeps the pointer coordinates when targets change. A prior
        // state can leave it over the pull-in chip and capture its hover border.
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
        return evalIn(page, `(() => {
          const pullIn = document.querySelector('.peerd-pull');
          if (!pullIn) return false;
          // why: Chrome can omit this fixed backdrop-filter layer during a
          // theme compositor repaint. Pinning the blur keeps both shots exact.
          pullIn.style.backdropFilter = 'none';
          pullIn.style.webkitBackdropFilter = 'none';
          pullIn.getBoundingClientRect();
          return true;
        })()`);
      };
      const visualReady = await waitFor(pinVisualState, { budgetMs: 5000 });
      if (!visualReady) throw new Error('Pod failure controls did not settle');
      try { await rec.visualPage('pod-tab-failed', page, { beforeShot: pinVisualState }); }
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

  // --- functional: the ORCHESTRATOR delegates from CODE (script + actors.call) ---
  // The actors-in-script surface end to end: the model writes ONE script whose
  // code awaits actors.call('web', …); the call relays offscreen-worker → SW
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
        isWebActor: body.includes('kind: bound; type: web'),
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
      if (isActor) return { sse: sseText('WIDGET_PRICE_777'), delayMs: 5000 };
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
          code: "const r = await actors.call('web', 'price of widget X?'); return 'GOT:' + r.reply + ':' + r.failed;",
        }) };
      }
      return { sse: sseText('unexpected extra orchestrator step') };
    },
    async run(ctx, rec) {
      scriptFanState = { scripts: 0, seen: [] };
      // Capture transient live-feed DOM before the turn starts. A loaded full
      // run can finish between CDP polls even when the actor response is held;
      // the page-side observer makes "was rendered" durable for this state.
      await evalIn(ctx.page, `(() => {
        globalThis.__peerdScriptFanObserver?.disconnect();
        const state = globalThis.__peerdScriptFanE2e = {
          opsSeen: false, finalSeen: false, cardOk: false,
        };
        const sample = () => {
          state.opsSeen ||= !!document.querySelector('.tool-call .script-ops .script-op');
          state.finalSeen ||= [...document.querySelectorAll('.message-assistant .bubble')]
            .some((bubble) => bubble.textContent.trim() === 'SCRIPT-FAN-DONE');
          state.cardOk ||= [...document.querySelectorAll('.tool-call.tool-ok')]
            .some((card) => card.querySelector('.tool-name')?.textContent === 'script');
        };
        globalThis.__peerdScriptFanObserver = new MutationObserver(sample);
        globalThis.__peerdScriptFanObserver.observe(document.body, { childList: true, subtree: true });
        sample();
      })()`);
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'script-check the widget price' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      // The live delegation feed appears on the pending script card.
      const liveState = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const state = globalThis.__peerdScriptFanE2e;
          return state?.opsSeen || state?.finalSeen ? state : null;
        })()`),
        { budgetMs: 90_000, pollMs: 100 });
      const opsSeen = liveState?.opsSeen === true;
      rec.check('the live delegation feed renders on the pending script card', !!opsSeen);
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const tracked = globalThis.__peerdScriptFanE2e ?? {};
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          const results = [...document.querySelectorAll('.tool-call .tool-result')].map((r) => r.textContent || '');
          const cardOk = !!document.querySelector('.tool-call.tool-ok .tool-name') &&
            [...document.querySelectorAll('.tool-call .tool-name')].some((n) => n.textContent === 'script');
          return {
            bubbles, busy, results,
            finalSeen: tracked.finalSeen === true || bubbles.includes('SCRIPT-FAN-DONE'),
            cardOk: tracked.cardOk === true || cardOk,
          };
        })()`) || {};
        return out.finalSeen && !out.busy;
      }, { budgetMs: 90_000 });

      const seen = scriptFanState.seen;
      const actorTurns = seen.filter((s) => s.isActor && s.isWebActor);
      const resultTurn = seen.filter((s) => !s.isActor && s.hasScriptResult);
      rec.check('the model called script exactly once', scriptFanState.scripts === 1, `scripts=${scriptFanState.scripts}`);
      rec.check("the script's actors.call spawned a REAL web-actor turn", actorTurns.length >= 1, `actorTurns=${actorTurns.length}`);
      rec.check("the orchestrator read a result whose value was built FROM the actor's reply", resultTurn.length >= 1, `resultTurns=${resultTurn.length}`);
      rec.check('the final orchestrator answer landed', out.finalSeen === true);
      rec.check('the script card settled ok', out.cardOk === true);
      await evalIn(ctx.page, `globalThis.__peerdScriptFanObserver?.disconnect()`);
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
        isWebActor: body.includes('kind: bound; type: web'),
        hasReplyLead: body.includes('you messaged has replied'),
        hasFence: body.includes('<untrusted_web_content'),
        hasActorText: body.includes('PRICE_IS_42'),
      });
      // ACTOR sub-loop turn: plain text, no tool call → no fetch_url → no egress.
      // Hold the isolated turn open long enough to inspect the live Actor Fabric
      // at real side-panel width; without this, the fake reply can settle within
      // one paint and only the terminal transcript receipt is observable.
      if (isActor) return { delayMs: 12_000, sse: sseText('PRICE_IS_42') };
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
      const fabric = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const panel = document.querySelector('.actor-fabric');
          const toggle = panel?.querySelector('.actor-fabric-toggle');
          const actor = panel?.querySelector('[data-node-id^="actor:"]');
          if (!panel || !toggle || !actor) return null;
          const toggleRect = toggle.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          const body = panel.querySelector('.actor-fabric-body');
          return {
            expanded: toggle.getAttribute('aria-expanded'),
            actorKind: actor.getAttribute('data-node-kind'),
            actorPressed: actor.getAttribute('aria-pressed'),
            text: panel.textContent ?? '',
            toggleHeight: toggleRect.height,
            withinViewport: panelRect.left >= 0 && panelRect.right <= innerWidth,
            contentFits: !!body && body.scrollWidth <= body.clientWidth
              && [...body.querySelectorAll('.actor-fabric-node')].every((node) => node.scrollWidth <= node.clientWidth),
          };
        })()`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('the live Actor Fabric mounts expanded with an inspectable bound actor',
        fabric?.expanded === 'true'
          && fabric?.actorKind === 'bound'
          && fabric?.actorPressed === 'false',
        JSON.stringify(fabric));
      rec.check('the fabric makes exact capability + fenced handoff concrete at a glance',
        fabric?.text.includes('one web tab ·')
          && fabric?.text.includes('separate worker')
          && fabric?.text.includes('fenced reply'),
        JSON.stringify(fabric?.text));
      rec.check('the fabric fits the panel and keeps a 44px disclosure target',
        fabric?.withinViewport === true
          && fabric?.contentFits === true
          && fabric?.toggleHeight >= 44,
        JSON.stringify(fabric));
      if (fabric) {
        await ctx.page.send('Page.reload', { ignoreCache: true });
        const rehydrated = await waitFor(
          () => evalIn(ctx.page, `(() => {
            const panel = document.querySelector('.actor-fabric');
            const actor = panel?.querySelector('[data-node-id^="actor:"]');
            return panel && actor ? panel.textContent : null;
          })()`),
          { budgetMs: 15_000, pollMs: 50 });
        rec.check('a freshly reconnected panel rehydrates the still-live actor fabric',
          typeof rehydrated === 'string'
            && rehydrated.includes('get the price of widget X')
            && rehydrated.includes('separate worker'),
          JSON.stringify(rehydrated));
        await evalIn(ctx.page, `(() => {
          const actor = document.querySelector('[data-node-id^="actor:"]');
          actor?.click();
          actor?.focus();
        })()`);
        const inspected = await waitFor(() => evalIn(ctx.page, `(() => {
          const actor = document.querySelector('[data-node-id^="actor:"]');
          const detail = document.querySelector('.actor-fabric-detail');
          if (!actor || !detail) return null;
          return {
            pressed: actor?.getAttribute('aria-pressed'),
            detail: detail?.textContent ?? '',
            announced: document.querySelector('.actor-fabric-announcer')?.textContent ?? '',
          };
        })()`), { budgetMs: 2_000, pollMs: 25 });
        rec.check('selecting an actor reveals its authoritative access and memory boundary',
          inspected?.pressed === 'true'
            && inspected?.detail.includes('one web tab · page_code · site_client_run')
            && inspected?.detail.includes('Dedicated keyless worker')
            && inspected?.detail.includes('no key or extension APIs')
            && inspected?.announced.includes('details shown'),
          JSON.stringify(inspected));
      }
      const settledFabric = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const panel = document.querySelector('.actor-fabric.is-settled');
          const focused = document.querySelector('[data-node-id^="actor:"]');
          if (!panel || !focused) return null;
          return {
            text: panel.textContent ?? '',
            focusPreserved: document.activeElement === focused,
          };
        })()`),
        { budgetMs: 15_000, pollMs: 50 });
      rec.check('settling announces completion without dropping focused actor controls',
        settledFabric?.text.includes('all actor work finished')
          && settledFabric?.focusPreserved === true,
        JSON.stringify(settledFabric));
      await evalIn(ctx.page, `document.querySelector('.input-bar textarea')?.focus()`);
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const cardOk = !!document.querySelector('.tool-call.tool-actor.tool-ok');
          const name = document.querySelector('.tool-actor .tool-name')?.textContent || '';
          const busy = !!document.querySelector('form.input-bar button.stop');
          const fabricGone = !document.querySelector('.actor-fabric');
          const users = [...document.querySelectorAll('.message-user')].map((u) => u.textContent.trim());
          const replies = [...document.querySelectorAll('.message-actor-reply')].map((r) => ({
            role: r.querySelector('.role')?.textContent || '',
            body: r.querySelector('.bubble')?.textContent || '',
          }));
          return { bubbles, cardOk, name, busy, fabricGone, users, replies };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-ORCH-REPLY') && !out.busy && out.fabricGone;
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
      rec.check('the Actor Fabric self-hides when no isolated work remains', out.fabricGone === true);
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
    },
  },

  // The custody boundary has two audiences. The actor needs an instruction it
  // can act on without looping; the person needs a short recovery step. Drive
  // the live actor-error stream and prove the card never crosses those copies.
  {
    name: 'actor-boundary-error-card', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>')) {
        const error = JSON.stringify({ error: {
          message: 'actor-provider-boundary-blocked: The actor model request was not run. '
            + 'Do not retry automatically. Ask the user to reload peerd before another actor attempt.',
        } });
        return { sse: `data: ${error}\n\n${sseText('')}` };
      }
      if (body.includes('could not complete your request')) return { sse: sseText('BOUNDARY-FAILURE-NOTED') };
      if (actorBoundaryState.delegates === 0) {
        actorBoundaryState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'web', message: 'inspect the current page' }) };
      }
      return { sse: sseText('Delegated to the web actor.') };
    },
    async run(ctx, rec) {
      actorBoundaryState = { delegates: 0 };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'inspect this page safely' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      const notRun = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call.tool-actor.tool-not-run')`),
        { budgetMs: 25_000, pollMs: 100 });
      rec.check('the live actor card settles as Not run', !!notRun);
      await evalIn(ctx.page, `document.querySelector('.tool-actor .tool-call-header')?.click()`);
      const expanded = await waitFor(
        () => evalIn(ctx.page, `document.querySelector('.tool-actor .tool-call-header')?.getAttribute('aria-expanded') === 'true'
          && !!document.querySelector('.tool-actor .actor-body')`),
        { budgetMs: 5_000, pollMs: 50 });
      rec.check('the live actor card expands', !!expanded);
      const out = await evalIn(ctx.page, `(() => {
        const card = document.querySelector('.tool-call.tool-actor');
        return {
          label: card?.querySelector('.tool-duration')?.textContent || '',
          body: card?.querySelector('.actor-body')?.textContent || '',
        };
      })()`);
      rec.check('the live card labels the request Not run', out?.label === 'Not run', JSON.stringify(out?.label));
      rec.check('the live card uses generic host-proven Not run guidance',
        (out?.body || '').includes('No actor work was started. Review the request before trying again.'),
        JSON.stringify(out?.body));
      rec.check('the live card does not trust provider recovery tokens or instructions',
        !/actor-provider-boundary-blocked|Reload peerd|Do not retry automatically|Ask the user/i
          .test(out?.body || ''), JSON.stringify(out?.body));
      const replyReady = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.message-actor-reply')`),
        { budgetMs: 25_000, pollMs: 100 });
      rec.check('the failed actor reply is visible', !!replyReady);
      const reply = await evalIn(ctx.page, `(() => {
        const message = document.querySelector('.message-actor-reply');
        return {
          role: message?.querySelector('.role')?.textContent || '',
          body: message?.querySelector('.bubble')?.textContent || '',
        };
      })()`);
      rec.check('the failed actor reply is also labeled Not run',
        /Not run/.test(reply?.role || ''), JSON.stringify(reply?.role));
      rec.check('the failed actor reply uses the same generic Not run guidance',
        (reply?.body || '') === 'No actor work was started. Review the request before trying again.'
          && !/actor-provider-boundary-blocked|Reload peerd|Do not retry automatically|Ask the user/i
            .test(reply?.body || ''),
        JSON.stringify(reply?.body));
      await waitFor(async () => { const state = await probe(ctx); return !state.busy; }, { budgetMs: 25_000 });
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
      rec.check(
        'a2a_run EXECUTED — the code surface ran through the mesh bridge + SW route (tool_executed audit)',
        a2aRan === true,
        a2aRan ? 'a2aRan=true' : JSON.stringify(entries.filter((entry) =>
          String(entry.type).startsWith('tool_') || JSON.stringify(entry.details || {}).includes('a2a')).slice(-12)),
      );
      rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('A2A-FINAL'));
      rec.check('the turn settles idle', out.busy === false);
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
    },
  },

  // --- functional: a pure-reasoning actor runs in its OWN isolated heap ---
  // Heap-split phase 1. The orchestrator spawns a sync tools:[] actor; that
  // child's loop runs in a dedicated Worker (its own heap, no key),
  // relaying its model call back to the SW. Proof: the child model call happens
  // (its prompt carries the EPHEMERAL ACTOR block), the result round-trips into
  // the orchestrator's final answer, AND the host-neutral actor_ran_isolated
  // audit carries the dedicated-worker and verified-realm proof fields.
  {
    name: 'reasoning-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model call — its system prompt is the ephemeral-actor block.
      // Match the compact actor kernel's structural identity, not mutable prose.
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) { reasoningState.childCalls += 1; return { sse: sseText('REASONED-FOURTY-TWO') }; }
      // ORCHESTRATOR — spawn ONE sync pure-reasoning child, then (post tool-result) answer.
      if (reasoningState.spawned === 0) {
        reasoningState.spawned += 1;
        return { sse: sseToolCall('actor_create', { task: 'compute the answer to life', tools: [], sync: true }) };
      }
      return { sse: sseText('FINAL-ANSWER-42') };
    },
    async run(ctx, rec) {
      reasoningState = { spawned: 0, childCalls: 0 };
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
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

      const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
      const isolation = actorIsolationEvidence(entries);
      const actorTypes = entries.filter((e) => String(e.type).startsWith('spawned')).map((e) => e.type);
      rec.check('the child sub-loop ran (EPHEMERAL ACTOR prompt seen)', reasoningState.childCalls >= 1, `childCalls=${reasoningState.childCalls}`);
      rec.check('the pure-reasoning child ran in a dedicated Worker with a verified realm', isolation.exactProof === true, `isolated=${isolation.isolated.length} backgroundRefused=${isolation.backgroundRefused} isolationFailed=${isolation.isolationFailed} bubbles=${JSON.stringify(out.bubbles)} actorAudits=${JSON.stringify(actorTypes)}`);
      rec.check('it did NOT enter the background turn driver or fail isolation', isolation.backgroundRefused === false && isolation.isolationFailed === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-ANSWER-42'));
      rec.check('the turn settles idle', out.busy === false);
    },
  },

  // --- functional: a TOOL-BEARING actor runs in its OWN isolated heap ---
  // Heap-split phase 4. The orchestrator spawns a sync actor GRANTED script;
  // that child's loop runs in a dedicated Worker (its own heap, no key)
  // and RELAYS its script call back to the SW, which rebuilds the child's restricted
  // ctx from the persisted grantedTools and dispatches script in the offscreen
  // job-runner. Proof: the child looped (two model calls: emit script, then answer),
  // the actor_ran_isolated audit carries the dedicated-worker realm proof,
  // AND a tool_executed audit for script is present (the relayed tool actually ran).
  {
    name: 'actor-tools-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The CHILD's model calls (ephemeral-actor prompt). First call emits script;
      // second call (after the tool result re-enters its heap) answers.
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
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
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
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

      const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
      const isolation = actorIsolationEvidence(entries);
      const jsRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'script');
      rec.check('the tool-bearing child looped in its heap (script emitted, then answered) — 2 child calls', actorToolsState.childCalls >= 2, `childCalls=${actorToolsState.childCalls}`);
      rec.check('the child ran in a dedicated Worker with a verified realm', isolation.exactProof === true, `isolated=${isolation.isolated.length}`);
      rec.check('script actually executed via the SW-gated relay (tool_executed audit)', jsRan === true, `jsRan=${jsRan}`);
      rec.check('it did NOT enter the background turn driver or fail isolation', isolation.backgroundRefused === false && isolation.isolationFailed === false);
      rec.check('the child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-WITH-CHILD'));
      rec.check('the turn settles idle', out.busy === false);
    },
  },

  // --- functional: a trusted spawned actor delegates FROM CODE (#324) -------
  // Direct message_actor already admitted this trusted lineage. This state proves
  // the code hand has exact parity: actor heap -> script worker -> actors.call relay
  // -> web-actor heap -> reply back into code -> child -> orchestrator.
  {
    name: 'actor-code-delegates-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('kind: bound; type: web')) {
        actorCodeDelegatesState.webCalls += 1;
        return { sse: sseText('WEB-CODE-PRICE-101') };
      }
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
        actorCodeDelegatesState.childCalls += 1;
        if (body.includes('CODE:')
          && body.includes('WEB-CODE-PRICE-101')
          && body.includes('untrusted')) {
          actorCodeDelegatesState.sawComposedResult = true;
        }
        if (actorCodeDelegatesState.childCalls === 1) {
          return { sse: sseToolCall('script', {
            code: "const r = await actors.call('web', 'get the code-path price'); return 'CODE:' + r.reply;",
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
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
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

      const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
      const isolation = actorIsolationEvidence(entries);
      const jsRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'script');
      rec.check('the actor script ran through the SW-gated relay', jsRan === true, `jsRan=${jsRan}`);
      rec.check('the actor looped after code received the web reply', actorCodeDelegatesState.childCalls >= 2 && actorCodeDelegatesState.sawComposedResult, `childCalls=${actorCodeDelegatesState.childCalls} composed=${actorCodeDelegatesState.sawComposedResult}`);
      rec.check('actors.call reached a real web-actor heap', actorCodeDelegatesState.webCalls >= 1, `webCalls=${actorCodeDelegatesState.webCalls}`);
      rec.check('the actor stayed in a dedicated Worker with a verified realm', isolation.exactProof === true && isolation.backgroundRefused === false && isolation.isolationFailed === false, `isolated=${isolation.isolated.length} backgroundRefused=${isolation.backgroundRefused} isolationFailed=${isolation.isolationFailed}`);
      rec.check('the composed result reached the orchestrator', (out.bubbles || []).includes('FINAL-VIA-ACTOR-CODE'));
      rec.check('the turn settles idle', out.busy === false);
    },
  },

  // --- functional + visual: the real nested Actor Fabric at panel width ----
  // Two async siblings overlap; one delegates to its bound web actor. This is
  // the defining topology (root → temporary child → resource-bound child), not
  // a component fixture, and catches indentation/connector/overflow failures.
  {
    name: 'actor-fabric-hierarchy', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('kind: bound; type: web')) {
        actorFabricHierarchyState.webCalls += 1;
        return { delayMs: 5_000, sse: sseText('NESTED-WEB-DONE') };
      }
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
        if (body.includes('inspect price through the web actor')) {
          actorFabricHierarchyState.nestedCalls += 1;
          if (actorFabricHierarchyState.nestedCalls === 1) {
            return { sse: sseToolCall('message_actor', { to: 'web', message: 'inspect the current price' }) };
          }
          return { sse: sseText('NESTED-CHILD-DONE') };
        }
        actorFabricHierarchyState.siblingCalls += 1;
        return { delayMs: 6_000, sse: sseText('SIBLING-DONE') };
      }
      if (actorFabricHierarchyState.spawned === 0) {
        actorFabricHierarchyState.spawned += 1;
        return { sse: sseToolCall('actor_create', {
          task: 'inspect price through the web actor', tools: ['message_actor'],
        }) };
      }
      if (actorFabricHierarchyState.spawned === 1) {
        actorFabricHierarchyState.spawned += 1;
        return { sse: sseToolCall('actor_create', {
          task: 'compare warranty terms independently', tools: [],
        }) };
      }
      return { sse: sseText('FABRIC-MAIN-IDLE') };
    },
    async run(ctx, rec) {
      actorFabricHierarchyState = {
        spawned: 0, nestedCalls: 0, siblingCalls: 0, webCalls: 0,
      };
      const sent = await rpc(ctx.page, {
        type: 'agent/send', text: 'compare price and warranty with isolated actors',
      });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      const hierarchy = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const panel = document.querySelector('.actor-fabric');
          const body = panel?.querySelector('.actor-fabric-body');
          const top = body?.querySelector(':scope > .actor-fabric-branch');
          if (!panel || !body || !top) return null;
          const topSubactors = [...top.children]
            .filter((item) => item.querySelector(':scope > .actor-fabric-node.is-subactor')).length;
          const nestedBound = body.querySelector('.actor-fabric-branch .actor-fabric-branch .actor-fabric-node.is-bound');
          if (topSubactors < 2 || !nestedBound) return null;
          const panelRect = panel.getBoundingClientRect();
          return {
            nodes: body.querySelectorAll('.actor-fabric-node').length,
            topSubactors,
            nestedBound: !!nestedBound,
            text: panel.textContent ?? '',
            contentFits: body.scrollWidth <= body.clientWidth,
            heightCapped: panelRect.height <= Math.min(innerHeight * 0.61, 525),
            outerScrollTop: document.querySelector('.body')?.scrollTop ?? 0,
          };
        })()`),
        { budgetMs: 20_000, pollMs: 50 });
      rec.check('the live fabric renders two sibling subactors and one nested bound actor',
        hierarchy?.nodes >= 4
          && hierarchy?.topSubactors >= 2
          && hierarchy?.nestedBound === true,
        JSON.stringify(hierarchy));
      rec.check('the deep hierarchy fits 390px and stays height-bounded',
        hierarchy?.contentFits === true && hierarchy?.heightCapped === true,
        JSON.stringify(hierarchy));
      rec.check('solid/dashed semantics and both real tasks are legible',
        hierarchy?.text.includes('temporary subactor')
          && hierarchy?.text.includes('web actor')
          && hierarchy?.text.includes('inspect price through the web actor')
          && hierarchy?.text.includes('compare warranty terms independently'),
        JSON.stringify(hierarchy?.text));

      await evalIn(ctx.page, `document.querySelector('.actor-fabric-branch .actor-fabric-branch .actor-fabric-node.is-bound')?.click()`);
      const inspected = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const detail = document.querySelector('.actor-fabric-detail');
          const body = detail?.closest('.actor-fabric-body');
          const toggle = document.querySelector('.actor-fabric-toggle');
          if (!detail || !body) return null;
          const detailRect = detail.getBoundingClientRect();
          const bodyRect = body.getBoundingClientRect();
          const toggleRect = toggle?.getBoundingClientRect();
          return {
            text: detail.textContent ?? '',
            fullyVisible: detailRect.top >= bodyRect.top - 1 && detailRect.bottom <= bodyRect.bottom + 1,
            headerVisible: !!toggleRect && toggleRect.top >= 0 && toggleRect.bottom <= innerHeight,
            outerScrollTop: document.querySelector('.body')?.scrollTop ?? 0,
          };
        })()`),
        { budgetMs: 2_000, pollMs: 25 });
      rec.check('the nested bound actor remains inspectable',
        inspected?.fullyVisible === true
          && inspected?.headerVisible === true
          && inspected?.outerScrollTop === hierarchy?.outerScrollTop
          && inspected?.text.includes('one web tab')
          && inspected?.text.includes('Dedicated keyless worker'),
        JSON.stringify(inspected));

      const finished = await waitFor(
        () => evalIn(ctx.page, `(() => {
          const panel = document.querySelector('.actor-fabric.is-settled');
          const body = panel?.querySelector('.actor-fabric-body');
          if (!panel || !body) return null;
          return {
            nodes: body.querySelectorAll('.actor-fabric-node').length,
            nested: !!body.querySelector('.actor-fabric-branch .actor-fabric-branch .actor-fabric-node.is-bound'),
            text: panel.textContent ?? '',
          };
        })()`),
        { budgetMs: 25_000, pollMs: 50 });
      rec.check('the completion receipt preserves the full work-batch topology',
        finished?.nodes === 4
          && finished?.nested === true
          && finished?.text.includes('all actor work finished'),
        JSON.stringify(finished));
      await evalIn(ctx.page, `document.querySelector('.input-bar textarea')?.focus()`);
    },
  },

  // --- functional + visual: full-page, cross-session Actor Space -----------
  // Two chats keep temporary actors alive at once. The home monitor must show
  // two independent orchestrator rooms without merging their lineages, expose
  // an inspectable physical boundary, and collapse to its permanent empty state
  // after both work graphs stop.
  {
    name: 'actor-overview', kind: 'functional', phase: 'post-unlock',
    responder: async (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>') && body.includes('alpha isolated research')) {
        await actorOverviewState.liveGate;
        return { sse: sseText('ALPHA-ACTOR-DONE') };
      }
      if (body.includes('ALPHA-ROOT')) {
        if (actorOverviewState.alphaSpawned === 0) {
          actorOverviewState.alphaSpawned = 4;
          return { sse: sseToolCalls(Array.from({ length: 4 }, (_, index) => ({
            name: 'actor_create',
            args: { task: `alpha isolated research ${index + 1}`, tools: [] },
          }))) };
        }
        return { sse: sseText('ALPHA-DELEGATED') };
      }
      if (body.includes('BETA-ROOT')) {
        await actorOverviewState.liveGate;
        return { sse: sseText('BETA-ORCHESTRATOR-DONE') };
      }
      return { sse: sseText('overview-state-idle') };
    },
    async run(ctx, rec) {
      let releaseLive = () => {};
      const liveGate = new Promise((resolve) => { releaseLive = () => resolve(undefined); });
      actorOverviewState = { alphaSpawned: 0, betaSpawned: 0, liveGate, releaseLive };
      // A reset leaves a deliberately sessionless composer until first send.
      // Seed two ordinary chats before starting either long-running actor so
      // switching between their durable ids cannot stop the other's work.
      await rpc(ctx.page, { type: 'agent/send', text: 'Launch risk orchestration workspace' });
      const firstState = await waitFor(async () => {
        const state = await rpc(ctx.page, { type: 'state/get' });
        return state?.state?.session?.sessionId && !(await probe(ctx)).busy ? state : null;
      }, { budgetMs: 30_000, pollMs: 80 });
      const alphaRoot = firstState?.state?.session?.sessionId;
      await rpc(ctx.page, { type: 'session/reset' });
      await waitFor(async () => !(await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId,
        { budgetMs: 5_000, pollMs: 50 });
      await rpc(ctx.page, { type: 'agent/send', text: 'Rollout options workspace' });
      const secondState = await waitFor(async () => {
        const state = await rpc(ctx.page, { type: 'state/get' });
        return state?.state?.session?.sessionId && !(await probe(ctx)).busy ? state : null;
      }, { budgetMs: 30_000, pollMs: 80 });
      const betaRoot = secondState?.state?.session?.sessionId;
      const distinctRoots = !!alphaRoot && !!betaRoot && alphaRoot !== betaRoot;
      rec.check('two distinct orchestrator sessions exist', distinctRoots,
        `${alphaRoot} / ${betaRoot}`);
      if (!distinctRoots) return;

      const page = await openWidePage(ctx, 'home/home.html#actors');
      try {
        await rpc(ctx.page, { type: 'session/switch', sessionId: alphaRoot });
        await rpc(ctx.page, { type: 'agent/send', text: 'ALPHA-ROOT research the launch risks' });
        const alphaLive = await waitFor(async () => {
          const overview = await rpc(page, { type: 'actors/overview' });
          return overview?.roots?.some((root) => root.session?.sessionId === alphaRoot
            && Object.keys(root.topology?.spawned?.sessions ?? {}).length >= 4);
        }, { budgetMs: 15_000, pollMs: 80 });
        rec.check('the first chat keeps a high-fanout actor room live', !!alphaLive);

        const switched = await rpc(ctx.page, { type: 'session/switch', sessionId: betaRoot });
        rec.check('a second orchestrator can become active while the first actor works', switched?.ok === true, JSON.stringify(switched));
        await rpc(ctx.page, { type: 'agent/send', text: 'BETA-ROOT compare the rollout options' });
        let liveProbe = /** @type {any} */ (null);
        const bothLive = await waitFor(async () => {
          const overview = await rpc(page, { type: 'actors/overview' });
          const alpha = (overview?.roots ?? []).find((root) => root.session?.sessionId === alphaRoot);
          const beta = (overview?.roots ?? []).find((root) => root.session?.sessionId === betaRoot);
          liveProbe = (overview?.roots ?? []).map((root) => ({
            id: root.session?.sessionId, busy: root.busy, activity: root.activity,
            spawned: Object.keys(root.topology?.spawned?.sessions ?? {}).length,
          }));
          return Object.keys(alpha?.topology?.spawned?.sessions ?? {}).length >= 4
            && beta?.busy === true
            && String(beta?.activity ?? '').includes('BETA-ROOT compare the rollout options')
            ? overview : null;
        }, { budgetMs: 30_000, pollMs: 80 });
        rec.check('the server snapshot reports both roots without cross-session merging',
          bothLive?.roots?.length === 2,
          JSON.stringify(bothLive?.roots?.map((root) => root.session?.sessionId) ?? liveProbe));

        const rendered = await waitFor(() => evalIn(page, `(() => {
          const space = document.querySelector('.actor-space');
          const rooms = [...document.querySelectorAll('.actor-space-room')];
          const nodes = [...document.querySelectorAll('.actor-space-node')];
          const actorBadge = document.querySelector('[data-home-view="actors"] .home-nav-count');
          if (!space || rooms.length < 2 || nodes.length < 6
            || !space.textContent?.includes('BETA-ROOT compare the rollout options')
            || actorBadge?.textContent?.trim() !== '4') return null;
          const rect = space.getBoundingClientRect();
          const alphaRoom = rooms.find((room) => room.getAttribute('data-root-session') === ${JSON.stringify(alphaRoot)});
          const alphaTree = alphaRoom?.querySelector('.actor-space-tree');
          const alphaHead = alphaRoom?.querySelector('.actor-space-room-head');
          return {
            rooms: rooms.length,
            roots: rooms.map((room) => room.getAttribute('data-root-session')),
            nodes: nodes.length,
            subactors: document.querySelectorAll('.actor-space-node.is-subactor').length,
            orbs: document.querySelectorAll('.actor-space .peerd-spinner').length,
            actorBadge: actorBadge.textContent.trim(),
            navGroups: [...document.querySelectorAll('.home-nav-group-label')]
              .map((label) => label.textContent.trim()),
            text: space.textContent ?? '',
            highFanoutScrolls: !!alphaTree && alphaTree.scrollHeight > alphaTree.clientHeight,
            headerVisible: !!alphaHead && alphaHead.getBoundingClientRect().top >= 0,
            fits: rect.left >= 0 && rect.right <= innerWidth
              && document.documentElement.scrollWidth <= innerWidth,
          };
        })()`), { budgetMs: 30_000, pollMs: 80 });
        rec.check('Actor Space renders two orchestrator rooms and both workers',
          rendered?.rooms === 2 && rendered?.nodes >= 6 && rendered?.subactors >= 4,
          JSON.stringify(rendered));
        rec.check('rooms with isolated actors lead main-only orchestrators',
          rendered?.roots?.[0] === alphaRoot, JSON.stringify(rendered?.roots));
        rec.check('the rooms stay root-separated and use the brand orb on live contexts',
          rendered?.roots?.includes(alphaRoot)
            && rendered?.roots?.includes(betaRoot)
            && rendered?.orbs >= 5,
          JSON.stringify(rendered));
        rec.check('the rail groups Chats and Actors under Agent and shows a live actor count',
          rendered?.actorBadge === '4'
            && rendered?.navGroups?.join('|') === 'Agent|Create|Network',
          JSON.stringify(rendered));
        rec.check('the full-screen map exposes current work, topology semantics, and fits the viewport',
          rendered?.text.includes('alpha isolated research')
            && rendered?.text.includes('BETA-ROOT compare the rollout options')
            && rendered?.text.includes('solid · resource-bound actor')
            && rendered?.text.includes('dashed · temporary subactor')
            && rendered?.fits === true,
          JSON.stringify(rendered));
        rec.check('a high-fanout room scrolls internally without pushing away its header',
          rendered?.highFanoutScrolls === true && rendered?.headerVisible === true,
          JSON.stringify(rendered));

        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
        });
        await sleep(100);
        const narrow = await evalIn(page, `(() => {
          const shell = document.querySelector('.home-shell');
          const rail = document.querySelector('.home-rail');
          const nav = document.querySelector('.home-nav');
          const targets = [...document.querySelectorAll('.home-rail button')];
          return {
            direction: getComputedStyle(shell).flexDirection,
            viewport: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            railWidth: rail.getBoundingClientRect().width,
            navFits: nav.scrollWidth <= nav.clientWidth,
            targetsTall: targets.every((button) => button.getBoundingClientRect().height >= 44),
          };
        })()`);
        rec.check('Actor Space reflows to a compact top rail at 390 CSS pixels',
          narrow?.direction === 'column'
            && narrow?.documentWidth <= narrow?.viewport
            && narrow?.railWidth <= narrow?.viewport
            && narrow?.navFits === true
            && narrow?.targetsTall === true,
          JSON.stringify(narrow));

        await evalIn(page, `document.querySelector('.actor-space-node.is-subactor')?.click()`);
        const inspected = await waitFor(() => evalIn(page, `(() => {
          const panel = document.querySelector('.actor-space-inspector');
          return panel ? { text: panel.textContent ?? '', pressed:
            document.querySelector('.actor-space-node.is-subactor')?.getAttribute('aria-pressed') } : null;
        })()`), { budgetMs: 2_000, pollMs: 40 });
        rec.check('a worker opens an exact access and isolation inspector',
          inspected?.pressed === 'true'
            && inspected?.text.includes('reasoning only')
            && inspected?.text.includes('Dedicated keyless worker'),
          JSON.stringify(inspected));
        await evalIn(page, `document.querySelector('.actor-space-inspector')?.scrollIntoView({ block: 'center' })`);
        await setEmulatedTheme(page, 'dark');
        await sleep(100);

        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 320, height: 720, deviceScaleFactor: 1, mobile: false,
        });
        await sleep(100);
        const zoomReflow = await evalIn(page, `({
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          railWidth: document.querySelector('.home-rail')?.getBoundingClientRect().width,
          navFits: document.querySelector('.home-nav')?.scrollWidth
            <= document.querySelector('.home-nav')?.clientWidth,
        })`);
        rec.check('Actor Space still reflows at the 320 CSS-pixel equivalent of 400% zoom',
          zoomReflow?.documentWidth <= zoomReflow?.viewport
            && zoomReflow?.railWidth <= zoomReflow?.viewport
            && zoomReflow?.navFits === true,
          JSON.stringify(zoomReflow));

        await rpc(ctx.page, { type: 'session/switch', sessionId: alphaRoot });
        const alphaStopped = await rpc(ctx.page, { type: 'agent/stop' });
        await rpc(ctx.page, { type: 'session/switch', sessionId: betaRoot });
        const betaStopped = await rpc(ctx.page, { type: 'agent/stop' });
        rec.check('Stop clears both root work graphs',
          alphaStopped?.ok === true && betaStopped?.ok === true,
          JSON.stringify({ alphaStopped, betaStopped }));
        actorOverviewState.releaseLive();
        let emptyProbe = /** @type {any} */ (null);
        const empty = await waitFor(async () => {
          const overview = await rpc(page, { type: 'actors/overview' });
          const view = await evalIn(page, `(() => ({
            text: document.querySelector('.actor-space-empty')?.textContent ?? '',
            badge: document.querySelector('[data-home-view="actors"] .home-nav-count')?.textContent ?? null,
            hidden: document.hidden,
          }))()`);
          emptyProbe = {
            roots: (overview?.roots ?? []).map((root) => ({
              id: root.session?.sessionId, busy: root.busy,
              spawned: Object.keys(root.topology?.spawned?.sessions ?? {}).length,
              tasks: Object.values(root.topology?.asyncTasks ?? {}).flat()
                .map((task) => task?.status),
            })),
            view,
          };
          return emptyProbe.roots.length === 0 && view?.text && !view.badge
            ? { text: view.text, badge: null } : null;
        },
        { budgetMs: 45_000, pollMs: 150 });
        rec.check('the permanent monitor settles to an honest empty state',
          empty?.text?.includes('The instance is quiet') && empty.badge === null,
          JSON.stringify(empty ?? emptyProbe));
      } finally {
        actorOverviewState.releaseLive();
        try { page.close(); } catch { /* */ }
      }
    },
  },

  // --- functional: an offscreen actor DELEGATES to its own web actor ------
  // Heap-split phase 4, the deepest chain, with two isolated heaps stacked. The
  // orchestrator spawns a sync actor granted message_actor; that actor's loop
  // runs in its OWN isolated Worker heap and calls message_actor({to:'web'}), which relays
  // to the SW, dispatches actorMessaging from the child's restricted ctx, and (because
  // the sender is an actor) AWAITS the web actor's fenced reply into the child's tool
  // result. The web actor is ITSELF an isolated Worker heap (phase 3). Proof: the child
  // looped in isolation, a web-actor sub-loop ran, message_actor executed via the relay, and the
  // web reply round-tripped up through the child into the orchestrator's answer. This is
  // the delegation-from-a-heap path the unit tests can only stub.
  {
    name: 'actor-delegates-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      // The WEB ACTOR's model call (its own offscreen heap).
      if (body.includes('kind: bound; type: web')) {
        actorDelegatesState.webCalls += 1;
        return { sse: sseText('WEB-PRICE-99') };
      }
      // The ACTOR's model calls (ephemeral-actor prompt). First emits message_actor;
      // second (after the awaited web reply re-enters its heap) answers.
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
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
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
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

      const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
      const isolation = actorIsolationEvidence(entries);
      const msgActorRan = entries.some((e) => e.type === 'tool_executed' && e.details && e.details.tool === 'message_actor');
      rec.check('the actor looped in isolation (message_actor emitted, then answered), 2 child calls', actorDelegatesState.childCalls >= 2, `childCalls=${actorDelegatesState.childCalls}`);
      rec.check('the actor ran in a dedicated Worker with a verified realm', isolation.exactProof === true, `isolated=${isolation.isolated.length}`);
      rec.check('the actor delegated via message_actor from its heap (tool_executed audit)', msgActorRan === true, `msgActorRan=${msgActorRan}`);
      rec.check('a WEB-ACTOR sub-loop ran (its own heap) for the child delegation', actorDelegatesState.webCalls >= 1, `webCalls=${actorDelegatesState.webCalls}`);
      rec.check('it did NOT enter the background turn driver or fail isolation', isolation.backgroundRefused === false && isolation.isolationFailed === false);
      rec.check('the web reply round-tripped up through the actor into the final answer', (out.bubbles || []).includes('FINAL-VIA-ACTOR'));
      rec.check('the turn settles idle', out.busy === false);
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
          return { sse: sseToolCall('app_write_file', { path: 'asset.bin', contentBase64: 'AP/AgH8=' }) };
        }
        if (actorAppState.appCalls === 2) {
          return { sse: sseToolCall('app_write_file', { path: 'empty.wasm', contentBase64: 'AGFzbQEAAAA=' }) };
        }
        if (actorAppState.appCalls === 3) {
          return { sse: sseToolCall('app_write_file', { path: 'model.custom', contentBase64: 'QUJD' }) };
        }
        if (actorAppState.appCalls === 4) {
          const probe = JSON.stringify(actorAppProbeUrl);
          const secureProbe = JSON.stringify(actorAppProbeUrl.replace(/^http:/, 'https:'));
          const blobPayload = `<script>try { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${actorAppStunPort}'}]}); p.createDataChannel('blob'); p.createOffer().then(o => p.setLocalDescription(o)); } catch (_) {}<\/script>`;
          const blobPayloadLiteral = JSON.stringify(blobPayload).replace(/</g, '\\u003c');
          const dataPayload = `<script>try { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${actorAppStunPort}'}]}); p.createDataChannel('data'); p.createOffer().then(o => p.setLocalDescription(o)); } catch (_) {} setTimeout(() => { location.href = URL.createObjectURL(new Blob([${blobPayloadLiteral}], {type:'text/html'})); }, 250);<\/script>`;
          const dataPayloadLiteral = JSON.stringify(dataPayload).replace(/</g, '\\u003c');
          const content = `<!DOCTYPE html><body>REAL LAVA LAMP
<img src="${actorAppProbeUrl}/image">
<script>
Promise.resolve().then(async () => {
  parent.postMessage({ type: 'runner-ready' }, '*');
  const bytes = window.peerd.assets.bytes('asset.bin');
  const custom = window.peerd.assets.bytes('model.custom');
  await WebAssembly.instantiate(window.peerd.assets.bytes('empty.wasm'));
  const second = window.name === 'peerd-binary-reloaded' || window.name === 'peerd-binary-probed';
  const sendProof = () => parent.postMessage({
    type: 'e2e-binary-proof', second, bytes: Array.from(bytes), custom: Array.from(custom), wasm: true,
  }, '*');
  sendProof();
  const proofTimer = setInterval(sendProof, 100);
  setTimeout(() => clearInterval(proofTimer), 2_000);
  document.body.dataset.webrtc = String(typeof RTCPeerConnection);
  if (!second) {
    window.name = 'peerd-binary-reloaded';
    setTimeout(() => location.reload(), 250);
    return;
  }
  if (window.name === 'peerd-binary-probed') return;
  window.name = 'peerd-binary-probed';
  fetch(${probe} + '/fetch').catch(() => {});
  try {
    new Worker(URL.createObjectURL(new Blob([
      'fetch(' + JSON.stringify(${probe} + '/worker') + ').catch(() => {})',
    ], { type: 'application/javascript' })));
  } catch (_) {}
  setTimeout(() => { location.href = ${probe} + '/navigate'; }, 50);
  setTimeout(() => { location.assign(${secureProbe} + '/assign'); }, 80);
  setTimeout(() => { location.replace(${probe} + '/replace'); }, 110);
  setTimeout(() => {
    const meta = document.createElement('meta');
    meta.httpEquiv = 'refresh';
    meta.content = '0;url=' + ${probe} + '/meta-refresh';
    document.head.appendChild(meta);
  }, 140);
  setTimeout(() => {
    const form = document.createElement('form');
    form.action = ${probe} + '/form';
    document.body.appendChild(form);
    form.submit();
  }, 170);
  setTimeout(() => { location.href = 'data:text/html,' + encodeURIComponent(${dataPayloadLiteral}); }, 200);
  setTimeout(() => { location.href = URL.createObjectURL(new Blob([${blobPayloadLiteral}], {type:'text/html'})); }, 250);
}).catch((error) => parent.postMessage({ type: 'e2e-binary-error', error: String(error) }, '*'));
</script></body>`;
          return { sse: sseToolCall('app_write_file', { path: 'index.html', content }) };
        }
        return { sse: sseText('APP-ACTOR-WROTE') };
      }
      // ACTOR (ephemeral): create, capture the app id from the result, delegate.
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
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
      /** @type {string[]} */
      const probeHits = [];
      let probeConnections = 0;
      let stunHits = 0;
      const server = createServer((req, res) => {
        probeHits.push(req.url ?? '');
        res.writeHead(204); res.end();
      });
      server.on('connection', () => { probeConnections += 1; });
      server.on('clientError', (_error, socket) => socket.destroy());
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
        rec.check('the actor reached the freshly-created app actor (delegation worked)', msgActorRan === true && actorAppState.appCalls >= 4, `msgActorRan=${msgActorRan} appActorCalls=${actorAppState.appCalls}`);
        rec.check('the app actor wrote text and binary files (app_write_file executed)', appWriteRan === true, `appWriteRan=${appWriteRan}`);
        rec.check('the orchestrator settled with a final answer', (out.bubbles || []).includes('FINAL-APP-BUILT'));

        // sandbox_create already opened an owner-pinned App tab. Close that
        // background build surface, then reopen its exact owner-bearing URL in
        // a CDP-controlled tab. Creating a second appId-only host is correctly
        // rejected because it would make actor/runtime routing ambiguous.
        const appTarget = await waitFor(async () => {
          const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
          const prefix = `chrome-extension://${ctx.sw.id}/engine-tabs/app-tab/index.html#${actorAppState.appId}`;
          return targets.find((candidate) => candidate.type === 'page' && candidate.url.startsWith(prefix)) ?? null;
        }, { budgetMs: 8_000, pollMs: 50 });
        if (!appTarget) throw new Error('the actor-created App tab was not available for E2E attachment');
        const appUrl = new URL(appTarget.url);
        const appPath = `${appUrl.pathname.replace(/^\//, '')}${appUrl.hash}`;
        await fetch(`http://127.0.0.1:${ctx.port}/json/close/${appTarget.id}`);
        await waitFor(async () => {
          const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
          return targets.every((candidate) => candidate.id !== appTarget.id);
        }, { budgetMs: 5_000, pollMs: 50 });
        await sleep(100);
        appPage = await openExtPage(ctx, appPath);
        await appPage.send('Page.addScriptToEvaluateOnNewDocument', { source: `
          if (window === top) {
            globalThis.__e2eBinaryProofs = [];
            globalThis.__e2eBinaryErrors = [];
            globalThis.__e2eAppPolicies = [];
            globalThis.__e2eParentPolicies = [];
            addEventListener('message', (event) => {
              const frame = document.getElementById('app-frame');
              if (event.source !== frame?.contentWindow) return;
              if (event.data?.type === 'e2e-binary-proof') {
                globalThis.__e2eBinaryProofs.push({ ...event.data, receivedAt: performance.now() });
              }
              if (event.data?.type === 'e2e-binary-error') globalThis.__e2eBinaryErrors.push(event.data.error);
              if (event.data?.type === 'app-policy-blocked') globalThis.__e2eAppPolicies.push(event.data.directive);
            });
            addEventListener('securitypolicyviolation', (event) => {
              globalThis.__e2eParentPolicies.push({
                directive: event.effectiveDirective,
                receivedAt: performance.now(),
              });
            });
          }
        ` });
        await appPage.send('Page.reload', { ignoreCache: true });
        const rendered = await waitFor(() => evalIn(appPage, `
          document.title === 'peerd · Lava'
          && document.getElementById('boot')?.classList.contains('is-hidden')
          && !document.getElementById('boot')?.classList.contains('is-failed')
        `),
          { budgetMs: 12_000, pollMs: 200 });
        const binaryProof = await waitFor(() => evalIn(appPage, `
          globalThis.__e2eBinaryProofs?.find((proof) => proof.second === true
            && proof.wasm === true
            && JSON.stringify(proof.bytes) === '[0,255,192,128,127]'
            && JSON.stringify(proof.custom) === '[65,66,67]') ?? null
        `), { budgetMs: 12_000, pollMs: 100 });
        await sleep(1_200);
        rec.check('the real manifest-sandboxed App rendered', !!rendered);
        rec.check('the App received exact binary bytes and instantiated WASM after a self-reload', !!binaryProof,
          JSON.stringify(binaryProof ?? await evalIn(appPage, `globalThis.__e2eBinaryProofs ?? []`)));
        rec.check('the App binary API reported no runtime errors',
          (await evalIn(appPage, `(globalThis.__e2eBinaryErrors ?? []).length`)) === 0,
          JSON.stringify(await evalIn(appPage, `globalThis.__e2eBinaryErrors ?? []`)));
        rec.check('fetch, resources, Worker, forms, meta refresh, and HTTP(S) navigation made zero network connections',
          probeHits.length === 0 && probeConnections === 0,
          JSON.stringify({ hits: probeHits, connections: probeConnections, policies: await evalIn(appPage, `globalThis.__e2eAppPolicies ?? []`) }));
        rec.check('the trusted parent CSP blocked cross-origin frame navigation before fetch',
          (await evalIn(appPage, `globalThis.__e2eParentPolicies ?? []`))
            .some((policy) => policy.directive === 'frame-src'),
          JSON.stringify(await evalIn(appPage, `globalThis.__e2eParentPolicies ?? []`)));
        rec.check('the App kept running after blocked self-navigation', await evalIn(appPage, `(() => {
          const blockedAt = globalThis.__e2eParentPolicies
            ?.find((policy) => policy.directive === 'frame-src')?.receivedAt;
          return typeof blockedAt === 'number'
            && globalThis.__e2eBinaryProofs?.some((proof) => proof.receivedAt > blockedAt);
        })()`) === true);
        rec.check('the WebRTC fail-closed preflight allowed App delivery', !!rendered);
        rec.check('data: and blob: replacement realms cannot emit WebRTC STUN traffic', stunHits === 0, `udpHits=${stunHits}`);
        await evalIn(appPage, `document.getElementById('mode-toggle')?.click()`);
        const editorState = await waitFor(() => evalIn(appPage, `(() => {
          const rows = [...document.querySelectorAll('.pe-node.is-readonly')];
          if (rows.length < 3) return null;
          rows[0].click();
          return {
            labels: rows.map((row) => row.getAttribute('aria-label')),
            notice: document.getElementById('app-security-notice')?.textContent ?? '',
            panelVisible: document.getElementById('editor-panel')?.hidden === false,
          };
        })()`), { budgetMs: 8_000, pollMs: 100 });
        rec.check('the App editor exposes binary files as labeled read-only rows',
          editorState?.panelVisible === true
            && editorState.labels?.some((label) => label === 'asset.bin, binary asset, read-only')
            && editorState.labels?.some((label) => label === 'empty.wasm, binary asset, read-only')
            && editorState.labels?.some((label) => label === 'model.custom, binary asset, read-only'),
          JSON.stringify(editorState));
        rec.check('selecting a binary file explains the safe replacement paths',
          editorState?.notice?.includes('Ask peerd to replace it') && editorState.notice.includes('import'),
          editorState?.notice ?? '');
        const replacementNoticeFocus = await evalIn(appPage, `(() => {
          const rows = [...document.querySelectorAll('.pe-node.is-readonly')];
          const dismiss = document.querySelector('#app-security-notice button');
          dismiss?.focus();
          rows[1]?.click();
          return {
            active: document.activeElement?.textContent ?? '',
            notice: document.getElementById('app-security-notice')?.textContent ?? '',
          };
        })()`);
        rec.check('replacing a binary notice preserves keyboard focus on Dismiss',
          replacementNoticeFocus?.active === 'Dismiss'
            && replacementNoticeFocus?.notice?.includes('empty.wasm'),
          JSON.stringify(replacementNoticeFocus));
        const appViewport = await evalIn(appPage, `({ width: innerWidth, height: innerHeight })`);
        await appPage.send('Emulation.setDeviceMetricsOverride', {
          width: 320,
          height: 500,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const stackedNotices = await evalIn(appPage, `(() => {
          const save = document.getElementById('app-save-status');
          const message = document.getElementById('app-save-message');
          const security = document.getElementById('app-security-notice');
          if (!save || !message || !security) return null;
          message.textContent = 'Could not save assets/' + 'unbrokenfilename'.repeat(16)
            + 'large-binary-file.wasm. Your edits are still open. Reduce the file or free browser storage, then retry.';
          save.hidden = false;
          const saveRect = save.getBoundingClientRect();
          const securityRect = security.getBoundingClientRect();
          const dismissRect = security.querySelector('button')?.getBoundingClientRect();
          const result = {
            gap: saveRect.top - securityRect.bottom,
            securityTop: securityRect.top,
            saveBottom: saveRect.bottom,
            dismissVisible: !!dismissRect
              && dismissRect.left >= 0
              && dismissRect.right <= innerWidth
              && dismissRect.top >= 0
              && dismissRect.bottom <= innerHeight,
          };
          save.hidden = true;
          return result;
        })()`);
        rec.check('long save errors and security notices remain separate and usable in a narrow App tab',
          stackedNotices?.gap >= 8
            && stackedNotices.securityTop >= 0
            && stackedNotices.saveBottom <= 500
            && stackedNotices.dismissVisible === true,
          JSON.stringify(stackedNotices));
        await appPage.send('Emulation.setDeviceMetricsOverride', {
          width: appViewport.width,
          height: appViewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } finally {
        try { appPage?.close(); } catch { /* */ }
        await new Promise((resolve) => server.close(resolve));
        stunServer.close();
        actorAppProbeUrl = '';
        actorAppStunPort = 0;
      }
    },
  },

  // --- red-team: actor jobs and relays reach only the offscreen client ------
  {
    name: 'actor-channel-targeting', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
        actorChannelTargetState.childCalls += 1;
        return { sse: sseText('TARGETED-CHILD-DONE') };
      }
      if (actorChannelTargetState.spawned === 0) {
        actorChannelTargetState.spawned += 1;
        return { sse: sseToolCall('actor_create', {
          task: 'target-only-marker-308', tools: [], sync: true,
        }) };
      }
      return { sse: sseText('TARGETED-PARENT-DONE') };
    },
    async run(ctx, rec) {
      actorChannelTargetState = { spawned: 0, childCalls: 0 };
      let appPage = null;
      try {
        // why an App host page: it is a real first-party extension tab and the
        // exact sibling context that must not receive an offscreen job or relay.
        appPage = await openExtPage(ctx, 'engine-tabs/app-tab/index.html#channel-target-probe');
        const ready = await waitFor(() => evalIn(appPage,
          `location.protocol === 'chrome-extension:' && document.readyState !== 'loading'`),
        { budgetMs: 8_000, pollMs: 60 });
        rec.check('the adversarial engine-tab sender loaded', ready === true);
        await evalIn(appPage, `(async () => {
          const browser = (await import('/vendor/browser-polyfill.js')).default;
          globalThis.__actorChannelObservations = [];
          const record = (kind, value) => {
            let text = '';
            try { text = JSON.stringify(value); } catch { text = String(value); }
            globalThis.__actorChannelObservations.push({ kind, text });
          };
          browser.runtime.onMessage.addListener((message) => record('runtime-message', message));
          browser.runtime.onConnect.addListener((port) => record('runtime-connect', { name: port.name }));
          navigator.serviceWorker?.addEventListener('message', (event) => record('service-worker-message', event.data));
          return true;
        })()`, true);
        const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
        const sent = await rpc(ctx.page, {
          type: 'agent/send', text: 'run the targeted actor transport probe',
        });
        rec.check('the actor probe turn was accepted', sent?.ok === true, JSON.stringify(sent));
        let turnView = {};
        const settled = await waitFor(async () => {
          turnView = await evalIn(ctx.page, `({
            bubbles: [...document.querySelectorAll('.message-assistant .bubble')]
              .map((bubble) => bubble.textContent.trim()),
            busy: !!document.querySelector('form.input-bar button.stop'),
          })`) ?? {};
          return actorChannelTargetState.childCalls >= 1 && !turnView.busy;
        },
        { budgetMs: 30_000, pollMs: 100 });
        let isolation = actorIsolationEvidence([]);
        await waitFor(async () => {
          const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
          isolation = actorIsolationEvidence(entries);
          return isolation.exactProof;
        }, { budgetMs: 5_000, pollMs: 100 });
        rec.check('the targeted actor completed',
          settled === true && isolation.exactProof === true,
          JSON.stringify({ turnView, actorChannelTargetState, isolation }));
        const observations = await evalIn(appPage, `globalThis.__actorChannelObservations`);
        const observedText = JSON.stringify(observations ?? []);
        rec.check('the sibling engine page saw no actor channel, job, relay, or marker',
          !/peerd\/actor-channel|actor\/(?:open|commit|relay|run)|target-only-marker-308/.test(observedText),
          observedText.slice(0, 2_000));
      } finally {
        try { appPage?.close(); } catch { /* */ }
      }
    },
  },

  // --- visual + functional: authority row at Firefox sidebar width ---------
  // Last because the keyed Anthropic fixture intentionally changes the
  // ephemeral E2E vault/provider inventory.
  {
    name: 'narrow-sidebar', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('narrow layout ready') }),
    async run(ctx, rec) {
      await ctx.page.send('Emulation.setDeviceMetricsOverride', NARROW_PANEL_METRICS);
      try {
        await sleep(80);
        const home = await evalIn(ctx.page, `(() => {
          const inside = (el) => {
            const rect = el.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          };
          const paths = [...document.querySelectorAll('.path-card')];
          const menu = document.querySelector('.path-menu');
          const composer = document.querySelector('.composer');
          const onboarding = document.querySelector('.onboarding-card');
          return {
            width: innerWidth,
            contentWidth: menu ? Math.round(menu.getBoundingClientRect().width) : null,
            paths: paths.length,
            pathsInside: paths.length > 0 && paths.every(inside),
            composerInside: !!composer && inside(composer),
            onboardingInside: !onboarding || inside(onboarding),
          };
        })()`);
        rec.check('the 310px viewport produces the reported 282px content column',
          home?.width === NARROW_PANEL_METRICS.width && home?.contentWidth === 282,
          JSON.stringify(home));
        rec.check('home cards and composer remain inside the narrow viewport',
          home?.paths >= 6 && home?.pathsInside && home?.composerInside && home?.onboardingInside,
          JSON.stringify(home));

        const keyed = await rpc(ctx.page, {
          type: 'provider/setKey', provider: 'anthropic', plaintext: 'sk-e2e-narrow-sidebar-only',
        });
        rec.check('Anthropic fixture key stored in the ephemeral E2E vault',
          keyed?.ok === true, JSON.stringify(keyed));
        const selectedProvider = await rpc(ctx.page, {
          type: 'settings/update',
          patch: { providerName: 'anthropic', providerModel: '', reasoningEnabled: true },
        });
        rec.check('narrow fixture selects Anthropic deterministically',
          selectedProvider?.ok === true, JSON.stringify(selectedProvider));
        await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.effort-dial')`),
          { budgetMs: 8_000, pollMs: 60 });
        await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.model-picker-select')`),
          { budgetMs: 8_000, pollMs: 60 });
        await waitFor(() => evalIn(ctx.page,
          `/^Anthropic/.test(document.querySelector('.model-picker-select')?.selectedOptions?.[0]?.textContent || '')`),
        { budgetMs: 8_000, pollMs: 60 });

        const controls = await evalIn(ctx.page, `(() => {
          const row = document.querySelector('.chat-mode-row');
          const plan = document.querySelector('.planact-mode');
          const act = document.querySelectorAll('.planact-mode')[1];
          const confirm = document.querySelector('.planact-confirm');
          const effort = document.querySelector('.effort-dial');
          const goal = document.querySelector('.goal-toggle');
          const model = document.querySelector('.model-picker-select');
          const list = [plan, act, confirm, effort, goal];
          const inside = (el) => {
            const rect = el.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          };
          const target = (el) => {
            const rect = el.getBoundingClientRect();
            return rect.width >= 24 && rect.height >= 24;
          };
          const focusVisible = list.map((el) => {
            el.focus();
            const style = getComputedStyle(el);
            return document.activeElement === el && parseFloat(style.outlineWidth) >= 2;
          });
          return {
            present: list.every(Boolean),
            inside: list.every(inside),
            targets: list.every(target),
            untruncated: list.every((el) => el.scrollWidth <= el.clientWidth),
            selectedModeCount: document.querySelectorAll('.planact-mode[aria-pressed="true"]').length,
            confirmState: confirm?.getAttribute('aria-pressed'),
            effortValue: effort?.value,
            goalState: goal?.getAttribute('aria-pressed'),
            wraps: !!row && getComputedStyle(row).flexWrap === 'wrap'
              && effort.getBoundingClientRect().top > plan.getBoundingClientRect().top,
            rowFits: !!row && row.scrollWidth <= row.clientWidth && inside(row),
            focusVisible,
            modelInside: !!model && inside(model),
          };
        })()`);
        rec.check('all authority controls remain visible, named, and untruncated',
          controls?.present && controls?.inside && controls?.untruncated && controls?.rowFits,
          JSON.stringify(controls));
        rec.check('narrow controls wrap with 24px-or-larger targets',
          controls?.wraps && controls?.targets, JSON.stringify(controls));
        rec.check('selected authority and effort states remain explicit',
          controls?.selectedModeCount === 1
            && /^(true|false)$/.test(controls?.confirmState ?? '')
            && controls?.effortValue === 'medium'
            && /^(true|false)$/.test(controls?.goalState ?? ''),
          JSON.stringify(controls));
        rec.check('focus rings and model selector survive the narrow layout',
          controls?.focusVisible?.every(Boolean) && controls?.modelInside,
          JSON.stringify(controls));

        await evalIn(ctx.page, `document.querySelector('.planact-mode')?.focus()`);
        const tabOrder = [];
        for (let index = 0; index < 5; index += 1) {
          tabOrder.push(await evalIn(ctx.page, `(() => {
            const el = document.activeElement;
            if (el?.matches('.planact-mode:first-child')) return 'Plan';
            if (el?.matches('.planact-mode:nth-child(2)')) return 'Act';
            if (el?.matches('.planact-confirm')) return 'Confirm';
            if (el?.matches('.effort-dial')) return 'Effort';
            if (el?.matches('.goal-toggle')) return 'Goal';
            return el?.className || el?.tagName || '';
          })()`));
          if (index < 4) {
            await ctx.page.send('Input.dispatchKeyEvent', {
              type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
            });
            await ctx.page.send('Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
            });
          }
        }
        rec.check('native Tab order is Plan → Act → Confirm → Effort → Goal',
          JSON.stringify(tabOrder) === JSON.stringify(['Plan', 'Act', 'Confirm', 'Effort', 'Goal']),
          JSON.stringify(tabOrder));

        const documentNode = await ctx.page.send('DOM.getDocument');
        const axSelectors = [
          '.planact-mode:first-child', '.planact-mode:nth-child(2)',
          '.planact-confirm', '.effort-dial', '.goal-toggle',
        ];
        const axNames = [];
        for (const selector of axSelectors) {
          const node = await ctx.page.send('DOM.querySelector', {
            nodeId: documentNode.root.nodeId, selector,
          });
          const tree = await ctx.page.send('Accessibility.getPartialAXTree', {
            nodeId: node.nodeId, fetchRelatives: false,
          });
          axNames.push(tree.nodes?.[0]?.name?.value ?? '');
        }
        rec.check('authority controls retain explicit accessibility-tree names',
          axNames[0] === 'PLAN' && axNames[1] === 'ACT'
            && /^Confirm: (on|off)$/.test(axNames[2])
            && axNames[3] === 'Reasoning effort' && /^Goal/.test(axNames[4]),
          JSON.stringify(axNames));

        const widths = [310, 340, 341, 370, 371, 397, 398, 400];
        const widthResults = [];
        for (const width of widths) {
          await ctx.page.send('Emulation.setDeviceMetricsOverride', {
            ...NARROW_PANEL_METRICS, width,
          });
          await sleep(40);
          widthResults.push(await evalIn(ctx.page, `(() => {
            const inside = (el) => {
              const rect = el.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth;
            };
            const row = document.querySelector('.chat-mode-row');
            const controls = [...row.querySelectorAll(
              '.planact-mode, .planact-confirm, .effort-dial, .goal-toggle')];
            const actions = [...document.querySelectorAll('.topbar-actions button')];
            return {
              width: innerWidth,
              pageFits: document.documentElement.scrollWidth <= innerWidth
                && document.body.scrollWidth <= innerWidth,
              rowFits: row.scrollWidth <= row.clientWidth && inside(row) && controls.every(inside),
              targets: controls.every((el) => {
                const rect = el.getBoundingClientRect();
                return rect.width >= 24 && rect.height >= 24;
              }),
              wraps: getComputedStyle(row).flexWrap === 'wrap',
              // why: the pill-squeeze bug - a control narrower than its own
              // label overflows internally (scrollWidth > clientWidth) or
              // grows a second text line. Fitting means neither happens.
              unsqueezed: controls.every((el) => el.scrollWidth <= el.clientWidth
                && el.getBoundingClientRect().height <= 30),
              // 7 actions since the §5g top-bar Lock joined the rail.
              actionsFit: actions.length === 7 && actions.every(inside),
              actionNames: actions.map((el) => el.getAttribute('aria-label')),
            };
          })()`));
        }
        // why wraps at EVERY width: the row is flex-wrap:wrap unconditionally
        // now - overflow becomes a second row of intact pills. The old
        // nowrap-above-370 rule squeezed the pills at 371–460px and their
        // labels broke onto two lines inside the pill.
        rec.check('the authority row fits across both sides of every responsive boundary',
          widthResults.every((result) => result.pageFits && result.rowFits && result.targets
            && result.wraps && result.unsqueezed),
          JSON.stringify(widthResults));
        rec.check('all seven named top-bar actions remain reachable across the width matrix',
          widthResults.every((result) => result.actionsFit
            && result.actionNames.every((name) => typeof name === 'string' && name.length > 0)),
          JSON.stringify(widthResults));

        await ctx.page.send('Emulation.setDeviceMetricsOverride', NARROW_PANEL_METRICS);
        await sleep(500);
        const settledModel = await evalIn(ctx.page,
          `document.querySelector('.model-picker-select')?.selectedOptions?.[0]?.textContent?.trim() || ''`);
        rec.check('the model selection stays Anthropic after async options settle',
          /^Anthropic/.test(settledModel), settledModel);
        await rec.visual('narrow-sidebar');
      } finally {
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
      }
    },
  },
];
