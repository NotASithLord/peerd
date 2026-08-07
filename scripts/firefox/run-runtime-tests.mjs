#!/usr/bin/env bun
// Firefox runtime gate, first slice.
//
// This installs the real staged Store XPI as a temporary add-on, boots its
// background page and primary UI pages, and exercises the real Firefox
// scripting fallback. It then runs the shared browser suite from source under
// Gecko. That second signal is web-platform coverage, not packaged-XPI parity.
// Chrome remains the only pixel-baseline authority; Firefox screenshots are
// diagnostic.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { startGeckodriver, waitFor } from './webdriver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTENSION = join(ROOT, 'extension');
const OUTPUT = join(ROOT, 'artifacts', 'firefox-runtime');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const TEST_UUID = '7d12f198-31fc-4e95-9184-e954123981a6';
const EXTENSION_ORIGIN = `moz-extension://${TEST_UUID}`;
const FIXTURE_PATH = '/__firefox-runtime-fixture';
const MODULE_IMPORT_PROBE_PATH = '/__firefox-module-import-probe.js';
const RESULT_BUDGET_MS = 180_000;
const PROVIDER_PATH = '/v1/messages';
const PASSPHRASE_CANARY = 'firefox-runtime-passphrase-canary-7d12f198';
const PROVIDER_KEY_CANARY = 'sk-ant-firefox-provider-canary-7d12f198';
const ACTOR_REPLY_CANARY = 'firefox-bound-actor-reply-7d12f198';
const FINAL_REPLY_CANARY = 'firefox-parent-final-reply-7d12f198';
const ACTOR_PROMPT = 'Return the Firefox bound actor proof token.';

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
      response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Firefox runtime fixture</title>
<body>
  <button id="firefox-action" type="button">Firefox parity action</button>
  <label for="firefox-input">Firefox parity input</label>
  <input id="firefox-input">
  <output id="firefox-status" role="status">ready</output>
  <script>
    document.getElementById('firefox-action').addEventListener('click', () => {
      document.body.dataset.clicked = 'yes';
    });
    document.getElementById('firefox-input').addEventListener('input', (event) => {
      document.getElementById('firefox-status').textContent = event.target.value;
    });
  </script>
</body></html>`);
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

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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

const delegationResponse = () => {
  const input = JSON.stringify({ to: 'web', message: ACTOR_PROMPT, await: true });
  return [
    sse('message_start', { type: 'message_start' }),
    sse('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'firefox-actor-tool', name: 'message_actor', input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: input },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
};

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
      records.push({ method: request.method, url: request.url, headers: { ...request.headers }, body });
      const payload = body.includes('<actor_agent>')
        ? textResponse(ACTOR_REPLY_CANARY)
        : body.includes(ACTOR_REPLY_CANARY)
          ? textResponse(FINAL_REPLY_CANARY)
          : delegationResponse();
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(payload);
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
  const proxyServer = createServer((_request, response) => {
    response.writeHead(405);
    response.end('CONNECT required');
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
    port, records, connections, tlsErrors,
    close: async () => {
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
  assert(actorProof.bundle.contextSnapshots.some((snapshot) => snapshot.label === 'actor web (in-SW)'),
    'the installed Firefox actor uses the in-service-worker route');
  assert(!actorProof.audit.some((entry) => entry.type === 'actor_ran_offscreen'),
    'Firefox does not claim offscreen heap isolation');
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

const main = async () => {
  if (!firefoxBinary) throw new Error('Firefox not found. Set FIREFOX_PATH.');
  if (!geckodriverBinary) throw new Error('geckodriver not found. Set GECKODRIVER_PATH.');
  mkdirSync(OUTPUT, { recursive: true });
  for (const diagnostic of ['failure.png', 'geckodriver.log', 'sidepanel.png']) {
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
        sslProxy: `127.0.0.1:${providerServer.port}`,
        noProxy: ['localhost', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
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

    await runModuleImportPolicySmoke(driver, server);
    await runBoundActorSmoke(driver, providerServer);

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
          for (let attempt = 0; attempt < 200; attempt += 1) {
            try {
              const [probe] = await browser.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.readyState === 'complete'
                  && document.getElementById('firefox-action') !== null,
              });
              if (probe?.result === true) {
                fixtureReady = true;
                break;
              }
            } catch { /* Firefox may reject injection while navigation is in flight */ }
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          }
          if (!fixtureReady) throw new Error('fixture tab did not become scriptable');
          const snapshot = await captureSnapshot(
            { id: tab.id }, { scripting: browser.scripting }, { budget: 4_000 },
          );
          const [typed] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: typeInjected,
            args: ['#firefox-input', 'typed in Firefox', false, null, 1],
          });
          const [clicked] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: clickInjected,
            args: ['#firefox-action', 0, null, 1],
          });
          const [observed] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
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
