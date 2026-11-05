// An Emscripten-shaped App reads its own files through the in-realm file
// server, inside the real manifest sandbox. Run with:
// bun run e2e:verify --only=app-file-server
import { createServer } from 'node:http';
import { attach, evalIn, openExtPage, rpc, sseText, sseToolCall, waitFor } from './e2e-harness.mjs';

// A module that exports answer() and returns 42, and a small data package.
const GAME_WASM = 'AGFzbQEAAAABBQFgAAF/AwIBAAcKAQZhbnN3ZXIAAAoGAQQAQSoL';
const GAME_DATA = 'AAEC+v8=';
const GAME_DATA_BYTES = [0, 1, 2, 250, 255];
// A BOM proves the server sends the stored bytes, not a decoded string.
const NOTES_BYTES = [239, 187, 191, 104, 105];

let probeUrl = '';

// The loader does what Emscripten glue does: it streams the module from a
// relative fetch and reads the data package through XHR arraybuffer.
const loaderSource = (probe) => `(async () => {
  const report = {};
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('game.wasm'));
    report.answer = instance.exports.answer();
    const base = location.href.slice(0, location.href.lastIndexOf('/') + 1);
    const absolute = await fetch(base + 'game.wasm?v=1');
    report.absolute = [absolute.status, absolute.headers.get('content-type'),
      absolute.headers.get('content-length'), (await absolute.arrayBuffer()).byteLength];
    report.data = await new Promise((resolve) => {
      const request = new XMLHttpRequest();
      let progress = null;
      request.open('GET', 'game.data', true);
      request.responseType = 'arraybuffer';
      request.onprogress = (event) => { progress = [event.loaded, event.total]; };
      request.onload = () => resolve({
        status: request.status, progress, bytes: Array.from(new Uint8Array(request.response)),
      });
      request.onerror = () => resolve({ status: 'error' });
      request.send(null);
    });
    report.notes = Array.from(new Uint8Array(await (await fetch('notes.txt')).arrayBuffer()));
    report.packaged = [
      (await fetch('/manifest.json')).status,
      (await fetch('../../background/vault-kernel.js')).status,
    ];
    report.remoteFetch = await fetch(${JSON.stringify(`${probe}/file-server-fetch`)})
      .then(() => 'reached', (error) => error.name);
    report.remoteXhr = await new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open('GET', ${JSON.stringify(`${probe}/file-server-xhr`)});
      request.onload = () => resolve('reached');
      request.onerror = () => resolve('error');
      request.send();
    });
  } catch (error) {
    report.error = String(error);
  }
  parent.postMessage({ type: 'e2e-file-server', report }, '*');
})();`;

