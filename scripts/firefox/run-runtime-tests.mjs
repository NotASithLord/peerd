#!/usr/bin/env bun
// Firefox packaged parity and runtime gate.
//
// This installs the real staged Store XPI as a temporary add-on, boots its
// background page and primary UI pages, and exercises the real Firefox
// scripting fallback. It then runs the shared browser suite from source under
// Gecko. That second signal is web-platform coverage, not packaged-XPI parity.
// Chrome remains the only pixel-baseline authority; Firefox screenshots are
// diagnostic.

import { execFileSync } from 'node:child_process';
import {
  closeSync, constants, cpSync, createReadStream, existsSync, fstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { startGeckodriver, waitFor } from './webdriver.mjs';
import {
  advisesCheckingBeforeRetry,
  hasAmbiguousOutcomeWarning,
  hasOutcomeUnknownState,
} from './outcome-unknown-oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTENSION = join(ROOT, 'extension');
const OUTPUT = join(ROOT, 'artifacts', 'firefox-runtime');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const TEST_UUID = '7d12f198-31fc-4e95-9184-e954123981a6';
const EXTENSION_ORIGIN = `moz-extension://${TEST_UUID}`;
const FIXTURE_PATH = '/__firefox-runtime-fixture';
const WORKER_PROBE_PATH = '/__firefox-worker-startup-probe';
const MODULE_IMPORT_PROBE_PATH = '/__firefox-module-import-probe.js';
const DNR_PUBLIC_HOST = 'guard.peerd.test';
const DNR_FRAME_HOST = 'frame.peerd.test';
const DNR_FIXTURE_PATH = '/__firefox-dnr-fixture';
const DNR_REDIRECT_PATH = '/__firefox-dnr-redirect';
const DNR_META_PATH = '/__firefox-dnr-meta';
const DNR_SCRIPT_PATH = '/__firefox-dnr-script';
const DNR_ACTION_PATH = '/__firefox-dnr-action';
const DNR_ATTEMPT_PATH = '/__firefox-dnr-attempt';
const DNR_CHILD_PATH = '/__firefox-dnr-child';
const RESULT_BUDGET_MS = 180_000;
const PROVIDER_PATH = '/v1/messages';
const PASSPHRASE_CANARY = 'firefox-runtime-passphrase-canary-7d12f198';
const PROVIDER_KEY_CANARY = 'sk-ant-firefox-provider-canary-7d12f198';
const ACTOR_REPLY_CANARY = 'firefox-bound-actor-reply-7d12f198';
const FINAL_REPLY_CANARY = 'firefox-parent-final-reply-7d12f198';
const ACTOR_PROMPT = 'Return the Firefox bound actor proof token.';
const LIFETIME_ACTOR_REPLY_CANARY = 'firefox-lifetime-actor-reply-7d12f198';
const LIFETIME_FINAL_REPLY_CANARY = 'firefox-lifetime-parent-final-7d12f198';
const LIFETIME_ACTOR_PROMPT = 'Return the Firefox background lifetime proof token.';
const LIFETIME_HEARTBEAT_KEY = 'peerdActorHostKeepAlive';
const LIFETIME_RESPONSE_DELAY_MS = 65_000;
const FIREFOX_EVENT_PAGE_IDLE_MS = 30_000;
const FIREFOX_EVENT_PAGE_RESTART_MARGIN_MS = 15_000;
const LIFETIME_QUIET_MS = 12_000;
const LIFETIME_FAILURE_SCREENSHOT = 'lifetime-failure.png';
const LIFETIME_FAILURE_LOG = 'lifetime-geckodriver.log';
const LIFETIME_FAILURE_DIAGNOSTIC = 'lifetime-failure.json';
const KEEPALIVE_LOSS_ACTOR_PROMPT = 'Click the Firefox parity action, then report its status.';
const KEEPALIVE_LOSS_TOOL_ID = 'firefox-keepalive-loss-click';
const KEEPALIVE_LOSS_FINAL_CANARY = 'firefox-keepalive-loss-final-7d12f198';
const KEEPALIVE_LOSS_LATE_CANARY = 'firefox-keepalive-loss-late-response-7d12f198';
const KEEPALIVE_LOSS_RESPONSE_DELAY_MS = 20_000;
const KEEPALIVE_LOSS_SCREENSHOT = 'keepalive-loss.png';
const KEEPALIVE_LOSS_LOG = 'keepalive-loss-geckodriver.log';
const KEEPALIVE_LOSS_DIAGNOSTIC = 'keepalive-loss.json';
const RECOVERY_SEED_KEY = 'peerdFirefoxActorRecoverySeed';
const RECOVERY_BOOT_KEY = 'peerdFirefoxActorRecoveryBoot';
const FAILURE_FINAL_CANARY = 'firefox-actor-not-run-final-7d12f198';
const FAILURE_ACTOR_PROMPT = 'Click the Firefox parity action and report the page status.';
const BROKEN_WORKER_SCREENSHOT = 'broken-worker.png';
const DNR_MAIN_PROMPT = 'Delegate the Firefox private-network DNR proof to the web actor.';
const DNR_ACTOR_PROMPT = 'Open the Firefox DNR public fixture and report when it is ready.';
const DNR_NAV_TOOL_ID = 'firefox-dnr-navigate-tool';
const DNR_ACTOR_REPLY_CANARY = 'firefox-dnr-actor-ready-7d12f198';
const DNR_FINAL_REPLY_CANARY = 'firefox-dnr-parent-ready-7d12f198';
const DNR_BURST_MAIN_PROMPT = 'Delegate the Firefox protected child proof to the web actor.';
const DNR_BURST_ACTOR_PROMPT = 'Open the protected child test page, click its button once, and report the result.';
const DNR_BURST_NAV_TOOL_ID = 'firefox-dnr-child-navigate-tool';
const DNR_BURST_TOOL_ID = 'firefox-dnr-child-burst-tool';
const DNR_BURST_ACTOR_REPLY_CANARY = 'firefox-dnr-child-actor-ready-7d12f198';
const DNR_BURST_FINAL_REPLY_CANARY = 'firefox-dnr-child-parent-ready-7d12f198';

const FIREFOX_RUNTIME_FIXTURE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Firefox runtime fixture</title>
<body>
  <button id="firefox-action" type="button">Firefox parity action</button>
  <label for="firefox-input">Firefox parity input</label>
  <input id="firefox-input">
  <output id="firefox-status" role="status">ready</output>
  <script>
    document.getElementById('firefox-action').addEventListener('click', () => {
      document.body.dataset.clicked = 'yes';
      document.body.dataset.clickCount = String(Number(document.body.dataset.clickCount ?? 0) + 1);
    });
    document.getElementById('firefox-input').addEventListener('input', (event) => {
      document.getElementById('firefox-status').textContent = event.target.value;
    });
  </script>
</body></html>`;

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });

const firefoxBinary = process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  ].find(existsSync)
  || onPath('firefox');
const geckodriverBinary = process.env.GECKODRIVER_PATH || onPath('geckodriver');

const assert = (condition, message, detail = '') => {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  console.log(`  ✓ ${message}`);
};

const overwriteRegularFile = (path, contents) => {
  const descriptor = openSync(path,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`refusing to overwrite non-file: ${path}`);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
};
const delay = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

const startTestServer = async () => {
  let moduleImportProbeRequests = 0;
  const server = createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); response.end('bad request'); return; }
    if (pathname === FIXTURE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FIREFOX_RUNTIME_FIXTURE);
      return;
    }
    if (pathname === MODULE_IMPORT_PROBE_PATH) {
      moduleImportProbeRequests += 1;
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end("export default 'network request escaped the module policy';");
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = join(EXTENSION, pathname);
    if (!file.startsWith(`${EXTENSION}${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('Firefox test server did not receive a port');
  return {
    port,
    get moduleImportProbeRequests() { return moduleImportProbeRequests; },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
};

// One fresh server per DNR vector. A browser request that reaches this process
// is already a policy failure, so count both the raw TCP accept and the parsed
// HTTP request. `connection: close` keeps cleanup deterministic after a failed
// assertion and prevents one vector from borrowing another vector's socket.
const startNetworkProbe = async () => {
  const requests = [];
  const sockets = new Set();
  let connections = 0;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(204, { connection: 'close' });
    response.end();
  });
  server.on('connection', (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('Firefox DNR probe server did not receive a port');
  return {
    port,
    requests,
    get connections() { return connections; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
};

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const requestSystemText = (request) => Array.isArray(request?.system)
  ? request.system.map((block) => String(block?.text ?? '')).join('\n')
  : String(request?.system ?? '');

const textResponse = (text) => [
  sse('message_start', { type: 'message_start' }),
  sse('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' },
  }),
  sse('content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text },
  }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  sse('message_stop', { type: 'message_stop' }),
].join('');

const toolUseResponse = ({ id, name, input }) => [
  sse('message_start', { type: 'message_start' }),
  sse('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
  }),
  sse('content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  sse('message_stop', { type: 'message_stop' }),
].join('');

const delegationResponse = ({
  to = 'web',
  message = ACTOR_PROMPT,
  toolUseId = 'firefox-actor-tool',
} = {}) => toolUseResponse({
  id: toolUseId,
  name: 'message_actor',
  input: { to, message, await: true },
});

const dnrDelegationResponse = () => delegationResponse({
  message: DNR_ACTOR_PROMPT,
  toolUseId: 'firefox-dnr-actor-tool',
});

const dnrBurstDelegationResponse = () => delegationResponse({
  message: DNR_BURST_ACTOR_PROMPT,
  toolUseId: 'firefox-dnr-child-actor-tool',
});

// Evaluate the loss-lane tool response before any browser starts. This keeps a
// malformed helper scope from spending the long lifetime runner before failing.
const KEEPALIVE_LOSS_CLICK_RESPONSE = toolUseResponse({
  id: KEEPALIVE_LOSS_TOOL_ID,
  name: 'click',
  input: { selector: '#firefox-action', expectedCount: 1 },
});

// why a browser-level TLS proxy: the production adapter's endpoint is fixed,
// and safeFetch correctly rejects HTTP redirects. The proxy leaves the URL as
// https://api.anthropic.com/v1/messages, so the real adapter and egress policy
// run unchanged while the local server can inspect the final request header.
// The proxy refuses every other CONNECT target. Its certificate key exists only
// in the OS temp directory for this run and is deleted during cleanup.
const startProviderServer = async () => {
  const records = [];
  const connections = [];
  const tlsErrors = [];
  let workerStartupProbes = 0;
  let lifetimeActorResponses = 0;
  let lifetimeActorResponseAt = 0;
  let lifetimeActorAborts = 0;
  let keepaliveLossActorAborts = 0;
  let scenario = { mode: 'happy', actorTarget: 'web' };
  const httpRequests = [];
  const webSocketUpgrades = [];
  const dnrRedirectAttempts = [];
  const dnrVectors = new Map();
  let nextDnrVectorId = 0;
  let dnrFlow = null;
  let lastDnrFlow = null;
  const certificateDirectory = mkdtempSync(join(tmpdir(), 'peerd-firefox-provider-'));
  const certificatePath = join(certificateDirectory, 'provider-cert.pem');
  const keyPath = join(certificateDirectory, 'provider-key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=api.anthropic.com',
      '-addext', 'subjectAltName=DNS:api.anthropic.com',
      '-keyout', keyPath, '-out', certificatePath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    rmSync(certificateDirectory, { recursive: true, force: true });
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`Firefox runtime tests need OpenSSL with req -addext support: ${detail}`);
  }

  const providerRequestHandler = (request, response) => {
    if (request.method === 'POST' && request.url === WORKER_PROBE_PATH) {
      workerStartupProbes += 1;
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== PROVIDER_PATH) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        response.writeHead(413);
        response.end('request too large');
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const requestScenario = { ...scenario };
      const record = {
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
        scenario: requestScenario.mode,
        receivedAt: Date.now(),
        responseAttemptedAt: null,
        respondedAt: null,
      };
      records.push(record);
      const actorRequest = body.includes('<actor_agent>');
      const priorLifetimeParentRequest = requestScenario.mode === 'lifetime'
        && !actorRequest
        && records.slice(0, -1).some((entry) =>
          entry.scenario === 'lifetime' && !entry.body.includes('<actor_agent>'));
      const failureContinuation = body.includes('Actors were not run')
        || body.includes('actor_isolation_temporarily_unavailable')
        || body.includes('isolated worker host is temporarily unavailable');
      const keepaliveLossActorContinuation = requestScenario.mode === 'keepalive-loss'
        && actorRequest && body.includes(KEEPALIVE_LOSS_TOOL_ID);
      let payload;
      if (dnrFlow) {
        if (dnrFlow.kind === 'burst'
            && dnrFlow.phase === 'parent_delegate'
            && !actorRequest
            && body.includes(DNR_BURST_MAIN_PROMPT)) {
          payload = dnrBurstDelegationResponse();
          dnrFlow.phase = 'actor_click';
        } else if (dnrFlow.kind === 'burst'
            && dnrFlow.phase === 'actor_click'
            && actorRequest
            && body.includes(DNR_BURST_ACTOR_PROMPT)) {
          payload = toolUseResponse({
            id: DNR_BURST_NAV_TOOL_ID,
            name: 'navigate',
            input: { url: dnrFlow.fixtureUrl },
          });
          dnrFlow.phase = 'actor_click_ready';
        } else if (dnrFlow.kind === 'burst'
            && dnrFlow.phase === 'actor_click_ready'
            && actorRequest
            && body.includes(DNR_BURST_NAV_TOOL_ID)) {
          payload = toolUseResponse({
            id: DNR_BURST_TOOL_ID,
            name: 'click',
            input: { selector: '#dnr-child-burst', expectedCount: 1 },
          });
          dnrFlow.phase = 'actor_finish';
        } else if (dnrFlow.kind === 'burst'
            && dnrFlow.phase === 'actor_finish'
            && actorRequest
            && body.includes(DNR_BURST_TOOL_ID)) {
          dnrFlow.actorToolResultBody = body;
          payload = textResponse(DNR_BURST_ACTOR_REPLY_CANARY);
          dnrFlow.phase = 'parent_finish';
        } else if (dnrFlow.kind === 'burst'
            && dnrFlow.phase === 'parent_finish'
            && !actorRequest
            && body.includes(DNR_BURST_ACTOR_REPLY_CANARY)) {
          payload = textResponse(DNR_BURST_FINAL_REPLY_CANARY);
          dnrFlow.phase = 'complete';
          lastDnrFlow = dnrFlow;
          dnrFlow = null;
        } else if (dnrFlow.kind !== 'burst'
            && dnrFlow.phase === 'parent_delegate' && !actorRequest && body.includes(DNR_MAIN_PROMPT)) {
          payload = dnrDelegationResponse();
          dnrFlow.phase = 'actor_navigate';
        } else if (dnrFlow.phase === 'actor_navigate' && actorRequest && body.includes(DNR_ACTOR_PROMPT)) {
          payload = toolUseResponse({
            id: DNR_NAV_TOOL_ID,
            name: 'navigate',
            input: { url: dnrFlow.fixtureUrl },
          });
          dnrFlow.phase = 'actor_finish';
        } else if (dnrFlow.phase === 'actor_finish' && actorRequest && body.includes(DNR_NAV_TOOL_ID)) {
          payload = textResponse(DNR_ACTOR_REPLY_CANARY);
          dnrFlow.phase = 'parent_finish';
        } else if (dnrFlow.phase === 'parent_finish' && !actorRequest && body.includes(DNR_ACTOR_REPLY_CANARY)) {
          payload = textResponse(DNR_FINAL_REPLY_CANARY);
          dnrFlow.phase = 'complete';
          lastDnrFlow = dnrFlow;
          dnrFlow = null;
        } else {
          dnrFlow.errors.push({ phase: dnrFlow.phase, actorRequest, body: body.slice(0, 500) });
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(`unexpected DNR provider phase: ${dnrFlow.phase}`);
          return;
        }
      } else {
        payload = requestScenario.mode === 'lifetime'
          ? actorRequest
            ? textResponse(LIFETIME_ACTOR_REPLY_CANARY)
            : body.includes(LIFETIME_ACTOR_REPLY_CANARY)
              ? textResponse(LIFETIME_FINAL_REPLY_CANARY)
              : priorLifetimeParentRequest
                ? textResponse('Firefox lifetime fixture: actor reply was unavailable.')
                : delegationResponse({
                  message: LIFETIME_ACTOR_PROMPT,
                  toolUseId: 'firefox-lifetime-actor-tool',
                })
          : requestScenario.mode === 'keepalive-loss'
            ? actorRequest
              ? keepaliveLossActorContinuation
                ? textResponse(KEEPALIVE_LOSS_LATE_CANARY)
                : KEEPALIVE_LOSS_CLICK_RESPONSE
              : hasOutcomeUnknownState(body)
                ? textResponse(KEEPALIVE_LOSS_FINAL_CANARY)
                : delegationResponse({
                  to: requestScenario.actorTarget,
                  message: KEEPALIVE_LOSS_ACTOR_PROMPT,
                  toolUseId: 'firefox-keepalive-loss-actor-tool',
                })
            : actorRequest
              ? textResponse(ACTOR_REPLY_CANARY)
              : requestScenario.mode === 'broken-worker'
                ? failureContinuation
                  ? textResponse(FAILURE_FINAL_CANARY)
                  : delegationResponse({
                    to: requestScenario.actorTarget,
                    message: FAILURE_ACTOR_PROMPT,
                    toolUseId: 'firefox-broken-worker-tool',
                  })
                : body.includes(ACTOR_REPLY_CANARY)
                  ? textResponse(FINAL_REPLY_CANARY)
                  : delegationResponse();
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      });
      if ((requestScenario.mode === 'lifetime' && actorRequest) || keepaliveLossActorContinuation) {
        // why: Firefox does not resolve this proxied fetch on flushed headers
        // alone. Send one ignored SSE comment so the connect timeout clears,
        // then leave the stream silent while the lifetime heartbeat is tested.
        response.write(': connected\n\n');
        let abortRecorded = false;
        response.once('close', () => {
          if (!response.writableFinished && !abortRecorded) {
            abortRecorded = true;
            if (keepaliveLossActorContinuation) keepaliveLossActorAborts += 1;
            else lifetimeActorAborts += 1;
          }
        });
        setTimeout(() => {
          if (response.destroyed) {
            if (!abortRecorded) {
              abortRecorded = true;
              if (keepaliveLossActorContinuation) keepaliveLossActorAborts += 1;
              else lifetimeActorAborts += 1;
            }
            return;
          }
          record.responseAttemptedAt = Date.now();
          response.end(payload, () => {
            record.respondedAt = Date.now();
            if (!keepaliveLossActorContinuation) {
              lifetimeActorResponses += 1;
              lifetimeActorResponseAt = Date.now();
            }
          });
        }, keepaliveLossActorContinuation
          ? KEEPALIVE_LOSS_RESPONSE_DELAY_MS
          : Number(requestScenario.lifetimeDelayMs) || LIFETIME_RESPONSE_DELAY_MS);
      } else {
        response.end(payload, () => { record.respondedAt = Date.now(); });
      }
    });
  };

  const tlsServer = createHttpsServer({
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
    ALPNProtocols: ['http/1.1'],
  }, providerRequestHandler);
  tlsServer.on('tlsClientError', (error) => {
    if (tlsErrors.length < 20) tlsErrors.push(error?.code ?? error?.message ?? 'tls-error');
  });
  await new Promise((resolveListen, reject) => {
    tlsServer.once('error', reject);
    tlsServer.listen(0, '127.0.0.1', resolveListen);
  }).catch((error) => {
    rmSync(certificateDirectory, { recursive: true, force: true });
    throw error;
  });
  const tlsAddress = tlsServer.address();
  const tlsPort = typeof tlsAddress === 'object' && tlsAddress ? tlsAddress.port : 0;
  if (!tlsPort) {
    tlsServer.close();
    rmSync(certificateDirectory, { recursive: true, force: true });
    throw new Error('Firefox provider TLS server did not receive a port');
  }

  const sockets = new Set();
  const proxyServer = createServer((request, response) => {
    let target;
    try { target = new URL(request.url, `http://${request.headers.host ?? ''}`); }
    catch {
      response.writeHead(400, { connection: 'close' });
      response.end('bad proxy request');
      return;
    }
    httpRequests.push({ method: request.method, url: target.href, host: target.hostname, path: target.pathname });
    if (![DNR_PUBLIC_HOST, DNR_FRAME_HOST].includes(target.hostname)) {
      response.writeHead(502, { connection: 'close' });
      response.end('unexpected proxy target');
      return;
    }
    if (target.pathname === DNR_FIXTURE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>DNR public fixture</title><body data-dnr-ready="yes">public fixture</body>');
      return;
    }
    if (target.pathname === DNR_CHILD_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>DNR public child</title><body>public child</body>');
      return;
    }
    if (target.pathname === FIXTURE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(FIREFOX_RUNTIME_FIXTURE);
      return;
    }
    if (target.pathname === DNR_ATTEMPT_PATH) {
      request.resume();
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (![DNR_REDIRECT_PATH, DNR_META_PATH, DNR_SCRIPT_PATH, DNR_ACTION_PATH].includes(target.pathname)) {
      response.writeHead(404, { connection: 'close' });
      response.end('not found');
      return;
    }
    const dnrVector = dnrVectors.get(target.searchParams.get('route') ?? '');
    if (!dnrVector) {
      response.writeHead(400, { connection: 'close' });
      response.end('unknown DNR vector');
      return;
    }
    const {
      routeId, action: dnrAction, token: dnrToken, target: privateTarget,
    } = dnrVector;
    const attemptParams = new URLSearchParams({ action: dnrAction, token: dnrToken });
    const attemptLiteral = JSON.stringify(`${DNR_ATTEMPT_PATH}?${attemptParams}`).replaceAll('<', '\\u003c');
    const childAttemptParams = new URLSearchParams({
      action: `${dnrAction}-created`, token: dnrToken,
    });
    const childAttemptLiteral = JSON.stringify(`${DNR_ATTEMPT_PATH}?${childAttemptParams}`)
      .replaceAll('<', '\\u003c');
    const tokenLiteral = JSON.stringify(dnrToken).replaceAll('<', '\\u003c');
    const wrapDnrAction = (source) => `
      document.documentElement.dataset.dnrActionLoaded = ${tokenLiteral};
      try { ${source} } finally {
        document.documentElement.dataset.dnrActionAttempted = ${tokenLiteral};
        void navigator.sendBeacon(${attemptLiteral});
      }
    `;
    if (target.pathname === DNR_REDIRECT_PATH) {
      dnrRedirectAttempts.push({ action: dnrAction, token: dnrToken, target: privateTarget });
      response.writeHead(302, { location: privateTarget, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (target.pathname === DNR_META_PATH) {
      const contentLiteral = JSON.stringify(`0;url=${privateTarget}`).replaceAll('<', '\\u003c');
      const source = `
        const meta = document.createElement('meta');
        meta.httpEquiv = 'refresh';
        meta.content = ${contentLiteral};
        document.head.append(meta);
      `;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>DNR meta probe</title><script>${wrapDnrAction(source)}</script>`);
      return;
    }
    if (target.pathname === DNR_SCRIPT_PATH) {
      const literal = JSON.stringify(privateTarget).replaceAll('<', '\\u003c');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>DNR script probe</title><script>${wrapDnrAction(`location.replace(${literal});`)}</script>`);
      return;
    }
    if (target.pathname === DNR_ACTION_PATH) {
      const literal = JSON.stringify(privateTarget).replaceAll('<', '\\u003c');
      if (dnrAction === 'burst') {
        const socketTarget = new URL(privateTarget);
        socketTarget.protocol = 'ws:';
        socketTarget.searchParams.set('transport', 'websocket');
        const socketLiteral = JSON.stringify(socketTarget.href).replaceAll('<', '\\u003c');
        const publicChildLiteral = JSON.stringify(`http://${DNR_PUBLIC_HOST}${DNR_CHILD_PATH}`);
        const source = `
          document.querySelector('#dnr-child-burst').addEventListener('click', () => {
            const child = window.open(${publicChildLiteral}, 'firefox-guarded-child');
            if (!child) return;
            document.documentElement.dataset.dnrActionAttempted = ${tokenLiteral};
            void navigator.sendBeacon(${attemptLiteral});
            void child.fetch(${literal}, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
            try { void new child.WebSocket(${socketLiteral}); } catch { /* child may close first */ }
          });
        `;
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        response.end(`<!doctype html><meta charset="utf-8"><title>DNR child burst</title>
          <body data-dnr-ready="yes"><button id="dnr-child-burst" type="button">Open child</button>
          <script>${source}</script>`);
        return;
      }
      const frameTarget = new URL(DNR_ACTION_PATH, `http://${DNR_FRAME_HOST}`);
      frameTarget.searchParams.set('route', routeId);
      const frameLiteral = JSON.stringify(frameTarget.href).replaceAll('<', '\\u003c');
      const source = dnrAction === 'fetch'
        ? `void fetch(${literal}, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});`
        : dnrAction === 'websocket'
          ? `void new WebSocket(${literal});`
        : dnrAction === 'beacon'
          ? `void navigator.sendBeacon(${literal}, 'firefox-dnr-beacon');`
        : dnrAction === 'image'
          ? `const image = new Image(); image.src = ${literal}; document.body.append(image);`
          : dnrAction === 'imageset'
            ? `const image = new Image(1, 1); image.srcset = ${literal} + ' 1x'; image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; document.body.append(image);`
          : dnrAction === 'form'
            ? `const frame = document.createElement('iframe'); frame.name = 'dnr-form-sink'; frame.hidden = true; document.body.append(frame); const form = document.createElement('form'); form.method = 'POST'; form.target = frame.name; form.action = ${literal}; document.body.append(form); form.submit();`
            : dnrAction === 'location'
              ? `location.href = ${literal};`
              : dnrAction === 'popup'
                ? `const child = window.open(${literal}, '_blank'); if (child) void navigator.sendBeacon(${childAttemptLiteral});`
                : dnrAction === 'cross-popup'
                  ? target.hostname === DNR_FRAME_HOST
                    ? `const child = window.open(${literal}, '_blank'); if (child) void navigator.sendBeacon(${childAttemptLiteral});`
                    : `const frame = document.createElement('iframe'); frame.hidden = true; frame.src = ${frameLiteral}; document.body.append(frame);`
                : '';
      response.writeHead(source ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      });
      response.end(source
        ? `<!doctype html><meta charset="utf-8"><title>DNR action</title><body><script>${wrapDnrAction(source)}</script>`
        : '<!doctype html><title>Unknown DNR action</title>');
      return;
    }
  });
  proxyServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxyServer.on('connect', (request, socket, head) => {
    if (request.url?.toLowerCase() !== 'api.anthropic.com:443') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    connections.push(request.url);
    const upstream = connectSocket({ host: '127.0.0.1', port: tlsPort }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.once('error', () => socket.destroy());
  });
  proxyServer.on('upgrade', (request, socket) => {
    let target;
    try { target = new URL(request.url, `http://${request.headers.host ?? ''}`); }
    catch {
      socket.destroy();
      return;
    }
    webSocketUpgrades.push({
      method: request.method,
      url: target.href,
      host: target.hostname,
      path: target.pathname,
    });
    socket.destroy();
  });
  proxyServer.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise((resolveListen, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => tlsServer.close(resolveClose));
    rmSync(certificateDirectory, { recursive: true, force: true });
    throw error;
  }
  const proxyAddress = proxyServer.address();
  const port = typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0;
  if (!port) {
    proxyServer.close();
    tlsServer.close();
    rmSync(certificateDirectory, { recursive: true, force: true });
    throw new Error('Firefox provider proxy did not receive a port');
  }
  return {
    port, records, connections, tlsErrors, httpRequests, webSocketUpgrades, dnrRedirectAttempts,
    registerDnrVector: ({ action, token, target }) => {
      const routeId = `dnr-${nextDnrVectorId += 1}`;
      dnrVectors.set(routeId, Object.freeze({ routeId, action, token, target }));
      return routeId;
    },
    get workerStartupProbes() { return workerStartupProbes; },
    get lifetimeActorResponses() { return lifetimeActorResponses; },
    get lifetimeActorResponseAt() { return lifetimeActorResponseAt; },
    get lifetimeActorAborts() { return lifetimeActorAborts; },
    get keepaliveLossActorAborts() { return keepaliveLossActorAborts; },
    setScenario: (next) => { scenario = { ...scenario, ...next }; },
    beginDnrFlow: (fixtureUrl) => {
      if (dnrFlow) throw new Error(`DNR provider flow already active: ${dnrFlow.phase}`);
      lastDnrFlow = null;
      dnrFlow = { kind: 'setup', phase: 'parent_delegate', fixtureUrl, errors: [] };
    },
    beginDnrBurstFlow: (fixtureUrl) => {
      if (dnrFlow) throw new Error(`DNR provider flow already active: ${dnrFlow.phase}`);
      lastDnrFlow = null;
      dnrFlow = { kind: 'burst', phase: 'parent_delegate', fixtureUrl, errors: [], actorToolResultBody: '' };
    },
    get dnrFlow() { return dnrFlow ?? lastDnrFlow; },
    close: async () => {
      dnrVectors.clear();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolveClose) => proxyServer.close(resolveClose)),
        new Promise((resolveClose) => tlsServer.close(resolveClose)),
      ]);
      rmSync(certificateDirectory, { recursive: true, force: true });
    },
  };
};

