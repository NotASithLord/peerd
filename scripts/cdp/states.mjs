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
//       rec.observe(name, value)         : structured, non-gating telemetry
//       rec.shot(label)                 — a screenshot artifact (Claude can read)
//       rec.visual(name, opts)          — capture + baseline pixel-compare
//
// The recorder is what makes the loop legible to an agent: every state leaves a
// screenshot to look at and a structured pass/fail with the "why".

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_FIXTURE_HOST, GIT_FIXTURE_TLS_CERT, GIT_FIXTURE_TLS_KEY,
} from '../acceptance/git-smart-http-fixture.mjs';
import {
  rpc, evalIn, waitFor, sseText, sseToolCall, sseToolCalls, openExtPage, openWidePage, attach,
  reloadReadyPanel, resetSession, launchPeerd, unlockAndReady, freezeAnimations,
  sleep, setEmulatedTheme, PASSPHRASE, PANEL_METRICS, NARROW_PANEL_METRICS,
  NETWORK_GUARD_CONTROLLER_PORT, NETWORK_GUARD_OWNED_HOST,
  NETWORK_GUARD_UNRELATED_HOST, SITE_CLIENT_FIXTURE_TLS_PORT,
} from './e2e-harness.mjs';
import { startWebFixtureServer } from './fixtures/web-suite.mjs';
import { recordNetworkFloorVector, recordPrivateChildFloor, ordinaryProbeReached } from './network-floor-oracle.mjs';
import { NOTEBOOK_FETCH_STATE } from './notebook-fetch-state.mjs';
import { WEBVM_TERMINAL_STATE } from './webvm-terminal-state.mjs';
import { WASMER_STATE } from './wasmer-state.mjs';
import { STARTER_VISUAL_STATES, discoverSurface } from './starter-visuals.mjs';
import { APP_RUNTIME_STATES } from './app-runtime-state.mjs';
import { PERF_CHAT_NOTEBOOK_STATES } from './perf-chat-notebook-state.mjs';
import { CHAT_ONBOARDING_STATES } from './chat-onboarding-state.mjs';
import { HOME_SETTINGS_STATES } from './home-settings-state.mjs';
import { FIRST_TAB_STATES } from './first-tab-states.mjs';
import { IMMUTABLE_ADDRESS_VISUAL_STATES } from './immutable-address-visuals.mjs';
import { CONSENT_LOCK_VISUAL_STATES } from './consent-lock-visuals.mjs';
import { PEER_NETWORK_STATUS_STATES } from './peer-network-status-states.mjs';
import { armVaultLockStages } from './vault-lock-stages.mjs';
import { observeCatalogWorkerIdentity } from './catalog-worker-identity.mjs';
import { createConsentDiagnostics, observeHosts } from './network-consent-cold.mjs';

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

// why: long, tab-heavy headless runs can defer Mithril's scheduled redraw
// after a real click. Commit that redraw before asserting the resulting DOM.
const clickAndSyncRedraw = (page, selector) => evalIn(page, `(async () => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  const { default: m } = await import('/vendor/mithril/mithril.js');
  m.redraw.sync();
  return true;
})()`, true);

// Real key presses over CDP, the way a keyboard user drives a page. why
// rawKeyDown for keys without text: a keyDown without `text` floods a second
// keydown on macOS; Enter carries '\r' so native buttons activate.
const KEY_CODES = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
};
const pressKey = async (page, key) => {
  const spec = KEY_CODES[key];
  await page.send('Input.dispatchKeyEvent', {
    type: spec.text ? 'keyDown' : 'rawKeyDown', key, code: spec.code, windowsVirtualKeyCode: spec.vk,
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.vk });
};
// A real mouse click over CDP: the user gesture Chrome requires before a page
// may open the side panel, which a scripted element.click() does not carry.
const realClick = async (page, selector) => {
  const point = await evalIn(page, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`realClick: ${selector} not found`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};

// why: Home owns Chat only while no side-panel port is connected (single-homed
// chat). Retire the panel document to release its port before a Home scenario,
// then put the live panel back for the states that follow.
const releasePanelDocument = async (ctx) => {
  await ctx.page.send('Page.navigate', { url: 'about:blank' });
  const released = await waitFor(() => evalIn(ctx.page, `location.href === 'about:blank'`).catch(() => false),
    { budgetMs: 5_000, pollMs: 50 });
  if (!released) throw new Error('the side-panel document did not release its port');
};
const awaitLivePanel = async (ctx) => {
  const restored = await waitFor(() => evalIn(ctx.page,
    `document.documentElement.dataset.peerdBootStage === 'app-ready' && !!document.querySelector('.input-bar textarea')`).catch(() => false),
  { budgetMs: 20_000, pollMs: 80 });
  if (!restored) throw new Error('the live side panel did not restore');
};
const restorePanelDocument = async (ctx, panelUrl) => {
  await ctx.page.send('Page.navigate', { url: panelUrl });
  await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
  await awaitLivePanel(ctx);
};

// why: DOM attributes alone do not prove the name Chrome exposes to users.
const checkAccessibleNames = async (page, rec, label, expected) => {
  const { root } = await page.send('DOM.getDocument');
  const controls = [];
  for (const [selector, name, role = 'button'] of expected) {
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`accessible control is missing: ${selector}`);
    const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    controls.push({ selector, expected: name, expectedRole: role, name: nodes?.[0]?.name?.value, role: nodes?.[0]?.role?.value });
  }
  if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe(`base ${label}`, controls);
  else rec.check(label, controls.every((control) => control.name === control.expected && control.role === control.expectedRole), JSON.stringify(controls));
};

const pressNativeKey = async (page, key, shiftKey = false) => {
  const event = { key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers: shiftKey ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
};

// Layout checks for the vault gate states. why checks: the visual lane only
// reports, so a check is the gate. On the merge base a failed check is a
// note, because that render only supplies the "before" picture.
const checkGateLayout = (rec, name, pass, detail) => {
  if (process.env.PEERD_VISUAL_BASE_RENDER === '1' && !pass) rec.observe(`merge-base: ${name}`, detail);
  else rec.check(name, pass, JSON.stringify(detail));
};
const gateBox = (page) => evalIn(page, `(() => {
  const rect = document.querySelector('.gate-card').getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, vw: innerWidth, vh: innerHeight };
})()`);
// One readable column, centered, in the upper third of the tab.
const inGateColumn = (box) => box.width <= 440 && Math.abs(box.left + box.width / 2 - box.vw / 2) <= 1
  && box.top >= box.vh * 0.15 && box.top <= box.vh / 3;
// why read the styles: the visual lane hides the code stream, so no capture
// shows it if it runs under the gate text again. The gate covers the stream
// with a border image in the page color (sidepanel/styles.css).
const gateBackdrop = (page) => evalIn(page, `(() => {
  const card = document.querySelector('.gate-card');
  if (!card) return null;
  const style = getComputedStyle(card);
  const color = getComputedStyle(document.body).backgroundColor;
  return { image: style.borderImageSource, slice: style.borderImageSlice, color,
    covers: style.borderImageSource.includes(color) && style.borderImageSlice.includes('fill') };
})()`);

// why: these scenarios model a user who already made a network choice. Keep
// the choice local to their fixtures; fresh-profile consent oracles stay untouched.
const chooseFixtureNetwork = async (ctx, enabled) => {
  const available = await evalIn(ctx.page, `(async () =>
    (await import('/shared/channel-config.js')).DWEB_ENABLED)()`, true);
  if (!available) {
    if (enabled) throw new Error('peer-network fixture requires a supported host');
    return;
  }
  const reply = await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: enabled } });
  if (reply?.ok !== true || reply.settings?.dwebEnabled !== enabled
      || reply.settings?.dwebChoiceMade === false) {
    throw new Error(`fixture network choice failed: ${JSON.stringify(reply)}`);
  }
  if (enabled) {
    const home = await openExtPage(ctx, 'home/home.html');
    try {
      const started = await rpc(home, { type: 'dweb/base/start' });
      if (started?.ok !== true || started.running !== true || !started.did?.startsWith('did:key:')) {
        throw new Error(`fixture peer host did not start: ${JSON.stringify(started)}`);
      }
    } finally { await home.close(); }
  }
};

const submitActorStopMessage = async (page, text) => {
  await page.send('Page.bringToFront');
  await evalIn(page, `(() => {
    'use strict';
    const input = document.querySelector('form.input-bar textarea');
    if (!input || input.disabled) throw new Error('composer is unavailable');
    input.focus(); input.select();
  })()`);
  await page.send('Input.insertText', { text });
  const ready = await waitFor(() => evalIn(page,
    `!!document.querySelector('form.input-bar button.send-btn:not(:disabled)')`), { budgetMs: 5_000 });
  if (!ready || !await clickAndSyncRedraw(page, 'form.input-bar button.send-btn')) throw new Error('composer send is unavailable');
};

// why: a first send can stay behind as the fresh-chat draft. Remove only this
// fixture's own texts so a later state starts with an empty composer.
const clearActorStopDraft = (page, texts) => evalIn(page, `(() => {
  'use strict';
  if (${JSON.stringify(texts)}.includes(localStorage.getItem('peerd.draft.new'))) localStorage.removeItem('peerd.draft.new');
})()`).catch(() => {});

const SMOKE_TEXT = 'e2e-smoke-ok';
const TRANSFER_EXPORT_VERSION = 2;
const REQUIRE_SITE_CAPTURE_TAP = process.env.PEERD_REQUIRE_SITE_CAPTURE_TAP === '1';

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

// Both physical site-client lanes use the same pinned TLS origin. Sharing the
// fixture keeps differences in actor kind, not server behavior, as the variable.
const startSiteClientFixture = async ({ value, onRead }) => {
  const server = createHttpsServer({
    cert: GIT_FIXTURE_TLS_CERT, key: GIT_FIXTURE_TLS_KEY,
  }, (request, response) => {
    if (new URL(request.url ?? '/', 'https://fixture.test').pathname === '/api/status') {
      onRead();
      const origin = typeof request.headers.origin === 'string' && request.headers.origin
        ? request.headers.origin : '*';
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        ...cors, 'content-type': 'application/json', 'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ value }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Site client fixture</title>
<button id="refresh" type="button">Refresh status</button><output id="status">not loaded</output>
<script>document.querySelector('#refresh').addEventListener('click', async () => {
  const response = await fetch('/api/status', { cache: 'no-store' });
  document.querySelector('#status').textContent = (await response.json()).value;
});</script>`);
  });
  await new Promise((resolve) => server.listen(
    SITE_CLIENT_FIXTURE_TLS_PORT, '127.0.0.1', resolve,
  ));
  const origin = `https://${GIT_FIXTURE_HOST}`;
  return { server, origin, url: `${origin}/` };
};

const siteClientConfirmation = (page, budgetMs = 90_000) => waitFor(() => evalIn(page, `(() => {
  const modal = document.querySelector('.confirm-modal');
  if (modal?.querySelector('h3')?.textContent !== 'Confirm site client') return null;
  return {
    title: modal.querySelector('h3').textContent,
    role: modal.getAttribute('role'), titleId: modal.getAttribute('aria-labelledby'),
    rejectFocused: document.activeElement === modal.querySelector('[data-confirm-reject]'),
    code: modal.querySelector('[aria-label="Proposed site-client code"]')?.textContent,
    endpoints: modal.querySelector('[aria-label="Proposed site-client endpoints"]')?.textContent,
    contracts: modal.querySelector('[aria-label="Proposed site-client contracts"]')?.textContent,
    buttons: [...modal.querySelectorAll('button')].map((button) => button.textContent.trim()),
  };
})()`), { budgetMs, pollMs: 80 });

const approveSiteClient = (page) => evalIn(page, `(() => {
  const button = [...document.querySelectorAll('.confirm-modal button')]
    .find((candidate) => candidate.textContent.trim() === 'Save client');
  button?.click();
  return !!button;
})()`);

// Code-mode returns the tool value as JSON inside the normal script fence.
// Decode that value before inspecting the host envelope or capture evidence.
const siteClientResultContent = (text) => {
  const value = text.match(/\[VALUE\]\n([\s\S]*?)\n<\/untrusted_web_content>/);
  if (!value) return text;
  const decoded = JSON.parse(value[1]);
  return typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
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
let actorState = { delegates: 0, seen: [], afterStop: false };
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
  phase: 'hierarchy', fixtureUrl: '', targetOpened: false,
  spawned: 0, nestedCalls: 0, siblingCalls: 0, webCalls: 0, nestedResults: [],
};
let actorOverviewState = {
  alphaSpawned: 0, betaSpawned: 0,
  liveGate: Promise.resolve(), releaseLive: () => {},
};
let actorOverviewVisualState = {
  started: false, actorCalls: 0, liveGate: Promise.resolve(),
};
let homeSurfaceGate = Promise.resolve();
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
let storeScriptingState = {
  delegated: false, actorTurn: 0, actorPrompt: '', results: [], wakeBody: '', orderRef: '', sendRef: '',
};
let storeScriptingFixtureUrl = '';
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
let networkGuardTrustedChildComplete = false;
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
let siteClientVerticalOrigin = '';
let siteClientVerticalUrl = '';
let siteClientVertical = {
  mainStage: 0, actorCalls: 0, mainRefusalBody: '', actorBodies: [], replyBody: '',
};
let siteClientApiOrigin = '';
let siteClientApiState = {
  delegated: false, actorCalls: 0, actorBody: '', sawLiveValue: false,
  replySeen: false, replyReturned: false, apiReads: 0,
};
let lockActorTurn = 0;
let lockDelegated = false;
let lockReportBody = '';
let lockFixtureUrl = '';

const captureHomeLibraryGit = async (ctx, rec, { visualName, metrics, revealPanel = false, rename = false }) => {
  await chooseFixtureNetwork(ctx, false);
  const options = await openExtPage(ctx, 'options/options.html');
  let imported;
  try {
    imported = await evalIn(options, `(async () => {
      const { buildAppExport } = await import('/peerd-engine/index.js');
      const envelope = await buildAppExport({
        record: { name: 'Versioned App', entryFile: 'index.html', tags: ['visual-fixture'] },
        files: { 'index.html': '<!doctype html><title>Versioned App</title><main>Hello</main>' },
      });
      return chrome.runtime.sendMessage({ type: 'import/apply', envelope });
    })()`, true);
  } finally {
    await retirePrivateTransferPage(options);
  }
  rec.check('visual fixture App imported with a Git repository', imported?.ok && imported?.kind === 'app', JSON.stringify(imported));
  const appId = imported?.id ?? '';
  const cardSelector = `.library-card[data-app-id="${appId}"]`;
  const page = await openWidePage(ctx, 'home/home.html#library', { metrics });
  try {
    const branched = appId ? await evalIn(page,
      `chrome.runtime.sendMessage({ type: 'apps/repository/branch', appId: ${JSON.stringify(appId)}, name: 'feature/visual', checkout: true })`, true) : null;
    rec.check('visual fixture exposes existing-branch switching', branched?.ok === true, JSON.stringify(branched));
    const libraryReady = await waitFor(() => evalIn(page, `
      document.querySelector('[data-home-view="library"]')?.getAttribute('aria-current') === 'page'
        && !!document.querySelector('.library-grid')
    `), { budgetMs: 15_000, pollMs: 80 });
    rec.check('visual fixture opens the Library route', !!libraryReady);
    const appReady = await waitFor(() => evalIn(page,
      `!!document.querySelector(${JSON.stringify(cardSelector)})`),
    { budgetMs: 20_000, pollMs: 80 });
    rec.check('visual fixture App appears in the Library', !!appReady);
    await checkAccessibleNames(page, rec, 'Library glyph controls expose their actions and App name', [
      ['.library-star:not(.library-card .library-star)', 'Show favorites only'], ['.library-refresh', 'Refresh'],
      [`${cardSelector} .library-star`, 'Favorite Versioned App'], [`${cardSelector} .library-kebab`, 'More actions for Versioned App'],
    ]);
    await evalIn(page, `document.querySelector(${JSON.stringify(cardSelector)})?.querySelector('.library-kebab')?.click()`);
    if (rename) {
      await waitFor(() => evalIn(page, `!!document.querySelector(${JSON.stringify(`${cardSelector} .library-menu-item`)})`),
        { budgetMs: 5_000, pollMs: 50 });
      await evalIn(page, `[...document.querySelector(${JSON.stringify(cardSelector)}).querySelectorAll('.library-menu-item')]
        .find((button) => button.textContent === 'Rename')?.click()`);
      const field = await waitFor(() => evalIn(page, `(() => {
        const input = document.querySelector(${JSON.stringify(`${cardSelector} input`)});
        return input ? { label: input.getAttribute('aria-label'), selected: input.selectionEnd - input.selectionStart,
          value: input.value, focused: document.activeElement === input } : null;
      })()`), { budgetMs: 5_000, pollMs: 50 });
      rec.check('Library opens the real rename field', field?.focused === true && field.value === 'Versioned App');
      if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
        rec.check('the rename field has a name and selects the current App name',
          field?.label === 'Rename Versioned App' && field.selected === field.value.length, JSON.stringify(field));
      }
      await rec.visualPage(visualName, page, { beforeShot: () => evalIn(page, `(() => {
        const meta = document.querySelector(${JSON.stringify(`${cardSelector} .library-meta`)})?.firstChild;
        if (meta?.nodeType === 3) meta.nodeValue = 'just now';
      })()`) });
      await pressKey(page, 'Escape');
      if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
        const restored = await waitFor(() => evalIn(page,
          `document.activeElement === document.querySelector(${JSON.stringify(`${cardSelector} .library-kebab`)})`),
        { budgetMs: 3_000, pollMs: 50 });
        rec.check('Escape returns focus to the App actions button', !!restored);
      }
      return;
    }
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
      const toolbar = await evalIn(page, `(() => {
        const panel = document.querySelector(${JSON.stringify(`${cardSelector} .library-repository`)});
        const head = panel?.querySelector('.library-repository-head');
        const panelRect = panel?.getBoundingClientRect();
        const controls = [...head?.querySelectorAll('button') ?? []].map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.getAttribute('aria-label') || button.textContent.trim(),
            width: rect.width, height: rect.height, disabled: button.disabled,
            inside: !!panelRect && rect.left >= panelRect.left && rect.right <= panelRect.right };
        });
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, controls };
      })()`);
      rec.check('narrow Git Close and Refresh remain full-size inside the repository card',
        toolbar?.documentWidth <= toolbar?.viewport && toolbar?.controls?.length === 2
          && toolbar.controls.some((control) => control.label === 'Close Git history for Versioned App')
          && toolbar.controls.some((control) => control.label === 'Refresh Git')
          && toolbar.controls.every((control) => control.width >= 28 && control.height >= 28
            && control.inside && !control.disabled),
        JSON.stringify(toolbar));
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
    if (appId) {
      const deleted = await evalIn(page,
        `chrome.runtime.sendMessage({ type: 'apps/delete', appId: ${JSON.stringify(appId)} })`, true)
        .catch(() => null);
      rec.check('visual fixture App removed after capture', deleted?.ok === true, JSON.stringify(deleted));
    }
    page.close();
  }
};

let pacingDelegated = false;
let pacingActorCalled = false;

export const STATES = [
  ...CONSENT_LOCK_VISUAL_STATES,
  ...IMMUTABLE_ADDRESS_VISUAL_STATES,
  ...STARTER_VISUAL_STATES,
  ...PEER_NETWORK_STATUS_STATES,
  ...APP_RUNTIME_STATES,
  ...PERF_CHAT_NOTEBOOK_STATES,
  ...CHAT_ONBOARDING_STATES,
  ...HOME_SETTINGS_STATES,
  ...FIRST_TAB_STATES,
  WASMER_STATE,
  {
    name: 'pacing-wait-stop', kind: 'functional', phase: 'post-unlock',
    responder: (_index, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>')) {
        if (pacingActorCalled) return { sse: sseText('The paced action has stopped.') };
        pacingActorCalled = true;
        return body.includes('tools: page_code')
          ? { sse: sseToolCall('page_code', { code: 'return await page.goto("https://paced.example/");' }) }
          : { sse: sseToolCall('navigate', { url: 'https://paced.example/' }) };
      }
      if (!pacingDelegated) {
        pacingDelegated = true;
        return { sse: sseToolCall('message_actor', { to: 'web', message: 'Open https://paced.example/.' }) };
      }
      return { sse: sseText('Delegated the paced browser action.') };
    },
    async run(ctx, rec) {
      pacingDelegated = false;
      pacingActorCalled = false;
      let settings = await openWidePage(ctx, 'options/options.html#!/paced-sites');
      try {
        await rpc(settings, { type: 'paced/clear' });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
        const seeded = await rpc(ctx.page, {
          type: 'debug/pacing', origin: 'https://paced.example', status: 429, retryAfter: '20',
        });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });
        rec.check('a trusted refusal becomes a durable rule', seeded?.origins?.length === 1, JSON.stringify(seeded));
        // CDP close only disconnects. Retire this Options document so later
        // private-transfer tests still have one exact recipient.
        await retirePrivateTransferPage(settings);
        settings = await openWidePage(ctx, 'options/options.html#!/paced-sites');
        await waitFor(() => evalIn(settings, `document.body.innerText.includes('paced.example')`), { budgetMs: 10_000 });
        await rec.visualPage('options-paced-sites', settings);
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Open the paced site.' });
        rec.check('agent/send accepted', sent?.ok === true, JSON.stringify(sent));
        const bar = await waitFor(() => evalIn(ctx.page, `(() => {
          const row = document.querySelector('.pacing-bar');
          return row ? { text: row.textContent, role: row.getAttribute('role'),
            stop: !!row.querySelector('button') } : null;
        })()`), { budgetMs: 20_000, pollMs: 100 });
        rec.check('a real actor reached the pacing boundary', pacingActorCalled);
        rec.check('the wait names the site and exposes Stop', bar?.text?.includes('paced.example') && bar?.stop === true, JSON.stringify(bar));
        rec.check('the wait is announced accessibly', bar?.role === 'status');
        await rec.shot('waiting');
        const stopped = await rpc(ctx.page, { type: 'agent/stop' });
        rec.check('Stop is accepted', stopped?.ok === true);
        let out = {};
        await waitFor(async () => { out = await probe(ctx); return !out.busy; }, { budgetMs: 20_000 });
        rec.check('Stop returns the turn to idle', out.busy === false);
        const opened = await evalIn(ctx.page, `(async () => (await chrome.tabs.query({}))
          .filter((tab) => (tab.url || tab.pendingUrl || '').includes('paced.example')))()`, true);
        rec.check('the delayed action never created a tab', Array.isArray(opened) && opened.length === 0, JSON.stringify(opened));
        const gone = await waitFor(() => evalIn(ctx.page, `!document.querySelector('.pacing-bar')`), { budgetMs: 10_000 });
        rec.check('the wait notice clears', !!gone);
        await rec.shot('final');
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
        await rpc(settings, { type: 'paced/clear' }).catch(() => {});
        await retirePrivateTransferPage(settings);
      }
    },
  },
  // --- visual: the pre-unlock setup screen (must capture BEFORE unlock) -------
  {
    name: 'initial-screen', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      const backdrop = await waitFor(() => gateBackdrop(ctx.page), { budgetMs: 10_000, pollMs: 50 });
      checkGateLayout(rec, 'the code stream stays off the gate text', !!backdrop?.covers, backdrop);
      await rec.visual('initial-screen');
    },
  },

  // --- visual (WIDE): the first-run vault gate on a cold Home tab -----------
  // A cold Home tab gets the gate straight from the vault shell, laid out over
  // the whole tab, so the panel capture above does not cover it. Pre-unlock:
  // the gate shows its first-run choices only before a vault exists.
  {
    name: 'home-first-run-gate', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'home/home.html', { ready: '.gate-card' });
      try {
        // why wait for the label: the capability probe runs after the worker
        // answers and can change the copy. Capture only its settled form.
        const settled = await waitFor(() => evalIn(page, `(() => {
          const button = document.querySelector('.gate-card button:not(.secondary):not(.linklike)');
          const label = button && !button.disabled ? button.textContent : '';
          return label && !/^Preparing|^Create vault with passkey$/.test(label) ? label : null;
        })()`), { budgetMs: 15_000, pollMs: 50 });
        rec.check('a cold Home tab shows the settled first-run vault gate', !!settled, String(settled));
        const box = await gateBox(page);
        checkGateLayout(rec, 'the gate is one centered column in the upper third of the tab', inGateColumn(box), box);
        const stream = await waitFor(() => evalIn(page, `(() => {
          const canvas = document.querySelector('canvas.code-stream');
          return canvas && { mask: getComputedStyle(canvas).maskImage };
        })()`), { budgetMs: 5_000, pollMs: 50 });
        const backdrop = await gateBackdrop(page);
        checkGateLayout(rec, 'the code stream stays off the gate text',
          !!stream && stream.mask !== 'none' && !!backdrop?.covers, { ...stream, ...backdrop });
        await rec.visualPage('home-first-run-gate', page);
        // why a short tab: there, a space that shrinks to fit the content moved
        // the column when the form or an error showed. A fixed 22vh space
        // pushed the form off the tab. The capture above is too tall to show
        // this. The two passphrases differ, so the form writes nothing.
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 650, deviceScaleFactor: 1, mobile: false });
        const boxes = [await waitFor(async () => {
          const next = await gateBox(page);
          return next.vh === 650 ? next : null;
        }, { budgetMs: 5_000, pollMs: 50 })];
        const boxWhen = (selector) => waitFor(async () => (await evalIn(page,
          `!!document.querySelector(${JSON.stringify(selector)})`)) && gateBox(page), { budgetMs: 5_000, pollMs: 50 });
        await clickAndSyncRedraw(page, '.gate-card button.linklike');
        boxes.push(await boxWhen('#pass2'));
        await evalIn(page, `(() => {
          for (const [index, id] of ['pass', 'pass2'].entries()) {
            const input = document.getElementById(id);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'passphrase-' + index);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return true;
        })()`);
        await clickAndSyncRedraw(page, '.gate-card form button[type="submit"]');
        boxes.push(await boxWhen('.gate-msg'));
        const mismatch = boxes[2];
        checkGateLayout(rec, 'on a short tab the gate keeps one place when its content changes',
          boxes.every((box) => box && Math.abs(box.top - boxes[0].top) <= 1), boxes);
        checkGateLayout(rec, 'on a short tab the passphrase form with an error fits',
          !!mismatch && mismatch.top + mismatch.height <= mismatch.vh, mismatch);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): an onboarding question step on Home -------------------
  // Home shows each setup step in .options-gate (home.js). The question steps
  // have the shortest lines, so they show if the column keeps one width from
  // step to step. Render only: the real OnboardingGate in the real Home page
  // and stylesheets, with replies that write nothing.
  {
    name: 'home-onboarding-question', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'home/home.html', { ready: '.gate-card' });
      try {
        await evalIn(page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { OnboardingGate } = await import('/sidepanel/components/onboarding-view.js');
          const state = {
            vault: { initialized: true, locked: false },
            profile: { onboardingComplete: false, peerName: 'peerd' },
            settings: { dwebChoiceMade: true },
          };
          window.__onboardingSends = [];
          const send = async (message) => {
            window.__onboardingSends.push(message.type);
            return message.type === 'provider/status' ? { ok: true, providers: [] } : { ok: false };
          };
          m.mount(document.getElementById('app'), { view: () =>
            m('.options-gate', m(OnboardingGate, { state, send, reconcileState: async () => {} })) });
        })()`, true);
        await waitFor(() => evalIn(page, `!!document.querySelector('.onboarding-skip')`), { budgetMs: 5_000, pollMs: 50 });
        await clickAndSyncRedraw(page, '.onboarding-skip');
        await waitFor(() => evalIn(page, `!!document.querySelector('.peer-name-input')`), { budgetMs: 5_000, pollMs: 50 });
        await clickAndSyncRedraw(page, '.onboarding-actions button:not(.onboarding-skip)');
        const step = await waitFor(() => evalIn(page, `(() => {
          const card = document.querySelector('.options-gate .onboarding-card');
          return document.querySelector('#onb-call') && card ? {
            question: document.querySelector('.onb-ask')?.textContent,
            sends: window.__onboardingSends,
            width: card.getBoundingClientRect().width,
            vw: innerWidth,
          } : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the first question step renders in the Home gate and writes nothing',
          step?.question === 'What should I call you?'
            && step.sends.every((type) => type === 'provider/status'), JSON.stringify(step));
        checkGateLayout(rec, 'the question step keeps the full gate column width',
          !!step && step.width === Math.min(420, step.vw - 32), step);
        await rec.visualPage('home-onboarding-question', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): the vault gate after a lock on an open Home tab -------
  // An open Home tab shows this gate in .options-gate (home.js), not through
  // the vault shell, so the cold-tab state above does not cover it. Render
  // only: an idle-lock snapshot, with replies that write nothing.
  {
    name: 'home-locked-gate', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'home/home.html', { ready: '.gate-card' });
      try {
        await evalIn(page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { VaultGate } = await import('/sidepanel/components/vault-gate.js');
          const state = { hydrated: true, vault: { initialized: true, locked: true, unlockedAt: 0,
            prfEnrolled: false, hasRecovery: false, lockReason: 'idle' } };
          m.mount(document.getElementById('app'), { view: () =>
            m('.options-gate', m(VaultGate, { state, send: async () => ({ ok: false }) })) });
        })()`, true);
        const box = await gateBox(page);
        checkGateLayout(rec, 'the locked gate is one centered column in the upper third of the tab',
          inGateColumn(box), box);
        await rec.visualPage('home-locked-gate', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual (WIDE): the vault gate error line on Home ---------------------
  // No other state shows the gate's message line (a dot and a sentence).
  // Render only: the locked snapshot above, and a reply that writes nothing.
  // why this error: its message wraps in the column, and the dot must lead
  // the first line.
  {
    name: 'home-gate-error', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'home/home.html', { ready: '.gate-card' });
      try {
        await evalIn(page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { VaultGate } = await import('/sidepanel/components/vault-gate.js');
          const state = { hydrated: true, vault: { initialized: true, locked: true, unlockedAt: 0,
            prfEnrolled: false, hasRecovery: false, lockReason: 'idle' } };
          const send = async () => ({ ok: false, error: 'vault-authority-channel-lost' });
          m.mount(document.getElementById('app'), { view: () =>
            m('.options-gate', m(VaultGate, { state, send })) });
          const input = document.getElementById('pass');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'passphrase-0');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`, true);
        await clickAndSyncRedraw(page, '.gate-card form button[type="submit"]');
        const message = await waitFor(() => evalIn(page, `(async () => {
          const { default: m } = await import('/vendor/mithril/mithril.js');
          m.redraw.sync();
          return document.querySelector('.gate-msg')?.textContent ?? null;
        })()`, true), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the Home gate shows its error line', /restarted before it could confirm/.test(String(message)),
          String(message));
        await rec.visualPage('home-gate-error', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },


  {
    name: 'composer-file-references', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const files = { 'index.html': '<!doctype html><title>Notes</title><main>Notes</main>',
        'plain.md': 'Plain document body.', 'my notes.md': 'Document body with spaces.', 'docs/guide.md': 'Nested document body.' };
      const requests = [];
      let created = false;
      ctx.setModelResponder((_index, request) => {
        const body = JSON.parse(request.postData ?? Buffer.concat((request.postDataEntries ?? []).map((entry) => Buffer.from(entry.bytes ?? '', 'base64'))).toString());
        const last = body.messages?.at(-1);
        if (last?.role === 'user') requests.push(typeof last.content === 'string' ? last.content : (last.content ?? []).map((part) => part.text ?? '').join(''));
        if (!created) { created = true; return { sse: sseToolCall('sandbox_create', { kind: 'app', name: 'Document notes', files }) }; }
        return { sse: sseText('Document files are ready.') };
      });
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create the document notes App.' });
      if (sent?.ok !== true || !await waitFor(() => evalIn(ctx.page, `!document.querySelector('form.input-bar button.stop') && [...document.querySelectorAll('.message-assistant .bubble')].some((bubble) => bubble.textContent.includes('Document files are ready.'))`), { budgetMs: 30_000 })) throw new Error('the real App creation did not settle');
      const listed = await rpc(ctx.page, { type: 'composer/files' });
      rec.check('the real App picker lists all stored reference files', listed?.ok === true && ['plain.md', 'my notes.md', 'docs/guide.md'].every((path) => listed.files.some((file) => file.replace(/^\/+/, '') === path)), JSON.stringify(listed));
      for (const [path, query] of [['plain.md', 'plain'], ['my notes.md', 'my'], ['docs/guide.md', 'guide']]) {
        await ctx.page.send('Page.bringToFront');
        await evalIn(ctx.page, `(() => { const input = document.querySelector('form.input-bar textarea'); input.focus(); input.select(); })()`);
        await ctx.page.send('Input.insertText', { text: `@file:${query}` });
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('#composer-palette .palette-option')`), { budgetMs: 10_000 })) throw new Error('the real file palette did not open');
        if (path === 'my notes.md') await rec.visual('composer-file-references');
        await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        if (!await waitFor(() => evalIn(ctx.page, `(() => {
          const input = document.querySelector('form.input-bar textarea');
          return !document.querySelector('#composer-palette') && document.activeElement === input && input.selectionStart === input.value.length;
        })()`), { budgetMs: 5_000 })) throw new Error('the file pick did not restore its caret');
        await ctx.page.send('Input.insertText', { text: 'Summarize this file.' });
        const before = requests.length;
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar button.send-btn:not(:disabled)')`), { budgetMs: 5_000 })
          || !await clickAndSyncRedraw(ctx.page, 'form.input-bar button.send-btn')) throw new Error('the file reference could not be sent');
        if (!await waitFor(async () => {
          if (requests.length <= before || (await probe(ctx)).busy) return false;
          const messages = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.messages;
          return messages?.at(-1)?.role === 'assistant' && messages.at(-1).streaming !== true;
        }, { budgetMs: 30_000, pollMs: 50 })) throw new Error('the real reference send did not reach the model and settle');
        const wire = requests.at(-1);
        const state = (await rpc(ctx.page, { type: 'state/get' }))?.state;
        const durable = state?.session?.messages?.filter((message) => message.role === 'user').at(-1)?.content;
        rec.check(`${path} has a durable user message`, typeof durable === 'string');
        if (baseRender) rec.observe(`merge-base ${path} expansion`, { wire, durable });
        else rec.check(`${path} reaches the model and durable history as the exact file`, wire.includes(`<peerd_file path="${path}">`)
          && wire.includes(files[path]) && !wire.includes('could not resolve') && durable.includes(files[path]), JSON.stringify({ wire, durable }));
        if (path === 'my notes.md') await rec.visual('composer-file-expanded');
      }
    },
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
          // A side panel is not itself a tab, so tabs.getCurrent() returns
          // undefined. Bind the syntax probe to the active browser tab that
          // owns this panel instead of fabricating an id.
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!Number.isInteger(tab?.id)) throw new Error('active browser tab unavailable');
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
      const terminalMarker = `NETWORK-GUARD-SETTLED:${networkGuardActorTask}`;
      if (body.includes('<actor_agent>')) {
        if (networkGuardActorTurn > 0) {
          const results = toolResultsIn(body).join('\n');
          networkGuardActorResult = results;
          if (networkGuardActorTask === 'open' && results.includes('network-guard-controller')) {
            networkGuardActorReady = true;
          }
          if (networkGuardActorTask.startsWith('trusted-child:') && results.includes('clicked')) {
            networkGuardTrustedChildComplete = true;
          }
        }
        const turn = networkGuardActorTurn++;
        if (body.includes('tools: page_code')) {
          if (turn === 0) {
            const trustedChildRef = {
              '#trusted-private-child': '@e1',
              '#trusted-sensitive-child': '@e2',
              '#trusted-data-child': '@e3',
            }[networkGuardActorTask.split(':')[1]];
            return { sse: sseToolCall('page_code', {
              code: networkGuardActorTask.startsWith('trusted-child:')
                ? `await page.snapshot(); return await page.click(${JSON.stringify(trustedChildRef)});`
                : `await page.goto(${JSON.stringify(networkGuardFixtureUrl)}); return await page.content();`,
            }) };
          }
          return { sse: sseText(terminalMarker) };
        }
        if (turn === 0) return { sse: sseToolCall('navigate', { url: networkGuardFixtureUrl }) };
        if (turn === 1) return { sse: sseToolCall('read_page', {}) };
        return { sse: sseText(terminalMarker) };
      }
      // why: the main turn can finish while its actor is still running. Only
      // the current task's terminal reply proves that reintegration has begun.
      if (body.includes(terminalMarker)) networkGuardWakeSettled = true;
      if (!networkGuardDelegated) {
        networkGuardDelegated = true;
        return { sse: sseToolCall('message_actor', {
          to: 'web',
          message: networkGuardActorTask.startsWith('trusted-child:')
            ? `Click ${networkGuardActorTask.split(':')[1]} on the current controller page.`
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
      networkGuardTrustedChildComplete = false;
      networkGuardWakeSettled = false;
      let probeConnections = 0;
      let probeRequests = [];
      let controllerRequests = 0;
      let ordinaryControllerRequests = 0;
      let sensitiveChildRequests = 0;
      const controllerAttempts = new Set();
      const isolatedProbes = [];
      // Never reset these counters: separate listeners attribute speculative
      // navigation and child-fetch connections without cross-vector reuse.
      const startIsolatedProbe = async () => {
        let connections = 0;
        const requests = [];
        const sockets = new Set();
        const server = createServer((req, res) => {
          requests.push(req.url ?? '/');
          res.writeHead(204, { connection: 'close' });
          res.end();
        });
        server.on('connection', (socket) => {
          connections += 1; sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
        });
        const close = () => {
          for (const socket of sockets) socket.destroy();
          server.close(() => {});
        };
        isolatedProbes.push({ close });
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
        return { port: server.address().port, snapshot: () => ({ connections, requests: [...requests] }) };
      };
      let privateNavigationProbe;
      let privateFetchProbe;
      let privateChildObserved;
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
        const requestUrl = new URL(req.url ?? '/', `http://${NETWORK_GUARD_OWNED_HOST}`);
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
            const monitorReleases = new Map();
            self.addEventListener('message', (event) => {
              const { fetchUrl, socketUrl, token, monitorToken, monitorReleaseToken } = event.data || {};
              if (monitorToken) {
                event.waitUntil(new Promise((resolve) => {
                  let timer = null;
                  const release = () => {
                    if (timer !== null) clearTimeout(timer);
                    monitorReleases.delete(monitorToken);
                    resolve();
                  };
                  timer = setTimeout(release, 15_000);
                  monitorReleases.set(monitorToken, release);
                  event.source?.postMessage({ peerdNetworkMonitorToken: monitorToken });
                }));
                return;
              }
              if (monitorReleaseToken) {
                monitorReleases.get(monitorReleaseToken)?.();
                event.source?.postMessage({ peerdNetworkMonitorReleaseToken: monitorReleaseToken });
                return;
              }
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
        const requestedProbePort = Number(requestUrl.searchParams.get('probePort'));
        const targetProbePort = Number.isInteger(requestedProbePort)
          && requestedProbePort > 0 && requestedProbePort <= 65_535
          ? requestedProbePort
          : probePort;
        if (requestUrl.pathname === '/redirect') {
          const target = `http://127.0.0.1:${targetProbePort}/probe?vector=redirect`;
          res.writeHead(302, { location: target });
          res.end();
          return;
        }
        if (requestUrl.pathname === '/meta') {
          const target = `http://127.0.0.1:${targetProbePort}/probe?vector=meta`;
          res.end(`<!doctype html><meta http-equiv="refresh" content="0;url=${target}">`);
          return;
        }
        if (requestUrl.pathname === '/script') {
          const target = `http://127.0.0.1:${targetProbePort}/probe?vector=script`;
          res.end(`<!doctype html><script>location.href=${JSON.stringify(target)}<\/script>`);
          return;
        }
        if (requestUrl.pathname === '/cross-frame-popup') {
          const target = `http://127.0.0.1:${targetProbePort}/probe?vector=cross-frame-popup`;
          res.end(`<!doctype html><body><script>
            'use strict';
            const link = document.createElement('a');
            link.href = ${JSON.stringify(target)};
            link.target = '_blank';
            document.body.append(link);
            link.click();
            navigator.sendBeacon('/attempt?vector=cross-frame-popup');
          <\/script>`);
          return;
        }
        if (requestUrl.pathname === '/cross-frame-blank') {
          const target = `http://127.0.0.1:${targetProbePort}/probe?vector=cross-frame-blank`;
          // why: parser-blocking head scripts have no body yet. A receipt must
          // follow the child fetch call, not merely this action page loading.
          res.end(`<!doctype html><body style="margin:0">
            <button style="width:100vw;height:100vh">Open child</button><script>
            'use strict';
            document.querySelector('button').addEventListener('click', (event) => {
              navigator.sendBeacon('/attempt?vector=cross-frame-blank:' + (event.isTrusted ? 'trusted-click' : 'untrusted-click'));
              const name = 'private-child-' + Math.random();
              const child = window.open('about:blank', name);
              navigator.sendBeacon('/attempt?vector=cross-frame-blank:' + (child ? 'opened' : 'open-refused'));
              if (child) {
                child.fetch(${JSON.stringify(target)}, { mode: 'no-cors' }).catch(() => {});
                navigator.sendBeacon('/attempt?vector=cross-frame-blank');
              }
            });
            navigator.sendBeacon('/attempt?vector=cross-frame-blank:ready');
          <\/script>`);
          return;
        }
        const trustedTarget = `http://127.0.0.1:${privateNavigationProbe.port}/probe?vector=trusted-private-child`;
        const trustedFetchTarget = `http://127.0.0.1:${privateFetchProbe.port}/probe?vector=trusted-private-child-fetch`;
        const sensitiveTarget = `http://chase.com:${NETWORK_GUARD_CONTROLLER_PORT}/sensitive-child`;
        const dataTarget = `data:text/html,${encodeURIComponent(`<script>fetch(${JSON.stringify(
          `http://127.0.0.1:${probePort}/probe?vector=data-child`,
        )}).catch(()=>{})</script>`)}`;
        res.end(`<!doctype html><title>network-guard-controller</title>
          <h1>network-guard-controller</h1>
          <button id="trusted-private-child">Open private child</button>
          <button id="trusted-sensitive-child">Open sensitive child</button>
          <button id="trusted-data-child">Open opaque child</button>
          <script>
            navigator.serviceWorker.register('/worker.js');
            document.querySelector('#trusted-private-child').addEventListener('click', () => {
              const child = window.open(${JSON.stringify(trustedTarget)}, 'trusted-private-child');
              if (child) {
                navigator.sendBeacon('/attempt?vector=trusted-private-child');
                child.fetch(${JSON.stringify(trustedFetchTarget)}, { mode: 'no-cors' }).catch(() => {});
                navigator.sendBeacon('/attempt?vector=trusted-private-child-fetch');
              }
            });
            document.querySelector('#trusted-sensitive-child').addEventListener('click', () => {
              const sensitive = window.open(${JSON.stringify(sensitiveTarget)}, 'trusted-sensitive-child');
              if (sensitive) navigator.sendBeacon('/attempt?vector=trusted-sensitive-child');
            });
            document.querySelector('#trusted-data-child').addEventListener('click', () => {
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
      networkGuardFixtureUrl = `http://${NETWORK_GUARD_OWNED_HOST}:${NETWORK_GUARD_CONTROLLER_PORT}/`;
      const initialWorkerDomains = await evalIn(ctx.page, `(async () => {
        const policy = await import(chrome.runtime.getURL('peerd-egress/index.js'));
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        const workerRule = rules.find((rule) =>
          policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
        return [...(workerRule?.condition?.initiatorDomains ?? [])].sort();
      })()`, true);
      const guardedWorkerDomains = [...new Set([
        ...initialWorkerDomains, NETWORK_GUARD_OWNED_HOST,
      ])].sort();
      const retainedWorkerDomains = [...new Set([
        ...guardedWorkerDomains, NETWORK_GUARD_UNRELATED_HOST,
      ])].sort();
      const resetProbe = async () => {
        await sleep(100);
        probeConnections = 0;
        probeRequests = [];
      };
      let ordersWorkerMonitor = null;
      let releaseMonitorHold = null;
      let diagnosticWorkerRuleInstalled = false;
      try {
        privateNavigationProbe = await startIsolatedProbe();
        privateFetchProbe = await startIsolatedProbe();
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
        const controllerSettled = await waitFor(async () => networkGuardWakeSettled && !(await probe(ctx)).busy,
          { budgetMs: 15_000, pollMs: 50 });
        if (!controllerSettled) throw new Error('network controller terminal reply did not settle');
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

        const runTrustedChild = async ({ selector, attempt, label }) => {
          await resetProbe();
          const sensitiveBefore = sensitiveChildRequests;
          networkGuardActorTask = `trusted-child:${selector}`;
          networkGuardActorTurn = 0;
          networkGuardDelegated = false;
          networkGuardActorResult = '';
          networkGuardTrustedChildComplete = false;
          networkGuardWakeSettled = false;
          const tabIdsBefore = new Set((await evalIn(ctx.page,
            'chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))', true))
            .filter((id) => typeof id === 'number'));
          const sent = await rpc(ctx.page, {
            type: 'agent/send',
            text: `Exercise the ${label} child once.`,
          });
          rec.check(`${label} trusted child turn accepted`, !!sent?.ok, JSON.stringify(sent));
          const completed = await waitFor(() => networkGuardTrustedChildComplete, {
            budgetMs: 30_000, pollMs: 100,
          });
          const reintegrated = await waitFor(async () => networkGuardWakeSettled && !(await probe(ctx)).busy,
            { budgetMs: 15_000, pollMs: 50 });
          if (!reintegrated) throw new Error(`${label} child terminal reply did not settle before the next fixture task`);
          await sleep(800);
          const tabsAfter = await evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) =>
            tabs.map(({ id, openerTabId, url, pendingUrl, status }) =>
              ({ id, openerTabId, url, pendingUrl, status })))`, true);
          const children = tabsAfter.filter((tab) => !tabIdsBefore.has(tab.id));
          const observed = {
            completed: completed === true,
            attempted: controllerAttempts.has(attempt),
            connections: probeConnections,
            requests: [...probeRequests],
            sensitiveRequests: sensitiveChildRequests - sensitiveBefore,
            ...(label === 'private' ? {
              navigation: privateNavigationProbe.snapshot(),
              childFetch: { ...privateFetchProbe.snapshot(),
                attempted: controllerAttempts.has('trusted-private-child-fetch') },
            } : {}),
            children,
            actorResult: networkGuardActorResult.slice(0, 2000),
          };
          rec.check(`${label} trusted click exercised the requested child path`,
            observed.completed && observed.attempted, JSON.stringify(observed));
          if (label === 'private') privateChildObserved = observed;
          else rec.check(`${label} child causes no protected network side effect`,
            observed.connections === 0 && observed.requests.length === 0
              && observed.sensitiveRequests === 0,
            JSON.stringify(observed));
          rec.check(`${label} protected child is closed`, children.length === 0,
            JSON.stringify(observed));
          const hasReceipt = networkGuardActorResult.includes('protected_child_navigation');
          rec.check(`${label} child policy receipt is target-free when Chrome reports one`,
            !hasReceipt || (![probePort, privateNavigationProbe.port, privateFetchProbe.port]
              .some((port) => networkGuardActorResult.includes(`127.0.0.1:${port}`))
              && !networkGuardActorResult.includes('chase.com')),
            networkGuardActorResult.slice(0, 2000));
          rec.observe(`${label} child policy outcome`, {
            mode: hasReceipt ? 'fixed-receipt' : 'dnr-first-silent-block',
            actorResult: networkGuardActorResult.slice(0, 500),
          });
          for (const child of children) {
            await evalIn(ctx.page, `chrome.tabs.remove(${child.id})`, true).catch(() => {});
          }
        };
        for (const child of [
          { selector: '#trusted-private-child', attempt: 'trusted-private-child', label: 'private' },
          { selector: '#trusted-sensitive-child', attempt: 'trusted-sensitive-child', label: 'sensitive' },
          { selector: '#trusted-data-child', attempt: 'trusted-data-child', label: 'opaque' },
        ]) {
          await runTrustedChild(child);
        }
        // The positive control owns a fresh endpoint, so its HTTP request cannot
        // reuse an idle socket counted before another vector reset its counters.
        const userProbe = await startIsolatedProbe();
        const baselineUrl = `http://127.0.0.1:${userProbe.port}/probe?vector=user-tab`;
        const userTab = await evalIn(ctx.page, `chrome.tabs.create({ url: ${JSON.stringify(baselineUrl)}, active: false })`, true);
        await waitFor(() => ordinaryProbeReached(userProbe.snapshot()), { budgetMs: 5_000, pollMs: 25 });
        rec.check('an ordinary user tab can still reach the private probe',
          ordinaryProbeReached(userProbe.snapshot()), JSON.stringify(userProbe.snapshot()));
        if (typeof userTab?.id === 'number') {
          await evalIn(ctx.page, `chrome.tabs.remove(${userTab.id})`, true).catch(() => {});
        }
        await resetProbe();
        const activeBeforeOrdinary = await evalIn(ctx.page,
          'chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.id)', true);
        const ordinaryUrl = `http://${NETWORK_GUARD_UNRELATED_HOST}:${NETWORK_GUARD_CONTROLLER_PORT}/ordinary-quarantine`;
        const ordinaryStartedAt = Date.now();
        const ordinaryTab = await evalIn(ctx.page,
          `chrome.tabs.create({ url: ${JSON.stringify(ordinaryUrl)}, active: false })`, true);
        // why tabs.get: executeScript can wait indefinitely on an inactive tab
        // whose own fetch/socket probes are intentionally still settling. The
        // browser-owned tab record is enough to prove the navigation committed
        // without turning this control into another injected-code test.
        const ordinaryReady = typeof ordinaryTab?.id === 'number' && await waitFor(() =>
          evalIn(ctx.page, `chrome.tabs.get(${ordinaryTab.id}).catch(() => null)`, true).then((value) =>
            value?.status === 'complete'
              && value?.title === 'ordinary-quarantine-ready'
              && value?.url === ordinaryUrl ? value : null), {
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
            && ordinaryReady?.status === 'complete'
            && ordinaryReady?.url === ordinaryUrl,
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
          // why one listener per vector: a late speculative connection from one
          // Chrome navigation must never be attributed to the next vector.
          let connections = 0;
          const requests = [];
          const server = createServer((req, res) => {
            requests.push(req.url ?? '/');
            res.writeHead(204, { connection: 'close' });
            res.end();
          });
          server.on('connection', () => { connections += 1; });
          server.on('upgrade', (req, socket) => {
            requests.push(req.url ?? '/');
            socket.destroy();
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const privatePort = /** @type {{ port: number }} */ (server.address()).port;
          const target = `${vector === 'websocket' ? 'ws' : 'http'}://127.0.0.1:${privatePort}/probe?vector=${vector}`;
          const marker = `peerd-network-vector-${vector}`;
          try {
            await evalIn(ctx.page, `(async () => chrome.scripting.executeScript({
              target: { tabId: ${drivenTab.id} },
              world: 'MAIN',
              func: (kind, privateTarget, publicBase, privatePort, marker) => {
                const recordAttempt = () => navigator.sendBeacon(
                  '/attempt?vector=' + encodeURIComponent(kind));
                const mark = (node) => {
                  node.dataset.peerdNetworkProbe = marker;
                  return node;
                };
                const frame = (url, name = '') => {
                  const node = mark(document.createElement('iframe'));
                  if (name) node.name = name;
                  node.hidden = true;
                  node.src = url;
                  document.body.append(node);
                  return node;
                };
                const publicRoute = (path, crossOrigin = false) => {
                  const url = new URL(path, crossOrigin
                    ? publicBase.replace(
                      ${JSON.stringify(NETWORK_GUARD_OWNED_HOST)},
                      ${JSON.stringify(NETWORK_GUARD_UNRELATED_HOST)})
                    : publicBase);
                  url.searchParams.set('probePort', String(privatePort));
                  return url.href;
                };
                if (kind === 'fetch') {
                  recordAttempt();
                  fetch(privateTarget).catch(() => {});
                }
                if (kind === 'websocket') {
                  recordAttempt();
                  const socket = new WebSocket(privateTarget);
                  socket.addEventListener('error', () => {}, { once: true });
                  globalThis.__peerdNetworkProbeSockets ??= new Map();
                  globalThis.__peerdNetworkProbeSockets.set(marker, socket);
                }
                if (kind === 'image') {
                  recordAttempt();
                  const image = mark(new Image());
                  image.src = privateTarget;
                  document.body.append(image);
                }
                if (kind === 'form') {
                  recordAttempt();
                  const name = 'private-probe-frame-' + marker;
                  frame('about:blank', name);
                  const form = mark(document.createElement('form'));
                  form.method = 'post';
                  form.action = privateTarget;
                  form.target = name;
                  document.body.append(form);
                  form.submit();
                }
                if (['redirect', 'meta', 'script'].includes(kind)) {
                  recordAttempt();
                  frame(publicRoute(kind));
                }
                if (kind === 'popup') {
                  recordAttempt();
                  const link = mark(document.createElement('a'));
                  link.href = privateTarget;
                  link.target = '_blank';
                  document.body.append(link);
                  link.click();
                }
                if (kind === 'cross-frame-popup') {
                  frame(publicRoute(kind, true));
                }
                if (kind === 'cross-frame-blank') {
                  const node = frame(publicRoute(kind, true));
                  node.hidden = false;
                  node.dataset.peerdCrossFrameBlank = '';
                  node.style.cssText = 'position:fixed;top:20px;left:20px;width:200px;height:100px;z-index:2147483647;border:0';
                }
                if (kind === 'location') {
                  recordAttempt();
                  location.href = privateTarget;
                }
              },
              args: [${JSON.stringify(vector)}, ${JSON.stringify(target)},
                ${JSON.stringify(networkGuardFixtureUrl)}, ${privatePort}, ${JSON.stringify(marker)}],
            }))()`, true);
            if (vector === 'cross-frame-blank') {
              // why: popup admission is separate from the network floor. Use a
              // real click so a refused automatic popup cannot fake coverage.
              const ready = await waitFor(() => controllerAttempts.has(vector + ':ready'), {
                budgetMs: 2_000, pollMs: 25,
              });
              if (!ready) throw new Error('cross-frame blank action did not become ready');
              const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
              const target = targets.find((item) => item.type === 'page' && item.url === networkGuardFixtureUrl);
              if (!target) throw new Error('cross-frame blank source target not found');
              const source = await attach(target.webSocketDebuggerUrl);
              try {
                const point = await evalIn(source, `(() => {
                  const rect = document.querySelector('[data-peerd-cross-frame-blank]').getBoundingClientRect();
                  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                })()`);
                await source.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
                await source.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
              } finally { source.close(); }
            }
            await waitFor(() => controllerAttempts.has(vector), {
              budgetMs: 2_000, pollMs: 25,
            });
            await sleep(800);
            return {
              connections,
              requests: [...requests],
              attempted: controllerAttempts.has(vector),
              stages: [...controllerAttempts].filter((entry) => entry.startsWith(vector + ':')),
              port: privatePort,
            };
          } finally {
            const children = await evalIn(ctx.page, `chrome.tabs.query({}).then((items) =>
              items.filter((tab) => tab.openerTabId === ${drivenTab.id}).map((tab) => tab.id))`, true)
              .catch(() => []);
            for (const childId of children) {
              await evalIn(ctx.page, `chrome.tabs.remove(${childId})`, true).catch(() => {});
            }
            await evalIn(ctx.page, `chrome.scripting.executeScript({
              target: { tabId: ${drivenTab.id} },
              world: 'MAIN',
              func: (marker) => {
                for (const node of document.querySelectorAll(
                  '[data-peerd-network-probe="' + marker + '"]')) node.remove();
                const socket = globalThis.__peerdNetworkProbeSockets?.get(marker);
                try { socket?.close(); } catch {}
                globalThis.__peerdNetworkProbeSockets?.delete(marker);
              },
              args: [${JSON.stringify(marker)}],
            })`, true).catch(() => {});
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
          }
        };

        for (const vector of [
          'fetch', 'websocket', 'image', 'form', 'redirect', 'meta', 'script',
          'popup', 'cross-frame-popup', 'cross-frame-blank', 'location',
        ]) {
          const observed = await runVector(vector);
          recordNetworkFloorVector(rec, vector, observed);
          if (vector === 'location') {
            rec.observe('blocked top-level private navigation transport', {
              mode: observed.connections === 0 ? 'blocked-before-connect' : 'connected-without-request',
              ...observed,
            });
          }
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
              && JSON.stringify(rule.condition?.initiatorDomains) === JSON.stringify(guardedWorkerDomains)),
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
            initiator: ${JSON.stringify(`http://${NETWORK_GUARD_UNRELATED_HOST}:${NETWORK_GUARD_CONTROLLER_PORT}`)},
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
        const wakeWorkerForMonitor = async (tabId) => evalIn(ctx.page, `(async () => {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: ${tabId} },
            world: 'MAIN',
            func: async () => {
              const registration = await navigator.serviceWorker.ready;
              const monitorToken = crypto.randomUUID();
              return new Promise((resolve) => {
                const finish = (value) => {
                  clearTimeout(timer);
                  navigator.serviceWorker.removeEventListener('message', onMessage);
                  resolve(value);
                };
                const onMessage = (event) => {
                  if (event.data?.peerdNetworkMonitorToken === monitorToken) finish(true);
                };
                const timer = setTimeout(() => finish(false), 5_000);
                navigator.serviceWorker.addEventListener('message', onMessage);
                registration.active.postMessage({ monitorToken });
              }).then((acknowledged) => acknowledged ? monitorToken : null);
            },
          });
          return injection?.result ?? null;
        })()`, true);
        const releaseWorkerMonitorHold = async (tabId, monitorToken) => evalIn(ctx.page, `(async () => {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: ${tabId} },
            world: 'MAIN',
            func: async (token) => {
              const registration = await navigator.serviceWorker.ready;
              return new Promise((resolve) => {
                const finish = (value) => {
                  clearTimeout(timer);
                  navigator.serviceWorker.removeEventListener('message', onMessage);
                  resolve(value);
                };
                const onMessage = (event) => {
                  if (event.data?.peerdNetworkMonitorReleaseToken === token) finish(true);
                };
                const timer = setTimeout(() => finish(false), 5_000);
                navigator.serviceWorker.addEventListener('message', onMessage);
                registration.active.postMessage({ monitorReleaseToken: token });
              });
            },
            args: [${JSON.stringify(monitorToken)}],
          });
          return injection?.result === true;
        })()`, true);
        // A registered page worker is allowed to retire before this state reaches
        // the worker lane. Wake it through its ordinary client before polling the
        // debugger target list; otherwise a one-time target snapshot races Chrome's
        // service-worker startup and makes the Network gate intermittently blind.
        const monitorToken = await wakeWorkerForMonitor(drivenTab.id);
        const monitorWakeAcknowledged = typeof monitorToken === 'string';
        if (monitorWakeAcknowledged) {
          releaseMonitorHold = () => releaseWorkerMonitorHold(drivenTab.id, monitorToken);
        }
        let monitorHoldReleased = false;
        try {
          ordersWorkerMonitor = monitorWakeAcknowledged
            ? await attachWorkerMonitor(new URL(networkGuardFixtureUrl).origin) : null;
        } finally {
          monitorHoldReleased = releaseMonitorHold
            ? await releaseMonitorHold().catch(() => false) : false;
          if (monitorHoldReleased) releaseMonitorHold = null;
        }
        rec.check('Chrome exposes the fixture service worker to the network test',
          monitorWakeAcknowledged && ordersWorkerMonitor !== null && monitorHoldReleased,
          JSON.stringify({
            monitorWakeAcknowledged,
            monitored: ordersWorkerMonitor !== null,
            monitorHoldReleased,
          }));

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
        await waitFor(() => networkFailureFor(ordersWorkerMonitor, 'worker-fetch-guarded'), {
          budgetMs: 5_000, pollMs: 25,
        });
        const guardedNetworkFailure = networkFailureFor(ordersWorkerMonitor, 'worker-fetch-guarded');
        rec.check('the public fixture has an active service worker with WebSocket support',
          guardedWorker?.secure === true && guardedWorker?.active === true
            && guardedWorker?.completed === true
            && controllerAttempts.has('worker-guarded-websocket-function'),
          JSON.stringify({ guardedWorker, attempts: [...controllerAttempts] }));
        rec.check('the custodied page worker fetch causes no private-network side effect',
          !probeRequests.some((request) => request.includes('worker-fetch-guarded')),
          JSON.stringify({ probeConnections, probeRequests, events: ordersWorkerMonitor?.events }));
        rec.check('Chrome reports the custodied worker request as browser-policy blocked',
          guardedNetworkFailure?.errorText === 'net::ERR_BLOCKED_BY_CLIENT',
          JSON.stringify(guardedNetworkFailure));

        rec.observe('custodied service-worker WebSocket residual', {
          mode: probeRequests.some((request) => request.includes('worker-websocket-guarded'))
            ? 'bypassed' : 'blocked-or-deferred',
          probeConnections,
          probeRequests: [...probeRequests],
          events: ordersWorkerMonitor?.events ?? [],
        });

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
        diagnosticWorkerRuleInstalled = true;
        await resetProbe();
        const unscopedWorker = await triggerWorker(drivenTab.id, 'unscoped-diagnostic');
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
        rec.check('the unscoped worker-WebSocket diagnostic executed',
          unscopedAttempted === true && unscopedWorker?.completed === true,
          JSON.stringify({ unscopedAttempted, unscopedWorker }));
        rec.observe('unscoped service-worker WebSocket diagnostic', {
          mode: unscopedReached ? 'bypassed' : 'blocked-or-deferred',
          probeConnections,
          probeRequests: [...probeRequests],
          events: ordersWorkerMonitor?.events ?? [],
        });
        await evalIn(ctx.page, `chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [4999],
        })`, true);
        diagnosticWorkerRuleInstalled = false;
        if (!unscopedReached) {
          await waitFor(() => probeRequests
            .some((request) => request.includes('worker-websocket-unscoped-diagnostic')), {
            budgetMs: 2_000, pollMs: 25,
          });
        }

        rec.check('the page-domain worker rule does not intercept the extension local provider',
          ctx.modelCallCount() > 0,
          JSON.stringify({ modelCalls: ctx.modelCallCount() }));

        const unrelatedUrl = networkGuardFixtureUrl.replace(
          NETWORK_GUARD_OWNED_HOST, NETWORK_GUARD_UNRELATED_HOST);
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
              JSON.stringify(rule.condition?.initiatorDomains)
                === JSON.stringify(${JSON.stringify(retainedWorkerDomains)}));
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
        await waitFor(() => networkFailureFor(ordersWorkerMonitor, 'worker-fetch-retained'), {
          budgetMs: 5_000, pollMs: 25,
        });
        const retainedNetworkFailure = networkFailureFor(ordersWorkerMonitor, 'worker-fetch-retained');
        rec.check('a previously visited worker domain remains guarded after navigation',
          retainedWorker?.secure === true
            && retainedWorker?.completed === true
            && retainedNetworkFailure?.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
            && !probeRequests.some((request) => request.includes('worker-fetch-retained')),
          JSON.stringify({ retainedWorker, retainedNetworkFailure, probeConnections, probeRequests }));
        rec.observe('retained-domain service-worker WebSocket residual', {
          mode: probeRequests.some((request) => request.includes('worker-websocket-retained'))
            ? 'bypassed' : 'blocked-or-deferred',
          probeConnections,
          probeRequests: [...probeRequests],
          events: ordersWorkerMonitor?.events ?? [],
        });

        await evalIn(ctx.page, `chrome.tabs.remove(${drivenTab.id})`, true).catch(() => {});
        const releasedScope = await waitFor(() => evalIn(ctx.page, `(async () => {
          const policy = await import(chrome.runtime.getURL('peerd-egress/index.js'));
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          const workerRules = rules.filter((rule) =>
            policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
          const expected = ${JSON.stringify(initialWorkerDomains)};
          return expected.length === 0
            ? workerRules.length === 0
            : workerRules.length === policy.PRIVATE_NETWORK_INITIATOR_RULE_IDS.length
              && workerRules.every((rule) =>
                JSON.stringify(rule.condition?.initiatorDomains) === JSON.stringify(expected));
        })()`, true), { budgetMs: 5_000, pollMs: 25 });
        rec.check('closing test custody restores the prior worker-domain rules',
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
      } finally {
        if (releaseMonitorHold) {
          await releaseMonitorHold().catch(() => false);
          releaseMonitorHold = null;
        }
        if (diagnosticWorkerRuleInstalled) {
          await evalIn(ctx.page, `chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [4999],
          })`, true).catch(() => {});
        }
        ordersWorkerMonitor?.connection.close();
        for (const isolated of isolatedProbes) isolated.close();
        probeServer.closeAllConnections?.();
        controllerServer.closeAllConnections?.();
        probeServer.close();
        controllerServer.close();
        // Keep the endpoints alive throughout the state and include delayed
        // connections/requests in the one private-child verdict. Report after
        // closing all sockets so a reporter error cannot strand a listener.
        if (privateChildObserved) recordPrivateChildFloor(rec, {
          ...privateChildObserved,
          navigation: privateNavigationProbe.snapshot(),
          childFetch: { ...privateFetchProbe.snapshot(),
            attempted: controllerAttempts.has('trusted-private-child-fetch') },
        });
      }
    },
  },

  // --- functional: portable identity through the live SW + offscreen host ---
  {
    name: 'portable-identity', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, true);
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

      const homePage = await openWidePage(ctx, 'home/home.html');
      try {
        await rpc(homePage, { type: 'settings/update', patch: { dwebEnabled: true } });
        const restarted = await rpc(homePage, { type: 'dweb/base/start' });
        rec.check('the peer host starts under the restored identity after lease release',
          restarted?.ok === true && restarted?.running === true && restarted?.did === incoming.did,
          JSON.stringify(restarted));
      } finally { try { homePage.close(); } catch { /* */ } }
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
      await chooseFixtureNetwork(ctx, true);
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
        await rec.visualPage('options-transfer-conflict', page, { beforeShot: async (_page, theme) => {
          await pinIdentityText();
          // why: the disabled export pair can lose its paint in headless light
          // captures. Record the actual DOM/style boundary without replacing
          // pixels or changing production CSS to hide a rendering regression.
          const debugControls = await evalIn(page, `(() => {
            const describe = (element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return { tag: element.tagName, className: element.className,
                rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                  width: rect.width, height: rect.height },
                style: Object.fromEntries(['display', 'visibility', 'opacity', 'color',
                  'backgroundColor', 'borderColor', 'borderRadius', 'transform', 'filter',
                  'overflow', 'position', 'zIndex'].map((key) => [key, style[key]])) };
            };
            const buttons = [...document.querySelectorAll('button')].filter((button) =>
              ['Export debug bundle', 'Export OTel trace'].includes(button.textContent.trim()));
            return { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
              visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight },
              buttons: buttons.map((button) => ({ ...describe(button),
                label: button.textContent.trim(), disabled: button.disabled,
                hit: (() => { const r = button.getBoundingClientRect();
                  const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  return { tag: target?.tagName, text: target?.textContent?.trim().slice(0, 100) }; })(),
                ancestors: [button.parentElement, button.parentElement?.parentElement,
                  document.documentElement].filter(Boolean).map(describe),
              })) };
          })()`);
          rec.observe(`debug export paint boundary (${theme})`, debugControls);
          const controlsPresent = debugControls?.buttons?.length === 2
            && debugControls.buttons.every((button) => button.rect.width > 0 && button.rect.height > 0
              && button.rect.left >= 0 && button.rect.right <= debugControls.viewport.width
              && button.style.display !== 'none' && button.style.visibility === 'visible'
              && Number(button.style.opacity) > 0)
            && debugControls.buttons[0].rect.right <= debugControls.buttons[1].rect.left + 0.5;
          rec.check(`debug export labels and separate control boxes remain present (${theme})`, controlsPresent);
          if (!controlsPresent) throw new Error('debug export controls are missing or overlapping');
        } });
      } finally { await retirePrivateTransferPage(page); }
    },
  },

  // --- visual: idle unlocked panel -------------------------------------------
  {
    name: 'openrouter-host-catalog', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const model = 'z-ai/glm-5.1';
      const createFixture = async (initialMode = 'valid') => {
        let mode = initialMode, actorStarted = false, phase = 'chat';
        const catalogs = [], requests = [], errors = [], workers = new Map();
        const child = await launchPeerd({ extensionDir: ctx.extensionDir, resumeAuxiliaryWorkers: false, modelResponder: (_index, request) => {
          requests.push({ at: performance.now(), url: request.url, body: JSON.parse(request.postData) });
          if (request.postData.includes('<actor_agent>')) return { sse: sseText('CATALOG-ACTOR-DONE') };
          if (phase === 'actor' && !actorStarted) { actorStarted = true; return { sse: sseToolCall('actor_create', { task: 'Return the catalog worker control.', tools: [] }) }; }
          return { sse: sseText(phase === 'actor'
            ? request.postData.includes('An actor you started earlier') ? 'CATALOG-ACTOR-REPORT' : 'CATALOG-ACTOR-QUEUED'
            : 'CATALOG-REPLY') };
        } });
        let browser, identity;
        const close = async () => {
          try {
            if (identity) {
              const evidence = await identity.close();
              rec.observe('catalog worker identity and cleanup', evidence);
              const clean = evidence.errors.length === 0
                && evidence.commands.every((command) => command.status === 'complete')
                && evidence.workers.every((worker) => worker.released || worker.destroyed);
              rec.check('catalog worker identity observer closes without errors', clean);
              if (!clean) throw new Error('catalog worker identity or cleanup failed');
            }
          } finally { browser?.close(); await child.close(); }
        };
        try {
          const version = await fetch(`http://127.0.0.1:${child.port}/json/version`).then((reply) => reply.json());
          browser = await attach(version.webSocketDebuggerUrl);
          const { sessionId } = await browser.send('Target.attachToTarget', { targetId: child.sw.targetId, flatten: true });
          browser.on((method, params, message) => {
            if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(method) && params.targetInfo.type === 'worker') {
              const target = params.targetInfo;
              workers.set(target.targetId, { ...(workers.get(target.targetId) ?? {}), ...target });
            }
            if (method === 'Target.targetDestroyed' && workers.has(params.targetId)) workers.get(params.targetId).destroyed = true;
            if (method !== 'Fetch.requestPaused' || message.sessionId !== sessionId) return;
            const { request, requestId } = params;
            if (request.url !== 'https://openrouter.ai/api/v1/models') { errors.push('unexpected catalog endpoint'); return; }
            catalogs.push({ at: performance.now(), method: request.method, mode });
            if (mode === 'hold') return;
            const data = mode === 'invalid' ? { data: null } : { data: [{ id: model, context_length: 256_000, top_provider: { context_length: 200_000 } }] };
            void browser.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
              responseHeaders: [{ name: 'content-type', value: 'application/json' }],
              body: Buffer.from(JSON.stringify(data)).toString('base64') }, sessionId).catch((error) => errors.push(String(error)));
          });
          await browser.send('Target.setDiscoverTargets', { discover: true });
          await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'https://openrouter.ai/api/v1/models' }] }, sessionId);
          await unlockAndReady(child.page);
          identity = await observeCatalogWorkerIdentity(child, browser);
          const key = await rpc(child.page, { type: 'provider/setKey', provider: 'openrouter', plaintext: 'sk-or-v1-e2e-catalog-wire-only', activate: false });
          const settings = await rpc(child.page, { type: 'settings/update', patch: { providerName: 'openrouter', providerModel: model, autoMemoryEnabled: false } });
          if (!key?.ok || !settings?.ok) throw new Error('OpenRouter wire fixture refused');
          return { child, catalogs, requests, errors, workers, identity, setMode: (next) => { mode = next; },
            setPhase: (next) => { phase = next; }, close };
        } catch (error) { await close(); throw error; }
      };
      const send = async (fixture, text) => {
        const page = fixture.child.page;
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('form.input-bar textarea')`))) throw new Error('catalog composer did not mount');
        await evalIn(page, `(() => { 'use strict'; const input = document.querySelector('form.input-bar textarea');
          input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        if (!await waitFor(() => evalIn(page, `document.querySelector('.send-btn')?.disabled === false`))) throw new Error('catalog composer stayed disabled');
        await clickAndSyncRedraw(page, '.send-btn');
      };
      const settled = (fixture, text, budgetMs = 20_000) => waitFor(() => evalIn(fixture.child.page,
        `${JSON.stringify(text)} === [...document.querySelectorAll('.message-assistant .bubble')].at(-1)?.textContent.trim()
          && !document.querySelector('form.input-bar button.stop')`), { budgetMs, pollMs: 50 });
      const nativeHeaps = (fixture, targets, role, retired) => {
        const evidence = fixture.identity.snapshot();
        const parent = evidence.parents.length === 1 ? evidence.parents[0] : null;
        const workers = targets.map((target) => evidence.workers.filter((worker) => worker.targetId === target.targetId));
        const ok = !!parent && evidence.errors.length === 0 && workers.length > 0
          && workers.every((matches) => matches.length === 1 && matches.every((worker) =>
            worker.parentTargetId === parent.target.targetId && worker.targetInfo.parentId === parent.target.targetId
            && worker.parentSessionId === parent.parentSessionId && worker.targetInfo.type === 'worker'
            && worker.native?.href === `chrome-extension://${fixture.child.sw.id}/offscreen/${role}-worker.js`
            && worker.native.name === (role === 'controller' ? 'peerd-controller' : '')
            && worker.native.constructorName === 'DedicatedWorkerGlobalScope' && !worker.error && worker.released
            && (!retired || worker.destroyed === true)));
        return { ok, parent, workers: workers.flat() };
      };
      const warm = await createFixture();
      try {
        const sessions = [], controllerHeaps = [];
        for (let index = 0; index < 3; index += 1) {
          if (index) await resetSession(warm.child);
          // why: each validated turn creates a model client. Other controller work can overlap.
          const beforeRequests = warm.requests.length;
          const text = `Catalog chat ${index + 1}.`;
          await send(warm, text);
          if (!await settled(warm, 'CATALOG-REPLY')) throw new Error('fresh OpenRouter chat did not settle');
          const state = await rpc(warm.child.page, { type: 'state/get' });
          if (!state?.ok || !state.state.session.sessionId) throw new Error('catalog chat identity is missing');
          sessions.push(state.state.session.sessionId);
          const heaps = warm.identity.snapshot().workers.filter((worker) =>
            worker.native?.href === `chrome-extension://${warm.child.sw.id}/offscreen/controller-worker.js`);
          const native = nativeHeaps(warm, heaps, 'controller', false);
          rec.observe(`chat ${index + 1} observed controller lifecycle`, heaps);
          const request = warm.requests[beforeRequests];
          rec.check(`chat ${index + 1} has exact native controller identity and one model call`, native.ok
            && warm.requests.length === beforeRequests + 1 && Array.isArray(request?.body?.messages)
            && request.body.messages.some((message) => message.role === 'user'
              && JSON.stringify(message.content ?? '').includes(text)), JSON.stringify(native));
          if (!native.ok) throw new Error('controller heap native identity is missing');
          controllerHeaps.push(...heaps.map((worker) => worker.targetId));
        }
        warm.setPhase('actor');
        await send(warm, 'Start the catalog actor.');
        if (!await settled(warm, 'CATALOG-ACTOR-REPORT', 30_000)) throw new Error('catalog actor did not return through the real wake');
        const actorHeaps = warm.identity.snapshot().workers.filter((worker) =>
          worker.native?.href === `chrome-extension://${warm.child.sw.id}/offscreen/actor-worker.js`);
        const actorIdentity = nativeHeaps(warm, actorHeaps, 'actor', false);
        rec.check('the isolated actor has exact native worker and parent identity', actorIdentity.ok, JSON.stringify(actorIdentity));
        if (!actorIdentity.ok) throw new Error('actor heap native identity is missing');
        const audit = await rpc(warm.child.page, { type: 'audit/list', limit: 800 });
        if (!audit?.ok || !Array.isArray(audit.entries)) throw new Error('catalog actor audit refused');
        const isolation = actorIsolationEvidence(audit.entries);
        rec.check('three real chats and a fresh isolated actor use the model path', new Set(sessions).size === 3
          && new Set(controllerHeaps).size >= 1 && actorHeaps.length >= 1 && isolation.exactProof,
        JSON.stringify({ sessions, controllerHeaps, actorHeaps, isolation }));
        rec.check('all inference stays on the intercepted OpenRouter wire', warm.requests.length >= 6
          && warm.requests.every((request) => request.url === 'https://openrouter.ai/api/v1/chat/completions' && request.body.model === model));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base catalog GETs across real chats and the actor', warm.catalogs);
        else rec.check('all real chats and the isolated actor share one valid host catalog', warm.catalogs.length === 1 && warm.catalogs[0].method === 'GET');
        await rec.visualPage('openrouter-host-catalog', warm.child.page);
        warm.setMode('hold'); warm.setPhase('chat');
        const before = warm.catalogs.length;
        await send(warm, 'Reuse the warm model catalog while its endpoint is held.');
        const reused = await settled(warm, 'CATALOG-REPLY', 3_000);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base warm catalog hold', { reused, requests: warm.catalogs.length - before });
        else rec.check('the warm cache avoids the held endpoint and completes the model turn', reused === true && warm.catalogs.length === before);
        await rec.visualPage('openrouter-warm-held', warm.child.page);
        if (!reused && !(await rpc(warm.child.page, { type: 'agent/stop' }))?.ok) throw new Error('held catalog Stop refused');
        rec.check('catalog fixture has no interception error', warm.errors.length === 0, JSON.stringify(warm.errors));
      } finally { await warm.close(); }
      for (const mode of ['invalid', 'hold']) {
        const fresh = await createFixture(mode);
        try {
          await send(fresh, `Use the static fallback after the first ${mode} metadata read.`);
          const completed = await settled(fresh, 'CATALOG-REPLY', mode === 'hold' ? 12_000 : 5_000);
          const elapsedMs = fresh.requests[0] && fresh.catalogs[0] ? fresh.requests[0].at - fresh.catalogs[0].at : null;
          if (process.env.PEERD_VISUAL_BASE_RENDER === '1' && mode === 'hold') rec.observe('base stalled first catalog', { completed, elapsedMs });
          else rec.check(`${mode} first metadata leaves inference available within its bounded deadline`, completed === true
            && fresh.catalogs.length === 1 && fresh.requests.length === 1
            && elapsedMs !== null && elapsedMs < (mode === 'hold' ? 11_000 : 5_000), JSON.stringify({ elapsedMs, catalogs: fresh.catalogs }));
          await rec.visualPage(`openrouter-first-${mode}`, fresh.child.page);
          if (!completed && !(await rpc(fresh.child.page, { type: 'agent/stop' }))?.ok) throw new Error('stalled first metadata Stop refused');
          rec.check(`${mode} catalog interception stays local`, fresh.errors.length === 0, JSON.stringify(fresh.errors));
        } finally { await fresh.close(); }
      }
    },
  },
  {
    name: 'invalid-tool-arguments', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const requests = [];
      const ids = ['runtime-broken-json', 'runtime-null-json', 'runtime-valid-object'];
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, modelResponder: (index, request) => {
        requests.push({ url: request.url, body: JSON.parse(request.postData) });
        if (index > 0) return { sse: sseText('ARGUMENTS-CHECKED') };
        const calls = ['{"url":"unterminated', 'null', '{}'].map((argumentsText, offset) => ({
          index: offset, id: ids[offset], type: 'function', function: { name: 'open_tab', arguments: argumentsText },
        }));
        return { sse: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
          'data: [DONE]', '',
        ].join('\n\n') };
      } });
      try {
        await unlockAndReady(child.page);
        const key = await rpc(child.page, { type: 'provider/setKey', provider: 'openai', plaintext: 'sk-e2e-runtime-wire-only', activate: false });
        const settings = await rpc(child.page, { type: 'settings/update', patch: { providerName: 'openai', providerModel: 'gpt-4.1-mini', autoMemoryEnabled: false } });
        if (!key?.ok || !settings?.ok) throw new Error('OpenAI fixture selection refused');
        const beforeTabs = await evalIn(child.page, `chrome.tabs.query({}).then((tabs) => tabs.map(({ id, url }) => ({ id, url })))`, true);
        const beforeAudit = await rpc(child.page, { type: 'audit/list', limit: 800 });
        if (!beforeAudit?.ok || !Array.isArray(beforeAudit.entries)) throw new Error('audit read refused');
        const priorIds = new Set(beforeAudit.entries.map((entry) => entry.id));
        if (!await waitFor(() => evalIn(child.page, `!!document.querySelector('.input-bar textarea')`))) throw new Error('composer did not mount');
        await evalIn(child.page, `(() => { 'use strict';
          const input = document.querySelector('.input-bar textarea'); input.value = 'Open the task tabs with the supplied arguments.';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        if (!await waitFor(() => evalIn(child.page, `document.querySelector('.send-btn')?.disabled === false`))) throw new Error('composer is not ready');
        await clickAndSyncRedraw(child.page, '.send-btn');
        const session = await waitFor(async () => {
          const reply = await rpc(child.page, { type: 'state/get' });
          return reply?.ok && reply.state?.session?.messages?.some((message) => message.role === 'assistant' && message.content === 'ARGUMENTS-CHECKED' && message.streaming === false) ? reply.state.session : null;
        }, { budgetMs: 30_000, pollMs: 80 });
        if (!session) throw new Error('OpenAI argument probe did not settle');
        const afterTabs = await evalIn(child.page, `chrome.tabs.query({}).then((tabs) => tabs.map(({ id, url }) => ({ id, url })))`, true);
        const added = afterTabs.filter((tab) => !beforeTabs.some((prior) => prior.id === tab.id));
        const results = session.messages.flatMap((message) => message.toolResults ?? []);
        const valid = results.find((result) => result.tool_use_id === ids[2]);
        const receiptId = Number(valid?.content.match(/"tabId"\s*:\s*(\d+)/)?.[1]);
        rec.check('the valid sibling opens its real task tab', valid?.is_error === false && added.some((tab) => tab.id === receiptId), JSON.stringify({ added, valid }));
        rec.check('the existing tab URLs stay exact', beforeTabs.every((prior) => afterTabs.some((tab) => tab.id === prior.id && tab.url === prior.url)));
        rec.check('the real OpenAI adapter receives two model responses', requests.length === 2
          && requests.every((request) => request.url === 'https://api.openai.com/v1/chat/completions'));
        const replay = requests[1]?.body.messages ?? [];
        const uses = session.messages.flatMap((message) => message.toolUses ?? []);
        const audit = await rpc(child.page, { type: 'audit/list', limit: 800 });
        if (!audit?.ok || !Array.isArray(audit.entries)) throw new Error('settled audit read refused');
        const entries = audit.entries.filter((entry) => !priorIds.has(entry.id));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base invalid effects', { added, results, entries });
        else {
          rec.check('both invalid calls have known error results and no target effect', added.length === 1 && ids.slice(0, 2).every((id) => {
            const result = results.find((candidate) => candidate.tool_use_id === id);
            return result?.is_error === true && result.outcomeKnown !== false && result.content.startsWith('invalid_arguments:')
              && replay.some((message) => message.role === 'tool' && message.tool_call_id === id && message.content === result.content)
              && JSON.stringify(uses.find((use) => use.id === id)?.input) === '{}';
          }), JSON.stringify(results));
          const audited = entries.filter((entry) => ids.includes(entry.details?.callId));
          rec.check('host audit records two known failures and only one execution', audited.length === 3
            && ids.slice(0, 2).every((id) => audited.some((entry) => entry.type === 'tool_failed'
              && entry.details.callId === id && entry.details.tool === 'open_tab'
              && entry.details.outcome === 'semantic-failure' && entry.details.performed === false && entry.details.outcomeKnown === true))
            && audited.some((entry) => entry.type === 'tool_executed' && entry.details.callId === ids[2]
              && entry.details.tool === 'open_tab' && entry.details.operation === 'turn.page.open-tab'
              && entry.details.performed === true && entry.details.outcomeKnown === true), JSON.stringify(audited));
        }
        if (!await waitFor(() => evalIn(child.page, `document.querySelectorAll('.tool-call').length === 3`))) throw new Error('tool cards did not render');
        await rec.visualPage('invalid-tool-arguments', child.page);
        await clickAndSyncRedraw(child.page, '.tool-call-header');
        await rec.visualPage('invalid-arguments-detail', child.page);
      } finally { await child.close(); }
    },
  },
  {
    name: 'instruction-paging', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const skillName = 'e2e-instruction-paging';
      const skillBody = Array.from({ length: 120 }, (_, index) => `Step ${index + 1}: ${'Keep this instruction. '.repeat(20).trimEnd()}`).join('\n');
      const memoryBody = Array.from({ length: 300 }, (_, index) => `Note ${index + 1}: ${'Keep this durable note. '.repeat(2).trimEnd()}`).join('\n');
      const pages = { load_skill: [], read_memory: [] };
      let stage = 'load_skill';
      let modelCalls = 0;
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, modelResponder: (_index, request) => {
        if (++modelCalls > 10) return { sse: sseText('PAGING-PROBE-FAILED') };
        const body = JSON.parse(request.postData);
        const previous = body.messages.filter((message) => message.role === 'tool').at(-1);
        if (previous) {
          const call = body.messages.flatMap((message) => message.tool_calls ?? []).find((candidate) => candidate.id === previous.tool_call_id);
          if (!call || !Object.hasOwn(pages, call.function.name)) throw new Error('unexpected paging result');
          pages[call.function.name].push(previous.content);
          const next = previous.content.match(/next: (.+)\.$/m);
          if (next) return { sse: sseToolCall(call.function.name, JSON.parse(next[1])) };
          stage = call.function.name === 'load_skill' ? 'read_memory' : 'done';
        }
        return { sse: stage === 'done' ? sseText('ALL-INSTRUCTIONS-READ')
          : sseToolCall(stage, stage === 'load_skill' ? { name: skillName } : { scope: 'user' }) };
      } });
      let options;
      try {
        await unlockAndReady(child.page);
        const key = await rpc(child.page, { type: 'provider/setKey', provider: 'openai', plaintext: 'sk-e2e-runtime-wire-only', activate: false });
        const settings = await rpc(child.page, { type: 'settings/update', patch: { providerName: 'openai', providerModel: 'gpt-4.1-mini', autoMemoryEnabled: false } });
        if (!key?.ok || !settings?.ok) throw new Error('paging provider selection refused');
        options = await openWidePage(child, 'options/options.html#!/skills');
        if (!await waitFor(() => evalIn(options, `!!document.querySelector('.skills-install textarea')`))) throw new Error('skill editor did not mount');
        await evalIn(options, `(() => { 'use strict';
          const input = document.querySelector('.skills-install textarea');
          input.value = ${JSON.stringify(`---\nname: ${skillName}\ndescription: Check every instruction through bounded pages.\n---\n${skillBody}`)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await clickAndSyncRedraw(options, '.skills-install button');
        if (!await waitFor(async () => {
          const result = await rpc(options, { type: 'skills/list' });
          return result?.ok && result.skills?.some((skill) => skill.name === skillName);
        })) throw new Error('long skill did not install');
        await options.close();
        options = await openWidePage(child, 'options/options.html#!/memory');
        if (!await waitFor(() => evalIn(options, `!!document.querySelector('.memory-actions')`))) throw new Error('memory view did not mount');
        await evalIn(options, `(() => { 'use strict';
          [...document.querySelectorAll('.memory-actions button')].find((button) => button.textContent === 'New user note')?.click();
        })()`);
        if (!await waitFor(() => evalIn(options, `!![...document.querySelectorAll('.memory-card')].find((card) => card.querySelector('.memory-scope')?.textContent.startsWith('User'))`))) throw new Error('user memory editor did not mount');
        await evalIn(options, `(() => { 'use strict';
          const card = [...document.querySelectorAll('.memory-card')].find((element) => element.querySelector('.memory-scope')?.textContent.startsWith('User'));
          const input = card.querySelector('textarea'); input.value = ${JSON.stringify(memoryBody)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        if (!await waitFor(() => evalIn(options, `[...document.querySelectorAll('.memory-card-actions button')].find((button) => button.textContent === 'Save')?.disabled === false`))) throw new Error('memory draft did not become ready');
        await evalIn(options, `[...document.querySelectorAll('.memory-card-actions button')].find((button) => button.textContent === 'Save').click()`);
        if (!await waitFor(async () => {
          const result = await rpc(options, { type: 'memory/export' });
          return result?.ok && result.payload?.docs?.some((doc) => doc.kind === 'user' && doc.body === memoryBody);
        })) throw new Error('long memory did not save');
        await child.page.send('Page.bringToFront');
        await evalIn(child.page, `(() => { 'use strict';
          const input = document.querySelector('.input-bar textarea'); input.value = 'Read the complete paging skill and user memory.';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        if (!await waitFor(() => evalIn(child.page, `document.querySelector('.send-btn')?.disabled === false`))) throw new Error('paging composer is not ready');
        await clickAndSyncRedraw(child.page, '.send-btn');
        const finished = await waitFor(async () => {
          const reply = await rpc(child.page, { type: 'state/get' });
          return reply?.ok && reply.state?.session?.messages?.some((message) => message.role === 'assistant' && message.content === 'ALL-INSTRUCTIONS-READ' && message.streaming === false);
        }, { budgetMs: 45_000, pollMs: 80 });
        if (!finished) throw new Error(`instruction paging did not settle: ${modelCalls} calls`);
        rec.check('both reads return real nonempty model tool bytes', pages.load_skill.length > 0 && pages.read_memory.length > 0);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base instruction pages', pages);
        else {
          rec.check('every skill byte reaches the model through intact bounded pages', pages.load_skill.length > 1
            && pages.load_skill.every((page) => page.length <= 18_000 && !page.includes(' chars elided '))
            && pages.load_skill.map((page) => page.match(/\n\n([\s\S]*)\n<\/skill>/)?.[1]).join('') === skillBody);
          rec.check('every memory byte reaches the model through intact bounded pages', pages.read_memory.length > 1
            && pages.read_memory.every((page) => page.length <= 18_000 && !page.includes(' chars elided '))
            && pages.read_memory.map((page) => page.replace(/\n\[paging\][^\n]*$/, '')).join('') === memoryBody);
        }
        for (const name of ['load_skill', 'read_memory']) for (const edge of ['first', 'last']) {
          await evalIn(child.page, `(() => { 'use strict';
            const cards = [...document.querySelectorAll('.tool-call')].filter((card) => card.querySelector('.tool-name')?.textContent === ${JSON.stringify(name)});
            const card = cards[${edge === 'first' ? '0' : 'cards.length - 1'}];
            if (!card) throw new Error('paging card is missing');
            const header = card.querySelector('.tool-call-header'); if (header.getAttribute('aria-expanded') !== 'true') header.click();
          })()`);
          await rec.visualPage(name === 'load_skill' && edge === 'first' ? 'instruction-paging' : `instruction-${name}-${edge}`, child.page, { beforeShot: (page) => evalIn(page, `(() => { 'use strict';
            const cards = [...document.querySelectorAll('.tool-call')].filter((card) => card.querySelector('.tool-name')?.textContent === ${JSON.stringify(name)});
            const card = cards[${edge === 'first' ? '0' : 'cards.length - 1'}]; card.scrollIntoView({ block: 'start' });
            const content = card.querySelector('.tool-result-content'); if (content) content.scrollTop = ${edge === 'first' ? '0' : 'content.scrollHeight'};
          })()`) });
        }
      } finally { if (options) await options.close(); await child.close(); }
    },
  },
  {
    name: 'actor-stop-transcripts', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let childCalls = 0;
      let spawned = false;
      let parentWaiting = false;
      const tasks = [1, 2, 3].map((index) => `Stop transcript fixture ${index}: retain this task after reload.`);
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, modelResponder: async (_index, request) => {
        if (request.postData.includes('<actor_agent>')) { childCalls++; await gate; return { sse: sseText('LATE-CHILD-REPLY') }; }
        if (!spawned) { spawned = true; return { sse: sseToolCalls(tasks.map((task) => ({ name: 'actor_create', args: { task, tools: [] } }))) }; }
        parentWaiting = true; await gate; return { sse: sseText('LATE-PARENT-REPLY') };
      } });
      try {
        await unlockAndReady(child.page);
        if (!await waitFor(() => evalIn(child.page, `!!document.querySelector('.input-bar textarea')`))) throw new Error('actor composer did not mount');
        await evalIn(child.page, `(() => { 'use strict';
          const input = document.querySelector('.input-bar textarea'); input.value = 'Start three actors, then let me stop them.';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        if (!await waitFor(() => evalIn(child.page, `document.querySelector('.send-btn')?.disabled === false`))) throw new Error('actor composer is not ready');
        await clickAndSyncRedraw(child.page, '.send-btn');
        if (!await waitFor(() => childCalls === 3 && parentWaiting, { budgetMs: 30_000, pollMs: 50 })) throw new Error('three actors did not reach the model');
        const state = await rpc(child.page, { type: 'state/get' });
        const parentId = state?.state?.session?.sessionId;
        if (!parentId) throw new Error('actor parent session is missing');
        if (!await clickAndSyncRedraw(child.page, 'form.input-bar button.stop')) throw new Error('real Stop control is missing');
        const evidence = await waitFor(async () => {
          const audit = await rpc(child.page, { type: 'audit/list', limit: 800 });
          if (!audit?.ok || !Array.isArray(audit.entries)) throw new Error('actor audit read refused');
          const entries = audit.entries.filter((entry) => entry.details?.parentSessionId === parentId);
          const ids = [...new Set(entries.filter((entry) => entry.type === 'actor_spawned').map((entry) => entry.details.actorSessionId))];
          return ids.length === 3 && ids.every((id) => entries.some((entry) => entry.details?.actorSessionId === id
            && ['actor_completed', 'actor_persistence_failed'].includes(entry.type))) ? { ids, entries } : null;
        }, { budgetMs: 20_000, pollMs: 80 });
        if (!evidence) throw new Error('stopped actors did not settle');
        const sessions = await Promise.all(evidence.ids.map(async (sessionId) => {
          const reply = await rpc(child.page, { type: 'session/get', sessionId });
          if (!reply?.ok || !Array.isArray(reply.session?.messages) || reply.session.parentSessionId !== parentId) throw new Error('child transcript read refused');
          return reply.session;
        }));
        const messageIds = sessions.flatMap((session) => session.messages.map((message) => message.id));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base stopped transcripts', { sessions, entries: evidence.entries });
        else rec.check('all three Stop fallbacks persist with six distinct IDs', sessions.every((session) => session.messages.length === 2
          && session.messages[0].content === session.task) && new Set(messageIds).size === 6
          && !evidence.entries.some((entry) => entry.type === 'actor_persistence_failed'), JSON.stringify({ sessions, entries: evidence.entries }));
        release();
        await reloadReadyPanel(child, { expectedSessionId: parentId });
        if (!await waitFor(() => evalIn(child.page, `document.querySelectorAll('.tool-call.tool-actor').length === 3`))) throw new Error('reloaded actor cards are missing');
        await evalIn(child.page, `document.querySelectorAll('.tool-call.tool-actor > .tool-call-header').forEach((button) => button.click())`);
        const readable = sessions.filter((session) => session.messages.length > 0).length;
        if (!await waitFor(() => evalIn(child.page, `document.querySelectorAll('.actor-transcript').length === ${readable}`))) throw new Error('actor transcript cards did not load');
        if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') rec.check('all three saved tasks render after reload', await evalIn(child.page,
          `${JSON.stringify(tasks)}.every((task) => [...document.querySelectorAll('.actor-transcript .bubble')].some((element) => element.textContent.trim() === task
            && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility === 'visible'))`));
        await rec.visualPage('actor-stop-transcripts', child.page);
        await rec.visualPage('actor-stop-reopened-last', child.page, { beforeShot: (page) => evalIn(page,
          `document.querySelectorAll('.tool-call.tool-actor')[2].scrollIntoView({ block: 'end' })`) });
        // why: an async delivery can retry after the panel reload has finished.
        await sleep(1_500);
        rec.check('Stop prevents a later actor wake after the delivery retry interval', childCalls === 3 && child.modelCallCount() === 5);
      } finally { release(); await child.close(); }
    },
  },
  {
    name: 'idle-unlocked', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) { await rec.visual('idle-unlocked'); },
  },
  {
    name: 'web-request-outcome-audit', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const received = [], sockets = new Set();
      const origin = `https://${GIT_FIXTURE_HOST}`;
      const server = createHttpsServer({ cert: GIT_FIXTURE_TLS_CERT, key: GIT_FIXTURE_TLS_KEY }, (request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('error', () => {});
        request.on('end', () => {
          const receipt = { method: request.method, path: request.url, host: request.headers.host,
            tls: request.socket.encrypted === true, body: Buffer.concat(chunks).toString(), header: request.headers['x-proof'] };
          received.push(receipt);
          if (request.url.startsWith('/provider-audit/ok-')) {
            response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('ok');
          } else {
            // why: close the HTTP socket; Bun exposes an inert reset method.
            request.socket.destroy();
          }
        });
      });
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SITE_CLIENT_FIXTURE_TLS_PORT, '127.0.0.1', resolve); });
      let active = null, actorCalls = 0, delegated = false;
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, modelResponder: (_index, request) => {
        if (request.postData.includes('<actor_agent>')) {
          if (actorCalls++ === 0) return { sse: sseToolCall('page_code', { code: `return await page.fetch(${JSON.stringify(active.url)}, ${JSON.stringify(active.init)});` }) };
          return { sse: sseText('RESET-ACTOR-DONE') };
        }
        const wake = JSON.parse(request.postData).messages.some((message) => message.role === 'user'
          && typeof message.content === 'string' && message.content.includes('tool="message_actor"'));
        if (wake) return { sse: sseText('RESET-PARENT-DONE') };
        if (!delegated) { delegated = true; return { sse: sseToolCall('message_actor', { to: 'web', message: 'Make the exact requested fixture request once.' }) }; }
        return { sse: sseText('RESET-PARENT-QUEUED') };
      } }).catch(async (error) => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        throw error;
      });
      let notebook, activity;
      try {
        await unlockAndReady(child.page);
        if (!(await rpc(child.page, { type: 'settings/update', patch: { autoMemoryEnabled: false, webActorActionSurface: 'code' } }))?.ok) throw new Error('request audit settings refused');
        const auditBefore = await rpc(child.page, { type: 'audit/list', limit: 800 });
        if (!auditBefore?.ok || !Array.isArray(auditBefore.entries)) throw new Error('initial request audit refused');
        const priorIds = new Set(auditBefore.entries.map((entry) => entry.id));
        const cases = [];
        const requireNotebookChat = async () => {
          const reply = await rpc(child.page, { type: 'state/get' });
          if (reply?.ok !== true || reply.state?.session?.sessionId !== null) throw new Error('Notebook fixture requires an exact null chat');
        };
        const approveAndWait = async (operation, path, method, pathKind) => {
          let done = false, failure = null, approvals = 0;
          const pending = operation.then((value) => { done = true; return value; }, (error) => { done = true; failure = error; });
          const finished = await waitFor(async () => {
            for (const page of approvals === 0 ? [child.page, notebook].filter(Boolean) : []) {
              const dialog = await evalIn(page, `(() => { 'use strict';
                const button = [...document.querySelectorAll('.confirm-modal button')].find((node) => node.textContent.trim().toLowerCase() === 'allow once' && !node.disabled);
                const modal = button?.closest('.confirm-modal');
                return modal ? { text: modal.textContent, summary: modal.querySelector('.confirm-summary')?.textContent,
                  origin: [...modal.querySelectorAll('p')].map((node) => node.textContent).find((text) => text.startsWith('On: ')) } : null;
              })()`);
              if (dialog) {
                if (pathKind === 'notebook') await requireNotebookChat();
                const host = new URL(origin).host;
                const matchesDestination = pathKind === 'notebook'
                  ? dialog.summary === `Allow the WebVM to send a POST request to ${host}? This can send data out of the browser.`
                    && dialog.origin === `On: ${host}`
                  : dialog.text.includes(origin);
                const beforeApproval = received.filter((entry) => entry.path === path);
                rec.check(`${method} ${path.split('?')[0]} waits for real consent before receipt`, method === 'POST' && approvals === 0
                  && beforeApproval.length === 0 && matchesDestination, JSON.stringify({ pathKind, dialog, beforeApproval }));
                if (method !== 'POST' || approvals || beforeApproval.length || !matchesDestination) throw new Error('request consent boundary did not hold');
                await evalIn(page, `[...document.querySelectorAll('.confirm-modal button')].find((node) => node.textContent.trim().toLowerCase() === 'allow once' && !node.disabled).click()`);
                approvals += 1;
                break;
              }
            }
            return done && (await Promise.all([child.page, notebook].filter(Boolean).map((page) =>
              evalIn(page, `!document.querySelector('.confirm-modal')`)))).every(Boolean);
          }, { budgetMs: 45_000, pollMs: 80 });
          if (!finished) throw new Error('real request did not settle');
          await pending;
          if (failure) throw failure;
          rec.check(`${method} uses its normal consent rule`, approvals === (method === 'POST' ? 1 : 0));
        };
        for (const pathKind of ['web', 'notebook']) {
          if (pathKind === 'notebook') {
            await resetSession(child);
            await requireNotebookChat();
            notebook = await openWidePage(child, 'engine-tabs/notebook-tab/index.html#provider-audit-notebook', { ready: '#notebook-app:not([hidden])' });
          }
          const command = (message) => evalIn(child.swConn, `(async () => {
            const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.endsWith('#provider-audit-notebook'));
            if (!tab?.id) throw new Error('real Notebook tab is missing');
            return chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ notebookId: 'provider-audit-notebook', ...message })});
          })()`, true);
          if (pathKind === 'notebook' && !await waitFor(async () => (await command({ type: 'js/list-files' }))?.ok === true)) throw new Error('Notebook command host did not become ready');
          for (const kind of ['ok', 'reset-get', 'reset-post']) {
            const method = kind === 'reset-post' ? 'POST' : 'GET';
            const path = `/provider-audit/${kind}-${pathKind}?private=query-canary`;
            const init = { method, headers: { 'x-proof': 'header-canary' }, ...(method === 'POST' ? { body: 'body-canary' } : {}) };
            active = { url: origin + path, init }; actorCalls = 0; delegated = false;
            let operation;
            if (pathKind === 'web') {
              await resetSession(child);
              operation = (async () => {
                const sent = await rpc(child.page, { type: 'agent/send', text: `Make one ${method} request to the test fixture.` });
                if (!sent?.ok) throw new Error('real web request send refused');
                if (!await waitFor(() => evalIn(child.page, `document.body.textContent.includes('RESET-PARENT-DONE') && !document.querySelector('form.input-bar button.stop')`), { budgetMs: 40_000, pollMs: 80 })) throw new Error('web actor did not return its terminal report');
              })();
            } else {
              await requireNotebookChat();
              operation = command({ type: 'js/eval', timeoutMs: 40_000,
                code: `try { const response = await peerd.egress.fetch(${JSON.stringify(active.url)}, ${JSON.stringify(init)}); return { ok: response.ok, status: response.status }; }
                  catch (error) { return { unknown: true, name: error.name }; }` }).then((result) => {
                const value = result?.result?.value;
                if (!result?.ok || !value || (kind === 'ok' ? value.ok !== true || value.status !== 200 : value.unknown !== true)) throw new Error('Notebook eval did not return its real request outcome');
              });
            }
            await approveAndWait(operation, path, method, pathKind);
            const receipts = received.filter((entry) => entry.path === path);
            rec.check(`${pathKind} ${kind} reaches the real HTTPS server with the full request`, receipts.length >= 1
              && receipts.every((entry) => entry.tls === true && entry.host === new URL(origin).host
                && entry.method === method && entry.header === 'header-canary'
                && entry.body === (method === 'POST' ? 'body-canary' : '')), JSON.stringify(receipts));
            cases.push({ pathKind, kind, method, path: path.split('?')[0] });
          }
        }
        const entries = await waitFor(async () => {
          const audit = await rpc(child.page, { type: 'audit/list', limit: 800 });
          if (!audit?.ok || !Array.isArray(audit.entries)) throw new Error('settled request audit refused');
          const rows = audit.entries.filter((entry) => !priorIds.has(entry.id) && entry.type === 'web_fetch' && entry.details?.origin === origin);
          return process.env.PEERD_VISUAL_BASE_RENDER === '1' || rows.length >= cases.length ? rows : null;
        });
        if (!entries) throw new Error('request audit rows did not settle');
        rec.observe('actual HTTPS receipt and audit evidence', { received, entries });
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base unaudited reset requests', cases);
        else rec.check('every received request has one safe method and path outcome row', cases.every((item) => {
          const rows = entries.filter((entry) => entry.details.path === item.path);
          return rows.length === 1 && rows[0].details.method === item.method
            && (item.kind === 'ok' ? rows[0].details.outcome === undefined : rows[0].details.outcome === 'unknown');
        }) && !['query-canary', 'body-canary', 'header-canary'].some((value) => JSON.stringify(entries).includes(value)));
        activity = await openWidePage(child, 'options/options.html#!/activity');
        if (!await waitFor(() => evalIn(activity, `!!document.querySelector('.log-filter-level')`))) throw new Error('real Activity did not load');
        await evalIn(activity, `(() => { 'use strict'; const input = document.querySelector('.log-filter-query');
          input.value = ${JSON.stringify(origin)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await rec.visualPage('web-request-audit-all', activity);
        await evalIn(activity, `(() => { 'use strict'; const select = document.querySelector('.log-filter-level');
          select.value = 'warn'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
          const visible = await waitFor(() => evalIn(activity, `[...document.querySelectorAll('.log-row')].filter((row) => row.querySelector('.log-label')?.textContent === 'web request').length === 4`));
          rec.check('real Activity Issues names all four unknown GET and POST destinations', visible === true
            && await evalIn(activity, `[...document.querySelectorAll('.log-row')].filter((row) => row.querySelector('.log-label')?.textContent === 'web request').every((row) => row.textContent.includes('unknown') && /GET|POST/.test(row.textContent))`));
        }
        rec.check('Activity displays no private request bytes', await evalIn(activity, `!['query-canary', 'body-canary', 'header-canary'].some((value) => document.body.textContent.includes(value))`));
        await rec.visualPage('web-request-outcome-audit', activity);
      } finally {
        if (activity) await activity.close(); if (notebook) await notebook.close(); await child.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  },

  {
    name: 'spend-limit-admission', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('The first model reply crosses the spend limit.') }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const initial = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings;
      if (!initial?.providerModel) throw new Error('the current model is unavailable');
      const pricingOverrides = { ...initial.pricingOverrides,
        [initial.providerModel]: { input: 1_000_000, output: 1_000_000 } };
      const settings = await openWidePage(ctx, 'options/options.html#!/costs', {
        ready: 'input[aria-label="Session spend limit in US dollars"]',
      });
      const view = () => evalIn(ctx.page, `(async () => {
        'use strict';
        (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
        return { banner: document.querySelector('.error-banner')?.innerText ?? '',
          settings: !!document.querySelector('.error-banner button'),
          halted: !!document.querySelector('.cost-chip--halt'),
          unknown: document.body.innerText.includes('Turn outcome unknown'),
          busy: !!document.querySelector('form.input-bar button.stop, .message-assistant.streaming') };
      })()`, true);
      const send = async (text) => {
        const before = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.messages?.length ?? 0;
        await ctx.page.send('Page.bringToFront');
        await evalIn(ctx.page, `(() => {
          'use strict';
          const input = document.querySelector('form.input-bar textarea');
          if (!input || input.disabled) throw new Error('composer is unavailable');
          input.focus(); input.select();
        })()`);
        await ctx.page.send('Input.insertText', { text });
        if (!await waitFor(() => evalIn(ctx.page,
          `!!document.querySelector('form.input-bar button.send-btn:not(:disabled)')`), { budgetMs: 5_000 })
          || !await clickAndSyncRedraw(ctx.page, 'form.input-bar button.send-btn')) throw new Error('composer send is unavailable');
        const state = await waitFor(async () => {
          const next = (await rpc(ctx.page, { type: 'state/get' }))?.state;
          const messages = next?.session?.messages ?? [];
          return messages.length >= before + 2 && messages.at(-1)?.role === 'assistant'
            && messages.at(-1)?.streaming !== true && !(await view()).busy ? next : null;
        }, { budgetMs: 30_000, pollMs: 50 });
        if (!state) throw new Error('the real send did not settle with a durable reply');
        return state;
      };
      const checkKnownHalt = async (name, state) => {
        const rendered = await view();
        if (baseRender) rec.observe(`merge-base ${name}`, { rendered, cost: state.session.cost,
          messages: state.session.messages.map(({ role, stopReason, errorCode, outcomeKnown }) => ({ role, stopReason, errorCode, outcomeKnown })) });
        else {
          rec.check(`${name} keeps the spend notice and Settings action`, rendered.banner.includes('Spend limit reached')
            && rendered.settings && rendered.halted && !rendered.busy, JSON.stringify(rendered));
          rec.check(`${name} stays known`, !rendered.unknown && state.session.messages.every((message) =>
            message.outcomeKnown !== false && !message.error), JSON.stringify(state.session.messages.at(-1)));
        }
      };
      const readAudit = async () => {
        const reply = await rpc(ctx.page, { type: 'audit/list', limit: 800 });
        if (reply?.ok !== true || !Array.isArray(reply.entries)) throw new Error('the tool audit is unavailable');
        return reply.entries;
      };
      let pendingTool = false;
      ctx.setModelResponder(() => ({ sse: pendingTool
        ? sseToolCall('script', { code: 'return 6 * 7;' }, { text: 'The spend halt must stop this pending computation.' })
        : sseText('The first model reply crosses the spend limit.') }));
      try {
        const updated = await rpc(settings, { type: 'settings/update', patch: { pricingOverrides } });
        if (updated?.ok !== true) throw new Error('the fixture rate did not save');
        await evalIn(settings, `(() => {
          'use strict';
          const input = document.querySelector('input[aria-label="Session spend limit in US dollars"]');
          input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        if (!await waitFor(async () => (await rpc(settings, { type: 'state/get' }))?.state?.settings?.spendLimitUsd === 1,
          { budgetMs: 10_000 })) throw new Error('the real Settings cap did not save');
        const totalBefore = await rpc(ctx.page, { type: 'cost/total' });
        const first = await send('Answer once, then honor this chat spend limit.');
        rec.check('one admitted model call records the fixture price in the real ledger',
          ctx.modelCallCount() === 1 && first.session.cost?.cost === 3, JSON.stringify(first.session.cost));
        await checkKnownHalt('the settled crossing', first);
        await rec.visual('spend-limit-admission');
        for (const text of ['Try this chat again.', 'Check the same limit once more.']) {
          const priorCalls = ctx.modelCallCount(), priorCost = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.cost?.cost;
          const refused = await send(text);
          if (baseRender) rec.observe('merge-base repeated send', { calls: ctx.modelCallCount() - priorCalls,
            priorCost, cost: refused.session.cost?.cost });
          else {
            rec.check('an over-cap composer send makes no extra model call or ledger charge',
              ctx.modelCallCount() === priorCalls && refused.session.cost?.cost === priorCost);
            rec.check('the refused message has a durable factual reply', refused.session.messages.at(-2)?.content === text
              && refused.session.messages.at(-1)?.content.includes('This message was not sent to the model.'));
          }
          await checkKnownHalt('the settled refusal', refused);
        }
        const totalAfter = await rpc(ctx.page, { type: 'cost/total' });
        if (!baseRender) rec.check('the aggregate real ledger also keeps only one fixture charge',
          totalBefore?.ok && totalAfter?.ok && totalAfter.usd - totalBefore.usd === 3, JSON.stringify({ totalBefore, totalAfter }));
        await rec.visual('spend-limit-refused-send');
        await resetSession(ctx);
        pendingTool = true;
        const callsBefore = ctx.modelCallCount();
        const auditsBefore = new Set((await readAudit()).map((entry) => entry.id));
        const stopped = await send('Start a fresh chat and stop before its pending computation.');
        rec.check('a fresh chat still admits one model call', ctx.modelCallCount() === callsBefore + 1 && stopped.session.cost?.cost === 3);
        const toolEffects = (await readAudit()).filter((entry) => !auditsBefore.has(entry.id)
          && entry.type === 'tool_executed' && entry.details?.tool === 'script');
        rec.check('usage-time halt never dispatches the pending computation', toolEffects.length === 0
          && !stopped.session.messages.some((message) => message.toolResults?.length), JSON.stringify(toolEffects));
        await checkKnownHalt('the pending-tool halt', stopped);
        if (!baseRender) rec.check('the usage-time halt is a known aborted assistant',
          stopped.session.messages.at(-1)?.stopReason === 'aborted');
        await rec.visual('spend-limit-pending-tool');
      } finally {
        await rpc(ctx.page, { type: 'agent/stop' });
        const restored = await rpc(settings, { type: 'settings/update', patch: {
          spendLimitUsd: initial.spendLimitUsd ?? 0, pricingOverrides: initial.pricingOverrides ?? {},
        } });
        await settings.close();
        if (restored?.ok !== true) throw new Error('the original cost settings did not restore');
      }
    },
  },

  // --- visual: local send follows while another reader keeps its place -------
  {
    name: 'own-send-scroll', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText(Array.from({ length: 10 }, (_, index) =>
      `History paragraph ${index + 1}. Keep this earlier context available while reading.`).join('\n\n')) }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const ownText = 'Send from this reading surface.';
      const delayedReply = 'The delayed reply arrived. Keep the earlier reading position.';
      let other, waiting = false, complete = false, releaseReply = () => {};
      const view = (page) => evalIn(page, `(async () => {
        'use strict';
        (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
        const list = document.querySelector('.message-list');
        if (!list) return null;
        const bubble = [...list.querySelectorAll('.message-user .bubble')].at(-1);
        const bounds = list.getBoundingClientRect(), message = bubble?.getBoundingClientRect();
        return { user: bubble?.textContent, top: list.scrollTop,
          bottom: list.scrollHeight - list.scrollTop - list.clientHeight,
          overflow: list.scrollHeight - list.clientHeight,
          visible: !!message && message.top >= bounds.top - 1 && message.bottom <= bounds.bottom + 1,
          reply: [...list.querySelectorAll('.message-assistant .bubble')].at(-1)?.textContent,
          busy: !!list.querySelector('.message-assistant.streaming') || !!document.querySelector('form.input-bar button.stop'),
        };
      })()`, true);
      const submit = async (page, text) => {
        await page.send('Page.bringToFront');
        await evalIn(page, `(() => {
          'use strict';
          const input = document.querySelector('form.input-bar textarea');
          if (!input || input.disabled) throw new Error('composer is unavailable');
          input.focus(); input.select();
        })()`);
        await page.send('Input.insertText', { text });
        const enabled = await waitFor(() => evalIn(page,
          `!!document.querySelector('form.input-bar button.send-btn:not(:disabled)')`), { budgetMs: 5_000 });
        if (!enabled || !await clickAndSyncRedraw(page, 'form.input-bar button.send-btn')) throw new Error('composer send is unavailable');
      };
      const settled = async (page, text, reply) => {
        const ready = await waitFor(async () => {
          const state = await view(page);
          return state?.user === text && state.reply?.includes(reply) && !state.busy;
        }, { budgetMs: 20_000, pollMs: 50 });
        if (!ready) throw new Error(`scroll turn did not settle: ${text}`);
      };
      const readFromTop = async (page) => {
        await page.send('Page.bringToFront');
        await evalIn(page, `new Promise((resolve, reject) => {
          'use strict';
          const list = document.querySelector('.message-list');
          if (!list || list.scrollHeight - list.clientHeight <= 300) throw new Error('history does not overflow');
          let timer;
          const moved = () => {
            if (list.scrollTop !== 0) { list.scrollTop = 0; return; }
            clearTimeout(timer); list.removeEventListener('scroll', moved); resolve(true);
          };
          timer = setTimeout(() => { list.removeEventListener('scroll', moved); reject(new Error('native reader scroll did not arrive')); }, 3_000);
          list.addEventListener('scroll', moved);
          list.scrollTop = list.scrollTop === 0 ? list.scrollHeight : 0;
        })`, true);
      };
      try {
        for (const index of [1, 2]) {
          const text = `Keep earlier turn ${index} in this chat.`;
          await submit(ctx.page, text);
          await settled(ctx.page, text, 'History paragraph 10.');
        }
        rec.check('reading history comes from two real composer turns', ctx.modelCallCount() === 2);
        other = await openWidePage(ctx, 'sidepanel/sidepanel.html', { metrics: PANEL_METRICS, ready: '.message-list' });
        await settled(other, 'Keep earlier turn 2 in this chat.', 'History paragraph 10.');
        const { targetInfo } = await other.send('Target.getTargetInfo');
        rec.observe('second real side-panel document', { targetId: targetInfo.targetId, url: await evalIn(other, 'location.href') });
        await readFromTop(ctx.page);
        await readFromTop(other);
        ctx.setModelResponder(async () => {
          await new Promise((resolve) => { releaseReply = resolve; waiting = true; });
          waiting = false;
          return { sse: sseText(delayedReply) };
        });
        await submit(ctx.page, ownText);
        const started = await waitFor(async () => {
          const [own, foreign] = await Promise.all([view(ctx.page), view(other)]);
          return waiting && ctx.modelCallCount() === 1 && own?.user === ownText
            && foreign?.user === ownText && own.busy && foreign.busy;
        }, { budgetMs: 20_000, pollMs: 50 });
        if (!started) throw new Error('delayed model request did not reach both real surfaces');
        await rec.visualPage('own-send-scroll', ctx.page, { beforeShot: async (_page, theme) => {
          const [own, foreign] = await Promise.all([view(ctx.page), view(other)]);
          rec.check(`foreign send keeps the reader in place (${theme})`, foreign?.top === 0, JSON.stringify(foreign));
          if (baseRender) rec.observe(`merge-base own-send position (${theme})`, own);
          else rec.check(`own send keeps its bubble visible (${theme})`, own?.bottom < 2 && own.visible, JSON.stringify(own));
        } });
        await readFromTop(ctx.page);
        const [reading, otherReading] = await Promise.all([view(ctx.page), view(other)]);
        rec.check('a reader can leave the live edge during a real delayed model call',
          waiting && reading?.busy && otherReading?.busy && reading.top === 0 && otherReading.top === 0);
        releaseReply();
        await settled(ctx.page, ownText, delayedReply);
        await settled(other, ownText, delayedReply);
        complete = true;
        await rec.visualPage('own-send-scroll-reader', ctx.page, { beforeShot: async (_page, theme) => {
          const [own, foreign] = await Promise.all([view(ctx.page), view(other)]);
          rec.check(`reply and settlement keep both readers in place (${theme})`,
            own?.top === 0 && foreign?.top === 0 && !own.busy && !foreign.busy, JSON.stringify({ own, foreign }));
        } });
      } finally {
        releaseReply();
        if (!complete) await rpc(ctx.page, { type: 'agent/stop' });
        if (other) await other.close();
        await setEmulatedTheme(ctx.page, 'light');
      }
    },
  },

  {
    name: 'actors-stop-hydration', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('This chat is idle.') }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const held = [], requests = [];
      let owner = null;
      const view = () => evalIn(ctx.page, `(async () => {
        'use strict';
        (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
        return { user: [...document.querySelectorAll('.message-user .bubble')].at(-1)?.textContent,
          stop: !!document.querySelector('form.input-bar button.stop'),
          streaming: !!document.querySelector('.message-assistant.streaming'), text: document.body.innerText };
      })()`, true);
      const checkStop = async (name, expected) => {
        if (!baseRender) await waitFor(async () => (await view())?.stop === expected,
          { budgetMs: 5_000, pollMs: 50 });
        const current = await view();
        if (baseRender) rec.observe(`merge-base ${name}`, current);
        else rec.check(name, current?.stop === expected, JSON.stringify(current));
      };
      const switchTo = async (sessionId, text) => {
        const reply = await rpc(ctx.page, { type: 'session/switch', sessionId });
        if (!reply?.ok || !await waitFor(async () => (await view())?.user === text,
          { budgetMs: 10_000, pollMs: 50 })) throw new Error('chat switch did not mount its owner');
      };
      try {
        await submitActorStopMessage(ctx.page, 'Keep this chat idle.');
        if (!await waitFor(async () => (await view())?.text.includes('This chat is idle.') && !(await view())?.streaming,
          { budgetMs: 20_000 })) throw new Error('idle chat did not settle');
        const idle = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId;
        await resetSession(ctx);
        ctx.setModelResponder(async (_index, request) => {
          requests.push(request.postData);
          await new Promise((resolve) => held.push(resolve));
          return { sse: sseText('A stopped response must not appear.') };
        });
        await submitActorStopMessage(ctx.page, 'Wait for this model reply.');
        if (!await waitFor(async () => held.length === 1 && (await view())?.stop,
          { budgetMs: 20_000 })) throw new Error('the real model request did not start');
        owner = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId;
        const priorDocument = await evalIn(ctx.page, 'performance.timeOrigin');
        await reloadReadyPanel(ctx, { expectedSessionId: owner });
        rec.check('reload mounts a new document while the real request remains pending',
          priorDocument !== await evalIn(ctx.page, 'performance.timeOrigin') && held.length === 1 && (await view())?.streaming);
        await checkStop('the reopened owner keeps its Stop', true);
        await rec.visualPage('actors-stop-hydration', ctx.page, { beforeShot: () => checkStop('reopened Stop survives each theme', true) });
        await switchTo(idle, 'Keep this chat idle.');
        await checkStop('an idle chat has no Stop from another owner', false);
        await rec.visualPage('actors-stop-idle-chat', ctx.page, { beforeShot: () => checkStop('idle Stop stays absent in each theme', false) });
        await switchTo(owner, 'Wait for this model reply.');
        await checkStop('switching back restores the live owner Stop', true);
        await submitActorStopMessage(ctx.page, 'Steer this pending reply.');
        if (!await waitFor(() => held.length === 2, { budgetMs: 20_000 })) throw new Error('steer did not reach the model');
        held[0]();
        const superseded = await waitFor(async () => {
          const state = (await rpc(ctx.page, { type: 'state/get' }))?.state;
          return state?.session?.messages?.some((message) => message.stopReason === 'aborted')
            && state.session.messages.at(-1)?.streaming === true;
        }, { budgetMs: 15_000, pollMs: 50 });
        rec.check('a real steer settles the old turn while its replacement stays live', !!superseded && requests.length === 2);
        await checkStop('old settlement does not hide the replacement Stop', true);
        await rec.visualPage('actors-stop-steered', ctx.page, { beforeShot: () => checkStop('steered Stop survives each theme', true) });
        if ((await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId !== owner) throw new Error('Stop has the wrong chat owner');
        if (await evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`)) {
          await clickAndSyncRedraw(ctx.page, 'form.input-bar button.stop');
        } else if (baseRender) await rpc(ctx.page, { type: 'agent/stop' });
        else throw new Error('the replacement turn has no Stop');
        held[1]();
        if (!await waitFor(async () => !(await view())?.streaming, { budgetMs: 15_000 })) throw new Error('Stop did not settle the owner');
        rec.check('Stop never renders either held reply', !(await view())?.text.includes('A stopped response must not appear.'));
        await reloadReadyPanel(ctx, { expectedSessionId: owner });
        rec.check('the finished owner reloads without a dead Stop', (await view())?.stop === false);
      } finally {
        if (owner) {
          await rpc(ctx.page, { type: 'session/switch', sessionId: owner });
          await rpc(ctx.page, { type: 'agent/stop' });
        }
        for (const release of held) release();
        await setEmulatedTheme(ctx.page, 'light');
        await clearActorStopDraft(ctx.page, ['Keep this chat idle.', 'Wait for this model reply.', 'Steer this pending reply.']);
      }
    },
  },
  {
    name: 'actors-incomplete-reply', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('Ready.') }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      let spawned = 0, childCalls = 0, wakeCalls = 0, scriptResult = '';
      const prior = new Set((await auditEntries(ctx)).map((entry) => entry.id));
      ctx.setModelResponder((_index, request) => {
        const body = request.postData ?? '';
        if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
          childCalls++;
          if (childCalls === 1) return { sse: sseToolCall('script', { code: 'return 6 * 7;' }) };
          scriptResult = toolResultsIn(body).at(-1) ?? '';
          return { sse: sseText('') };
        }
        if (body.includes('An actor you started earlier')) {
          wakeCalls++;
          return { sse: sseText('The child ended without a final reply. Check its saved computation before retrying.') };
        }
        if (!spawned++) return { sse: sseToolCall('actor_create', {
          task: 'Compute six times seven, then end without reply text.', tools: ['script'], sync: false,
        }) };
        return { sse: sseText('The isolated computation is running.') };
      });
      try {
        await submitActorStopMessage(ctx.page, 'Delegate one computation and preserve its terminal report.');
        const owner = await waitFor(async () => (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId,
          { budgetMs: 10_000 });
        const completed = await waitFor(async () => (await auditEntries(ctx)).find((entry) =>
          !prior.has(entry.id) && entry.type === 'actor_completed'), { budgetMs: 30_000, pollMs: 100 });
        if (!completed) throw new Error('the real child did not complete');
        if (!baseRender && !await waitFor(() => evalIn(ctx.page,
          `!!document.querySelector('.message-actor-reply.failed') && document.body.innerText.includes('Check its saved transcript before retrying.')`),
        { budgetMs: 20_000, pollMs: 50 })) throw new Error('the child terminal report did not render');
        if (!await waitFor(() => evalIn(ctx.page,
          `!document.querySelector('.message-assistant.streaming') && !document.querySelector('form.input-bar button.stop')`),
        { budgetMs: 15_000, pollMs: 50 })) {
          rec.observe('unsettled terminal report', { spawned, childCalls, wakeCalls,
            view: await evalIn(ctx.page, 'document.body.innerText'),
            bundle: (await rpc(ctx.page, { type: 'session/debugBundle', sessionId: owner }))?.bundle });
          throw new Error('the terminal report did not settle');
        }
        const bundle = (await rpc(ctx.page, { type: 'session/debugBundle', sessionId: owner }))?.bundle;
        const child = bundle?.childSessions?.find((session) => session.kind === 'spawned');
        const parentCall = bundle?.session?.messages?.flatMap((message) => message.toolUses ?? [])
          .find((call) => call.name === 'actor_create');
        const replies = bundle?.session?.messages?.filter((message) => message.actorReply) ?? [];
        const scripts = (await auditEntries(ctx)).filter((entry) => !prior.has(entry.id)
          && entry.type === 'tool_executed' && entry.details?.tool === 'script');
        rec.check('the real child ran one computation and made two model calls', childCalls === 2 && scripts.length === 1 && scriptResult.includes('42'));
        rec.check('the child transcript retains its exact computation call and result',
          child?.messages?.some((message) => message.toolUses?.some((call) => call.name === 'script'))
          && child.messages.some((message) => message.toolResults?.length === 1));
        if (baseRender) rec.observe('merge-base incomplete delivery', { wakeCalls, replies, completion: completed.details });
        else {
          rec.check('the incomplete child wakes its exact parent once', wakeCalls === 1 && replies.length === 1 && typeof parentCall?.id === 'string'
            && replies[0].actorReply.failed === true && replies[0].actorReply.parentToolUseId === parentCall?.id
            && replies[0].id === replies[0].actorReply.actorDeliveryId);
          rec.check('the parent receives a bounded factual report with no false Stop claim',
            replies[0].content.length < 2_000 && !replies[0].content.includes('stopped before it produced a reply'));
        }
        await rec.visual('actors-incomplete-reply');
      } finally {
        await rpc(ctx.page, { type: 'agent/stop' });
        await clearActorStopDraft(ctx.page, ['Delegate one computation and preserve its terminal report.']);
      }
    },
  },
  {
    name: 'actor-cold-surfaces', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const observer = `(() => {
        'use strict';
        const evidence = globalThis.__actorColdEvidence = { states: [], requests: [] };
        const runtime = chrome.runtime;
        const connect = runtime.connect.bind(runtime), sendMessage = runtime.sendMessage.bind(runtime);
        runtime.connect = (...args) => {
          const port = connect(...args);
          port.onMessage.addListener((message) => {
            if (message?.type === 'state') evidence.states.push({
              capability: message.state?.capabilities?.actorExecution,
              projection: message.state?.projection,
            });
          });
          return port;
        };
        runtime.sendMessage = (...args) => {
          const message = args.find((value) => value && typeof value.type === 'string');
          if (message) evidence.requests.push(message.type);
          return sendMessage(...args);
        };
      })()`;
      for (const surface of ['home', 'sidepanel']) {
        let mainCalls = 0, childCalls = 0;
        const fresh = await launchPeerd({ extensionDir: ctx.extensionDir,
          panelPath: surface === 'home' ? 'home/home.html#chat' : 'sidepanel/sidepanel.html',
          beforePanelNavigate: (page) => page.send('Page.addScriptToEvaluateOnNewDocument', { source: observer }),
          modelResponder: (_index, request) => {
            if (request.postData?.includes('<actor_agent>')) {
              childCalls++; return { sse: sseText('The isolated cold-start computation is complete.') };
            }
            if (mainCalls++ === 0) return { sse: sseToolCall('actor_create', {
              task: 'Compute six times seven without tools and report the result.', tools: [], sync: true,
            }) };
            return { sse: sseText('The first isolated actor is ready.') };
          },
        });
        let options;
        try {
          const untouched = await rpc(fresh.page, { type: 'state/get' });
          rec.check(`${surface} starts with a real fresh locked vault`, untouched?.ok
            && untouched.state?.vault?.initialized === false && untouched.state.vault.locked === true);
          const untouchedActor = untouched?.state?.capabilities?.actorExecution;
          if (baseRender) rec.observe(`merge-base fresh locked ${surface} actor health`, untouchedActor);
          else rec.check(`${surface} fresh locked state has exact neutral actor health`, untouchedActor?.status === 'not-started'
            && untouchedActor.host === 'offscreen-document-worker' && untouchedActor.reason === null
            && untouchedActor.retryable === false, JSON.stringify(untouchedActor));
          const untouchedLease = await rpc(fresh.page, { type: 'bootstrap/ready' });
          rec.check(`${surface} fresh locked state read keeps the controller revoked`, untouchedLease?.ok
            && untouchedLease.featureLeases?.schema === 1
            && untouchedLease.featureLeases.leases?.controller?.status === 'revoked', JSON.stringify(untouchedLease?.featureLeases));
          await unlockAndReady(fresh.page);
          if (surface === 'home') {
            if (!await waitFor(() => evalIn(fresh.page, `!!document.querySelector('[data-network-choice="skip"]')`),
              { budgetMs: 15_000, pollMs: 50 })) throw new Error('fresh Home did not offer its real network choice');
            if (!await clickAndSyncRedraw(fresh.page, '[data-network-choice="skip"]')) throw new Error('Not now did not accept the real choice');
            rec.check('fresh Home records the explicit network-off choice',
              (await rpc(fresh.page, { type: 'state/get' }))?.state?.settings?.dwebEnabled === false);
          }
          await freezeAnimations(fresh);
          await fresh.page.send('Emulation.setDeviceMetricsOverride', surface === 'home'
            ? { width: 960, height: 900, deviceScaleFactor: 1, mobile: false } : PANEL_METRICS);
          const ready = await waitFor(() => evalIn(fresh.page,
            `document.querySelectorAll('.path-card[data-path]').length > 1`), { budgetMs: 20_000, pollMs: 50 });
          if (!ready) throw new Error(`${surface} did not mount its real starter cards`);
          const cold = (await rpc(fresh.page, { type: 'state/get' }))?.state?.capabilities?.actorExecution;
          // why: provider projection can verify the host before the first unlocked state is published.
          const safeHealth = ['not-started', 'available'].includes(cold?.status)
            && cold.host === 'offscreen-document-worker' && cold.reason === null && cold.retryable === false;
          const lease = await rpc(fresh.page, { type: 'bootstrap/ready' });
          const controls = await evalIn(fresh.page, `(() => ({
            banner: !!document.querySelector('.actor-isolation-banner'),
            cards: [...document.querySelectorAll('.path-card[data-path]')].map((button) => ({
              kind: button.dataset.path, disabled: button.disabled,
            })),
          }))()`);
          if (baseRender) rec.observe(`merge-base cold ${surface}`, { cold, controls, leases: lease?.featureLeases });
          else {
            rec.check(`${surface} has exact safe actor health`, safeHealth, JSON.stringify(cold));
            rec.check(`${surface} has enabled starters and no false pause`, !controls.banner
              && controls.cards.length > 1 && controls.cards.every((card) => !card.disabled), JSON.stringify(controls));
          }
          const leases = lease?.featureLeases;
          const validLeases = lease?.ok === true && leases?.schema === 1 && leases.leases !== null
            && typeof leases.leases === 'object' && !Array.isArray(leases.leases)
            && ['buildId', 'bootId', 'kernelEpoch'].every((key) => typeof leases[key] === 'string' && leases[key].length > 0);
          const coldAudit = await rpc(fresh.page, { type: 'audit/list', limit: 100 });
          rec.check(`${surface} cold setup starts no actor or model inference`, validLeases && (baseRender || safeHealth)
            && fresh.modelCallCount() === 0 && coldAudit?.ok && Array.isArray(coldAudit.entries)
            && !coldAudit.entries.some((entry) => ['actor_ran_isolated', 'actor_background_turn_refused', 'actor_completed'].includes(entry.type)),
          JSON.stringify({ cold, lease, calls: fresh.modelCallCount(), audit: coldAudit }));
          // why: unlocked provider projection uses the controller before actor work starts.
          rec.observe(`${surface} provider readiness lease after unlock`, { before: untouchedLease?.featureLeases, after: leases });
          await rec.visualPage(surface === 'home' ? 'actor-cold-surfaces' : `actor-cold-${surface}`, fresh.page);
          if (surface === 'home') {
            const before = await evalIn(fresh.page, 'globalThis.__actorColdEvidence.states.length');
            options = await openWidePage(fresh, 'options/options.html#!/providers', { ready: '#runner-model' });
            await evalIn(options, `document.querySelector('#runner-model').scrollIntoView({ block: 'center' })`);
            const hint = await evalIn(options, `document.querySelector('#runner-model-status')?.textContent ?? null`);
            if (baseRender) rec.observe('merge-base cold Providers hint', hint);
            else rec.check('cold Providers has no false paused hint', hint === null, String(hint));
            rec.check('real Providers inventory makes no model inference', fresh.modelCallCount() === 0);
            await rec.visualPage('actor-cold-providers', options);
            const published = await waitFor(() => evalIn(fresh.page,
              `globalThis.__actorColdEvidence.states.slice(${before}).find((entry) => entry.capability?.status === 'available')`),
            { budgetMs: 15_000, pollMs: 50 });
            if (baseRender) rec.observe('merge-base inventory publication push', published ?? null);
            else rec.check('live inventory publication pushes health to Home without a diagnostic state read',
              published?.capability?.status === 'available' && published.capability.reason === null);
          } else {
            const before = await evalIn(fresh.page, `({ states: globalThis.__actorColdEvidence.states.length,
              reads: globalThis.__actorColdEvidence.requests.filter((type) => type === 'state/get').length })`);
            await evalIn(fresh.page, `(() => {
              'use strict'; const input = document.querySelector('form.input-bar textarea'); input.focus(); input.select();
            })()`);
            await fresh.page.send('Input.insertText', { text: 'Start one isolated actor for this cold chat.' });
            if (!await waitFor(() => evalIn(fresh.page, `!!document.querySelector('button.send-btn:not(:disabled)')`),
              { budgetMs: 5_000 }) || !await clickAndSyncRedraw(fresh.page, 'button.send-btn')) throw new Error('the cold composer did not send');
            const finished = await waitFor(() => evalIn(fresh.page,
              `document.body.innerText.includes('The first isolated actor is ready.') && !document.querySelector('form.input-bar button.stop')`),
            { budgetMs: 30_000, pollMs: 50 });
            if (!finished) throw new Error('the first real actor did not settle');
            const pushed = await evalIn(fresh.page, `({ states: globalThis.__actorColdEvidence.states.slice(${before.states}),
              reads: globalThis.__actorColdEvidence.requests.filter((type) => type === 'state/get').length,
              banner: !!document.querySelector('.actor-isolation-banner') })`);
            const audit = await rpc(fresh.page, { type: 'audit/list', limit: 100 });
            rec.check('the real first actor uses one verified dedicated worker', childCalls === 1 && fresh.modelCallCount() === 3
              && audit?.ok && audit.entries?.some((entry) => entry.type === 'actor_ran_isolated'
                && entry.details?.workerType === 'dedicated' && entry.details?.realmVerified === true));
            rec.check('the first-use observation adds no state/get artifact', pushed.reads === before.reads, JSON.stringify(pushed));
            if (baseRender) rec.observe('merge-base first-use publication', pushed);
            else rec.check('live first-use publication clears the cold value and false pause',
              pushed.states.some((entry) => entry.capability?.status === 'available') && !pushed.banner, JSON.stringify(pushed));
            await rec.visualPage('actor-cold-first-use', fresh.page);
          }
        } finally { if (options) await options.close(); await fresh.close(); }
      }
    },
  },

  {
    name: 'backup-network-policy', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const evidence = { schema: 1, phase: 'fresh', events: [], observerErrors: [] };
      const diagnostic = createConsentDiagnostics(evidence, () => {});
      const fresh = await launchPeerd({ extensionDir: ctx.extensionDir, panelPath: 'home/home.html', resumeAuxiliaryWorkers: false });
      const directory = await mkdtemp(join(tmpdir(), 'peerd-backup-policy-'));
      let observer;
      const click = async (selector) => {
        if (!await waitFor(() => evalIn(fresh.page, `!!document.querySelector(${JSON.stringify(selector)})`),
          { budgetMs: 20_000 }) || !await clickAndSyncRedraw(fresh.page, selector)) throw new Error(`missing real control ${selector}`);
      };
      const exportBackup = async (mode, expectedDid = null) => {
        evidence.phase = mode;
        const start = { events: evidence.events.length,
          hosts: await evalIn(fresh.swConn, 'globalThis.__backupHostCalls.length'),
          closes: await evalIn(fresh.swConn, 'globalThis.__backupHostCloses.length') };
        // Read-only lease posture separates export demand from host recovery.
        rec.observe(`backup lease posture before ${mode}`,
          (await rpc(fresh.page, { type: 'bootstrap/ready' }))?.featureLeases);
        const destination = await mkdtemp(join(directory, `${mode}-`));
        let page;
        const exceptions = [];
        const endpoint = await (await fetch(`http://127.0.0.1:${fresh.port}/json/version`)).json();
        const debug = await attach(endpoint.webSocketDebuggerUrl);
        const { sessionId } = await debug.send('Target.attachToTarget', { targetId: fresh.sw.targetId, flatten: true });
        const debugSend = (method, params = {}) => debug.send(method, params, sessionId);
        const scriptPaths = new Map();
        const onPause = async (method, params, message) => {
          if (message.sessionId !== sessionId) return;
          if (method === 'Debugger.scriptParsed' && scriptPaths.size < 2000
            && /^chrome-extension:\/\/[a-p]{32}\/[a-zA-Z0-9_./-]+\.js$/.test(params.url ?? '')) {
            scriptPaths.set(params.scriptId, new URL(params.url).pathname);
          }
          if (method !== 'Debugger.paused') return;
          // why: the public transfer reply deliberately hides arbitrary errors.
          // Keep bounded static locations and allowlisted refusal codes, never
          // exception text, scopes, arguments, or exported secret material.
          const receipt = exceptions.length < 24 ? {
            kind: ['Error', 'TypeError', 'DOMException', 'ReferenceError', 'RangeError']
              .includes(params.data?.className) ? params.data.className : 'other',
            frames: (params.callFrames ?? []).slice(0, 12).map((frame) => ({
              path: scriptPaths.get(frame.location?.scriptId) ?? 'non-static-source',
              line: frame.location?.lineNumber,
              column: frame.location?.columnNumber,
            })),
          } : null;
          if (receipt) exceptions.push(receipt);
          try {
            if (receipt && params.data?.objectId) {
              // why: projectTools returns finite refusal codes; project only
              // that data property, without evaluating getters or error text.
              const projection = await debugSend('Runtime.callFunctionOn', {
                objectId: params.data.objectId,
                functionDeclaration: `function() {
                  'use strict';
                  const code = Object.getOwnPropertyDescriptor(this, 'code')?.value;
                  return ['host-concurrency', 'module-load-failed', 'module-load-timeout',
                    'controller-module-load-failed', 'controller-call-aborted',
                    'controller-capability-unimplemented', 'controller-deadline-expired',
                    'controller-worker-lost', 'kernel-channel-lost', 'kernel-operation-denied',
                    'turn-tool-projection-failed', 'turn-payload-invalid', 'turn-authority-invalid']
                    .includes(code) ? code : 'unclassified';
                }`,
                returnByValue: true, silent: true,
              });
              receipt.code = projection.result?.value ?? 'unavailable';
            }
          } catch { if (receipt) receipt.code = 'unavailable'; }
          finally { await debugSend('Debugger.resume').catch(() => {}); }
          // Observation changes scheduling; it is diagnostic evidence, not a
          // replacement for a passing uninstrumented release qualification.
        };
        debug.on(onPause);
        try {
          await debugSend('Debugger.enable');
          await debugSend('Debugger.setPauseOnExceptions', { state: 'all' });
          // Attach before page startup so observation does not add a settling
          // delay between opening Settings and the real export gesture.
          page = await openWidePage(fresh, 'options/options.html#!/transfer', { ready: '#exppass2' });
          await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: destination });
          // Observe only result codes from the real private channel. Never
          // retain the passphrase, exported payload, secrets or identity capsule.
          await evalIn(page, `(() => {
            'use strict';
            globalThis.__backupReplyCodes = [];
            navigator.serviceWorker.addEventListener('message', event => {
              if (!event.isTrusted || event.data?.type !== 'private-transfer/channel' || event.ports.length !== 1) return;
              event.ports[0].addEventListener('message', response => {
                const data = response.data;
                if (data?.type !== 'private-transfer/response') return;
                const code = data.reply?.error ?? data.error;
                // why: classify known static messages without retaining arbitrary exception text.
                const known = {
                  'Temporarily unavailable. Try again.': 'startup-unavailable',
                  'sealed controller worker retired before readiness': 'controller-retired-before-ready',
                  'sealed controller worker did not become ready': 'controller-not-ready',
                  'controller ambient capability denied': 'controller-ambient-denied',
                };
                globalThis.__backupReplyCodes.push({ transportOk: data.ok === true, ok: data.reply?.ok === true,
                  error: typeof code === 'string' && /^[a-z0-9-]{1,100}$/.test(code) ? code
                    : typeof code === 'string' && Object.hasOwn(known, code) ? known[code]
                    : code == null ? null : 'non-code-error',
                  code: typeof data.reply?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(data.reply.code)
                    ? data.reply.code : null,
                  phase: ['startup', 'pre-dispatch'].includes(data.reply?.phase) ? data.reply.phase : null,
                  outcomeKnown: typeof data.reply?.outcomeKnown === 'boolean' ? data.reply.outcomeKnown : null,
                  retryable: typeof data.reply?.retryable === 'boolean' ? data.reply.retryable : null });
              });
            });
            for (const id of ['exppass', 'exppass2']) {
              const input = document.getElementById(id); input.value = ${JSON.stringify(PASSPHRASE)};
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          })()`);
          if (!await clickAndSyncRedraw(page, '.transfer-section > div > button')) throw new Error('Download backup is missing');
          const status = await waitFor(() => evalIn(page, `(() => {
            const status = document.querySelector('.transfer-status');
            return status ? { text: status.textContent, success: status.classList.contains('transfer-status--success'),
              retained: document.querySelector('#exppass').value.length > 0 && document.querySelector('#exppass2').value.length > 0,
              enabled: [...document.querySelectorAll('.transfer-section button')].some((button) => button.textContent === 'Download backup' && !button.disabled) } : null;
          })()`), { budgetMs: 60_000, pollMs: 100 });
          if (!status?.enabled) throw new Error(`backup ${mode} did not settle`);
          let payload, inspected;
          if (status.success) {
            payload = await waitFor(async () => {
              const names = (await readdir(destination)).filter((name) => name.endsWith('.json'));
              return names.length === 1 ? readFile(join(destination, names[0]), 'utf8').then(JSON.parse).catch(() => null) : null;
            }, { budgetMs: 15_000, pollMs: 50 });
            if (!payload) throw new Error(`backup ${mode} reported success without a real JSON download`);
            inspected = await privateTransferRpc(page, { type: 'transfer/inspectImport', payload });
            if (inspected?.ok !== true) throw new Error(`backup ${mode} could not inspect its actual download`);
          }
          rec.observe(`settled backup receipt ${mode}`, { status, codes: await evalIn(page, 'globalThis.__backupReplyCodes'), files: await readdir(destination),
            format: payload?.format ?? null, summary: inspected?.summary ?? null });
          await observer.barrier();
          const events = evidence.events.slice(start.events);
          const hosts = await evalIn(fresh.swConn, 'globalThis.__backupHostCalls.slice(' + start.hosts + ')');
          const files = await readdir(destination);
          const identity = payload?.dweb?.identityRecord;
          const off = mode !== 'identity-on';
          const noHost = hosts.length === 0 && !events.some((event) => event.href?.includes('/offscreen/offscreen.html'));
          const noTransport = !events.some((event) => ['WebSocket', 'RTCPeerConnection', 'native-websocket'].includes(event.kind));
          const closes = await evalIn(fresh.swConn, 'globalThis.__backupHostCloses.slice(' + start.closes + ')');
          const result = { status, files, hosts, closes, noHost, noTransport, did: identity?.did ?? null,
            format: payload?.format ?? null, summary: inspected?.summary ?? null };
          rec.observe(`actual backup ${mode}`, result);
          rec.observe(`backup lease posture after ${mode}`,
            (await rpc(fresh.page, { type: 'bootstrap/ready' }))?.featureLeases);
          if (baseRender && off) rec.observe(`merge-base backup ${mode}`, result);
          else if (expectedDid && off) {
            rec.check('identity-off refuses the download with distinct network guidance', !status.success && status.retained
              && files.length === 0 && status.text.includes('Turn it on in Settings > Decentralized web')
              && status.text.includes('Nothing was downloaded'));
          } else {
            rec.check(`${mode} downloads an inspectable real backup`, status.success && payload?.format === 'peerd-export');
            if (!status.success || inspected?.ok !== true) throw new Error(`backup ${mode} refused; see settled backup receipt for result codes`);
            rec.check(`${mode} includes only the expected identity`, expectedDid
              ? identity?.did === expectedDid && typeof identity.capsule === 'string' && identity.capsule.length > 0
                && inspected.summary?.hasIdentityRecord === true && inspected.summary.identityDid === expectedDid
              : !identity && inspected.summary?.hasIdentityRecord === false);
          }
          if (!baseRender && off) rec.check(`${mode} constructs no host or network transport`, noHost && noTransport);
          rec.check(`${mode} export makes no model inference`, fresh.modelCallCount() === 0);
          await rec.visualPage(mode === 'no-choice' ? 'backup-network-policy' : `backup-${mode}`, page);
        } finally {
          await debugSend('Debugger.setPauseOnExceptions', { state: 'none' }).catch(() => {});
          await debugSend('Debugger.disable').catch(() => {});
          debug.off(onPause);
          debug.close();
          rec.observe(`backup exception locations ${mode}`, exceptions);
          await page?.close();
        }
      };
      try {
        const initial = await rpc(fresh.page, { type: 'state/get' });
        rec.check('backup policy starts in a real fresh vault', initial?.ok && initial.state?.vault?.initialized === false);
        const existing = await evalIn(fresh.page, 'chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })', true);
        if (!Array.isArray(existing) || existing.length) throw new Error('a host exists before backup observation');
        await evalIn(fresh.swConn, `(() => {
          'use strict';
          globalThis.__backupHostCalls = [];
          globalThis.__backupHostCloses = [];
          const closeDocument = chrome.offscreen.closeDocument.bind(chrome.offscreen);
          chrome.offscreen.closeDocument = (...args) => {
            globalThis.__backupHostCloses.push({ at: Date.now(),
              stack: new Error('backup host retirement').stack?.slice(0, 3000) });
            return closeDocument(...args);
          };
          const createDocument = chrome.offscreen.createDocument.bind(chrome.offscreen);
          chrome.offscreen.createDocument = (...args) => {
            globalThis.__backupHostCalls.push({ at: Date.now(), url: args[0]?.url,
              stack: new Error('backup host creation').stack?.slice(0, 3000) }); return createDocument(...args);
          };
        })()`);
        const shellSource = await readFile(join(ctx.extensionDir, 'offscreen/controller-shell.js'), 'utf8');
        const refusalLine = shellSource.split('\n').findIndex(line => line.includes("ok: false, code: 'host-concurrency'"));
        if (refusalLine < 0) throw new Error('controller refusal diagnostic location missing');
        const configureWorkerDebugger = async (connection, sessionId) => {
          const send = (method, params = {}) => connection.send(method, params, sessionId);
          const { breakpointId } = await send('Debugger.setBreakpointByUrl', {
            url: `chrome-extension://${fresh.sw.id}/offscreen/controller-shell.js`, lineNumber: refusalLine,
          });
          connection.on(async (method, params, message) => {
            if (method !== 'Debugger.paused' || message.sessionId !== sessionId
              || !params.hitBreakpoints?.includes(breakpointId)) return;
            try {
              evidence.controllerOccupancy ??= [];
              if (evidence.controllerOccupancy.length < 12) {
                // why: only finite capability/phase labels leave the paused frame;
                // never retain request identifiers, payloads or authority objects.
                const result = await send('Debugger.evaluateOnCallFrame', {
                  callFrameId: params.callFrames[0].callFrameId,
                  expression: `(() => {
                    const label = value => typeof value === 'string' && /^[a-z][a-z0-9./-]{0,63}$/.test(value) ? value : 'other';
                    return { refused: label(operation.capability), concurrent, stopConcurrent, maxConcurrent,
                      operations: Array.from(operations.values()).slice(0, 16).map(item => ({
                        capability: label(item.capability), phase: ['accepted', 'committed'].includes(item.phase) ? item.phase : 'other',
                        stopLane: item.stopLane === true, pendingCalls: item.kernelCalls.size,
                      })) };
                  })()`, returnByValue: true, silent: true,
                });
                if (result.exceptionDetails) throw new Error('controller occupancy projection failed');
                evidence.controllerOccupancy.push(result.result.value);
              }
            } catch { evidence.observerErrors.push('controller occupancy diagnostic failed'); }
            finally { await send('Debugger.resume').catch(() => {}); }
          });
        };
        observer = await observeHosts(fresh, evidence, diagnostic, () => {}, undefined, configureWorkerDebugger);
        const initialized = await rpc(fresh.page, { type: 'vault/initialize', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
        if (initialized?.ok !== true) throw new Error('the fresh backup vault did not initialize');
        const noChoice = (await rpc(fresh.page, { type: 'state/get' }))?.state?.settings;
        rec.check('fresh backup has no inherited network choice', noChoice?.dwebChoiceMade === false && noChoice.dwebEnabled === false);
        await exportBackup('no-choice');
        await click('.onboarding-skip');
        await click('[data-network-choice=skip]');
        for (const field of ['.peer-name-input', '#onb-call', '#onb-notes']) {
          if (!await waitFor(() => evalIn(fresh.page, `!!document.querySelector(${JSON.stringify(field)})`),
            { budgetMs: 20_000 })) throw new Error(`missing personal setup ${field}`);
          await click('.onboarding-skip');
        }
        const off = (await rpc(fresh.page, { type: 'state/get' }))?.state?.settings;
        rec.check('Not now is a real persisted off choice', off?.dwebChoiceMade === true && off.dwebEnabled === false);
        await exportBackup('no-identity-off');
        evidence.phase = 'explicit-enable';
        await evalIn(fresh.page, `location.hash = 'discover'`);
        await click('[data-network-choice=enable]');
        const readback = { choice: null, ready: null, info: null };
        const saved = await waitFor(async () => {
          const reply = await rpc(fresh.page, { type: 'state/get' });
          readback.choice = { ok: reply?.ok, dwebChoiceMade: reply?.state?.settings?.dwebChoiceMade,
            dwebEnabled: reply?.state?.settings?.dwebEnabled };
          return readback.choice.ok === true && readback.choice.dwebChoiceMade === true
            && readback.choice.dwebEnabled === true;
        }, { budgetMs: 30_000, pollMs: 100 });
        rec.observe('explicit peer-network choice read-back', readback.choice);
        if (!saved) throw new Error(`explicit network choice did not persist: ${JSON.stringify(readback)}`);
        const running = await waitFor(async () => {
          readback.ready = await rpc(fresh.page, { type: 'bootstrap/ready' });
          if (readback.ready?.ok !== true || readback.ready.featureLeases?.leases?.dweb?.status !== 'active') return false;
          readback.info = await rpc(fresh.page, { type: 'dweb/distributed/info' });
          return readback.info?.ok === true && readback.info.running === true
            && readback.info.did?.startsWith('did:key:');
        }, { budgetMs: 60_000, pollMs: 100 });
        rec.observe('native peer-network startup read-back', readback);
        if (!running) throw new Error(`native network opt-in did not create the real identity: ${JSON.stringify(readback)}`);
        const started = readback.info;
        const signaled = await waitFor(() => evidence.events.some((event) => event.phase === 'explicit-enable'
          && event.kind === 'WebSocket'), { budgetMs: 30_000, pollMs: 100 });
        rec.check('explicit opt-in proves the native transport observer works', !!signaled);
        await exportBackup('identity-on', started.did);
        const disabled = await rpc(fresh.page, { type: 'settings/update', patch: { dwebEnabled: false } });
        if (disabled?.ok !== true || disabled.settings?.dwebEnabled !== false) throw new Error('the peer network did not turn off');
        await exportBackup('identity-off', started.did);
      } finally {
        rec.observe('backup host and transport evidence', evidence);
        try { if (observer) await observer.close(); }
        finally { await fresh.close(); await rm(directory, { recursive: true, force: true }); }
      }
    },
  },

  // --- functional: the goal-mode autonomous loop -----------------------------
  // Also covers the plan-of-record (todo_init/todo_check → the visible
  // TodoCard) and the sticky Goal toggle (lit "running" while the run drives,
  // not untoggled on send). The faked model plans, ticks one item, then ends
  // the run - so the card renders 1/2 and the toggle reads running mid-flight.
  {
    name: 'goal', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => {
      if (callIndex === 0) return { delayMs: 200, sse: sseText('On it - planning the goal.') };
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
      // The Goal toggle is the run's state light - it must read "running", not
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
      // after todo_check - the visible checklist that answers "is it working?".
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
      // The receipt must also survive a full 'state' push, which replaces the
      // whole session: a Plan toggle is one such push.
      await rpc(ctx.page, { type: 'permission/set', mode: 'plan' });
      const planOn = await waitFor(() => evalIn(ctx.page,
        `document.querySelector('.planact-mode[aria-pressed="true"]')?.textContent.trim() === 'Plan'`), { budgetMs: 8_000, pollMs: 50 });
      const todoAfterPush = await evalIn(ctx.page, `!!document.querySelector('.todo-card')`);
      rec.check('TodoCard survives the state push of a Plan toggle', !!planOn && todoAfterPush === true);
      await rpc(ctx.page, { type: 'permission/set', mode: 'act' });
      await waitFor(() => evalIn(ctx.page,
        `document.querySelector('.planact-mode[aria-pressed="true"]')?.textContent.trim() === 'Act'`), { budgetMs: 8_000, pollMs: 50 });
      rec.check('submitted goal text round-trips as the first user message', !!out.userText && out.userText.includes('tidy the repo'), JSON.stringify(out.userText));
    },
  },

  // --- functional: the local-first personal-data agent (code-mode over OPFS) --
  {
    name: 'personal-data', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      if (callIndex === 0) return { sse: sseToolCall('script', { code: PDA_SCRIPT }) };
      // call 1 carries the script tool result back - capture it for the assertion.
      if (callIndex === 1) pdaToolResultBody = (request && request.postData) || '';
      return { sse: sseText('You spent $50.00 across 3 orders - computed on-device, nothing left your machine.') };
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
      // OPFS index - the computed total/count only exist in the worker's result
      // JSON, not in PDA_SCRIPT's source text or the code argument echoed back.
      // why parse, not substring-match the raw body: pdaToolResultBody is the
      // raw request postData, where the script result is a JSON string NESTED in
      // the request JSON - so its quotes are escaped (\"total\":50) and a raw
      // `"total":50` check never matches (this is why the check was red). Parse
      // the request, pull the tool-result message content (now unescaped), and
      // assert the computed values live THERE - the load-bearing proof the
      // sealed worker built + queried the OPFS index (total/count exist only in
      // its result, not in PDA_SCRIPT's source or the echoed code arg).
      let pdaResult = '';
      try {
        const reqBody = JSON.parse(pdaToolResultBody);
        pdaResult = (reqBody.messages || [])
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .find((c) => c.includes('on-device OPFS index')) || '';
      } catch { /* leave '' - the check fails with a clear detail */ }
      rec.check('script REALLY computed on-device (computed total in tool result, not script source)',
        /"total"\s*:\s*50\b/.test(pdaResult) && /"count"\s*:\s*3\b/.test(pdaResult),
        `script tool result: ${pdaResult.slice(0, 200)}`);
      rec.check('the on-device answer renders to the user', !!out.assistantText && /50/.test(out.assistantText), JSON.stringify(out.assistantText));
    },
  },

  // --- functional: HARVEST - the agent reads a real page, then indexes it ------
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
            code: `const results = await Promise.all([page.goto(${JSON.stringify(`${harvestFixtureUrl}first`)}), page.goto(${JSON.stringify(harvestFixtureUrl)}), page.content()]); return results[2];`,
          }) };
          return { sse: sseText('Order #1001 - Coffee Mug - $12.00; Order #1002 - Notebook - $8.50; Order #1003 - Pen Set - $15.00') };
        }
        if (t === 0) return { sse: sseToolCall('navigate', { url: harvestFixtureUrl }) };
        if (t === 1) return { sse: sseToolCall('read_page', {}) };
        return { sse: sseText('Order #1001 - Coffee Mug - $12.00; Order #1002 - Notebook - $8.50; Order #1003 - Pen Set - $15.00') };
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
      let firstResponseAt = 0;
      let rootRequestAt = 0;
      const server = createServer((req, res) => {
        const respond = () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ORDERS_HTML); };
        if (req.url === '/first') {
          setTimeout(() => { firstResponseAt = Date.now(); respond(); }, 150);
          return;
        }
        if (req.url === '/') rootRequestAt = Date.now();
        respond();
      });
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
        const actorTabs = await evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(harvestFixtureUrl)})).map(({ id, url }) => ({ id, url })))`, true);
        rec.check('concurrent first page calls share one actor tab in FIFO order',
          actorTabs.length === 1 && actorTabs[0]?.url === harvestFixtureUrl && firstResponseAt > 0 && rootRequestAt >= firstResponseAt,
          JSON.stringify({ actorTabs, firstResponseAt, rootRequestAt }));
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

  // This state proves the chrome.scripting fallback in the real browser.
  {
    name: 'chrome-scripting-browser-actions', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>')) {
        if (!storeScriptingState.actorPrompt) storeScriptingState.actorPrompt = body;
        storeScriptingState.results = toolResultsIn(body);
        const latest = storeScriptingState.results.at(-1) || '';
        const turn = storeScriptingState.actorTurn++;
        if (turn === 0) return { sse: sseToolCall('navigate', { url: storeScriptingFixtureUrl }) };
        if (turn === 1) return { sse: sseToolCall('snapshot', {}) };
        if (turn === 2) {
          storeScriptingState.orderRef = latest.match(/(@e\d+) textbox "Order ID"/)?.[1] || '';
          storeScriptingState.sendRef = latest.match(/(@e\d+) button "Send message"/)?.[1] || '';
          return { sse: sseToolCall('type', {
            ref: storeScriptingState.orderRef, text: 'STORE-42', expectedCount: 1,
          }) };
        }
        if (turn === 3) return { sse: sseToolCall('click', { ref: storeScriptingState.sendRef, expectedCount: 1 }) };
        if (latest.includes('TICKET-STORE-42')) {
          return { sse: sseText('SCRIPTING-ACTOR-DONE TICKET-STORE-42') };
        }
        if (turn < 8) return { delayMs: 250, sse: sseToolCall('read_page', {}) };
        return { sse: sseText('SCRIPTING-ACTOR-DID-NOT-OBSERVE-CONFIRMATION') };
      }
      if (!storeScriptingState.delegated) {
        storeScriptingState.delegated = true;
        return { sse: sseToolCall('message_actor', {
          to: 'web',
          message: `Open ${storeScriptingFixtureUrl}. Enter order STORE-42. Send the form. Report the confirmation code.`,
        }) };
      }
      if (body.includes('you messaged has replied')) {
        storeScriptingState.wakeBody = body;
        return { sse: sseText('Chrome scripting completed the form with TICKET-STORE-42.') };
      }
      return { sse: sseText('Delegated to the web actor; awaiting its reply.') };
    },
    async run(ctx, rec) {
      storeScriptingState = {
        delegated: false, actorTurn: 0, actorPrompt: '', results: [], wakeBody: '', orderRef: '', sendRef: '',
      };
      const tabsBefore = await evalIn(ctx.page, `(async () =>
        (await chrome.tabs.query({})).map((tab) => tab.id).filter(Number.isInteger))()`, true);
      const fixture = await startWebFixtureServer();
      storeScriptingFixtureUrl = `${fixture.url.replace('127.0.0.1', 'orders.peerd.test')}/contact`;
      try {
        const settings = await rpc(ctx.page, {
          type: 'settings/update',
          patch: { webActorActionSurface: 'tools', advancedAutomationEnabled: false },
        });
        rec.check('fallback settings select discrete tools without advanced automation',
          settings?.ok === true
            && settings.settings?.webActorActionSurface === 'tools'
            && settings.settings?.advancedAutomationEnabled === false,
          JSON.stringify(settings));

        const sent = await rpc(ctx.page, {
          type: 'agent/send',
          text: 'Submit support request STORE-42 and report its confirmation code.',
        });
        rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
        await waitFor(() => (storeScriptingState.results.at(-1) || '').includes('TICKET-STORE-42'), {
          budgetMs: 40_000, pollMs: 100,
        });
        await ctx.page.send('Page.bringToFront').catch(() => {});

        let out = {};
        await waitFor(async () => {
          out = await evalIn(ctx.page, `(() => ({
            bubbles: [...document.querySelectorAll('.message-assistant .bubble')]
              .map((bubble) => bubble.textContent.trim()),
            busy: !!document.querySelector('form.input-bar button.stop'),
          }))()`) || {};
          return (out.bubbles || []).includes('Chrome scripting completed the form with TICKET-STORE-42.')
            && !out.busy;
        }, { budgetMs: 40_000 });

        const [, snapshotResult = '', typeResult = '', clickResult = ''] = storeScriptingState.results;
        const readPageResult = storeScriptingState.results
          .find((result) => result.includes('TICKET-STORE-42')) || '';
        rec.check('the web actor received the discrete browser tools',
          storeScriptingState.actorPrompt.includes('tools: snapshot')
            && !storeScriptingState.actorPrompt.includes('tools: page_code'),
          storeScriptingState.actorPrompt.slice(0, 500));
        rec.check('snapshot used the Chrome scripting fallback',
          snapshotResult.includes('DOM-walk fallback') && snapshotResult.includes('no CDP here'),
          snapshotResult.slice(0, 1200));
        rec.check('type and click used DOM-walk refs',
          typeResult.includes('"typed": "STORE-42"')
            && /"via"\s*:\s*"dom-walk"/.test(typeResult)
            && clickResult.includes('"clicked": true')
            && /"via"\s*:\s*"dom-walk"/.test(clickResult),
          JSON.stringify({ typeResult, clickResult }));
        rec.check('the actor observed the submitted result',
          readPageResult.includes('TICKET-STORE-42'), readPageResult.slice(-1200));
        rec.check('the actor reply returned through a fenced wake',
          storeScriptingState.wakeBody.includes('you messaged has replied')
            && storeScriptingState.wakeBody.includes('<untrusted_web_content')
            && storeScriptingState.wakeBody.includes('SCRIPTING-ACTOR-DONE TICKET-STORE-42'),
          storeScriptingState.wakeBody.slice(-1000));
        rec.check('the final answer renders and the turn is idle',
          (out.bubbles || []).includes('Chrome scripting completed the form with TICKET-STORE-42.')
            && out.busy === false,
          JSON.stringify(out));
        await rec.shot('final');
      } finally {
        await rpc(ctx.page, { type: 'agent/stop' }).catch(() => {});
        const reset = await rpc(ctx.page, {
          type: 'settings/reset',
          keys: ['webActorActionSurface', 'advancedAutomationEnabled'],
        }).catch((error) => ({ ok: false, error: String(error) }));
        await evalIn(ctx.page, `(async () => {
          const before = new Set(${JSON.stringify(tabsBefore)});
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)
            && (!before.has(tab.id) || tab.url === ${JSON.stringify(storeScriptingFixtureUrl)}))
            .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        })()`, true).catch(() => {});
        await fixture.close().catch(() => {});
        rec.check('the channel settings reset after the fallback probe', reset?.ok === true, JSON.stringify(reset));
        if (!reset?.ok) throw new Error(`settings reset failed: ${JSON.stringify(reset)}`);
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
        // why: the final assistant response redraws the tool card. Inspecting
        // while that turn is still streaming can click a node that is about to
        // be replaced and falsely report a missing disclosure.
        await waitFor(async () => !(await probe(ctx)).busy,
          { budgetMs: 20_000, pollMs: 50 });
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
      await waitFor(async () => !(await probe(ctx)).busy,
        { budgetMs: 20_000, pollMs: 50 });
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

  // --- functional: real tab-site-client custody + live confirmation ---------
  // One production-shaped vertical: a forged main-agent call is refused, then
  // a tab Web actor drives a real page, captures its traffic, waits on the real
  // confirmation channel before persisting a client, reads it, and executes it
  // in the sealed site-client worker against the same origin.
  {
    name: 'site-client-vertical', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>')) {
        siteClientVertical.actorCalls += 1;
        siteClientVertical.actorBodies.push(body);
        const turn = siteClientVertical.actorCalls - 1;
        siteClientVertical.actorResults[turn] = toolResultsIn(body).at(-1) ?? '';
        const codeSurface = body.includes('tools: page_code');
        if (turn === 0) return codeSurface
          ? { sse: sseToolCall('page_code', {
            code: `await page.goto(${JSON.stringify(siteClientVerticalUrl)}); return await page.content();`,
          }) }
          : { sse: sseToolCall('navigate', { url: siteClientVerticalUrl }) };
        if (turn === 1) return codeSurface
          ? { sse: sseToolCall('page_code', {
            code: 'return await page.captureSite("start");',
          }) }
          : { sse: sseToolCall('site_capture', { action: 'start' }) };
        if (turn === 2) return codeSurface
          ? { sse: sseToolCall('page_code', {
            code: 'await page.click("#refresh"); return await page.content();',
          }) }
          : { sse: sseToolCall('click', { selector: '#refresh' }) };
        if (turn === 3) return codeSurface
          ? { sse: sseToolCall('page_code', {
            code: 'return await page.captureSite("stop");',
          }) }
          : { sse: sseToolCall('site_capture', { action: 'stop' }) };
        if (turn === 4) {
          const capture = siteClientResultContent(siteClientVertical.actorResults[4] ?? '');
          const deriver = capture.includes('deriver: capture-cdp') ? 'capture-cdp' : 'capture-tap';
          const definition = {
            summary: 'Read the live fixture status.',
            endpoints: [{ method: 'GET', path: '/api/status', note: 'Current status' }],
            auth: 'none', deriver,
            body: 'return { status: async ({ key }) => { const response = await site.fetch("/api/status?key=" + encodeURIComponent(key)); if (response.status !== 200) throw new Error("Status request failed"); return { status: response.status, value: response.json?.value, key }; } };',
            operations: [{
              name: 'status', description: 'Read the fixture status with a request key.', readOnly: true,
              inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
              outputSchema: { type: 'object', properties: {
                status: { type: 'integer' }, value: { type: 'string' }, key: { type: 'string' },
              }, required: ['status', 'value', 'key'], additionalProperties: false },
            }],
            validationCases: ['first', 'second'].map((key) => ({
              operation: 'status', input: { key }, expected: { status: 200, value: 'live-42', key },
            })),
          };
          return codeSurface
            ? { sse: sseToolCall('page_code', {
              code: `return await page.writeSiteClient(${JSON.stringify(siteClientVerticalOrigin)}, ${JSON.stringify(definition)});`,
            }) }
            : { sse: sseToolCall('site_client_write', {
              origin: siteClientVerticalOrigin, ...definition,
            }) };
        }
        if (turn === 5) return codeSurface
          ? { sse: sseToolCall('page_code', {
            code: `return await page.readSiteClient(${JSON.stringify(siteClientVerticalOrigin)});`,
          }) }
          : { sse: sseToolCall('site_client_read', { origin: siteClientVerticalOrigin }) };
        if (turn === 6 || turn === 7) {
          const read = siteClientResultContent(siteClientVertical.actorResults[6] ?? '');
          const envelope = read.match(/<site_client_contract>\s*([\s\S]*?)\s*<\/site_client_contract>/);
          const revision = envelope ? JSON.parse(envelope[1]).revision : null;
          if (!revision) throw new Error('The live read did not return a revision-bound contract');
          return { sse: sseToolCall('site_client_run', {
            origin: siteClientVerticalOrigin, revision,
            ...(turn === 6 ? { mode: 'validate' } : { operation: 'status', input: { key: 'held-out' } }),
          }) };
        }
        return { sse: sseText('SITE-CLIENT-VERTICAL-DONE') };
      }

      if (siteClientVertical.mainStage === 0) {
        siteClientVertical.mainStage = 1;
        // Deliberately forge a hidden actor-only name. The real exposure gate
        // must reject it before capture/browser authority is reached.
        return { sse: sseToolCall('site_capture', { action: 'start' }) };
      }
      if (siteClientVertical.mainStage === 1) {
        siteClientVertical.mainStage = 2;
        return { sse: sseToolCall('message_actor', {
          to: `site:${siteClientVerticalOrigin}`,
          message: 'Capture the status request, save and inspect a client for it, then run the client.',
        }) };
      }
      if (body.includes('you messaged has replied')
          || body.includes('could not complete your request')) {
        siteClientVertical.replyBody = body;
        return { sse: sseText('The live site client completed.') };
      }
      return { sse: sseText('Delegated; awaiting the site-client result.') };
    },
    async run(ctx, rec) {
      siteClientVertical = {
        mainStage: 0, actorCalls: 0, actorBodies: [], actorResults: [],
        replyBody: '', apiReads: 0,
      };
      const fixture = await startSiteClientFixture({
        value: 'live-42', onRead: () => { siteClientVertical.apiReads += 1; },
      });
      siteClientVerticalOrigin = fixture.origin;
      siteClientVerticalUrl = fixture.url;
      try {
        const sent = await rpc(ctx.page, {
          type: 'agent/send',
          text: 'Refuse a direct site capture, then delegate the site-client work to the exact site actor.',
        });
        rec.check('the single site-client turn was accepted', sent?.ok === true, JSON.stringify(sent));

        const confirmation = await siteClientConfirmation(ctx.page);
        rec.check('the page request occurs only after the refused call delegated to the actor',
          siteClientVertical.apiReads >= 1,
          JSON.stringify({ apiReads: siteClientVertical.apiReads }));
        rec.check('the live confirmation names the stored executable and captured endpoint',
          confirmation?.title === 'Confirm site client'
            && confirmation?.code?.includes('/api/status')
            && confirmation?.endpoints?.includes('GET /api/status')
            && confirmation?.buttons?.includes('Save client'),
          JSON.stringify(confirmation));
        rec.check('the user can review exact contracts and both expected examples',
          confirmation?.contracts?.includes('inputSchema')
            && confirmation.contracts.includes('first') && confirmation.contracts.includes('second'),
          confirmation?.contracts);
        await rec.shot('contract-confirmation');
        await evalIn(ctx.page, `document.querySelector('[aria-label="Proposed site-client contracts"]').closest('details').open = true`);
        await rec.shot('contract-details');
        await evalIn(ctx.page, `document.querySelector('[aria-label="Proposed site-client contracts"]').closest('details').open = false`);

        rec.check('the live consent dialog keeps its title and safe initial focus', confirmation?.role === 'dialog'
          && confirmation?.titleId === 'peerd-confirm-title' && confirmation?.rejectFocused === true, JSON.stringify(confirmation));
        const callsAtConfirmation = siteClientVertical.actorCalls;
        await sleep(500);
        const stillBlocked = await evalIn(ctx.page,
          `document.querySelector('.confirm-modal h3')?.textContent === 'Confirm site client'`);
        rec.check('the actor is blocked on the real confirmation channel until the user answers',
          stillBlocked === true && siteClientVertical.actorCalls === callsAtConfirmation,
          JSON.stringify({ callsAtConfirmation, actorCalls: siteClientVertical.actorCalls }));

        const answered = await approveSiteClient(ctx.page);
        rec.check('the user approved through the rendered production modal', answered === true);

        await waitFor(() => siteClientVertical.replyBody.length > 0,
          { budgetMs: 90_000, pollMs: 100 });
        const listed = await rpc(ctx.page, { type: 'session/list' });
        const sessionId = listed?.sessions?.[0]?.sessionId;
        const debug = sessionId
          ? await rpc(ctx.page, { type: 'session/debugBundle', sessionId }) : null;
        const failure = debug?.bundle?.failures?.find((entry) =>
          entry?.scope === 'tool' && entry?.error === 'tool has no execution owner');
        const refusalAudit = debug?.bundle?.audit?.find((entry) =>
          entry?.type === 'tool_failed' && entry?.details?.tool === 'site_capture');
        const firstActorEffect = debug?.bundle?.audit?.find((entry) =>
          entry?.type === 'authority_effect' && entry?.sessionId !== sessionId);
        rec.check('the forged main-agent site_capture was refused before browser effects',
          typeof failure?.toolUseId === 'string'
            && refusalAudit?.details?.callId === failure.toolUseId
            && refusalAudit?.details?.performed === false
            && refusalAudit?.details?.outcomeKnown === true
            && refusalAudit?.when < firstActorEffect?.when,
          JSON.stringify({ failure, refusalAudit, firstActorEffect }));
        const actorEvidence = siteClientResultContent(siteClientVertical.actorResults[4] ?? '');
        rec.check('capture observed the real page request and returned its redacted dossier',
          actorEvidence.includes('/api/status')
            && (REQUIRE_SITE_CAPTURE_TAP
              ? actorEvidence.includes('deriver: capture-tap')
              : actorEvidence.includes('deriver: capture-cdp')
                || actorEvidence.includes('deriver: capture-tap')),
          actorEvidence.slice(-1200));
        rec.check('write settled, read returned the persisted client, and sealed run used it',
          /create/i.test(siteClientVertical.actorResults[5] ?? '')
            && (siteClientVertical.actorResults[6] ?? '').includes('<site_client_contract>')
            && (siteClientVertical.actorResults[7] ?? '').includes('validated')
            && (siteClientVertical.actorResults[8] ?? '').includes('live-42')
            && (siteClientVertical.actorResults[8] ?? '').includes('held-out')
            && siteClientVertical.apiReads >= 4,
          JSON.stringify({
            apiReads: siteClientVertical.apiReads,
            actorResults: siteClientVertical.actorResults.slice(4),
          }));
        rec.check('the tab Web actor completed and its fenced reply reached the orchestrator',
          siteClientVertical.actorCalls >= 9
            && siteClientVertical.replyBody.includes('SITE-CLIENT-VERTICAL-DONE')
            && siteClientVertical.replyBody.includes('you messaged has replied'),
          siteClientVertical.replyBody.slice(-900));
      } finally {
        fixture.server.close();
      }
    },
  },

  // --- functional: origin-pinned API actor owns the site-client lifecycle ---
  // A bare origin addresses the tab-free API actor (not `site:<origin>`). It
  // writes, reads, and runs one confirmed client through the real sealed actor
  // heap, then forges the tab-only capture name. The live controller must refuse
  // that name without ever reaching capture/browser authority.
  {
    name: 'site-client-api-actor', kind: 'functional', phase: 'post-unlock',
    responder: (_callIndex, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>') && body.includes('kind: bound; type: api')) {
        siteClientApiState.actorCalls += 1;
        siteClientApiState.actorBody = body;
        const turn = siteClientApiState.actorCalls - 1;
        siteClientApiState.sawLiveValue ||= (toolResultsIn(body).at(-1) ?? '')
          .includes('api-live-42');
        if (turn === 0) return { sse: sseToolCall('site_client_write', {
          origin: siteClientApiOrigin,
          summary: 'Read the live API actor fixture.',
          endpoints: [{ method: 'GET', path: '/api/status', note: 'Current status' }],
          auth: 'none', deriver: 'probe',
          body: 'return { status: async () => site.fetch("/api/status") };',
        }) };
        if (turn === 1) return { sse: sseToolCall('site_client_read', {
          origin: siteClientApiOrigin,
        }) };
        if (turn === 2) return { sse: sseToolCall('site_client_run', {
          origin: siteClientApiOrigin,
          code: 'const response = await client.status(); return { status: response.status, value: response.json?.value };',
        }) };
        if (turn === 3) return { sse: sseToolCall('site_capture', { action: 'start' }) };
        return { sse: sseText('API-SITE-CLIENT-DONE') };
      }
      if (!siteClientApiState.delegated) {
        siteClientApiState.delegated = true;
        return { sse: sseToolCall('message_actor', {
          to: siteClientApiOrigin,
          message: 'Create, inspect, and run the client for your exact origin, then prove capture is unavailable.',
        }) };
      }
      if (body.includes('you messaged has replied')
          || body.includes('could not complete your request')) {
        siteClientApiState.replySeen = true;
        siteClientApiState.replyReturned = body.includes('you messaged has replied')
          && body.includes('API-SITE-CLIENT-DONE');
        return { sse: sseText('The API actor completed its origin-pinned client check.') };
      }
      return { sse: sseText('Delegated; awaiting the API actor result.') };
    },
    async run(ctx, rec) {
      siteClientApiState = {
        delegated: false, actorCalls: 0, actorBody: '', sawLiveValue: false,
        replySeen: false, replyReturned: false, apiReads: 0,
      };
      const fixture = await startSiteClientFixture({
        value: 'api-live-42', onRead: () => { siteClientApiState.apiReads += 1; },
      });
      siteClientApiOrigin = fixture.origin;
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
      try {
        const sent = await rpc(ctx.page, {
          type: 'agent/send', text: 'ask the exact API origin actor to exercise its stored client',
        });
        rec.check('the API actor turn was accepted', sent?.ok === true, JSON.stringify(sent));

        const confirmation = await siteClientConfirmation(ctx.page, 60_000);
        rec.check('the API actor write waits on the rendered confirmation channel',
          confirmation?.code?.includes('/api/status')
            && confirmation?.endpoints?.includes('GET /api/status'),
          JSON.stringify(confirmation));
        const answered = await approveSiteClient(ctx.page);
        rec.check('the user approved the API client through production UI', answered === true);

        await waitFor(() => siteClientApiState.replySeen,
          { budgetMs: 90_000, pollMs: 100 });
        const entries = await waitFor(async () => {
          const fresh = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
          return fresh.some((entry) => entry.type === 'actor_ran_isolated') ? fresh : null;
        }, { budgetMs: 10_000, pollMs: 50 }) ?? [];
        const operations = entries.filter((entry) => entry.type === 'authority_effect')
          .map((entry) => entry.details?.operation);
        const siteEffects = entries.filter((entry) => entry.type === 'authority_effect'
          && ['turn.site-client.read', 'turn.site-client.commit', 'turn.site-client.run']
            .includes(entry.details?.operation));
        const effectSessions = [...new Set(siteEffects.map((entry) => entry.sessionId))];
        const isolation = actorIsolationEvidence(entries);
        const actorEvidence = siteClientApiState.actorBody;
        const captureRefusal = entries.find((entry) => entry.type === 'tool_failed'
          && entry.details?.tool === 'site_capture');

        rec.check('the live prompt is the bare-origin API actor with no tab or capture surface',
          actorEvidence.includes('kind: bound; type: api')
            && actorEvidence.includes(`scope: origin:${siteClientApiOrigin}`)
            && actorEvidence.includes('site_client_run')
            && !actorEvidence.includes('tools: site_capture'),
          actorEvidence.slice(0, 1_800));
        rec.check('confirmed write, read, and run used only their exact authority operations',
          ['turn.site-client.read', 'turn.site-client.commit', 'turn.site-client.run']
            .every((operation) => operations.includes(operation))
            && siteEffects.every((entry) => entry.details?.outcomeKnown === true)
            && effectSessions.length === 1,
          JSON.stringify({ operations, effectSessions }));
        rec.check('the stored client reached the real pinned endpoint from the sealed API actor',
          siteClientApiState.apiReads >= 1
            && siteClientApiState.sawLiveValue
            && isolation.exactProof === true
            && isolation.isolated.some((entry) =>
              (entry.sessionId ?? entry.details?.actorSessionId) === effectSessions[0]),
          JSON.stringify({ apiReads: siteClientApiState.apiReads, sawLiveValue: siteClientApiState.sawLiveValue }));
        rec.check('forged capture was refused before any capture/browser authority',
          captureRefusal?.details?.performed === false
            && captureRefusal?.details?.outcomeKnown === true
            && !operations.includes('turn.site-client.capture-start')
            && !operations.includes('turn.site-client.capture-stop'),
          JSON.stringify({ captureRefusal, operations }));
        rec.check('the fenced API actor reply returned to the orchestrator',
          siteClientApiState.replyReturned);
      } finally {
        fixture.server.close();
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


  // --- functional: Stop while a tool is running -------------------------------
  // why: the loop saves the assistant message as streaming:false + 'tool_use'
  // before it dispatches, and Stop cannot prove that the running tool also
  // stopped. The card must still settle (outcome unknown), live and after a
  // reload, instead of saying "running…" forever.
  {
    name: 'stop-during-tool', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => callIndex === 0
      ? { sse: sseToolCall('script', { code: 'await new Promise((resolve) => setTimeout(resolve, 12000)); return 42;' }) }
      : { sse: sseText('this-should-never-render') },
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const cardProbe = `(() => ({
        busy: !!document.querySelector('form.input-bar button.stop'),
        running: document.querySelector('.tool-call .tool-pending')?.textContent ?? null,
        settled: document.querySelector('.tool-call .tool-cancelled')?.textContent ?? null,
      }))()`;
      await rpc(ctx.page, { type: 'agent/send', text: 'run a slow script' });
      const running = await waitFor(async () => {
        const view = await evalIn(ctx.page, cardProbe);
        return view.busy && view.running ? view : null;
      }, { budgetMs: 15_000, pollMs: 100 });
      rec.check('the tool card says running while the script runs',
        running?.running === 'running…', JSON.stringify(running));
      const stopped = await rpc(ctx.page, { type: 'agent/stop' });
      rec.check('agent/stop accepted', !!stopped?.ok);
      let out = null;
      await waitFor(async () => {
        out = await evalIn(ctx.page, cardProbe);
        return !out.busy && (baseRender || !out.running) ? out : null;
      }, { budgetMs: 15_000, pollMs: 100 });
      if (baseRender) rec.observe('merge-base stopped tool card', out);
      else rec.check('Stop settles the tool card as outcome unknown',
        out?.busy === false && out?.running === null && out?.settled === 'outcome unknown',
        JSON.stringify(out));
      rec.check('Stop makes exactly one model call', ctx.modelCallCount() === 1, String(ctx.modelCallCount()));
      const sessionId = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
      await reloadReadyPanel(ctx, { expectedSessionId: sessionId });
      const persisted = await waitFor(async () => {
        const view = await evalIn(ctx.page, cardProbe);
        return (baseRender ? !view.busy : view.settled) ? view : null;
      }, { budgetMs: 15_000, pollMs: 100 });
      if (baseRender) rec.observe('merge-base reloaded tool card', persisted);
      else rec.check('the settled card survives a panel reload',
        persisted?.running === null && persisted?.settled === 'outcome unknown',
        JSON.stringify(persisted));
      await clickAndSyncRedraw(ctx.page, '.tool-call .tool-call-header');
      if (!baseRender) rec.check('the expanded card tells the user to check before retrying',
        await evalIn(ctx.page, `document.querySelector('.tool-call .tool-result')?.textContent
          .includes('Check the session before retrying.')`));
      await rec.shot('settled-tool-card');
    },
  },

  // why: the visual lane runs only visual states. Reuse the live Stop flow.
  {
    name: 'stopped-tool-card', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const state = STATES.find(state => state.name === 'stop-during-tool');
      ctx.setModelResponder(state.responder);
      await state.run(ctx, rec);
      await rec.visual('stopped-tool-card');
    },
  },
  {
    name: 'tool-call-output-limit', kind: 'visual', phase: 'post-unlock',
    responder: call => ({ sse: call > 0 ? sseText('I will split the work into smaller calls.') : [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '', tool_calls: [{
        index: 0, id: 'call_e2e_cut', type: 'function',
        'function': { name: 'sandbox_create', 'arguments': '{"kind":"app","name":"Budget tracker","html":"<!doctype html>' },
      }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
      'data: [DONE]', '',
    ].join('\n\n') + '\n\n' }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      await evalIn(ctx.page, `chrome.tabs.query({ currentWindow: true }).then(tabs => { const tab = tabs.find(tab => tab.url === 'about:blank'); return tab && !tab.active ? chrome.tabs.update(tab.id, { active: true }) : null; })`, true);
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Build a budget tracker App.' });
      rec.check('the App request is accepted', sent?.ok === true);
      const settled = await waitFor(async () => {
        const state = await rpc(ctx.page, { type: 'state/get' });
        const messages = state?.state?.session?.messages ?? [];
        const final = messages.at(-1);
        const idle = await evalIn(ctx.page, `!document.querySelector('form.input-bar button.stop')
          && !document.querySelector('.message-assistant.streaming, .wordmark--exit, .wordmark--gone, .channel-badge.is-exiting')`);
        return idle && (final?.content === 'I will split the work into smaller calls.'
          || (baseRender && final?.stopReason === 'max_tokens'))
          ? { sessionId: state.state.session.sessionId, messages } : null;
      }, { budgetMs: 20_000, pollMs: 100 });
      if (!settled) {
        const state = await rpc(ctx.page, { type: 'state/get' });
        const context = await evalIn(ctx.page, `(async () => ({ visibility: document.visibilityState,
          owner: await chrome.windows.getCurrent(), tabs: await chrome.tabs.query({}),
          current: await chrome.tabs.query({currentWindow:true}), stop: !!document.querySelector('form.input-bar button.stop'),
          streaming: !!document.querySelector('.message-assistant.streaming'),
          brand: [...document.querySelectorAll('[class*=wordmark], [class*=channel-badge]')].map(node => ({
            class: node.className, text: node.textContent, display: getComputedStyle(node).display,
            opacity: getComputedStyle(node).opacity, color: getComputedStyle(node).color,
          })) }))()`, true);
        throw new Error('The cut tool call did not settle: ' + JSON.stringify({baseRender,calls:ctx.modelCallCount(), messages:state?.state?.session?.messages, context}));
      }
      const cut = settled.messages.find(message => message.stopReason === 'max_tokens');
      const result = settled.messages.flatMap(message => message.toolResults ?? [])
        .find(result => result.tool_use_id === cut?.toolUses?.[0]?.id);
      if (baseRender) rec.observe('merge-base cut call', { calls: ctx.modelCallCount(), result });
      else {
        rec.check('the cut call gets a known not-run result and a smaller-call hint',
          result?.is_error && result?.outcomeKnown === true && result?.content?.startsWith('not_run:')
            && result.content.includes('Split the work into smaller calls'), JSON.stringify(result));
        rec.check('the model continues once without dispatching the cut call', ctx.modelCallCount() === 2);
        rec.check('the finished cut call has no running label',
          await evalIn(ctx.page, `!document.querySelector('.tool-call .tool-pending')`));
      }
      const entries = await auditEntries(ctx);
      rec.check('the incomplete App call never executes', !entries.some(entry => entry.sessionId === settled.sessionId
        && entry.type === 'tool_executed' && entry.details?.tool === 'sandbox_create'));
      await clickAndSyncRedraw(ctx.page, '.tool-call .tool-call-header');
      await rec.visual('tool-call-output-limit');
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

  // Core-to-render proof. The live controller can refuse these causes earlier.
  {
    name: 'error-copy-causes', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const page = await openExtPage(ctx, 'tests/fixtures/actor-isolation.html');
      const callsBefore = ctx.modelCallCount();
      try {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 900, deviceScaleFactor: 1, mobile: false });
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('.chat-view')`), { budgetMs: 8000 })) throw new Error('The shared fixture did not mount');
        const result = await evalIn(page, `(async () => {
          'use strict';
          const { default: m } = await import('/vendor/mithril/mithril.js');
          const { default: browser } = await import('/shared/browser-api.js');
          const { idb } = await import('/peerd-egress/index.js');
          const { createSessionStore, makeTurnSlots, makeTurnAuthorityDriver, SessionNotFoundError } = await import('/peerd-runtime/index.js');
          const { listProviderModels, listProviders, providerFailureCode, UnknownProviderError } = await import('/peerd-provider/controller.js');
          const { INITIAL_STATE, reduceChat } = await import('/sidepanel/chat-reducer.js');
          const { ChatView } = await import('/sidepanel/components/chat-view.js');
          const sessions = createSessionStore({ idb });
          const survivor = await sessions.create({ provider: 'ollama' });
          globalThis.__errorCopyCleanup = () => idb.del('sessions', survivor.sessionId);
          const missingId = crypto.randomUUID();
          const attempts = { model: 0, tool: 0 };
          const events = [];
          const providers = listProviders();
          const states = [survivor.sessionId, missingId].map(sessionId => ({
            ...INITIAL_STATE, hydrated: true,
            vault: { ...INITIAL_STATE.vault, initialized: true, locked: false },
            session: { ...INITIAL_STATE.session, sessionId },
            providers: { current: 'ollama', hasKey: true, model: '' },
            settings: { ...INITIAL_STATE.settings, voiceOnboardingDismissed: true },
          }));
          const host = document.getElementById('app');
          m.mount(host, null);
          host.style.cssText = 'display:flex;flex-direction:row;gap:24px;justify-content:center;padding:24px';
          const send = message => {
            if (message.type === 'models/options') return browser.runtime.sendMessage(message);
            attempts.tool++; throw new Error('The error fixture has no mutation authority');
          };
          m.mount(host, { view: () => states.map(state => m('section', {
            style: 'width:400px;height:850px;display:flex;flex-direction:column',
          }, m(ChatView, { state, send, voiceManager: null }))) });
          const causes = [];
          for (const [index, state] of states.entries()) {
            const driver = makeTurnAuthorityDriver({
              vault: { isLocked: () => false }, sessions, turnSlots: makeTurnSlots(),
              sessionCache: { sessionGet: async () => null, sessionSet: async () => {} },
              resolvePermission: async () => ({ mode: 'act', confirmActions: false }),
              memory: { loadAlwaysLoaded: async () => ({ text: '' }) },
              browser: { tabs: { query: async () => [] } },
              skillRegistry: { describeForPrompt: async () => '' },
              settingsStore: { get: () => ({ spendLimitUsd: 0 }) },
              DWEB_ENABLED: false, dwebEngagedSessions: new Set(),
              projectToolDescriptors: async () => ({ tools: [], operations: [] }),
              uiConnected: () => true,
              uiPorts: { broadcast: message => {
                events.push(message);
                states.forEach((value, position) => { states[position] = reduceChat(value, message); });
                m.redraw.sync();
              } },
              auditLog: { append: async () => {} }, trimEnricher: { drain: async () => {} },
              runUserTurn: async function* (context) {
                try {
                  if (index === 0) await listProviderModels('not-registered', {
                    modelEgress: { readModelInventory: async () => {
                      attempts.model++; throw new Error('The error fixture has no model authority');
                    } },
                  });
                  else await sessions.appendMessage(context.sessionId, {
                    id: crypto.randomUUID(), role: 'user', content: context.userText, when: Date.now(),
                  });
                } catch (cause) {
                  causes.push(cause.name);
                  // Use the controller's real bounded provider-code projection.
                  const code = providerFailureCode(cause);
                  if (code) cause.code = code;
                  throw cause;
                }
              },
            });
            await driver.runAgentTurn({ sessionId: state.session.sessionId, userText: 'Check this unavailable chat configuration.' });
          }
          m.redraw.sync();
          return {
            causes, attempts, errors: events.filter(event => event.type === 'turn/error'),
            idle: states.every(state => !state.streaming),
            codes: states.map(state => state.lastError),
            registryIntact: JSON.stringify(listProviders()) === JSON.stringify(providers) && providers.length > 0,
            survivorIntact: JSON.stringify(await sessions.get(survivor.sessionId)) === JSON.stringify(survivor),
            missingAbsent: await sessions.get(missingId) === undefined,
            types: [UnknownProviderError.errorName, SessionNotFoundError.errorName],
            text: [...document.querySelectorAll('.error-banner > span')].map(node => node.textContent),
            settingsActions: [...document.querySelectorAll('.error-banner button')].map(node => node.textContent.trim()),
          };
        })()`, true);
        rec.check('real registry and session producers fail through the driver',
          JSON.stringify(result.causes) === JSON.stringify(result.types) && result.errors.length === 2,
          JSON.stringify(result));
        rec.check('both owner errors remain scoped and settle idle', result.idle
          && JSON.stringify(result.codes) === JSON.stringify(['unknown-provider', 'session-not-found']), JSON.stringify(result.codes));
        rec.check('registry and durable chat stay intact; missing chat stays absent', result.registryIntact && result.survivorIntact && result.missingAbsent);
        rec.check('error production invokes no model or tool effect', result.attempts.model === 0 && result.attempts.tool === 0 && ctx.modelCallCount() === callsBefore);
        rec.check('only the existing provider Settings action renders', JSON.stringify(result.settingsActions) === JSON.stringify(['Open settings']));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base error text', result.text);
        else rec.check('both banners state only what their actual causes prove', JSON.stringify(result.text) === JSON.stringify([
          'The selected provider is unavailable. Choose another provider in Settings.',
          'This chat is unavailable. Open another chat or start a new one.',
        ]), JSON.stringify(result.text));
        await rec.visualPage('error-copy-causes', page, { beforeShot: async (surface, theme) => {
          const frame = await evalIn(surface, `(() => {
            'use strict';
            return { width: innerWidth, height: innerHeight,
              banners: [...document.querySelectorAll('.error-banner')].map(node => {
                const { top, right, bottom, left, width, height } = node.getBoundingClientRect();
                return { text: node.querySelector('span')?.textContent, visible: node.checkVisibility(),
                  top, right, bottom, left, width, height };
              }) };
          })()`, true);
          rec.check(`both error banners stay in frame (${theme})`, frame.banners.length === 2
            && frame.banners.every(row => row.visible && row.width > 0 && row.height > 0
              && row.top >= 0 && row.left >= 0 && row.right <= frame.width && row.bottom <= frame.height), JSON.stringify(frame));
        } });
      } finally {
        try { await evalIn(page, `globalThis.__errorCopyCleanup?.()`, true); }
        finally { page.close(); }
      }
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

  {
    name: 'goal-receipt-chat-switch', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('Receipt fixture ready.') }),
    async run(ctx, rec) {
      const sessions = [];
      for (const label of ['Goal receipt chat A', 'Goal receipt chat B']) {
        if (sessions.length) await rpc(ctx.page, { type: 'session/reset' });
        await rpc(ctx.page, { type: 'agent/send', text: label });
        const ready = await waitFor(async () => {
          const view = await probe(ctx);
          if (!view.userText?.includes(label) || !view.assistantText || view.busy) return null;
          return (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId;
        }, { budgetMs: 20_000, pollMs: 50 });
        if (!ready) throw new Error(`Could not create ${label}`);
        sessions.push({ id: ready, label });
      }
      rec.check('the receipt fixture uses two real chats', sessions[0].id !== sessions[1].id);
      const switchTo = async (session) => {
        const reply = await rpc(ctx.page, { type: 'session/switch', sessionId: session.id });
        const mounted = await waitFor(async () => (await probe(ctx)).userText?.includes(session.label),
          { budgetMs: 8_000, pollMs: 50 });
        if (!reply?.ok || !mounted) throw new Error(`Could not switch to ${session.label}`);
      };
      const inspect = (session) => evalIn(ctx.page, `(() => ({
        draft: document.querySelector('form.input-bar textarea')?.value,
        savedDraft: localStorage.getItem('peerd.draft.' + ${JSON.stringify(session.id)}),
        pending: JSON.parse(localStorage.getItem('peerd.unconfirmed-send.' + ${JSON.stringify(session.id)}) || 'null'),
        canCheck: [...document.querySelectorAll('form.input-bar button')]
          .some((button) => button.textContent === 'Check delivery' && !button.disabled),
        sendDisabled: document.querySelector('form.input-bar .send-btn')?.disabled,
      }))()`);
      const modelCalls = ctx.modelCallCount();
      for (const outcome of ['unknown-reply', 'transport-failure']) {
        const goal = `Keep the goal draft in A after ${outcome}`;
        const draftB = `Keep this separate B draft after ${outcome}`;
        const pendingB = {
          operationId: `e2e.pending-b.${outcome}`, sessionId: sessions[1].id,
          text: 'Earlier B message awaiting delivery', goal: false,
          hadAttachments: false, source: 'composer',
        };
        try {
          await switchTo(sessions[0]);
          await evalIn(ctx.page, `(async () => {
            localStorage.setItem('peerd.draft.' + ${JSON.stringify(sessions[1].id)}, ${JSON.stringify(draftB)});
            localStorage.setItem('peerd.unconfirmed-send.' + ${JSON.stringify(sessions[1].id)}, ${JSON.stringify(JSON.stringify(pendingB))});
            const browser = (await import('/shared/browser-api.js')).default;
            const runtime = browser.runtime;
            const original = runtime.sendMessage;
            const fixture = globalThis.__peerdGoalReceipt = {
              calls: [], finish: () => {}, restore: () => { runtime.sendMessage = original; },
            };
            // Hold only the first send; every session/read route stays real.
            runtime.sendMessage = (message, ...args) => {
              if (message?.type === 'agent/send') {
                fixture.calls.push(message);
                if (fixture.calls.length === 1) return new Promise((resolve, reject) => {
                  fixture.finish = () => ${JSON.stringify(outcome)} === 'transport-failure'
                    ? reject(new Error('Goal receipt transport lost'))
                    : resolve({ ok: false, outcomeKnown: false });
                });
              }
              return original.call(runtime, message, ...args);
            };
          })()`, true);
          rec.check(`${outcome}: the visible Goal control arms the send`,
            await clickAndSyncRedraw(ctx.page, '.goal-toggle[aria-pressed="false"]'));
          await evalIn(ctx.page, `(async () => {
            const { default: m } = await import('/vendor/mithril/mithril.js');
            const input = document.querySelector('form.input-bar textarea');
            input.value = ${JSON.stringify(goal)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            m.redraw.sync();
            document.querySelector('form.input-bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            m.redraw.sync();
          })()`, true);
          const sent = await waitFor(() => evalIn(ctx.page, 'globalThis.__peerdGoalReceipt.calls[0] ?? null'),
            { budgetMs: 5_000, pollMs: 50 });
          if (!sent?.operationId) throw new Error('The mounted composer did not send a goal');
          rec.check(`${outcome}: the pending goal names its original chat`,
            sent.goal === true && sent.sessionId === sessions[0].id && sent.text === goal, JSON.stringify(sent));
          await switchTo(sessions[1]);
          rec.check(`${outcome}: B displays its own draft while A waits`, (await inspect(sessions[1])).draft === draftB);
          await evalIn(ctx.page, 'globalThis.__peerdGoalReceipt.finish()');
          const other = await waitFor(async () => {
            const view = await inspect(sessions[1]);
            return view.canCheck ? view : null;
          }, { budgetMs: 8_000, pollMs: 50 });
          rec.check(`${outcome}: A cannot replace B's draft or delivery receipt`,
            other?.draft === draftB && other.savedDraft === draftB && other.sendDisabled === true
              && other.pending?.operationId === pendingB.operationId, JSON.stringify(other));
          await switchTo(sessions[0]);
          const origin = await inspect(sessions[0]);
          rec.check(`${outcome}: returning to A restores its goal and delivery action`,
            origin.draft === goal && origin.savedDraft === goal && origin.canCheck && origin.sendDisabled === true
              && origin.pending?.operationId === sent.operationId && origin.pending?.sessionId === sessions[0].id,
            JSON.stringify(origin));
          rec.check(`${outcome}: switching and recovery never replay the send`,
            await evalIn(ctx.page, 'globalThis.__peerdGoalReceipt.calls.length === 1')
              && ctx.modelCallCount() === modelCalls);
          await rec.shot(outcome);
        } finally {
          await evalIn(ctx.page, `(async () => {
            globalThis.__peerdGoalReceipt?.finish();
            globalThis.__peerdGoalReceipt?.restore();
            delete globalThis.__peerdGoalReceipt;
            for (const id of ${JSON.stringify(sessions.map((session) => session.id))}) {
              localStorage.removeItem('peerd.unconfirmed-send.' + id);
              localStorage.removeItem('peerd.draft.' + id);
            }
            const { default: m } = await import('/vendor/mithril/mithril.js');
            m.redraw.sync();
          })()`, true).catch(() => {});
        }
      }
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

  // --- functional: the first send keeps the pending permission choice --------
  {
    name: 'pending-chat-permissions', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const extension = process.argv.find(argument => argument.startsWith('--extension='))?.slice('--extension='.length);
      const files = Object.fromEntries(await Promise.all(['index.html', 'app.js'].map(async name => [name,
        await readFile(extension ? join(extension, 'peerd-engine/starters/csv-lab', name)
          : new URL(`../../extension/peerd-engine/starters/csv-lab/${name}`, import.meta.url), 'utf8'),
      ])));
      const inspect = async () => {
        const current = await rpc(ctx.page, { type: 'state/get' });
        const listed = await rpc(ctx.page, { type: 'apps/list' });
        if (current?.ok !== true || listed?.ok !== true || !Array.isArray(listed.apps)) {
          throw new Error('The real permission or App state is unavailable');
        }
        const sessionId = current.state?.session?.sessionId ?? null;
        const durable = sessionId ? await rpc(ctx.page, { type: 'session/get', sessionId }) : null;
        if (sessionId && durable?.session?.sessionId !== sessionId) throw new Error('The durable chat is unavailable');
        const ui = await evalIn(ctx.page, `(async () => {
          'use strict';
          const { default: m } = await import('/vendor/mithril/mithril.js');
          m.redraw.sync();
          const input = document.querySelector('form.input-bar textarea');
          return {
            mode: document.querySelector('.planact-mode[aria-pressed="true"]')?.textContent.trim().toLowerCase(),
            confirmActions: document.querySelector('.planact-confirm')?.getAttribute('aria-pressed') === 'true',
            busy: !!document.querySelector('form.input-bar button.stop, .message-assistant.streaming'),
            input: input ? { value: input.value, disabled: input.disabled, focused: document.activeElement === input } : null,
            deliveryFence: [...document.querySelectorAll('form.input-bar button')].some(button =>
              ['Check delivery', 'Checking…', 'I checked; allow a new message'].includes(button.textContent)),
            prompt: document.querySelector('.confirm-modal') ? {
              title: document.querySelector('.confirm-modal h3')?.textContent,
              summary: document.querySelector('.confirm-modal .confirm-summary')?.textContent,
            } : null,
          };
        })()`, true);
        return { ui, composer: current.state?.composer, permission: current.state?.session?.permission, session: durable?.session ?? null,
          apps: listed.apps, appIds: listed.apps.map(app => app.id).sort() };
      };
      const matches = (permission, mode, confirmActions) => permission?.mode === mode
        && permission?.confirmActions === confirmActions;
      let previousSessionId = null;
      let completedPlan = null;
      for (const mode of ['plan', 'act']) {
        const confirmActions = mode === 'act';
        rec.check(`${mode}: the real New chat control is available`,
          await clickAndSyncRedraw(ctx.page, 'button[aria-label="New chat"]'));
        const fresh = await waitFor(async () => {
          const value = await inspect();
          return !value.session && matches(value.ui, 'act', false)
            && matches(value.permission, 'act', false) ? value : null;
        }, { budgetMs: 15_000, pollMs: 80 });
        rec.check(`${mode}: an untouched new chat has the independent Act and Confirm-off default`, !!fresh);
        if (!fresh) throw new Error('The fresh chat default did not settle');
        const selector = mode === 'plan'
          ? '.planact-mode:first-child:not(:disabled)' : '.planact-confirm[aria-pressed="false"]:not(:disabled)';
        if (!await clickAndSyncRedraw(ctx.page, selector)) throw new Error('The permission control is unavailable');
        const selected = await waitFor(async () => {
          const value = await inspect();
          return !value.session && matches(value.ui, mode, confirmActions)
            && matches(value.permission, mode, confirmActions) ? value : null;
        }, { budgetMs: 10_000, pollMs: 80 });
        rec.check(`${mode}: the real controls set the pending kernel permission before a chat exists`, !!selected);
        if (!selected) throw new Error('The pending permission did not settle');
        if (mode === 'act' && (!completedPlan?.known || completedPlan.readModelCalls() !== 2)) {
          throw new Error('The prior Plan turn has no known complete receipt');
        }
        let beforeSend;
        const ready = await waitFor(async () => {
          beforeSend = await inspect();
          return !beforeSend.session && matches(beforeSend.permission, mode, confirmActions)
            && matches(beforeSend.ui, mode, confirmActions) && beforeSend.composer?.canSend === true
            && !beforeSend.ui.busy && !beforeSend.ui.deliveryFence && beforeSend.ui.input?.disabled === false
            && (beforeSend.ui.input.value === '' || mode === 'act' && beforeSend.ui.input.value === completedPlan.text);
        }, { budgetMs: 15_000, pollMs: 80 });
        if (!ready) {
          rec.observe(`${mode}: the composer did not become ready and empty`, beforeSend);
          throw new Error('The real composer did not become ready and empty');
        }
        if (beforeSend.ui.input.value) {
          // why: only this completed fixture can be removed. Other drafts keep their custody.
          if (completedPlan.readModelCalls() !== 2) throw new Error('The prior Plan turn resumed before fixture cleanup');
          rec.observe('act: exact completed Plan text before fixture cleanup', {
            ui: beforeSend.ui, permission: beforeSend.permission, composer: beforeSend.composer,
            priorSessionId: completedPlan.sessionId, priorCallId: completedPlan.callId,
            priorKnown: completedPlan.known, priorModelCalls: completedPlan.readModelCalls(),
          });
          await evalIn(ctx.page, `(() => {
            'use strict';
            const input = document.querySelector('form.input-bar textarea');
            const fenced = [...document.querySelectorAll('form.input-bar button')].some(button =>
              ['Check delivery', 'Checking…', 'I checked; allow a new message'].includes(button.textContent));
            if (!input || input.disabled || fenced || input.value !== ${JSON.stringify(completedPlan.text)}) {
              throw new Error('The completed fixture text changed before cleanup');
            }
            input.focus(); input.select();
          })()`);
          if (completedPlan.readModelCalls() !== 2) throw new Error('The prior Plan turn resumed before the cleanup keys');
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          const afterClear = await inspect();
          rec.observe('act: composer after exact completed fixture cleanup', {
            ui: afterClear.ui, permission: afterClear.permission, composer: afterClear.composer,
            sessionId: afterClear.session?.sessionId ?? null, priorModelCalls: completedPlan.readModelCalls(),
          });
          if (afterClear.session || !matches(afterClear.permission, mode, confirmActions)
            || !matches(afterClear.ui, mode, confirmActions) || afterClear.composer?.canSend !== true
            || afterClear.ui.busy || afterClear.ui.deliveryFence || afterClear.ui.input?.disabled !== false
            || afterClear.ui.input.value !== '' || completedPlan.readModelCalls() !== 2) {
            throw new Error('The real keys did not leave the fresh composer empty with unchanged permission');
          }
        }
        const name = `Pending permission ${mode}`;
        const args = { kind: 'app', name, files };
        const sentText = `Create the packaged Tables and charts App named ${name}.`;
        const replyText = `PENDING-PERMISSION-${mode.toUpperCase()}-SETTLED`;
        let modelCalls = 0;
        ctx.setModelResponder(index => {
          modelCalls += 1;
          return { sse: index === 0 ? sseToolCall('sandbox_create', args) : sseText(replyText) };
        });
        await evalIn(ctx.page, `(async () => {
          'use strict';
          const { default: m } = await import('/vendor/mithril/mithril.js');
          const input = document.querySelector('form.input-bar textarea');
          if (!input || input.value) throw new Error('The real composer is missing or has a draft');
          input.value = ${JSON.stringify(sentText)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          m.redraw.sync();
          input.closest('form').requestSubmit();
          m.redraw.sync();
        })()`, true);
        const outcome = async () => {
          const value = await inspect();
          const calls = (value.session?.messages ?? []).flatMap(message => message.toolUses ?? [])
            .filter(call => call.name === 'sandbox_create' && call.input?.name === name);
          const call = calls[0];
          const result = (value.session?.messages ?? []).flatMap(message => message.toolResults ?? [])
            .find(result => result.tool_use_id === call?.id);
          return { ...value, calls, call, result };
        };
        const decision = await waitFor(async () => {
          const value = await outcome();
          return value.call && (value.ui.prompt || value.result) ? value : null;
        }, { budgetMs: 30_000, pollMs: 80 });
        if (!decision) throw new Error('The real App call did not reach a prompt or result');
        if (mode === 'act') await rec.shot('confirm-decision');
        if (decision.ui.prompt) {
          rec.check(`${mode}: the native prompt names the exact App authority`,
            decision.ui.prompt.title === 'Confirm action' && decision.ui.prompt.summary?.includes('Create an App'),
            JSON.stringify(decision.ui.prompt));
          if (!await clickAndSyncRedraw(ctx.page, '.confirm-modal [data-confirm-reject]')) {
            throw new Error('The real Reject control is unavailable');
          }
        }
        const settled = await waitFor(async () => {
          const value = await outcome();
          return value.result && !value.ui.busy && !value.ui.prompt
            && value.session.messages.some(message => message.role === 'assistant' && message.content === replyText)
            ? value : null;
        }, { budgetMs: 40_000, pollMs: 80 });
        if (!settled) throw new Error('The correlated App result did not settle');
        const completeCall = modelCalls === 2 && settled.calls.length === 1 && typeof settled.call.id === 'string'
            && typeof settled.session.sessionId === 'string' && settled.session.sessionId !== previousSessionId
            && settled.call.input.kind === 'app' && JSON.stringify(settled.call.input.files) === JSON.stringify(files)
            && settled.result.tool_use_id === settled.call.id
            && settled.session.messages.flatMap(message => message.toolUses ?? []).length === 1
            && settled.session.messages.flatMap(message => message.toolResults ?? []).length === 1
            && settled.session.messages.filter(message => message.role === 'user' && message.content === sentText).length === 1;
        rec.check(`${mode}: the first turn has one complete valid App call and its exact result`, completeCall,
          JSON.stringify({ modelCalls, sessionId: settled.session.sessionId, callId: settled.call.id }));
        if (mode === 'plan') {
          let created = null;
          if (baseRender && settled.result.is_error === false) {
            try { created = JSON.parse(settled.result.content.split('\n\n')[0]); } catch {}
          }
          const knownRefusal = !decision.ui.prompt && settled.result.is_error === true
            && settled.result.meta?.gates?.some(gate => gate.name === 'persona' && gate.allowed === false && /plan/i.test(gate.reason));
          const knownAddition = created?.kind === 'app' && created.name === name && typeof created.id === 'string'
            && settled.apps.some(app => app.id === created.id && app.name === name)
            && !selected.appIds.includes(created.id) && settled.appIds.length === selected.appIds.length + 1
            && selected.appIds.every(id => settled.appIds.includes(id));
          completedPlan = { text: sentText, sessionId: settled.session.sessionId, callId: settled.call.id,
            readModelCalls: () => modelCalls, known: completeCall && settled.result.outcomeKnown !== false
              && !/outcome (?:is )?unknown|unconfirmed/i.test(settled.result.content)
              && (baseRender ? knownAddition : knownRefusal) };
        }
        const evidence = { permission: settled.permission, ui: settled.ui,
          durable: { mode: settled.session.permissionMode, confirmActions: settled.session.confirmActions },
          beforeAppIds: selected.appIds, afterAppIds: settled.appIds, prompted: !!decision.ui.prompt,
          callId: settled.call.id, result: { tool_use_id: settled.result.tool_use_id,
            is_error: settled.result.is_error, content: String(settled.result.content).slice(0, 600) } };
        // why: BASE must show its real permission loss and App outcome. Only the fixed expectations differ.
        if (baseRender) rec.observe(`${mode}: merge-base permission and App outcome`, evidence);
        else {
          rec.check(`${mode}: the durable chat keeps the selected permission`,
            matches(evidence.durable, mode, confirmActions), JSON.stringify(evidence.durable));
          rec.check(`${mode}: the kernel and controls keep the selected permission`,
            matches(settled.permission, mode, confirmActions) && matches(settled.ui, mode, confirmActions));
          rec.check(`${mode}: no App is created`, JSON.stringify(selected.appIds) === JSON.stringify(settled.appIds),
            JSON.stringify({ before: selected.appIds, after: settled.appIds }));
          rec.check(mode === 'plan' ? 'Plan refuses the first App write without a prompt'
            : 'Confirm prompts and real Reject refuses the first App write', settled.result.is_error === true
              && (mode === 'plan' ? !decision.ui.prompt && settled.result.meta?.gates?.some(gate =>
                gate.name === 'persona' && gate.allowed === false && /plan/i.test(gate.reason))
                : !!decision.ui.prompt && /declin|reject/i.test(settled.result.content)
                  && !/outcome (?:is )?unknown/i.test(settled.result.content)), JSON.stringify(settled.result));
        }
        await rec.shot(`${mode === 'plan' ? 'plan' : 'confirm'}-settled`);
        previousSessionId = settled.session.sessionId;
      }
    },
  },

  // --- functional: vault lock → gate, unlock → ready (restores unlocked) ------
  {
    name: 'vault-lock', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const diagnostics = await armVaultLockStages(ctx);
      try {
        const lockStartedAt = Date.now();
        const lock = await rpc(ctx.page, { type: 'vault/lock' });
        const lockReplyMs = Date.now() - lockStartedAt;
        const locked = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.vault-brand') && !document.querySelector('form.input-bar')`), { budgetMs: 8_000 });
        rec.check('locking flips the panel to the vault gate', !!locked && lock?.ok === true, JSON.stringify(lock));
        if (!locked || lock?.ok !== true) {
          await rec.shot('lock-failed');
          rec.observe('lock failure', {
            lockReplyMs,
            stages: await diagnostics.read(),
            elapsedMs: Date.now() - lockStartedAt,
            kernel: await rpc(ctx.page, { type: 'bootstrap/ready' }),
            state: await rpc(ctx.page, { type: 'state/get' }),
            pageEvents: ctx.page.events.slice(-12),
            targetEvents: ctx.extensionTargetEvents().map(({ targetId, events }) => ({ targetId, events: events.slice(-12) })),
          });
        }
        rec.observe('lock stages', await diagnostics.read());
        await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE });
        const ready = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar')`), { budgetMs: 10_000 });
        rec.check('unlocking restores the ready composer', !!ready);
      } finally {
        try { rec.observe('lock stages final', await diagnostics.read()); }
        finally { await diagnostics.remove(); }
      }
    },
  },

  {
    name: 'vault-passphrase-error', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const readGate = () => evalIn(ctx.page, `(() => {
        'use strict';
        const field = document.querySelector('#pass');
        const error = document.querySelector('.gate-msg');
        const live = error?.closest('[aria-live], [role="alert"], [role="status"]');
        return {
          composer: !!document.querySelector('form.input-bar'),
          field: field ? { disabled: field.disabled, readOnly: field.readOnly,
            invalid: field.getAttribute('aria-invalid'), describedBy: field.getAttribute('aria-describedby') } : null,
          error: error ? { text: error.textContent, id: error.id, visible: error.checkVisibility(),
            live: live?.getAttribute('role') === 'alert' || ['polite', 'assertive'].includes(live?.getAttribute('aria-live')),
            linked: !!error.id && field?.getAttribute('aria-describedby')?.split(/\\s+/).includes(error.id)
              && document.getElementById(error.id) === error } : null,
          focused: document.activeElement === field,
          activeTag: document.activeElement?.tagName,
        };
      })()`);
      const requireLocked = async label => {
        const authority = await waitFor(async () => {
          const reply = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5000 });
          rec.observe(`${label}: locked authority`, reply);
          return reply?.ok === true && reply.state?.vault?.locked === true ? reply : null;
        }, { budgetMs: 30_000, pollMs: 100 });
        if (!authority) {
          // Preserve existing observer evidence without waking or resuming the failed authority.
          rec.observe(`${label}: readiness failure targets`, {
            pageEvents: ctx.page.events.slice(-12),
            targets: ctx.extensionTargetEvents().map(({ targetId, events }) => ({
              targetId, events: events.slice(-12),
            })).slice(-24),
          });
          throw new Error(`PROBE-GAP: ${label} has no ready locked authority. No passphrase was submitted.`);
        }
        return authority;
      };
      const submit = async text => {
        const editable = await evalIn(ctx.page, `(() => {
          'use strict';
          const field = document.querySelector('#pass');
          if (!(field instanceof HTMLInputElement) || field.disabled || field.readOnly) return false;
          field.focus();
          field.select();
          return true;
        })()`);
        if (!editable) throw new Error('PROBE-GAP: The real passphrase field is not editable.');
        await ctx.page.send('Input.insertText', { text });
        await ctx.page.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
        });
        await ctx.page.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
        });
      };
      if (!await clickAndSyncRedraw(ctx.page, 'button[aria-label="Lock the vault"]')) {
        throw new Error('The real Lock control is unavailable.');
      }
      await requireLocked('wrong passphrase');
      if (!await waitFor(async () => {
        const gate = await readGate();
        return gate.field && !gate.field.disabled && !gate.field.readOnly;
      }, { budgetMs: 10_000 })) throw new Error('The locked passphrase field did not become ready.');
      await submit(`${PASSPHRASE}-wrong`);
      const wrong = await waitFor(async () => {
        const gate = await readGate();
        return gate.error?.text === 'That passphrase is wrong.' && !gate.field?.disabled && !gate.field?.readOnly
          ? gate : null;
      }, { budgetMs: 30_000, pollMs: 50 });
      rec.check('the real wrong passphrase returns the expected visible refusal',
        wrong?.error?.visible === true && !wrong.composer, JSON.stringify(wrong));
      if (!wrong) throw new Error('The single wrong-passphrase attempt did not return its known refusal.');
      if (baseRender) rec.observe('merge-base wrong-passphrase accessibility', wrong);
      else {
        rec.check('the visible wrong-passphrase error is a live alert', wrong.error.live, JSON.stringify(wrong.error));
        rec.check('the invalid field describes its exact visible error',
          wrong.field.invalid === 'true' && wrong.error.linked, JSON.stringify(wrong));
        rec.check('wrong-passphrase refusal keeps focus on the recovery field', wrong.focused, JSON.stringify(wrong));
      }
      await rec.visual('vault-passphrase-error');
      // why: Qualify the next single attempt without replaying any unlock.
      await requireLocked('corrected passphrase');
      await submit(PASSPHRASE);
      const ready = await waitFor(() => evalIn(ctx.page, `(() => {
        'use strict';
        const field = document.querySelector('form.input-bar textarea');
        if (!(field instanceof HTMLTextAreaElement)) return null;
        return { focused: document.activeElement === field,
          editable: !field.disabled && !field.readOnly,
          activeTag: document.activeElement?.tagName,
          visible: document.visibilityState, documentFocused: document.hasFocus() };
      })()`), { budgetMs: 30_000 });
      rec.observe('successful unlock immediate composer focus', ready);
      const accepted = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5000 });
      rec.check('one corrected keyboard attempt unlocks the real vault', !!ready
        && accepted?.ok === true && accepted.state?.vault?.locked === false
        && (baseRender || (ready.focused === true && ready.editable)), JSON.stringify({ ready, accepted }));
      if (!ready || accepted?.ok !== true || accepted.state?.vault?.locked !== false) {
        throw new Error('The single corrected-passphrase attempt did not prove an unlocked vault.');
      }
      await rec.shot('retry-ready');
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
        const all = await browser.storage.local.get(null);
        return Object.fromEntries(Object.entries(all)
          .filter(([key]) => key.startsWith('contributor_metrics.')));
      })()`, true);
      const latestCommitted = (records) => Object.entries(records ?? {})
        .filter(([key, value]) => key.startsWith('contributor_metrics.state.v2.')
          && value?.version === 2 && value?.committed === true)
        .sort((left, right) => right[1].revision - left[1].revision)[0]?.[1] ?? null;
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
          forged?.ok === false && forged?.code === 'contributor-channel-admission-denied',
          JSON.stringify(forged));
        rec.check('a rejected enable remains storage-inert',
          Object.keys(await stored()).length === 0, JSON.stringify(await stored()));

        await evalIn(page, `(() => [...document.querySelectorAll('button')]
          .find((button) => button.textContent === 'Enable Contributor Metrics')?.click())()`);
        await waitFor(() => evalIn(page, `document.querySelector('.contributor-payload') !== null`),
          { budgetMs: 8_000, pollMs: 80 });
        const active = await stored();
        const snapshot = latestCommitted(active);
        const record = snapshot?.record;
        rec.check('the exact Options button commits one v2 consent journal generation',
          Object.keys(active ?? {}).length === 1
            && snapshot?.state === 'active'
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
        await waitFor(async () => Object.keys(await stored()).length === 1,
          { budgetMs: 8_000, pollMs: 80 });
        const cleared = await stored();
        const revoked = latestCommitted(cleared);
        rec.check('disable commits revocation and removes consent-bearing local state',
          Object.keys(cleared ?? {}).length === 1
            && revoked?.state === 'revoked' && revoked?.record === null,
          JSON.stringify(cleared));
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
        const session = await rpc(ctx.page, { type: 'state/get' });
        await reloadReadyPanel(ctx, {
          expectedSessionId: session?.state?.session?.sessionId ?? null,
        });
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
        `document.querySelector('.task-feedback-note')?.textContent
          .includes('enable Contributor Metrics in Settings') === true`),
      { budgetMs: 4_000, pollMs: 50 });
      const after = await evalIn(ctx.page, `({
        pressed: document.querySelector('.task-feedback button[aria-pressed="true"]')?.textContent,
        notice: document.querySelector('.task-feedback-note')?.textContent,
        messageCount: document.querySelectorAll('.message').length,
        freeText: document.querySelector('.task-feedback input, .task-feedback textarea') !== null,
      })`);
      rec.check('disabled feedback is declined honestly without mutating the transcript',
        !after?.pressed && after?.notice?.includes('enable Contributor Metrics in Settings')
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
    visualVariants: ['site-client-contract-details'],
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
                operations: [{
                  name: 'currentOrder', description: 'Read the current order.', readOnly: true,
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  outputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false },
                }],
                validationCases: [{ operation: 'currentOrder', input: {}, expected: { status: 'shipped' } }],
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
        const contractsExpanded = await evalIn(ctx.page, `(() => {
          const details = document.querySelector('[aria-label="Proposed site-client contracts"]')?.closest('details');
          if (!details) return false;
          details.open = true;
          return true;
        })()`);
        if (!contractsExpanded && process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
          throw new Error('The proposed site-client contracts are unavailable for visual review');
        }
        await rec.visual('site-client-contract-details');
        await ctx.page.send('Emulation.setDeviceMetricsOverride', NARROW_PANEL_METRICS);
        await rec.visual('site-client-contract-details-narrow');
        await evalIn(ctx.page, `document.querySelector('[aria-label="Proposed site-client contracts"]')?.closest('details')?.removeAttribute('open')`);
        await rec.visual('site-client-confirm-narrow');
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
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
        await rec.visual('site-client-maximum');
      } finally {
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
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

  {
    name: 'onboarding-network', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      if (process.env.PEERD_VISUAL_BASE_RENDER === '1') {
        const extension = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
        if (!extension) throw new Error('base visual render requires an explicit extension tree');
        if (!existsSync(join(extension, 'sidepanel/components/onboarding-network-step.js'))) {
          rec.observe('merge-base surface', { present: false, reason: 'network onboarding was introduced on this branch' });
          return;
        }
      }
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { PeerNetworkStep } = await import('/sidepanel/components/onboarding-network-step.js');
          const host = document.createElement('div');
          host.id = 'e2e-onboarding-network';
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
          document.body.appendChild(host);
          window.__networkChoices = [];
          m.mount(host, { view: () => m('.onboarding-view', m('.card.onboarding-card',
            m(PeerNetworkStep, { send: async (message) => {
              window.__networkChoices.push(message); return { ok: false };
            } }))) });
        })()`, true);
        const shape = await evalIn(ctx.page, `({
          heading: document.querySelector('#e2e-onboarding-network h3')?.textContent,
          choices: [...document.querySelectorAll('#e2e-onboarding-network button')].map(b => b.textContent),
          sent: window.__networkChoices.length,
        })`);
        rec.check('network participation requires an explicit choice',
          shape?.heading === 'Join the peer network?' && shape.sent === 0
            && shape.choices.join('|') === 'Enable peer network|Not now', JSON.stringify(shape));
        await rec.visual('onboarding-network');
        await clickAndSyncRedraw(ctx.page, '#e2e-onboarding-network [data-network-choice="enable"]');
        await waitFor(() => evalIn(ctx.page, `!!document.querySelector('#e2e-onboarding-network [role="alert"]')`),
          { budgetMs: 5_000, pollMs: 50 });
        rec.check('a failed choice remains visible and does not enable peer-triggered work',
          await evalIn(ctx.page, `JSON.stringify(window.__networkChoices) === JSON.stringify([
            { type:'settings/update', patch:{dwebEnabled:true} }
          ])`));
        await rec.visual('onboarding-network-save-error');
      } finally {
        await evalIn(ctx.page, `(async () => {
          const host = document.querySelector('#e2e-onboarding-network');
          if (host) { (await import('/vendor/mithril/mithril.js')).default.mount(host, null); host.remove(); }
          delete window.__networkChoices;
        })()`, true);
      }
    },
  },
  {
    name: 'onboarding-network-consent', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const available = await evalIn(ctx.page, `(async () =>
        (await import('/shared/channel-config.js')).DWEB_ENABLED)()`, true);
      if (!available) { rec.check('unsupported host does not offer network onboarding', true); return; }
      const reset = await rpc(ctx.page, { type: 'settings/reset', keys: ['dwebEnabled', 'dwebAgentEnabled'] });
      rec.check('reset leaves participation off', reset?.ok && reset.settings?.dwebEnabled === false,
        JSON.stringify(reset));
      const before = await rpc(ctx.page, { type: 'bootstrap/ready' });
      rec.check('no network lease exists before a choice', before?.ok
        && before.featureLeases?.leases?.dweb?.status !== 'active', JSON.stringify(before.featureLeases));
      const page = await openWidePage(ctx, 'home/home.html');
      try {
        await waitFor(() => evalIn(page, `!!document.querySelector('[data-network-choice="skip"]')`),
          { budgetMs: 15_000, pollMs: 50 });
        rec.check('existing users receive only the missing network step',
          await evalIn(page, `!!document.querySelector('.onboarding-network')
            && !document.querySelector('.onb-provider-row, .peer-name-input')`));
        await clickAndSyncRedraw(page, '[data-network-choice="skip"]');
        const skipped = await waitFor(async () => {
          const r = await rpc(page, { type: 'state/get' });
          return r?.state?.settings?.dwebChoiceMade === true ? r.state.settings : null;
        }, { budgetMs: 15_000, pollMs: 50 });
        rec.check('Not now persists an explicit off choice', skipped?.dwebEnabled === false, JSON.stringify(skipped));
        await page.send('Page.reload', { ignoreCache: true });
        await waitFor(() => evalIn(page, `!!document.querySelector('.home-rail')`),
          { budgetMs: 15_000, pollMs: 50 });
        rec.check('reloading does not replay a completed choice',
          await evalIn(page, `!document.querySelector('.onboarding-network')`));
        const after = await rpc(page, { type: 'bootstrap/ready' });
        rec.check('skip and reload do not start the network', after?.ok
          && after.featureLeases?.leases?.dweb?.status !== 'active', JSON.stringify(after.featureLeases));
        await evalIn(page, `location.hash = 'discover'`);
        const offDiscover = await waitFor(() => evalIn(page,
          `!!document.querySelector('[data-network-choice="enable"]') && !!document.querySelector('.home-rail')`),
        { budgetMs: 15_000, pollMs: 50 });
        rec.check('Discover remains accessible while off and offers explicit enable', !!offDiscover);
        await rec.shotPage('discover-network-off', page);
        await clickAndSyncRedraw(page, '[data-network-choice="enable"]');
        const optedIn = await waitFor(async () => {
          const r = await rpc(page, { type: 'state/get' });
          return r?.state?.settings?.dwebChoiceMade === true && r.state.settings.dwebEnabled === true
            ? r.state.settings : null;
        }, { budgetMs: 15_000, pollMs: 50 });
        rec.check('Discover enable persists only network participation, not agent work',
          optedIn?.dwebEnabled === true && optedIn.dwebAgentEnabled === false, JSON.stringify(optedIn));
        // Discover reads status once the choice lands: connected, looking or offline.
        const statusLine = '.disc-status-live[role="status"], .disc-empty-waiting [role="status"]';
        const statusVisible = await waitFor(() => evalIn(page,
          `!!document.querySelector(${JSON.stringify(statusLine)})`),
        { budgetMs: 15_000, pollMs: 50 });
        const consentUi = await evalIn(page, `({
          status: document.querySelector(${JSON.stringify(statusLine)})?.textContent?.trim().slice(0, 300) ?? null,
          enableOffered: !!document.querySelector('[data-network-choice="enable"]'),
          controls: [...document.querySelectorAll('.disc-home button')].filter(button => !button.disabled)
            .map(button => button.textContent.trim()),
          body: document.body.innerText.slice(0, 3000),
        })`);
        rec.check('connection status is separate from saved consent and leaves controls usable',
          !!statusVisible && !consentUi.enableOffered && consentUi.controls.length > 0
            && /^(Connected to \d+ (people|person)|Looking for people who share apps…|Peer network is offline)$/.test(consentUi.status ?? ''),
          JSON.stringify(consentUi));
        await rec.shotPage('discover-network-enabled', page);
        await page.send('Page.reload', { ignoreCache: true });
        await waitFor(() => evalIn(page, `!!document.querySelector('.home-rail')`),
          { budgetMs: 15_000, pollMs: 50 });
        const reloaded = await rpc(page, { type: 'state/get' });
        rec.check('explicit enable survives reload without enabling agent execution',
          reloaded?.state?.settings?.dwebEnabled === true
            && reloaded.state.settings.dwebChoiceMade === true
            && reloaded.state.settings.dwebAgentEnabled === false, JSON.stringify(reloaded?.state?.settings));
        // Discover only enables. Turning off lives in Settings and the Network view.
        await evalIn(page, `location.hash = 'network'`);
        const stopOffered = await waitFor(() => evalIn(page, `[...document.querySelectorAll('button.peerd-net-btn')]
          .some(button => button.textContent === 'Stop the network' && !button.disabled)`),
        { budgetMs: 30_000, pollMs: 50 });
        rec.check('the Network view offers Stop the network while on', !!stopOffered);
        // why replace confirm: Stop first asks in a blocking dialog. Answer yes, as the user would.
        await evalIn(page, `(() => {
          window.confirm = () => true;
          [...document.querySelectorAll('button.peerd-net-btn')].find(button => button.textContent === 'Stop the network')?.click();
        })()`);
        const disabled = await waitFor(async () => {
          const r = await rpc(page, { type: 'state/get' });
          const host = await rpc(page, { type: 'bootstrap/ready' });
          return r?.state?.settings?.dwebEnabled === false
            && !['starting', 'active'].includes(host?.featureLeases?.leases?.dweb?.status);
        }, { budgetMs: 20_000, pollMs: 50 });
        rec.check('Network view stop revokes the network lease', !!disabled);

      } finally { try { page.close(); } catch {} }
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
          const { DWEB_ENABLED } = await import('/shared/channel-config.js');
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
              : message.type === 'local-model/catalog'
                // A resident on-device model: the runner shipped, so the front
                // door must be able to show it as selectable.
                ? { ok: true, models: [{ id: 'muse-glimmer-30b', available: true }] }
                : { ok: true };
          m.mount(host, { view: () => m('.onboarding-view', m('.card.onboarding-card', [
            m(ProviderStep, { send, onDone: () => {} }),
            m('.onb-dots', { 'aria-label': DWEB_ENABLED ? 'Step 1 of 5' : 'Step 1 of 4' },
              (DWEB_ENABLED ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]).map((i) =>
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

  // --- visual: the runner row when the weights are NOT here yet --------------
  // The common first run: the engine is supported, nothing is downloaded. The
  // row has to separate that from "this browser cannot run it at all", which
  // is why it is a state and not just a unit assertion on the phase helper.
  {
    name: 'onboarding-provider-local-empty', kind: 'visual', phase: 'pre-unlock',
    responder: null,
    async run(ctx, rec) {
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { ProviderStep } = await import('/sidepanel/components/onboarding-provider-step.js');
          const host = document.createElement('div');
          host.id = 'e2e-onboarding-local-empty';
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
          document.body.appendChild(host);
          const providers = [
            { name: 'ollama', label: 'Ollama', keyless: true, liveModels: true },
            { name: 'local-webgpu', label: 'Local WebGPU', keyless: true, liveModels: false },
          ];
          const send = async (message) => message.type === 'provider/status'
            ? { ok: true, providers }
            : message.type === 'provider/test'
              ? { ok: false, error: 'unreachable' }
              : message.type === 'local-model/catalog'
                ? { ok: true, models: [{ id: 'muse-glimmer-30b', available: false, downloaded: false }] }
                : { ok: true };
          m.mount(host, { view: () => m('.onboarding-view', m('.card.onboarding-card',
            m(ProviderStep, { send, onDone: () => {} }))) });
        })()`, true);
        const rendered = await waitFor(() => evalIn(ctx.page, `(() => {
          const rows = [...document.querySelectorAll('#e2e-onboarding-local-empty .onb-provider-row')];
          if (rows.length === 0) return null;
          const runner = rows.find((r) => r.textContent.includes('On-device runner'));
          if (!runner || runner.querySelector('.onb-provider-chip')?.textContent === 'CHECKING\u2026') return null;
          return {
            rows: rows.length,
            runnerChip: runner.querySelector('.onb-provider-chip')?.textContent,
            runnerDisabled: runner.disabled,
            daemonChip: rows.find((r) => r.textContent.includes('Ollama'))
              ?.querySelector('.onb-provider-chip')?.textContent,
          };
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('an undownloaded runner says so, and stays unselectable',
          rendered?.rows === 2
            && rendered?.runnerChip === 'NOT DOWNLOADED'
            && rendered?.runnerDisabled === true
            // The unreachable daemon must NOT borrow the runner's wording.
            && rendered?.daemonChip === 'NO KEY NEEDED',
          JSON.stringify(rendered));
        await rec.visual('onboarding-provider-local-empty');
      } finally {
        await evalIn(ctx.page, `(async () => {
          const host = document.querySelector('#e2e-onboarding-local-empty');
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

  {
    name: 'starter-unknown-warning', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const base = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const phase2 = discoverSurface().phase2;
      const applyLabel = phase2 ? 'Add to Library' : 'Apply: add local copy';
      const warning = phase2
        ? 'peerd is not sure the app was added. Check your Library before you add it again.'
        : 'peerd could not confirm whether the starter was added. Check your Library before reviewing another copy.';
      const title = 'Confirm actions: ON - asks when required. Reads and quick compute can run without asking.';
      const modelCallsBefore = ctx.modelCallCount();
      await chooseFixtureNetwork(ctx, false);
      const before = await rpc(ctx.page, { type: 'state/get' });
      const permission = before?.state?.session?.permission;
      if (before?.ok !== true || before.state.session?.sessionId !== null
          || !['plan', 'act'].includes(permission?.mode) || typeof permission?.confirmActions !== 'boolean') {
        throw new Error('The original permission state is missing');
      }
      const appsBefore = await rpc(ctx.page, { type: 'apps/list' });
      if (appsBefore?.ok !== true || !Array.isArray(appsBefore.apps)) throw new Error('The Library did not load');
      const page = await openWidePage(ctx, 'tests/fixtures/starters.html?starter=csv-lab');
      try {
        const ready = await waitFor(() => evalIn(page, `(() => {
          'use strict';
          const apply = document.querySelector('.starter-review > button:first-of-type');
          return apply?.textContent === ${JSON.stringify(applyLabel)} && !apply.disabled
            && JSON.stringify(window.__starterFixtureCalls) === '["import/inspect"]';
        })()`), { budgetMs: 8_000, pollMs: 80 });
        if (!ready) throw new Error('The packaged starter inspection did not settle');
        if (!await clickAndSyncRedraw(page, '.starter-review > button:first-of-type')) {
          throw new Error('The starter Apply control is missing');
        }
        const unknown = await waitFor(() => evalIn(page, `(() => {
          'use strict';
          const alert = document.querySelector(${JSON.stringify(`.starter-review [role="${phase2 ? 'status' : 'alert'}"]`)});
          if (!alert) return null;
          return { text: alert.textContent, calls: window.__starterFixtureCalls,
            apply: [...document.querySelectorAll('.starter-review button')]
              .some(button => button.textContent === ${JSON.stringify(applyLabel)}) };
        })()`), { budgetMs: 8_000, pollMs: 80 });
        rec.observe('actual starter warning', unknown);
        rec.check('one real inspection and one refused Apply leave no Apply control',
          unknown?.apply === false
            && JSON.stringify(unknown.calls) === '["import/inspect","import/apply"]', JSON.stringify(unknown));
        rec.check('the starter outcome remains unconfirmed',
          unknown?.text?.includes(phase2 ? 'not sure the app was added' : 'could not confirm') === true
            && !unknown.text.includes('starter was not added'), JSON.stringify(unknown));
        if (!base) rec.check('the starter warning gives no Refresh or replay assurance', unknown?.text === warning);
        // why: this existing fixture inspects real packaged bytes but has no mutation authority.
        await rec.visualPage('starter-unknown-warning', page);
      } finally { await page.close(); }
      await ctx.page.send('Page.bringToFront');
      try {
        if (permission.mode !== 'act') await clickAndSyncRedraw(ctx.page, '.planact-mode:last-child');
        const actReady = await waitFor(async () => {
          const current = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.permission;
          return current?.mode === 'act' && current.confirmActions === permission.confirmActions
            && await evalIn(ctx.page, `document.querySelector('.planact-confirm')?.disabled === false`);
        }, { budgetMs: 8_000, pollMs: 80 });
        if (!actReady) throw new Error('The actual Act control did not settle');
        if (!permission.confirmActions) await clickAndSyncRedraw(ctx.page, '.planact-confirm');
        const confirmed = await waitFor(async () => {
          const current = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.permission;
          return current?.mode === 'act' && current.confirmActions === true
            && await evalIn(ctx.page, `document.querySelector('.planact-confirm')?.getAttribute('aria-pressed') === 'true'
              && document.querySelector('.planact-confirm')?.disabled === false`);
        }, { budgetMs: 8_000, pollMs: 80 });
        if (!confirmed) throw new Error('The actual Confirm control did not settle');
        const control = await evalIn(ctx.page, `(() => {
          'use strict';
          const button = document.querySelector('.planact-confirm');
          return { text: button?.textContent, title: button?.title,
            pressed: button?.getAttribute('aria-pressed'), disabled: button?.disabled };
        })()`);
        rec.observe('actual Confirm DOM title, not tooltip pixels', control);
        rec.check('the real Confirm control is on and enabled',
          control?.text === 'Confirm: on' && control.pressed === 'true' && control.disabled === false);
        if (!base) rec.check('the Confirm title names the compute exception', control?.title === title);
        await rec.visual('confirm-script-exception');
      } finally {
        const current = (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.permission;
        if (current?.mode !== 'act') throw new Error('Permission restoration has no known Act state');
        if (current.confirmActions !== permission.confirmActions) {
          await clickAndSyncRedraw(ctx.page, '.planact-confirm');
          const restored = await waitFor(async () =>
            (await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.permission?.confirmActions === permission.confirmActions,
          { budgetMs: 8_000, pollMs: 80 });
          if (!restored) throw new Error('The original Confirm choice did not return');
        }
        if (permission.mode !== 'act') await clickAndSyncRedraw(ctx.page, '.planact-mode:first-child');
        const restored = await waitFor(async () => {
          const state = (await rpc(ctx.page, { type: 'state/get' }))?.state;
          return state?.session?.permission?.mode === permission.mode
            && state.session.permission.confirmActions === permission.confirmActions;
        }, { budgetMs: 8_000, pollMs: 80 });
        if (!restored) throw new Error('The original permission mode did not return');
      }
      const after = await rpc(ctx.page, { type: 'state/get' });
      const appsAfter = await rpc(ctx.page, { type: 'apps/list' });
      rec.check('the copy review creates no App, session or model request',
        appsAfter?.ok === true && Array.isArray(appsAfter.apps)
          && JSON.stringify(appsAfter.apps.map(app => app.id).sort()) === JSON.stringify(appsBefore.apps.map(app => app.id).sort())
          && after?.state?.session?.sessionId === before.state.session.sessionId && ctx.modelCallCount() === modelCallsBefore);
      rec.check('the real controls restore the original permission choice',
        after?.state?.session?.permission?.mode === permission.mode
          && after.state.session.permission.confirmActions === permission.confirmActions);
    },
  },

  // --- visual: a goal run mid-flight (goal bar + plan todo card) --------------
  {
    name: 'goal-ended-recovery', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, modelResponder: () => ({ sse: sseText('Other chat ready.') }) });
      try {
        await unlockAndReady(child.page);
        const settings = await rpc(child.page, { type: 'settings/update', patch: { autoMemoryEnabled: false } });
        if (!settings?.ok) throw new Error('Goal fixture settings refused');
        const panelUrl = await evalIn(child.page, 'location.href');
        const send = async (text, goal = false) => {
          if (!await waitFor(() => evalIn(child.page, `!!document.querySelector('form.input-bar textarea')`))) throw new Error('Goal composer did not mount');
          if (goal && !await clickAndSyncRedraw(child.page, '.goal-toggle[aria-pressed="false"]')) throw new Error('Goal toggle did not arm');
          await evalIn(child.page, `(() => { 'use strict';
            const input = document.querySelector('form.input-bar textarea'); input.value = ${JSON.stringify(text)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          if (!await waitFor(() => evalIn(child.page, `document.querySelector('.send-btn')?.disabled === false`))) throw new Error('Goal composer stayed disabled');
          await clickAndSyncRedraw(child.page, '.send-btn');
        };
        await send('Keep this separate chat open.');
        const otherId = await waitFor(async () => {
          const result = await rpc(child.page, { type: 'state/get' });
          return result?.ok && result.state.session.messages.some((message) => message.content === 'Other chat ready.') ? result.state.session.sessionId : null;
        });
        if (!otherId) throw new Error('separate chat did not persist');
        const reset = await rpc(child.page, { type: 'session/reset' });
        if (!reset?.ok) throw new Error('fresh Goal chat refused');
        let waiting = false;
        child.setModelResponder(async (index) => {
          if (index === 2) { waiting = true; await held; }
          // why: exercise the turn cap with active work, independently of the
          // separate guard that stops consecutive text-only continuations.
          return { sse: index % 2 === 0
            ? sseToolCall('read_memory', { scope: 'user' })
            : sseText('Continue the requested work.') };
        });
        await send('Continue until the Goal turn limit stops this run.', true);
        if (!await waitFor(() => waiting, { budgetMs: 20_000, pollMs: 50 })) throw new Error('Goal did not reach its held turn');
        const running = await rpc(child.page, { type: 'state/get' });
        const goalId = running?.state?.session?.sessionId;
        const limit = await evalIn(child.page, `Number(document.querySelector('.goal-bar-meta')?.textContent.split(' / ')[1])`);
        if (!goalId || goalId === otherId || !Number.isSafeInteger(limit) || limit < 3) throw new Error('Goal ownership or turn limit is missing');
        if (!(await rpc(child.page, { type: 'session/switch', sessionId: otherId }))?.ok) throw new Error('switch away from Goal refused');
        await child.page.send('Page.navigate', { url: 'about:blank' });
        if (!await waitFor(() => evalIn(child.page, `location.href === 'about:blank'`))) throw new Error('panel document did not close');
        release();
        if (!await waitFor(() => child.modelCallCount() === limit * 2, { budgetMs: 60_000, pollMs: 80 })) throw new Error('closed Goal did not reach its real turn limit');
        const completedModelCalls = child.modelCallCount();
        await sleep(500);
        await child.page.send('Page.navigate', { url: panelUrl });
        await reloadReadyPanel(child, { expectedSessionId: otherId });
        rec.check('the other chat does not show the Goal stop reason', await evalIn(child.page, `![...document.querySelectorAll('.notice-text')].some((node) => node.textContent.startsWith('Goal run stopped'))`));
        if (!(await rpc(child.page, { type: 'session/switch', sessionId: goalId }))?.ok) throw new Error('return to Goal chat refused');
        const readReason = async () => {
          const result = await rpc(child.page, { type: 'state/get' });
          if (!result?.ok || result.state?.session?.sessionId !== goalId) return null;
          return { note: result.state.session.goalStopNote ?? null,
            notices: await evalIn(child.page, `[...document.querySelectorAll('.notice-text')].map((node) => node.textContent).filter((text) => text.startsWith('Goal run stopped'))`) };
        };
        const returned = process.env.PEERD_VISUAL_BASE_RENDER === '1' ? await readReason()
          : await waitFor(async () => { const value = await readReason(); return value?.note && value.notices.length === 1 ? value : null; });
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Goal end after close and switch', returned);
        else rec.check('the returned Goal chat shows its exact durable reason once', returned?.notices.length === 1
          && returned.note.text === `Goal run stopped after reaching the ${limit}-turn limit.`);
        await rec.visualPage('goal-ended-returned', child.page);
        await reloadReadyPanel(child, { expectedSessionId: goalId });
        const reopened = await readReason();
        if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') rec.check('a new panel document replays the same reason once', reopened?.note?.id === returned?.note?.id && reopened?.notices.length === 1);
        const [otherSession, goalSession] = await Promise.all([otherId, goalId].map((sessionId) =>
          rpc(child.page, { type: 'session/get', sessionId })));
        if (otherSession?.session?.sessionId !== otherId || goalSession?.session?.sessionId !== goalId
            || otherSession.session.provider !== goalSession.session.provider
            || otherSession.session.model !== goalSession.session.model) throw new Error('cold chats have different provider inputs');
        if (!(await rpc(child.page, { type: 'session/switch', sessionId: otherId }))?.ok) throw new Error('cold fixture chat switch refused');
        const oldWorker = await child.stopServiceWorker();
        const newWorker = await child.restartServiceWorker(oldWorker);
        const posture = await rpc(child.page, { type: 'state/get' });
        if (!posture?.ok) throw new Error('cold state read refused');
        if (posture.state.vault.locked && !(await rpc(child.page, { type: 'vault/unlock', passphrase: PASSPHRASE }))?.ok) throw new Error('cold Goal vault unlock refused');
        if (!await waitFor(() => evalIn(child.page, `!!document.querySelector('form.input-bar')`))) throw new Error('cold Goal panel did not mount');
        // Finish provider work in the other chat before the first cold Goal projection.
        await evalIn(child.page, `import('/vendor/mithril/mithril.js').then(({ default: m }) => m.mount(document.querySelector('#app'), null))`, true);
        if (!(await rpc(child.page, { type: 'session/switch', sessionId: otherId }))?.ok) throw new Error('cold route preparation failed');
        if (!(await rpc(child.page, { type: 'models/options', sessionId: otherId }))?.ok) throw new Error('cold model options failed');
        const warm = await waitFor(async () => {
          const value = await rpc(child.page, { type: 'state/get' });
          return value?.ok && value.state.session.sessionId === otherId
            && value.state.composer?.canSend === true ? value.state : null;
        });
        if (!warm) throw new Error('cold provider preparation failed');
        const before = await rpc(child.page, { type: 'bootstrap/ready' });
        const leases = before?.featureLeases;
        const baseline = leases?.leases?.controller;
        if (!before?.ok || leases?.schema !== 1 || typeof leases.kernelEpoch !== 'string'
            || !leases.kernelEpoch || !Number.isSafeInteger(baseline?.generation)
            || baseline.status !== 'revoked') throw new Error('cold provider preparation did not release its controller');
        if (!(await rpc(child.page, { type: 'session/switch', sessionId: goalId }))?.ok) throw new Error('cold Goal chat switch refused');
        const isolated = await rpc(child.page, { type: 'state/get' });
        const after = await rpc(child.page, { type: 'bootstrap/ready' });
        const controller = after?.featureLeases?.leases?.controller;
        rec.check('cold Goal-note hydration does not acquire a controller', isolated?.ok === true
          && isolated.state.session.sessionId === goalId
          && isolated.state.composer.provider === warm.composer.provider
          && isolated.state.composer.model === warm.composer.model
          && isolated.state.composer.canSend === true
          && (process.env.PEERD_VISUAL_BASE_RENDER === '1' || isolated.state.session.goalStopNote?.id === returned?.note?.id)
          && after?.ok === true && after.featureLeases?.schema === 1
          && after.featureLeases.kernelEpoch === leases.kernelEpoch
          && controller?.generation === baseline.generation && controller?.status === baseline.status,
        JSON.stringify({ before: before?.featureLeases, after: after?.featureLeases }));
        await reloadReadyPanel(child, { expectedSessionId: goalId });
        const restarted = process.env.PEERD_VISUAL_BASE_RENDER === '1' ? await readReason()
          : await waitFor(async () => { const value = await readReason(); return value?.notices.length === 1 ? value : null; });
        rec.check('worker restart preserves chat ownership without another model call',
          newWorker.targetId !== oldWorker.targetId && child.modelCallCount() === completedModelCalls,
          JSON.stringify({ completedModelCalls, afterRestartModelCalls: child.modelCallCount() }));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Goal end after worker restart', restarted);
        else rec.check('worker restart replays the durable reason once', restarted?.note?.id === returned?.note?.id && restarted?.notices.length === 1);
        await rec.visualPage('goal-ended-recovery', child.page);
        child.setModelResponder(() => ({ sse: sseText('The new user turn is complete.') }));
        await send('Start a new user turn in this chat.');
        if (!await waitFor(() => evalIn(child.page, `document.body.textContent.includes('The new user turn is complete.')`))) throw new Error('new user turn did not settle');
        const cleared = await readReason();
        rec.check('the next real user send clears the old Goal reason', cleared?.note === null && cleared?.notices.length === 0);
      } finally { release(); await child.close(); }
    },
  },
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

  {
    name: 'composer-palette', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      try {
        await evalIn(ctx.page, `(() => {
          const input = document.querySelector('form.input-bar textarea');
          input.focus(); input.value = '/'; input.setSelectionRange(1, 1);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const listed = await waitFor(() => evalIn(ctx.page,
          `!!document.querySelector('.command-palette')`), { budgetMs: 5_000, pollMs: 50 });
        if (!listed) throw new Error('The slash palette did not render');
        const builtins = await evalIn(ctx.page,
          `JSON.stringify([...document.querySelectorAll('.palette-label')].slice(0, 3).map((el) => el.textContent))
            === JSON.stringify(['/init', '/system', '/tools'])`);
        if (baseRender) rec.observe('merge-base command list', { builtins });
        else rec.check('the slash palette lists the three worker commands first', builtins);
        await rec.visual('composer-palette-commands');
        await evalIn(ctx.page, `(() => {
          const input = document.querySelector('form.input-bar textarea');
          input.value = '/zzzz'; input.setSelectionRange(5, 5);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const empty = await waitFor(() => evalIn(ctx.page,
          `document.querySelector('.palette-empty')?.textContent === 'No matching commands'`),
        { budgetMs: 5_000, pollMs: 50 });
        if (!empty) throw new Error('The no-match palette did not render');
        const noMissingOption = await evalIn(ctx.page,
          `!document.querySelector('form.input-bar textarea').hasAttribute('aria-activedescendant')`);
        if (baseRender) rec.observe('merge-base empty option', { noMissingOption });
        else rec.check('an empty palette names no missing active option', noMissingOption);
        await rec.visual('composer-palette-no-match');
        await ctx.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await evalIn(ctx.page, `import('/vendor/mithril/mithril.js').then(({ default: m }) => m.redraw.sync())`, true);
        const escaped = await evalIn(ctx.page,
          `!document.querySelector('.command-palette')
            && document.querySelector('form.input-bar textarea').value === '/zzzz'`);
        if (baseRender) rec.observe('merge-base Escape', { escaped });
        else rec.check('Escape stays closed after keyup and keeps the draft', escaped);
      } finally {
        await evalIn(ctx.page, `(() => {
          const input = document.querySelector('form.input-bar textarea');
          input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      }
    },
  },
  {
    name: 'reasoning-disclosure', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      try {
        await evalIn(ctx.page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { MessageList } = await import('/sidepanel/components/message-list.js');
          const host = document.createElement('div');
          host.id = 'e2e-reasoning';
          // why fixed: the fixture must cover the live panel for the capture.
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
          document.body.appendChild(host);
          m.mount(host, { view: () => m(MessageList, { messages: [{
            id: 'reasoning-reply', role: 'assistant', content: 'The saved files are ready.',
            thinking: 'I will check the saved files before I give the result.',
          }] }) });
          host.querySelector('.reasoning-header').focus();
        })()`, true);
        const nativeButton = await evalIn(ctx.page, `(() => {
          const button = document.querySelector('#e2e-reasoning .reasoning-header');
          return button.tagName === 'BUTTON' && button === document.activeElement
            && button.getAttribute('aria-expanded') === 'false';
        })()`);
        if (baseRender) rec.observe('merge-base reasoning control', { nativeButton });
        else rec.check('Reasoning is a focused native button with a collapsed state', nativeButton);
        await rec.visual('reasoning-disclosure-focused');
        // why click on the base: its disclosure is a div. Capture that same
        // expanded content without requiring the branch's new keyboard path.
        if (baseRender) await clickAndSyncRedraw(ctx.page, '#e2e-reasoning .reasoning-header');
        else {
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        const expanded = await waitFor(() => evalIn(ctx.page,
          `!!document.querySelector('#e2e-reasoning .reasoning-body')`), { budgetMs: 3_000, pollMs: 50 });
        if (baseRender) rec.check('the old disclosure opens for the expanded capture', !!expanded);
        else rec.check('Enter opens Reasoning', !!expanded);
        await rec.visual('reasoning-disclosure-expanded');
        if (!baseRender) {
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
          const collapsed = await waitFor(() => evalIn(ctx.page,
            `document.querySelector('#e2e-reasoning .reasoning-header')?.getAttribute('aria-expanded') === 'false'`),
          { budgetMs: 3_000, pollMs: 50 });
          rec.check('Space closes Reasoning', !!collapsed);
        }
      } finally {
        await evalIn(ctx.page, `(async () => {
          const host = document.getElementById('e2e-reasoning');
          if (host) { (await import('/vendor/mithril/mithril.js')).default.mount(host, null); host.remove(); }
        })()`, true);
      }
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
    // Stop and observe its terminal UI before handing the shared browser back.
    responder: () => ({ delayMs: 60_000, sse: sseText('…') }),
    async run(ctx, rec) {
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'plan a fix for the failing test' });
      if (sent?.ok !== true) throw new Error(`Busy fixture turn refused: ${JSON.stringify(sent)}`);
      try {
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`), { budgetMs: 10_000, pollMs: 50 })) {
          throw new Error('Busy fixture did not reach its live turn');
        }
        await rec.visual('busy-thinking');
      } finally {
        const stopped = await rpc(ctx.page, { type: 'agent/stop' });
        if (stopped?.ok !== true) throw new Error(`Busy fixture Stop refused: ${JSON.stringify(stopped)}`);
        if (!await waitFor(async () => !(await probe(ctx)).busy, { budgetMs: 20_000, pollMs: 50 })) {
          throw new Error('Busy fixture did not publish its terminal turn state');
        }
      }
    },
  },

  {
    name: 'context-inspector-keyboard', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('CONTEXT-KEYBOARD-DONE') }),
    async run(ctx, rec) {
      const before = await rpc(ctx.page, { type: 'state/get' });
      if (!before?.ok || !before.state?.settings) throw new Error('Context baseline read refused');
      try {
        if (!(await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true, autoMemoryEnabled: false } }))?.ok) throw new Error('Context dev mode refused');
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Capture this real model turn for the context inspector.' });
        if (sent?.ok !== true) throw new Error(`Context fixture turn refused: ${JSON.stringify(sent)}`);
        if (!await waitFor(() => evalIn(ctx.page, `document.querySelector('.message-assistant .bubble')?.textContent.trim() === 'CONTEXT-KEYBOARD-DONE' && !document.querySelector('form.input-bar button.stop')`))) throw new Error('Context turn did not settle');
        const current = await rpc(ctx.page, { type: 'state/get' });
        const snapshots = await rpc(ctx.page, { type: 'session/contextSnapshots', sessionId: current?.state?.session?.sessionId });
        if (!snapshots?.ok || !snapshots.snapshots?.some((snapshot) => snapshot.label === 'main')) throw new Error('real model snapshot is missing');
        const calls = ctx.modelCallCount();
        await evalIn(ctx.page, `(() => { 'use strict'; const trigger = document.querySelector('.debug-export-btn'); trigger.focus(); trigger.click(); })()`);
        if (!await waitFor(() => evalIn(ctx.page, `[...document.querySelectorAll('.debug-menu-item')].some((button) => button.textContent === 'context inspector')`))) throw new Error('real Context menu item is missing');
        await evalIn(ctx.page, `[...document.querySelectorAll('.debug-menu-item')].find((button) => button.textContent === 'context inspector').click()`);
        if (!await waitFor(() => evalIn(ctx.page, `[...document.querySelectorAll('.ctx-snap-label')].some((label) => label.textContent === 'main')`))) throw new Error('real Context snapshot did not render');
        const dialog = await evalIn(ctx.page, `(() => { 'use strict'; const dialog = document.querySelector('.context-inspector');
          return { role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal'), title: dialog.getAttribute('aria-labelledby'),
            closeFocused: document.activeElement === dialog.querySelector('.ctx-close'), menuClosed: !document.querySelector('.debug-menu') }; })()`);
        rec.check('Context opens its real snapshot with the debug menu closed', dialog.menuClosed);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Context dialog focus and name', dialog);
        else rec.check('Context opens a named modal with Close focused', dialog.role === 'dialog' && dialog.modal === 'true'
          && dialog.title === 'context-inspector-title' && dialog.closeFocused, JSON.stringify(dialog));
        await checkAccessibleNames(ctx.page, rec, 'Context and Close expose their accessible names', [
          ['.context-inspector', 'context inspector', 'dialog'], ['.context-inspector .ctx-close', 'Close'],
        ]);
        await evalIn(ctx.page, `document.querySelector('.context-inspector .ctx-snap-summary').click()`);
        if (!await waitFor(() => evalIn(ctx.page, `document.querySelector('.context-inspector .ctx-snap')?.open === true`))) throw new Error('real Context snapshot did not expand');
        await evalIn(ctx.page, `document.querySelector('.context-inspector .ctx-close').focus()`);
        await pressNativeKey(ctx.page, 'Tab', true);
        const reverse = await evalIn(ctx.page, `document.activeElement === [...document.querySelectorAll('.context-inspector summary')].filter((node) => node.getClientRects().length).at(-1)`);
        await pressNativeKey(ctx.page, 'Tab');
        const forward = await evalIn(ctx.page, `document.activeElement === document.querySelector('.context-inspector .ctx-close')`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Context native Tab', { reverse, forward });
        else rec.check('native Tab includes expanded summaries and stays in Context', reverse && forward);
        await rec.visualPage('context-inspector-keyboard', ctx.page, { beforeShot: () => evalIn(ctx.page, `(() => { 'use strict';
          for (const meta of document.querySelectorAll('.ctx-snap-meta')) meta.textContent = meta.textContent.replace(/ · [^·]+$/, ' · 12:00:00'); })()`) });
        await pressNativeKey(ctx.page, 'Escape');
        const escaped = await waitFor(() => evalIn(ctx.page, `!document.querySelector('.context-inspector')`), { budgetMs: 1_000, pollMs: 40 });
        const returned = await evalIn(ctx.page, `document.activeElement === document.querySelector('.debug-export-btn')`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Context native Escape', { escaped, returned });
        else rec.check('Escape closes Context and returns focus to the persistent debug button', escaped && returned);
        if (!escaped) await evalIn(ctx.page, `document.querySelector('.ctx-close').click()`);
        rec.check('Context inspection makes no extra model call and leaves its menu closed', ctx.modelCallCount() === calls
          && await evalIn(ctx.page, `!document.querySelector('.context-inspector, .debug-menu')`));
      } finally {
        await evalIn(ctx.page, `document.querySelector('.ctx-close')?.click()`);
        if (!(await rpc(ctx.page, { type: 'settings/update', patch: { devMode: before.state.settings.devMode, autoMemoryEnabled: before.state.settings.autoMemoryEnabled } }))?.ok) throw new Error('Context settings restore refused');
      }
    },
  },

  // --- visual: the sessions / chats list -------------------------------------
  {
    name: 'sessions-list', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // why: an old assistant bubble is not completion of the newly requested
      // turn. Prove each accepted turn persisted before resetting its session.
      const expected = [];
      for (const text of ['summarize the three PRs I opened today', 'spin up a linux VM and run uname -a']) {
        const reset = await rpc(ctx.page, { type: 'session/reset' });
        if (reset?.ok !== true) throw new Error(`sessions-list reset refused: ${JSON.stringify(reset)}`);
        const empty = await waitFor(async () => {
          const state = await rpc(ctx.page, { type: 'state/get' });
          const view = await probe(ctx);
          return state?.ok === true && !state.state?.session?.sessionId
            && !view.userText && !view.assistantText && !view.busy;
        }, { budgetMs: 20_000 });
        if (!empty) throw new Error('sessions-list reset did not reach an empty session');
        const sent = await rpc(ctx.page, { type: 'agent/send', text });
        rec.check(`session fixture turn accepted: ${text}`, sent?.ok === true, JSON.stringify(sent));
        if (sent?.ok !== true) throw new Error('sessions-list fixture turn refused');
        let lastObservation = null;
        const persisted = await waitFor(async () => {
          const state = await rpc(ctx.page, { type: 'state/get' });
          const sessionId = state?.state?.session?.sessionId;
          const view = await probe(ctx);
          // The user container also includes the visible role label "you".
          // Match the message bubble itself, just as the assistant probe does.
          const userText = await evalIn(ctx.page, `document.querySelector('.message-user .bubble')?.textContent.trim() ?? null`);
          lastObservation = { stateOk: state?.ok === true, sessionId, busy: view.busy,
            userMatches: userText === text, assistantMatches: view.assistantText === 'noted',
            errorPresent: !!view.errorText };
          if (!sessionId || view.busy || userText !== text || view.assistantText !== 'noted') return null;
          const reply = await rpc(ctx.page, { type: 'session/debugBundle', sessionId });
          const messages = reply?.bundle?.session?.messages ?? [];
          const userPersisted = messages.some(message => message.role === 'user' && message.content === text);
          const assistantPersisted = messages.some(message => message.role === 'assistant' && message.content === 'noted');
          lastObservation = { ...lastObservation, bundleOk: reply?.ok === true,
            messageCount: messages.length, userPersisted, assistantPersisted };
          return reply?.ok === true && userPersisted && assistantPersisted ? { sessionId, title: text } : null;
        }, { budgetMs: 20_000 });
        rec.check(`session fixture turn persisted: ${text}`, !!persisted, JSON.stringify(lastObservation));
        if (!persisted) throw new Error('sessions-list exact fixture turn did not persist');
        expected.push(persisted);
      }
      const listed = await rpc(ctx.page, { type: 'session/list' });
      const complete = listed?.ok === true && new Set(expected.map(row => row.sessionId)).size === 2
        && expected.every(row => listed.sessions?.some(session => session.sessionId === row.sessionId
          && session.title === row.title && session.messageCount >= 2 && !session.archived));
      rec.check('both exact fixture sessions remain in the persisted list', complete, JSON.stringify(listed?.sessions));
      if (!complete) throw new Error('sessions-list persisted fixture rows are missing');
      await evalIn(ctx.page, `document.querySelector('.topbar-actions button[title="Chats"]')?.click()`);
      const visible = await waitFor(() => evalIn(ctx.page, `(() => {
        const titles = [...document.querySelectorAll('.sessions-list .session-title')].map(row => row.textContent.trim());
        return ${JSON.stringify(expected.map(row => row.title))}.every(title => titles.includes(title));
      })()`), { budgetMs: 8_000, pollMs: 50 });
      rec.check('both persisted fixture sessions render before capture', !!visible);
      if (!visible) throw new Error('sessions-list expected rows did not render');
      const titles = await evalIn(ctx.page, `[...document.querySelectorAll('.sessions-list .session-title')].map((row) => row.textContent.trim())`);
      await checkAccessibleNames(ctx.page, rec, 'Archive names identify each persisted chat', expected.map((row) => [
        `.sessions-list .session-row:nth-child(${titles.indexOf(row.title) + 1}) .session-archive`, `Archive chat “${row.title}”`,
      ]));
      await rec.visual('sessions-list');
      // Return to the chat view for later states.
      await evalIn(ctx.page, `document.querySelector('.topbar-actions button[title="Chats"]')?.click()`);
    },
  },

  // --- visual: an expanded tool-call card (the lineage body) -----------------
  {
    name: 'tool-card-expanded', kind: 'visual', phase: 'post-unlock',
    responder: (callIndex) => callIndex === 0
      ? { sse: sseToolCall('actor_list', {}) }
      : { sse: sseText('The available actor targets are listed above.') },
    async run(ctx, rec) {
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
      // why: page reads belong to a web actor, so the main-turn example must
      // exercise a real owned tool instead of photographing an ownership refusal.
      await rpc(ctx.page, { type: 'agent/send', text: 'list the available actor targets' });
      const settled = await waitFor(() => evalIn(ctx.page, `(() => {
        const card = document.querySelector('.tool-call.tool-ok');
        return card?.querySelector('.tool-name')?.textContent === 'actor_list'
          && !document.querySelector('form.input-bar button.stop');
      })()`), { budgetMs: 20_000, pollMs: 50 });
      rec.check('the expanded example is a successfully executed owned tool', settled === true);
      if (!settled) throw new Error('actor_list did not settle successfully');
      await clickAndSyncRedraw(ctx.page, '.tool-call-header');
      const expanded = await waitFor(() => evalIn(ctx.page, `(() => {
        const detail = document.querySelector('.tool-detail');
        return detail?.querySelector('.primitive-badge')?.textContent === 'spawned'
          && detail?.querySelector('.tool-result-content')?.textContent.includes('actor_execution');
      })()`), { budgetMs: 5_000, pollMs: 50 });
      const executed = (await auditEntries(ctx)).some((entry) => !priorAuditIds.has(entry.id)
        && entry.type === 'tool_executed' && entry.details?.tool === 'actor_list');
      rec.check('the expanded card renders known lineage and its audited result', expanded === true && executed,
        JSON.stringify({ expanded, executed }));
      if (!expanded || !executed) throw new Error('actor_list result or audit is missing');
      const roster = await evalIn(ctx.page, `JSON.parse(document.querySelector('.tool-result-content').textContent)`);
      // why: actor_list deliberately reports partial source failures as data;
      // an ok tool card must not hide a broken directory source in this fixture.
      const complete = Array.isArray(roster?.unavailable ?? []) && (roster?.unavailable ?? []).length === 0;
      rec.check('the actor directory has no unexpected unavailable sources', complete, JSON.stringify(roster?.unavailable ?? []));
      if (!complete) throw new Error('actor_list returned an unavailable directory source');
      await rec.visual('tool-card-expanded');
    },
  },

  {
    name: 'home-chat-authority', kind: 'functional', phase: 'post-unlock',
    responder: async (callIndex) => {
      if (callIndex > 0) await homeSurfaceGate;
      return { sse: sseText(callIndex === 0 ? 'HOME-COMPOSER-REPLY' : 'HOME-STOPPED-REPLY-MUST-NOT-RENDER') };
    },
    async run(ctx, rec) {
      const panelUrl = await evalIn(ctx.page, 'location.href');
      let page = null;
      let releaseLive = () => {};
      homeSurfaceGate = new Promise((resolve) => { releaseLive = resolve; });
      const requireCheck = (name, pass, detail = '') => {
        rec.check(name, pass, detail);
        if (!pass) throw new Error(name);
      };
      try {
        // why: Home authority requires a real tab, not a native side-panel
        // frame navigated to its URL. Retire the panel document to release its
        // chat port, then open the actual Home tab without forging presence.
        await ctx.page.send('Page.navigate', { url: 'about:blank' });
        const released = await waitFor(() => evalIn(ctx.page, `location.href === 'about:blank'`)
          .catch(() => false), { budgetMs: 5_000, pollMs: 50 });
        if (!released) throw new Error('Home fixture did not release the side-panel document');
        page = await openWidePage(ctx, 'home/home.html#chat');
        const homeContext = { ...ctx, page };
        const mounted = await waitFor(() => evalIn(page,
          `!!document.querySelector('.home-chat form.input-bar textarea')`).catch(() => false), { budgetMs: 20_000, pollMs: 80 });
        const homeSurface = await evalIn(page, `({
          url: location.href, boot: { ...document.documentElement.dataset },
          activeView: document.querySelector('[data-home-view][aria-current="page"]')?.getAttribute('data-home-view'),
          text: document.querySelector('#app')?.textContent?.slice(0, 500),
        })`);
        requireCheck('the real Home document owns the chat composer', mounted === true, JSON.stringify(homeSurface));
        await evalIn(page, `(() => {
          const editor = document.querySelector('.home-chat form.input-bar textarea');
          editor.value = 'HOME-COMPOSER-MESSAGE';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.closest('form').requestSubmit();
        })()`);
        const answered = await waitFor(async () => {
          const view = await probe(homeContext);
          return view.userText?.includes('HOME-COMPOSER-MESSAGE')
            && view.assistantText === 'HOME-COMPOSER-REPLY' && !view.busy && !view.errorText;
        }, { budgetMs: 20_000, pollMs: 80 });
        requireCheck('Home composer sends a real turn and renders its answer', answered === true);
        const composerAfterSend = await evalIn(page, `(() => ({
          value: document.querySelector('.home-chat form.input-bar textarea')?.value,
          sendDisabled: document.querySelector('.home-chat form.input-bar .send-btn')?.disabled,
          leakedDrafts: Object.keys(localStorage).filter((key) => key.startsWith('peerd.draft.')
            && (localStorage.getItem(key) ?? '').includes('HOME-COMPOSER-MESSAGE')),
        }))()`);
        rec.check('a confirmed Home send leaves the composer and its saved draft empty',
          composerAfterSend?.value === '' && composerAfterSend.sendDisabled === true
            && composerAfterSend.leakedDrafts?.length === 0, JSON.stringify(composerAfterSend));
        const state = await rpc(page, { type: 'state/get' });
        const sessionId = state?.state?.session?.sessionId;
        requireCheck('Home observes the bound live session', typeof sessionId === 'string' && sessionId.length > 0);
        const diagnostic = await rpc(page, { type: 'session/debugBundle', sessionId });
        requireCheck('Home exports the actual chat diagnostic transcript', diagnostic?.ok === true
          && diagnostic.bundle?.format === 'peerd-debug-bundle'
          && JSON.stringify(diagnostic.bundle?.session?.messages).includes('HOME-COMPOSER-REPLY'),
        JSON.stringify({ ok: diagnostic?.ok, error: diagnostic?.error, format: diagnostic?.bundle?.format }));
        const callsBeforeProbe = ctx.modelCallCount();
        const recovery = await rpc(page, { type: 'actor-isolation/retry' });
        requireCheck('Home recovery runs only the fixed isolated-worker readiness probe', recovery?.ok === true
          && recovery.capability?.status === 'available' && ctx.modelCallCount() === callsBeforeProbe,
        JSON.stringify(recovery));
        const catalog = await rpc(page, { type: 'local-model/catalog' });
        const local = await rpc(page, { type: 'local-model/status' });
        requireCheck('Home reads the default local-model catalog and status without downloading', catalog?.ok === true
          && Array.isArray(catalog.models) && catalog.models.length > 0
          && local?.ok === true && local.loading === false && local.downloaded === false,
        JSON.stringify({ catalog, local }));
        const customCatalog = await rpc(page, { type: 'local-model/catalog', includeSupport: false });
        const customStatus = await rpc(page, { type: 'local-model/status', model: local.model });
        requireCheck('Home cannot parameterize the default local-model reads',
          customCatalog?.error === 'vault-route-unauthorized-sender'
            && customStatus?.error === 'vault-route-unauthorized-sender', JSON.stringify({ customCatalog, customStatus }));

        const operationId = `send.${Date.now().toString(36)}.${crypto.randomUUID()}`;
        const sent = await rpc(page, { type: 'agent/send', text: 'HOME-LIVE-STOP', sessionId, operationId });
        requireCheck('Home admits a live turn with an exact delivery receipt', sent?.ok === true, JSON.stringify(sent));
        const busy = await waitFor(async () => ctx.modelCallCount() === 2
          && await evalIn(page, `!!document.querySelector('.home-chat form.input-bar button.stop')`),
        { budgetMs: 15_000, pollMs: 80 });
        requireCheck('the second Home turn reaches the model while Stop is available', busy === true);
        const receipt = await rpc(page, { type: 'agent/send', checkOnly: true, sessionId, operationId });
        requireCheck('Home checkOnly keeps a live outcome unknown without resending', receipt?.ok === false
          && receipt.outcomeKnown === false && receipt.retryable === false
          && receipt.operationId === operationId && ctx.modelCallCount() === 2, JSON.stringify(receipt));
        await clickAndSyncRedraw(page, '.home-chat form.input-bar button.stop');
        const stopped = await waitFor(async () => {
          const view = await probe(homeContext);
          return !view.busy && view.stopChip && !view.errorText;
        }, { budgetMs: 15_000, pollMs: 80 });
        requireCheck('the real Home Stop control settles its live turn', stopped === true);
        releaseLive();
        await sleep(750);
        requireCheck('Home Stop never renders or replays the held reply', ctx.modelCallCount() === 2
          && await evalIn(page, `!document.body.textContent.includes('HOME-STOPPED-REPLY-MUST-NOT-RENDER')`));
        const settledReceipt = await waitFor(async () => {
          const reply = await rpc(page, { type: 'agent/send', checkOnly: true, sessionId, operationId });
          return reply?.ok === true && reply.duplicate === true ? reply : null;
        }, { budgetMs: 10_000, pollMs: 80 });
        requireCheck('Home confirms the receipt only after its stopped turn settles',
          settledReceipt?.operationId === operationId && ctx.modelCallCount() === 2,
          JSON.stringify(settledReceipt));
        await rec.shotPage('home-chat-stopped', page);
      } finally {
        if (page) await rpc(page, { type: 'agent/stop' }).catch(() => {});
        releaseLive();
        homeSurfaceGate = Promise.resolve();
        if (page) await retirePrivateTransferPage(page);
        await ctx.page.send('Page.navigate', { url: panelUrl });
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
        const restored = await waitFor(() => evalIn(ctx.page,
          `document.documentElement.dataset.peerdBootStage === 'app-ready' && !!document.querySelector('.input-bar textarea')`).catch(() => false),
        { budgetMs: 20_000, pollMs: 80 });
        if (!restored) throw new Error('Home fixture did not restore the live side panel');
      }
    },
  },

  // --- functional: Home > Chats by keyboard, and the live chat header -------
  // Chats is Home's default view when no panel is open. A row must open with
  // Enter (a real <button>), its delete control must be a named sibling that
  // shows on keyboard focus, and the header must carry the session title (the
  // state snapshot used to drop it, so the header always read "New chat").
  {
    name: 'home-chat-list-keyboard', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      const panelUrl = await evalIn(ctx.page, 'location.href');
      const sendChat = async (text) => {
        const sent = await rpc(ctx.page, { type: 'agent/send', text });
        if (!sent?.ok) throw new Error(`agent/send failed: ${JSON.stringify(sent)}`);
        await waitFor(async () => { const o = await probe(ctx); return o.assistantText && !o.busy; }, { budgetMs: 20_000 });
      };
      await sendChat('alpha chat about tides');
      await rpc(ctx.page, { type: 'session/reset' });
      await waitFor(async () => !(await rpc(ctx.page, { type: 'state/get' }))?.state?.session?.sessionId, { budgetMs: 10_000, pollMs: 80 });
      await sendChat('beta chat about bread');
      let page = null;
      try {
        await releasePanelDocument(ctx);
        page = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-shell' });
        const listed = await waitFor(() => evalIn(page, `document.querySelectorAll('.chat-list-item').length >= 2`), { budgetMs: 15_000, pollMs: 80 });
        rec.check('Home lists both chats', !!listed);
        const header = () => evalIn(page, `document.querySelector('.home-chat-title')?.textContent ?? null`);
        const activeTitle = () => evalIn(page, `document.querySelector('.chat-list-item.is-active .chat-list-item-title')?.textContent ?? null`);
        const titles = { header: await header(), active: await activeTitle() };
        rec.check('the chat header carries the live session title',
          titles.header === 'beta chat about bread' && titles.active === 'beta chat about bread', JSON.stringify(titles));
        // Real Tabs from "+ New chat": the first row, its delete control, the second row.
        await evalIn(page, `document.querySelector('button.chat-list-new').focus()`);
        for (let i = 0; i < 3; i++) await pressKey(page, 'Tab');
        const focused = await evalIn(page, `(() => {
          const a = document.activeElement;
          const row = a?.closest('.chat-list-item');
          const del = row?.querySelector('.chat-item-del');
          return { tag: a?.tagName ?? null, inRow: !!row, active: !!row?.classList.contains('is-active'),
            nested: !!a?.querySelector?.('.chat-item-del'), delOpacity: del ? getComputedStyle(del).opacity : null,
            delLabel: del?.getAttribute('aria-label') ?? null, title: row?.querySelector('.chat-list-item-title')?.textContent ?? null };
        })()`);
        rec.check('Tab reaches the older chat as a real button that does not swallow its delete control',
          focused.tag === 'BUTTON' && focused.inRow && !focused.active && !focused.nested && focused.title === 'alpha chat about tides',
          JSON.stringify(focused));
        rec.check('keyboard focus reveals the delete control, named per chat',
          focused.delOpacity === '1' && /^Delete chat “.+”$/.test(focused.delLabel ?? ''), JSON.stringify(focused));
        const beforeId = (await rpc(page, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
        await pressKey(page, 'Enter');
        const switched = await waitFor(async () => {
          const id = (await rpc(page, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
          return id && id !== beforeId ? id : null;
        }, { budgetMs: 8_000, pollMs: 80 });
        rec.check('Enter on a chat row switches the live session', !!switched, JSON.stringify({ beforeId, switched }));
        const headerFollows = await waitFor(async () => (await header()) === 'alpha chat about tides', { budgetMs: 8_000, pollMs: 80 });
        rec.check('the header follows the switched chat', !!headerFollows, JSON.stringify(await header()));
        await rec.shotPage('home-chat-list-keyboard', page);
      } finally {
        if (page) await retirePrivateTransferPage(page);
        await restorePanelDocument(ctx, panelUrl);
      }
    },
  },

  // --- functional: Home keeps the view you chose around the side panel -------
  // A panel the user opened must survive a return to Home (only a card-opened
  // panel auto-closes), and closing the panel after navigating must not yank
  // Home back to Chats.
  {
    name: 'home-panel-navigation', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      const panelUrl = await evalIn(ctx.page, 'location.href');
      const view = (page) => evalIn(page, `document.querySelector('main.home-content')?.className.replace('home-content home-content--', '') ?? null`);
      const panelBar = (page) => evalIn(page, `!!document.querySelector('.home-panel-bar')`);
      let page = null;
      let blank = null;
      try {
        await releasePanelDocument(ctx);
        page = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-shell' });
        rec.check('Home owns Chat while no panel is connected', (await view(page)) === 'chat' && !(await panelBar(page)));
        // The panel comes back (its port connects): Home hands Chat over.
        await restorePanelDocument(ctx, panelUrl);
        const handed = await waitFor(async () => (await panelBar(page)) && (await view(page)) !== 'chat', { budgetMs: 8_000, pollMs: 80 });
        rec.check('an open panel takes Chat and Home drops to a tool view', !!handed, JSON.stringify({ view: await view(page) }));
        await clickAndSyncRedraw(page, '[data-home-view="library"]');
        rec.check('Library opens beside the panel', (await view(page)) === 'library');
        // Leave for another tab and come back: a panel the user opened stays.
        blank = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
        const blankPage = await attach(blank.webSocketDebuggerUrl);
        await blankPage.send('Page.enable');
        await blankPage.send('Page.bringToFront');
        const hidden = await waitFor(() => evalIn(page, `document.visibilityState === 'hidden'`), { budgetMs: 5_000, pollMs: 50 });
        await page.send('Page.bringToFront');
        const visible = await waitFor(() => evalIn(page, `document.visibilityState === 'visible'`), { budgetMs: 5_000, pollMs: 50 });
        blankPage.close();
        rec.check('Home went hidden and came back', !!hidden && !!visible);
        await sleep(1_000);
        const surfaces = await rpc(page, { type: 'surfaces/get' }).catch(() => null);
        const returned = { surfaces, view: await view(page), panelBar: await panelBar(page) };
        rec.check('a panel the user opened stays open when Home returns',
          surfaces?.sidePanelOpen === true && returned.panelBar && returned.view === 'library', JSON.stringify(returned));
        // Closing the panel now keeps Library instead of yanking Home to Chats.
        await releasePanelDocument(ctx);
        const closed = await waitFor(async () => !(await panelBar(page)), { budgetMs: 8_000, pollMs: 80 });
        await sleep(300);
        rec.check('closing the panel keeps the view the user navigated to', !!closed && (await view(page)) === 'library', JSON.stringify({ view: await view(page) }));
        await rec.shotPage('home-panel-navigation', page);
      } finally {
        if (blank) await fetch(`http://127.0.0.1:${ctx.port}/json/close/${blank.id}`).catch(() => {});
        if (page) await retirePrivateTransferPage(page);
        await restorePanelDocument(ctx, panelUrl);
      }
    },
  },

  // --- functional: a card-opened side panel closes when you return to Home ---
  // "Go ↗" on a "peerd opened a tab" card opens the side panel to follow the
  // agent's tab. Coming back to Home must close that panel and hand Chat back,
  // while a panel the user opened stays (home-panel-navigation). The close is
  // the real one, which destroys the browser-owned panel document, so the
  // harness reopens the panel for the states that follow.
  {
    name: 'home-card-panel-return', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => (callIndex === 0
      ? { sse: sseToolCall('open_tab', {}) }
      : { sse: sseText('The tab is open.') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      // why the sync redraw: a hidden tab gets no animation frame, so commit
      // Mithril's scheduled redraw before reading Home's DOM.
      const snap = async (page) => ({
        sidePanelOpen: (await rpc(page, { type: 'surfaces/get' }).catch(() => null))?.sidePanelOpen ?? null,
        ...(await evalIn(page, `import('/vendor/mithril/mithril.js').then(({ default: m }) => {
          m.redraw.sync();
          return {
            view: document.querySelector('main.home-content')?.className.replace('home-content home-content--', '') ?? null,
            panelBar: !!document.querySelector('.home-panel-bar'),
            visibility: document.visibilityState,
          };
        })`, true)),
      });
      const homeOwnsChat = async (page) => {
        const s = await snap(page);
        return s.sidePanelOpen === false && s.view === 'chat' && !s.panelBar;
      };
      let page = null;
      let tabsBefore = null;
      try {
        page = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-shell' });
        tabsBefore = await evalIn(page, `chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))`, true);
        // Bring the chat home first: the live panel closes for real.
        await rpc(page, { type: 'sidepanel/close' });
        const owned = await waitFor(() => homeOwnsChat(page), { budgetMs: 8_000, pollMs: 80 });
        rec.check('closing the panel hands Chat to Home', !!owned, JSON.stringify(await snap(page)));
        const sent = await rpc(page, { type: 'agent/send', text: 'Open a blank tab for me.' });
        rec.check('agent/send accepted from Home', !!sent?.ok, JSON.stringify(sent));
        const card = await waitFor(() => evalIn(page, `!!document.querySelector('.agent-tab-notice-go')`), { budgetMs: 20_000, pollMs: 80 });
        const settled = await waitFor(() => evalIn(page,
          `!document.querySelector('.message-assistant.streaming') && !document.querySelector('form.input-bar button.stop')`),
        { budgetMs: 20_000, pollMs: 80 });
        rec.check('the opened-tab card renders on Home', !!card && !!settled);
        await page.send('Page.bringToFront');
        await waitFor(() => evalIn(page, `document.visibilityState === 'visible'`), { budgetMs: 5_000, pollMs: 50 });
        // Go: a real click, since the gesture is what lets Home open the panel.
        await realClick(page, '.agent-tab-notice-go');
        const followed = await waitFor(async () => {
          const s = await snap(page);
          return s.visibility === 'hidden' && s.sidePanelOpen === true && s.panelBar;
        }, { budgetMs: 15_000, pollMs: 80 });
        rec.check('Go opens the side panel and leaves Home for the agent tab', !!followed, JSON.stringify(await snap(page)));
        const returnedAt = Date.now();
        await page.send('Page.bringToFront');
        const closed = await waitFor(() => homeOwnsChat(page), { budgetMs: 3_000, pollMs: 50 });
        rec.check('returning to Home closes the card-opened panel and Chat is back',
          !!closed, JSON.stringify({ ...(await snap(page)), afterMs: Date.now() - returnedAt }));
        await rec.shotPage('home-card-panel-return', page);
      } finally {
        if (page) {
          if (tabsBefore) {
            await evalIn(page, `(async () => {
              const before = new Set(${JSON.stringify(tabsBefore)});
              const tabs = await chrome.tabs.query({});
              await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && !before.has(tab.id))
                .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
            })()`, true).catch(() => {});
          }
          await retirePrivateTransferPage(page);
        }
        const panelAlive = await evalIn(ctx.page, 'true').then(() => true, () => false);
        if (!panelAlive) {
          await ctx.reopenNativePanel();
          await awaitLivePanel(ctx);
        }
      }
    },
  },

  // --- functional: the Home notifications bell (preview, network on) --------
  // The bell's menu is a disclosure: Escape closes it and returns focus to the
  // bell, focus leaving the bell area closes it, and at narrow widths (the rail
  // is a top bar) it opens below the bell inside the viewport, not above the window.
  {
    name: 'home-notifications-menu', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, true);
      let page = null;
      try {
        page = await openWidePage(ctx, 'home/home.html#library', { ready: '.home-shell' });
        const bellShown = await waitFor(() => evalIn(page, `!!document.querySelector('.notif-bell')`), { budgetMs: 15_000, pollMs: 80 });
        rec.check('the notifications bell renders with the network on', !!bellShown);
        // Three feed entries, broadcast the way the dweb base host emits them.
        for (let i = 0; i < 3; i++) {
          await evalIn(ctx.page, `chrome.runtime.sendMessage({ type: 'dweb/notify', notification: {
            id: 'e2e-notif-${i}', ts: Date.now(), kind: 'peer', title: 'New peer connected', body: 'peer e2e-${i}', link: 'network',
          } }).catch(() => null)`, true);
        }
        const fed = await waitFor(() => evalIn(page,
          `import('/shared/peer-notifications.js').then(({ peerNotifications }) => peerNotifications.list().length >= 3)`, true),
        { budgetMs: 5_000, pollMs: 50 });
        rec.check('the feed holds the three entries', !!fed);
        const snap = () => evalIn(page, `({
          open: !!document.querySelector('.notif-menu'), items: document.querySelectorAll('.notif-item').length,
          expanded: document.querySelector('.notif-bell')?.getAttribute('aria-expanded') ?? null,
          onBell: document.activeElement === document.querySelector('.notif-bell'),
          active: document.activeElement?.className ?? null,
        })`);
        await evalIn(page, `document.querySelector('.notif-bell').focus()`);
        await pressKey(page, 'Enter');
        const opened = await waitFor(async () => (await snap()).open, { budgetMs: 3_000, pollMs: 50 });
        rec.check('Enter on the bell opens the menu', !!opened, JSON.stringify(await snap()));
        await pressKey(page, 'Escape');
        await waitFor(async () => !(await snap()).open, { budgetMs: 3_000, pollMs: 50 });
        const afterEscape = await snap();
        rec.check('Escape closes the menu and returns focus to the bell',
          !afterEscape.open && afterEscape.onBell && afterEscape.expanded === 'false', JSON.stringify(afterEscape));
        if (!(await snap()).open) await clickAndSyncRedraw(page, '.notif-bell');
        await evalIn(page, `document.querySelector('.notif-bell').focus()`);
        await waitFor(async () => (await snap()).open, { budgetMs: 3_000, pollMs: 50 });
        await evalIn(page, `document.querySelector('.home-rail-lock').focus()`);
        await waitFor(async () => !(await snap()).open, { budgetMs: 3_000, pollMs: 50 });
        const afterFocusOut = await snap();
        rec.check('focus leaving the bell area closes the menu', !afterFocusOut.open, JSON.stringify(afterFocusOut));
        // Narrow window: the rail is a top bar and the menu must open inside the viewport.
        if ((await snap()).open) await clickAndSyncRedraw(page, '.notif-bell');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
        const narrow = await waitFor(() => evalIn(page, `matchMedia('(max-width: 620px)').matches`), { budgetMs: 3_000, pollMs: 50 });
        await clickAndSyncRedraw(page, '.notif-bell');
        const menuBox = await waitFor(() => evalIn(page, `(() => {
          const menu = document.querySelector('.notif-menu');
          if (!menu) return null;
          const r = menu.getBoundingClientRect();
          const items = [...menu.querySelectorAll('.notif-item')];
          const usable = items.filter((it) => {
            const b = it.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + b.height / 2;
            return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && it.contains(document.elementFromPoint(x, y));
          }).length;
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
            items: items.length, usable, vw: innerWidth, vh: innerHeight };
        })()`), { budgetMs: 3_000, pollMs: 50 });
        rec.check('at 600px the menu opens inside the viewport with every item usable',
          !!narrow && !!menuBox && menuBox.top >= 0 && menuBox.bottom <= menuBox.vh && menuBox.left >= 0 && menuBox.right <= menuBox.vw
            && menuBox.items >= 3 && menuBox.usable === menuBox.items, JSON.stringify(menuBox));
        await rec.shotPage('home-notifications-menu-narrow', page);
      } finally {
        if (page) {
          await evalIn(page, `import('/shared/peer-notifications.js').then(({ peerNotifications }) => peerNotifications.clear())`, true).catch(() => {});
          await retirePrivateTransferPage(page);
        }
        await chooseFixtureNetwork(ctx, false);
      }
    },
  },

  // --- visual (WIDE): the full-tab home SPA — the large in-browser view -------
  // Opened as its own browser tab (1280 wide), not the 400px side panel. The
  // vault is already unlocked in the SW, so home boots to its SPA.
  {
    name: 'home-fulltab', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      const page = await openWidePage(ctx, 'home/home.html');
      try {
        // Wait past the boot vault-gate/onboarding flash to the home surface.
        await waitFor(() => evalIn(page,
          `!!document.querySelector('.home-shell, .home-rail, .empty-state--home, .path-menu--home')`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        // Packaged starters now require an explicit action. Home rendering
        // must not wait for an automatic Commons installation that no longer occurs.
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

  // --- visual (WIDE): live Actor Space topology + boundary inspector --------
  // Keep two real temporary workers blocked at the model wire while Home renders
  // the authoritative cross-heap projection. No fixture-only UI or direct state
  // injection: this is the same actor_create -> actors/overview path users see.
  {
    name: 'actor-space-live', kind: 'visual', phase: 'post-unlock',
    responder: async (_callIndex, request) => {
      const body = request?.postData ?? '';
      if (body.includes('<actor_agent>') && body.includes('visual isolated worker')) {
        actorOverviewVisualState.actorCalls += 1;
        await actorOverviewVisualState.liveGate;
        return { sse: sseText('VISUAL-ACTOR-DONE') };
      }
      if (body.includes('ACTOR-SPACE-VISUAL-ROOT')) {
        if (!actorOverviewVisualState.started) {
          actorOverviewVisualState.started = true;
          return { sse: sseToolCalls([1, 2].map((index) => ({
            name: 'actor_create',
            args: { task: `visual isolated worker ${index}: inspect release risk`, tools: [] },
          }))) };
        }
        return { sse: sseText('Two isolated workers are active.') };
      }
      return { sse: sseText('noted') };
    },
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      let releaseLive = () => {};
      const liveGate = new Promise((resolve) => { releaseLive = resolve; });
      actorOverviewVisualState = { started: false, actorCalls: 0, liveGate };
      let page = null;
      try {
        const sent = await rpc(ctx.page, {
          type: 'agent/send', text: 'ACTOR-SPACE-VISUAL-ROOT inspect the release risk',
        });
        rec.check('the visual actor topology turn was accepted', sent?.ok === true,
          JSON.stringify(sent));
        const live = await waitFor(() => actorOverviewVisualState.actorCalls >= 2,
          { budgetMs: 20_000, pollMs: 80 });
        rec.check('two real isolated workers reached their model wire for the camera',
          !!live, `actorCalls=${actorOverviewVisualState.actorCalls}`);

        page = await openWidePage(ctx, 'home/home.html#actors', { ready: '.home-shell' });
        const rendered = await waitFor(() => evalIn(page, `(() => {
          const space = document.querySelector('.actor-space');
          const nodes = [...document.querySelectorAll('.actor-space-node')];
          if (!space || nodes.length < 3) return null;
          return { nodes: nodes.length, text: space.textContent ?? '' };
        })()`), { budgetMs: 20_000, pollMs: 80 });
        rec.check('the visual lane renders the live topology',
          rendered?.nodes >= 3
            && rendered?.text.includes('visual isolated worker 1')
            && rendered?.text.includes('visual isolated worker 2'),
          JSON.stringify(rendered));
        const state = await rpc(page, { type: 'state/get' });
        const isolation = state?.state?.capabilities?.actorExecution;
        rec.check('Actor Space projects the live isolated-worker health',
          isolation?.status === 'available'
            && isolation?.host === 'offscreen-document-worker'
            && await evalIn(page, `!document.querySelector('.actor-isolation-banner')`),
          JSON.stringify(isolation));
        await evalIn(page, `document.querySelector('.actor-space-node.is-subactor')?.click()`);
        const inspectorReady = await waitFor(() => evalIn(page, `(() => {
          const inspector = document.querySelector('.actor-space-inspector');
          return inspector?.textContent?.includes('Dedicated keyless worker') === true;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('the visual lane opens the physical boundary inspector', inspectorReady === true);
        await rec.visualPage('actor-space-live', page);
      } finally {
        await rpc(ctx.page, { type: 'agent/stop' }).catch(() => null);
        releaseLive();
        try { page?.close(); } catch { /* */ }
      }
    },
  },

  // Rename fields render on both revisions. The head checks the new focus rules.
  {
    name: 'home-contacts-rename', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, true);
      // The RFC 8032 public key keeps this saved contact and its avatar stable.
      const did = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';
      const page = await openWidePage(ctx, 'home/home.html#contacts', { ready: '.home-shell' });
      try {
        const saved = await rpc(page, { type: 'contacts/set', did, name: 'Rename review' });
        rec.check('the contact is saved through the real route', saved?.ok === true, JSON.stringify(saved));
        const ready = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.contact-row')]
          .some((row) => row.querySelector('.peerd-disc-name')?.textContent === 'Rename review')`),
        { budgetMs: 15_000, pollMs: 80 });
        if (!ready) throw new Error('the saved contact did not render');
        await evalIn(page, `[...document.querySelectorAll('.contact-row')]
          .find((row) => row.querySelector('.peerd-disc-name')?.textContent === 'Rename review')
          .querySelector('[title="Edit name"]').click()`);
        const editing = await waitFor(() => evalIn(page,
          `document.querySelector('.contact-name-input')?.value === 'Rename review'
            && document.activeElement === document.querySelector('.contact-name-input')`),
        { budgetMs: 5_000, pollMs: 50 });
        rec.check('Contacts opens its focused name field', !!editing);
        await rec.visualPage('home-contacts-rename', page, { beforeShot: () => evalIn(page,
          `import('/shared/peer-notifications.js').then(({ peerNotifications }) => peerNotifications.clear())`, true) });
        await pressKey(page, 'Escape');
        rec.check('Escape leaves the saved contact name unchanged',
          (await rpc(page, { type: 'contacts/list' }))?.contacts?.find((contact) => contact.did === did)?.name === 'Rename review');
      } finally {
        await rpc(page, { type: 'contacts/forget', did }).catch(() => {});
        await retirePrivateTransferPage(page);
        await chooseFixtureNetwork(ctx, false);
      }
    },
  },
  {
    name: 'home-library-rename', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await captureHomeLibraryGit(ctx, rec, { visualName: 'home-library-rename', rename: true });
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

  // Real Explore component with a controlled catalog. Both themes and widths
  // show the tile grid; an older tree shows its signed-hint filters instead.
  ...[false, true].map(narrow => ({
    name: narrow ? 'home-explore-narrow' : 'home-explore', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const { flow, phase2, plain, names } = discoverSurface();
      const page = await openExtPage(ctx, 'tests/fixtures/explore.html');
      try {
        // why 1400 narrow: the Your apps row and the search label sit above the one-column tiles.
        await page.send('Emulation.setDeviceMetricsOverride', {width:narrow ? 320 : 960,height:narrow ? 1400 : 760,deviceScaleFactor:1,mobile:false});
        const ready = await waitFor(() => evalIn(page, `document.querySelectorAll('.disc-card').length === 3`), {budgetMs:8000,pollMs:80});
        const fullView = await evalIn(page, `(() => {
          const cards = [...document.querySelectorAll('.disc-card')];
          return cards.length === 3 && cards.every(card => {
            const rect = card.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
          });
        })()`);
        rec.check('Explore renders all publisher claims including legacy unknown in full view', ready === true && fullView === true);
        await rec.visualPage(narrow ? 'home-explore-narrow' : 'home-explore', page);
        if (flow) {
          // why the tree's own label: the merge-base tree renders its own words.
          const pick = (label) => evalIn(page, `(async () => {
            [...document.querySelectorAll('.disc-pill')].find(pill => pill.textContent === ${JSON.stringify(label)}).click();
            (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
            return [...document.querySelectorAll('.disc-tile-name')].map(node => node.textContent);
          })()`, true);
          rec.check('From people you know keeps only the saved contact’s app',
            JSON.stringify(await pick(phase2 ? 'From people you know' : 'From contacts')) === JSON.stringify(['Field notes']));
          rec.check('Updates is empty while every installed app is current', (await pick('Updates')).length === 0
            && await evalIn(page, `document.body.textContent.includes(${JSON.stringify(plain ? 'No updates right now' : 'No matching apps')})`));
          const included = await pick(phase2 ? 'Comes with peerd' : 'Included');
          rec.check('Comes with peerd lists both packaged starters and Chat rooms', names
            ? JSON.stringify(included) === JSON.stringify(['Tables and charts', 'Desaturator', 'Chat rooms'])
            : included.length === 3 && included.includes('Peerd-to-Peerd Commons'));
          rec.check('All restores every shared app', (await pick('All')).length === 3);
          rec.check('Explore controls and cards fit the viewport',
            await evalIn(page, `document.documentElement.scrollWidth <= innerWidth`));
          return;
        }
        await evalIn(page, `(() => {const filter=document.querySelector('select');filter.value='yes';filter.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        const filtered = await waitFor(() => evalIn(page, `document.querySelectorAll('.disc-card').length === 1 && document.querySelector('.disc-name')?.textContent === 'Orbit lab'`), {budgetMs:4000,pollMs:50});
        rec.check('WebAssembly filter selects the declared module App', filtered === true);
        await rec.visualPage(narrow ? 'home-explore-wasm-narrow' : 'home-explore-wasm', page);
        // The head harness also captures older merge-base extension surfaces.
        // Only that explicit baseline run may lack the newly added control.
        const libraryPresent = await evalIn(page, `!!document.querySelector('[aria-label="Library filter"]')`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1' && !libraryPresent) {
          rec.check('Merge-base Explore predates the Library filter', true);
        } else {
          const libraryReady = await waitFor(() => evalIn(page,
            `document.querySelector('[aria-label="Library filter"]')?.disabled === false`), {budgetMs:4000,pollMs:50});
          rec.check('Library filter is ready after reading local Apps', libraryReady === true);
          if (libraryReady) {
            await evalIn(page, `(() => {
              const wasm=document.querySelector('[aria-label="WebAssembly content"]');
              wasm.value='all';wasm.dispatchEvent(new Event('change',{bubbles:true}));
              const library=document.querySelector('[aria-label="Library filter"]');
              library.value='uninstalled';library.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
            const unfamiliar = await waitFor(() => evalIn(page, `(() => {
              const names=[...document.querySelectorAll('.disc-name')].map(node=>node.textContent);
              return names.length===2 && names.includes('Field notes') && names.includes('Pixel garden');
            })()`), {budgetMs:4000,pollMs:50});
            rec.check('Library filter excludes the locally installed App', unfamiliar === true);
            await rec.visualPage(narrow ? 'home-explore-uninstalled-narrow' : 'home-explore-uninstalled', page);
          }
        }
        const fits = await evalIn(page, `document.documentElement.scrollWidth <= innerWidth`);
        rec.check('Explore controls and cards fit the viewport', fits === true);
      } finally { try {page.close();} catch { /* */ } }
    },
  })),
  // The Comes with peerd pill: both packaged starters and Commons as tiles, read only.
  {
    name: 'home-explore-included', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      if (!discoverSurface().flow) {
        rec.observe('merge-base surface', { present: false, reason: 'the Included filter was introduced on this branch' });
        return;
      }
      const page = await openExtPage(ctx, 'tests/fixtures/explore.html');
      try {
        await page.send('Emulation.setDeviceMetricsOverride', {width:960,height:760,deviceScaleFactor:1,mobile:false});
        if (!await waitFor(() => evalIn(page, `document.querySelectorAll('.disc-card').length === 3`), {budgetMs:8000,pollMs:80})) {
          throw new Error('Explore did not render');
        }
        // why the tree's own label: the merge-base tree renders its own words.
        const label = discoverSurface().phase2 ? 'Comes with peerd' : 'Included';
        await evalIn(page, `(async () => {
          [...document.querySelectorAll('.disc-pill')].find(pill => pill.textContent === ${JSON.stringify(label)}).click();
          (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
        })()`, true);
        // why wait for an enabled Chat rooms action: it stays off until the Library read lands.
        const add = discoverSurface().names ? 'Add and open Chat rooms' : 'Add and open Commons';
        const included = await waitFor(() => evalIn(page, `(() => {
          const metas = [...document.querySelectorAll('.disc-tile-meta')].map(node => node.textContent);
          return metas.length === 3 && metas.every(text => text === 'Comes with peerd')
            && [...document.querySelectorAll('.disc-tile-action')].some(button => button.textContent === ${JSON.stringify(add)} && !button.disabled);
        })()`), {budgetMs:4000,pollMs:50});
        rec.check('Comes with peerd lists both packaged starters and Chat rooms and sends only reads', !!included
          && await evalIn(page, `window.__exploreFixtureCalls.every(type =>
            ['apps/list', 'dweb/base/heard', 'bootstrap/ready', 'dweb/distributed/info', 'contacts/list', 'dweb/blocked-peers'].includes(type))`));
        rec.check('Explore controls and cards fit the viewport', await evalIn(page, `document.documentElement.scrollWidth <= innerWidth`));
        await rec.visualPage('home-explore-included', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // Home's own glue for a notification's app page, mounted for real: the bell
  // keeps the key, Discover answers it once and clears it, and leaving
  // Discover drops a request that still waits. One profile hears no peer app,
  // so the page answers the heard read itself; every other read is real.
  {
    name: 'home-discover-notification', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const available = await evalIn(ctx.page, `(async () =>
        (await import('/shared/channel-config.js')).DWEB_ENABLED)()`, true);
      if (!available) { rec.check('unsupported host shows no peer notifications', true); return; }
      if (!discoverSurface().flow) {
        rec.observe('merge-base surface', { present: false, reason: 'notification app pages were introduced on this branch' });
        return;
      }
      const wasOn = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings?.dwebEnabled === true;
      await chooseFixtureNetwork(ctx, true);
      const panelUrl = await evalIn(ctx.page, 'location.href');
      let panelRetired = false;
      const page = await openWidePage(ctx, 'home/home.html#library', { ready: '.notif-bell' });
      const key = 'e2e-notified-app';
      const tile = `[data-key=${JSON.stringify(key)}] .disc-tile-open`;
      const opened = `document.querySelector('.disc-app-title')?.textContent === 'Notified app'`;
      // why two frames: Home moves focus into new content one frame after it renders.
      const frames = () => evalIn(page, `new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`, true);
      const clickNotification = async () => {
        await evalIn(page, `document.querySelector('.notif-bell')?.click()`);
        const listed = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.notif-item')]
          .some(item => item.textContent.includes('Notified app'))`), { budgetMs: 5_000, pollMs: 50 });
        if (!listed) throw new Error('the notification is not in the bell');
        // A real click focuses the control first.
        await evalIn(page, `(() => {
          const item = [...document.querySelectorAll('.notif-item')].find(node => node.textContent.includes('Notified app'));
          item.focus(); item.click();
        })()`);
      };
      try {
        // why the page answers the heard read: `hold` parks the next reply.
        const stubbed = await evalIn(page, `(async () => {
          const { encodeDidKey } = await import('/shared/address/did.js');
          const publisher = encodeDidKey(new Uint8Array(32).fill(5));
          const version_id = '5'.repeat(64);
          const card = { dwapp_id: ${JSON.stringify(key)}, name: 'Notified app', slug: 'notified', seq: 1, version_id, publisher,
            uri: 'peerd://' + publisher + '/' + version_id };
          const heard = window.__e2eHeard = { card, apps: [card], hold: null, release: () => {} };
          const api = globalThis.browser ?? globalThis.chrome;
          const real = api.runtime.sendMessage.bind(api.runtime);
          const stub = (message, ...rest) => message?.type !== 'dweb/base/heard' ? real(message, ...rest)
            : (heard.hold ?? Promise.resolve()).then(() => ({ ok: true, apps: heard.apps }));
          api.runtime.sendMessage = stub;
          return api.runtime.sendMessage === stub;
        })()`, true);
        if (!stubbed) throw new Error('the page could not answer the heard read');
        // The offscreen host broadcasts this message; another extension page can too.
        await evalIn(ctx.page, `new Promise(done => chrome.runtime.sendMessage({ type: 'dweb/notify', notification: {
          id: 'app-e2e-notified', ts: Date.now(), kind: 'app', key: ${JSON.stringify(key)},
          title: 'New app to install', body: 'Notified app', link: 'discover',
        } }, () => { void chrome.runtime.lastError; done(true); }))`, true);
        const badge = await waitFor(() => evalIn(page, `!!document.querySelector('.notif-badge')`), { budgetMs: 10_000, pollMs: 50 });
        rec.check('the notification reaches the Home bell', !!badge);

        await clickNotification();
        rec.check('the bell opens the notified app page in Discover',
          !!await waitFor(() => evalIn(page, opened), { budgetMs: 10_000, pollMs: 50 }));
        await evalIn(page, `document.querySelector('.disc-back')?.click()`);
        await waitFor(() => evalIn(page, `!document.querySelector('.disc-back') && !!document.querySelector(${JSON.stringify(tile)})`),
          { budgetMs: 5_000, pollMs: 50 });
        // Discover is open now: the same notification must open its page again,
        // which it can only if Discover cleared the key it answered.
        await clickNotification();
        const reopened = await waitFor(() => evalIn(page, opened), { budgetMs: 10_000, pollMs: 50 });
        await frames();
        rec.check('an answered key is cleared, so the same notification opens its page again', !!reopened);
        rec.check('the app page keeps focus on its back link after Home moves focus',
          await evalIn(page, `!!document.activeElement?.matches('.disc-back')`),
          await evalIn(page, `document.activeElement?.outerHTML?.slice(0, 120) ?? ''`));

        // Not heard yet: the request waits for a heard read, and leaving
        // Discover before it lands drops the request.
        await evalIn(page, `document.querySelector('.disc-back')?.click()`);
        await evalIn(page, `(() => { window.__e2eHeard.apps = []; window.dispatchEvent(new Event('focus')); })()`);
        await waitFor(() => evalIn(page, `!document.querySelector(${JSON.stringify(tile)})`), { budgetMs: 5_000, pollMs: 50 });
        await evalIn(page, `window.__e2eHeard.hold = new Promise(done => { window.__e2eHeard.release = done; })`);
        await clickNotification();
        await frames();
        rec.check('a notification for an app not heard yet waits on the root',
          await evalIn(page, `!!document.querySelector('.disc-home') && !document.querySelector('.disc-back')`));
        await evalIn(page, `document.querySelector('[data-home-view="library"]')?.click()`);
        await waitFor(() => evalIn(page, `!document.querySelector('.disc-home')`), { budgetMs: 5_000, pollMs: 50 });
        await evalIn(page, `(() => {
          const heard = window.__e2eHeard;
          heard.apps = [heard.card]; heard.hold = null; heard.release();
        })()`);
        await evalIn(page, `document.querySelector('[data-home-view="discover"]')?.click()`);
        const root = await waitFor(() => evalIn(page, `!!document.querySelector(${JSON.stringify(tile)})`), { budgetMs: 10_000, pollMs: 50 });
        await frames();
        rec.check('leaving Discover drops a waiting notification, so Discover opens on its root',
          !!root && await evalIn(page, `!document.querySelector('.disc-back')`));

        // why retire the panel: only the Home chat owner can show its banner.
        panelRetired = true;
        await ctx.page.send('Page.navigate', { url: 'about:blank' });
        if (!await waitFor(() => evalIn(ctx.page, `location.href === 'about:blank'`).catch(() => false),
          { budgetMs: 5_000, pollMs: 50 })) throw new Error('notification fixture did not release the side-panel document');
        // Home adds Chats only after the surface update releases chat ownership.
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('[data-home-view="chat"]')`),
          { budgetMs: 10_000, pollMs: 50 })) throw new Error('Home did not receive chat ownership');
        await evalIn(page, `document.querySelector('[data-home-view="chat"]').click()`);
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('.home-chat form.input-bar textarea')`),
          { budgetMs: 20_000, pollMs: 80 })) throw new Error('Home chat did not show its composer');
        await evalIn(ctx.swConn, `new Promise(done => chrome.runtime.sendMessage({ type: 'dweb/notify', notification: {
          id: 'app-e2e-banner', ts: Date.now(), kind: 'app', key: ${JSON.stringify(key)},
          title: 'New app to install', body: 'Notified app', link: 'discover',
        } }, () => { void chrome.runtime.lastError; done(true); }))`, true);
        if (!await waitFor(() => evalIn(page, `document.querySelector('.notif-banner .home-popout')?.textContent === 'View in Discover'`),
          { budgetMs: 5_000, pollMs: 50 })) throw new Error('Home chat did not show the app notification');
        await evalIn(page, `(() => { const button = document.querySelector('.notif-banner .home-popout'); button.focus(); button.click(); })()`);
        const bannerOpened = !!await waitFor(() => evalIn(page, opened), { budgetMs: 10_000, pollMs: 50 });
        if (!bannerOpened) {
          // why: distinguish lost navigation from a missing heard reply without recording chat contents.
          rec.observe('notification banner navigation failure', await evalIn(page, `({
            href: location.href, visibility: document.visibilityState,
            discoverRoot: !!document.querySelector('.disc-home'),
            appTitle: document.querySelector('.disc-app-title')?.textContent ?? null,
            chatPresent: !!document.querySelector('.home-chat'),
            fixturePresent: window.__e2eHeard?.apps?.some(app => app.dwapp_id === ${JSON.stringify(key)}) === true,
            fixtureHeld: !!window.__e2eHeard?.hold,
          })`));
        }
        rec.check('the chat banner opens the notified app page in Discover', bannerOpened);
      } finally {
        try { await page.close(); } catch { /* */ }
        if (panelRetired) {
          await ctx.page.send('Page.navigate', { url: panelUrl });
          await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
          if (!await waitFor(() => evalIn(ctx.page,
            `document.documentElement.dataset.peerdBootStage === 'app-ready' && !!document.querySelector('.input-bar textarea')`).catch(() => false),
          { budgetMs: 20_000, pollMs: 80 })) throw new Error('notification fixture did not restore the side panel');
        }
        if (!wasOn) await chooseFixtureNetwork(ctx, false);
      }
    },
  },

  // Blocking a maker, for real: only the exact Home page may change the stored
  // policy, Contacts lists what it stores, and Unblock there undoes it.
  {
    name: 'home-block-maker', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const available = await evalIn(ctx.page, `(async () =>
        (await import('/shared/channel-config.js')).DWEB_ENABLED)()`, true);
      if (!available) { rec.check('unsupported host has no maker block', true); return; }
      if (!discoverSurface().blocks) {
        rec.observe('merge-base surface', { present: false, reason: 'blocking a maker was introduced on this branch' });
        return;
      }
      const wasOn = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings?.dwebEnabled === true;
      await chooseFixtureNetwork(ctx, true);
      const maker = await evalIn(ctx.page, `(async () =>
        (await import('/shared/address/did.js')).encodeDidKey(new Uint8Array(32).fill(6)))()`, true);
      const key = JSON.stringify(maker.slice(-8));
      const page = await openWidePage(ctx, 'home/home.html#contacts');
      try {
        rec.check('a first-party page other than Home cannot block a maker',
          (await rpc(ctx.page, { type: 'dweb/peer-block', did: maker }))?.error === 'kernel-route-unauthorized');
        rec.check('neither can it read the blocked list',
          (await rpc(ctx.page, { type: 'dweb/blocked-peers' }))?.error === 'kernel-route-unauthorized');
        const blocked = await rpc(page, { type: 'dweb/peer-block', did: maker });
        rec.check('Home blocks a maker by the full did, and the policy is stored', blocked?.durable === true, JSON.stringify(blocked));
        rec.check('the stored list names the blocked maker',
          (await rpc(page, { type: 'dweb/blocked-peers' }))?.blocked?.includes(maker) === true);
        // Contacts reads the list on its own poll.
        const listed = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.contacts-blocked-row')]
          .some(row => row.textContent.includes(${key}))`), { budgetMs: 10_000, pollMs: 100 });
        rec.check('Contacts lists the blocked maker', !!listed);
        await evalIn(page, `(() => {
          const row = [...document.querySelectorAll('.contacts-blocked-row')].find(node => node.textContent.includes(${key}));
          const button = row?.querySelector('button');
          button?.focus(); button?.click();
        })()`);
        const unblocked = await waitFor(() => evalIn(page, `document.querySelector('.contacts-unblocked')?.textContent
          === 'After you unblock someone, their apps show up again the next time peerd hears from them.'`), { budgetMs: 10_000, pollMs: 100 });
        rec.check('Unblock in Contacts says when their apps come back', !!unblocked);
        rec.check('the stored list no longer names them',
          (await rpc(page, { type: 'dweb/blocked-peers' }))?.blocked?.includes(maker) === false);
      } finally {
        try { await rpc(page, { type: 'dweb/peer-unblock', did: maker }); } catch { /* the check above reports it */ }
        try { await page.close(); } catch { /* */ }
        if (!wasOn) await chooseFixtureNetwork(ctx, false);
      }
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

        // A tile's Update opens that app's page and sends the update there.
        await evalIn(page, `
          [...document.querySelectorAll('.disc-card button')]
            .find((button) => button.textContent === 'Update')?.click()
        `);
        // why the footnote: the installed line is a status too, and it comes first.
        const discoverWarning = await waitFor(() => evalIn(page, `
          document.querySelector('.disc-panel .disc-footnote[role="status"]')?.textContent ?? ''
        `), { budgetMs: 4_000, pollMs: 50 });

        await evalIn(page, `
          [...document.querySelectorAll('.library-card button')]
            .find((button) => button.textContent === 'Update')?.click()
        `);
        const warningLayout = await waitFor(() => evalIn(page, `(() => {
          const statuses = [
            document.querySelector('section[aria-labelledby="library-warning-heading"] p.muted[role="status"]'),
            document.querySelector('.disc-panel .disc-footnote[role="status"]'),
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
        // why two wordings: Discover says in plain words that the old version is still shared.
        rec.check('Library and Discover render both committed warning details',
          warningText.includes('security audit entry could not be written')
            && (warningLayout?.texts?.[0] ?? '').includes('Older shared bytes will be cleaned up')
            && (warningLayout?.texts?.[1] ?? '').includes('peerd still shares the old version.'),
          JSON.stringify({ discoverWarning, warningLayout }));
        // why its own check: only the Library says the words above.
        rec.check('Discover says in plain words that the security log missed the update',
          (warningLayout?.texts?.[1] ?? '').includes('peerd could not add it to the security log.'),
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
  // why: the idle Providers capture cannot show a refused test. Keep the real
  // page and inventory, but fix this one reply so the image needs no API key.
  {
    name: 'options-provider-test-429', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html');
      try {
        await waitFor(() => evalIn(page, `document.querySelector('.provider-card') !== null`),
          { budgetMs: 15_000, pollMs: 80 });
        await evalIn(page, `(async () => {
          const m = (await import('/vendor/mithril/mithril.js')).default;
          const { OptionsApp } = await import('/options/components/options-app.js');
          const { makeUiRuntimeClient } = await import('/shared/ui-runtime-client.js');
          const browser = (await import('/shared/browser-api.js')).default;
          const client = makeUiRuntimeClient({ browser });
          const snapshot = await client.send({ type: 'state/get' });
          const status = await client.send({ type: 'provider/status' });
          if (!snapshot?.state || !Array.isArray(status?.providers)) {
            // why: retain bounded reply classifications, never account state or
            // provider/key data, when native controller startup refuses a fixture.
            const classify = reply => ({ ok: reply?.ok === true,
              code: typeof reply?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(reply.code) ? reply.code : null,
              phase: ['startup', 'pre-dispatch'].includes(reply?.phase) ? reply.phase : null,
              outcomeKnown: typeof reply?.outcomeKnown === 'boolean' ? reply.outcomeKnown : null });
            throw new Error('provider fixture snapshot missing: ' + JSON.stringify({
              snapshot: { ...classify(snapshot), hasState: !!snapshot?.state },
              status: { ...classify(status), hasProviders: Array.isArray(status?.providers) },
            }));
          }
          const state = snapshot.state;
          state.providers = { ...state.providers, current: 'anthropic', hasKey: true };
          state.settings = { ...state.settings, providerName: 'anthropic', providerModel: '' };
          const providers = status.providers.map(provider => provider.name === 'anthropic'
            ? { ...provider, hasKey: true } : provider);
          const send = message => message.type === 'provider/status'
            ? Promise.resolve({ ok: true, providers })
            : message.type === 'provider/test' && message.provider === 'anthropic'
              ? Promise.resolve({ ok: false, error: 'http-429' })
              : client.send(message);
          const root = document.getElementById('app');
          m.mount(root, null);
          m.mount(root, { view: () => m(OptionsApp, { state, send, section: 'providers' }) });
        })()`, true);
        const clicked = await waitFor(() => evalIn(page, `(() => {
          const card = [...document.querySelectorAll('.provider-card')]
            .find(node => node.querySelector('.provider-card-name')?.textContent === 'Anthropic');
          const button = [...(card?.querySelectorAll('button') ?? [])]
            .find(node => node.textContent === 'Test');
          if (!button) return false;
          button.click();
          return true;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        const message = await waitFor(() => evalIn(page, `document.querySelector('.provider-card .key-msg')?.textContent`),
          { budgetMs: 5_000, pollMs: 50 });
        rec.check('the provider test shows a settled result', clicked && !!message, message);
        if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
          rec.check('the refused test names its status and recovery step',
            message?.includes('(429)') && message.includes('Check your plan, credit or rate limit')
              && !message.includes('reach the provider'), message);
        }
        await rec.visualPage('options-provider-test-429', page);
      } finally { try { page.close(); } catch {} }
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
  {
    name: 'options-voice-ready', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const page = await openWidePage(ctx, 'options/options.html#!/voice');
      try {
        const loaded = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.voice-section button')]
          .some((button) => button.textContent === 'Enable voice')`), { budgetMs: 15_000, pollMs: 80 });
        if (!loaded) throw new Error('The Voice settings did not load');
        const state = await rpc(page, { type: 'state/get' });
        if (!state?.ok || state.state.settings.voiceEngine === 'moonshine') {
          throw new Error('The Voice capture requires the Web Speech preference');
        }
        // why Web Speech: enabling its idle manager does not record audio or
        // download a model. The real ready state exposes the silence slider.
        await evalIn(page, `[...document.querySelectorAll('.voice-section button')]
          .find((button) => button.textContent === 'Enable voice').click()`);
        const ready = await waitFor(() => evalIn(page,
          `!!document.querySelector('.voice-section input[type="range"]')
            && !!document.querySelector('.voice-status.is-ok')`), { budgetMs: 10_000, pollMs: 50 });
        if (!ready) throw new Error('Voice settings did not reach the ready state');
        const named = await evalIn(page, `(() => {
          const slider = document.querySelector('.voice-section input[type="range"]');
          return slider.id === 'voice-silence' && !!document.querySelector('label[for="voice-silence"]')
            && slider.getAttribute('aria-valuetext') === (Number(slider.value) / 1000).toFixed(1) + 's';
        })()`);
        if (baseRender) rec.observe('merge-base silence slider name', { named });
        else rec.check('the silence slider has a label and a value in seconds', named);
        await rec.visualPage('options-voice-ready', page);
      } finally {
        await evalIn(page, `[...document.querySelectorAll('.voice-section button')]
          .find((button) => button.textContent === 'Disable voice')?.click()`).catch(() => {});
        const disabled = await waitFor(async () => {
          const state = await rpc(ctx.page, { type: 'state/get' });
          return state?.ok && state.state.settings.voiceEnabled !== true;
        }, { budgetMs: 5_000, pollMs: 50 });
        if (!disabled) throw new Error('Voice settings did not return to disabled');
        await retirePrivateTransferPage(page);
      }
    },
  },
  {
    name: 'options-key-forms', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      let page = await openWidePage(ctx, 'options/options.html#!/api-integrations');
      try {
        const loaded = await waitFor(() => evalIn(page,
          `!!document.querySelector('form.provider-card-form input[type="password"]')`), { budgetMs: 15_000, pollMs: 80 });
        if (!loaded) throw new Error('The API key form did not load');
        const named = await evalIn(page, `(() => {
          const form = document.querySelector('form.provider-card-form');
          form.querySelector('input').focus();
          return ['API host', 'API key', 'Authentication', 'Header name'].every((name) =>
            form.querySelector('[aria-label="' + name + '"]'))
            && form.nextElementSibling?.getAttribute('role') === 'status';
        })()`);
        if (baseRender) rec.observe('merge-base API form names', { named });
        else rec.check('the API form names its fields and keeps a live result line', named);
        await rec.visualPage('options-api-form', page);
        await retirePrivateTransferPage(page);
        page = null;
        page = await openWidePage(ctx, 'options/options.html#!/vault');
        const vaultReady = await waitFor(() => evalIn(page, `!!document.querySelector('#recpass2')`),
          { budgetMs: 15_000, pollMs: 80 });
        if (!vaultReady) throw new Error('The recovery passphrase form did not load');
        // why: use the real vault passphrase and its 120 s Argon2 budget.
        // The capture must keep the same unlock passphrase.
        await evalIn(page, `(() => {
          for (const id of ['recpass', 'recpass2']) {
            const input = document.getElementById(id);
            input.value = ${JSON.stringify(PASSPHRASE)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          document.getElementById('recpass').closest('form').requestSubmit();
        })()`);
        const saved = await waitFor(() => evalIn(page, `[...document.querySelectorAll('form p')]
          .some((line) => /Recovery passphrase (updated|set)[.]/.test(line.textContent))`),
        { budgetMs: 120_000, pollMs: 80 });
        if (!saved) throw new Error('The recovery passphrase did not report success');
        const ink = await evalIn(page, `[...document.querySelectorAll('form p')]
          .find((line) => /Recovery passphrase (updated|set)[.]/.test(line.textContent))?.style.color === 'var(--ok-ink)'`);
        if (baseRender) rec.observe('merge-base recovery result colour', { ink });
        else rec.check('the recovery result uses the readable text colour', ink);
        await rec.visualPage('options-vault-recovery', page, {
          beforeShot: () => evalIn(page, `document.getElementById('recpass').closest('form').scrollIntoView({ block: 'center' })`),
        });
      } finally { if (page) await retirePrivateTransferPage(page); }
    },
  },

  {
    name: 'options-voice-confirm', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const before = await rpc(ctx.page, { type: 'state/get' });
      const auditBefore = await rpc(ctx.page, { type: 'audit/list', limit: 800 });
      if (!before?.ok || !before.state?.settings || !auditBefore?.ok || !Array.isArray(auditBefore.entries)) throw new Error('Voice baseline read refused');
      const priorIds = new Set(auditBefore.entries.map((entry) => entry.id));
      const keys = ['voiceEnabled', 'voiceEngine', 'voiceVariant', 'voiceSilenceMs', 'ocrEnabled'];
      const page = await openWidePage(ctx, 'options/options.html#!/voice');
      const requests = [];
      let activity;
      page.on((method, params) => { if (method === 'Network.requestWillBeSent' && params.request.url.startsWith('https://')) requests.push(params.request.url); });
      try {
        await page.send('Network.enable');
        if (!await waitFor(() => evalIn(page, `[...document.querySelectorAll('.voice-section button')].some((button) => button.textContent === 'Upgrade to on-device (Moonshine)' && !button.disabled)`))) throw new Error('real Voice upgrade trigger is missing');
        await evalIn(page, `(() => { 'use strict'; const trigger = [...document.querySelectorAll('.voice-section button')].find((button) => button.textContent === 'Upgrade to on-device (Moonshine)'); trigger.focus(); trigger.click(); })()`);
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('.voice-section .peerd-modal')`))) throw new Error('real Voice confirmation did not open');
        const dialog = await evalIn(page, `(() => { 'use strict'; const dialog = document.querySelector('.voice-section .peerd-modal');
          return { role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal'), title: dialog.getAttribute('aria-labelledby'),
            cancelFocused: document.activeElement === dialog.querySelector('button.secondary'), text: dialog.textContent }; })()`);
        rec.check('Voice states download facts before any approval', dialog.text.includes('250 MB') && dialog.text.includes('Download & enable'));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Voice dialog focus and name', dialog);
        else rec.check('Voice opens a named modal with Cancel focused', dialog.role === 'dialog' && dialog.modal === 'true'
          && dialog.title === 'voice-confirm-title' && dialog.cancelFocused, JSON.stringify(dialog));
        await checkAccessibleNames(page, rec, 'Voice exposes its named download dialog', [['.voice-section .peerd-modal', 'Download on-device voice model?', 'dialog']]);
        await rec.visualPage('options-voice-confirm', page);
        await evalIn(page, `document.querySelector('.voice-section .peerd-modal a').focus()`);
        await pressNativeKey(page, 'Tab', true);
        const reverse = await evalIn(page, `document.activeElement?.textContent === 'Download & enable'`);
        await pressNativeKey(page, 'Tab');
        const forward = await evalIn(page, `document.activeElement === document.querySelector('.voice-section .peerd-modal a')`);
        await pressNativeKey(page, 'Escape');
        const escaped = await waitFor(() => evalIn(page, `!document.querySelector('.voice-section .peerd-modal')`), { budgetMs: 1_000, pollMs: 40 });
        const returned = await evalIn(page, `document.activeElement?.textContent === 'Upgrade to on-device (Moonshine)'`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Voice native keys', { reverse, forward, escaped, returned });
        else rec.check('native Tab wraps and Escape returns focus to the Voice trigger', reverse && forward && escaped && returned);
        if (!escaped) await evalIn(page, `document.querySelector('.voice-section .peerd-modal button.secondary').click()`);
        if (!await waitFor(() => evalIn(page, `!document.querySelector('.voice-section .peerd-modal')`))) throw new Error('Voice Cancel did not close');
        rec.check('the real OCR trigger stays disabled while integrity is unpinned', await evalIn(page,
          `[...document.querySelectorAll('.ocr-section button')].some((button) => button.disabled && button.textContent === 'OCR not available in this build yet')`));
        const after = await rpc(page, { type: 'state/get' });
        const auditAfter = await rpc(page, { type: 'audit/list', limit: 800 });
        if (!after?.ok || !after.state?.settings || !auditAfter?.ok || !Array.isArray(auditAfter.entries)) throw new Error('Voice settled read refused');
        rec.check('cancelled Voice consent changes no voice setting and starts no model download', keys.every((key) => before.state.settings[key] === after.state.settings[key])
          && requests.length === 0 && !auditAfter.entries.some((entry) => !priorIds.has(entry.id) && entry.type === 'voice_model_fetch'), JSON.stringify({ requests }));
        activity = await openWidePage(ctx, 'options/options.html#!/activity');
        if (!await waitFor(() => evalIn(activity, `!!document.querySelector('.options-page button[title="Refresh"]')`))) throw new Error('real Activity Refresh is missing');
        await checkAccessibleNames(activity, rec, 'Activity Refresh has its action as its accessible name', [['.options-page button[title="Refresh"]', 'Refresh']]);
      } finally { if (activity) await activity.close(); await page.close(); }
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
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const page = await openWidePage(ctx, 'options/options.html#!/behavior');
      try {
        await waitFor(() => evalIn(page, `document.querySelectorAll('.set-row').length >= 11`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        await evalIn(page, `document.querySelector('.set-toggle')?.focus()`);
        await rec.visualPage('options-behavior', page);
        const firstTabRow = await evalIn(page, `(() => {
          const labels = [...document.querySelectorAll('.set-row-label')].map((label) => label.textContent);
          return labels.indexOf('Keep peerd as the first tab') - labels.indexOf('Toolbar button');
        })()`);
        if (baseRender) rec.observe('merge-base first tab row', { offset: firstTabRow });
        else rec.check('"Keep peerd as the first tab" sits under the toolbar button', firstTabRow === 1, String(firstTabRow));
        await evalIn(page, `(() => {
          const button = [...document.querySelectorAll('button')]
            .find((el) => el.textContent === 'Reset section to defaults');
          button.scrollIntoView({ block: 'center' }); button.click();
        })()`);
        await evalIn(page, `import('/vendor/mithril/mithril.js').then(({ default: m }) => m.redraw.sync())`, true);
        const confirmed = await evalIn(page,
          `document.body.textContent.includes('Reset the settings on this page to their defaults?')
            && document.activeElement?.textContent === 'No'`);
        if (baseRender) rec.observe('merge-base reset confirmation', { confirmed });
        else rec.check('reset asks before it changes this page', confirmed);
        await rec.visualPage('options-reset-confirm', page);
        await evalIn(page, `[...document.querySelectorAll('button')].find((el) => el.textContent === 'No')?.click()`);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    // The dweb page's HAPPY path had no state at all - the only coverage was
    // the stop-failure fixture, so the shape a user actually meets was
    // unphotographed. This fixture explicitly opts in so the nested agent row renders.
    name: 'options-dweb', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: true } });
      const page = await openWidePage(ctx, 'options/options.html#!/dweb');
      try {
        await waitFor(() => evalIn(page, `document.querySelectorAll('.set-row').length >= 2`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        const shape = await evalIn(page, `(() => {
          const rows = [...document.querySelectorAll('.set-row')].map((row) => ({
            label: row.querySelector('.set-row-label')?.textContent ?? '',
            pill: row.querySelector('.set-pill')?.textContent ?? '',
            named: row.querySelector('button[role="switch"]')?.getAttribute('aria-label') ?? '',
          }));
          return { rows, headings: document.querySelectorAll('.options-page h3').length };
        })()`);
        rec.check('the network and agent settings both read as rows',
          shape?.rows?.length === 2
            && shape.rows[0].label === 'Participate in the dweb'
            && shape.rows[1].label === 'dweb agent',
          JSON.stringify(shape?.rows));
        rec.check('each switch is named for its STATE, not its inverse action',
          // The bug the row pattern exists to kill: a control labelled
          // "Disable the dweb agent" makes the reader infer state from an
          // action verb. Every switch must announce where you stand.
          (shape?.rows ?? []).every((row) => / - (on|off)$/.test(row.named))
            && !(shape?.rows ?? []).some((row) => /^(Enable|Disable) /.test(row.named)),
          JSON.stringify((shape?.rows ?? []).map((row) => row.named)));
        await rec.visualPage('options-dweb', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    // Memory had no visual state at all, so the auto-memory switch - the one
    // control on the page - was never photographed. It is also the row whose
    // old hand-rolled busy dance had no `finally`, which is precisely the kind
    // of state a still frame catches and an assertion does not.
    name: 'options-memory', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/memory');
      try {
        await waitFor(() => evalIn(page, `document.querySelectorAll('.set-row').length >= 1`),
          { budgetMs: 15_000, pollMs: 80 }).catch(() => {});
        const row = await evalIn(page, `(() => {
          const el = document.querySelector('.set-row');
          const toggle = el?.querySelector('button[role="switch"]');
          return {
            label: el?.querySelector('.set-row-label')?.textContent ?? '',
            pill: el?.querySelector('.set-pill')?.textContent ?? '',
            named: toggle?.getAttribute('aria-label') ?? '',
            headings: document.querySelectorAll('.memory-pane h3').length,
          };
        })()`);
        rec.check('auto-memory reads as a row that states where you stand',
          row?.label === 'Auto-memory'
            && row?.pill === 'ON'
            && / - (on|off)$/.test(row?.named ?? ''),
          JSON.stringify(row));
        await rec.visualPage('options-memory', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'options-memory-safety', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const scope = { kind: 'project', workspace: 'settings-safety' };
      const body = '# Project memory\n\n- Keep the saved files.';
      const draft = `${body}\n- Keep this unsaved edit too.`;
      const page = await openWidePage(ctx, 'options/options.html#!/memory');
      let prior;
      let attempted = false;
      try {
        const exported = await rpc(page, { type: 'memory/export' });
        if (!exported?.ok) throw new Error('Memory export failed');
        prior = exported.payload.docs.find((doc) => doc.id === 'project:settings-safety');
        attempted = true;
        const written = await rpc(page, { type: 'memory/write', scope, body });
        if (!written?.ok) throw new Error('Memory seed failed');
        await page.send('Page.reload');
        const ready = await waitFor(() => evalIn(page,
          `[...document.querySelectorAll('.memory-card')].some((card) => card.querySelector('.memory-scope')?.textContent === 'Project · settings-safety')`),
        { budgetMs: 15_000, pollMs: 80 });
        if (!ready) throw new Error('The project memory editor did not open');
        await evalIn(page, `[...document.querySelectorAll('.memory-actions button')].find((el) => el.textContent === 'Delete all').click()`);
        await evalIn(page, `import('/vendor/mithril/mithril.js').then(({ default: m }) => m.redraw.sync())`, true);
        const pending = await rpc(page, { type: 'memory/export' });
        rec.check('one Delete all click leaves the saved memory intact',
          pending?.payload?.docs.some((doc) => doc.id === 'project:settings-safety' && doc.body === body));
        const confirmed = await evalIn(page, `!!document.querySelector('.memory-confirm') && document.activeElement?.textContent === 'No'`);
        if (baseRender) rec.observe('merge-base memory confirmation', { confirmed });
        else rec.check('Delete all asks with a separate confirmation', confirmed);
        await rec.visualPage('options-memory-delete-confirm', page);
        await evalIn(page, `[...document.querySelectorAll('.memory-confirm button')].find((el) => el.textContent === 'No')?.click()`);
        await evalIn(page, `(() => {
          const card = [...document.querySelectorAll('.memory-card')]
            .find((el) => el.querySelector('.memory-scope')?.textContent === 'Project · settings-safety');
          const input = card.querySelector('textarea');
          input.value = ${JSON.stringify(draft)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          location.hash = '!/costs';
        })()`);
        const left = await waitFor(() => evalIn(page, `!document.querySelector('.memory-pane')`),
          { budgetMs: 5_000, pollMs: 50 });
        if (!left) throw new Error('Settings did not leave Memory');
        await evalIn(page, `location.hash = '!/memory'`);
        const restored = await waitFor(() => evalIn(page,
          `[...document.querySelectorAll('.memory-card')].some((card) => card.querySelector('.memory-scope')?.textContent === 'Project · settings-safety')`),
        { budgetMs: 5_000, pollMs: 50 });
        const current = await rpc(page, { type: 'memory/export' });
        rec.check('editing and navigation leave the saved memory unchanged', !!restored
          && current?.payload?.docs.some((doc) => doc.id === 'project:settings-safety' && doc.body === body));
        const retained = await evalIn(page, `[...document.querySelectorAll('.memory-card')]
          .find((el) => el.querySelector('.memory-scope')?.textContent === 'Project · settings-safety')?.querySelector('textarea')?.value === ${JSON.stringify(draft)}`);
        if (baseRender) rec.observe('merge-base memory draft', { retained });
        else rec.check('a section switch preserves the unsaved draft', retained);
        await rec.visualPage('options-memory-draft-restored', page);
      } finally {
        await evalIn(page, `[...document.querySelectorAll('.memory-card')]
          .find((el) => el.querySelector('.memory-scope')?.textContent === 'Project · settings-safety')
          ?.querySelectorAll('button').forEach((button) => { if (button.textContent === 'Revert') button.click(); })`).catch(() => {});
        if (attempted) await rpc(page, prior ? { type: 'memory/write', scope, body: prior.body } : { type: 'memory/delete', scope }).catch(() => {});
        await retirePrivateTransferPage(page);
      }
    },
  },
  {
    name: 'options-activity-history', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const marker = 'settings-history-e2e.test';
      const page = await openWidePage(ctx, 'options/options.html#!/activity');
      let added = false;
      try {
        const prior = await rpc(page, { type: 'denylist/list' });
        if (!prior?.ok || prior.patterns?.includes(marker)) throw new Error('Activity marker is not free');
        added = true;
        const result = await rpc(page, { type: 'denylist/add', pattern: marker });
        if (!result?.ok) throw new Error('Activity marker could not be recorded');
        const recorded = await waitFor(async () => (await rpc(page, { type: 'audit/list', limit: 20_000 }))
          ?.entries?.some((entry) => entry.type === 'denylist_added' && entry.details?.pattern === marker),
        { budgetMs: 5_000, pollMs: 50 });
        if (!recorded) throw new Error('The activity marker was not recorded');
        // why real requests: the old event must fall outside the route's actual
        // fetch window. Keep the current mode while generating newer events.
        await evalIn(page, `(async () => {
          const browser = (await import('/shared/browser-api.js')).default;
          const state = await browser.runtime.sendMessage({ type: 'state/get' });
          const mode = state.state.session.permission.mode;
          for (let index = 0; index < 501; index++) {
            const reply = await browser.runtime.sendMessage({ type: 'permission/set', mode });
            if (!reply?.ok) throw new Error('Activity event could not be recorded');
          }
        })()`, true);
        const outside = await waitFor(async () => {
          const log = await rpc(page, { type: 'audit/list' });
          return log?.total > log?.entries?.length
            && !log.entries.some((entry) => entry.details?.pattern === marker);
        }, { budgetMs: 5_000, pollMs: 50 });
        if (!outside) throw new Error('The old event did not leave the fetch window');
        await page.send('Page.reload');
        const loaded = await waitFor(() => evalIn(page, `!!document.querySelector('.log-filter-query')`),
          { budgetMs: 15_000, pollMs: 80 });
        if (!loaded) throw new Error('Activity filters did not load');
        const windowNamed = await evalIn(page,
          `/Newest 500 of [0-9]+ recorded events/.test(document.body.textContent)`);
        if (baseRender) rec.observe('merge-base Activity window', { windowNamed });
        else rec.check('Activity states that it loaded only the newest events', windowNamed);
        await evalIn(page, `(() => {
          const input = document.querySelector('.log-filter-query');
          input.value = ${JSON.stringify(marker)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const found = await waitFor(() => evalIn(page,
          `document.querySelector('.log-row')?.textContent.includes(${JSON.stringify(marker)})`),
        { budgetMs: 5_000, pollMs: 50 });
        if (baseRender) rec.observe('merge-base older event search', { found: !!found });
        else rec.check('a filter finds an event older than the default fetch window', !!found);
        await rec.visualPage('options-activity-older-event', page);
      } finally {
        if (added) await rpc(page, { type: 'denylist/remove', pattern: marker }).catch(() => {});
        await retirePrivateTransferPage(page);
      }
    },
  },
  {
    name: 'options-denylist', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'options/options.html#!/denylist');
      const pattern = 'visual-options-denylist.peerd.test';
      let fixtureAttempted = false;
      try {
        // why: a permission refusal also renders a page; require the real seed
        // and exercise mutations through this exact Options document before
        // accepting a screenshot as evidence that the page works.
        const loaded = await waitFor(() => evalIn(page, `document.querySelectorAll('.denylist-group').length >= 8
          && !document.querySelector('.denylist-pane .key-msg.err')`), { budgetMs: 15_000, pollMs: 80 });
        const prior = await rpc(page, { type: 'denylist/list' });
        rec.check('Options loads the denylist seed without an authorization error', loaded === true && prior?.ok,
          JSON.stringify(prior?.error ?? { loaded, patterns: prior?.patterns?.length }));
        if (!loaded || !prior?.ok) throw new Error('Options denylist did not load');
        if (prior.patterns.includes(pattern) || prior.added.includes(pattern)) {
          throw new Error('denylist fixture pattern already exists');
        }
        fixtureAttempted = true;
        await evalIn(page, `(() => {
          const input = document.querySelector('.denylist-add input');
          input.value = ${JSON.stringify(pattern)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.denylist-add').requestSubmit();
        })()`);
        const added = await waitFor(async () => {
          const state = await rpc(page, { type: 'denylist/list' });
          return state?.ok && state.added.includes(pattern)
            && await evalIn(page, `!!document.querySelector('.denylist-item.is-user')
              && document.querySelector('.denylist-pane').textContent.includes(${JSON.stringify(pattern)})
              && !document.querySelector('.denylist-pane .key-msg.err')`);
        }, { budgetMs: 8_000, pollMs: 80 });
        rec.check('Options Block stores and renders the custom pattern', added === true);
        if (!added) throw new Error('Options denylist add did not settle');
        await rec.visualPage('options-denylist', page);
        await clickAndSyncRedraw(page, `.denylist-x[aria-label="Remove ${pattern}"]`);
        const confirmed = await clickAndSyncRedraw(page, `.danger-text[aria-label="Remove ${pattern}"]`);
        const removed = confirmed && await waitFor(async () => {
          const state = await rpc(page, { type: 'denylist/list' });
          return state?.ok && !state.added.includes(pattern) && !state.patterns.includes(pattern)
            && await evalIn(page, `!document.querySelector('.denylist-pane .key-msg.err')
              && ![...document.querySelectorAll('.denylist-item')].some((item) => item.textContent === ${JSON.stringify(pattern)})`);
        }, { budgetMs: 8_000, pollMs: 80 });
        rec.check('Options confirmed Remove deletes only the custom pattern', removed === true);
        if (!removed) throw new Error('Options denylist removal did not settle');
      } finally {
        for (const rule of fixtureAttempted ? [pattern, `*.${pattern}`] : []) {
          await rpc(ctx.page, { type: 'denylist/remove', pattern: rule }).catch(() => {});
        }
        try { page.close(); } catch { /* */ }
      }
    },
  },
  {
    // #234 Settings -> Paced sites. Seeded through the dev-mode observation
    // seam, which feeds the same trusted status + Retry-After the egress choke
    // point feeds, so the rendered rows are ones a real refusal would produce.
    name: 'options-paced-sites', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      let page = await openWidePage(ctx, 'options/options.html#!/paced-sites');
      try {
        await rpc(page, { type: 'paced/clear' });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
        // Two different shapes, so the row copy is exercised both ways: a site
        // that stated a wait and was refused twice (a compounded interval), and
        // one that only answered "unavailable" (peerd's own backoff).
        await rpc(ctx.page, {
          type: 'debug/pacing', origin: 'https://api.acme.test', status: 429, retryAfter: '1',
        });
        await rpc(ctx.page, {
          type: 'debug/pacing', origin: 'https://api.acme.test', status: 429, retryAfter: '1',
        });
        // why the gap: the list is ordered by most recent refusal, and two seeds
        // landing in the same millisecond fall back to the alphabetical tiebreak
        // - so without it the two rows swap places between runs and the capture
        // flaps.
        await sleep(50);
        await rpc(ctx.page, {
          type: 'debug/pacing', origin: 'https://portal.globex.test', status: 503,
        });
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });
        // why the page reopens after the stated pause has run out: a row
        // renders "paused for another Ns" off the wall clock, and capturing one
        // mid-countdown would make this state flap by a second on every run. The
        // learned interval, which is what this capture is actually about, is
        // stable. The countdown copy is covered by the in-browser test.
        await sleep(6_000);

        await retirePrivateTransferPage(page);
        page = await openWidePage(ctx, 'options/options.html#!/paced-sites');
        await waitFor(() => evalIn(page, `(() => {
          const text = document.body.innerText;
          return text.includes('api.acme.test')
            && text.includes('portal.globex.test')
            && text.includes('never tries to disguise itself')
            && !text.includes('paused for another');
        })()`), { budgetMs: 15_000, pollMs: 80 });
        await rec.visualPage('options-paced-sites', page);
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } }).catch(() => {});
        await rpc(page, { type: 'paced/clear' }).catch(() => {});
        if (page) await retirePrivateTransferPage(page);
      }
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
        const loaded = await waitFor(() => evalIn(page, `(() => {
          const text = document.body.innerText;
          return text.includes('accounts.acme.test')
            && text.includes('portal.globex.test')
            && text.includes('every port and its subdomains')
            && !document.querySelector('.learned-sites .key-msg.err');
        })()`), { budgetMs: 15_000, pollMs: 80 });
        const listed = await rpc(page, { type: 'learned/list' });
        rec.check('Options loads both learned hosts without an authorization error', loaded === true
          && listed?.ok && listed.origins?.length === 2,
        JSON.stringify({ loaded, listed }));
        if (!loaded || !listed?.ok || listed.origins?.length !== 2) throw new Error('Options learned sites did not load');
        await rec.visualPage('options-learned-sites', page);
        await clickAndSyncRedraw(page, '[data-learned-role="trigger"][data-learned-host="accounts.acme.test"]');
        const confirmed = await clickAndSyncRedraw(page, '[data-learned-role="confirm"][data-learned-host="accounts.acme.test"]');
        const removed = confirmed && await waitFor(async () => {
          const state = await rpc(page, { type: 'learned/list' });
          return state?.ok && state.origins?.length === 1 && state.origins[0].host === 'portal.globex.test'
            && await evalIn(page, `!document.querySelector('.learned-sites .key-msg.err')
              && ![...document.querySelectorAll('.learned-sites code')].some((item) => item.textContent === 'accounts.acme.test')
              && document.querySelector('.learned-sites .key-msg.ok')?.textContent === 'Removed accounts.acme.test.'
              && document.querySelector('[data-learned-role="trigger-all"]')?.disabled === false`);
        }, { budgetMs: 8_000, pollMs: 80 });
        rec.check('Options confirmed Remove forgets only the selected learned host', removed === true);
        if (!removed) throw new Error('Options learned host removal did not settle');
        const seed = async (origin) => {
          const enabled = await rpc(ctx.page, { type: 'settings/update', patch: { devMode: true } });
          const learned = await rpc(ctx.page, { type: 'debug/originLock', origin, seedReason: 'password-field' });
          const disabled = await rpc(ctx.page, { type: 'settings/update', patch: { devMode: false } });
          if (!enabled?.ok || !disabled?.ok || !learned?.ok || learned.learned !== true) throw new Error('real learn path refused');
        };
        const inspect = async (origin) => {
          const result = await rpc(ctx.page, { type: 'debug/originLock', origin });
          if (!result?.ok || typeof result.learned !== 'boolean') throw new Error('classifier read refused');
          return result.learned;
        };
        const forgotten = await inspect('https://accounts.acme.test:8443');
        await seed('https://later.example');
        const afterLearn = await rpc(page, { type: 'learned/list' });
        if (!afterLearn?.ok || !Array.isArray(afterLearn.origins)) throw new Error('post-learn list refused');
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base removal and later learn', { forgotten, afterLearn });
        else rec.check('Remove changes the live classifier and a later learn cannot restore the host', forgotten === false
          && afterLearn.origins.map((entry) => entry.host).sort().join(',') === 'later.example,portal.globex.test');
        await page.send('Page.reload', { ignoreCache: true });
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('[data-learned-host="portal.globex.test"]')`))) throw new Error('learned list did not reload');
        await clickAndSyncRedraw(page, '[data-learned-role="trigger"][data-learned-host="portal.globex.test"]');
        await Promise.all([
          clickAndSyncRedraw(page, '[data-learned-role="confirm"][data-learned-host="portal.globex.test"]'),
          seed('https://concurrent.example'),
        ]);
        if (!await waitFor(() => evalIn(page, `document.querySelector('.learned-sites .key-msg.ok')?.textContent === 'Removed portal.globex.test.'`))) throw new Error('raced Remove did not receive its receipt');
        const raced = await rpc(page, { type: 'learned/list' });
        const protectedAfterRace = await inspect('https://concurrent.example');
        if (!raced?.ok || !Array.isArray(raced.origins)) throw new Error('raced list refused');
        rec.check('a concurrent learn remains protected', protectedAfterRace === true);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base Remove and learn overlap', raced);
        else rec.check('Remove and learn share one ordered durable set', raced.origins.map((entry) => entry.host).sort().join(',') === 'concurrent.example,later.example'
          && await inspect('https://portal.globex.test') === false);
        await page.send('Page.reload', { ignoreCache: true });
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('[data-learned-role="trigger-all"]')`))) throw new Error('raced learned list did not reload');
        await rec.visualPage('options-learned-after-remove', page);
        // why: the separate store read can see a committed removal before the
        // UI receives its receipt. Wait for that receipt above, not the number
        // of trigger buttons (arming the first confirm already lowers it).
        const armedAll = await clickAndSyncRedraw(page, '[data-learned-role="trigger-all"]');
        const confirmedAll = await clickAndSyncRedraw(page, '[data-learned-role="confirm-all"]');
        const cleared = confirmedAll && await waitFor(async () => {
          const state = await rpc(page, { type: 'learned/list' });
          return state?.ok && state.origins?.length === 0
            && await evalIn(page, `!document.querySelector('.learned-sites .key-msg.err')
              && document.querySelector('.learned-sites').textContent.includes('Nothing learned yet.')`);
        }, { budgetMs: 8_000, pollMs: 80 });
        rec.check('Options confirmed Forget all clears the remaining learned hosts', cleared === true,
          JSON.stringify({ armedAll, confirmedAll, cleared }));
        if (!cleared) throw new Error('Options learned sites clear did not settle');
        const clearedClassifier = await inspect('https://concurrent.example');
        await seed('https://after-clear.example');
        const afterClear = await rpc(page, { type: 'learned/list' });
        if (!afterClear?.ok || !Array.isArray(afterClear.origins)) throw new Error('post-clear list refused');
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base clear and later learn', { clearedClassifier, afterClear });
        else rec.check('Forget all changes the classifier and stays cleared after another learn', clearedClassifier === false
          && afterClear.origins.length === 1 && afterClear.origins[0].host === 'after-clear.example');
        await page.send('Page.reload', { ignoreCache: true });
        if (!await waitFor(() => evalIn(page, `document.querySelector('.learned-sites')?.textContent.includes('after-clear.example')`))) throw new Error('post-clear learned list did not reload');
        await rec.visualPage('options-learned-after-clear', page);
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
    // why: these Options lists can turn a refused read into an innocent empty
    // state. Real human-page mutations plus persisted reads must gate the
    // functional lane, not just produce a screenshot in the visual lane.
    name: 'options-skills-hooks', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const skillName = 'e2e-options-skill';
      const hookId = 'e2e-options-hook';
      let page;
      let skillAttempted = false;
      let hookAttempted = false;
      const expectEventually = async (name, predicate) => {
        const passed = await waitFor(predicate, { budgetMs: 15_000, pollMs: 80 });
        rec.check(name, passed === true);
        if (!passed) throw new Error(name);
      };
      try {
        page = await openWidePage(ctx, 'options/options.html#!/skills');
        const priorSkills = await rpc(page, { type: 'skills/list' });
        rec.check('Options can read the real installed skill list', priorSkills?.ok && Array.isArray(priorSkills.skills),
          JSON.stringify(priorSkills?.error ?? { count: priorSkills?.skills?.length }));
        if (!priorSkills?.ok || !Array.isArray(priorSkills.skills)) throw new Error('Options skills list refused');
        if (priorSkills.skills.some((skill) => skill.name === skillName)) throw new Error('skill fixture already exists');
        await expectEventually('Options renders the skill installation form', () => evalIn(page,
          `!!document.querySelector('.skills-install textarea')`));
        const skillText = `---\nname: ${skillName}\ndescription: Verify local Settings skill management.\n---\nOnly used by the Settings browser regression fixture.`;
        skillAttempted = true;
        await evalIn(page, `(() => {
          const editor = document.querySelector('.skills-install textarea');
          editor.value = ${JSON.stringify(skillText)};
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await clickAndSyncRedraw(page, '.skills-install button');
        await expectEventually('Options Install persists and lists the local skill', async () => {
          const state = await rpc(page, { type: 'skills/list' });
          return state?.ok && state.skills.some((skill) => skill.name === skillName && skill.enabled === true)
            && await evalIn(page, `document.querySelector('.skills-list')?.textContent.includes(${JSON.stringify(skillName)})
              && document.querySelector('.skills-status')?.textContent.includes('Installed')`);
        });
        await rec.shotPage('skills-installed', page);
        for (const enabled of [false, true]) {
          await clickAndSyncRedraw(page, `.skills-list input[aria-label="Enable ${skillName}"]`);
          await expectEventually(`Options ${enabled ? 'enables' : 'disables'} the installed skill`, async () => {
            const state = await rpc(page, { type: 'skills/list' });
            return state?.ok && state.skills.some((skill) => skill.name === skillName && skill.enabled === enabled)
              && await evalIn(page, `document.querySelector('.skills-list input[aria-label="Enable ${skillName}"]')?.checked === ${enabled}`);
          });
        }
        await clickAndSyncRedraw(page, `.skills-list button[aria-label="Remove ${skillName}"]`);
        await expectEventually('Options Remove deletes the installed skill and its row', async () => {
          const state = await rpc(page, { type: 'skills/list' });
          return state?.ok && !state.skills.some((skill) => skill.name === skillName)
            && await evalIn(page, `!document.querySelector('.skills-list input[aria-label="Enable ${skillName}"]')`);
        });
        await retirePrivateTransferPage(page);
        page = await openWidePage(ctx, 'options/options.html#!/hooks');
        const priorHooks = await rpc(page, { type: 'hooks/list' });
        rec.check('Options can read the real built-in hook list', priorHooks?.ok
          && priorHooks.hooks?.some((hook) => hook.isDefault && hook.enabled), JSON.stringify(priorHooks?.error ?? ''));
        if (!priorHooks?.ok || !Array.isArray(priorHooks.hooks)) throw new Error('Options hook list refused');
        if (priorHooks.hooks.some((hook) => hook.id === hookId)) throw new Error('hook fixture already exists');
        const builtins = JSON.stringify(priorHooks.hooks.filter((hook) => hook.isDefault));
        await expectEventually('Options renders the always-on built-in hooks without an error', () => evalIn(page,
          `document.querySelectorAll('.hook-lock').length > 0 && !document.querySelector('.hooks-pane .key-msg.err')`));
        await clickAndSyncRedraw(page, '.hooks-actions button');
        const hookText = `---\nid: ${hookId}\nevent: pre-tool-use\nmatch: type\nrule:\n  matchArg: text\n  contains: E2E-OPTIONS-BLOCKED-LITERAL\n  reason: Settings regression fixture\n---\nVerify local Settings hook management.`;
        hookAttempted = true;
        await evalIn(page, `(() => {
          const editor = document.querySelector('.hook-add-editor');
          editor.value = ${JSON.stringify(hookText)};
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.hook-add').requestSubmit();
        })()`);
        await expectEventually('Options Save hook persists and renders the declarative policy', async () => {
          const state = await rpc(page, { type: 'hooks/list' });
          return state?.ok && state.hooks.some((hook) => hook.id === hookId && hook.enabled === true && !hook.isDefault)
            && await evalIn(page, `!!document.querySelector('.hook-toggle input[aria-label="Enable ${hookId}"]')
              && !document.querySelector('.hooks-pane .key-msg.err')`);
        });
        await rec.shotPage('hooks-saved', page);
        for (const enabled of [false, true]) {
          await clickAndSyncRedraw(page, `.hook-toggle input[aria-label="Enable ${hookId}"]`);
          await expectEventually(`Options ${enabled ? 'enables' : 'disables'} only the user hook`, async () => {
            const state = await rpc(page, { type: 'hooks/list' });
            return state?.ok && state.hooks.some((hook) => hook.id === hookId && hook.enabled === enabled)
              && JSON.stringify(state.hooks.filter((hook) => hook.isDefault)) === builtins
              && await evalIn(page, `document.querySelector('.hook-toggle input[aria-label="Enable ${hookId}"]')?.checked === ${enabled}
                && !document.querySelector('.hooks-pane .key-msg.err')`);
          });
        }
        await clickAndSyncRedraw(page, `.hook-x[aria-label="Remove ${hookId}"]`);
        await clickAndSyncRedraw(page, '.hook-confirm .danger-text');
        await expectEventually('Options confirmed Remove deletes only the user hook', async () => {
          const state = await rpc(page, { type: 'hooks/list' });
          return state?.ok && !state.hooks.some((hook) => hook.id === hookId)
            && JSON.stringify(state.hooks.filter((hook) => hook.isDefault)) === builtins
            && await evalIn(page, `!document.querySelector('.hook-toggle input[aria-label="Enable ${hookId}"]')
              && !document.querySelector('.hooks-pane .key-msg.err')`);
        });
      } finally {
        // Only remove names proved absent before this state. Never clear the
        // user's skill/hook collections or alter the built-in security floor.
        if (skillAttempted) await rpc(ctx.page, { type: 'skills/remove', name: skillName }).catch(() => {});
        if (hookAttempted) await rpc(ctx.page, { type: 'hooks/remove', id: hookId }).catch(() => {});
        if (page) await retirePrivateTransferPage(page);
      }
    },
  },
  {
    name: 'administrative-validation', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const base = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const modelCallsBefore = ctx.modelCallCount();
      const skillName = 'e2e-folded-description';
      const description = 'Read the full skill description. Use this fixture to check line folding.';
      let page;
      let skillAttempted = false;
      try {
        for (const kind of ['skills', 'hooks']) {
          page = await openWidePage(ctx, `options/options.html#!/${kind}`);
          const prior = await rpc(page, { type: `${kind}/list` });
          if (!prior?.ok || !Array.isArray(prior[kind])) throw new Error(`${kind} read refused`);
          if (kind === 'skills' && prior.skills.some((skill) => skill.name === skillName)) throw new Error('skill fixture already exists');
          const selector = kind === 'skills' ? '.skills-install textarea' : '.hook-add-editor';
          const submit = kind === 'skills' ? '.skills-install button' : '.hook-add button[type="submit"]';
          if (kind === 'hooks') {
            if (!await waitFor(() => evalIn(page, `!!document.querySelector('.hooks-actions button')`))) throw new Error('hook form did not mount');
            await clickAndSyncRedraw(page, '.hooks-actions button');
          }
          if (!await waitFor(() => evalIn(page, `!!document.querySelector(${JSON.stringify(selector)})`))) throw new Error(`${kind} editor did not mount`);
          const draft = kind === 'skills' ? '---\nname: 日本語スキル\ndescription: Check an invalid handle.\n---\nKeep this draft.'
            : '---\nid: e2e-invalid-rule\nevent: pre-tool-use\nmatch: type\nrule:\n  matchArg: text\n  contains: e2e\n  onmatch: allow\n---\nKeep this draft.';
          await evalIn(page, `(() => { 'use strict';
            const editor = document.querySelector(${JSON.stringify(selector)});
            editor.value = ${JSON.stringify(draft)};
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          if (!await waitFor(() => evalIn(page, `document.querySelector(${JSON.stringify(submit)})?.disabled === false`))) throw new Error(`${kind} Save did not enable`);
          await clickAndSyncRedraw(page, submit);
          const noticeSelector = kind === 'skills' ? '.skills-status' : '.hooks-pane .key-msg.err';
          const notice = await waitFor(() => evalIn(page, `document.querySelector(${JSON.stringify(noticeSelector)})?.textContent`));
          if (!notice) throw new Error(`${kind} refusal did not settle`);
          rec.check(`${kind} refusal preserves the exact draft`, await evalIn(page,
            `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(draft)}
              && document.querySelector(${JSON.stringify(submit)})?.disabled === false`));
          const after = await rpc(page, { type: `${kind}/list` });
          rec.check(`${kind} refusal writes nothing`, after?.ok && JSON.stringify(after[kind]) === JSON.stringify(prior[kind]));
          if (base) rec.observe(`${kind} base refusal`, notice);
          else rec.check(`${kind} reports a known actionable refusal`, notice.startsWith(kind === 'skills' ? 'Skill not installed:' : 'Hook not saved:')
            && !notice.includes('could not confirm'), notice);
          await rec.visualPage(kind === 'skills' ? 'administrative-validation' : `${kind}-validation-refusal`, page);
          if (kind === 'skills') {
            skillAttempted = true;
            const text = `---\nname: ${skillName}\ndescription: >-\n  Read the full skill description.\n  Use this fixture to check line folding.\n---\nOnly a parser test fixture.`;
            await evalIn(page, `(() => { 'use strict';
              const editor = document.querySelector('.skills-install textarea');
              editor.value = ${JSON.stringify(text)}; editor.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await clickAndSyncRedraw(page, '.skills-install button');
            const installed = await waitFor(async () => {
              const listed = await rpc(page, { type: 'skills/list' });
              return listed?.ok && listed.skills.find((skill) => skill.name === skillName);
            });
            if (!installed) throw new Error('folded skill did not install');
            if (base) rec.observe('base folded description', installed.description);
            else rec.check('the full folded description persists', installed.description === description, installed.description);
            if (!await waitFor(() => evalIn(page, `document.querySelector('.skills-list')?.textContent.includes(${JSON.stringify(installed.description)})`))) throw new Error('installed skill did not render');
            await rec.visualPage('skill-folded-description', page);
            const removed = await rpc(page, { type: 'skills/remove', name: skillName });
            if (!removed?.ok) throw new Error('skill fixture cleanup refused');
            skillAttempted = false;
          }
          await page.close(); page = null;
        }
        rec.check('validation and install need no model call', ctx.modelCallCount() === modelCallsBefore);
      } finally {
        if (skillAttempted) await rpc(ctx.page, { type: 'skills/remove', name: skillName });
        if (page) await page.close();
      }
    },
  },
  {
    name: 'shared-chat-title', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const fileBytes = await readFile(new URL('../../extension/peerd-runtime/tools/prompt-wrap.js', import.meta.url));
      const fileText = fileBytes.toString('utf8');
      const priorSettings = await evalIn(ctx.page, `(async () => { 'use strict';
        return (await (await import('/peerd-egress/kernel-storage.js')).kv.get('settings.v1')) ?? {};
      })()`, true);
      if (!priorSettings || typeof priorSettings !== 'object' || Array.isArray(priorSettings)) throw new Error('saved provider settings are unavailable');
      const status = await rpc(ctx.page, { type: 'provider/status' });
      if (status?.ok !== true || status.providers?.find((provider) => provider.name === 'anthropic')?.hasKey !== false) throw new Error('the ephemeral title fixture requires no prior Anthropic key');
      const fixture = await startWebFixtureServer();
      const requests = [];
      let tab;
      try {
        const keyed = await rpc(ctx.page, { type: 'provider/setKey', provider: 'anthropic', plaintext: 'sk-e2e-shared-title-only', activate: false });
        const selected = await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'anthropic', providerModel: '' } });
        if (keyed?.ok !== true || selected?.ok !== true) throw new Error('the real Anthropic fixture setup refused');
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.input-bar input[type="file"]') && !!document.querySelector('.input-bar textarea')`))) throw new Error('the Anthropic composer did not become ready');
        tab = await evalIn(ctx.page, `(async () => { 'use strict';
          return (await chrome.tabs.create({ url: ${JSON.stringify(`${fixture.url.replace('127.0.0.1', 'orders.peerd.test')}/products`)}, active: false })).id;
        })()`, true);
        if (!Number.isInteger(tab)) throw new Error('shared web tab did not open');
        const loaded = await waitFor(() => evalIn(ctx.page, `chrome.tabs.get(${tab}).then((tab) => tab.status === 'complete')`, true));
        if (!loaded) throw new Error('shared web fixture did not load');
        ctx.setModelResponder((_index, request) => {
          requests.push({ url: request.url, method: request.method,
            body: request.postData ?? Buffer.concat((request.postDataEntries ?? [])
              .map((entry) => Buffer.from(entry.bytes ?? '', 'base64'))).toString() });
          return { sse: [
            ['message_start', { type: 'message_start', message: { id: 'msg-e2e-shared-title', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Shared content received.' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
            ['message_stop', { type: 'message_stop' }],
          ].map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join('') };
        });
        await evalIn(ctx.page, `(() => { 'use strict';
          const files = new DataTransfer();
          files.items.add(new File([Uint8Array.from(${JSON.stringify([...fileBytes])})], 'prompt-wrap.js', { type: 'text/javascript' }));
          const input = document.querySelector('.input-bar input[type="file"]');
          if (!input) throw new Error('real attachment input is missing');
          input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        if (!await waitFor(() => evalIn(ctx.page, `document.querySelector('.attach-chip-name')?.textContent === 'prompt-wrap.js'`))) throw new Error('file did not stage');
        const question = 'Summarize the page and this file.';
        await evalIn(ctx.page, `(() => { 'use strict';
          const input = document.querySelector('.input-bar textarea');
          input.value = ${JSON.stringify(`@tab:${tab} ${question}`)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.closest('form').requestSubmit();
        })()`);
        const session = await waitFor(async () => {
          const state = await rpc(ctx.page, { type: 'state/get' });
          return state?.ok && state.state?.session?.messages?.some((message) => message.role === 'assistant' && message.content === 'Shared content received.' && message.streaming !== true) ? state.state.session : null;
        }, { budgetMs: 30_000, pollMs: 80 });
        if (!session) throw new Error('shared composer send did not settle');
        rec.check('one real Anthropic request is intercepted', ctx.modelCallCount() === 1 && requests.length === 1
          && requests[0].url === 'https://api.anthropic.com/v1/messages' && requests[0].method === 'POST');
        const content = session.messages.find((message) => message.role === 'user')?.content;
        rec.check('the durable message keeps real page and file context', typeof content === 'string'
          && content.includes('<untrusted_web_content ')
          && content.includes('Coffee Mug') && content.endsWith(`\n\n<peerd_file name="prompt-wrap.js">\n${fileText}\n</peerd_file>`), content?.slice(0, 250));
        const modelMessages = requests.length === 1 ? JSON.parse(requests[0].body).messages : [];
        const modelText = modelMessages.flatMap((message) => typeof message.content === 'string'
          ? [message.content] : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text)).join('\n');
        rec.check('the model gets the same fenced context', requests.length === 1
          && modelText.includes('untrusted_web_content') && modelText.includes('Coffee Mug')
          && modelText.includes(`<peerd_file name="prompt-wrap.js">\n${fileText}\n</peerd_file>`));
        const listed = await rpc(ctx.page, { type: 'session/list' });
        const title = listed?.ok === true && Array.isArray(listed.sessions)
          ? listed.sessions.find((row) => row.sessionId === session.sessionId)?.title : null;
        if (typeof title !== 'string' || !title.trim()) throw new Error(`real chat title metadata is missing: ${JSON.stringify({ sessionId: session.sessionId, listed })}`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base shared title', title);
        else rec.check('only the user question becomes the new title', title === question, title);
        await clickAndSyncRedraw(ctx.page, '[aria-label="Chats"]');
        if (!await waitFor(() => evalIn(ctx.page, `(() => { 'use strict';
          const node = document.querySelector('.session-row.active .session-title');
          return node instanceof HTMLElement && node.textContent === ${JSON.stringify(title)};
        })()`))) throw new Error('real chat title did not render');
        await rec.visual('shared-chat-title');
        await clickAndSyncRedraw(ctx.page, '[aria-label="Chats"]');
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('.input-bar textarea')`))) throw new Error('chat did not reopen');
      } finally {
        try {
          const keys = ['providerName', 'providerModel'];
          const reset = keys.filter((key) => !Object.hasOwn(priorSettings, key));
          const patch = Object.fromEntries(keys.filter((key) => Object.hasOwn(priorSettings, key)).map((key) => [key, priorSettings[key]]));
          if (reset.length && (await rpc(ctx.page, { type: 'settings/reset', keys: reset }))?.ok !== true) throw new Error('unset provider settings did not restore');
          if (Object.keys(patch).length && (await rpc(ctx.page, { type: 'settings/update', patch }))?.ok !== true) throw new Error('saved provider settings did not restore');
          const restored = await evalIn(ctx.page, `(async () => { 'use strict';
            return (await (await import('/peerd-egress/kernel-storage.js')).kv.get('settings.v1')) ?? {};
          })()`, true);
          rec.check('provider settings restore with exact saved field presence', keys.every((key) =>
            Object.hasOwn(restored, key) === Object.hasOwn(priorSettings, key) && restored[key] === priorSettings[key]));
        } finally {
          if (tab) await evalIn(ctx.page, `chrome.tabs.remove(${tab})`, true);
          await fixture.close();
        }
      }
    },
  },
  {
    name: 'document-attachment-refusals', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const initial = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings;
      if (!initial) throw new Error('the provider state is unavailable');
      try {
        const key = await rpc(ctx.page, { type: 'provider/setKey', provider: 'anthropic', plaintext: 'sk-e2e-document-refusal-only' });
        const provider = await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'anthropic', providerModel: '' } });
        if (key?.ok !== true || provider?.ok !== true) throw new Error('the attachment provider did not initialize');
        if (!await waitFor(() => evalIn(ctx.page, `!!document.querySelector('input.attach-input')`), { budgetMs: 15_000 })) throw new Error('the real file picker is unavailable');
        const legacy = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
        for (const [name, bytes, expected] of [
          ['report.doc', legacy, 'older or password-protected Office file'],
          ['locked.docx', legacy, 'without a password, then attach it again'],
          ['broken.docx', [0x50, 0x4b, 3, 4, 0, 0, 0, 0], 'corrupt, password-protected, or uses unsupported compression'],
        ]) {
          await evalIn(ctx.page, `(() => {
            const files = new DataTransfer();
            files.items.add(new File([Uint8Array.from(${JSON.stringify(bytes)})], ${JSON.stringify(name)}));
            const input = document.querySelector('input.attach-input');
            input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
            const composer = document.querySelector('form.input-bar textarea');
            composer.focus(); composer.select();
          })()`);
          await ctx.page.send('Input.insertText', { text: 'Summarize this document.' });
          if (!await waitFor(() => evalIn(ctx.page, `document.querySelector('.attach-chip-name')?.textContent === ${JSON.stringify(name)} && !!document.querySelector('form.input-bar button.send-btn:not(:disabled)')`), { budgetMs: 10_000 })) throw new Error('the file did not stage for Send');
          const before = ctx.modelCallCount();
          if (!await clickAndSyncRedraw(ctx.page, 'form.input-bar button.send-btn')) throw new Error('the real Send control is unavailable');
          const settled = await waitFor(() => evalIn(ctx.page, `(() => {
            const error = document.querySelector('.attach-error')?.textContent;
            const busy = !!document.querySelector('form.input-bar button.stop');
            return error && !busy ? { error, draft: document.querySelector('form.input-bar textarea')?.value,
              chip: document.querySelector('.attach-chip-name')?.textContent,
              users: document.querySelectorAll('.message-user').length } : null;
          })()`), { budgetMs: 30_000, pollMs: 50 });
          if (!settled) throw new Error('the real attachment refusal did not settle');
          rec.check(`${name} refuses before a model request and keeps the draft`, ctx.modelCallCount() === before && settled.draft === 'Summarize this document.' && settled.chip === name && settled.users === 0, JSON.stringify(settled));
          if (baseRender) rec.observe(`merge-base ${name} refusal`, settled);
          else rec.check(`${name} gives a safe next step`, settled.error.includes(expected)
            && !settled.error.includes('WebVM') && !settled.error.includes('Document extraction failed.'), settled.error);
          await evalIn(ctx.page, `document.querySelector('form.input-bar').scrollIntoView({ block: 'end' })`);
          await rec.visual(name.endsWith('.doc') ? 'document-attachment-refusals' : `document-attachment-${name.replace('.', '-')}`);
          await evalIn(ctx.page, `(() => {
            for (const button of document.querySelectorAll('.attach-chip-remove')) button.click();
            const input = document.querySelector('form.input-bar textarea'); input.focus(); input.select();
          })()`);
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await ctx.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
      } finally {
        const restored = await rpc(ctx.page, { type: 'settings/update', patch: { providerName: initial.providerName, providerModel: initial.providerModel } });
        if (restored?.ok !== true) throw new Error('the original provider did not restore');
      }
    },
  },
  {
    name: 'pull-in-moved-tab', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      // why: a fresh Home host leaves the real native panel closed. The shared
      // harness panel must stay alive for the next state.
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, panelPath: 'home/home.html',
        modelResponder: (index) => ({ sse: index === 0 ? sseToolCall('sandbox_create', { kind: 'notebook', name: 'Moved Notebook' }) : sseText('Notebook ready.') }) });
      let browser;
      let notebook;
      let panel;
      let panelSession;
      try {
        await unlockAndReady(child.page);
        const sent = await rpc(child.page, { type: 'agent/send', text: 'Create a Notebook named Moved Notebook.' });
        if (!sent?.ok) throw new Error('real Notebook creation refused');
        if (!await waitFor(async () => {
          const state = await rpc(child.page, { type: 'state/get' });
          return state?.ok && state.state?.session?.messages?.some((message) => message.role === 'assistant' && message.content === 'Notebook ready.' && message.streaming !== true);
        }, { budgetMs: 30_000 })) throw new Error('Notebook creation did not settle');
        const surfaces = await rpc(child.page, { type: 'surfaces/get' });
        if (surfaces?.ok !== true || surfaces.sidePanelOpen !== false) throw new Error('fresh native panel is not closed');
        const target = await waitFor(async () => (await fetch(`http://127.0.0.1:${child.port}/json/list`).then((reply) => reply.json()))
          .find((entry) => entry.url.includes('/engine-tabs/notebook-tab/index.html#')), { budgetMs: 30_000 });
        if (!target) throw new Error('real Notebook target is missing');
        notebook = await attach(target.webSocketDebuggerUrl);
        await notebook.send('Page.enable');
        if (!await waitFor(() => evalIn(notebook, `!!document.querySelector('.peerd-pull')`))) throw new Error('native pull-in chip did not mount');
        const before = await evalIn(notebook, `chrome.tabs.getCurrent().then((tab) => ({ id: tab.id, windowId: tab.windowId, document: performance.timeOrigin }))`, true);
        const movedWindow = await evalIn(notebook, `chrome.windows.create({ tabId: ${before.id}, focused: true }).then((window) => window.id)`, true);
        const after = await evalIn(notebook, `chrome.tabs.getCurrent().then((tab) => ({ id: tab.id, windowId: tab.windowId, document: performance.timeOrigin }))`, true);
        rec.check('the real Notebook tab moves without a new document', before.id === after.id && before.document === after.document
          && before.windowId !== after.windowId && after.windowId === movedWindow, JSON.stringify({ before, after }));
        await notebook.send('Page.bringToFront');
        const button = await evalIn(notebook, `(() => { 'use strict'; const bounds = document.querySelector('.peerd-pull').getBoundingClientRect(); return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; })()`);
        await notebook.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button });
        await notebook.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button });
        const version = await fetch(`http://127.0.0.1:${child.port}/json/version`).then((reply) => reply.json());
        browser = await attach(version.webSocketDebuggerUrl);
        let lastNativeTargets = [];
        const nativeTarget = await waitFor(async () => {
          lastNativeTargets = (await browser.send('Target.getTargets')).targetInfos;
          return lastNativeTargets.find((entry) => entry.url.split('#')[0] === `chrome-extension://${child.sw.id}/sidepanel/sidepanel.html`);
        });
        if (!nativeTarget) throw new Error(`native pull-in did not open a panel: ${JSON.stringify({
          targets: lastNativeTargets.map(({ targetId, type, url }) => ({ targetId, type, url })), before, after,
        })}`);
        ({ sessionId: panelSession } = await browser.send('Target.attachToTarget', { targetId: nativeTarget.targetId, flatten: true }));
        panel = { send: (method, parameters = {}) => browser.send(method, parameters, panelSession) };
        const ownerWindow = await evalIn(panel, `chrome.windows.getCurrent().then((window) => window.id)`, true);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('base native panel window', { ownerWindow, after });
        else rec.check('native pull-in opens in the moved tab window', ownerWindow === after.windowId, JSON.stringify({ ownerWindow, after }));
        if (!await waitFor(() => evalIn(panel, `!!document.querySelector('.input-bar textarea')`))) throw new Error('native panel did not become ready');
        await panel.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
        await rec.visualPage('pull-in-moved-tab', panel);
      } finally {
        if (panelSession) await browser.send('Target.detachFromTarget', { sessionId: panelSession });
        notebook?.close(); browser?.close();
        await child.close();
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
        const status = await evalIn(page, `(() => {
          const row = document.querySelector('.set-row');
          const toggle = document.querySelector('button[role="switch"]');
          return {
            warning: document.querySelector('[role="alert"]')?.textContent ?? '',
            retry: [...document.querySelectorAll('button')].some((button) =>
              button.textContent === 'Retry stop' && !button.disabled),
            legacyRetry: (toggle?.getAttribute('aria-label') ?? '').includes('retry stopping')
              && toggle instanceof HTMLButtonElement && !toggle.disabled,
            badge: row?.querySelector('.set-badge')?.textContent ?? '',
          };
        })()`);
        rec.check('failed live stop stays visible',
          status?.warning.includes('live network could not be stopped'), status?.warning);
        rec.check('failed live stop remains retryable',
          status?.retry === true || (process.env.PEERD_VISUAL_BASE_RENDER === '1'
            && status?.legacyRetry === true), JSON.stringify(status));
        rec.check('the row says the network is still running',
          status?.badge === 'STILL RUNNING', status?.badge);
        await rec.visualPage('options-dweb-stop-failed', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },
  {
    name: 'options-dweb-outcome-unknown', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'tests/fixtures/options-dweb-stop-failed.html?unknown=1', {
        ready: '[role="alert"]',
      });
      try {
        const status = await evalIn(page, `(() => ({
          warning: document.querySelector('[role="alert"]')?.textContent ?? '',
          badge: document.querySelector('.set-badge')?.textContent ?? '',
          reload: [...document.querySelectorAll('button')].some((button) =>
            button.textContent === 'Reload dweb status' && !button.disabled),
          mutationsDisabled: [...document.querySelectorAll('button[role="switch"]')]
            .every((button) => button.disabled),
          reset: [...document.querySelectorAll('button')].some((button) =>
            button.textContent === 'Reset section to defaults'),
        }))()`);
        rec.check('unknown network custody is explicit and offers only reconciliation',
          status?.badge === 'STATUS UNKNOWN' && status?.reload === true
            && status?.mutationsDisabled === true && status?.reset === false
            && status?.warning.includes('could not confirm whether'), JSON.stringify(status));
        await rec.visualPage('options-dweb-outcome-unknown', page);
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
  // why: hold the real disk lock in another document before this VM boots.
  // No CheerpX device can open in either refusal case.
  {
    name: 'vm-disk-ownership', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      if (process.env.PEERD_VISUAL_BASE_RENDER === '1') {
        const extension = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
        if (!extension) throw new Error('base visual render requires an explicit extension tree');
        if (!existsSync(join(extension, 'engine-tabs/vm-tab/disk-lock.js'))) {
          rec.observe('merge-base surface', { present: false, reason: 'disk refusal introduced on this branch' });
          return;
        }
      }
      const holder = await openExtPage(ctx, 'options/options.html');
      let page;
      try {
        const vm = await evalIn(holder, `(async () => {
          const { buildManifest } = await import('/shared/bundle/manifest.js');
          const { packBundle } = await import('/shared/bundle/bundle.js');
          const { toBase64 } = await import('/shared/bundle/bytes.js');
          const { manifest, chunks } = await buildManifest({ payload: packBundle({ files: {} }),
            type: 'vm-recipe', mime: 'application/peerd-vm-recipe', meta: { kind: 'vm', name: 'Disk guard' } });
          const imported = await chrome.runtime.sendMessage({ type: 'import/apply',
            envelope: { format: 'peerd-bundle', version: 1, manifest, chunks: chunks.map(toBase64) } });
          if (!imported?.ok) throw new Error(JSON.stringify(imported));
          const reply = await chrome.runtime.sendMessage({ type: 'vm/get-meta', vmId: imported.id });
          const { diskLockName } = await import('/engine-tabs/vm-tab/disk-lock.js');
          await new Promise(resolve => {
            navigator.locks.request(diskLockName(reply.record.diskOverlayKey), () => {
              resolve(); return new Promise(() => {});
            });
          });
          return reply.record;
        })()`, true);
        for (const failure of ['busy', 'unavailable']) {
          page = await openWidePage(ctx, 'engine-tabs/vm-tab/index.html', { ready: '.boot-card.is-failed' });
          if (failure === 'unavailable') {
            await page.send('Page.addScriptToEvaluateOnNewDocument', { source:
              `Object.defineProperty(navigator, 'locks', { value: { request() { throw new Error('lock service unavailable'); } } });` });
          }
          await page.send('Page.navigate', { url: `chrome-extension://${ctx.sw.id}/engine-tabs/vm-tab/index.html?lock-case=${failure}#${vm.id}` });
          const refused = await waitFor(() => evalIn(page, `(() => {
            if (!document.querySelector('.boot-card.is-failed') || location.hash) return null;
            return { text: document.body.innerText, log: document.getElementById('boot-log')?.textContent,
              cheerpxLoaded: performance.getEntriesByType('resource').some(entry => entry.name.includes('/cheerpx/')) };
          })()`), { budgetMs: 10_000, pollMs: 50 });
          rec.check(`${failure} disk ownership stops before the VM loads`,
            !!refused && !refused.cheerpxLoaded && !refused.log?.includes('IDBDevice.create')
              && refused.text.includes(failure === 'busy' ? 'already open in another tab' : 'Could not lock the VM disk'),
            JSON.stringify(refused));
          const pinClock = () => evalIn(page, `(() => {
            for (const node of document.querySelectorAll('#boot-log, #boot-log *')) {
              for (const text of node.childNodes) if (text.nodeType === 3) text.textContent = text.textContent.replace(/\\d{2}:\\d{2}:\\d{2}/g, '00:00:00').replaceAll(${JSON.stringify(vm.id)}, 'vm-disk-guard');
            }
            // why: match the existing VM capture guard for fixed blur layers.
            const pullIn = document.querySelector('.peerd-pull');
            if (pullIn) { pullIn.style.backdropFilter = 'none'; pullIn.style.webkitBackdropFilter = 'none'; pullIn.getBoundingClientRect(); }
          })()`);
          await rec.visualPage(`vm-disk-${failure}`, page, { beforeShot: pinClock });
          await page.close();
          page = null;
        }
      } finally { try { page?.close(); } catch {} try { await holder.closeTarget(); } catch {} }
    },
  },
  WEBVM_TERMINAL_STATE,
  NOTEBOOK_FETCH_STATE,
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

        const sendNotebook = (message) => evalIn(ctx.swConn, `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.includes(${JSON.stringify(`#${notebookId}`)}));
          if (!tab?.id) throw new Error('Notebook tab not found');
          return chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ notebookId, ...message })});
        })()`, true);
        const draft = 'return 21 * 2';
        await evalIn(page, `document.querySelector('.cm-content').focus()`);
        const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 };
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
        await page.send('Input.insertText', { text: draft });
        if (!await waitFor(async () => (await sendNotebook({ type: 'js/read-file', path: 'notebook.js' }))?.content === draft,
          { budgetMs: 10_000, pollMs: 100 })) throw new Error('Notebook draft did not save');
        const backupDirectory = (create) => evalIn(page, `(async () => {
          let dir = await navigator.storage.getDirectory();
          dir = await dir.getDirectoryHandle('peerd-notebooks');
          dir = await dir.getDirectoryHandle(${JSON.stringify(notebookId)});
          await dir.removeEntry('notebook.before-agent.js', { recursive: true }).catch((error) => {
            if (error.name !== 'NotFoundError') throw error;
          });
          if (${create}) await dir.getDirectoryHandle('notebook.before-agent.js', { create: true });
        })()`, true);
        await backupDirectory(true);
        const backupFailure = await sendNotebook({ type: 'js/eval', code: 'return 43', timeoutMs: 10_000 });
        const keptDraft = await sendNotebook({ type: 'js/read-file', path: 'notebook.js' });
        rec.check('a native backup write failure leaves the saved Notebook draft intact',
          backupFailure?.ok === false && keptDraft?.content === draft, JSON.stringify({ backupFailure, keptDraft }));
        await backupDirectory(false);
        const recovered = await sendNotebook({ type: 'js/eval', code: 'return 43', timeoutMs: 10_000 });
        if (recovered?.ok !== true) throw new Error('Notebook backup retry failed');

        const custodyPath = `peerd-notebook-custody/${notebookId}/mirror.json`;
        const backupAliases = ['notebook.before-agent.js', '/notebook.before-agent.js', 'notebook.before-agent.js/', '///notebook.before-agent.js///'];
        const backupBeforeWrites = await sendNotebook({ type: 'js/read-file', path: backupAliases[0] });
        const boundaryPaths = ['mirror.json', `/${custodyPath}`, `../../${custodyPath}`, `..\\${custodyPath}`, 'bad\0path'];
        const boundaryCode = `
          const paths = ${JSON.stringify([...boundaryPaths, ...backupAliases])};
          const writes = [], deletes = [];
          for (const path of paths) {
            try { await peerd.self.writeFile(path, '{"pending":true}'); writes.push(true); } catch { writes.push(false); }
            try { await peerd.self.deleteFile(path); deletes.push(true); } catch { deletes.push(false); }
          }
          let rootBlocked = false;
          try { await navigator.storage.getDirectory(); } catch { rootBlocked = true; }
          return { writes, deletes, rootBlocked };
        `;
        const boundary = await sendNotebook({ type: 'js/eval', code: boundaryCode, timeoutMs: 10_000 });
        const routeWrite = await sendNotebook({ type: 'js/write-file', path: `/${custodyPath}`, content: '{"pending":true}' });
        const escapeWrite = await sendNotebook({ type: 'js/write-file', path: `../../${custodyPath}`, content: '{"pending":true}' });
        const backupWrites = [];
        for (const path of backupAliases) backupWrites.push(await sendNotebook({ type: 'js/write-file', path, content: 'return 0' }));
        const backupAfterWrites = await sendNotebook({ type: 'js/read-file', path: backupAliases[0] });
        const markerAfterWrites = await evalIn(page, `(async () => {
          let dir = await navigator.storage.getDirectory();
          for (const part of ['peerd-notebook-custody', ${JSON.stringify(notebookId)}]) dir = await dir.getDirectoryHandle(part);
          return JSON.parse(await (await (await dir.getFileHandle('mirror.json')).getFile()).text());
        })().catch(() => null)`, true);
        rec.check('agent file writes and deletes cannot forge the host mirror marker',
          boundary?.result?.value?.rootBlocked === true
            && JSON.stringify(boundary?.result?.value?.writes) === '[true,true,false,false,false,false,false,false,false]'
            && JSON.stringify(boundary?.result?.value?.deletes) === '[true,true,false,false,false,false,false,false,false]'
            && routeWrite?.ok === true && escapeWrite?.ok === false && markerAfterWrites?.code === boundaryCode
            && backupWrites.every((reply) => reply?.ok === false)
            && backupBeforeWrites?.ok === true && backupAfterWrites?.content === backupBeforeWrites?.content,
          JSON.stringify({ boundary, routeWrite, escapeWrite, markerAfterWrites, backupWrites, backupBeforeWrites, backupAfterWrites }));

        const source = await readFile(new URL('../../extension/engine-tabs/notebook-tab/notebook-tab.js', import.meta.url), 'utf8');
        const marker = 'await mirrorOpfs.write(LAST_AGENT_PATH, JSON.stringify({ code: msg.code }));';
        const index = source.indexOf(marker);
        if (index < 0 || source.indexOf(marker, index + 1) >= 0) throw new Error('Notebook marker location is not unique');
        let paused = false;
        page.on((method) => { if (method === 'Debugger.paused') paused = true; });
        await page.send('Debugger.enable');
        const point = await page.send('Debugger.setBreakpointByUrl', {
          url: `chrome-extension://${ctx.sw.id}/engine-tabs/notebook-tab/notebook-tab.js`,
          lineNumber: source.slice(0, index).split('\n').length - 1,
          columnNumber: index - source.lastIndexOf('\n', index - 1) - 1,
        });
        if (!point.locations?.length) throw new Error('Notebook marker breakpoint did not bind');
        const interrupted = sendNotebook({ type: 'js/eval', code: 'return 44', timeoutMs: 10_000 }).catch(() => null);
        if (!await waitFor(() => paused, { budgetMs: 10_000, pollMs: 50 })) throw new Error('Notebook marker commit did not pause');
        await page.send('Debugger.removeBreakpoint', { breakpointId: point.breakpointId });
        await page.send('Page.reload');
        await page.send('Debugger.disable');
        if (!await waitFor(() => evalIn(page, `!document.getElementById('notebook-app').hidden && !!document.querySelector('.cm-content')`),
          { budgetMs: 10_000, pollMs: 100 })) throw new Error('Notebook did not reload');
        await interrupted;
        const blocked = await sendNotebook({ type: 'js/eval', code: 'return 45', timeoutMs: 10_000 });
        const backup = await sendNotebook({ type: 'js/read-file', path: 'notebook.before-agent.js' });
        const notebook = await sendNotebook({ type: 'js/read-file', path: 'notebook.js' });
        const visible = await evalIn(page, `!!document.querySelector('.pe-node[data-path="notebook.before-agent.js"]')`);
        rec.check('reload recovers a journaled replacement and preserves the visible backup',
          blocked?.result?.value === 45 && backup?.content === draft && notebook?.content === 'return 45' && visible === true,
          JSON.stringify({ blocked, backup, notebook, visible }));
        const removed = await evalIn(page, `(async () => {
          const { createRepositoryService } = await import('/peerd-engine/index.js');
          await createRepositoryService().destroy({ kind: 'notebook', id: ${JSON.stringify(notebookId)} }, { worktree: true });
          const root = await navigator.storage.getDirectory();
          return Promise.all(['peerd-notebooks', 'peerd-notebook-custody'].map(async (name) => {
            const parent = await root.getDirectoryHandle(name);
            return parent.getDirectoryHandle(${JSON.stringify(notebookId)}).then(() => false, (error) => error.name === 'NotFoundError');
          }));
        })()`, true);
        rec.check('Notebook destruction removes workspace files and host custody', removed?.every((value) => value === true), JSON.stringify(removed));
      } finally {
        await page.send('Debugger.disable').catch(() => {});
        try { page.close(); } catch { /* */ }
      }
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
  // why: use the real sandbox message and trusted parent, with a reserved URL.
  {
    name: 'app-consent-arming', kind: 'visual', phase: 'post-unlock',
    responder: call => ({ sse: call === 0 ? sseToolCall('sandbox_create', {
      kind: 'app', name: 'Consent guard', files: { 'index.html': `<!doctype html><title>Consent guard</title>
<main><h1>External link</h1><p>The trusted bar must confirm this link.</p></main>
<script>'use strict'; addEventListener('message', event => { if (event.data?.type === 'request-link') parent.postMessage({type:'app-link',href:'https://consent.peerd.test/approved'},'*'); });</script>` },
    }) : sseText('CONSENT-READY') }),
    async run(ctx, rec) {
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      let page, targetId;
      const targets = () => fetch(`http://127.0.0.1:${ctx.port}/json/list`).then(reply => reply.json());
      const opened = () => targets().then(all => all.filter(target => target.url.startsWith('https://consent.peerd.test/')));
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create the Consent guard App.' });
        if (!sent?.ok) throw new Error('Consent App creation failed');
        const target = await waitFor(async () => (await targets()).find(candidate => candidate.title === 'peerd · Consent guard'),
          { budgetMs: 30_000, pollMs: 100 });
        if (!target) throw new Error('Consent App did not open');
        targetId = target.id;
        page = await attach(target.webSocketDebuggerUrl);
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        await page.send('Page.bringToFront');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await waitFor(() => evalIn(page, `document.getElementById('boot')?.classList.contains('is-hidden')`),
          { budgetMs: 10_000, pollMs: 50 });
        const early = await evalIn(page, `(async () => {
          const bar = await new Promise((resolve, reject) => {
            const observer = new MutationObserver(() => {
              const bar = document.querySelector('[role="alertdialog"]');
              if (bar) { observer.disconnect(); clearTimeout(timer); resolve(bar); }
            });
            const timer = setTimeout(() => { observer.disconnect(); reject(new Error('consent bar missing')); }, 5000);
            observer.observe(document.body, { childList: true });
            document.getElementById('app-frame').contentWindow.postMessage({ type: 'request-link' }, '*');
          });
          const allow = [...bar.querySelectorAll('button')].find(button => button.textContent === 'Open link');
          if (!${baseRender}) allow?.click();
          return { disabled: allow?.disabled, open: !!document.querySelector('[role="alertdialog"]'),
            inert: document.getElementById('app-frame').inert, focused: document.activeElement?.textContent };
        })()`, true);
        if (baseRender) {
          await rec.visualPage('app-consent-armed', page);
          await evalIn(page, `[...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Deny').click()`);
          return;
        }
        rec.check('the new prompt blocks immediate approval and makes the App inert',
          early?.disabled && early.open && early.inert && early.focused === 'Deny', JSON.stringify(early));
        await waitFor(() => evalIn(page, `document.querySelector('[role="alertdialog"] button')?.disabled === false`),
          { budgetMs: 5_000, pollMs: 50 });
        const point = await evalIn(page, `(() => {
          const button = [...document.querySelectorAll('[role="alertdialog"] button')].find(node => node.textContent === 'Open link');
          const rect = button.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 2 });
        }
        rec.check('a multi-click after arming cannot approve or open a tab',
          await evalIn(page, `!!document.querySelector('[role="alertdialog"]')`) && (await opened()).length === 0);
        await rec.visualPage('app-consent-armed', page);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        }
        const approved = await waitFor(async () => (await opened())[0], { budgetMs: 5_000, pollMs: 50 });
        rec.check('a deliberate single click opens exactly the confirmed link',
          approved?.url === 'https://consent.peerd.test/approved'
            && await evalIn(page, `!document.querySelector('[role="alertdialog"]') && !document.getElementById('app-frame').inert`));
      } finally {
        for (const target of await opened()) await fetch(`http://127.0.0.1:${ctx.port}/json/close/${target.id}`);
        try { page?.close(); } catch {}
        if (targetId) await fetch(`http://127.0.0.1:${ctx.port}/json/close/${targetId}`);
      }
    },
  },
  // why a child browser: the P handle must open the REAL native side panel, and
  // the shared harness panel must stay as it is for the next state.
  {
    name: 'app-full-screen', kind: 'visual', phase: 'post-unlock',
    visualVariants: ['app-full-screen-button', 'app-full-screen-handle-focus', 'app-full-screen-panel-open'],
    responder: null,
    async run(ctx, rec) {
      const child = await launchPeerd({ extensionDir: ctx.extensionDir, panelPath: 'home/home.html',
        modelResponder: (index) => ({ sse: index === 0 ? sseToolCall('sandbox_create', {
          kind: 'app', name: 'Full screen check', files: { 'index.html': `<!doctype html><title>Full screen check</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f6f6;color:#1a1a1a}main{height:100vh;display:grid;place-content:center;text-align:center}</style>
<main><h1>Full screen check</h1><p>This App fills the whole screen.</p></main>
<script>'use strict'; addEventListener('message', event => { if (event.data?.type === 'request-link') parent.postMessage({type:'app-link',href:'https://full-screen.peerd.test/'},'*'); });
addEventListener('keydown', event => parent.postMessage({type:'full-screen-key',key:event.key},'*'));</script>` },
        }) : sseText('App ready.') }) });
      let app;
      let browser;
      // why observe on the merge base: its render only supplies the before pictures.
      const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const verdict = (name, pass, detail) => (baseRender ? rec.observe(`base ${name}`, { pass, detail }) : rec.check(name, pass, detail));
      const center = (selector) => evalIn(app, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const click = async (selector) => {
        const point = await center(selector);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        }
      };
      const fullScreenView = () => evalIn(app, `(() => {
        const shown = (selector) => { const node = document.querySelector(selector); return !!node && getComputedStyle(node).display !== 'none'; };
        const handle = document.getElementById('peerd-handle').getBoundingClientRect();
        return {
          full: document.fullscreenElement === document.documentElement,
          handle: shown('#peerd-handle'), status: shown('#fullscreen-status'),
          statusText: document.getElementById('fullscreen-status').textContent,
          handleBox: { left: handle.left, width: handle.width, height: handle.height, middle: handle.top + handle.height / 2, viewMiddle: innerHeight / 2 },
          controls: ['#fullscreen-btn', '#actor-chat-toggle', '#export-btn', '#mode-toggle', '.peerd-pull'].filter(shown),
        };
      })()`);
      // why wait for the status too: Chrome sets fullscreenElement first and fires
      // fullscreenchange at the next frame. The handle, the status and the App focus come from that event.
      const fullScreenOn = () => evalIn(app, `document.fullscreenElement === document.documentElement
        && !document.getElementById('fullscreen-status').hidden`);
      try {
        await unlockAndReady(child.page);
        const sent = await rpc(child.page, { type: 'agent/send', text: 'Create the Full screen check App.' });
        if (!sent?.ok) throw new Error('real App creation refused');
        const target = await waitFor(async () => (await fetch(`http://127.0.0.1:${child.port}/json/list`).then((reply) => reply.json()))
          .find((entry) => entry.title === 'peerd · Full screen check'), { budgetMs: 30_000, pollMs: 100 });
        if (!target) throw new Error('the App tab did not open');
        app = await attach(target.webSocketDebuggerUrl);
        await app.send('Runtime.enable');
        await app.send('Page.enable');
        await app.send('Page.bringToFront');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await waitFor(() => evalIn(app, `document.getElementById('boot')?.classList.contains('is-hidden')`), { budgetMs: 10_000, pollMs: 50 });
        // why: the pull-in chip types a short hint in and out after load. Capture after it leaves.
        await waitFor(() => evalIn(app, `!!document.getElementById('peerd-pull-hint')`), { budgetMs: 3_000, pollMs: 50 });
        await waitFor(() => evalIn(app, `!document.getElementById('peerd-pull-hint')`), { budgetMs: 15_000, pollMs: 100 });
        await rec.visualPage('app-full-screen-button', app);
        if (process.env.PEERD_BROWSER_WINDOW_EVIDENCE === '1') await rec.browserWindow('app-window', child, app);
        // why: a merge base from before full screen has no full-screen view to picture.
        if (baseRender && !await evalIn(app, `!!document.getElementById('fullscreen-btn')`)) return;
        await checkAccessibleNames(app, rec, 'the Full screen button has its visible name', [['#fullscreen-btn', 'Full screen']]);
        // why the App reports its keys: a check can then see a key press reach it.
        await evalIn(app, `window.appKeys = []; addEventListener('message', (event) => {
          if (event.source === document.getElementById('app-frame').contentWindow && event.data?.type === 'full-screen-key') window.appKeys.push(event.data.key);
        })`);
        await click('#fullscreen-btn');
        await waitFor(fullScreenOn, { budgetMs: 5_000, pollMs: 50 });
        const entered = await fullScreenView();
        verdict('the button puts the whole App page in full screen, with only the App, the P handle and the Esc status',
          entered.full && entered.handle && entered.status && entered.controls.length === 0
            && entered.statusText === 'Press Esc to leave full screen', JSON.stringify(entered));
        verdict('the P handle sits at the left edge, in the middle', entered.handleBox.left === 0 && entered.handleBox.width === 34
          && entered.handleBox.height === 64 && Math.abs(entered.handleBox.middle - entered.handleBox.viewMiddle) <= 1, JSON.stringify(entered.handleBox));
        // why: full screen hides the button that the click focused. A game or an editor must still get the keys.
        const appFocused = await evalIn(app, `document.activeElement === document.getElementById('app-frame')`);
        for (const type of ['keyDown', 'keyUp']) {
          await app.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, ...(type === 'keyDown' ? { text: 'k' } : {}) });
        }
        const keyReached = await waitFor(() => evalIn(app, `window.appKeys.includes('k')`), { budgetMs: 2_000, pollMs: 50 });
        verdict('the App gets the keys in full screen, with no extra click', appFocused === true && keyReached === true,
          JSON.stringify({ appFocused, keyReached }));
        const hintHidden = await evalIn(app, `(() => {
          const hint = document.createElement('div');
          hint.className = 'peerd-pull-hint';
          document.body.append(hint);
          const display = getComputedStyle(hint).display;
          hint.remove();
          return display === 'none';
        })()`);
        verdict('the pull-in hint stays hidden in full screen', hintHidden === true);
        await checkAccessibleNames(app, rec, 'the P handle names what it does', [['#peerd-handle', 'Open peerd']]);
        const faded = await waitFor(() => evalIn(app, `document.getElementById('fullscreen-status').hidden`), { budgetMs: 8_000, pollMs: 100 });
        verdict('the Esc status hides on its own after a few seconds', faded === true);
        // why show it again: the capture is the moment of entry. Its timer has already run, so nothing hides it mid-shot.
        await rec.visualPage('app-full-screen', app, { beforeShot: (page) => evalIn(page, `document.getElementById('fullscreen-status').hidden = false`) });
        if (process.env.PEERD_BROWSER_WINDOW_EVIDENCE === '1') await rec.browserWindow('full-screen', child, app);
        await evalIn(app, `document.getElementById('fullscreen-status').hidden = true`);
        // why Shift+Tab: the handle comes just before the App frame, and a key press shows the focus ring.
        await pressNativeKey(app, 'Tab', true);
        const handleFocus = await evalIn(app, `(() => {
          const handle = document.getElementById('peerd-handle');
          return document.activeElement === handle && handle.matches(':focus-visible');
        })()`);
        verdict('Shift+Tab from the App reaches the P handle and shows its focus ring', handleFocus === true);
        await rec.visualPage('app-full-screen-handle-focus', app);
        await click('#peerd-handle');
        const version = await fetch(`http://127.0.0.1:${child.port}/json/version`).then((reply) => reply.json());
        browser = await attach(version.webSocketDebuggerUrl);
        const panel = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos
          .find((entry) => entry.url.split('#')[0] === `chrome-extension://${child.sw.id}/sidepanel/sidepanel.html`), { budgetMs: 10_000, pollMs: 100 });
        // why watch, not read once: the handle keeps full screen on because Chrome keeps it
        // beside the panel. A drop a moment after the panel opens must fail here.
        const dropped = await waitFor(() => evalIn(app, `document.fullscreenElement !== document.documentElement`), { budgetMs: 2_000, pollMs: 100 });
        const beside = !dropped;
        verdict('the P handle opens the side panel beside the App, and full screen stays on', !!panel && beside,
          JSON.stringify({ panel: panel?.url ?? null, beside }));
        // why: with the panel beside the App, peerd is on screen and the handle has nothing to open.
        const handleGone = await waitFor(() => evalIn(app, `getComputedStyle(document.getElementById('peerd-handle')).display === 'none'`), { budgetMs: 5_000, pollMs: 50 });
        const frameFocused = await evalIn(app, `document.activeElement === document.getElementById('app-frame')`);
        verdict('once the side panel is open, the P handle hides and its focus goes to the App', handleGone === true && frameFocused === true,
          JSON.stringify({ handleGone, frameFocused }));
        await rec.visualPage('app-full-screen-panel-open', app);
        if (process.env.PEERD_BROWSER_WINDOW_EVIDENCE === '1') await rec.browserWindow('full-screen-beside-panel', child, app);
        // why a native key code: without one, Chrome gives a DevTools key press to the page only,
        // and the browser's own Esc handling never sees it. On macOS, Chrome builds the key press
        // from the code (53). On Linux, the browser reads windowsVirtualKeyCode. 9 is the Linux code for Esc.
        // fullscreenElement clears before the exit event and its focus handlers.
        // Acknowledging that event prevents reentry input racing the old exit.
        await evalIn(app, `(() => {
          window.__fullScreenExitAcknowledged = false;
          const exited = () => {
            if (document.fullscreenElement !== null) return;
            document.removeEventListener('fullscreenchange', exited);
            window.__fullScreenExitAcknowledged = true;
          };
          document.addEventListener('fullscreenchange', exited);
        })()`);
        const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: process.platform === 'darwin' ? 53 : 9 };
        for (const type of ['rawKeyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', { type, ...escape });
        if (!await waitFor(() => evalIn(app, `window.__fullScreenExitAcknowledged === true && document.fullscreenElement === null`), { budgetMs: 5_000, pollMs: 50 })) {
          throw new Error('The browser did not acknowledge full-screen exit');
        }
        // The DOM exits before the native window finishes resizing. Check the
        // restored native window before inspecting the post-Esc controls.
        const windowRestored = await waitFor(async () => {
          const { bounds } = await browser.send('Browser.getWindowForTarget', { targetId: target.id });
          return bounds.windowState === 'normal';
        }, { budgetMs: 5_000, pollMs: 50 });
        const left = await fullScreenView();
        // why beside first: with full screen already gone, Esc would pass without doing anything.
        verdict('Esc leaves full screen and brings the App controls back', beside && windowRestored === true && !left.full && !left.handle && !left.status
          && ['#fullscreen-btn', '#actor-chat-toggle', '#export-btn', '#mode-toggle'].every((selector) => left.controls.includes(selector)),
        JSON.stringify(left));
        // why: the button's own display rule must not beat its hidden attribute, set where the browser cannot go full screen.
        const staysHidden = await evalIn(app, `(() => {
          const button = document.getElementById('fullscreen-btn');
          button.hidden = true;
          const display = getComputedStyle(button).display;
          button.hidden = false;
          return display === 'none';
        })()`);
        verdict('a hidden Full screen button stays hidden', staysHidden === true);
        // why a prompt leaves full screen: the browser's own exit message shows at the top center, over the bar.
        await evalIn(app, `(() => {
          window.__fullScreenReentry = [];
          for (const type of ['click', 'fullscreenerror', 'fullscreenchange']) document.addEventListener(type, event => {
            window.__fullScreenReentry.push({ type, trusted: event.isTrusted,
              target: event.target?.id ?? null, active: navigator.userActivation.isActive,
              focused: document.hasFocus(), full: document.fullscreenElement !== null });
            if (window.__fullScreenReentry.length > 8) window.__fullScreenReentry.shift();
          }, true);
        })()`);
        // The native window can still be resizing after exit. Keyboard activation
        // tests reentry without stale native pointer coordinates; first entry and
        // the P handle above still require real pointer gestures.
        const focusedForReentry = await evalIn(app, `(() => {
          const button = document.getElementById('fullscreen-btn');
          if (button.hidden || getComputedStyle(button).display === 'none') return false;
          button.focus();
          return document.hasFocus() && document.activeElement === button;
        })()`);
        if (!focusedForReentry) throw new Error('The Full screen button could not receive keyboard focus');
        // Enter activates native buttons through a carriage-return keypress;
        // use the shared keyboard path, which includes that character stage.
        await pressKey(app, 'Enter');
        if (!await waitFor(() => evalIn(app, `window.__fullScreenReentry.some(event => event.type === 'click' && event.trusted && event.target === 'fullscreen-btn')`), { budgetMs: 5_000, pollMs: 50 })) {
          const evidence = await evalIn(app, `({ events: window.__fullScreenReentry,
            focused: document.hasFocus(), activeElement: document.activeElement?.id ?? null })`);
          throw new Error(`Keyboard reentry did not deliver a trusted Full screen click: ${JSON.stringify(evidence)}`);
        }
        const again = await waitFor(fullScreenOn, { budgetMs: 5_000, pollMs: 50 });
        // why: the panel that the handle opened is still open, as when a person asks peerd for an App and then clicks Full screen.
        const reentry = await evalIn(app, `({
          chip: document.querySelector('.peerd-pull').getAttribute('aria-label'),
          handle: getComputedStyle(document.getElementById('peerd-handle')).display,
          events: window.__fullScreenReentry,
        })`);
        verdict('full screen with the side panel already open shows no P handle', again === true
          && reentry.chip === 'Close the peerd side panel' && reentry.handle === 'none', JSON.stringify({ again, ...reentry, windowRestored, errors: app.events.slice(-12) }));
        const consent = await evalIn(app, `(async () => {
          const { bar, fullAtPrompt } = await new Promise((resolve, reject) => {
            const observer = new MutationObserver(() => {
              const found = document.querySelector('[role="alertdialog"]');
              if (found) { observer.disconnect(); clearTimeout(timer); resolve({ bar: found, fullAtPrompt: document.fullscreenElement !== null }); }
            });
            const timer = setTimeout(() => { observer.disconnect(); reject(new Error('consent bar missing')); }, 5000);
            observer.observe(document.body, { childList: true });
            document.getElementById('app-frame').contentWindow.postMessage({ type: 'request-link' }, '*');
          });
          await new Promise((resolve) => {
            if (!document.fullscreenElement) { resolve(); return; }
            document.addEventListener('fullscreenchange', resolve, { once: true });
            setTimeout(resolve, 5000);
          });
          const deny = [...bar.querySelectorAll('button')].find((button) => button.textContent === 'Deny');
          const box = deny.getBoundingClientRect();
          const onTop = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === deny;
          deny.click();
          return { full: document.fullscreenElement !== null, fullAtPrompt, onTop };
        })()`, true);
        verdict('a consent prompt leaves full screen and shows on top of the App', again === true && consent?.full === false && consent.fullAtPrompt === false && consent.onTop === true,
          JSON.stringify({ again, ...consent }));
        await evalIn(app, `document.getElementById('mode-toggle').click()`);
        const editing = await waitFor(() => evalIn(app, `document.body.classList.contains('mode-edit')`), { budgetMs: 10_000, pollMs: 100 });
        // why outside full screen: full screen hides the button too, so only the editor's own rule can pass this.
        const editor = await evalIn(app, `({ full: document.fullscreenElement !== null, display: getComputedStyle(document.getElementById('fullscreen-btn')).display })`);
        verdict('the editor shows no Full screen button', editing === true && editor.full === false && editor.display === 'none',
          JSON.stringify({ editing, ...editor }));
      } finally {
        try { app?.close(); } catch { /* already closed */ }
        browser?.close();
        await child.close();
      }
    },
  },
  {
    name: 'library-app-reuse', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('No model call is needed to open a local App.') }),
    async run(ctx, rec) {
      await chooseFixtureNetwork(ctx, false);
      const base = process.env.PEERD_VISUAL_BASE_RENDER === '1';
      const appPage = `chrome-extension://${ctx.sw.id}/engine-tabs/app-tab/index.html`;
      const targets = async () => fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json());
      const beforeApps = await rpc(ctx.page, { type: 'apps/list' });
      if (beforeApps?.ok !== true) throw new Error('The App catalog is unavailable');
      const previousIds = new Set(beforeApps.apps.map((app) => app.id));
      let appId;
      let options;
      let home;
      let app;
      let runner;
      let captured;
      try {
        options = await openWidePage(ctx, 'options/options.html#!/transfer?starter=csv-lab', { ready: '.starter-review' });
        const apply = '.starter-review > button:first-of-type';
        const { phase2, names } = discoverSurface();
        // why the tree's own name: the merge-base tree packages its own starter.
        const starterName = names ? 'Tables and charts' : 'CSV Lab';
        const applyLabel = phase2 ? 'Add to Library' : 'Apply: add local copy';
        const installedText = phase2 ? 'Added to your Library.' : 'Local copy added.';
        const reviewReady = await waitFor(() => evalIn(options,
          `document.querySelector(${JSON.stringify(apply)})?.textContent.trim() === ${JSON.stringify(applyLabel)}
            && document.querySelector(${JSON.stringify(apply)}).disabled === false`));
        if (!reviewReady) throw new Error(`The packaged ${starterName} review is not ready`);
        await clickAndSyncRedraw(options, apply);
        const installed = await waitFor(() => evalIn(options,
          `document.querySelector('.starter-review')?.innerText.includes(${JSON.stringify(installedText)})`));
        rec.check(`the real packaged ${starterName} copy is installed`, installed === true);
        if (!installed) throw new Error(`The ${starterName} Apply outcome is not known`);
        const listed = await rpc(ctx.page, { type: 'apps/list' });
        const added = listed?.apps?.filter((row) => !previousIds.has(row.id) && row.name === starterName) ?? [];
        rec.check('the catalog contains one new durable App ID', listed?.ok === true && added.length === 1);
        if (added.length !== 1) throw new Error('The installed App ID is not unique');
        appId = added[0].id;
        await options.close();
        options = null;
        home = await openWidePage(ctx, 'home/home.html#library', { ready: '.home-shell' });
        // why: a hidden Home can defer its redraw. Observe the actual reply without replacing it.
        await evalIn(home, `(async () => {
          'use strict';
          const browser = (await import('/shared/browser-api.js')).default;
          const send = browser.runtime.sendMessage.bind(browser.runtime);
          globalThis.__libraryOpenReceipts = [];
          browser.runtime.sendMessage = (message, ...args) => {
            const row = message?.type === 'apps/open' ? { appId: message.appId, settled: false } : null;
            if (row) globalThis.__libraryOpenReceipts.push(row);
            const pending = send(message, ...args);
            if (row) Promise.resolve(pending).then(
              (reply) => { row.reply = reply; row.settled = true; },
              (error) => { row.error = String(error); row.settled = true; });
            return pending;
          };
        })()`, true);
        const openSelector = `.library-card[data-app-id="${appId}"] [data-library-action="open"]`;
        const open = `document.querySelector(${JSON.stringify(openSelector)})`;
        const buttonReady = await waitFor(() => evalIn(home, `!!(${open}) && !(${open}).disabled`));
        if (!buttonReady) throw new Error('The Library Open button is not ready');
        await clickAndSyncRedraw(home, openSelector);
        const original = await waitFor(async () => (await targets()).find((row) =>
          row.type === 'page' && row.url.startsWith(`${appPage}#${appId}?owner=`)));
        if (!original) throw new Error('The first Library Open did not create an App host');
        const firstReceipt = await waitFor(() => evalIn(home,
          `globalThis.__libraryOpenReceipts.length === 1 && globalThis.__libraryOpenReceipts[0].settled
            ? globalThis.__libraryOpenReceipts[0] : null`), { budgetMs: 45_000 });
        rec.check('the first single Open has a known native receipt', firstReceipt?.appId === appId
          && firstReceipt.reply?.ok === true, JSON.stringify(firstReceipt));
        if (firstReceipt?.reply?.ok !== true) throw new Error('The first Open outcome is not known');
        app = await attach(original.webSocketDebuggerUrl);
        await app.send('Page.enable');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
        const sandbox = await waitFor(async () => {
          const host = await evalIn(app, `({ ready: !!document.querySelector('#boot.is-hidden')
            && !document.querySelector('#boot.is-failed'), url: document.querySelector('#app-frame')?.src })`);
          return host.ready && (await targets()).find((row) => row.type === 'iframe'
            && row.parentId === original.id && row.url === host.url);
        });
        if (!sandbox) throw new Error('The real App sandbox did not become ready');
        runner = await attach(sandbox.webSocketDebuggerUrl);
        const sealed = await waitFor(() => evalIn(runner, `(() => {
          'use strict';
          const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'peerd');
          return globalThis.origin === 'null' && document.title === ${JSON.stringify(starterName)}
            && !!document.querySelector('#csv') && typeof document.querySelector('#analyze')?.onclick === 'function'
            && descriptor?.writable === false && descriptor.configurable === false && Object.isFrozen(descriptor.value);
        })()`));
        rec.check(`the exact opaque ${starterName} sandbox is initialized`, sealed === true);
        if (!sealed) throw new Error('The App sandbox identity is not qualified');
        const identities = [];
        for (const [target, page] of [[original, app], [sandbox, runner]]) {
          const contexts = new Map();
          page.on((method, params) => {
            if (method === 'Runtime.executionContextCreated') contexts.set(params.context.id, params.context);
            if (method === 'Runtime.executionContextDestroyed') contexts.delete(params.executionContextId);
            if (method === 'Runtime.executionContextsCleared') contexts.clear();
          });
          await page.send('Runtime.enable');
          const { frameTree } = await page.send('Page.getFrameTree');
          const context = await waitFor(() => [...contexts.values()].find((row) =>
            row.auxData?.isDefault && row.auxData.frameId === frameTree.frame.id));
          if (!context?.uniqueId) throw new Error('The App heap identity is unavailable');
          const handle = await page.send('Runtime.evaluate', { expression: 'globalThis', contextId: context.id });
          if (handle.exceptionDetails || !handle.result?.objectId) throw new Error('The App heap handle is unavailable');
          identities.push({ target, page, contexts, context, objectId: handle.result.objectId,
            frame: frameTree.frame, document: await evalIn(page, `({ href: location.href, timeOrigin: performance.timeOrigin })`) });
        }
        const owner = new URLSearchParams(new URL(original.url).hash.split('?')[1]).get('owner');
        const durableOwner = await rpc(home, { type: 'session/get', sessionId: owner });
        rec.check('the App URL has a real durable owner', !!owner && durableOwner?.ok === true
          && durableOwner.session?.sessionId === owner);
        const queryEvidence = await evalIn(home, `(async () => {
          'use strict';
          return { canonical: ${JSON.stringify(original.url)},
            old: await chrome.tabs.query({ url: ${JSON.stringify(`${appPage}#${appId}*`)} }),
            broad: await chrome.tabs.query({ url: ${JSON.stringify(`${appPage}*`)} }) };
        })()`, true);
        rec.observe('native fragment and page queries before reuse', queryEvidence);
        const readyAgain = await waitFor(() => evalIn(home, `(async () => {
          'use strict';
          (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
          return !!(${open}) && !(${open}).disabled;
        })()`, true));
        if (!readyAgain) throw new Error('The first Library Open did not settle');
        await clickAndSyncRedraw(home, openSelector);
        const receipts = await waitFor(() => evalIn(home, `globalThis.__libraryOpenReceipts.length === 2
          && globalThis.__libraryOpenReceipts[1].settled ? globalThis.__libraryOpenReceipts : null`), { budgetMs: 45_000 });
        if (!base) rec.check('the second single Open has a known native receipt', receipts?.length === 2
          && receipts.every((row) => row.appId === appId && row.reply?.ok === true), JSON.stringify(receipts));
        const after = await targets();
        const live = after.filter((row) => row.type === 'page'
          && row.url.split('#')[0] === appPage && new URL(row.url).hash.slice(1).split('?')[0] === appId);
        const heaps = [];
        for (const identity of identities) {
          const read = await identity.page.send('Runtime.callFunctionOn', { objectId: identity.objectId,
            functionDeclaration: 'function () { "use strict"; return { current: this === globalThis, href: location.href, timeOrigin: performance.timeOrigin }; }',
            returnByValue: true }).catch((error) => ({ error: String(error) }));
          const { frameTree } = await identity.page.send('Page.getFrameTree');
          heaps.push({ targetId: identity.target.id, before: identity.document, after: read.result?.value,
            unchanged: !read.exceptionDetails && read.result?.value?.current === true
              && identity.contexts.get(identity.context.id)?.uniqueId === identity.context.uniqueId
              && frameTree.frame.id === identity.frame.id && frameTree.frame.loaderId === identity.frame.loaderId
              && read.result.value.href === identity.document.href
              && read.result.value.timeOrigin === identity.document.timeOrigin });
        }
        const catalog = await rpc(home, { type: 'apps/list' });
        rec.check('Open keeps the same durable App catalog entry', catalog?.ok === true
          && catalog.apps.filter((row) => !previousIds.has(row.id)).length === 1
          && catalog.apps.some((row) => row.id === appId));
        rec.check('Library Open needs no model request', ctx.modelCallCount() === 0);
        const reuse = live.length === 1 && live[0].id === original.id && live[0].url === original.url
          && heaps.length === 2 && heaps.every((heap) => heap.unchanged);
        rec.observe('actual Library reuse', { appId, original, live, heaps, reuse, base,
          receipts: receipts ?? await evalIn(home, 'globalThis.__libraryOpenReceipts') });
        // why: the base must show its real duplicate host. It predates this reuse fix.
        if (!base) rec.check('sequential Open keeps one exact tab, URL, document and both heaps', reuse);
        const capture = live.find((row) => row.id !== original.id) ?? live[0];
        if (!capture) throw new Error('No actual App host remains for capture');
        captured = capture.id === original.id ? app : await attach(capture.webSocketDebuggerUrl);
        await captured.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
        const painted = await waitFor(() => evalIn(captured, `document.readyState === 'complete'
          && (!!document.querySelector('#boot.is-hidden') || !!document.querySelector('#boot.is-failed'))`));
        if (!painted) throw new Error('The actual App outcome did not render');
        rec.observe('captured App outcome', await evalIn(captured,
          `({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 600) })`));
        await rec.visualPage('library-app-reuse', captured);
      } finally {
        try {
          if (captured && captured !== app) captured.close();
          runner?.close();
          app?.close();
          if (appId) for (const target of (await targets()).filter((row) => row.type === 'page'
            && row.url.split('#')[0] === appPage && new URL(row.url).hash.slice(1).split('?')[0] === appId)) {
            await fetch(`http://127.0.0.1:${ctx.port}/json/close/${target.id}`);
          }
        } finally {
          await home?.close();
          await options?.close();
        }
      }
    },
  },
  {
    name: 'app-editor-save-recovery', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex) => ({ sse: callIndex === 0
      ? sseToolCall('sandbox_create', {
        kind: 'app', name: 'Editor recovery', files: {
          'index.html': '<!doctype html><title>Editor recovery</title><h1>Draft recovery</h1><script>peerd.data.set("first", {saved:true})</script>',
        },
      }) : sseText('EDITOR-RECOVERY-READY') }),
    async run(ctx, rec) {
      const directory = await mkdtemp(join(tmpdir(), 'peerd-editor-recovery-'));
      const priorTargets = new Set((await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json())).map((target) => target.id));
      let page;
      let vaultLocked = false;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create an App named Editor recovery.' });
        rec.check('App creation accepted', sent?.ok === true, JSON.stringify(sent));
        const target = await waitFor(async () => {
          const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json());
          return targets.find((candidate) => candidate.type === 'page'
            && candidate.title === 'peerd · Editor recovery' && !priorTargets.has(candidate.id)) ?? null;
        }, { budgetMs: 30_000, pollMs: 100 });
        if (!target) throw new Error('The created App did not render');
        page = await attach(target.webSocketDebuggerUrl);
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        await page.send('Page.bringToFront');
        await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
        const appId = new URL(target.url).hash.slice(1).split('?')[0];
        const firstData = await waitFor(() => evalIn(page, `(async () => {
          const { opfsHelpers } = await import('/peerd-engine/opfs.js');
          return opfsHelpers(['peerd-apps', ${JSON.stringify(appId)}]).read('data/first.json').catch(() => null);
        })()`, true), { budgetMs: 10_000, pollMs: 100 });
        rec.check('the first peerd.data.set creates a real absent OPFS path', firstData === '{"saved":true}', firstData);
        await evalIn(page, `document.getElementById('mode-toggle').click()`);
        await waitFor(() => evalIn(page, `!!document.querySelector('#editor-panel:not([hidden]) .cm-content')`),
          { budgetMs: 10_000, pollMs: 100 });
        const loaded = await evalIn(page, `(async () => {
          const { EditorView } = await import('/vendor/codemirror/cm.js');
          const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
          view.focus();
          return view.state.doc.toString();
        })()`, true);
        for (const type of ['keyDown', 'keyUp']) {
          await page.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
            modifiers: type === 'keyDown' ? (process.platform === 'darwin' ? 4 : 2) : 0 });
        }
        await sleep(600);
        const afterUndo = await evalIn(page, `(async () => {
          const { EditorView } = await import('/vendor/codemirror/cm.js');
          const { opfsHelpers } = await import('/peerd-engine/index.js');
          return { buffer: EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString(),
            saved: await opfsHelpers(['peerd-apps', ${JSON.stringify(appId)}]).read('index.html') };
        })()`, true);
        rec.check('Undo after loading leaves the App source and saved file intact',
          !!loaded && afterUndo?.buffer === loaded && afterUndo.saved === loaded, JSON.stringify(afterUndo));
        await rec.shotPage('undo-after-load', page);
        await evalIn(page, `(() => {
          const original = window.prompt;
          window.prompt = () => 'notes.txt';
          document.querySelector('.pe-new').click();
          window.prompt = original;
        })()`);
        const created = await waitFor(() => evalIn(page,
          `document.querySelector('.pe-node.is-active')?.dataset.path === 'notes.txt'`),
        { budgetMs: 10_000, pollMs: 100 });
        rec.check('the real editor creates and opens a new file', !!created);
        await evalIn(page, `(() => {
          globalThis.__retiredAppDocument = true;
          document.getElementById('mode-toggle').click();
        })()`);
        const renewed = await waitFor(() => evalIn(page, `
          document.readyState === 'complete'
          && globalThis.__retiredAppDocument === undefined
          && location.href === ${JSON.stringify(target.url)}
          && document.getElementById('boot')?.classList.contains('is-hidden')
          && !document.getElementById('boot')?.classList.contains('is-failed')
          && !!document.getElementById('mode-toggle')
          && document.getElementById('editor-panel')?.hidden === true
        `).catch(() => false), { budgetMs: 15_000, pollMs: 100 });
        rec.check('View replaces a consent-retired document through the exact App host URL', !!renewed);
        await rec.shotPage('fresh-consent-document', page);
        await evalIn(page, `document.getElementById('mode-toggle').click()`);
        // Wait for the exact interactive target after the new document boots.
        // An ignored readiness timeout otherwise becomes an opaque null.click.
        const editorReady = await waitFor(() => evalIn(page, `
          document.readyState === 'complete'
          && !!document.querySelector('#editor-panel:not([hidden]) .cm-content')
          && !!document.querySelector('#editor-panel .pe-node[data-path="notes.txt"]')
        `), { budgetMs: 10_000, pollMs: 100 });
        if (!editorReady) {
          const diagnostic = await evalIn(page, `({
            url: location.href,
            readyState: document.readyState,
            mode: document.body.className,
            toggle: document.getElementById('mode-toggle')?.textContent,
            boot: document.getElementById('boot')?.className,
            bootMessage: document.getElementById('boot-msg')?.textContent,
            editorHidden: document.getElementById('editor-panel')?.hidden,
            files: [...document.querySelectorAll('.pe-node[data-path]')].map((node) => node.dataset.path),
          })`);
          rec.observe('renewed App editor runtime errors', page.events.slice(-12));
          if (process.env.PEERD_VISUAL_BASE_RENDER === '1' && diagnostic.boot?.includes('is-failed') && diagnostic.bootMessage) {
            rec.observe('merge-base App editor', diagnostic);
            await rec.visualPage('app-editor-recovery', page);
            return;
          }
          throw new Error(`The renewed App editor did not expose notes.txt: ${JSON.stringify(diagnostic)}`);
        }
        await evalIn(page, `document.querySelector('.pe-node[data-path="notes.txt"]').click()`);
        await waitFor(() => evalIn(page,
          `document.querySelector('.pe-node.is-active')?.dataset.path === 'notes.txt'`),
        { budgetMs: 10_000, pollMs: 100 });
        const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
        const selectFile = async (path) => {
          const opened = await evalIn(page, `(() => {
            const directory = document.querySelector('.pe-node[data-kind="dir"][data-path="data"]');
            if (directory?.getAttribute('aria-expanded') === 'false') directory.click();
            const file = [...document.querySelectorAll('.pe-node[data-kind="file"]')].find((node) => node.dataset.path === ${JSON.stringify(path)});
            file?.click();
            return !!file;
          })()`);
          if (!opened || !await waitFor(() => evalIn(page,
            `document.querySelector('.pe-node.is-active')?.dataset.path === ${JSON.stringify(path)}`),
          { budgetMs: 10_000, pollMs: 100 })) throw new Error(`Editor file did not open: ${path}`);
        };
        const replaceDraft = async (content) => {
          await evalIn(page, `(async () => {
            const { EditorView } = await import('/vendor/codemirror/cm.js');
            const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
            view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            view.focus();
          })()`, true);
          await page.send('Input.insertText', { text: content });
        };
        const savedText = (path) => evalIn(page, `(async () => {
          const { opfsHelpers } = await import('/peerd-engine/opfs.js');
          return opfsHelpers(['peerd-apps', ${JSON.stringify(appId)}]).read(${JSON.stringify(path)});
        })()`, true);
        // why: this records real replies. It never replaces a route result.
        await evalIn(page, `(async () => {
          const browser = (await import('/shared/browser-api.js')).default;
          const original = browser.runtime.sendMessage.bind(browser.runtime);
          globalThis.__engineReplies = [];
          browser.runtime.sendMessage = async (message, ...args) => {
            const reply = await original(message, ...args);
            if (['app/editor-write', 'app/actor-chat'].includes(message?.type)) {
              globalThis.__engineReplies.push({ type: message.type, path: message.path, reply });
            }
            return reply;
          };
        })()`, true);
        const chat = async (text) => {
          const before = await evalIn(page, `document.querySelectorAll('.actor-chat-message').length`);
          await evalIn(page, `(() => {
            if (document.getElementById('actor-chat-drawer').hidden) document.getElementById('actor-chat-toggle').click();
            const input = document.getElementById('actor-chat-input');
            input.focus(); input.select();
          })()`);
          await page.send('Input.insertText', { text });
          await evalIn(page, `document.getElementById('actor-chat-send').click()`);
          const settled = await waitFor(() => evalIn(page, `(() => {
            const messages = [...document.querySelectorAll('.actor-chat-message')];
            const last = messages.at(-1);
            const input = document.getElementById('actor-chat-input');
            if (messages.length < ${before + 2} || last?.dataset.role === 'user' || input.disabled) return null;
            return { text: last.textContent, role: last.dataset.role, prompt: input.value,
              reply: globalThis.__engineReplies.filter((entry) => entry.type === 'app/actor-chat').at(-1)?.reply };
          })()`), { budgetMs: 60_000, pollMs: 100 });
          if (!settled) throw new Error('The real App actor chat did not settle');
          return settled;
        };
        ctx.setModelResponder(() => ({ sse: sseText('APP-DRAWER-READY') }));
        const workingChat = await chat('Reply with APP-DRAWER-READY.');
        rec.check('the real App actor drawer works before the error control',
          workingChat.role === 'actor' && workingChat.text === 'APP-DRAWER-READY' && workingChat.reply?.ok === true,
          JSON.stringify(workingChat));
        ctx.setModelResponder(() => ({ status: 401, body: '{"error":{"message":"invalid api key SECRET-PROVIDER-TEXT"}}' }));
        const authChat = await chat('Keep this prompt after a rejected key.');
        rec.check('the actor receives a real model 401', authChat.reply?.ok === false
          && /HTTP 401/.test(authChat.reply?.error ?? '') && ctx.modelCallCount() > 0, JSON.stringify(authChat));
        if (baseRender) rec.observe('merge-base actor 401 guidance', authChat);
        else rec.check('the drawer names a rejected key and keeps the known-refusal prompt',
          authChat.text === 'API key rejected (401). Check or update it in Settings.'
          && authChat.prompt === 'Keep this prompt after a rejected key.' && !authChat.text.includes('SECRET-PROVIDER-TEXT'),
          JSON.stringify(authChat));
        await rec.visualPage('app-actor-chat-auth-refusal', page);
        await evalIn(page, `document.getElementById('actor-chat-close').click()`);
        await selectFile('data/first.json');
        const invalidJson = '{"saved":';
        await replaceDraft(invalidJson);
        const invalidSave = await waitFor(async () => {
          const saved = await savedText('data/first.json');
          const result = await evalIn(page, `({ text: document.getElementById('app-save-message').textContent,
            visible: !document.getElementById('app-save-status').hidden,
            reply: globalThis.__engineReplies.filter((entry) => entry.type === 'app/editor-write').at(-1)?.reply })`);
          return result.visible || saved === invalidJson ? { ...result, saved } : null;
        }, { budgetMs: 10_000, pollMs: 100 });
        if (!invalidSave) throw new Error('The real invalid JSON save did not settle');
        if (baseRender) rec.observe('merge-base invalid JSON write', invalidSave);
        else rec.check('invalid JSON stays in the editor and cannot replace the durable file',
          invalidSave.saved === firstData && invalidSave.reply?.code === 'app-file-invalid-json'
          && invalidSave.text.includes('Fix the JSON to save it.'), JSON.stringify(invalidSave));
        rec.check('the invalid JSON draft remains available to repair', await evalIn(page, `(async () => {
          const { EditorView } = await import('/vendor/codemirror/cm.js');
          return EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString() === ${JSON.stringify(invalidJson)};
        })()`, true));
        await rec.visualPage('app-editor-invalid-json', page);
        const repairedJson = '{"saved":true,"repaired":true}';
        await replaceDraft(repairedJson);
        // why: the successful save clears this banner after replacing the OPFS
        // file. Reading a File snapshot during that replacement can fail.
        const repaired = await waitFor(async () => await evalIn(page, `document.getElementById('app-save-status').hidden`)
          && await savedText('data/first.json') === repairedJson, { budgetMs: 10_000, pollMs: 100 });
        rec.check('valid JSON saves through the same editor after repair', !!repaired);
        if (!repaired) throw new Error('The JSON repair did not reach the durable file');
        await selectFile('index.html');
        const originalHtml = await savedText('index.html');
        const lockedDraft = `${originalHtml}\n<!-- Keep this draft through a locked save. -->`;
        const locked = await rpc(ctx.page, { type: 'vault/lock' });
        if (locked?.ok !== true) throw new Error(`Vault lock failed: ${JSON.stringify(locked)}`);
        vaultLocked = true;
        await replaceDraft(lockedDraft);
        const lockNotice = await waitFor(() => evalIn(page, `document.getElementById('app-save-status').hidden
          ? null : document.getElementById('app-save-status').textContent`), { budgetMs: 10_000, pollMs: 100 });
        const lockedReply = await evalIn(page, `globalThis.__engineReplies.filter((entry) => entry.type === 'app/editor-write').at(-1)?.reply`);
        rec.check('the real locked save refuses before a disk change and keeps Retry',
          lockedReply?.error === 'vault-locked' && await savedText('index.html') === originalHtml
          && await evalIn(page, `document.getElementById('app-save-retry').textContent === 'Retry'`), JSON.stringify({ lockNotice, lockedReply }));
        if (baseRender) rec.observe('merge-base locked save guidance', lockNotice);
        else rec.check('the Save banner directs the user to unlock',
          lockNotice?.includes('Unlock it in the peerd panel, then retry.') && !lockNotice.includes('free browser storage'), lockNotice);
        await rec.visualPage('app-editor-locked-save', page);
        const beforeLockedChat = ctx.modelCallCount();
        const lockedChat = await chat('Keep this prompt while the vault is locked.');
        rec.check('a locked drawer send makes no model call', ctx.modelCallCount() === beforeLockedChat, JSON.stringify(lockedChat));
        if (baseRender) rec.observe('merge-base locked actor guidance', lockedChat);
        else rec.check('the drawer names a real known locked refusal and keeps its prompt',
          lockedChat.reply?.error === 'vault-locked' && lockedChat.reply?.outcomeKnown === true
          && lockedChat.text === 'Vault is locked. Unlock it in the peerd panel, then send again.'
          && lockedChat.prompt === 'Keep this prompt while the vault is locked.', JSON.stringify(lockedChat));
        await rec.visualPage('app-actor-chat-locked-refusal', page);
        const unlocked = await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
        if (unlocked?.ok !== true) throw new Error(`Vault unlock failed: ${JSON.stringify(unlocked)}`);
        vaultLocked = false;
        await evalIn(page, `document.getElementById('app-save-retry').click()`);
        const retried = await waitFor(async () => await evalIn(page, `document.getElementById('app-save-status').hidden`)
          && await savedText('index.html') === lockedDraft, { budgetMs: 10_000, pollMs: 100 });
        rec.check('unlock and the existing Retry save the exact draft', !!retried);
        if (!retried) throw new Error('The real save retry did not finish');
        ctx.setModelResponder(() => ({ sse: sseText('APP-DRAWER-RECOVERED') }));
        const recoveredChat = await chat('Reply with APP-DRAWER-RECOVERED.');
        rec.check('the drawer works after unlock without a page reload',
          recoveredChat.role === 'actor' && recoveredChat.text === 'APP-DRAWER-RECOVERED' && recoveredChat.reply?.ok === true,
          JSON.stringify(recoveredChat));
        await evalIn(page, `document.getElementById('actor-chat-close').click()`);
        await selectFile('notes.txt');
        ctx.setModelResponder(() => ({ sse: sseText('EDITOR-RECOVERY-READY') }));
        const draft = 'These edits exist only in the open draft.\nKeep every character: café ✓';
        await evalIn(page, `(async () => {
          const browser = (await import('/shared/browser-api.js')).default;
          const original = browser.runtime.sendMessage.bind(browser.runtime);
          globalThis.__editorWriteAttempts = 0;
          globalThis.__editorDeleteAttempts = 0;
          browser.runtime.sendMessage = (message, ...args) => {
            if (message?.type === 'app/editor-delete') globalThis.__editorDeleteAttempts += 1;
            if (message?.type === 'app/editor-write') {
              globalThis.__editorWriteAttempts += 1;
              return Promise.resolve({ ok: false, outcomeKnown: false, error: 'save receipt lost' });
            }
            return original(message, ...args);
          };
          document.querySelector('.cm-content').focus();
        })()`, true);
        await page.send('Input.insertText', { text: draft });
        const notice = await waitFor(() => evalIn(page, `(() => {
          const status = document.getElementById('app-save-status');
          return status && !status.hidden ? status.textContent : null;
        })()`), { budgetMs: 5_000, pollMs: 100 });
        rec.check('unknown save offers a draft download before reopening',
          notice?.includes('Download edits') && notice.includes('Download a copy before reopening'), notice);
        await evalIn(page, `(async () => {
          document.getElementById('mode-toggle').click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const original = window.confirm;
          window.confirm = () => true;
          document.querySelector('.pe-node.is-active').focus();
          document.querySelector('.pe-delete').click();
          window.confirm = original;
          await new Promise((resolve) => setTimeout(resolve, 50));
        })()`, true);
        rec.check('View and Delete cannot hide recovery or replay an uncertain save',
          await evalIn(page, `document.getElementById('app-save-retry').textContent === 'Download edits'
            && document.getElementById('boot').classList.contains('is-hidden')
            && globalThis.__editorDeleteAttempts === 0 && globalThis.__editorWriteAttempts === 1`));
        await rec.shotPage('unknown-save', page);
        await evalIn(page, `document.getElementById('app-save-retry').click()`);
        const downloaded = await waitFor(() => readFile(join(directory, 'notes.txt'), 'utf8').catch(() => null),
          { budgetMs: 10_000, pollMs: 100 });
        rec.check('the recovery button downloads the exact unsaved draft', downloaded === draft, downloaded);
        await ctx.page.send('Page.bringToFront');
        await evalIn(page, `(async () => {
          window.dispatchEvent(new PageTransitionEvent('pagehide'));
          await new Promise((resolve) => setTimeout(resolve, 50));
        })()`, true);
        const after = await evalIn(page, `(async () => {
          const { EditorView } = await import('/vendor/codemirror/cm.js');
          const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
          const { opfsHelpers } = await import('/peerd-engine/opfs.js');
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return {
            draft: view.state.doc.toString(),
            saved: await opfsHelpers(['peerd-apps', ${JSON.stringify(appId)}]).read('notes.txt'),
            attempts: globalThis.__editorWriteAttempts,
            guard: event.defaultPrevented,
            url: location.href,
            noticeVisible: !document.getElementById('app-save-status').hidden,
          };
        })()`, true);
        rec.check('download and subsequent suspension preserve the dirty buffer without retry or reload',
          after?.draft === draft && after.saved === '' && after.attempts === 1
            && after.guard === true && after.url === target.url && after.noticeVisible === true,
          JSON.stringify(after));
        await page.send('Page.bringToFront');
        await rec.visualPage('app-editor-recovery', page);
        await rec.shotPage('draft-preserved', page);
      } finally {
        if (vaultLocked) await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
        try { await page?.send('Page.setDownloadBehavior', { behavior: 'default' }); } catch {}
        try { page?.close(); } catch {}
        await rm(directory, { recursive: true, force: true });
      }
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
    name: 'eval-page-authority', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      const page = await openWidePage(ctx, 'eval/runner.html', { ready: '#cfgA, #cfgB' });
      let priorRunner;
      let patchAttempted = false;
      const requireCheck = (name, pass, detail = '') => {
        rec.check(name, pass, detail);
        if (!pass) throw new Error(name);
      };
      try {
        const state = await rpc(page, { type: 'state/get' });
        const status = await rpc(page, { type: 'provider/status' });
        const models = await rpc(page, { type: 'models/options' });
        const local = await rpc(page, { type: 'local-model/status' });
        const model = models?.options?.find((option) => option.provider === 'ollama')?.model;
        requireCheck('the exact eval page reads its state, provider, model inventory, and default local status',
          state?.ok === true && status?.ok === true && models?.ok === true && local?.ok === true
            && typeof model === 'string' && model.length > 0,
          JSON.stringify({ stateOk: state?.ok, status, models, local }));
        priorRunner = state.state?.settings?.runnerModel ?? '';
        const loaded = await waitFor(() => evalIn(page, `(() => {
          const model = ${JSON.stringify(model)};
          return ['cfgA', 'cfgB'].every((id) => [...document.getElementById(id).options]
            .some((option) => option.value === model))
            && document.getElementById('warn').textContent.trim() === '';
        })()`), { budgetMs: 15_000, pollMs: 80 });
        requireCheck('the eval A/B selectors render the keyless provider without a false warning', loaded === true);

        // The A/B button would launch the whole task suite. Exercise the same
        // exact-page setting boundary directly without downloads or page work.
        patchAttempted = true;
        const changed = await rpc(page, { type: 'settings/update', patch: { runnerModel: model } });
        const selected = await rpc(page, { type: 'state/get' });
        requireCheck('eval can pin its own runner model', changed?.ok === true
          && selected?.state?.settings?.runnerModel === model, JSON.stringify(changed));
        const invalidSettings = [
          { type: 'settings/update', patch: { runnerModel: model, devMode: state.state?.settings?.devMode === true } },
          { type: 'settings/update', patch: { runnerModel: model }, extra: 'not-authorized' },
          { type: 'settings/update', patch: { runnerModel: null } },
        ];
        const settingsRefusals = [];
        for (const message of invalidSettings) settingsRefusals.push(await rpc(page, message));
        requireCheck('eval cannot add arbitrary settings, outer fields, or an invalid runner-model shape',
          settingsRefusals.every((reply) => reply?.error === 'vault-route-unauthorized-sender'),
          JSON.stringify(settingsRefusals));
        const parameterRefusals = [];
        for (const type of ['state/get', 'provider/status', 'models/options', 'local-model/status']) {
          parameterRefusals.push(await rpc(page, { type, model }));
        }
        requireCheck('eval read routes reject extra caller-controlled parameters',
          parameterRefusals.every((reply) => reply?.error === 'vault-route-unauthorized-sender'),
          JSON.stringify(parameterRefusals));
        const unchanged = await rpc(page, { type: 'state/get' });
        requireCheck('refused eval requests preserve the selected runner and other settings',
          unchanged?.state?.settings?.runnerModel === model
            && unchanged?.state?.settings?.devMode === selected?.state?.settings?.devMode,
          JSON.stringify({ runnerModel: unchanged?.state?.settings?.runnerModel, devMode: unchanged?.state?.settings?.devMode }));
        const restored = await rpc(page, { type: 'settings/update', patch: { runnerModel: priorRunner } });
        const after = await rpc(page, { type: 'state/get' });
        requireCheck('eval restores the previous runner model through the same narrow route', restored?.ok === true
          && (after?.state?.settings?.runnerModel ?? '') === priorRunner, JSON.stringify(restored));
        patchAttempted = false;
        await rec.shotPage('eval-ready', page);
      } finally {
        if (patchAttempted && typeof priorRunner === 'string') {
          await rpc(ctx.page, { type: 'settings/update', patch: { runnerModel: priorRunner } }).catch(() => {});
        }
        await retirePrivateTransferPage(page);
      }
    },
  },
  {
    name: 'eval-runner', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      // Dev-only and pruned from the store package, but it is a dense control
      // panel that renders fully at rest and is easy to break with a grid change.
      const page = await openWidePage(ctx, 'eval/runner.html', { ready: 'button, select' });
      try {
        // why: rejected provider reads used to become empty selects and a
        // misleading missing-key warning, which screenshot capture alone passed.
        const status = await rpc(page, { type: 'provider/status' });
        const models = await rpc(page, { type: 'models/options' });
        const model = models?.options?.find((option) => option.provider === 'ollama')?.model;
        const admitted = status?.ok === true && models?.ok === true && typeof model === 'string' && model.length > 0;
        rec.check('the eval document can read the configured keyless provider and model inventory', admitted,
          JSON.stringify({ status, models }));
        if (!admitted) throw new Error('eval provider or model inventory was refused');
        let rendered;
        const loaded = await waitFor(async () => {
          rendered = await evalIn(page, `({
            a: [...document.querySelectorAll('#cfgA option')].map((option) => option.value),
            b: [...document.querySelectorAll('#cfgB option')].map((option) => option.value),
            warning: document.querySelector('#warn')?.textContent.trim(),
          })`);
          return rendered?.a?.includes(model) && rendered?.b?.includes(model) && rendered?.warning === '';
        }, { budgetMs: 15_000, pollMs: 80 });
        rec.check('both eval model selectors populate without a false missing-key warning', loaded === true,
          JSON.stringify(rendered));
        if (!loaded) throw new Error('eval model selectors did not load');
        await rec.visualPage('eval-runner', page);
      }
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
  // message_actor ends the first turn. Its isolated reply re-enters later as a
  // fenced wake. Plain fixture text keeps this cross-process proof egress-free.
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
      // ORCHESTRATOR: the async wake turn carrying the fenced reply returns a final answer.
      if (body.includes('you messaged has replied')) return { sse: sseText('FINAL-ORCH-REPLY') };
      // The first orchestrator turn delegates once, then ends on the async ack.
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
      const collapsedFabric = await waitFor(
        () => evalIn(ctx.page, `document.querySelector('.actor-fabric-toggle')?.getAttribute('aria-expanded')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('the live Actor Fabric starts as a compact, accessible disclosure',
        collapsedFabric === 'false', String(collapsedFabric));
      if (collapsedFabric) await rec.shot('actor-fabric-collapsed');
      await evalIn(ctx.page, `document.querySelector('.actor-fabric-toggle')?.click()`);
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
            toggleHeight: toggleRect.height,
            withinViewport: panelRect.left >= 0 && panelRect.right <= innerWidth,
            contentFits: !!body && body.scrollWidth <= body.clientWidth
              && [...body.querySelectorAll('.actor-fabric-node')].every((node) => node.scrollWidth <= node.clientWidth),
          };
        })()`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('opening the live Actor Fabric reveals an inspectable actor in the panel',
        fabric?.expanded === 'true'
          && fabric?.actorKind === 'bound'
          && fabric?.actorPressed === 'false'
          && fabric?.withinViewport === true
          && fabric?.contentFits === true
          && fabric?.toggleHeight >= 44,
        JSON.stringify(fabric));
      if (fabric) {
        const session = await rpc(ctx.page, { type: 'state/get' });
        await reloadReadyPanel(ctx, {
          expectedSessionId: session?.state?.session?.sessionId ?? null,
        });
        const rehydrated = await waitFor(
          () => evalIn(ctx.page, `(() => {
            const panel = document.querySelector('.actor-fabric');
            const toggle = panel?.querySelector('.actor-fabric-toggle');
            if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
            const actor = panel?.querySelector('[data-node-id^="actor:"]');
            return panel && actor ? panel.textContent : null;
          })()`),
          { budgetMs: 15_000, pollMs: 50 });
        rec.check('opening the rehydrated fabric reveals the still-live actor',
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
      // The composer remains disabled for a brief interval while the fenced
      // wake turn settles. A disabled textarea refuses focus, which left the
      // inspected actor button focused and correctly paused the receipt's
      // accessibility-aware expiry forever. Body is always an available,
      // deterministic focus target outside the fabric.
      await evalIn(ctx.page, `(() => {
        document.body.tabIndex = -1;
        document.body.focus();
      })()`);
      await ctx.page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: 1, y: 1, button: 'none',
      });
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
      await clickAndSyncRedraw(ctx.page,
        '.tool-call.tool-actor.tool-not-run .tool-call-header');
      const expanded = await waitFor(
        () => evalIn(ctx.page, `document.querySelector('.tool-actor .tool-call-header')?.getAttribute('aria-expanded') === 'true'
          && !!document.querySelector('.tool-actor .actor-body')`),
        { budgetMs: 5_000, pollMs: 50 });
      rec.check('the live actor card expands', !!expanded);
      const out = await evalIn(ctx.page, `(() => {
        const card = document.querySelector('.tool-call.tool-actor.tool-not-run');
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
      await chooseFixtureNetwork(ctx, true);
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
      await chooseFixtureNetwork(ctx, true);
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
      if (body.includes('<actor_agent>')) {
        actorState.actorCalls += 1;
        return { delayMs: 2_500, sse: sseText('this-never-renders') };
      }
      if (body.includes('you messaged has replied')) {
        actorState.wakeCalls += 1;
        return { sse: sseText('should-not-reach-wake') };
      }
      if (actorState.afterStop) {
        actorState.continuationCalls += 1;
        return { sse: sseText('POST-STOP-CONTINUATION') };
      }
      // delegate once, then end the orchestrator turn (so it doesn't re-delegate
      // on the post-ack step) — leaving exactly one hung actor for Stop to cancel.
      if (actorState.delegates === 0) {
        actorState.delegates += 1;
        return { sse: sseToolCall('message_actor', { to: 'web', message: 'do a slow web read' }) };
      }
      return { sse: sseText('Delegated; awaiting the slow web read.') };
    },
    async run(ctx, rec) {
      actorState = {
        delegates: 0, seen: [], afterStop: false,
        actorCalls: 0, wakeCalls: 0, continuationCalls: 0,
      };
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'slowly read the page' });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      const stoppedSessionId = await waitFor(async () => {
        const admitted = await rpc(ctx.page, { type: 'state/get' });
        return admitted?.state?.session?.sessionId ?? null;
      }, { budgetMs: 5_000, pollMs: 25 });
      const pending = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call.tool-actor.tool-pending')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('the actor card is working (pending) before Stop', !!pending);
      const actorInFlight = await waitFor(
        () => actorState.actorCalls === 1 ? { ...actorState } : null,
        { budgetMs: 15_000, pollMs: 50 });
      rec.check('the isolated actor crossed its model boundary before Stop',
        actorInFlight?.actorCalls === 1, JSON.stringify(actorInFlight ?? actorState));
      const stopped = await rpc(ctx.page, { type: 'agent/stop' });
      rec.check('agent/stop accepted', !!stopped?.ok, JSON.stringify(stopped));
      const cancelled = await waitFor(
        () => evalIn(ctx.page, `!!document.querySelector('.tool-call.tool-actor.tool-cancelled')`),
        { budgetMs: 15_000, pollMs: 100 });
      rec.check('Stop cascades to the in-flight actor; card flips to cancelled',
        !!cancelled);
      let busy = true;
      await waitFor(async () => { busy = await evalIn(ctx.page, `!!document.querySelector('form.input-bar button.stop')`); return !busy; }, { budgetMs: 12_000 });
      rec.check('Stop returns the chat to idle', busy === false);
      actorState.afterStop = true;
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const noLeak = await evalIn(ctx.page, `![...document.querySelectorAll('.message-assistant .bubble')].some((b) => b.textContent.includes('this-never-renders'))`);
      rec.check('the hung actor reply never renders', noLeak === true);
      rec.check('Stop suppresses every late actor wake/model call',
        actorState.actorCalls === 1 && actorState.wakeCalls === 0
          && actorState.continuationCalls === 0,
        JSON.stringify(actorState));
      const noFailure = await evalIn(ctx.page, `(() => ({
        failed: document.querySelectorAll('.message-assistant.failed').length,
        unknown: document.body.innerText.includes('Turn outcome unknown'),
      }))()`);
      rec.check('Stop does not surface a failed or unknown-outcome turn',
        noFailure.failed === 0 && noFailure.unknown === false, JSON.stringify(noFailure));

      let durableSession = null;
      const durableCancellation = await waitFor(async () => {
        if (!stoppedSessionId) return null;
        const result = await rpc(ctx.page, {
          type: 'session/get', sessionId: stoppedSessionId,
        }).catch(() => null);
        durableSession = result?.session ?? null;
        return result?.session?.messages?.find((message) =>
          message?.synthetic === true
            && message?.actorReply?.aborted === true
            && message?.actorReply?.performed === false
            && message?.actorReply?.outcomeKnown === true) ?? null;
      }, { budgetMs: 15_000, pollMs: 50 });
      rec.check('Stop durably records the host-proven cancelled actor receipt before reload',
        !!durableCancellation, JSON.stringify(durableCancellation ?? durableSession));

      await reloadReadyPanel(ctx, { expectedSessionId: stoppedSessionId });
      const persisted = await waitFor(() => evalIn(ctx.page, `(() => {
        const state = {
          busy: !!document.querySelector('form.input-bar button.stop'),
          failed: document.querySelectorAll('.message-assistant.failed').length,
          unknown: document.body.innerText.includes('Turn outcome unknown'),
          request: [...document.querySelectorAll('.message-user:not(.message-actor-reply) .bubble')]
            .some((bubble) => bubble.textContent.includes('slowly read the page')),
          cancelled: !!document.querySelector('.tool-call.tool-actor.tool-cancelled'),
        };
        // Stop can win before the post-tool model round emits prose. The durable
        // turn is the user request plus its host-stamped cancelled tool receipt.
        return state.request && state.cancelled && !state.busy ? state : null;
      })()`), { budgetMs: 15_000, pollMs: 100 });
      rec.check('the stopped turn and cancelled actor receipt survive panel reload',
        persisted?.request === true && persisted?.cancelled === true && persisted?.busy === false
          && persisted?.failed === 0 && persisted?.unknown === false,
        JSON.stringify(persisted));

      const continued = await rpc(ctx.page, {
        type: 'agent/send', text: 'confirm the chat can continue after Stop',
      });
      rec.check('a subsequent turn is accepted', !!continued?.ok, JSON.stringify(continued));
      const resumed = await waitFor(() => evalIn(ctx.page, `(() => {
        const bubbles = [...document.querySelectorAll('.message-assistant .bubble')]
          .map((bubble) => bubble.textContent.trim());
        const busy = !!document.querySelector('form.input-bar button.stop');
        return bubbles.includes('POST-STOP-CONTINUATION') && !busy ? { bubbles, busy } : null;
      })()`), { budgetMs: 20_000, pollMs: 100 });
      rec.check('a subsequent model turn succeeds with valid persisted history',
        !!resumed, JSON.stringify(resumed));
      rec.check('only the admitted actor and explicit post-Stop user turn reached the model',
        actorState.actorCalls === 1 && actorState.continuationCalls === 1,
        JSON.stringify(actorState));
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

  // --- functional: a TOOL-BEARING actor runs + pages in its isolated heap ---
  // The child emits an oversized script value, receives the trusted spill note,
  // and pages the late sentinel through read_result before it answers. This is the
  // physical actor-worker -> controller -> SW -> result-store path; the unit tiers
  // can prove its projected grant but cannot prove that the live actor owns the
  // spill or that both exact authority operations share its session.
  {
    name: 'actor-tools-offscreen', kind: 'functional', phase: 'post-unlock',
    responder: (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
        actorToolsState.childCalls += 1;
        const latest = toolResultsIn(body).at(-1) ?? '';
        if (actorToolsState.childCalls === 1) return { sse: sseToolCall('script', {
          code: "return 'x'.repeat(24_000) + ['SPAWNED', 'PAGER', 'LATE', 'SENTINEL'].join('-');",
        }) };
        if (actorToolsState.childCalls === 2) {
          actorToolsState.scriptResult = latest;
          actorToolsState.spillKey = latest.match(
            /Read more with read_result \{ "key": "([^"]+)"/,
          )?.[1] ?? '';
          return { sse: sseToolCall('read_result', {
            key: actorToolsState.spillKey, offset: 16_000, limit: 16_000,
          }) };
        }
        actorToolsState.pagedResult = latest;
        return { sse: sseText('CHILD-PAGED-LATE-SENTINEL') };
      }
      if (actorToolsState.spawned === 0) {
        actorToolsState.spawned += 1;
        return { sse: sseToolCall('actor_create', {
          task: 'return an oversized value with script, page its late sentinel, and report it',
          tools: ['script'], sync: true,
        }) };
      }
      return { sse: sseText('FINAL-WITH-PAGED-CHILD') };
    },
    async run(ctx, rec) {
      actorToolsState = {
        spawned: 0, childCalls: 0, spillKey: '', scriptResult: '', pagedResult: '',
      };
      const priorAuditIds = new Set((await auditEntries(ctx)).map((entry) => entry.id));
      const sent = await rpc(ctx.page, {
        type: 'agent/send', text: 'use an actor to prove oversized script result paging',
      });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      let out = {};
      await waitFor(async () => {
        out = await evalIn(ctx.page, `(() => {
          const bubbles = [...document.querySelectorAll('.message-assistant .bubble')].map((b) => b.textContent.trim());
          const busy = !!document.querySelector('form.input-bar button.stop');
          return { bubbles, busy };
        })()`) || {};
        return (out.bubbles || []).includes('FINAL-WITH-PAGED-CHILD') && !out.busy;
      }, { budgetMs: 45_000 });

      const entries = (await auditEntries(ctx)).filter((entry) => !priorAuditIds.has(entry.id));
      const isolation = actorIsolationEvidence(entries);
      const toolNames = entries.filter((entry) => entry.type === 'tool_executed')
        .map((entry) => entry.details?.tool);
      const exactEffects = entries.filter((entry) => entry.type === 'authority_effect'
        && ['turn.execution.spill-script', 'turn.resource.read-result']
          .includes(entry.details?.operation));
      const effectSessions = [...new Set(exactEffects.map((entry) => entry.sessionId))];
      const isolatedSameSession = effectSessions.length === 1
        && isolation.isolated.some((entry) =>
          (entry.sessionId ?? entry.details?.actorSessionId) === effectSessions[0]);
      rec.check('the child looped in isolation through script, read_result, then answer',
        actorToolsState.childCalls >= 3, `childCalls=${actorToolsState.childCalls}`);
      rec.check('the child ran in a dedicated Worker with a verified realm', isolation.exactProof === true, `isolated=${isolation.isolated.length}`);
      rec.check('the oversized script result emitted an opaque pager without leaking the late sentinel',
        actorToolsState.spillKey.startsWith('result:')
          && actorToolsState.scriptResult.includes('read_result')
          && !actorToolsState.scriptResult.includes('SPAWNED-PAGER-LATE-SENTINEL'),
        JSON.stringify({ key: actorToolsState.spillKey, initialChars: actorToolsState.scriptResult.length }));
      rec.check('read_result returned the late sentinel inside the same actor heap',
        actorToolsState.pagedResult.includes('SPAWNED-PAGER-LATE-SENTINEL'));
      rec.check('script and read_result both executed through the live gated relay',
        toolNames.includes('script') && toolNames.includes('read_result'), JSON.stringify(toolNames));
      rec.check('spill and pager used exact authority operations under one actor session',
        exactEffects.some((entry) => entry.details?.operation === 'turn.execution.spill-script')
          && exactEffects.some((entry) => entry.details?.operation === 'turn.resource.read-result')
          && exactEffects.every((entry) => entry.details?.outcomeKnown === true)
          && isolatedSameSession,
        JSON.stringify({ effects: exactEffects, effectSessions }));
      rec.check('it did NOT enter the background turn driver or fail isolation', isolation.backgroundRefused === false && isolation.isolationFailed === false);
      rec.check('the paged child result round-tripped into the orchestrator final answer', (out.bubbles || []).includes('FINAL-WITH-PAGED-CHILD'));
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

  // A real nested fabric covers root → temporary child → bound child layout.
  {
    name: 'actor-fabric-hierarchy', kind: 'functional', phase: 'post-unlock',
    responder: async (callIndex, request) => {
      const body = (request && request.postData) || '';
      if (actorFabricHierarchyState.phase === 'prepare') {
        if (!actorFabricHierarchyState.targetOpened) {
          actorFabricHierarchyState.targetOpened = true;
          return { sse: sseToolCall('open_tab', { url: actorFabricHierarchyState.fixtureUrl }) };
        }
        return { sse: sseText('FABRIC-TARGET-READY') };
      }
      if (body.includes('kind: bound; type: web')) {
        actorFabricHierarchyState.webCalls += 1;
        // why: the inspector is a live-state assertion. A fixed response delay
        // races long single-Chrome runs and can settle the node before the
        // harness clicks it, even though the complete topology rendered.
        await actorFabricHierarchyState.inspectionGate;
        return { sse: sseText('NESTED-WEB-DONE') };
      }
      if (body.includes('<actor_agent>') && body.includes('kind: ephemeral')) {
        if (body.includes('inspect price through the web actor')) {
          actorFabricHierarchyState.nestedCalls += 1;
          if (actorFabricHierarchyState.nestedCalls === 1) {
            return { sse: sseToolCall('message_actor', { to: 'web', message: 'inspect the current price' }) };
          }
          actorFabricHierarchyState.nestedResults = toolResultsIn(body);
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
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Actor fabric target</title><main>Widget price: 42</main>');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const fixtureUrl = `http://orders.peerd.test:${/** @type {{port:number}} */ (server.address()).port}/actor-fabric`;
      let fixtureTabId = null;
      let releaseInspection = () => {};
      const inspectionGate = new Promise((resolve) => {
        releaseInspection = () => resolve(undefined);
      });
      actorFabricHierarchyState = {
        phase: 'prepare', fixtureUrl, targetOpened: false,
        spawned: 0, nestedCalls: 0, siblingCalls: 0, webCalls: 0, nestedResults: [],
        inspectionGate, releaseInspection,
      };
      try {
        // why: earlier states may leave this shared test chat with a settled
        // `web` binding to a tab they closed. This state proves fresh binding,
        // so isolate it in the same ordinary new-chat path a user would take.
        await rpc(ctx.page, { type: 'session/reset' });
        // Generic `web` is intentionally unable to invent authority over an
        // arbitrary tab. Establish a real public target through open_tab and
        // the shipped Go control before exercising the nested delegation.
        await rpc(ctx.page, { type: 'agent/send', text: 'FABRIC-PREP-TARGET open the comparison page' });
        await waitFor(async () => {
          const status = await probe(ctx);
          const rendered = await evalIn(ctx.page, `document.body.textContent?.includes('FABRIC-TARGET-READY') === true`);
          return !status.busy && rendered;
        }, { budgetMs: 20_000, pollMs: 50 });
        const fixtureTab = await waitFor(() => evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) =>
          tabs.find((tab) => tab.url === ${JSON.stringify(fixtureUrl)}) ?? null)`, true),
        { budgetMs: 10_000, pollMs: 50 });
        if (!Number.isInteger(fixtureTab?.id)) throw new Error('actor-fabric-target-not-opened');
        fixtureTabId = fixtureTab.id;
        const goReady = await waitFor(() => evalIn(ctx.page,
          `document.querySelectorAll('.agent-tab-notice-go').length > 0`),
        { budgetMs: 5_000, pollMs: 50 });
        if (!goReady) throw new Error('actor-fabric-target-control-not-rendered');
        await evalIn(ctx.page, `([...document.querySelectorAll('.agent-tab-notice-go')].at(-1)?.click(), true)`);
        const activated = await waitFor(() => evalIn(ctx.page,
          `chrome.tabs.get(${fixtureTabId}).then((tab) => tab.active === true)`, true),
        { budgetMs: 5_000, pollMs: 50 });
        if (!activated) throw new Error('actor-fabric-target-not-activated');
        actorFabricHierarchyState.phase = 'hierarchy';
      const sent = await rpc(ctx.page, {
        type: 'agent/send', text: 'compare price and warranty with isolated actors',
      });
      rec.check('agent/send accepted', !!sent?.ok, JSON.stringify(sent));
      await waitFor(() => evalIn(ctx.page,
        `document.querySelector('.actor-fabric-toggle')?.getAttribute('aria-expanded') === 'false'`));
      await evalIn(ctx.page, `document.querySelector('.actor-fabric-toggle')?.click()`);
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
      const hierarchyDetail = hierarchy ?? {
        counters: { ...actorFabricHierarchyState },
        dom: await evalIn(ctx.page, `({
          fabric: document.querySelector('.actor-fabric')?.textContent ?? '',
          tools: [...document.querySelectorAll('.tool-call')].map((node) => node.textContent ?? ''),
          replies: [...document.querySelectorAll('.message-actor-reply')].map((node) => node.textContent ?? ''),
        })`),
        audit: (await auditEntries(ctx, 80)).slice(-20).map((entry) => ({
          type: entry.type, details: entry.details,
        })),
      };
      rec.check('the live fabric renders two sibling subactors and one nested bound actor',
        hierarchy?.nodes >= 4
          && hierarchy?.topSubactors >= 2
          && hierarchy?.nestedBound === true,
        JSON.stringify(hierarchyDetail));
      rec.check('the deep hierarchy fits 390px and stays height-bounded',
        hierarchy?.contentFits === true && hierarchy?.heightCapped === true,
        JSON.stringify(hierarchy));
      rec.check('solid/dashed semantics and both real tasks are legible',
        hierarchy?.text.includes('temporary subactor')
          && hierarchy?.text.includes('web actor')
          && hierarchy?.text.includes('inspect price through the web actor')
          && hierarchy?.text.includes('compare warranty terms independently'),
        JSON.stringify(hierarchy?.text));

      await clickAndSyncRedraw(ctx.page,
        '.actor-fabric:not(.is-settled) .actor-fabric-branch .actor-fabric-branch .actor-fabric-node.is-bound');
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
      actorFabricHierarchyState.releaseInspection();

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
      } finally {
        releaseInspection();
        if (Number.isInteger(fixtureTabId)) {
          await evalIn(ctx.page, `chrome.tabs.remove(${fixtureTabId}).catch(() => {})`, true)
            .catch(() => {});
        }
        server.close();
      }
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

      // Mount the monitor only after the authoritative topology is live. Its
      // first automatic load still proves the live UI path without depending
      // on a background interval that Chrome may heavily throttle in a long run.
      const page = await openWidePage(ctx, 'home/home.html#library', { ready: '.home-shell' });
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

        await evalIn(page, `document.querySelector('[data-home-view="actors"]')?.click()`);

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
        const renderedDetail = rendered ?? await evalIn(page, `(() => ({
          text: document.querySelector('.actor-space')?.textContent ?? '',
          error: document.querySelector('.actor-space-error')?.textContent ?? '',
          loading: document.querySelector('.actor-space-loading')?.textContent ?? '',
          rooms: document.querySelectorAll('.actor-space-room').length,
          nodes: document.querySelectorAll('.actor-space-node').length,
          hidden: document.hidden,
        }))()`);
        rec.check('Actor Space renders two orchestrator rooms and both workers',
          rendered?.rooms === 2 && rendered?.nodes >= 6 && rendered?.subactors >= 4,
          JSON.stringify(renderedDetail));
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
        })()`), { budgetMs: 5_000, pollMs: 40 });
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
        await waitFor(async () => {
          const overview = await rpc(page, { type: 'actors/overview' });
          return overview?.roots?.length === 0 ? overview : null;
        }, { budgetMs: 45_000, pollMs: 150 });
        const refreshReady = await waitFor(() => evalIn(page, `(() => {
          const refresh = document.querySelector('.actor-space-refresh');
          return refresh instanceof HTMLButtonElement && !refresh.disabled;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        if (!refreshReady) throw new Error('actor-space-refresh-not-ready');
        await evalIn(page, `document.querySelector('.actor-space-refresh')?.click()`);
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
        if (alphaRoot) {
          await rpc(ctx.page, { type: 'session/switch', sessionId: alphaRoot }).catch(() => null);
          await rpc(ctx.page, { type: 'agent/stop' }).catch(() => null);
        }
        if (betaRoot) {
          await rpc(ctx.page, { type: 'session/switch', sessionId: betaRoot }).catch(() => null);
          await rpc(ctx.page, { type: 'agent/stop' }).catch(() => null);
        }
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
          const socketProbe = JSON.stringify(actorAppProbeUrl.replace(/^http:/, 'ws:'));
          const udpProbe = JSON.stringify(`https://127.0.0.1:${actorAppStunPort}`);
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
  const egressAttempts = [];
  const attemptEgress = (name, operation) => {
    egressAttempts.push(name);
    try {
      const result = operation();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}
  };
  attemptEgress('fetch-no-cors-post', () => fetch(${probe} + '/fetch', {
    method: 'POST', mode: 'no-cors', keepalive: true, body: 'exfiltration-probe',
  }));
  attemptEgress('XMLHttpRequest', () => {
    const request = new XMLHttpRequest();
    request.open('POST', ${probe} + '/xhr');
    request.send('exfiltration-probe');
  });
  attemptEgress('WebSocket', () => {
    const socket = new WebSocket(${socketProbe} + '/websocket');
    socket.addEventListener('open', () => socket.close(), { once: true });
    return socket;
  });
  attemptEgress('EventSource', () => {
    const source = new EventSource(${probe} + '/event-source');
    setTimeout(() => source.close(), 500);
    return source;
  });
  attemptEgress('sendBeacon', () => navigator.sendBeacon(
    ${probe} + '/beacon', 'exfiltration-probe',
  ));
  attemptEgress('WebTransport', () => {
    if (typeof WebTransport !== 'function') return undefined;
    const transport = new WebTransport(${udpProbe} + '/webtransport');
    transport.closed.catch(() => {});
    return transport;
  });
  attemptEgress('link-ping', () => {
    const link = document.createElement('a');
    link.href = '#ping-target';
    link.ping = ${probe} + '/ping';
    document.body.appendChild(link);
    link.click();
  });
  attemptEgress('Worker-fetch', () => {
    const worker = new Worker(URL.createObjectURL(new Blob([
      'fetch(' + JSON.stringify(${probe} + '/worker') + ').catch(() => {})',
    ], { type: 'application/javascript' })));
    setTimeout(() => worker.terminate(), 500);
    return worker;
  });
  attemptEgress('SharedWorker-fetch', () => {
    if (typeof SharedWorker !== 'function') return undefined;
    const worker = new SharedWorker(URL.createObjectURL(new Blob([
      'fetch(' + JSON.stringify(${probe} + '/shared-worker') + ').catch(() => {})',
    ], { type: 'application/javascript' })));
    setTimeout(() => worker.port.close(), 500);
    return worker;
  });
  parent.postMessage({ type: 'e2e-egress-attempts', attempts: egressAttempts }, '*');
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
      let probeDatagrams = 0;
      const server = createServer((req, res) => {
        probeHits.push(req.url ?? '');
        res.writeHead(204); res.end();
      });
      server.on('connection', () => { probeConnections += 1; });
      server.on('clientError', (_error, socket) => socket.destroy());
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = /** @type {{ port: number }} */ (server.address()).port;
      actorAppProbeUrl = `http://127.0.0.1:${port}`;
      const udpServer = createSocket('udp4');
      udpServer.on('message', () => { probeDatagrams += 1; });
      await new Promise((resolve) => udpServer.bind(0, '127.0.0.1', resolve));
      actorAppStunPort = /** @type {{ port: number }} */ (udpServer.address()).port;
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
            globalThis.__e2eEgressAttempts = [];
            globalThis.__e2eAppPolicies = [];
            globalThis.__e2eParentPolicies = [];
            addEventListener('message', (event) => {
              const frame = document.getElementById('app-frame');
              if (event.source !== frame?.contentWindow) return;
              if (event.data?.type === 'e2e-binary-proof') {
                globalThis.__e2eBinaryProofs.push({ ...event.data, receivedAt: performance.now() });
              }
              if (event.data?.type === 'e2e-binary-error') globalThis.__e2eBinaryErrors.push(event.data.error);
              if (event.data?.type === 'e2e-egress-attempts') {
                globalThis.__e2eEgressAttempts.push(...(event.data.attempts ?? []));
              }
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
        const expectedEgressAttempts = [
          'fetch-no-cors-post', 'XMLHttpRequest', 'WebSocket', 'EventSource',
          'sendBeacon', 'WebTransport', 'link-ping', 'Worker-fetch', 'SharedWorker-fetch',
        ];
        const egressAttempts = await evalIn(appPage, `globalThis.__e2eEgressAttempts ?? []`);
        rec.check('the raw App network API matrix ran and made zero HTTP(S)/WebSocket connections',
          expectedEgressAttempts.every((name) => egressAttempts.includes(name))
            && probeHits.length === 0 && probeConnections === 0,
          JSON.stringify({ attempts: egressAttempts, hits: probeHits, connections: probeConnections,
            policies: await evalIn(appPage, `globalThis.__e2eAppPolicies ?? []`) }));
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
        rec.check('App, data:, and blob: realms emit no WebRTC or WebTransport datagrams',
          probeDatagrams === 0, `udpHits=${probeDatagrams}`);
        await evalIn(appPage, `document.getElementById('mode-toggle')?.click()`);
        const editorState = await waitFor(() => evalIn(appPage, `(() => {
          const rows = [...document.querySelectorAll('.pe-node.is-readonly')];
          if (rows.length < 3 || document.getElementById('editor-panel')?.hidden !== false) return null;
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
        udpServer.close();
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
  {
    name: 'narrow-sidebar', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('narrow layout ready') }),
    async run(ctx, rec) {
      const { providerName, providerModel, reasoningEnabled } = (await rpc(ctx.page, { type: 'state/get' })).state.settings;
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
              // why: narrow controls must not clip or wrap their labels.
              unsqueezed: controls.every((el) => el.scrollWidth <= el.clientWidth
                && el.getBoundingClientRect().height <= 30),
              actionsFit: actions.length === 7 && actions.every(inside),
              actionNames: actions.map((el) => el.getAttribute('aria-label')),
            };
          })()`));
        }
        // why: the row must wrap before controls become too narrow.
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
        await rpc(ctx.page, { type: 'settings/update', patch: { providerName, providerModel, reasoningEnabled } });
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
      }
    },
  },
];

// why: keep the functional check and include the same real flow in CI images.
const appEditorRecovery = STATES.find((state) => state.name === 'app-editor-save-recovery');
if (!appEditorRecovery) throw new Error('App editor recovery state is missing');
STATES.push({ ...appEditorRecovery, name: 'app-editor-recovery', kind: 'visual' });