export const APP_FILE_SERVER_STATE = {
  name: 'app-file-server', kind: 'functional', phase: 'post-unlock',
  responder: (callIndex) => ({
    sse: callIndex === 0 ? sseToolCall('sandbox_create', {
      kind: 'app', name: 'File server game', files: {
        'index.html': '<!doctype html><html><head><title>Game</title></head><body><canvas></canvas><script src=loader.js></script></body></html>',
        'loader.js': loaderSource(probeUrl),
        'notes.txt': '﻿hi',
        'game.wasm': { base64: GAME_WASM },
        'game.data': { base64: GAME_DATA },
      },
    }) : sseText('FILE-SERVER-APP-READY'),
  }),
  async run(ctx, rec) {
    const probeHits = [];
    let probeConnections = 0;
    const server = createServer((request, response) => {
      probeHits.push(request.url ?? '');
      response.writeHead(204);
      response.end();
    });
    server.on('connection', () => { probeConnections += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    probeUrl = `http://127.0.0.1:${/** @type {{ port: number }} */ (server.address()).port}`;
    let page;
    let appId = null;
    try {
      const previous = new Set((await fetch(`http://127.0.0.1:${ctx.port}/json/list`)
        .then((reply) => reply.json())).map((target) => target.id));
      const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create the file server game App.' });
      rec.check('fixture App creation accepted', sent?.ok === true, JSON.stringify(sent));
      const target = await waitFor(async () => {
        const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json());
        return targets.find((candidate) => candidate.type === 'page' && !previous.has(candidate.id)
          && candidate.url?.includes('/engine-tabs/app-tab/index.html#'));
      }, { budgetMs: 30_000, pollMs: 100 });
      if (!target) throw new Error('the fixture App tab did not open');
      appId = new URL(target.url).hash.slice(1).split('?')[0];
      page = await attach(target.webSocketDebuggerUrl);
      await page.send('Page.enable');
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        if (window === top) {
          globalThis.__fileServerReports = [];
          globalThis.__fileServerPolicies = [];
          addEventListener('message', (event) => {
            if (event.source !== document.getElementById('app-frame')?.contentWindow) return;
            if (event.data?.type === 'e2e-file-server') globalThis.__fileServerReports.push(event.data.report);
            if (event.data?.type === 'app-policy-blocked') globalThis.__fileServerPolicies.push(event.data.directive);
          });
        }
      ` });
      // why: the target can be listed before its document is active, and a
      // reload then fails in CDP. Wait for that same document first.
      await waitFor(async () => {
        try {
          return await evalIn(page, `location.href === ${JSON.stringify(target.url)} && document.readyState === 'complete'`);
        } catch { return false; }
      }, { budgetMs: 15_000, pollMs: 100 });
      await page.send('Page.reload', { ignoreCache: true });
      const report = await waitFor(() => evalIn(page, 'globalThis.__fileServerReports?.[0] ?? null')
        .catch(() => null), { budgetMs: 20_000, pollMs: 100 });
      rec.check('the Emscripten-shaped App ran in the manifest sandbox', !!report && !report.error,
        JSON.stringify(report));
      rec.check('instantiateStreaming(fetch(relative .wasm)) ran the App module', report?.answer === 42,
        JSON.stringify(report?.answer));
      rec.check('an absolute runner-base URL with a query gets the file, its type, and its length',
        JSON.stringify(report?.absolute) === JSON.stringify([200, 'application/wasm', '39', 39]),
        JSON.stringify(report?.absolute));
      rec.check('XHR arraybuffer returned the exact .data bytes with progress',
        report?.data?.status === 200
          && JSON.stringify(report.data.bytes) === JSON.stringify(GAME_DATA_BYTES)
          && JSON.stringify(report.data.progress) === JSON.stringify([5, 5]),
        JSON.stringify(report?.data));
      rec.check('a text file arrives as its stored bytes', JSON.stringify(report?.notes) === JSON.stringify(NOTES_BYTES),
        JSON.stringify(report?.notes));
      rec.check('packaged extension files get a 404 through the file server',
        JSON.stringify(report?.packaged) === '[404,404]', JSON.stringify(report?.packaged));
      rec.check('remote fetch and XHR still fail and make zero connections',
        report?.remoteFetch === 'TypeError' && report?.remoteXhr === 'error'
          && probeHits.length === 0 && probeConnections === 0,
        JSON.stringify({ fetch: report?.remoteFetch, xhr: report?.remoteXhr, hits: probeHits,
          connections: probeConnections,
          policies: await evalIn(page, 'globalThis.__fileServerPolicies ?? []').catch(() => null) }));
    } finally {
      try { page?.close(); } catch { /* already closed */ }
      // why: later Library captures must not list this fixture. Only Home may delete an App.
      if (appId) {
        const home = await openExtPage(ctx, 'home/home.html');
        try {
          await waitFor(() => evalIn(home, `document.readyState === 'complete'`).catch(() => false),
            { budgetMs: 10_000, pollMs: 100 });
          const deleted = await evalIn(home,
            `chrome.runtime.sendMessage({ type: 'apps/delete', appId: ${JSON.stringify(appId)} })`, true)
            .catch(() => null);
          rec.check('fixture App removed', deleted?.ok === true, JSON.stringify(deleted));
        } finally { home.close(); }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
