#!/usr/bin/env node
// Opt-in Ollama-compatible development bridge. No remote fallback, telemetry,
// browser control, or credentials; page actions still execute inside Peerd.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  BRIDGE_MODEL, BRIDGE_TRANSPORT_CONTEXT, HELPER_CONTEXT,
  createBrowserDecisionResponder, makeLocalClients, assistantSse,
} from './model-bridge.mjs';

export function createBridgeServer({
  port = 11434, extensionOrigins = [], helperModel = 'qwen3.5:2b-q4_K_M',
  clients, decisionModel = 'decider-4b', emit = () => {},
} = {}) {
  if (helperModel === BRIDGE_MODEL) throw new Error('helper model and bridge model must differ');
  const origins = new Set(extensionOrigins);
  if ([...origins].some(origin => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
    throw new Error('extension origins must be exact chrome-extension://<id> origins');
  }
  const respond = createBrowserDecisionResponder({ ...clients, decisionModel, emit });
  let busy = false;
  const server = createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const livePort = server.address()?.port ?? port;
    const hostCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length;
    if (hostCount !== 1 || ![ `127.0.0.1:${livePort}`, `localhost:${livePort}` ].includes(request.headers.host)) {
      return reply(403, { error: 'invalid Host' });
    }
    const origin = request.headers.origin;
    if (Object.hasOwn(request.headers, 'origin') && !origins.has(origin)) return reply(403, { error: 'origin not allowed' });
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (!origin) return reply(403, { error: 'origin required' });
      response.setHeader('access-control-allow-methods', 'POST, GET');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.writeHead(204); response.end(); return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      return reply(200, { ready: true, mode: 'local-only-experimental', inferenceProbed: false });
    }
    if (request.method === 'GET' && request.url === '/api/tags') {
      return reply(200, { models: [BRIDGE_MODEL, helperModel].map(name => ({ name, model: name })) });
    }
    if (request.method !== 'POST' || !['/v1/chat/completions', '/api/show'].includes(request.url)) {
      return reply(404, { error: 'unknown endpoint' });
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply(415, { error: 'JSON required' });
    }
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    let holdsSlot = false;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1_000_000) return reply(413, { error: 'request exceeds budget' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (![BRIDGE_MODEL, helperModel].includes(body?.model)) {
        return reply(404, { error: 'model not configured' });
      }
      if (request.url === '/api/show') {
        return reply(200, { model_info: { 'peerd.context_length': body.model === BRIDGE_MODEL
          ? BRIDGE_TRANSPORT_CONTEXT : HELPER_CONTEXT }, capabilities: ['tools'],
        ...(body.model === helperModel ? { parameters: `num_ctx ${HELPER_CONTEXT}` } : {}) });
      }
      if (busy) return reply(429, { error: 'local inference busy; run one browser task at a time' });
      busy = true; holdsSlot = true;
      const message = body.model === helperModel
        ? await clients.chat(body, controller.signal)
        : await respond(body, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.end(assistantSse(message));
      } else reply(200, { choices: [{ index: 0, message,
        finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] });
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent) {
        emit({ type: 'request_failed', code: error instanceof SyntaxError ? 'invalid_json' : 'local_inference_or_protocol_error' });
        reply(error instanceof SyntaxError ? 400 : 502, {
          error: error instanceof SyntaxError ? 'invalid JSON request'
            : 'local inference or browser protocol failed; no browser action was returned',
        });
      }
    } finally { if (holdsSlot) busy = false; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  return server;
}

function main() {
  const options = Object.fromEntries(process.argv.slice(2).map(argument => {
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error('use --name=value arguments; see scripts/local-browser/README.md');
    return [match[1], match[2]];
  }));
  const allowed = ['port', 'extension-origin', 'helper-origin', 'helper-model', 'decision-origin', 'decision-model'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`unknown option: ${key}`);
  const port = Number(options.port ?? 11434);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port');
  const helperModel = options['helper-model'] ?? 'qwen3.5:2b-q4_K_M';
  const clients = makeLocalClients({
    decisionOrigin: options['decision-origin'], helperOrigin: options['helper-origin'], helperModel,
  });
  const server = createBridgeServer({
    port, helperModel, clients, decisionModel: options['decision-model'] ?? 'decider-4b',
    extensionOrigins: options['extension-origin'] ? [options['extension-origin']] : [],
    // Only operation metadata/timings are logged; never goals, DOM, or typed text.
    emit: event => console.log(JSON.stringify(event)),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local browser bridge: http://127.0.0.1:${port}; model=${BRIDGE_MODEL}`);
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
