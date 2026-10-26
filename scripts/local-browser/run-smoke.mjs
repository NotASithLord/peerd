#!/usr/bin/env bun
// Real extension/browser plumbing with optional local decision-model inference.
// The orchestrator and text helper stay scripted; this is not a full model-pair,
// Mac latency, or general web-success benchmark.
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchPeerd, unlockAndReady, resetSession, rpc, evalIn, waitFor,
} from '../cdp/e2e-harness.mjs';
import { BRIDGE_MODEL, createBrowserDecisionResponder, assistantSse, makeLocalClients } from './model-bridge.mjs';
import { parseSiteClientContract } from './api-policy.mjs';
import {
  GIT_FIXTURE_HOST, GIT_FIXTURE_TLS_CERT, GIT_FIXTURE_TLS_KEY, GIT_FIXTURE_SPKI_SHA256_BASE64,
} from '../acceptance/git-smart-http-fixture.mjs';

const decisionOrigin = process.argv.find((arg) => arg.startsWith('--decision-origin='))?.slice(18);
// makeLocalClients validates an explicit numeric loopback endpoint before IO.
const realDecision = decisionOrigin ? makeLocalClients({ decisionOrigin }).decide : null;
const EVIDENCE_CLASS = realDecision ? 'real-decision-scripted-helper-real-browser' : 'scripted-model-real-browser';
const REPORT = resolve(dirname(fileURLToPath(import.meta.url)),
  `../cdp/artifacts/local-browser-smoke/${realDecision ? 'mixed-result' : 'result'}.json`);
const SUITE_BUDGET_MS = 240_000;
const CASE_BUDGET_MS = realDecision ? 120_000 : 65_000;
const CASES = [
  { name: 'search-navigation', mutate: false },
  { name: 'mutation-replan', mutate: true },
  { name: 'api-reuse', mutate: false, api: true },
];
const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
if (requestedCase && !CASES.some((row) => row.name === requestedCase)) {
  throw new Error(`Unknown smoke case: ${requestedCase}`);
}
if (realDecision && requestedCase === 'api-reuse') {
  throw new Error('The API reuse fixture uses a scripted selector and makes no decision-model call; run it without --decision-origin.');
}

const API_ITEMS = Object.freeze({
  copper: { id: 'CW-42', name: 'Copper widget', price: 12.5, available: true },
  silver: { id: 'SW-19', name: 'Silver widget', price: 24, available: false },
  gold: { id: 'GW-07', name: 'Gold widget', price: 48, available: true },
});
const apiClientDefinition = () => ({
  summary: 'Look up a catalog item by its material.',
  endpoints: [{ method: 'GET', path: '/api/items', note: 'query: material' }],
  auth: 'none', deriver: 'capture-tap',
  body: 'return { lookup: async ({ material }) => { const response = await site.fetch("/api/items?material=" + encodeURIComponent(material)); if (response.status !== 200) throw new Error("Catalog lookup failed"); return response.json; } };',
  operations: [{
    name: 'lookup', description: 'Read one catalog item by material.', readOnly: true,
    inputSchema: { type: 'object', properties: { material: { type: 'string' } }, required: ['material'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, available: { type: 'boolean' },
    }, required: ['id', 'name', 'price', 'available'], additionalProperties: false },
  }],
  validationCases: ['copper', 'silver'].map(material => ({
    operation: 'lookup', input: { material }, expected: API_ITEMS[material],
  })),
});

const report = {
  evidenceClass: EVIDENCE_CLASS,
  modelInference: realDecision
    ? 'real local decision endpoint; orchestrator and copper text helper remain scripted'
    : 'scripted; no model weights loaded',
  ...(decisionOrigin ? { decisionOrigin } : {}),
  browser: 'real unpacked Peerd in Chrome for Testing',
  enforceWebSecurity: true,
  automation: 'DOM-walk through the normal advancedAutomationEnabled=false setting',
  startedAt: new Date().toISOString(),
  ok: false,
  cases: [],
};
let context;
let fixtureServer;
let fixtureProxy;
const fixtureSockets = new Set();
let phase = 'setup';
let active;
const requests = [];