const runBoundActorSmoke = async (driver, providerServer) => {
  console.log('Firefox bound actor smoke: run the packaged adapter through a local provider double');
  const started = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      (async () => {
        const sent = await browser.runtime.sendMessage({
          type: 'agent/send',
          text: 'Delegate the Firefox actor proof and return its exact result.',
        });
        return { ok: sent?.ok === true, sendError: sent?.error ?? null };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
  `);
  assert(started?.ok === true, 'Firefox starts the installed agent turn', JSON.stringify(started));

  const actorProof = await waitFor(() => driver.executeAsync(`
      const [actorCanary, finalCanary] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const listed = await send({ type: 'session/list' });
        const root = listed?.sessions?.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!root?.sessionId) return null;
        const debug = await send({ type: 'session/debugBundle', sessionId: root.sessionId });
        if (!debug?.ok || !debug.bundle) return null;
        const rootDone = debug.bundle.session?.messages?.some((message) =>
          message.role === 'assistant'
            && typeof message.content === 'string'
            && message.content.includes(finalCanary));
        const child = (debug.bundle.childSessions ?? []).find((session) =>
          session.kind === 'actor' && session.actorType === 'web');
        const actorDone = child?.messages?.some((message) =>
          message.role === 'assistant'
            && typeof message.content === 'string'
            && message.content.includes(actorCanary));
        if (!rootDone || !actorDone) return null;
        const [audit, state] = await Promise.all([
          send({ type: 'audit/list', limit: 500 }),
          send({ type: 'state/get' }),
        ]);
        return {
          ok: audit?.ok === true && state?.ok === true,
          bundle: debug.bundle,
          audit: audit?.entries ?? [],
          state: state?.state ?? null,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
  `, [ACTOR_REPLY_CANARY, FINAL_REPLY_CANARY]), { budgetMs: 60_000, pollMs: 250 });

  const timeoutDiagnostic = actorProof ? null : await driver.executeAsync(`
    const done = arguments[arguments.length - 1];
    const send = (message) => browser.runtime.sendMessage(message);
    (async () => {
      const listed = await send({ type: 'session/list' });
      const root = listed?.sessions?.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
      const debug = root?.sessionId
        ? await send({ type: 'session/debugBundle', sessionId: root.sessionId })
        : null;
      const summarize = (session) => ({
        kind: session?.kind,
        actorType: session?.actorType,
        backing: session?.backing,
        messages: (session?.messages ?? []).map((message) => ({
          role: message.role,
          content: typeof message.content === 'string' ? message.content.slice(0, 300) : '',
          stopReason: message.stopReason,
          toolUses: message.toolUses?.map((tool) => ({ name: tool.name, input: tool.input })),
          toolResults: message.toolResults?.map((result) => ({
            is_error: result.is_error, content: String(result.content ?? '').slice(0, 300),
          })),
        })),
      });
      return {
        listOk: listed?.ok,
        root: summarize(debug?.bundle?.session),
        children: (debug?.bundle?.childSessions ?? []).map(summarize),
        labels: (debug?.bundle?.contextSnapshots ?? []).map((snapshot) => snapshot.label),
      };
    })().then(done, (error) => done({ error: error?.message || String(error) }));
  `);
  const providerDiagnostic = providerServer.records.map((record) => ({
    actor: record.body.includes('<actor_agent>'),
    actorReply: record.body.includes(ACTOR_REPLY_CANARY),
    keyHeaderPresent: record.headers['x-api-key'] === PROVIDER_KEY_CANARY,
  }));
  const transportDiagnostic = {
    connections: providerServer.connections,
    tlsErrors: providerServer.tlsErrors,
  };
  const failureDiagnostic = JSON.stringify({
    timeoutDiagnostic, providerDiagnostic, transportDiagnostic,
  })
    .replaceAll(PROVIDER_KEY_CANARY, '<provider-key-canary-redacted>')
    .replaceAll(PASSPHRASE_CANARY, '<passphrase-canary-redacted>');
  assert(providerServer.connections.length > 0,
    'Firefox routes the provider request through the local TLS proxy', failureDiagnostic);
  assert(actorProof?.ok === true, 'the installed Firefox actor turn completes',
    actorProof
      ? JSON.stringify({ ok: actorProof.ok, error: actorProof.error })
      : failureDiagnostic);
  const child = actorProof.bundle.childSessions.find((session) =>
    session.kind === 'actor' && session.actorType === 'web');
  assert(child?.instanceId === 'web' && child?.backing === undefined,
    'Firefox creates the chat-scoped web actor before it adopts a tab',
    JSON.stringify(child ? {
      kind: child.kind, actorType: child.actorType, instanceId: child.instanceId, backing: child.backing,
    } : null));
  assert(child.messages.some((message) => message.role === 'assistant'
    && typeof message.content === 'string' && message.content.includes(ACTOR_REPLY_CANARY)),
    'the bound actor stores its provider reply');
  assert(actorProof.bundle.session.messages.some((message) => message.role === 'assistant'
    && typeof message.content === 'string' && message.content.includes(FINAL_REPLY_CANARY)),
    'the parent chat receives the actor result and returns a final reply');
  const actorExecution = actorProof.state?.capabilities?.actorExecution;
  assert(actorExecution?.status === 'available'
    && actorExecution?.host === 'background-page-worker'
    && actorExecution?.retryable === false,
  'the installed Firefox package reports the dedicated-worker actor host as available',
  JSON.stringify(actorExecution));
  assert(actorProof.bundle.contextSnapshots.some((snapshot) => snapshot.label === 'actor:web'),
    'the installed Firefox path labels model context as the isolated actor relay');
  const isolatedAudit = actorProof.audit.find((entry) => entry.type === 'actor_ran_isolated');
  assert(isolatedAudit?.details?.host === 'background-page-worker'
    && isolatedAudit?.details?.workerType === 'dedicated'
    && isolatedAudit?.details?.realmVerified === true
    && isolatedAudit?.details?.extensionApisPresent === false
    && isolatedAudit?.details?.kind === 'web'
    && isolatedAudit?.details?.ok === true,
  'the audit proves the Firefox actor ran in a verified extension-API-free dedicated worker',
  JSON.stringify(isolatedAudit?.details));
  assert(!actorProof.audit.some((entry) => entry.type === 'actor_background_turn_refused'),
    'the successful Firefox actor turn has no background-turn refusal');
  assert(!actorProof.audit.some((entry) => entry.type === 'actor_isolation_failure'
    || entry.type === 'actor_isolation_unavailable'),
  'the successful Firefox actor turn has no isolation fallback or failure');
  const storedProof = JSON.stringify({
    bundle: actorProof.bundle, audit: actorProof.audit, state: actorProof.state,
  });
  assert(!storedProof.includes(PROVIDER_KEY_CANARY) && !storedProof.includes(PASSPHRASE_CANARY),
    'installed Firefox session, state, audit, and debug data contain no exact credential canary');

  const providerRequests = providerServer.records.filter((record) => record.method === 'POST');
  const actorRequests = providerRequests.filter((record) => record.body.includes('<actor_agent>'));
  const parsedRequests = providerRequests.map((record) => {
    try { return JSON.parse(record.body); }
    catch { return null; }
  });
  const parentContinuation = parsedRequests.find((request) =>
    request?.messages?.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block?.type === 'tool_result'
        && block.tool_use_id === 'firefox-actor-tool')));
  const actorToolResult = parentContinuation?.messages
    ?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block?.type === 'tool_result'
      && block.tool_use_id === 'firefox-actor-tool');
  const actorToolResultText = typeof actorToolResult?.content === 'string'
    ? actorToolResult.content : '';
  const fenceStart = actorToolResultText.indexOf(
    '<untrusted_web_content origin="web" tool="message_actor"');
  const canaryIndex = actorToolResultText.indexOf(ACTOR_REPLY_CANARY);
  const fenceEnd = actorToolResultText.indexOf('</untrusted_web_content>');
  assert(providerRequests.length >= 3, 'the real adapter reaches the provider for parent and actor turns',
    String(providerRequests.length));
  assert(actorRequests.length >= 1, 'the provider observes an actor-marked model request',
    String(actorRequests.length));
  assert(providerRequests.every((record) => record.headers['x-api-key'] === PROVIDER_KEY_CANARY),
    'the installed provider boundary attaches the model-provider API key to every model request');
  assert(actorToolResult?.tool_use_id === 'firefox-actor-tool'
    && fenceStart >= 0 && canaryIndex > fenceStart && fenceEnd > canaryIndex,
    'the awaited actor reply re-enters as the matching fenced tool result');
  assert(providerRequests.every((record) => !record.body.includes(PROVIDER_KEY_CANARY)),
    'provider request bodies contain no key canary');
};

const createBrokenWorkerArtifact = () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-firefox-broken-worker-'));
  const staging = join(directory, 'staging');
  const artifact = join(directory, `peerd-${VERSION}-store-firefox-broken-worker.xpi`);
  cpSync(join(ROOT, 'artifacts', 'staging', 'store-firefox'), staging, { recursive: true });
  const probe = join(staging, 'background', 'firefox-broken-worker-probe.js');
  writeFileSync(probe, `const bootId = crypto.randomUUID();
browser.runtime.onMessage.addListener((message) =>
  message?.type === 'firefox-broken-worker/boot-id'
    ? Promise.resolve({ ok: true, bootId })
    : undefined);
`, { flag: 'wx', mode: 0o600 });
  const serviceWorker = join(staging, 'background', 'service-worker.js');
  const serviceWorkerSource = readFileSync(serviceWorker, 'utf8');
  overwriteRegularFile(serviceWorker,
    `import './firefox-broken-worker-probe.js';\n${serviceWorkerSource}`);
  const worker = join(staging, 'offscreen', 'actor-worker.js');
  overwriteRegularFile(worker, `await fetch('https://api.anthropic.com${WORKER_PROBE_PATH}', { method: 'POST', cache: 'no-store' });
throw new Error('Firefox runtime test fault: actor worker failed before ready');
`);
  execFileSync('zip', ['-q', '-X', '-r', artifact, '.'], {
    cwd: staging,
    env: { ...process.env, TZ: 'UTC' },
  });
  return { artifact, directory };
};

const createLifetimeArtifact = () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-firefox-lifetime-'));
  const staging = join(directory, 'staging');
  const artifact = join(directory, `peerd-${VERSION}-store-firefox-lifetime.xpi`);
  cpSync(join(ROOT, 'artifacts', 'staging', 'store-firefox'), staging, { recursive: true });
  const probe = join(staging, 'background', 'firefox-lifetime-probe.js');
  writeFileSync(probe, `const bootId = crypto.randomUUID();
const heartbeats = [];
globalThis.peerdFirefoxLifetimeProbe = {
  record(changes) {
    const change = changes?.[${JSON.stringify(LIFETIME_HEARTBEAT_KEY)}];
    if (!change) return;
    heartbeats.push({ at: Date.now(), value: change.newValue ?? null });
  },
};
browser.runtime.onMessage.addListener((message) =>
  message?.type === 'firefox-lifetime/boot-id'
    ? Promise.resolve({ ok: true, bootId, heartbeats: heartbeats.slice() })
    : undefined);
`, { flag: 'wx', mode: 0o600 });
  const serviceWorker = join(staging, 'background', 'service-worker.js');
  const source = readFileSync(serviceWorker, 'utf8');
  const listenerLine = '    actorHostKeepAlive.onChanged(changes);';
  if (source.split(listenerLine).length !== 2) {
    throw new Error('Firefox lifetime probe seam no longer matches service-worker.js');
  }
  overwriteRegularFile(serviceWorker, `import './firefox-lifetime-probe.js';\n${source.replace(
    listenerLine,
    `    globalThis.peerdFirefoxLifetimeProbe?.record(changes);\n${listenerLine}`,
  )}`);
  execFileSync('zip', ['-q', '-X', '-r', artifact, '.'], {
    cwd: staging,
    env: { ...process.env, TZ: 'UTC' },
  });
  return { artifact, directory };
};

const createKeepaliveLossArtifact = () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-firefox-keepalive-loss-'));
  const staging = join(directory, 'staging');
  const artifact = join(directory, `peerd-${VERSION}-store-firefox-keepalive-loss.xpi`);
  cpSync(join(ROOT, 'artifacts', 'staging', 'store-firefox'), staging, { recursive: true });
  const probe = join(staging, 'background', 'firefox-keepalive-loss-probe.js');
  writeFileSync(probe, `let armed = false;
globalThis.peerdFirefoxKeepaliveLossFault = {
  consume() {
    if (!armed) return false;
    armed = false;
    return true;
  },
};
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'firefox-keepalive-loss/arm') return undefined;
  armed = true;
  return Promise.resolve({ ok: true });
});
`, { flag: 'wx', mode: 0o600 });
  const directHost = join(staging, 'background', 'direct-actor-host.js');
  const source = readFileSync(directHost, 'utf8');
  const writeLine = '    const write = storage.set({ [key]: value });';
  if (source.split(writeLine).length !== 2) {
    throw new Error('Firefox keepalive fault seam no longer matches direct-actor-host.js');
  }
  overwriteRegularFile(directHost, source.replace(writeLine, `    const write = globalThis.peerdFirefoxKeepaliveLossFault?.consume()
      ? Promise.reject(new Error('Firefox runtime test fault: keepalive heartbeat failed'))
      : storage.set({ [key]: value });`));
  const serviceWorker = join(staging, 'background', 'service-worker.js');
  const serviceWorkerSource = readFileSync(serviceWorker, 'utf8');
  overwriteRegularFile(serviceWorker, `import './firefox-keepalive-loss-probe.js';\n${serviceWorkerSource}`);
  execFileSync('zip', ['-q', '-X', '-r', artifact, '.'], {
    cwd: staging,
    env: { ...process.env, TZ: 'UTC' },
  });
  return { artifact, directory };
};

const createRecoveryArtifact = () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-firefox-recovery-'));
  const staging = join(directory, 'staging');
  const artifact = join(directory, `peerd-${VERSION}-store-firefox-recovery.xpi`);
  cpSync(join(ROOT, 'artifacts', 'staging', 'store-firefox'), staging, { recursive: true });
  const probe = join(staging, 'background', 'firefox-recovery-probe.js');
  writeFileSync(probe, `const bootId = crypto.randomUUID();
