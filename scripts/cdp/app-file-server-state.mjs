// An Emscripten-shaped App reads its own files through the in-realm file
// server, inside the real manifest sandbox. It also loads scripts, workers and
// an audio worklet by URL, and the App tab names each failure in plain words.
// Run with: bun run e2e:verify --only=app-file-server
import { createServer } from 'node:http';
import { appProblemNotice } from '../../extension/engine-tabs/app-tab/app-problem.js';
import { attach, evalIn, openExtPage, rpc, sseText, sseToolCall, waitFor } from './e2e-harness.mjs';

// A module that exports answer() and returns 42, and a small data package.
export const GAME_WASM = 'AGFzbQEAAAABBQFgAAF/AwIBAAcKAQZhbnN3ZXIAAAoGAQQAQSoL';
const GAME_DATA = 'AAEC+v8=';
const GAME_DATA_BYTES = [0, 1, 2, 250, 255];
// A BOM proves the server sends the stored bytes, not a decoded string.
const NOTES_BYTES = [239, 187, 191, 104, 105];

let probeUrl = '';

// The loader does what Emscripten glue does: it streams the module from a
// relative fetch and reads the data package through XHR arraybuffer.
const loaderSource = (probe) => `addEventListener('message', (event) => {
  // The test asks the App to post a message again, or to reload its own frame.
  const again = {
    problem: { type: 'app-problem', problem: 'threads' },
    link: { type: 'app-link', href: 'mailto:someone@example.com' },
  }[event.data?.e2e];
  if (again) {
    parent.postMessage(again, '*');
    parent.postMessage({ type: 'e2e-asked' }, '*');
  }
  if (event.data?.e2e === 'reload') location.reload();
});
(async () => {
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
    const loadScript = (set) => new Promise((resolve) => {
      const script = document.createElement('script');
      script.onload = () => resolve('load');
      script.onerror = () => resolve('error');
      set(script);
      document.head.append(script);
    });
    report.scripts = [
      await loadScript((script) => { script.src = 'dynamic.js'; }),
      await loadScript((script) => script.setAttribute('src', './dynamic.js')),
      await loadScript((script) => { script.src = 'missing.js'; }),
      globalThis.dynamicLoads,
    ];
    const ask = (worker) => new Promise((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = () => resolve('error');
      worker.postMessage(21);
    });
    const workerName = ['work', 'er.js'].join('');
    report.workers = [
      await ask(new Worker(workerName)),
      await ask(new Worker(new URL('worker.js', location.href))),
      await ask(new Worker('missing-worker.js')),
    ];
    const levels = await fetch('data/levels.json');
    report.shipped = [levels.status, levels.headers.get('content-type'), await levels.text(),
      await ask(new Worker('data/levels.json'))];
    const audio = new AudioContext();
    await audio.audioWorklet.addModule('processor.js');
    report.worklet = [
      new AudioWorkletNode(audio, 'peerd-e2e') instanceof AudioWorkletNode,
      await audio.audioWorklet.addModule('missing-processor.js').then(() => 'loaded', (error) => error.name),
    ];
    await audio.close();
    report.gamepad = [document.featurePolicy?.allowsFeature('gamepad'), Array.isArray(Array.from(navigator.getGamepads()))];
    localStorage.setItem('best', 7);
    localStorage.level = 2;
    sessionStorage.setItem('run', 1);
    report.storage = [localStorage.getItem('best'), localStorage.level, Object.keys(localStorage).length,
      sessionStorage.length, typeof caches, 'caches' in window,
      (() => { try { indexedDB.open('save'); return 'opened'; } catch (error) { return error.name; } })()];
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
    // Last, because the notice for code that did not load stays in place.
    report.module = await new Promise((resolve) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.textContent = "import './dynamic.js';";
      script.onload = () => resolve('load');
      script.onerror = () => resolve('error');
      document.head.append(script);
    });
    // A notice that does not stay must not replace or close that reason.
    parent.postMessage({ type: 'app-link', href: 'mailto:someone@example.com' }, '*');
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
        'index.html': '<!doctype html><html><head><title>Game</title></head><body><canvas></canvas>'
          + '<script>document.cookie;</script><script>new SharedArrayBuffer(8);</script>'
          + '<script src=loader.js></script></body></html>',
        'loader.js': loaderSource(probeUrl),
        'dynamic.js': 'globalThis.dynamicLoads = (globalThis.dynamicLoads ?? 0) + 1;',
        'worker.js': 'onmessage = (event) => postMessage(event.data * 2);',
        'processor.js': "registerProcessor('peerd-e2e', class extends AudioWorkletProcessor { process() { return true; } });",
        'notes.txt': '\uFEFFhi',
        'data/levels.json': '{"levels":[1,2]}',
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
          globalThis.__fileServerNotices = [];
          globalThis.__fileServerAsked = 0;
          new MutationObserver((records) => {
            // Each time the App tab shows a notice, it adds one span to the element.
            for (const node of records.filter((record) => record.target.id === 'app-security-notice')
              .flatMap((record) => [...record.addedNodes]).filter((node) => node.localName === 'span')) {
              globalThis.__fileServerNotices.push({
                text: node.firstChild?.textContent, summary: node.querySelector('summary')?.textContent ?? '',
              });
            }
          }).observe(document, { childList: true, subtree: true, characterData: true });
          addEventListener('message', (event) => {
            if (event.source !== document.getElementById('app-frame')?.contentWindow) return;
            if (event.data?.type === 'e2e-file-server') globalThis.__fileServerReports.push(event.data.report);
            if (event.data?.type === 'app-policy-blocked') globalThis.__fileServerPolicies.push(event.data.directive);
            if (event.data?.type === 'e2e-asked') globalThis.__fileServerAsked += 1;
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
      rec.check('a dynamic script loads an App file by src and setAttribute, and a missing one fails',
        JSON.stringify(report?.scripts) === '["load","load","error",2]', JSON.stringify(report?.scripts));
      rec.check('a Worker named by a variable or a URL runs the App file, and a missing one fails',
        JSON.stringify(report?.workers) === '[42,42,"error"]', JSON.stringify(report?.workers));
      rec.check('a shipped data/<name>.json file reads by URL, and never runs as a Worker',
        JSON.stringify(report?.shipped) === JSON.stringify([200, 'application/json', '{"levels":[1,2]}', 'error']),
        JSON.stringify(report?.shipped));
      rec.check('an audio worklet loads the App file, and a missing one fails',
        JSON.stringify(report?.worklet) === '[true,"AbortError"]', JSON.stringify(report?.worklet));
      rec.check('the App frame allows gamepads', JSON.stringify(report?.gamepad) === '[true,true]',
        JSON.stringify(report?.gamepad));
      rec.check('localStorage and sessionStorage hold values in page memory, caches is absent, and indexedDB refuses open()',
        JSON.stringify(report?.storage) === JSON.stringify(['7', '2', 2, 1, 'undefined', false, 'SecurityError']),
        JSON.stringify(report?.storage));
      const expectedNotices = ['missing-file', 'feature', 'threads']
        .map((problem) => appProblemNotice({ type: 'app-problem', problem })?.text)
        .concat(appProblemNotice({ type: 'app-policy-blocked', directive: 'connect-src' })?.text);
      const notices = await waitFor(async () => {
        const seen = await evalIn(page, 'globalThis.__fileServerNotices ?? []').catch(() => []);
        return expectedNotices.every((text) => seen.some((notice) => notice.text === text)) ? seen : null;
      }, { budgetMs: 10_000, pollMs: 100 }) ?? await evalIn(page, 'globalThis.__fileServerNotices ?? []').catch(() => null);
      rec.check('the App tab names a missing file, a refused feature, threads, and an offline block in plain words',
        expectedNotices.every((text) => notices?.some((notice) => notice.text === text
          && notice.summary === 'Technical details'))
          && notices.every((notice) => !/connect-src|Blocked |Bundle /.test(notice.text)),
        JSON.stringify(notices));
      const stays = appProblemNotice({ type: 'app-problem', problem: 'modules' })?.text;
      const reason = () => evalIn(page, `(() => {
        const [notice, other] = ['app-problem-notice', 'app-security-notice'].map((id) => document.getElementById(id));
        return {
          text: notice?.querySelector('span')?.firstChild?.textContent, timer: notice?.dataset.timer,
          other: other?.querySelector('span')?.firstChild?.textContent, mode: document.body.className,
        };
      })()`).catch(() => null);
      const link = 'Only confirmed HTTP(S) links can leave an App.';
      const last = await waitFor(async () => {
        const shown = await reason();
        return shown?.text === stays && shown.other === link ? shown : null;
      }, { budgetMs: 10_000, pollMs: 100 }) ?? await reason();
      rec.check('a module import that failed gets a reason that stays in the App tab, and a later notice does not replace it',
        report?.module === 'error' && last?.text === stays && last.timer === '' && last.other === link,
        JSON.stringify({ module: report?.module, last }));
      rec.check('packaged extension files get a 404 through the file server',
        JSON.stringify(report?.packaged) === '[404,404]', JSON.stringify(report?.packaged));
      rec.check('remote fetch and XHR still fail and make zero connections',
        report?.remoteFetch === 'TypeError' && report?.remoteXhr === 'error'
          && probeHits.length === 0 && probeConnections === 0,
        JSON.stringify({ fetch: report?.remoteFetch, xhr: report?.remoteXhr, hits: probeHits,
          connections: probeConnections,
          policies: await evalIn(page, 'globalThis.__fileServerPolicies ?? []').catch(() => null) }));
      const tell = (what) => evalIn(page,
        `document.getElementById('app-frame').contentWindow.postMessage({ e2e: ${JSON.stringify(what)} }, '*')`);
      // The App posts one message, and the App tab has it before this returns.
      const ask = async (what) => {
        const asked = await evalIn(page, 'globalThis.__fileServerAsked');
        await tell(what);
        await waitFor(() => evalIn(page, `globalThis.__fileServerAsked > ${asked}`).catch(() => false),
          { budgetMs: 5000, pollMs: 50 });
      };
      const focus = (selector) => evalIn(page, `document.querySelector(${JSON.stringify(selector)})?.focus()`);
      const press = (selector) => evalIn(page, `document.querySelector(${JSON.stringify(selector)})?.click()`);
      await focus('#mode-toggle');
      await ask('link');
      await focus('#app-problem-notice button');
      await ask('link');
      await press('#app-problem-notice button');
      const focused = await evalIn(page, 'document.activeElement?.id || document.activeElement?.localName');
      rec.check('Dismiss gives the focus back to the control that had it, also when a second notice came in between',
        focused === 'mode-toggle' && (await reason())?.text === undefined, JSON.stringify(focused));
      const threads = appProblemNotice({ type: 'app-problem', problem: 'threads' })?.text;
      const shows = async () => (await evalIn(page, 'globalThis.__fileServerNotices'))
        .filter((notice) => notice.text === threads).length;
      const before = await shows();
      const first = await waitFor(async () => {
        await ask('problem');
        return await shows() > before;
      }, { budgetMs: 10_000, pollMs: 250 });
      await evalIn(page, `globalThis.__fileServerRepeat = document.getElementById('app-security-notice')`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await ask('problem');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const onScreen = [await shows(), await evalIn(page,
        `globalThis.__fileServerRepeat === document.getElementById('app-security-notice')`)];
      await press('#app-security-notice button');
      await ask('problem');
      const dismissed = [await shows(), (await reason())?.other];
      rec.check('the same App problem, posted again, keeps its one notice on screen, and does not come back at once after Dismiss',
        first === true && onScreen[0] === before + 1 && onScreen[1] === true
          && dismissed[0] === before + 1 && dismissed[1] === undefined,
        JSON.stringify({ before, first, onScreen, dismissed }));
      await tell('reload');
      const second = await waitFor(() => evalIn(page, 'globalThis.__fileServerReports?.[1] ?? null')
        .catch(() => null), { budgetMs: 40_000, pollMs: 100 });
      const reloaded = await waitFor(async () => {
        const shown = await reason();
        return shown?.other === link ? shown : null;
      }, { budgetMs: 10_000, pollMs: 100 }) ?? await reason();
      rec.check('an App that reloads its own frame does not get the dismissed reason again',
        second?.module === 'error' && reloaded?.other === link && reloaded.text === undefined,
        JSON.stringify({ module: second?.module, error: second?.error, reloaded }));
      // Last, because Edit ends this load of the App.
      await evalIn(page, `document.getElementById('mode-toggle').click()`);
      const edited = await waitFor(async () => {
        const shown = await reason();
        return shown?.mode.includes('mode-edit') && !!(await evalIn(page,
          `!!document.querySelector('#editor-panel:not([hidden]) .cm-content')`).catch(() => false)) ? shown : null;
      }, { budgetMs: 10_000, pollMs: 100 }) ?? await reason();
      await evalIn(page, `document.getElementById('mode-toggle').click()`);
      const again = await waitFor(async () => {
        const shown = await reason();
        return shown?.mode.includes('mode-render') && shown.text === stays ? shown : null;
      }, { budgetMs: 20_000, pollMs: 100 }) ?? await reason();
      rec.check('Edit ends the reason of the old load, and the next load shows its own',
        edited?.mode.includes('mode-edit') && edited.text === undefined && again?.text === stays && again.timer === '',
        JSON.stringify({ edited, again }));
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