const writeReport = () => {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
};
const deadline = async (promise, milliseconds, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
};
const requireOk = (reply, name) => {
  if (reply?.ok !== true) throw new Error(`${name} failed: ${JSON.stringify(reply)}`);
  return reply;
};
const textMessage = content => ({ role: 'assistant', content });
const toolMessage = (name, args) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id: `smoke_${crypto.randomUUID()}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }],
});
const check = (row, name, pass, detail) => {
  row.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`[local-browser-smoke] ${pass ? 'PASS' : 'FAIL'} ${row.name}: ${name}`);
};

// All fixture values are controlled by this file. The browser's own input,
// submit and link events leave sessionStorage evidence across real navigation.
const fixtureHtml = (url) => {
  // Render the fixture's constant, never reflect the request's query bytes.
  const name = CASES.find((row) => row.name === url.searchParams.get('case'))?.name
    ?? 'search-navigation';
  const query = url.searchParams.get('q') === 'copper' ? 'copper' : '';
  const mutation = url.searchParams.get('mutation') === '1' ? '1' : '0';
  let content;
  if (url.pathname === '/api-catalog') {
    content = '<h1>API catalog</h1><button id="load-preview" type="button">Preview copper item</button><output id="api-preview">Not loaded</output>';
  } else if (url.pathname === '/catalog') {
    content = `<h1>Local catalog</h1>
      <form id="search-form" action="/results" method="get">
        <input type="hidden" name="case" value="${name}">
        <input type="hidden" id="mutation" name="mutation" value="0">
        <label id="query-label" for="query">Search catalog</label>
        <input id="query" name="q" autocomplete="off">
        <button id="find" type="submit">Find items</button>
      </form>`;
  } else if (url.pathname === '/results') {
    content = query
      ? `<h1>Search results for copper</h1><a id="item-link" href="/item/copper-widget?case=${name}&q=copper&mutation=${mutation}">Copper widget</a>`
      : '<h1>No matching items</h1>';
  } else if (url.pathname === '/item/copper-widget' && query) {
    content = `<h1>Copper widget</h1><p id="item-id">CW-42</p>
      <p id="query-evidence">copper</p><p id="mutation-evidence">${mutation}</p>`;
  } else {
    content = '<h1>Unknown fixture path</h1>';
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Peerd local browser fixture</title>
    <body><main>${content}</main><script>
      'use strict';
      document.addEventListener('input', function(event) {
        if (event.target.id === 'query') sessionStorage.setItem('typedQuery', event.target.value);
      });
      document.addEventListener('click', function(event) {
        if (event.target.id === 'find') sessionStorage.setItem('findClicked', 'yes');
        if (event.target.id === 'item-link') sessionStorage.setItem('itemClicked', 'yes');
        if (event.target.id === 'decoy') sessionStorage.setItem('decoyClicked', 'yes');
      });
      document.addEventListener('submit', function() { sessionStorage.setItem('formSubmitted', 'yes'); });
      document.querySelector('#load-preview')?.addEventListener('click', async function() {
        sessionStorage.setItem('apiPreviewClicked', 'yes');
        const response = await fetch('/api/items?material=copper', { cache: 'no-store' });
        document.querySelector('#api-preview').textContent = JSON.stringify(await response.json());
      });
    </script></body></html>`;
};