const stored = await browser.storage.local.get([
  ${JSON.stringify(RECOVERY_SEED_KEY)},
  ${JSON.stringify(RECOVERY_BOOT_KEY)},
]);
const previousBoot = stored?.[${JSON.stringify(RECOVERY_BOOT_KEY)}];
const boot = {
  bootId,
  count: Number(previousBoot?.count ?? 0) + 1,
};
await browser.storage.local.set({ ${JSON.stringify(RECOVERY_BOOT_KEY)}: boot });
const seed = stored?.[${JSON.stringify(RECOVERY_SEED_KEY)}];
if (seed?.active === true && Array.isArray(seed.entries)) {
  const mailbox = Object.fromEntries(seed.entries
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]));
  await browser.storage.session.set({ actorMailbox: mailbox });
}
browser.runtime.onMessage.addListener((message) =>
  message?.type === 'firefox-recovery/probe'
    ? Promise.resolve({ ok: true, boot })
    : undefined);
`, { flag: 'wx', mode: 0o600 });
  const serviceWorker = join(staging, 'background', 'service-worker.js');
  const source = readFileSync(serviceWorker, 'utf8');
  overwriteRegularFile(serviceWorker, `import './firefox-recovery-probe.js';\n${source}`);
  execFileSync('zip', ['-q', '-X', '-r', artifact, '.'], {
    cwd: staging,
    env: { ...process.env, TZ: 'UTC' },
  });
  return { artifact, directory };
};

const runActorLifetimeSmoke = async ({ providerServer }) => {
  console.log('Firefox actor lifetime smoke: keep a long Worker turn alive with every UI port closed');
  const { artifact, directory } = createLifetimeArtifact();
  const recordStart = providerServer.records.length;
  const responseStart = providerServer.lifetimeActorResponses;
  const abortStart = providerServer.lifetimeActorAborts;
  let driver = null;
  try {
    driver = await startGeckodriver({
      binary: geckodriverBinary,
      firefoxBinary,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
      },
    });
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID, 'the lifetime diagnostic XPI keeps the Store add-on id', String(installedId));
    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const prepared = await driver.executeAsync(`
      const [passphrase, providerKey] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const vault = await send({ type: 'vault/initialize', passphrase });
        const provider = await send({ type: 'provider/setKey', provider: 'anthropic', plaintext: providerKey });
        const boot = await send({ type: 'firefox-lifetime/boot-id' });
        return {
          ok: vault?.ok === true && provider?.ok === true && typeof boot?.bootId === 'string',
          bootId: boot?.bootId ?? null,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [PASSPHRASE_CANARY, PROVIDER_KEY_CANARY]);
    assert(prepared?.ok === true,
      'the lifetime profile initializes without a test-owned keepalive listener', JSON.stringify(prepared));

    const lifetimeDelayMs = LIFETIME_RESPONSE_DELAY_MS;
    providerServer.setScenario({ mode: 'lifetime', actorTarget: 'web', lifetimeDelayMs });
    const started = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({
        type: 'agent/send',
        text: 'Delegate the Firefox background lifetime proof and return its exact result.',
      }).then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(started?.ok === true, 'the long Firefox actor turn starts', JSON.stringify(started));

    const actorRequestStarted = await waitFor(() => providerServer.records
      .slice(recordStart)
      .some((record) => record.scenario === 'lifetime' && record.body.includes('<actor_agent>')),
    { budgetMs: 30_000, pollMs: 100 });
    assert(actorRequestStarted === true, 'the isolated actor reaches the delayed provider response');

    const extensionHandle = await driver.windowHandle();
    const plainContext = await driver.newWindow('tab');
    assert(typeof plainContext?.handle === 'string',
      'the lifetime test opens a plain browser context before closing the extension UI',
      JSON.stringify(plainContext));
    await driver.switchToWindow(plainContext.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(plainContext.handle);
    const openHandles = await driver.windowHandles();
    assert(Array.isArray(openHandles) && !openHandles.includes(extensionHandle),
      'the extension UI context is physically closed for the lifetime proof',
      JSON.stringify(openHandles));
    const actorResponseFinished = await waitFor(() => {
      if (providerServer.lifetimeActorResponses > responseStart) return 'completed';
      const parentRequests = providerServer.records.slice(recordStart)
        .filter((record) => record.scenario === 'lifetime'
          && !record.body.includes('<actor_agent>'));
      return parentRequests.length > 1 ? 'actor-ended-without-reply' : null;
    },
      { budgetMs: lifetimeDelayMs + 30_000, pollMs: 250 });
    assert(actorResponseFinished === 'completed',
      'the actor Worker survives while every extension UI port is closed',
      String(actorResponseFinished));

    const parentContinuationFinished = await waitFor(() => providerServer.records
      .slice(recordStart)
      .some((record) => record.scenario === 'lifetime'
        && !record.body.includes('<actor_agent>')
        && record.body.includes(LIFETIME_ACTOR_REPLY_CANARY)
        && typeof record.respondedAt === 'number'),
    { budgetMs: 30_000, pollMs: 100 });
    assert(parentContinuationFinished === true,
      'the parent continuation finishes while every extension UI port remains closed');

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const proof = await waitFor(() => driver.executeAsync(`
      const [finalCanary, actorCanary, actorPrompt, heartbeatKey] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const [listed, heartbeat, audit, boot] = await Promise.all([
          send({ type: 'session/list' }),
          browser.storage.session.get(heartbeatKey),
          send({ type: 'audit/list', limit: 500 }),
          send({ type: 'firefox-lifetime/boot-id' }),
        ]);
        let parentBundle = null;
        let actorSessionId = null;
        for (const session of listed?.sessions ?? []) {
          if (!session?.sessionId || session.kind === 'actor') continue;
          const debug = await send({ type: 'session/debugBundle', sessionId: session.sessionId });
          const complete = debug?.bundle?.session?.messages?.some((message) =>
            message.role === 'assistant'
              && typeof message.content === 'string'
              && message.content.includes(finalCanary));
          if (!complete) continue;
          const actor = (debug?.bundle?.childSessions ?? []).find((child) =>
            child.kind === 'actor'
              && child.messages?.some((message) =>
              message.role === 'user'
                && typeof message.content === 'string'
                && message.content.includes(actorPrompt))
              && child.messages?.some((message) =>
                message.role === 'assistant'
                  && typeof message.content === 'string'
                  && message.content.includes(actorCanary)));
          if (!actor?.sessionId) continue;
          parentBundle = debug.bundle;
          actorSessionId = actor.sessionId;
          break;
        }
        return parentBundle && actorSessionId ? {
          heartbeats: boot?.heartbeats ?? [],
          heartbeat: heartbeat?.[heartbeatKey] ?? null,
          bundle: parentBundle,
          actorSessionId,
          bootId: boot?.bootId ?? null,
          audit: audit?.entries ?? [],
        } : null;
      })().then(done, (error) => done({ error: error?.message || String(error) }));
    `, [
      LIFETIME_FINAL_REPLY_CANARY,
      LIFETIME_ACTOR_REPLY_CANARY,
      LIFETIME_ACTOR_PROMPT,
      LIFETIME_HEARTBEAT_KEY,
    ]), {
      budgetMs: 60_000,
      pollMs: 250,
    });
    assert(proof?.bundle && Array.isArray(proof?.heartbeats),
      'the session heartbeat runs and the parent turn completes with no UI open',
      JSON.stringify(proof));
    assert(proof.bootId === prepared.bootId,
      'the same Firefox background heap owns actor start, product heartbeats, and completion',
      JSON.stringify({ prepared: prepared.bootId, completed: proof.bootId }));
    const isolatedRuns = proof.audit.filter((entry) => entry.type === 'actor_ran_isolated'
      && entry.details?.host === 'background-page-worker'
      && entry.details?.actorSessionId === proof.actorSessionId);
    assert(isolatedRuns.length === 1
      && isolatedRuns[0]?.details?.ok === true
      && isolatedRuns[0]?.details?.realmVerified === true,
      'the heartbeat-retained lifetime turn keeps the verified background-page Worker boundary',
      JSON.stringify(isolatedRuns.map((entry) => entry.details)));
    const lifetimeParentContinuations = providerServer.records.slice(recordStart)
      .filter((record) => record.scenario === 'lifetime'
        && !record.body.includes('<actor_agent>')
        && record.body.includes(LIFETIME_ACTOR_REPLY_CANARY));
    assert(lifetimeParentContinuations.length === 1
      && typeof lifetimeParentContinuations[0].respondedAt === 'number',
    'the parent continuation completes exactly once without a UI-triggered replay',
    JSON.stringify(lifetimeParentContinuations.map((record) => ({
      receivedAt: record.receivedAt,
      respondedAt: record.respondedAt,
    }))));
    const lifetimeActorRequests = providerServer.records.slice(recordStart)
      .filter((record) => record.scenario === 'lifetime'
        && record.body.includes('<actor_agent>')
        && record.body.includes(LIFETIME_ACTOR_PROMPT));
    const pulseTimes = proof.heartbeats
      .filter((entry) => entry?.value?.leaseId && Number.isInteger(entry?.value?.sequence))
      .map((entry) => entry.at);
    const heartbeatAfterIdle = pulseTimes.some((at) =>
      at >= lifetimeActorRequests[0]?.receivedAt + FIREFOX_EVENT_PAGE_IDLE_MS
        && at <= providerServer.lifetimeActorResponseAt);
    const heartbeatOverlapsRequest = pulseTimes.some((at) =>
      at >= lifetimeActorRequests[0]?.receivedAt
        && at <= providerServer.lifetimeActorResponseAt);
    assert(lifetimeActorRequests.length === 1
      && pulseTimes.length >= 2
      && pulseTimes.at(-1) > pulseTimes[0]
      && heartbeatAfterIdle === true
      && heartbeatOverlapsRequest === true,
    'the product Firefox session heartbeat runs after the idle window during the delayed actor request',
    JSON.stringify({
      requestAt: lifetimeActorRequests[0]?.receivedAt,
      idleThresholdAt: lifetimeActorRequests[0]?.receivedAt + FIREFOX_EVENT_PAGE_IDLE_MS,
      heartbeats: proof.heartbeats,
      actorResponseAt: providerServer.lifetimeActorResponseAt,
    }));
    assert(lifetimeActorRequests.length === 1
      && providerServer.lifetimeActorResponses - responseStart === 1
      && providerServer.lifetimeActorAborts - abortStart === 0,
    'the original actor request completes exactly once without an aborted replay',
    JSON.stringify({
      requests: lifetimeActorRequests.length,
      responses: providerServer.lifetimeActorResponses - responseStart,
      aborts: providerServer.lifetimeActorAborts - abortStart,
    }));
    // Let the final session-key removal settle before sampling. The actor run
    // is complete now, so the product lease must be gone and no later heartbeat
    // may advance the in-memory diagnostic count.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const quietBefore = await driver.executeAsync(`
      const [heartbeatKey] = arguments;
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.storage.session.get(heartbeatKey),
        browser.runtime.sendMessage({ type: 'firefox-lifetime/boot-id' }),
      ]).then(([heartbeat, boot]) => done({
        heartbeat: heartbeat?.[heartbeatKey] ?? null,
        count: boot?.heartbeats?.length ?? 0,
      }), (error) => done({ error: error?.message || String(error) }));
    `, [LIFETIME_HEARTBEAT_KEY]);
    await new Promise((resolveWait) => setTimeout(resolveWait, LIFETIME_QUIET_MS));
    const quietAfter = await driver.executeAsync(`
      const [heartbeatKey] = arguments;
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.storage.session.get(heartbeatKey),
        browser.runtime.sendMessage({ type: 'firefox-lifetime/boot-id' }),
      ]).then(([heartbeat, boot]) => done({
        heartbeat: heartbeat?.[heartbeatKey] ?? null,
        count: boot?.heartbeats?.length ?? 0,
      }), (error) => done({ error: error?.message || String(error) }));
    `, [LIFETIME_HEARTBEAT_KEY]);
    assert(quietBefore?.heartbeat === null && quietAfter?.heartbeat === null,
      'the product Firefox session heartbeat is gone after the last actor run',
      JSON.stringify({ before: quietBefore, after: quietAfter }));
    assert(Number(quietBefore?.count) === Number(quietAfter?.count),
    'the keepalive marker stays unchanged beyond another heartbeat interval',
    JSON.stringify({ quietMs: LIFETIME_QUIET_MS, before: quietBefore, after: quietAfter }));
    const stored = JSON.stringify({ heartbeats: proof.heartbeats, bundle: proof.bundle, audit: proof.audit });
    assert(!stored.includes(PROVIDER_KEY_CANARY) && !stored.includes(PASSPHRASE_CANARY),
      'the lifetime proof stores no credential canaries');
  } catch (error) {
    try {
      if (driver) {
        const screenshot = await driver.screenshot();
        writeFileSync(join(OUTPUT, LIFETIME_FAILURE_SCREENSHOT), Buffer.from(screenshot, 'base64'));
      }
    } catch { /* the browser may already be gone */ }
    const geckoLog = driver?.logs.join('') ?? '';
    if (geckoLog) writeFileSync(join(OUTPUT, LIFETIME_FAILURE_LOG), geckoLog);
    writeFileSync(join(OUTPUT, LIFETIME_FAILURE_DIAGNOSTIC), JSON.stringify({
      error: error?.message ?? String(error),
      records: providerServer.records.slice(recordStart).map((record) => ({
        scenario: record.scenario,
        actor: record.body.includes('<actor_agent>'),
        receivedAt: record.receivedAt,
        respondedAt: record.respondedAt,
      })),
      actorResponses: providerServer.lifetimeActorResponses - responseStart,
      actorAborts: providerServer.lifetimeActorAborts - abortStart,
    }, null, 2));
    throw error;
  } finally {
    await driver?.close();
    providerServer.setScenario({ mode: 'happy', actorTarget: 'web', lifetimeDelayMs: 0 });
    rmSync(directory, { recursive: true, force: true });
  }
};

const runActorKeepaliveLossSmoke = async ({ providerServer }) => {
  console.log('Firefox actor keepalive-loss smoke: fail a product heartbeat after a real side effect');
  const { artifact, directory } = createKeepaliveLossArtifact();
  const recordStart = providerServer.records.length;
  const abortStart = providerServer.keepaliveLossActorAborts;
  let driver = null;
  let fixtureTabId = null;
  try {
    driver = await startGeckodriver({
      binary: geckodriverBinary,
      firefoxBinary,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        httpProxy: `127.0.0.1:${providerServer.port}`,
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
      },
    });
    await driver.setWindowRect({ width: 400, height: 900, x: 0, y: 0 });
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID,
      'the keepalive-loss diagnostic XPI keeps the Store add-on id', String(installedId));
    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const prepared = await driver.executeAsync(`
      const [passphrase, providerKey, fixtureUrl] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const vault = await send({ type: 'vault/initialize', passphrase });
        const provider = await send({ type: 'provider/setKey', provider: 'anthropic', plaintext: providerKey });
        const tab = await browser.tabs.create({ url: fixtureUrl, active: true });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const [probe] = await browser.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => document.readyState === 'complete'
                && document.getElementById('firefox-action') !== null,
            });
            if (probe?.result === true) {
              return { ok: vault?.ok === true && provider?.ok === true, tabId: tab.id };
            }
          } catch { /* navigation is still in flight */ }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        return { ok: false, tabId: tab.id, error: 'fixture tab did not become scriptable' };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [
      PASSPHRASE_CANARY,
      PROVIDER_KEY_CANARY,
      `http://${DNR_PUBLIC_HOST}${FIXTURE_PATH}`,
    ]);
    fixtureTabId = prepared?.tabId ?? null;
    assert(prepared?.ok === true && Number.isInteger(fixtureTabId),
      'the keepalive-loss profile initializes a concrete actor target', JSON.stringify(prepared));

    providerServer.setScenario({ mode: 'keepalive-loss', actorTarget: String(fixtureTabId) });
    const started = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({
        type: 'agent/send',
        text: 'Delegate the Firefox keepalive-loss proof and report its exact outcome.',
      }).then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(started?.ok === true, 'the keepalive-loss actor turn starts', JSON.stringify(started));

    const sideEffectAndContinuation = await waitFor(async () => {
      const actorContinuation = providerServer.records.slice(recordStart).find((record) =>
        record.scenario === 'keepalive-loss'
          && record.body.includes('<actor_agent>')
          && record.body.includes(KEEPALIVE_LOSS_TOOL_ID)
          && record.respondedAt === null);
      const observed = await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.scripting.executeScript({
          target: { tabId },
          func: () => ({
            clicked: document.body.dataset.clicked ?? null,
            clickCount: document.body.dataset.clickCount ?? '0',
          }),
        }).then(([entry]) => done(entry?.result ?? null), () => done(null));
      `, [fixtureTabId]);
      return actorContinuation && observed?.clicked === 'yes'
        ? {
          actorRequestAt: actorContinuation.receivedAt,
          clicked: observed.clicked,
          clickCount: observed.clickCount,
        }
        : null;
    }, { budgetMs: 30_000, pollMs: 100 });
    assert(sideEffectAndContinuation?.clicked === 'yes'
      && Number.parseInt(sideEffectAndContinuation?.clickCount ?? '0', 10) > 0,
      'the actor side effect commits before the keepalive fault is armed',
      JSON.stringify(sideEffectAndContinuation));

    const faultArmed = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'firefox-keepalive-loss/arm' })
        .then((result) => done(result?.ok === true),
          (error) => done({ error: error?.message || String(error) }));
    `);
    assert(faultArmed === true, 'the packaged lane arms only the next product heartbeat');

    const extensionHandle = await driver.windowHandle();
    const plainContext = await driver.newWindow('tab');
    assert(typeof plainContext?.handle === 'string',
      'the keepalive-loss test opens a plain context before closing the extension UI',
      JSON.stringify(plainContext));
    await driver.switchToWindow(plainContext.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(plainContext.handle);
    const extensionUiClosedAt = Date.now();
    const openHandles = await driver.windowHandles();
    assert(Array.isArray(openHandles) && !openHandles.includes(extensionHandle),
      'the heartbeat fails with the extension UI physically closed',
      JSON.stringify(openHandles));

    const lossSettledWhileClosed = await waitFor(() => {
      const records = providerServer.records.slice(recordStart)
        .filter((record) => record.scenario === 'keepalive-loss');
      const interrupted = records.find((record) =>
        record.body.includes('<actor_agent>')
          && record.receivedAt === sideEffectAndContinuation.actorRequestAt);
      const outcomeUnknown = records.find((record) =>
        !record.body.includes('<actor_agent>')
          && hasOutcomeUnknownState(record.body));
      return interrupted && outcomeUnknown ? {
        actorContinuationReceivedAt: interrupted.receivedAt,
        actorContinuationRespondedAt: interrupted.respondedAt,
        unknownContinuationReceivedAt: outcomeUnknown.receivedAt,
      } : null;
    }, { budgetMs: 15_000, pollMs: 100 });
    assert(lossSettledWhileClosed?.actorContinuationRespondedAt === null
      && lossSettledWhileClosed?.unknownContinuationReceivedAt >= extensionUiClosedAt,
      'the failed heartbeat settles Outcome unknown before the delayed provider response with every UI closed',
      JSON.stringify({ extensionUiClosedAt, ...lossSettledWhileClosed }));

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);

    const proof = await waitFor(() => driver.executeAsync(`
      const [finalCanary, rootToolUseId, heartbeatKey] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const [listed, audit, heartbeat, mailbox, state] = await Promise.all([
          send({ type: 'session/list' }),
          send({ type: 'audit/list', limit: 500 }),
          browser.storage.session.get(heartbeatKey),
          browser.storage.session.get('actorMailbox'),
          send({ type: 'state/get' }),
        ]);
        let bundle = null;
        for (const session of listed?.sessions ?? []) {
          if (!session?.sessionId || session.kind === 'actor') continue;
          const debug = await send({ type: 'session/debugBundle', sessionId: session.sessionId });
          const doneMessage = debug?.bundle?.session?.messages?.some((message) =>
            message.role === 'assistant'
              && typeof message.content === 'string'
              && message.content.includes(finalCanary));
          if (doneMessage) { bundle = debug.bundle; break; }
        }
        if (!bundle) return null;
        const toolResult = bundle.session.messages
          .flatMap((message) => message.toolResults ?? [])
          .find((result) => result.tool_use_id === rootToolUseId);
        return {
          bundle,
          toolResult: toolResult ?? null,
          audit: audit?.entries ?? [],
          heartbeat: heartbeat?.[heartbeatKey] ?? null,
          mailboxKeys: Object.keys(mailbox?.actorMailbox ?? {}),
          actorExecution: state?.state?.capabilities?.actorExecution ?? null,
        };
      })().then(done, (error) => done({ error: error?.message || String(error) }));
    `, [KEEPALIVE_LOSS_FINAL_CANARY, 'firefox-keepalive-loss-actor-tool', LIFETIME_HEARTBEAT_KEY]), {
      budgetMs: 60_000,
      pollMs: 250,
    });
    assert(proof?.bundle && proof?.toolResult,
      'the post-start keepalive loss reaches one visible parent terminal state', JSON.stringify(proof));
    const resultText = String(proof.toolResult?.content ?? '');
    assert(proof.toolResult?.is_error === true
      && hasOutcomeUnknownState(resultText),
    'the awaited actor result is Outcome unknown rather than Not run', resultText);
    const failedRun = proof.audit.find((entry) => entry.type === 'actor_ran_isolated'
      && entry.details?.host === 'background-page-worker'
      && entry.details?.ok === false);
    assert(failedRun?.details?.performed === true
      && failedRun?.details?.outcomeKnown === false,
    'the audit records a post-start ambiguous outcome', JSON.stringify(failedRun));
    assert(proof.heartbeat === null && proof.mailboxKeys.length === 0,
      'the failed lease and committed actor receipt leave no heartbeat or mailbox row',
      JSON.stringify({ heartbeat: proof.heartbeat, mailboxKeys: proof.mailboxKeys }));
    assert(proof.actorExecution?.status === 'temporarily_unavailable'
      && proof.actorExecution?.retryable === true,
    'the failed heartbeat pauses actor execution until an explicit retry',
    JSON.stringify(proof.actorExecution));

    const preGuardRequests = providerServer.records.slice(recordStart)
      .filter((record) => record.scenario === 'keepalive-loss');
    const preGuardActorRequests = preGuardRequests
      .filter((record) => record.body.includes('<actor_agent>'));
    const preGuardRootRequests = preGuardRequests.filter((record) =>
      !record.body.includes('<actor_agent>')
        && !hasOutcomeUnknownState(record.body));
    const preGuardUnknownContinuations = preGuardRequests.filter((record) =>
      !record.body.includes('<actor_agent>')
        && hasOutcomeUnknownState(record.body));
    const interruptedActorContinuation = preGuardActorRequests.find((record) =>
      record.body.includes(KEEPALIVE_LOSS_TOOL_ID)
        && record.receivedAt === sideEffectAndContinuation.actorRequestAt);
    assert(preGuardRootRequests.length === 1
      && preGuardActorRequests.length === 2
      && preGuardUnknownContinuations.length === 1,
    'the ambiguous turn makes exactly one root request, two actor requests, and one terminal continuation',
    JSON.stringify({
      rootRequests: preGuardRootRequests.length,
      actorRequests: preGuardActorRequests.length,
      unknownContinuations: preGuardUnknownContinuations.length,
    }));
    assert(interruptedActorContinuation
      && preGuardUnknownContinuations[0].receivedAt < (interruptedActorContinuation.respondedAt ?? Infinity),
    'the failed heartbeat settles Outcome unknown before any delayed upstream continuation can return',
    JSON.stringify({
      actorContinuationReceivedAt: interruptedActorContinuation?.receivedAt,
      actorContinuationRespondedAt: interruptedActorContinuation?.respondedAt,
      unknownContinuationReceivedAt: preGuardUnknownContinuations[0]?.receivedAt,
    }));

    const guardStart = providerServer.records.length;
    const guardTurn = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({
        type: 'agent/send',
        text: 'Report whether actor work is available. Do not retry the previous action.',
      }).then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(guardTurn?.ok === true, 'the model-facing paused-capability proof starts', JSON.stringify(guardTurn));
    const guardedRequest = await waitFor(() => providerServer.records.slice(guardStart)
      .find((record) => record.scenario === 'keepalive-loss'
        && !record.body.includes('<actor_agent>')
        && typeof record.respondedAt === 'number'),
    { budgetMs: 30_000, pollMs: 100 });
    let guardedPayload = null;
    try { guardedPayload = JSON.parse(guardedRequest?.body ?? ''); }
    catch { /* assertion below reports the malformed body */ }
    const guardedTools = (guardedPayload?.tools ?? []).map((tool) => tool?.name);
    const guardedSystem = requestSystemText(guardedPayload);
    assert(guardedSystem.includes('status="temporarily_unavailable"')
      && !guardedTools.some((name) =>
        ['message_actor', 'actor_create', 'request_review'].includes(name)),
    'the next model turn names the pause and removes actor execution tools',
    JSON.stringify({ guardedSystem, guardedTools }));

    const requestCount = providerServer.records.slice(recordStart)
      .filter((record) => record.scenario === 'keepalive-loss').length;
    assert(requestCount === preGuardRequests.length + 1,
      'the guarded follow-up adds exactly one deliberate parent request',
      JSON.stringify({ beforeGuard: preGuardRequests.length, afterGuard: requestCount }));
    const lateResponseEvent = await waitFor(() => {
      const interrupted = providerServer.records.slice(recordStart).find((record) =>
        record.scenario === 'keepalive-loss'
          && record.body.includes('<actor_agent>')
          && record.receivedAt === sideEffectAndContinuation.actorRequestAt);
      const actorAborts = providerServer.keepaliveLossActorAborts - abortStart;
      if (actorAborts === 1) {
        return { actorAborts, responseAttemptedAt: interrupted?.responseAttemptedAt ?? null };
      }
      if (actorAborts === 0 && typeof interrupted?.responseAttemptedAt === 'number') {
        return { actorAborts, responseAttemptedAt: interrupted.responseAttemptedAt };
      }
      return null;
    }, { budgetMs: KEEPALIVE_LOSS_RESPONSE_DELAY_MS + 5_000, pollMs: 100 });
    assert(lateResponseEvent,
      'the interrupted provider stream is either closed or attempts its delayed response',
      JSON.stringify(lateResponseEvent));
    await new Promise((resolveWait) => setTimeout(resolveWait, LIFETIME_QUIET_MS));
    const settledRequests = providerServer.records.slice(recordStart)
      .filter((record) => record.scenario === 'keepalive-loss');
    const settledActorRequests = settledRequests
      .filter((record) => record.body.includes('<actor_agent>'));
    const actorAborts = providerServer.keepaliveLossActorAborts - abortStart;
    const settledInterruptedContinuation = settledActorRequests.find((record) =>
      record.body.includes(KEEPALIVE_LOSS_TOOL_ID)
        && record.receivedAt === sideEffectAndContinuation.actorRequestAt);
    // why: AbortSignal revocation is the product boundary. Firefox may either
    // close the proxied HTTP stream or drain it without delivering its result;
    // both are safe when the retired relay cannot dispatch or replay anything.
    assert(settledActorRequests.length === 2
      && settledRequests.length === requestCount,
    'the post-start loss produces no actor or parent replay beyond a full heartbeat interval', JSON.stringify({
      quietMs: LIFETIME_QUIET_MS,
      actorRequests: settledActorRequests.length,
      actorAborts,
      actorContinuationResponseAttemptedAt: settledInterruptedContinuation?.responseAttemptedAt,
      actorContinuationRespondedAt: settledInterruptedContinuation?.respondedAt,
      requestsBeforeQuiet: requestCount,
      requestsAfterQuiet: settledRequests.length,
    }));
    const lateResponseProof = await driver.executeAsync(`
      const [sessionId, tabId, lateCanary] = arguments;
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.runtime.sendMessage({ type: 'session/debugBundle', sessionId }),
        browser.runtime.sendMessage({ type: 'state/get' }),
        browser.scripting.executeScript({
          target: { tabId },
          func: () => ({
            clicked: document.body.dataset.clicked ?? null,
            clickCount: document.body.dataset.clickCount ?? '0',
          }),
        }),
      ]).then(([debug, state, [page]]) => done({
        bundleOk: debug?.ok === true && !!debug?.bundle,
        lateCanaryPresent: JSON.stringify(debug?.bundle ?? {}).includes(lateCanary),
        actorExecution: state?.state?.capabilities?.actorExecution ?? null,
        page: page?.result ?? null,
      }), (error) => done({ error: error?.message || String(error) }));
    `, [proof.bundle.session.sessionId, fixtureTabId, KEEPALIVE_LOSS_LATE_CANARY]);
    assert(lateResponseProof?.bundleOk === true
      && lateResponseProof?.lateCanaryPresent === false
      && lateResponseProof?.actorExecution?.status === 'temporarily_unavailable'
      && lateResponseProof?.page?.clicked === 'yes'
      && lateResponseProof?.page?.clickCount === sideEffectAndContinuation.clickCount,
    'late provider bytes have no authority to change the terminal result or repeat the side effect',
    JSON.stringify(lateResponseProof));

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const rendered = await waitFor(() => driver.execute(`
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      const banner = document.querySelector('.actor-isolation-banner');
      const retryButtons = [...(banner?.querySelectorAll('button') ?? [])]
        .filter((button) => button.textContent?.trim() === 'Try again');
      if (!header || !header.innerText.includes('Outcome unknown')
          || !banner || retryButtons.length !== 1) return null;
      return {
        header: header.innerText,
        banner: banner.innerText,
        bannerRole: banner.getAttribute('role'),
        retryLabel: retryButtons[0]?.textContent?.trim() ?? '',
      };
    `), { budgetMs: 30_000, pollMs: 250 });
    assert(rendered?.bannerRole === 'status'
      && rendered?.banner?.includes('Actor work is paused')
      && rendered?.retryLabel === 'Try again',
    'the packaged UI persistently exposes one labeled recovery control', JSON.stringify(rendered));
    const actorHeaderClicked = await driver.execute(`
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      if (!header) return false;
      header.click();
      return true;
    `);
    assert(actorHeaderClicked === true, 'the ambiguous actor result exposes an expandable detail control');
    const expandedActorResult = await waitFor(() => driver.execute(`
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      if (!header || header.getAttribute('aria-expanded') !== 'true') return null;
      return {
        header: header.innerText,
        expanded: header.getAttribute('aria-expanded'),
        body: header.parentElement?.querySelector('.actor-body')?.innerText ?? '',
      };
    `), { budgetMs: 10_000, pollMs: 100 });
    assert(expandedActorResult?.expanded === 'true'
      && expandedActorResult?.header?.includes('Outcome unknown')
      && !expandedActorResult?.header?.includes('Not run'),
    'the packaged UI distinguishes Outcome unknown without relying on color',
    JSON.stringify(expandedActorResult));
    assert(hasAmbiguousOutcomeWarning(expandedActorResult?.body),
      'the ambiguous actor detail warns that the action may have completed',
      JSON.stringify(expandedActorResult));
    assert(advisesCheckingBeforeRetry(expandedActorResult?.body),
      'the ambiguous actor detail tells the user to check before retrying',
      JSON.stringify(expandedActorResult));

    const requestsBeforeRetry = providerServer.records.length;
    const recoveryStarted = await driver.execute(`
      const retry = [...document.querySelectorAll('.actor-isolation-banner button')]
        .find((button) => button.textContent?.trim() === 'Try again');
      if (!retry) return null;
      retry.click();
      const banner = document.querySelector('.actor-isolation-banner');
      const busyButton = banner?.querySelector('button');
      return {
        ariaBusy: banner?.getAttribute('aria-busy') ?? null,
        disabled: busyButton?.disabled ?? false,
        label: busyButton?.textContent?.trim() ?? '',
      };
    `);
    assert(recoveryStarted?.ariaBusy === 'true'
      && recoveryStarted?.disabled === true
      && recoveryStarted?.label === 'Retrying actor worker…',
    'the visible retry control enters an announced, disabled busy state',
    JSON.stringify(recoveryStarted));
    const recovered = await waitFor(() => driver.executeAsync(`
      const [heartbeatKey] = arguments;
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.runtime.sendMessage({ type: 'state/get' }),
        browser.storage.session.get(heartbeatKey),
      ]).then(([state, heartbeat]) => {
        const receipts = [...document.querySelectorAll('.actor-isolation-banner.is-recovered')];
        const proof = {
          state: state?.state?.capabilities?.actorExecution ?? null,
          heartbeat: heartbeat?.[heartbeatKey] ?? null,
          receiptCount: receipts.length,
          receipt: receipts[0]?.innerText ?? '',
          focused: receipts.length === 1 && document.activeElement === receipts[0],
        };
        done(proof.state?.status === 'available'
          && proof.heartbeat === null
          && proof.receiptCount === 1
          && proof.receipt.includes('Actor work is ready')
          && proof.focused === true
          ? proof
          : null);
      }, (error) => done({ error: error?.message || String(error) }));
    `, [LIFETIME_HEARTBEAT_KEY]), { budgetMs: 30_000, pollMs: 100 });
    assert(recovered?.state?.status === 'available'
      && recovered?.heartbeat === null
      && recovered?.receiptCount === 1
      && recovered?.receipt?.includes('Actor work is ready')
      && recovered?.focused === true,
    'the visible retry restores actor work, clears its heartbeat, and focuses one recovery receipt',
    JSON.stringify(recovered));
    await new Promise((resolveWait) => setTimeout(resolveWait, LIFETIME_QUIET_MS));
    assert(providerServer.records.length === requestsBeforeRetry,
      'restoring actor work does not replay the ambiguous request beyond a full heartbeat interval',
      JSON.stringify({ before: requestsBeforeRetry, after: providerServer.records.length }));
  } catch (error) {
    let product = null;
    try {
      product = await driver?.executeAsync(`
        const done = arguments[arguments.length - 1];
        const send = (message) => browser.runtime.sendMessage(message);
        (async () => {
          const [listed, audit, state] = await Promise.all([
            send({ type: 'session/list' }),
            send({ type: 'audit/list', limit: 500 }),
            send({ type: 'state/get' }),
          ]);
          const root = listed?.sessions?.slice().sort((a, b) => b.createdAt - a.createdAt)
            .find((session) => session.kind !== 'actor');
          const debug = root?.sessionId
            ? await send({ type: 'session/debugBundle', sessionId: root.sessionId })
            : null;
          return {
            bundle: debug?.bundle ?? null,
            audit: audit?.entries ?? [],
            actorExecution: state?.state?.capabilities?.actorExecution ?? null,
          };
        })().then(done, (failure) => done({ error: failure?.message || String(failure) }));
      `);
    } catch { /* failure diagnostics must not mask the original assertion */ }
    const geckoLog = driver?.logs.join('') ?? '';
    if (geckoLog) writeFileSync(join(OUTPUT, KEEPALIVE_LOSS_LOG), geckoLog);
    writeFileSync(join(OUTPUT, KEEPALIVE_LOSS_DIAGNOSTIC), JSON.stringify({
      error: error?.message ?? String(error),
      records: providerServer.records.slice(recordStart).map((record) => ({
        scenario: record.scenario,
        actor: record.body.includes('<actor_agent>'),
        outcomeUnknown: hasOutcomeUnknownState(record.body),
        receivedAt: record.receivedAt,
        responseAttemptedAt: record.responseAttemptedAt,
        respondedAt: record.respondedAt,
      })),
      actorAborts: providerServer.keepaliveLossActorAborts - abortStart,
      product,
    }, null, 2));
    throw error;
  } finally {
    try {
      if (driver) {
        const screenshot = await driver.screenshot();
        writeFileSync(join(OUTPUT, KEEPALIVE_LOSS_SCREENSHOT), Buffer.from(screenshot, 'base64'));
      }
    } catch { /* the browser may already be gone */ }
    if (fixtureTabId != null && driver) {
      await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.tabs.remove(tabId).then(() => done(true), () => done(false));
      `, [fixtureTabId]).catch(() => {});
    }
    await driver?.close();
    providerServer.setScenario({ mode: 'happy', actorTarget: 'web' });
    rmSync(directory, { recursive: true, force: true });
  }
};

const runActorRecoverySmoke = async ({ providerServer }) => {
  console.log('Firefox actor recovery smoke: idle-restart twice without replaying durable mailbox work');
  const { artifact, directory } = createRecoveryArtifact();
  let driver = null;
  try {
    driver = await startGeckodriver({
      binary: geckodriverBinary,
      firefoxBinary,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
      },
    });
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID, 'the recovery diagnostic XPI keeps the Store add-on id', String(installedId));
    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);

    const prepared = await driver.executeAsync(`
      const [passphrase, providerKey, seedKey] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const vault = await send({ type: 'vault/initialize', passphrase });
        const provider = await send({ type: 'provider/setKey', provider: 'anthropic', plaintext: providerKey });
        const command = await send({ type: 'agent/send', text: '/system Firefox recovery fixture' });
        let sessionId = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const listed = await send({ type: 'session/list' });
          sessionId = listed?.sessions?.[0]?.sessionId ?? null;
          if (sessionId) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        if (!sessionId) throw new Error('recovery parent session was not created');
        const createdAt = Date.now();
        const provenance = { rootSessionId: sessionId, lineagePath: [sessionId] };
        const entries = [
          {
            id: 'firefox-recovery-queued', senderSessionId: sessionId,
            to: 'web', message: 'queued recovery request', createdAt,
            state: 'queued', kind: 'web', provenance,
          },
          {
            id: 'firefox-recovery-started', senderSessionId: sessionId,
            to: 'web', message: 'started recovery request', createdAt: createdAt + 1,
            state: 'started', startedAt: createdAt + 2, kind: 'web', provenance,
          },
          {
            id: 'firefox-recovery-legacy', senderSessionId: sessionId,
            to: 'web', message: 'legacy recovery request', createdAt: createdAt + 3,
            kind: 'web', provenance,
          },
        ];
        await browser.storage.session.remove('actorMailbox');
        await browser.storage.local.set({ [seedKey]: { active: true, entries } });
        const probe = await send({ type: 'firefox-recovery/probe' });
        return {
          ok: vault?.ok === true && provider?.ok === true
            && command?.ok === true && typeof probe?.boot?.bootId === 'string',
          sessionId,
          entryIds: entries.map((entry) => entry.id),
          boot: probe?.boot ?? null,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [PASSPHRASE_CANARY, PROVIDER_KEY_CANARY, RECOVERY_SEED_KEY]);
    assert(prepared?.ok === true, 'the recovery profile creates one durable parent and three mailbox seeds',
      JSON.stringify(prepared));

    providerServer.setScenario({ mode: 'recovery', actorTarget: 'web' });
    const recordStart = providerServer.records.length;
    const expectedReceiptIds = prepared.entryIds
      .map((id) => `actor-recovery:${prepared.sessionId}:${id}`)
      .sort();

    const readRecoveryState = () => driver.executeAsync(`
      const [sessionId, expectedIds] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      Promise.all([
        send({ type: 'session/get', sessionId }),
        browser.storage.session.get('actorMailbox'),
        send({ type: 'firefox-recovery/probe' }),
        send({ type: 'audit/list', limit: 500 }),
      ]).then(([sessionReply, mailboxStored, probe, audit]) => {
        const messages = sessionReply?.session?.messages ?? [];
        const expected = new Set(expectedIds);
        const receipts = messages.filter((message) => expected.has(message?.id));
        done({
          ok: sessionReply?.ok === true,
          boot: probe?.boot ?? null,
          mailboxKeys: Object.keys(mailboxStored?.actorMailbox ?? {}),
          messageIds: messages.map((message) => message?.id ?? null),
          receipts: receipts.map((message) => ({
            id: message.id,
            content: message.content,
            outcomeKnown: message.actorReply?.outcomeKnown,
            performed: message.actorReply?.performed,
          })),
          audit: audit?.entries ?? [],
        });
      }, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [prepared.sessionId, expectedReceiptIds]);

    const idleRestartAndRecover = async (previousBoot) => {
      // Exercise Firefox's real event-page lifecycle. runtime.reload tears down
      // the temporary add-on's moz-extension document and Gecko may reject
      // navigation back to that origin for the whole WebDriver command budget,
      // which tests add-on reinstallation rather than product recovery. Closing
      // the last extension UI releases its port; after Firefox's idle window the
      // event page is discarded and the survivor tab can wake a fresh generation.
      const extensionHandle = await driver.windowHandle();
      const survivor = await driver.newWindow('tab');
      assert(typeof survivor?.handle === 'string',
        'the recovery restart keeps a plain browser context alive',
        JSON.stringify(survivor));
      await driver.switchToWindow(survivor.handle);
      await driver.navigate('about:blank');
      await driver.switchToWindow(extensionHandle);
      await driver.closeWindow();
      await driver.switchToWindow(survivor.handle);
      const openHandles = await driver.windowHandles();
      assert(Array.isArray(openHandles) && !openHandles.includes(extensionHandle),
        'the recovery proof physically closes the extension UI context',
        JSON.stringify(openHandles));
      await new Promise((resolveWait) => setTimeout(resolveWait,
        FIREFOX_EVENT_PAGE_IDLE_MS + FIREFOX_EVENT_PAGE_RESTART_MARGIN_MS));

      let lastObserved = null;
      let lastThrownError = null;
      const ready = await waitFor(async () => {
        try {
          await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
          const observed = await driver.executeAsync(`
            const done = arguments[arguments.length - 1];
            Promise.all([
              browser.runtime.sendMessage({ type: 'state/get' }),
              browser.runtime.sendMessage({ type: 'firefox-recovery/probe' }),
            ]).then(([state, probe]) => done({
              stateOk: state?.ok === true,
              state: state?.state ?? null,
              boot: probe?.boot ?? null,
            }), (error) => done({ error: error?.message || String(error) }));
          `);
          lastObserved = observed;
          return observed?.stateOk === true
            && typeof observed.boot?.bootId === 'string'
            && observed.boot.bootId !== previousBoot.bootId
            ? observed
            : null;
        } catch (error) {
          lastThrownError = {
            name: typeof error?.name === 'string' ? error.name : null,
            message: error?.message ?? String(error),
          };
          return null;
        }
      }, { budgetMs: 30_000, pollMs: 250 });
      assert(typeof ready?.boot?.bootId === 'string'
        && ready.boot.bootId !== previousBoot.bootId,
      'the recovery XPI starts a new background generation',
      JSON.stringify({ previousBoot, lastObserved, lastThrownError }));
      if (ready.state?.vault?.locked === true) {
        const unlocked = await driver.executeAsync(`
          const [passphrase] = arguments;
          const done = arguments[arguments.length - 1];
          browser.runtime.sendMessage({ type: 'vault/unlock', passphrase })
            .then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
        `, [PASSPHRASE_CANARY]);
        assert(unlocked?.ok === true, 'the recovery profile unlocks for transcript inspection',
          JSON.stringify(unlocked));
      }
      const recovered = await waitFor(async () => {
        const state = await readRecoveryState();
        return state?.ok === true
          && typeof state.boot?.bootId === 'string'
          && state.boot.bootId !== previousBoot.bootId
          && state.mailboxKeys?.length === 0
          && state.receipts?.length === expectedReceiptIds.length
          ? state
          : null;
      }, { budgetMs: 30_000, pollMs: 250 });
      assert(recovered?.receipts?.length === expectedReceiptIds.length,
        'queued, started, and legacy recovery receipts commit before mailbox removal',
        JSON.stringify(recovered));
      return recovered;
    };

    const first = await idleRestartAndRecover(prepared.boot);
    assert(first.receipts.some((receipt) => receipt.id.endsWith(':firefox-recovery-queued')
      && receipt.outcomeKnown === true && receipt.performed === false
      && receipt.content.includes('It was not run')),
    'queued mailbox work becomes one durable Not run receipt', JSON.stringify(first.receipts));
    assert(first.receipts.filter((receipt) =>
      receipt.id.endsWith(':firefox-recovery-started')
        || receipt.id.endsWith(':firefox-recovery-legacy'))
      .every((receipt) => receipt.outcomeKnown === false
        && receipt.content.includes('cannot confirm whether the previous request ran')),
    'started and legacy mailbox work become durable Outcome unknown receipts',
    JSON.stringify(first.receipts));
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert(providerServer.records.length === recordStart,
      'first background recovery performs no provider or actor request',
      JSON.stringify(providerServer.records.slice(recordStart)));

    const second = await idleRestartAndRecover(first.boot);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    const finalState = await readRecoveryState();
    assert(finalState?.mailboxKeys?.length === 0
      && finalState?.messageIds?.length === expectedReceiptIds.length
      && JSON.stringify(finalState.messageIds.slice().sort()) === JSON.stringify(expectedReceiptIds),
    'the second recovery removes its mailbox seeds without duplicating stable receipts',
    JSON.stringify(finalState));
    assert(new Set([prepared.boot.bootId, first.boot.bootId, second.boot.bootId]).size === 3,
      'the recovery proof observes three distinct background boot identities',
      JSON.stringify([prepared.boot, first.boot, second.boot]));
    const replayAudit = finalState.audit.filter((entry) => entry.type === 'actor_ran_isolated'
      || entry.type === 'actor_message');
    assert(providerServer.records.length === recordStart && replayAudit.length === 0,
      'two background recoveries produce zero model calls and zero actor executions',
      JSON.stringify({ requests: providerServer.records.slice(recordStart), replayAudit }));
  } finally {
    await driver?.close();
    providerServer.setScenario({ mode: 'happy', actorTarget: 'web' });
    rmSync(directory, { recursive: true, force: true });
  }
};

const runBrokenWorkerSmoke = async ({ providerServer }) => {
  console.log('Firefox actor failure smoke: install a copy with the dedicated worker removed');
  const { artifact, directory } = createBrokenWorkerArtifact();
  const workerProbeStart = providerServer.workerStartupProbes;
  let driver = null;
  let fixtureTabId = null;
  try {
    driver = await startGeckodriver({
      binary: geckodriverBinary,
      firefoxBinary,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        httpProxy: `127.0.0.1:${providerServer.port}`,
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
      },
    });
    await driver.setWindowRect({ width: 400, height: 900, x: 0, y: 0 });
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID, 'the broken-worker diagnostic XPI keeps the Store add-on id', String(installedId));

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const mounted = await waitFor(() => driver.execute(
      "return document.readyState === 'complete' && (document.getElementById('app')?.childElementCount || 0) > 0;",
    ), { budgetMs: 30_000 });
    assert(mounted === true, 'the broken-worker package still mounts the Firefox side panel');

    const initialized = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const before = await send({ type: 'state/get' });
        const vault = await send({
          type: 'vault/initialize', passphrase: ${JSON.stringify(PASSPHRASE_CANARY)},
        });
        const provider = await send({
          type: 'provider/setKey', provider: 'anthropic', plaintext: ${JSON.stringify(PROVIDER_KEY_CANARY)},
        });
        const boot = await send({ type: 'firefox-broken-worker/boot-id' });
        return {
          ok: before?.ok === true && vault?.ok === true && provider?.ok === true
            && typeof boot?.bootId === 'string',
          bootId: boot?.bootId ?? null,
          capability: before?.state?.capabilities?.actorExecution ?? null,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(initialized?.ok === true, 'the broken-worker package initializes the real vault and provider',
      JSON.stringify(initialized));
    assert(initialized?.capability?.status === 'available'
      && initialized?.capability?.host === 'background-page-worker',
    'Firefox reports the actor host available before the worker is first started',
    JSON.stringify(initialized?.capability));

    const fixture = await driver.executeAsync(`
      const [fixtureUrl] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const tab = await browser.tabs.create({ url: fixtureUrl, active: true });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const [probe] = await browser.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => document.readyState === 'complete'
                && document.getElementById('firefox-action') !== null,
            });
            if (probe?.result === true) {
              return { ok: true, tabId: tab.id };
            }
          } catch { /* navigation is still in flight */ }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        return { ok: false, tabId: tab.id, error: 'fixture tab did not become scriptable' };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [`http://${DNR_PUBLIC_HOST}${FIXTURE_PATH}`]);
    fixtureTabId = fixture?.tabId ?? null;
    assert(fixture?.ok === true && Number.isInteger(fixtureTabId),
      'the failure lane has a concrete actor target', JSON.stringify(fixture));
    providerServer.setScenario({ mode: 'broken-worker', actorTarget: String(fixtureTabId) });

    const started = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({
        type: 'agent/send',
        text: 'Ask the specified Firefox actor to click its action and report the page status.',
      }).then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(started?.ok === true, 'Firefox accepts the turn that will exercise the broken worker',
      JSON.stringify(started));

    const proof = await waitFor(() => driver.executeAsync(`
      const [finalCanary] = arguments;
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const [listed, audit, state] = await Promise.all([
          send({ type: 'session/list' }),
          send({ type: 'audit/list', limit: 500 }),
          send({ type: 'state/get' }),
        ]);
        if (state?.state?.capabilities?.actorExecution?.status !== 'temporarily_unavailable') return null;
        let bundle = null;
        for (const session of listed?.sessions ?? []) {
          if (!session?.sessionId || session.kind === 'actor') continue;
          const debug = await send({ type: 'session/debugBundle', sessionId: session.sessionId });
          if (debug?.bundle?.session?.messages?.some((message) =>
            message.role === 'assistant'
              && typeof message.content === 'string'
              && message.content.includes(finalCanary))) {
            bundle = debug.bundle;
            break;
          }
        }
        if (!bundle) return null;
        return {
          bundle,
          audit: audit?.entries ?? [],
          state: state?.state ?? null,
        };
      })().then(done, (error) => done({ error: error?.message || String(error) }));
    `, [FAILURE_FINAL_CANARY]), { budgetMs: 60_000, pollMs: 250 });
    assert(proof?.state && proof?.bundle, 'the failed actor turn reaches a visible terminal state',
      JSON.stringify(proof));

    const capability = proof.state.capabilities?.actorExecution;
    assert(capability?.status === 'temporarily_unavailable'
      && capability?.host === 'background-page-worker'
      && capability?.retryable === true,
    'a worker startup failure makes actor execution temporarily unavailable and retryable',
    JSON.stringify(capability));

    const unavailable = proof.audit.filter((entry) => entry.type === 'actor_isolation_unavailable');
    const failures = proof.audit.filter((entry) => entry.type === 'actor_isolation_failure');
    const workerStartupAttempts = providerServer.workerStartupProbes - workerProbeStart;
    assert(workerStartupAttempts === 2,
      'the packaged host makes one initial worker start and exactly one automatic retry',
      String(workerStartupAttempts));
    assert(unavailable.length === 1
      && unavailable[0]?.details?.host === 'background-page-worker'
      && unavailable[0]?.details?.retryable === true,
    'the bounded automatic startup retry ends in one persistent unavailability transition',
    JSON.stringify(unavailable));
    assert(failures.length === 1 && failures[0]?.details?.performed === false,
      'the failed actor turn is audited as not performed', JSON.stringify(failures));
    assert(!proof.audit.some((entry) => entry.type === 'actor_ran_isolated'),
      'the broken-worker package never claims an isolated actor run');
    assert(!proof.audit.some((entry) => entry.type === 'actor_background_turn_refused'),
      'the broken-worker failure is not misreported as a background-turn refusal');

    const observedTarget = await driver.executeAsync(`
      const [tabId] = arguments;
      const done = arguments[arguments.length - 1];
      browser.scripting.executeScript({
        target: { tabId },
        func: () => ({
          clicked: document.body.dataset.clicked ?? null,
          value: document.getElementById('firefox-input')?.value ?? null,
          status: document.getElementById('firefox-status')?.textContent ?? null,
        }),
      }).then(([entry]) => done(entry?.result ?? null),
        (error) => done({ error: error?.message || String(error) }));
    `, [fixtureTabId]);
    assert(observedTarget?.clicked === null
      && observedTarget?.value === ''
      && observedTarget?.status === 'ready',
    'the unavailable actor leaves its concrete target unchanged', JSON.stringify(observedTarget));

    const failureRequests = providerServer.records.filter((record) => record.scenario === 'broken-worker');
    const actorRequests = failureRequests.filter((record) => record.body.includes('<actor_agent>'));
    const parsedFailureRequests = failureRequests.map((record) => {
      try { return JSON.parse(record.body); }
      catch { return null; }
    });
    const failureContinuation = parsedFailureRequests.find((request) =>
      request?.messages?.some((message) => Array.isArray(message.content)
        && message.content.some((block) => block?.type === 'tool_result'
          && block.tool_use_id === 'firefox-broken-worker-tool')));
    const failureToolNames = (failureContinuation?.tools ?? []).map((tool) => tool?.name);
    const failureSystem = requestSystemText(failureContinuation);
    assert(failureRequests.length >= 2, 'the parent model receives the terminal actor refusal',
      String(failureRequests.length));
    assert(actorRequests.length === 0, 'the worker startup failure makes no actor model request',
      String(actorRequests.length));
    assert(failureSystem.includes('status="temporarily_unavailable"')
      && !failureToolNames.some((name) =>
        ['message_actor', 'actor_create', 'request_review'].includes(name)),
    'the continuation tells the model actors are unavailable and removes actor execution tools',
    JSON.stringify({ failureSystem, failureToolNames }));
    assert(failureRequests.every((record) => record.headers['x-api-key'] === PROVIDER_KEY_CANARY)
      && failureRequests.every((record) => !record.body.includes(PROVIDER_KEY_CANARY)),
    'the broken-worker lane keeps the provider key at the provider boundary');

    const storedProof = JSON.stringify({ bundle: proof.bundle, audit: proof.audit, state: proof.state });
    assert(!storedProof.includes(PROVIDER_KEY_CANARY) && !storedProof.includes(PASSPHRASE_CANARY),
      'the broken-worker state, audit, and session diagnostics contain no credential canaries');

    const probesBeforeReload = providerServer.workerStartupProbes;
    // Use Firefox's real event-page lifecycle here too. runtime.reload removes
    // the temporary add-on document from under WebDriver and can make its
    // moz-extension origin unavailable for the remainder of the command budget.
    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    assert(typeof survivor?.handle === 'string',
      'the failure restart keeps a plain browser context alive',
      JSON.stringify(survivor));
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    const openHandles = await driver.windowHandles();
    assert(Array.isArray(openHandles) && !openHandles.includes(extensionHandle),
      'the failure proof physically closes the extension UI context',
      JSON.stringify(openHandles));
    await new Promise((resolveWait) => setTimeout(resolveWait,
      FIREFOX_EVENT_PAGE_IDLE_MS + FIREFOX_EVENT_PAGE_RESTART_MARGIN_MS));
    let lastRestartObserved = null;
    let lastRestartError = null;
    const restarted = await waitFor(async () => {
      try {
        await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
        const observed = await driver.executeAsync(`
          const done = arguments[arguments.length - 1];
          Promise.all([
            browser.runtime.sendMessage({ type: 'state/get' }),
            browser.runtime.sendMessage({ type: 'firefox-broken-worker/boot-id' }),
          ]).then(([state, boot]) => done({
            mounted: !!document.querySelector('#app'),
            capability: state?.state?.capabilities?.actorExecution ?? null,
            bootId: boot?.bootId ?? null,
          }), (error) => done({ error: error?.message || String(error) }));
        `);
        lastRestartObserved = observed;
        return observed?.mounted === true
          && observed?.bootId !== initialized.bootId
          && observed?.capability?.status === 'temporarily_unavailable'
          && observed?.capability?.host === 'background-page-worker'
          && observed?.capability?.retryable === true
          ? observed
          : null;
      } catch (error) {
        lastRestartError = {
          name: typeof error?.name === 'string' ? error.name : null,
          message: error?.message ?? String(error),
        };
        return null;
      }
    }, { budgetMs: 30_000, pollMs: 250 });
    assert(typeof restarted?.bootId === 'string'
      && restarted.bootId !== initialized.bootId,
    'the side panel reconnects to a new Firefox event-page generation',
    JSON.stringify({ previousBootId: initialized.bootId, lastRestartObserved, lastRestartError }));
    const persistedCapability = restarted.capability;
    assert(persistedCapability?.status === 'temporarily_unavailable'
      && persistedCapability?.host === 'background-page-worker'
      && persistedCapability?.retryable === true,
    'the worker failure remains fail-closed after the Firefox event-page restart',
    JSON.stringify(persistedCapability));
    assert(providerServer.workerStartupProbes === probesBeforeReload,
      'background restart does not clear or automatically probe the stored failure',
      `${providerServer.workerStartupProbes} probes after ${probesBeforeReload}`);

    await driver.navigate(`${EXTENSION_ORIGIN}/home/home.html`);
    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const accessible = await waitFor(() => driver.execute(`
      const statuses = [...document.querySelectorAll('.actor-isolation-banner[role="status"]')];
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      if (statuses.length !== 1 || !header) return null;
      return {
        statusCount: statuses.length,
        live: statuses[0].getAttribute('aria-live'),
        atomic: statuses[0].getAttribute('aria-atomic'),
        bannerText: statuses[0].innerText,
        retryText: statuses[0].querySelector('button')?.textContent ?? null,
        headerText: header.innerText,
        headerTag: header.tagName,
        expanded: header.getAttribute('aria-expanded'),
      };
    `), { budgetMs: 30_000, pollMs: 250 });
    assert(accessible?.statusCount === 1
      && accessible?.live === 'polite'
      && accessible?.atomic === 'true'
      && accessible?.bannerText.includes('Actor work is paused')
      && accessible?.bannerText.includes('Use Try again before retrying an actor request.')
      && accessible?.retryText === 'Try again',
    'the persistent live status explains impact and offers a retry', JSON.stringify(accessible));
    assert(accessible?.headerTag === 'BUTTON'
      && accessible?.headerText.includes('Not run')
      && accessible?.expanded === 'false',
    'the failed message_actor card is a collapsed Not run disclosure', JSON.stringify(accessible));

    const disclosureClicked = await driver.execute(`
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      header?.click();
      return !!header;
    `);
    assert(disclosureClicked === true, 'the Not run disclosure accepts its expand action');
    const expanded = await waitFor(() => driver.execute(`
      const header = [...document.querySelectorAll('.tool-call.tool-actor button.tool-call-header')]
        .find((node) => node.querySelector('.tool-name')?.textContent === 'message_actor');
      const state = {
        expanded: header?.getAttribute('aria-expanded') ?? null,
        detail: header?.parentElement?.querySelector('.actor-body .error-line')?.textContent ?? null,
      };
      return state.expanded === 'true' && typeof state.detail === 'string' ? state : null;
    `), { budgetMs: 5_000, pollMs: 100 });
    assert(expanded?.expanded === 'true' && typeof expanded?.detail === 'string'
      && expanded.detail.includes('actor_isolation_temporarily_unavailable')
      && !/Do not retry automatically|Use the Try again control/i.test(expanded.detail),
    'the Not run disclosure exposes the failure reason without relying on color',
    JSON.stringify(expanded));
  } finally {
    try {
      if (driver) {
        const screenshot = await driver.screenshot();
        writeFileSync(join(OUTPUT, BROKEN_WORKER_SCREENSHOT), Buffer.from(screenshot, 'base64'));
      }
    } catch { /* the browser may already be gone */ }
    if (fixtureTabId != null && driver) {
      await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.tabs.remove(tabId).then(() => done(true), () => done(false));
      `, [fixtureTabId]).catch(() => {});
    }
    await driver?.close();
    providerServer.setScenario({ mode: 'happy', actorTarget: 'web' });
    rmSync(directory, { recursive: true, force: true });
  }
};

const runModuleImportPolicySmoke = async (driver, server) => {
  console.log('Firefox module import policy smoke: enforce Store channel and syntax policy before request');
  const notebookId = 'firefox-module-import-policy';
  const notebookUrl = `${EXTENSION_ORIGIN}/engine-tabs/notebook-tab/index.html#${notebookId}`;
  const probeUrl = `http://127.0.0.1:${server.port}${MODULE_IMPORT_PROBE_PATH}`;
  const computedCode = `const target = ${JSON.stringify(probeUrl)};
return await import(target);`;
  const escapedProbeUrl = String.raw`h\x74tp${probeUrl.slice(4)}`;
  const staticCode = `import '${escapedProbeUrl}';
return 'REACHED';`;
  const requestCountBefore = server.moduleImportProbeRequests;
  let notebookTabId = null;
  try {
    const policy = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL('peerd-engine/index.js'))
        .then((engine) => done({
          ok: true,
          unsupportedCode: engine.UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
          storeCode: engine.REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
        }), (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(policy?.ok === true
      && policy.unsupportedCode === 'unsupported_native_module_import'
      && policy.storeCode === 'remote_module_imports_unavailable',
    'the packaged engine exports both import-policy codes', JSON.stringify(policy));

    const opened = await driver.executeAsync(`
      const [url] = arguments;
      const done = arguments[arguments.length - 1];
      browser.tabs.create({ url, active: false })
        .then((tab) => done({ ok: true, tabId: tab.id }),
          (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [notebookUrl]);
    assert(opened?.ok === true && Number.isInteger(opened.tabId),
      'the packaged Firefox Notebook host opens', JSON.stringify(opened));
    notebookTabId = opened.tabId;

    const computedReply = await waitFor(() => driver.executeAsync(`
      const [tabId, id, source] = arguments;
      const done = arguments[arguments.length - 1];
      browser.tabs.sendMessage(tabId, {
        type: 'js/eval', notebookId: id, code: source, timeoutMs: 10_000,
      }).then((response) => done(response?.ok === true ? response : null), () => done(null));
    `, [notebookTabId, notebookId, computedCode]), { budgetMs: 30_000, pollMs: 200 });
    assert(computedReply?.ok === true, 'the live Notebook returns its computed-import result',
      JSON.stringify(computedReply));
    assert(computedReply.result?.errorCode === policy.unsupportedCode
      && computedReply.result?.durationMs === 0
      && computedReply.result?.error?.startsWith('import resolution failed:'),
    'Firefox refuses the computed native import during Acorn preflight',
    JSON.stringify(computedReply.result));
    assert(server.moduleImportProbeRequests === requestCountBefore,
      'the refused computed import makes no module request',
      JSON.stringify({ before: requestCountBefore, after: server.moduleImportProbeRequests }));

    const staticReply = await waitFor(() => driver.executeAsync(`
      const [tabId, id, source] = arguments;
      const done = arguments[arguments.length - 1];
      browser.tabs.sendMessage(tabId, {
        type: 'js/eval', notebookId: id, code: source, timeoutMs: 10_000,
      }).then((response) => done(response?.ok === true ? response : null), () => done(null));
    `, [notebookTabId, notebookId, staticCode]), { budgetMs: 30_000, pollMs: 200 });
    assert(staticReply?.ok === true, 'the live Notebook returns its Store-import result',
      JSON.stringify(staticReply));
    assert(staticReply.result?.errorCode === policy.storeCode
      && staticReply.result?.durationMs === 0
      && staticReply.result?.error?.startsWith('import resolution failed:'),
    'Firefox Store refuses an escaped literal static URL during Acorn preflight',
    JSON.stringify(staticReply.result));
    assert(server.moduleImportProbeRequests === requestCountBefore,
      'the Store policy refusal makes no module request',
      JSON.stringify({ before: requestCountBefore, after: server.moduleImportProbeRequests }));
  } finally {
    if (notebookTabId != null) {
      await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.tabs.remove(tabId).then(() => done(true), () => done(false));
      `, [notebookTabId]).catch(() => {});
    }
  }
};

const runPrivateNetworkDnrSmoke = async (driver, providerServer) => {
  console.log('Firefox private-network DNR smoke: enforce the packaged portable rules before network IO');
  const publicBase = `http://${DNR_PUBLIC_HOST}`;
  const fixtureUrl = `${publicBase}${DNR_FIXTURE_PATH}`;
  let parentTabId = null;
  let extensionTabId = null;
  try {
    providerServer.beginDnrFlow(fixtureUrl);
    const started = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'agent/send', text: ${JSON.stringify(DNR_MAIN_PROMPT)} })
        .then((reply) => done({ ok: reply?.ok === true, error: reply?.error ?? null }),
          (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(started?.ok === true, 'Firefox starts the production web-actor DNR turn', JSON.stringify(started));
    const installed = await waitFor(() => driver.executeAsync(`
      const [actorCanary, finalCanary, fixtureUrl] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const policy = await import(browser.runtime.getURL('peerd-egress/index.js'));
        if (typeof browser.declarativeNetRequest?.getSessionRules !== 'function') {
          return { failed: 'declarativeNetRequest session rules unavailable' };
        }
        const listed = await browser.runtime.sendMessage({ type: 'session/list' });
        const root = listed?.sessions?.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!root?.sessionId) return null;
        const debug = await browser.runtime.sendMessage({ type: 'session/debugBundle', sessionId: root.sessionId });
        if (!debug?.ok || !debug.bundle) return null;
        const rootDone = debug.bundle.session?.messages?.some((message) =>
          message.role === 'assistant' && typeof message.content === 'string'
            && message.content.includes(finalCanary));
        const child = (debug.bundle.childSessions ?? []).find((session) =>
          session.kind === 'actor' && session.actorType === 'web');
        const actorDone = child?.messages?.some((message) =>
          message.role === 'assistant' && typeof message.content === 'string'
            && message.content.includes(actorCanary));
        if (!rootDone || !actorDone) return null;
        const lock = await browser.runtime.sendMessage({ type: 'debug/originLock', origin: fixtureUrl });
        if (!Number.isInteger(lock?.ownedTabId)) return null;
        const tab = await browser.tabs.get(lock.ownedTabId).catch(() => null);
        if (tab?.url !== fixtureUrl) return null;
        const ids = [...policy.PRIVATE_NETWORK_RULE_IDS];
        const liveRules = await browser.declarativeNetRequest.getSessionRules();
        const [extensionTab] = await browser.tabs.query({ active: true, currentWindow: true });
        return {
          ok: true,
          tabId: lock.ownedTabId,
          extensionTabId: extensionTab?.id,
          expectedIds: ids,
          expectedResourceTypes: [...policy.DENYLIST_RESOURCE_TYPES],
          hostRuleId: policy.PRIVATE_NETWORK_HOST_RULE_ID,
          rules: liveRules.filter((rule) => ids.includes(rule.id)),
        };
      })().then(done, (error) => done({ failed: error?.message || String(error) }));
    `, [DNR_ACTOR_REPLY_CANARY, DNR_FINAL_REPLY_CANARY, fixtureUrl]), { budgetMs: 60_000, pollMs: 200 });
    assert(installed?.ok === true && Number.isInteger(installed.tabId),
      'Firefox installs the production portable private-network rules', JSON.stringify(installed));
    parentTabId = installed.tabId;
    extensionTabId = installed.extensionTabId;
    assert(providerServer.dnrFlow?.phase === 'complete' && providerServer.dnrFlow?.errors?.length === 0,
      'the provider double observes the production message_actor and navigate sequence',
      JSON.stringify(providerServer.dnrFlow));
    const installedIds = installed.rules.map((rule) => rule.id).sort((a, b) => a - b);
    const expectedIds = [...installed.expectedIds].sort((a, b) => a - b);
    assert(JSON.stringify(installedIds) === JSON.stringify(expectedIds),
      'Firefox retains every production private-network rule id',
      JSON.stringify({ installedIds, expectedIds }));
    const expectedTypes = [...installed.expectedResourceTypes].sort();
    const ruleShapeOk = installed.rules.every((rule) =>
      rule.action?.type === 'block'
      && rule.priority === 4
      && JSON.stringify([...(rule.condition?.tabIds ?? [])].sort((a, b) => a - b)) === JSON.stringify([parentTabId])
      && JSON.stringify([...(rule.condition?.resourceTypes ?? [])].sort()) === JSON.stringify(expectedTypes));
    assert(ruleShapeOk, 'installed Firefox DNR rules are block-only, tab-scoped, and use portable resource types',
      JSON.stringify(installed.rules));
    const hostRule = installed.rules.find((rule) => rule.id === installed.hostRuleId);
    assert(hostRule?.condition?.requestDomains?.includes('localhost')
      && expectedTypes.includes('main_frame')
      && expectedTypes.includes('xmlhttprequest')
      && expectedTypes.includes('image')
      && expectedTypes.includes('ping')
      && expectedTypes.includes('beacon')
      && expectedTypes.includes('websocket')
      && expectedTypes.includes('imageset')
      && !expectedTypes.includes('webbundle')
      && !expectedTypes.includes('webtransport'),
    'installed rule inspection includes navigation, fetch, image-set, beacon, and WebSocket without Chrome-only types',
    JSON.stringify({ hostRule, expectedTypes }));

    const unrelatedProbe = await startNetworkProbe();
    try {
      const unrelated = await driver.executeAsync(`
        const [target] = arguments;
        const done = arguments[arguments.length - 1];
        (async () => {
          const tab = await browser.tabs.create({ url: target, active: false });
          return { ok: true, tabId: tab.id };
        })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
      `, [`http://localhost.:${unrelatedProbe.port}/unrelated-user-tab`]);
      try {
        await waitFor(() => unrelatedProbe.connections > 0 && unrelatedProbe.requests.length > 0
          ? true : null, { budgetMs: 5_000, pollMs: 50 });
        assert(unrelated?.ok === true && unrelatedProbe.connections > 0 && unrelatedProbe.requests.length > 0,
          'an unrelated user tab still reaches trailing-dot localhost while scoped rules are active',
          JSON.stringify({ unrelated, connections: unrelatedProbe.connections, requests: unrelatedProbe.requests }));
      } finally {
        if (Number.isInteger(unrelated?.tabId)) {
          await driver.executeAsync(`
            const [tabId] = arguments;
            const done = arguments[arguments.length - 1];
            browser.tabs.remove(tabId).then(() => done(true), () => done(false));
          `, [unrelated.tabId]);
        }
      }
    } finally {
      await unrelatedProbe.close();
    }

    const vectors = [
      { name: 'fetch', action: 'fetch', host: '127.0.0.1' },
      { name: 'WebSocket', action: 'websocket', host: '127.0.0.1', protocol: 'ws' },
      { name: 'trailing-dot localhost fetch', action: 'fetch', host: 'localhost.' },
      { name: 'sendBeacon', action: 'beacon', host: '127.0.0.1' },
      { name: 'image', action: 'image', host: '127.0.0.1' },
      { name: 'image srcset', action: 'imageset', host: '127.0.0.1' },
      { name: 'form POST', action: 'form', host: '127.0.0.1' },
      { name: 'public redirect', action: 'redirect', host: '127.0.0.1', publicPath: DNR_REDIRECT_PATH },
      { name: 'meta refresh', action: 'meta', host: '127.0.0.1', publicPath: DNR_META_PATH },
      { name: 'served script location', action: 'script', host: '127.0.0.1', publicPath: DNR_SCRIPT_PATH },
      { name: 'in-page location', action: 'location', host: '127.0.0.1' },
      { name: 'popup navigation', action: 'popup', host: '127.0.0.1' },
      { name: 'cross-frame popup navigation', action: 'cross-popup', host: '127.0.0.1' },
    ];
    const vectorRuns = await Promise.all(vectors.map(async (vector) => {
      const probe = await startNetworkProbe();
      const target = `${vector.protocol ?? 'http'}://${vector.host}:${probe.port}/dnr-${encodeURIComponent(vector.action)}`;
      const token = `${vector.action}-${probe.port}`;
      const routeId = providerServer.registerDnrVector({ action: vector.action, token, target });
      const query = `route=${encodeURIComponent(routeId)}`;
      return {
        ...vector,
        probe,
        target,
        token,
        routeId,
        publicActionUrl: vector.publicPath
          ? `${publicBase}${vector.publicPath}?${query}`
          : '',
        pageActionUrl: vector.publicPath
          ? ''
          : `${publicBase}${DNR_ACTION_PATH}?${query}`,
      };
    }));
    const proxyStart = providerServer.httpRequests.length;
    const webSocketUpgradeStart = providerServer.webSocketUpgrades.length;
    try {
      const result = await driver.executeAsync(`
          const [tabId, fixtureUrl, vectors] = arguments;
          const done = arguments[arguments.length - 1];
          let stage = 'initialize';
          (async () => {
            const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
            const ready = async (id) => {
              for (let attempt = 0; attempt < 120; attempt += 1) {
                try {
                  const [probe] = await browser.scripting.executeScript({
                    target: { tabId: id },
                    func: () => document.body?.dataset?.dnrReady === 'yes',
                  });
                  if (probe?.result === true) return true;
                } catch { /* navigation still in flight */ }
                await wait(50);
              }
              return false;
            };
            const outcomes = [];
            for (const vector of vectors) {
              const { action, publicActionUrl, pageActionUrl } = vector;
              const beforeTabIds = new Set((await browser.tabs.query({})).map((tab) => tab.id));
              stage = 'reload:' + action;
              await browser.tabs.update(tabId, { url: fixtureUrl, active: false });
              stage = 'ready:' + action;
              if (!(await ready(tabId))) throw new Error('DNR public fixture did not become scriptable');
              stage = 'action:' + action;
              // why: navigation lets the public page run its own action in the
              // page realm without asking Firefox for a second injection grant.
              const loadPageAction = () => browser.tabs.update(tabId, {
                url: pageActionUrl, active: false,
              });
              if (['fetch', 'websocket', 'beacon', 'image', 'imageset', 'form', 'location'].includes(action)) {
                await loadPageAction();
              } else if (action === 'redirect' || action === 'meta' || action === 'script') {
                await browser.tabs.update(tabId, { url: publicActionUrl, active: false });
              } else if (action === 'popup' || action === 'cross-popup') {
                await loadPageAction();
              } else {
                throw new Error('unknown DNR vector: ' + action);
              }
              await wait(600);
              const childRemaining = (await browser.tabs.query({})).some((tab) =>
                !beforeTabIds.has(tab.id) && tab.openerTabId === tabId);
              outcomes.push({ action, childRemaining });
            }
            return { ok: true, outcomes };
          })().then(done, (error) => done({ ok: false, stage, error: error?.message || String(error) }));
        `, [parentTabId, fixtureUrl, vectorRuns.map(({ probe: _probe, host: _host, name: _name, publicPath: _publicPath, ...vector }) => vector)]);
      await delay(200);
      assert(result?.ok === true && result.outcomes?.length === vectorRuns.length,
        'Firefox drives every private-network DNR vector', JSON.stringify(result));
      const proxied = providerServer.httpRequests.slice(proxyStart);
      const upgraded = providerServer.webSocketUpgrades.slice(webSocketUpgradeStart);
      for (const [index, vector] of vectorRuns.entries()) {
        const outcome = result.outcomes[index];
        assert(outcome?.action === vector.action, `Firefox drives the ${vector.name} DNR vector`, JSON.stringify(outcome));
        if (vector.action === 'popup' || vector.action === 'cross-popup') {
          assert(outcome?.childRemaining === false,
            'Firefox closes the protected popup after the attempted action', JSON.stringify(outcome));
        }
        const unexpectedProxyTargets = proxied.filter((request) =>
          ![DNR_PUBLIC_HOST, DNR_FRAME_HOST].includes(request.host)
            && request.url.includes(`:${vector.probe.port}/`));
        const unexpectedWebSocketUpgrades = upgraded.filter((request) =>
          ![DNR_PUBLIC_HOST, DNR_FRAME_HOST].includes(request.host)
            && request.url.includes(`:${vector.probe.port}/`));
        const publicPath = vector.publicPath || DNR_ACTION_PATH;
        const loaded = proxied.some((request) => {
          const url = new URL(request.url);
          return request.host === DNR_PUBLIC_HOST
            && request.path === publicPath
            && url.searchParams.get('route') === vector.routeId;
        });
        assert(loaded, `Firefox loads the public ${vector.name} action page`, JSON.stringify(proxied));
        const attempted = vector.action === 'redirect'
          ? providerServer.dnrRedirectAttempts.some((attempt) =>
            attempt.action === vector.action && attempt.token === vector.token && attempt.target === vector.target)
          : proxied.some((request) => {
            const url = new URL(request.url);
            return [DNR_PUBLIC_HOST, DNR_FRAME_HOST].includes(request.host)
              && request.path === DNR_ATTEMPT_PATH
              && request.method === 'POST'
              && url.searchParams.get('action') === vector.action
              && url.searchParams.get('token') === vector.token;
          });
        assert(attempted, `the ${vector.name} action page attempts its browser request`,
          JSON.stringify({ proxied, redirectAttempts: providerServer.dnrRedirectAttempts }));
        if (vector.action === 'popup' || vector.action === 'cross-popup') {
          const childCreated = proxied.some((request) => {
            const url = new URL(request.url);
            return [DNR_PUBLIC_HOST, DNR_FRAME_HOST].includes(request.host)
              && request.path === DNR_ATTEMPT_PATH
              && request.method === 'POST'
              && url.searchParams.get('action') === `${vector.action}-created`
              && url.searchParams.get('token') === vector.token;
          });
          assert(childCreated, `Firefox observes the ${vector.name} child handle before closure`,
            JSON.stringify(proxied));
        }
        assert(vector.probe.connections === 0 && vector.probe.requests.length === 0
          && unexpectedProxyTargets.length === 0 && unexpectedWebSocketUpgrades.length === 0,
          `scoped Firefox ${vector.name} causes zero raw TCP or HTTP side effects`,
          JSON.stringify({
            connections: vector.probe.connections,
            requests: vector.probe.requests,
            unexpectedProxyTargets,
            unexpectedWebSocketUpgrades,
          }));
      }
    } finally {
      await Promise.all(vectorRuns.map(({ probe }) => probe.close()));
    }

    const burstProbe = await startNetworkProbe();
    try {
      const burstTarget = `http://127.0.0.1:${burstProbe.port}/dnr-child-burst`;
      const burstToken = `burst-${burstProbe.port}`;
      const burstRouteId = providerServer.registerDnrVector({
        action: 'burst', token: burstToken, target: burstTarget,
      });
      const burstUrl = `${publicBase}${DNR_ACTION_PATH}?route=${encodeURIComponent(burstRouteId)}`;
      const burstProxyStart = providerServer.httpRequests.length;
      const prepared = await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        (async () => {
          const policy = await import(browser.runtime.getURL('peerd-egress/index.js'));
          await browser.tabs.remove(tabId);
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const rules = await browser.declarativeNetRequest.getSessionRules();
            const stillScoped = rules.some((rule) =>
              policy.PRIVATE_NETWORK_RULE_IDS.includes(rule.id)
                && rule.condition?.tabIds?.includes(tabId));
            if (!stillScoped) {
              return { ok: true, beforeTabIds: (await browser.tabs.query({})).map((tab) => tab.id) };
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          }
          return { ok: false, error: 'old actor tab remained in private-network rules' };
        })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
      `, [parentTabId]);
      assert(prepared?.ok === true, 'Firefox starts the child burst with a fresh actor tab', JSON.stringify(prepared));
      parentTabId = null;

      providerServer.beginDnrBurstFlow(burstUrl);
      const burstStarted = await driver.executeAsync(`
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({ type: 'agent/send', text: ${JSON.stringify(DNR_BURST_MAIN_PROMPT)} })
          .then((reply) => done({ ok: reply?.ok === true, error: reply?.error ?? null }),
            (error) => done({ ok: false, error: error?.message || String(error) }));
      `);
      assert(burstStarted?.ok === true, 'Firefox starts the actor-driven protected child burst', JSON.stringify(burstStarted));
      const burstComplete = await waitFor(() => providerServer.dnrFlow?.phase === 'complete'
        ? providerServer.dnrFlow : null, { budgetMs: 60_000, pollMs: 100 });
      await delay(500);
      const burstTabs = await driver.executeAsync(`
        const done = arguments[arguments.length - 1];
        browser.tabs.query({}).then((tabs) => done(tabs.map((tab) => ({
          id: tab.id, openerTabId: tab.openerTabId, url: tab.url,
        }))));
      `);
      const sourceTab = burstTabs.find((tab) => tab.url === burstUrl);
      assert(Number.isInteger(sourceTab?.id), 'Firefox actor owns the child burst fixture tab', JSON.stringify(burstTabs));
      parentTabId = sourceTab.id;
      const beforeIds = new Set(prepared.beforeTabIds);
      const publicChild = burstTabs.find((tab) =>
        !beforeIds.has(tab.id) && tab.openerTabId === parentTabId);
      const burstHttp = providerServer.httpRequests.slice(burstProxyStart);
      const attempted = burstHttp.some((request) => {
        const url = new URL(request.url);
        return request.host === DNR_PUBLIC_HOST
          && request.path === DNR_ATTEMPT_PATH
          && request.method === 'POST'
          && url.searchParams.get('action') === 'burst'
          && url.searchParams.get('token') === burstToken;
      });
      const actorToolResultBody = burstComplete?.actorToolResultBody ?? '';
      let childReceipt = null;
      try {
        const payload = JSON.parse(actorToolResultBody);
        const toolResult = (payload.messages ?? [])
          .flatMap((message) => Array.isArray(message.content) ? message.content : [])
          .find((block) => block?.type === 'tool_result' && block.tool_use_id === DNR_BURST_TOOL_ID);
        const content = typeof toolResult?.content === 'string' ? JSON.parse(toolResult.content) : null;
        childReceipt = content?.browserPolicy ?? null;
      } catch { childReceipt = null; }
      assert(attempted, 'the Firefox actor click reaches the immediate child-request action', JSON.stringify(burstHttp));
      assert(burstProbe.connections === 0 && burstProbe.requests.length === 0,
        'the Firefox immediate child fetch and WebSocket cause zero network side effects',
        JSON.stringify({ connections: burstProbe.connections, requests: burstProbe.requests }));
      assert(Number.isInteger(publicChild?.id),
        'Firefox leaves the exact public child available', JSON.stringify(burstTabs));
      assert(!actorToolResultBody.includes(`127.0.0.1:${burstProbe.port}`),
        'the Firefox source actor transcript contains no protected destination',
        actorToolResultBody.slice(0, 1200));
      assert(childReceipt == null || (childReceipt.reason === 'protected_child_request'
        && childReceipt.outcome === 'not_run'
        && childReceipt.child === 'guarded'
        && childReceipt.retryable === false),
      'a synchronous Firefox child stop emits only the URL-free protected request receipt',
      JSON.stringify({ childReceipt }));
      await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.tabs.remove(tabId).then(() => done(true), () => done(false));
      `, [publicChild.id]);
    } finally {
      await burstProbe.close();
    }

    const released = await driver.executeAsync(`
      const [tabId, extensionTabId] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const policy = await import(browser.runtime.getURL('peerd-egress/index.js'));
        if (Number.isInteger(extensionTabId)) {
          await browser.tabs.update(extensionTabId, { active: true }).catch(() => {});
        }
        await browser.tabs.remove(tabId);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const rules = await browser.declarativeNetRequest.getSessionRules();
          const stillScoped = rules.some((rule) =>
            policy.PRIVATE_NETWORK_RULE_IDS.includes(rule.id)
              && rule.condition?.tabIds?.includes(tabId));
          if (!stillScoped) return { ok: true };
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        return { ok: false, error: 'closed actor tab remained in private-network rules' };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `, [parentTabId, extensionTabId]);
    assert(released?.ok === true, 'closing the driven actor tab removes its production DNR scope', JSON.stringify(released));
    parentTabId = null;
  } finally {
    if (parentTabId != null) {
      await driver.executeAsync(`
        const [tabId] = arguments;
        const done = arguments[arguments.length - 1];
        browser.tabs.remove(tabId).then(() => done(true), () => done(false));
      `, [parentTabId]).catch(() => {});
    }
  }
};