const startFixture = async () => {
  fixtureServer = createHttpsServer({ cert: GIT_FIXTURE_TLS_CERT, key: GIT_FIXTURE_TLS_KEY }, (request, response) => {
    const url = new URL(request.url ?? '/', `https://${GIT_FIXTURE_HOST}`);
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    requests.push({ method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), at: Date.now() });
    if (url.pathname === '/api/items') {
      const material = url.searchParams.get('material');
      const item = Object.hasOwn(API_ITEMS, material) ? API_ITEMS[material] : undefined;
      response.writeHead(item ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(item ?? { error: 'unknown material' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixtureHtml(url));
  });
  await new Promise((resolveListen, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolveListen);
  });
  // why: an inherited machine proxy may resolve .test names remotely despite
  // Chrome's host mapping. Reuse the acceptance harness's exact local TLS seam;
  // this proxy reaches only this fixture and rejects every other destination.
  fixtureProxy = createServer((_request, response) => {
    response.writeHead(403); response.end('Fixture CONNECT only');
  });
  fixtureProxy.on('connect', (request, client, head) => {
    if (request.url !== `${GIT_FIXTURE_HOST}:443` || request.headers['proxy-authorization']) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const upstream = connect(fixtureServer.address().port, '127.0.0.1');
    for (const socket of [client, upstream]) {
      fixtureSockets.add(socket);
      socket.once('close', () => fixtureSockets.delete(socket));
      socket.setTimeout(20_000, () => socket.destroy());
    }
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise((resolveListen, reject) => {
    fixtureProxy.once('error', reject);
    fixtureProxy.listen(0, '127.0.0.1', resolveListen);
  });
  report.fixtureRouting = 'exact local CONNECT destination with the repository test TLS identity; no upstream Internet';
  return { origin: `https://${GIT_FIXTURE_HOST}`, proxyServer: {
    url: `http://127.0.0.1:${fixtureProxy.address().port}`,
    certificateSpkiSha256: GIT_FIXTURE_SPKI_SHA256_BASE64,
  } };
};

// Verification uses the browser directly, independently of the policy's DONE
// choice or final text. No fixture state is written through this reader.
const readFixture = async (origin, name) => evalIn(context.page, `(async () => {
  const tabs = (await chrome.tabs.query({})).filter(tab => {
    if (!tab.url?.startsWith(${JSON.stringify(origin)} + '/')) return false;
    return new URL(tab.url).searchParams.get('case') === ${JSON.stringify(name)};
  });
  if (tabs.length !== 1) return { tabCount: tabs.length };
  const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: () => {
    'use strict';
    return {
    url: location.href, title: document.querySelector('h1')?.textContent,
    itemId: document.querySelector('#item-id')?.textContent,
    query: document.querySelector('#query-evidence')?.textContent,
    mutation: document.querySelector('#mutation-evidence')?.textContent,
    typedQuery: sessionStorage.getItem('typedQuery'),
    findClicked: sessionStorage.getItem('findClicked'),
    itemClicked: sessionStorage.getItem('itemClicked'),
    formSubmitted: sessionStorage.getItem('formSubmitted'),
    decoyClicked: sessionStorage.getItem('decoyClicked'),
    apiPreviewClicked: sessionStorage.getItem('apiPreviewClicked'),
    apiPreview: document.querySelector('#api-preview')?.textContent,
    };
  } });
  return { tabCount: tabs.length, tabId: tabs[0].id, ...results[0]?.result };
})()`, true);

const mutateDuringDecision = async (origin, name) => evalIn(context.page, `(async () => {
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith(${JSON.stringify(origin)} + '/catalog')
    && new URL(tab.url).searchParams.get('case') === ${JSON.stringify(name)});
  if (tabs.length !== 1) throw new Error('Expected one actor-owned fixture tab to perturb');
  const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: () => {
    'use strict';
    const field = document.querySelector('#query');
    const label = document.querySelector('#query-label');
    if (!field || !label || document.querySelector('#decoy')) throw new Error('Fixture mutation precondition failed');
    const decoy = document.createElement('button');
    decoy.id = 'decoy'; decoy.type = 'button'; decoy.textContent = 'Unrelated help';
    label.before(decoy);
    label.textContent = 'Catalog query';
    document.querySelector('#mutation').value = '1';
    return { mutationApplied: true, priorValue: field.value, newLabel: label.textContent };
  } });
  return results[0]?.result;
})()`, true);

const makePolicy = (row, origin) => createBrowserDecisionResponder({
  emit: (event) => row.events.push(event),
  decide: async (request) => {
    row.decisions += 1;
    if (row.decisions > 14) throw new Error('Smoke decision budget exceeded');
    const state = JSON.parse(request.state);
    const criteria = Object.entries(request.questions.action.criteria);
    if (realDecision) {
      const startedAt = Date.now();
      let inferencePending = true;
      // why: perturb the browser while the real classifier is working, without
      // selecting, rewriting, or retrying its answer to make the fixture pass.
      const inference = realDecision(request, AbortSignal.timeout(30_000))
        .finally(() => { inferencePending = false; });
      void inference.catch(() => {});
      if (row.mutate && !row.mutationApplied) {
        row.mutationEvidence = await mutateDuringDecision(origin, row.name);
        row.mutationEvidence.inferencePending = inferencePending;
        row.mutationApplied = row.mutationEvidence?.mutationApplied === true;
      }
      const response = await inference;
      row.modelDecisions.push({
        durationMs: Date.now() - startedAt, observation: state.observation,
        choice: response?.answers?.action?.choice, candidateCount: criteria.length,
        ...(response?.usage && typeof response.usage === 'object' ? { usage: response.usage } : {}),
      });
      return response;
    }
    let chosen;
    if (state.observation.includes('heading "Copper widget"')) {
      chosen = 'done';
    } else if (state.observation.includes('heading "Search results for copper"')) {
      chosen = criteria.find(([id, label]) => id.startsWith('click_') && label.includes('link "Copper widget"'))?.[0];
    } else if (/textbox "(?:Search catalog|Catalog query)" \[value="copper"(?:\s|\])/.test(state.observation)) {
      chosen = criteria.find(([id, label]) => id.startsWith('click_') && label.includes('button "Find items"'))?.[0];
    } else {
      chosen = criteria.find(([id, label]) => id.startsWith('type_') && /textbox "(?:Search catalog|Catalog query)"/.test(label))?.[0];
      if (chosen && row.mutate && !row.mutationApplied) {
        row.mutationEvidence = await mutateDuringDecision(origin, row.name);
        row.mutationApplied = row.mutationEvidence?.mutationApplied === true;
        if (!row.mutationApplied) throw new Error('The intended inference-time DOM mutation did not happen');
      }
    }
    if (!chosen || !Object.hasOwn(request.questions.action.criteria, chosen)) {
      throw new Error(`Scripted policy has no fixture action for observation: ${state.observation.slice(0, 1600)}`);
    }
    return { answers: { action: { choice: chosen, probabilities: { [chosen]: 1 } } } };
  },
  generateText: async () => { row.textHelperCalls += 1; return 'copper'; },
});

const modelResponder = async (_index, request) => {
  try {
    const body = JSON.parse(request.postData ?? '{}');
    if (phase === 'setup') return { sse: assistantSse(textMessage('LOCAL-SMOKE-READY')) };
    if (!active) throw new Error('Unexpected model request outside a smoke case');
    const actor = body.tools?.some(tool => tool.function?.name === 'snapshot');
    if (actor) {
      active.actorCalls += 1;
      active.lastToolResult = body.messages?.filter(message => message.role === 'tool').at(-1)?.content ?? null;
      if (active.actorCalls > 36) throw new Error('Smoke actor wire budget exceeded');
      if (active.api && active.stage === 'author') {
        const turn = active.authoringResults.length;
        active.authoringResults.push(active.lastToolResult);
        if (turn === 0) return { sse: assistantSse(toolMessage('navigate', { url: active.url })) };
        if (turn === 1) return { sse: assistantSse(toolMessage('site_capture', { action: 'start' })) };
        if (turn === 2) return { sse: assistantSse(toolMessage('click', { selector: '#load-preview' })) };
        if (turn === 3) return { sse: assistantSse(toolMessage('site_capture', { action: 'stop' })) };
        if (turn === 4) return { sse: assistantSse(toolMessage('site_client_write', { origin: active.origin, ...apiClientDefinition() })) };
        if (turn === 5 || turn === 7) return { sse: assistantSse(toolMessage('site_client_read', { origin: active.origin })) };
        if (turn === 6) {
          active.draftContract = parseSiteClientContract(active.lastToolResult, active.origin);
          return { sse: assistantSse(toolMessage('site_client_run', {
            origin: active.origin, mode: 'validate', revision: active.draftContract.revision,
          })) };
        }
        active.validatedContract = parseSiteClientContract(active.lastToolResult, active.origin);
        return { sse: assistantSse(textMessage('API-CLIENT-FIXTURE-AUTHORED')) };
      }
      return { sse: assistantSse(await active.policy(body)) };
    }
    if (!active.delegated) {
      active.delegated = true;
      return { sse: assistantSse(toolMessage('message_actor', {
        to: 'web', message: active.goal ?? `Open ${active.url}. Search the catalog for copper, open the Copper widget details and stop there.`,
      })) };
    }
    if (request.postData.includes('you messaged has replied')) active.actorSettled = true;
    return { sse: assistantSse(textMessage(active.actorSettled ? 'LOCAL-SMOKE-SETTLED' : 'Delegated fixture task.')) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (active) active.modelErrors.push(message);
    console.error(`[local-browser-smoke] responder error: ${message}`);
    // why: the harness deliberately tolerates torn-down requests; a thrown
    // responder would otherwise be swallowed and leave this request paused.
    return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message, type: 'smoke_responder_error' } }) };
  }
};

const prepareMainSession = async () => {
  phase = 'setup';
  await resetSession(context);
  requireOk(await rpc(context.page, { type: 'agent/send', text: 'Prepare the local browser fixture smoke session.' }), 'prepare agent/send');
  const prepared = await waitFor(() => evalIn(context.page,
    `document.body.textContent.includes('LOCAL-SMOKE-READY') && !document.querySelector('form.input-bar button.stop')`),
  { budgetMs: 15_000, pollMs: 100 });
  if (!prepared) throw new Error('Main session preparation did not settle');
  requireOk(await rpc(context.page, { type: 'permission/set', mode: 'act' }), 'permission/set act');
};

// The author, API selector and expectations are fixture code. This case proves
// the real capture/confirmation/worker/promotion/reuse path, not model accuracy.
const runApiCase = async (spec, origin) => {
  const row = {
    ...spec, origin, stage: 'author', evidenceClass: 'scripted-model-real-browser',
    ok: false, checks: [], events: [], decisions: 0, actorCalls: 0,
    textHelperCalls: 0, apiSelectorCalls: 0, delegated: false, actorSettled: false,
    modelErrors: [], authoringResults: [], startedAt: Date.now(),
  };
  report.cases.push(row);
  active = row;
  await prepareMainSession();
  row.url = `${origin}/api-catalog?case=${row.name}`;
  row.goal = `Open ${row.url}. Discover the catalog request, save its read client after review, and validate the declared examples.`;
  phase = 'task';
  console.log(`[local-browser-smoke] Running ${row.name}: capture and validate`);
  requireOk(await rpc(context.page, { type: 'agent/send', text: 'Prepare the reusable API client fixture.' }), 'API authoring send');
  const confirmation = await waitFor(async () => {
    if (row.modelErrors.length) throw new Error(row.modelErrors[0]);
    return evalIn(context.page, `(() => {
      const modal = document.querySelector('.confirm-modal');
      if (modal?.querySelector('h3')?.textContent !== 'Confirm site client') return null;
      return {
        code: modal.querySelector('[aria-label="Proposed site-client code"]')?.textContent,
        contracts: modal.querySelector('[aria-label="Proposed site-client contracts"]')?.textContent,
        text: modal.textContent,
      };
    })()`);
  }, { budgetMs: 30_000, pollMs: 100 });
  if (!confirmation) throw new Error('API client review did not appear');
  check(row, 'real review contains exact client code, contracts and expected examples',
    confirmation.code === apiClientDefinition().body
      && confirmation.contracts?.includes('copper') && confirmation.contracts.includes('silver')
      && confirmation.text.includes(origin));
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(resolve(dirname(REPORT), 'api-client-confirmation.png'), await context.screenshot());
  const approved = await evalIn(context.page, `(() => {
    const button = [...document.querySelectorAll('.confirm-modal button')].find(item => item.textContent.trim() === 'Save client');
    button?.click(); return !!button;
  })()`);
  if (!approved) throw new Error('API fixture review could not be approved');
  const authored = await waitFor(() => {
    if (row.modelErrors.length) throw new Error(row.modelErrors[0]);
    return row.actorSettled && row.validatedContract;
  }, { budgetMs: 30_000, pollMs: 100 });
  if (!authored) throw new Error('API client validation did not finish');
  row.authoringDurationMs = Date.now() - row.startedAt;
  check(row, 'capture saw the real endpoint and preserved numeric response shape',
    row.authoringResults[4]?.includes('/api/items') && row.authoringResults[4].includes('number'));
  check(row, 'explicit validation promoted the exact saved revision',
    row.draftContract.status === 'draft' && row.validatedContract.status === 'validated'
      && row.draftContract.revision === row.validatedContract.revision
      && row.validatedContract.validatedOperations.includes('lookup'));
  const trainingReads = requests.filter(request => request.pathname === '/api/items');
  check(row, 'both declared inputs ran before the held-out repeat task',
    trainingReads.some(request => request.query.material === 'copper')
      && trainingReads.some(request => request.query.material === 'silver')
      && trainingReads.every(request => request.method === 'GET' && request.query.material !== 'gold'));

  await prepareMainSession();
  row.stage = 'reuse'; row.delegated = false; row.actorSettled = false; row.actorCalls = 0;
  row.reuseCase = `${row.name}-repeat`;
  row.url = `${origin}/api-catalog?case=${row.reuseCase}`;
  row.goal = `Open ${row.url}. Read the gold catalog item's id and price using the saved client.`;
  row.policy = createBrowserDecisionResponder({
    emit: event => row.events.push(event),
    decide: async () => { row.decisions += 1; throw new Error('Validated API task should not use DOM decisions'); },
    generateText: async () => { row.textHelperCalls += 1; throw new Error('API reuse should not type into a page'); },
    selectApi: async ({ contract }) => {
      row.apiSelectorCalls += 1;
      if (contract.origin !== origin) throw new Error('API selector received the wrong origin');
      return { operation: 'lookup', input: { material: 'gold' } };
    },
  });
  row.reuseStartedAt = Date.now();
  phase = 'task';
  requireOk(await rpc(context.page, { type: 'agent/send', text: 'Run the held-out repeat API lookup.' }), 'API repeat send');
  const completed = await waitFor(() => {
    if (row.modelErrors.length) throw new Error(row.modelErrors[0]);
    return row.events.some(event => event.type === 'api_result');
  }, { budgetMs: 30_000, pollMs: 100 });
  if (!completed) throw new Error('API bridge did not receive a checked result');
  row.reuseDurationMs = Date.now() - row.reuseStartedAt;
  row.browserEvidence = await readFixture(origin, row.reuseCase);
  row.apiReceipt = row.lastToolResult;
  const repeatReads = requests.filter(request => request.pathname === '/api/items' && request.at >= row.reuseStartedAt);
  check(row, 'real endpoint returned the held-out item through the typed stored operation',
    repeatReads.length === 1 && repeatReads[0].method === 'GET' && repeatReads[0].query.material === 'gold'
      && row.apiReceipt.includes(API_ITEMS.gold.id) && row.apiReceipt.includes(String(API_ITEMS.gold.price)));
  check(row, 'repeat path needed one selector and zero browser decisions or field generations',
    row.apiSelectorCalls === 1 && row.decisions === 0 && row.textHelperCalls === 0,
    { apiSelectorCalls: row.apiSelectorCalls, decisions: row.decisions, textHelperCalls: row.textHelperCalls });
  check(row, 'repeat task left the page controls untouched', row.browserEvidence.tabCount === 1
    && row.browserEvidence.apiPreviewClicked === null && row.browserEvidence.apiPreview === 'Not loaded');
  check(row, 'contract checking was not represented as independent task verification',
    row.events.filter(event => event.type === 'api_result').every(event => event.inputValidated
      && event.outputValidated && event.taskVerified === false));
  check(row, 'model responder had no hidden failures', row.modelErrors.length === 0);
  row.durationMs = Date.now() - row.startedAt;
  row.ok = row.checks.every(item => item.pass);
  delete row.policy; delete row.lastToolResult;
  await waitFor(() => row.actorSettled, { budgetMs: 5_000, pollMs: 100 });
  writeReport();
};