const main = async () => {
  if (!firefoxBinary) throw new Error('Firefox not found. Set FIREFOX_PATH.');
  if (!geckodriverBinary) throw new Error('geckodriver not found. Set GECKODRIVER_PATH.');
  mkdirSync(OUTPUT, { recursive: true });
  for (const diagnostic of [
    'failure.png', 'geckodriver.log', 'sidepanel.png',
    BROKEN_WORKER_SCREENSHOT, KEEPALIVE_LOSS_SCREENSHOT,
    KEEPALIVE_LOSS_LOG, KEEPALIVE_LOSS_DIAGNOSTIC,
    LIFETIME_FAILURE_SCREENSHOT, LIFETIME_FAILURE_LOG, LIFETIME_FAILURE_DIAGNOSTIC,
  ]) {
    rmSync(join(OUTPUT, diagnostic), { force: true });
  }

  console.log('Firefox packaged Store smoke: build and install');
  const artifact = await packageArtifact({
    channel: 'store', browser: 'firefox', version: VERSION, sign: false, verify: true,
  });
  const server = await startTestServer();
  let providerServer = null;
  let driver = null;
  try {
    providerServer = await startProviderServer();
    driver = await startGeckodriver({
      binary: geckodriverBinary,
      firefoxBinary,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        httpProxy: `127.0.0.1:${providerServer.port}`,
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', 'localhost.', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
        // why: keep native LNA and popup policy from preempting the extension's
        // own DNR behavior, so the probe counters isolate the product boundary.
        'network.lna.enabled': false,
        'network.lna.blocking': false,
        'network.dns.disableIPv6': true,
        'dom.disable_open_during_load': false,
      },
    });
    await driver.setWindowRect({ width: 400, height: 900, x: 0, y: 0 });
    console.log(`  installing ${artifact}`);
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID, 'temporary add-on id matches the Store manifest', String(installedId));

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const mounted = await waitFor(() => driver.execute(
      "return document.readyState === 'complete' && (document.getElementById('app')?.childElementCount || 0) > 0;",
    ), { budgetMs: 30_000 });
    assert(mounted === true, 'packaged Firefox side panel mounts');

    const posture = await driver.execute(`
      return {
        runtimeId: chrome.runtime.id,
        scripting: typeof chrome.scripting?.executeScript,
        sidebar: typeof chrome.sidebarAction?.open,
        debuggerApi: typeof chrome.debugger,
        offscreenApi: typeof chrome.offscreen,
      };
    `);
    assert(posture?.runtimeId === ADDON_ID, 'packaged page runs under the expected extension identity', JSON.stringify(posture));
    assert(posture?.scripting === 'function', 'Firefox exposes the scripting fallback');
    assert(posture?.sidebar === 'function', 'Firefox exposes the sidebar API');
    assert(posture?.debuggerApi === 'undefined', 'Firefox package has no debugger API path');
    assert(posture?.offscreenApi === 'undefined', 'Firefox package has no offscreen API path');

    const background = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const before = await send({ type: 'state/get' });
        const passphrase = ${JSON.stringify(PASSPHRASE_CANARY)};
        const providerKey = ${JSON.stringify(PROVIDER_KEY_CANARY)};
        const sensitiveNames = new Set([
          'key', 'plaintext', 'passphrase', 'prfoutput', 'apikey', 'secret',
          'keymaterial', 'accesstoken', 'providertoken', 'providerkey',
          'wrappeddk', 'datakey', 'masterkey', 'privatekey',
        ]);
        const scan = (value, snapshotName, path = '', leaks = []) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            const next = path ? path + '.' + key : key;
            const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (typeof child === 'string' && child.length > 0 && sensitiveNames.has(normalized)) {
              leaks.push(snapshotName + '.' + next);
            }
            scan(child, snapshotName, next, leaks);
          }
          return leaks;
        };
        const initialized = await send({ type: 'vault/initialize', passphrase });
        const providerSaved = await send({
          type: 'provider/setKey', provider: 'anthropic', plaintext: providerKey,
        });
        const afterInitialize = await send({ type: 'state/get' });
        const sessions = await send({ type: 'session/list' });
        const locked = await send({ type: 'vault/lock' });
        const afterLock = await send({ type: 'state/get' });
        const wrongUnlock = await send({ type: 'vault/unlock', passphrase: passphrase + '-wrong' });
        const afterWrongUnlock = await send({ type: 'state/get' });
        const unlocked = await send({ type: 'vault/unlock', passphrase });
        const afterUnlock = await send({ type: 'state/get' });
        const snapshots = {
          before: before?.state,
          afterInitialize: afterInitialize?.state,
          afterLock: afterLock?.state,
          afterWrongUnlock: afterWrongUnlock?.state,
          afterUnlock: afterUnlock?.state,
        };
        const sensitivePaths = Object.entries(snapshots).flatMap(([name, state]) => scan(state, name) || []);
        const canaryPaths = Object.entries(snapshots).flatMap(([name, state]) => {
          const serialized = JSON.stringify(state) ?? '';
          return [
            ...(serialized.includes(passphrase) ? [name + '.passphrase-canary'] : []),
            ...(serialized.includes(providerKey) ? [name + '.provider-key-canary'] : []),
          ];
        });
        return {
          ok: before?.ok === true,
          initiallyLocked: before?.state?.vault?.locked,
          sensitivePaths,
          canaryPaths,
          initialized: initialized?.ok === true,
          providerSaved: providerSaved?.ok === true,
          unlockedAfterInitialize: afterInitialize?.state?.vault?.locked === false,
          sessionsReadable: sessions?.ok === true && Array.isArray(sessions.sessions),
          locked: locked?.ok === true && afterLock?.state?.vault?.locked === true,
          wrongPassphraseRefused: wrongUnlock?.ok === false
            && wrongUnlock?.error === 'wrong-passphrase'
            && afterWrongUnlock?.state?.vault?.locked === true,
          unlocked: unlocked?.ok === true && afterUnlock?.state?.vault?.locked === false,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(background?.ok === true, 'Firefox background module answers real extension RPCs', JSON.stringify(background));
    assert(background?.initiallyLocked === true, 'fresh Firefox profile starts with the vault locked', JSON.stringify(background));
    assert(background?.sensitivePaths?.length === 0 && background?.canaryPaths?.length === 0,
      'locked and unlocked state snapshots expose no secret-bearing fields', JSON.stringify(background));
    assert(background?.initialized === true && background?.unlockedAfterInitialize === true,
      'Firefox initializes the encrypted vault', JSON.stringify(background));
    assert(background?.providerSaved === true, 'Firefox stores a provider key in the encrypted vault', JSON.stringify(background));
    assert(background?.sessionsReadable === true, 'Firefox reads session storage through the live background', JSON.stringify(background));
    assert(background?.wrongPassphraseRefused === true,
      'Firefox refuses a wrong vault passphrase', JSON.stringify(background));
    assert(background?.locked === true && background?.unlocked === true,
      'Firefox locks and unlocks the vault with the same passphrase', JSON.stringify(background));

    await runPrivateNetworkDnrSmoke(driver, providerServer);
    await runModuleImportPolicySmoke(driver, server);
    await runBoundActorSmoke(driver, providerServer);
    await runActorLifetimeSmoke({ providerServer });
    await runActorKeepaliveLossSmoke({ providerServer });
    await runActorRecoverySmoke({ providerServer });

    const scriptingFlow = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      const fixtureUrl = ${JSON.stringify(`http://127.0.0.1:${server.port}${FIXTURE_PATH}`)};
      (async () => {
        let tab;
        try {
          const [{ captureSnapshot }, { clickInjected }, { typeInjected }] = await Promise.all([
            import(browser.runtime.getURL('peerd-runtime/dom/index.js')),
            import(browser.runtime.getURL('peerd-runtime/tools/defs/click.js')),
            import(browser.runtime.getURL('peerd-runtime/tools/defs/type.js')),
          ]);
          tab = await browser.tabs.create({ url: fixtureUrl, active: true });
          let fixtureReady = false;
          let fixtureDocumentId = null;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            try {
              const [probe] = await browser.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.readyState === 'complete'
                  && document.getElementById('firefox-action') !== null,
              });
              if (probe?.result === true && typeof probe?.documentId === 'string') {
                fixtureReady = true;
                fixtureDocumentId = probe.documentId;
                break;
              }
            } catch { /* Firefox may reject injection while navigation is in flight */ }
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          }
          if (!fixtureReady || !fixtureDocumentId) {
            throw new Error('fixture tab did not produce an exact scriptable document');
          }
          const snapshot = await captureSnapshot(
            { id: tab.id, peerdDocumentId: fixtureDocumentId },
            { scripting: browser.scripting },
            { budget: 4_000 },
          );
          const [typed] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [fixtureDocumentId] },
            func: typeInjected,
            args: ['#firefox-input', 'typed in Firefox', false, null, 1],
          });
          const [clicked] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [fixtureDocumentId] },
            func: clickInjected,
            args: ['#firefox-action', 0, null, 1],
          });
          const [observed] = await browser.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [fixtureDocumentId] },
            func: () => ({
              clicked: document.body.dataset.clicked,
              value: document.getElementById('firefox-input')?.value,
              status: document.getElementById('firefox-status')?.textContent,
            }),
          });
          return {
            ok: true,
            snapshot: snapshot?.ok === true,
            source: snapshot?.source,
            snapshotHasControls: snapshot?.text?.includes('Firefox parity action')
              && snapshot?.text?.includes('Firefox parity input'),
            typed: typed?.result?.ok === true,
            clicked: clicked?.result?.ok === true,
            observed: observed?.result,
          };
        } finally {
          if (tab?.id != null) await browser.tabs.remove(tab.id).catch(() => {});
        }
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(scriptingFlow?.ok === true, 'packaged Firefox runs the scripting contract', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.snapshot === true && scriptingFlow?.source === 'dom-walk',
      'Firefox captures a real tab through the DOM-walk fallback', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.snapshotHasControls === true, 'Firefox snapshot contains the target controls', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.typed === true && scriptingFlow?.observed?.value === 'typed in Firefox'
      && scriptingFlow?.observed?.status === 'typed in Firefox',
    'Firefox types through the real scripting path', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.clicked === true && scriptingFlow?.observed?.clicked === 'yes',
      'Firefox clicks through the real scripting path', JSON.stringify(scriptingFlow));

    const primaryPages = [
      ['home/home.html', '#app'],
      ['options/options.html', '#app'],
    ];
    for (const [page, selector] of primaryPages) {
      await driver.navigate(`${EXTENSION_ORIGIN}/${page}`);
      const ready = await waitFor(() => driver.execute(
        `return document.readyState === 'complete' && (document.querySelector(${JSON.stringify(selector)})?.childElementCount || 0) > 0;`,
      ), { budgetMs: 30_000 });
      assert(ready === true, `packaged Firefox ${page} mounts`);
    }

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const remounted = await waitFor(() => driver.execute(
      "return document.readyState === 'complete' && document.querySelector('.topbar') !== null;",
    ), { budgetMs: 30_000 });
    assert(remounted === true, 'packaged Firefox side panel receives the unlocked state');
    const renderedActorTurn = await waitFor(() => driver.execute(`
      const messages = document.querySelector('.message-list')?.innerText ?? '';
      const actorCard = [...document.querySelectorAll('.tool-call.tool-actor .tool-name')]
        .some((node) => node.textContent === 'message_actor');
      return messages.includes(${JSON.stringify(FINAL_REPLY_CANARY)}) && actorCard;
    `), { budgetMs: 30_000 });
    assert(renderedActorTurn === true,
      'packaged Firefox renders the actor card and final answer in the side panel');
    // Let the one-shot wordmark intro settle so diagnostics show the final UI,
    // without changing the motion preference used by the browser test suite.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_700));
    const screenshot = await driver.screenshot();
    writeFileSync(join(OUTPUT, 'sidepanel.png'), Buffer.from(screenshot, 'base64'));

    await runBrokenWorkerSmoke({ providerServer });

    console.log('Firefox Gecko web-platform suite: run shared browser tests');
    const only = process.env.FIREFOX_TEST_ONLY ?? '';
    const shardRequest = process.env.FIREFOX_TEST_SHARD ?? '';
    const requestedShard = only ? null : /^(\d+)\/(\d+)$/.exec(shardRequest);
    assert(!shardRequest || only || requestedShard !== null,
      'Firefox shard request uses N/TOTAL', shardRequest);
    const shardCount = only ? 1 : Number(requestedShard?.[2] ?? process.env.FIREFOX_TEST_SHARDS ?? 8);
    const resultBudgetMs = Number(process.env.FIREFOX_RESULT_BUDGET_MS ?? RESULT_BUDGET_MS);
    assert(Number.isInteger(shardCount) && shardCount >= 1 && shardCount <= 32,
      'Firefox test shard count is valid', String(shardCount));
    assert(Number.isFinite(resultBudgetMs) && resultBudgetMs >= 1_000,
      'Firefox test result budget is valid', String(resultBudgetMs));
    const shardNumbers = requestedShard
      ? [Number(requestedShard[1])]
      : Array.from({ length: shardCount }, (_, index) => index + 1);
    assert(shardNumbers.every((number) => number >= 1 && number <= shardCount),
      'requested Firefox test shard is valid', process.env.FIREFOX_TEST_SHARD ?? 'all');
    let expectedTotal = null;
    let executed = 0;
    let passed = 0;
    let runtimeMs = 0;
    for (const shardNumber of shardNumbers) {
      const query = new URLSearchParams({
        ci: '1',
        ...(only ? { only } : {}),
        ...(shardCount > 1 ? { shard: `${shardNumber}/${shardCount}` } : {}),
      });
      const runnerUrl = `http://localhost:${server.port}/tests/runner.html?${query.toString()}`;
      console.log(`  running shard ${shardNumber}/${shardCount}`);
      await driver.navigate(runnerUrl);
      const marker = await waitFor(() => driver.execute(
        "return document.getElementById('ci-marker')?.textContent || '';",
      ), { budgetMs: resultBudgetMs, pollMs: 500 });
      if (typeof marker !== 'string' || !marker.startsWith('__TEST_RESULT__')) {
        const diagnostic = await driver.execute(`
          const summary = document.getElementById('summary');
          return {
            href: location.href,
            current: summary?.textContent || document.body?.innerText?.slice(0, 600) || '(none)',
            history: JSON.parse(summary?.dataset.testHistory || '[]'),
          };
        `);
        throw new Error(`Firefox in-browser shard ${shardNumber}/${shardCount} produced no result marker: ${JSON.stringify(diagnostic)}`);
      }
      const result = JSON.parse(marker.slice('__TEST_RESULT__'.length).trim());
      if (result.crash) {
        throw new Error(`Firefox in-browser runner crashed in shard ${shardNumber}/${shardCount}: ${result.crash}`);
      }
      if (result.failed > 0) {
        const failures = await driver.execute(`
          return [...document.querySelectorAll('li.test.fail')].map((item) => {
            const name = item.querySelectorAll(':scope > span')[1]?.textContent ?? '(unnamed)';
            const error = item.querySelector('details')?.innerText?.trim() ?? '';
            return error ? name + ': ' + error : name;
          });
        `);
        throw new Error(`Firefox in-browser failures in shard ${shardNumber}/${shardCount} (${result.failed}):\n  ${(failures ?? []).join('\n  ')}`);
      }
      assert(result.shardNumber === shardNumber && result.shardCount === shardCount,
        'Firefox runner acknowledged the requested shard', JSON.stringify(result));
      if (expectedTotal === null) expectedTotal = result.total;
      assert(Number.isInteger(result.total) && result.total > 0,
        'Firefox loaded a non-empty browser test graph', String(result.total));
      assert(result.total === expectedTotal, 'Firefox shards loaded the same test graph');
      const shardExecuted = result.passed + result.failed;
      assert(shardExecuted > 0, 'Firefox shard or filter selected at least one test', `${shardNumber}/${shardCount}`);
      executed += shardExecuted;
      passed += result.passed;
      runtimeMs += result.ms;
      console.log(`  ✓ shard ${shardNumber}/${shardCount}: ${result.passed} tests in ${result.ms}ms`);
    }
    if (!only && !requestedShard) assert(executed === expectedTotal, 'Firefox shards executed every registered browser test once', `${executed}/${expectedTotal}`);
    console.log(`  ✓ ${passed} browser tests passed under Gecko in ${runtimeMs}ms`);
    console.log('Firefox Store smoke + Gecko suite OK');
  } catch (error) {
    try {
      if (!driver) throw new Error('Firefox driver did not start');
      const screenshot = await driver.screenshot();
      writeFileSync(join(OUTPUT, 'failure.png'), Buffer.from(screenshot, 'base64'));
    } catch { /* the browser may already be gone */ }
    const geckoLog = driver?.logs.join('') ?? '';
    if (geckoLog) writeFileSync(join(OUTPUT, 'geckodriver.log'), geckoLog);
    throw error;
  } finally {
    await driver?.close();
    await providerServer?.close();
    await server.close();
  }
};

main().catch((error) => {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  console.error(`${name}: ${message}`);
  if (error?.stack && error.stack !== `${name}: ${message}`) console.error(error.stack);
  process.exit(1);
});