const runCase = async (spec, origin) => {
  if (spec.api) return runApiCase(spec, origin);
  const row = {
    ...spec, evidenceClass: EVIDENCE_CLASS, ok: false, checks: [], events: [],
    decisions: 0, actorCalls: 0, textHelperCalls: 0, delegated: false,
    mutationApplied: false, modelErrors: [], modelDecisions: [], startedAt: Date.now(),
  };
  report.cases.push(row);
  active = row;
  await prepareMainSession();
  row.url = `${origin}/catalog?case=${row.name}`;
  row.policy = makePolicy(row, origin);
  phase = 'task';
  console.log(`[local-browser-smoke] Running ${row.name}`);
  requireOk(await rpc(context.page, { type: 'agent/send', text: `Run the ${row.name} browser fixture task.` }), 'case agent/send');
  const settled = await waitFor(() => {
    if (row.modelErrors.length) throw new Error(row.modelErrors[0]);
    return row.events.some(event => event.type === 'completion_claim');
  }, { budgetMs: realDecision ? 105_000 : 45_000, pollMs: 100 });
  check(row, 'policy reached its terminal protocol state', !!settled);
  if (!settled) throw new Error(`${row.name}: no terminal protocol event within budget`);

  row.browserEvidence = await readFixture(origin, row.name);
  const evidence = row.browserEvidence;
  const expectedUrl = `${origin}/item/copper-widget?case=${row.name}&q=copper&mutation=${row.mutate ? '1' : '0'}`;
  check(row, 'actual final URL and DOM match independent result conditions',
    evidence.tabCount === 1 && evidence.url === expectedUrl && evidence.title === 'Copper widget'
      && evidence.itemId === 'CW-42' && evidence.query === 'copper', evidence);
  check(row, 'real input, form and link events occurred', evidence.typedQuery === 'copper'
    && evidence.findClicked === 'yes' && evidence.formSubmitted === 'yes' && evidence.itemClicked === 'yes');
  check(row, 'ordinary actor delegation and text-helper paths ran', row.delegated && row.actorCalls > 3 && row.textHelperCalls >= 1);
  check(row, 'no unrelated control was activated', evidence.decoyClicked === null);
  const replans = row.events.filter(event => event.type === 'stale_observation_replanned').length;
  if (row.mutate) {
    check(row, 'DOM changed while the old decision was being computed', row.mutationApplied
      && row.mutationEvidence.priorValue === '' && (!realDecision || row.mutationEvidence.inferencePending));
    check(row, 'changed snapshot caused replan before a mutation tool was released', replans >= 1
      && row.events.findIndex(event => event.type === 'stale_observation_replanned')
        < row.events.findIndex(event => event.type === 'action'), { replans });
    check(row, 'mutated page state survived the verified navigation', evidence.mutation === '1');
  }
  check(row, 'policy DONE was not represented as outcome verification', row.events
    .filter(event => event.type === 'completion_claim').every(event => event.verified === false));
  check(row, 'model responder had no hidden failures', row.modelErrors.length === 0);
  row.durationMs = Date.now() - row.startedAt;
  row.ok = row.checks.every(item => item.pass);
  delete row.policy;
  delete row.lastToolResult;
  await context.page.send('Page.bringToFront').catch(() => {});
  await waitFor(() => row.actorSettled, { budgetMs: 5_000, pollMs: 100 });
  writeReport();
};

const runSuite = async () => {
  const { origin, proxyServer } = await startFixture();
  context = await launchPeerd({ modelResponder, tagsModel: BRIDGE_MODEL, enforceWebSecurity: true, proxyServer });
  await unlockAndReady(context.page, { model: BRIDGE_MODEL });
  requireOk(await rpc(context.page, { type: 'settings/update', patch: {
    webActorActionSurface: 'tools', runnerModel: BRIDGE_MODEL, advancedAutomationEnabled: false,
  } }), 'settings/update local browser experiment');
  for (const spec of CASES.filter(row => (!requestedCase || row.name === requestedCase) && (!realDecision || !row.api))) {
    try {
      await deadline(runCase(spec, origin), CASE_BUDGET_MS, spec.name);
    } catch (error) {
      active.error = error instanceof Error ? error.message : String(error);
      active.durationMs = Date.now() - active.startedAt;
      delete active.policy;
      active.browserEvidence = await deadline(readFixture(origin, spec.name), 3_000, 'failed fixture evidence').catch(String);
      active.failureState = await deadline(rpc(context.page, { type: 'state/get' }), 3_000, 'failed case state').catch(String);
      // why: each episode gets one attempt. Stop its real descendant actor
      // before starting the next case, without repairing the failed trajectory.
      requireOk(await rpc(context.page, { type: 'agent/stop' }), 'failed case cleanup');
      console.error(`[local-browser-smoke] ${spec.name}: ${active.error}`);
      writeReport();
    }
  }
  report.fixtureRequests = requests;
  report.ok = report.cases.length > 0 && report.cases.every(row => row.ok);
};

try {
  await deadline(runSuite(), SUITE_BUDGET_MS, 'browser plumbing suite');
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (active) {
    delete active.policy;
    active.durationMs = Date.now() - active.startedAt;
  }
  if (context) report.diagnostics = {
    panel: await deadline(evalIn(context.page, 'document.body.innerText.slice(-6000)'), 3_000, 'failure panel').catch(String),
    browserEvents: [...(context.page.events ?? []), ...(context.swConn?.events ?? [])].slice(-16),
    extensionTargetEvents: context.extensionTargetEvents(),
    tabs: await deadline(evalIn(context.page, 'chrome.tabs.query({}).then(tabs => tabs.map(({id,url,pendingUrl,status}) => ({id,url,pendingUrl,status})))', true), 3_000, 'failure tabs').catch(String),
    state: await deadline(rpc(context.page, { type: 'state/get' }), 3_000, 'failure state').catch(String),
    audit: await deadline(rpc(context.page, { type: 'audit/list', limit: 20 }), 3_000, 'failure audit').catch(String),
  };
  report.fixtureRequests = requests;
  console.error(`[local-browser-smoke] ${report.error}`);
} finally {
  report.finishedAt = new Date().toISOString();
  writeReport();
  if (context) await deadline(context.close(), 7_000, 'Chrome cleanup').catch(() => {});
  fixtureServer?.closeAllConnections();
  fixtureServer?.close();
  for (const socket of fixtureSockets) socket.destroy();
  fixtureProxy?.closeAllConnections();
  fixtureProxy?.close();
}

console.log(JSON.stringify({ evidenceClass: EVIDENCE_CLASS, ok: report.ok, report: REPORT,
  cases: report.cases.map(row => ({ name: row.name, ok: row.ok, checks: row.checks.length })) }));
process.exit(report.ok ? 0 : 1);
