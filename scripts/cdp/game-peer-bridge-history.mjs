import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameNetPageScript } from '../../extension/engine-tabs/game-tab/game-net-page.js';
import { attach, evalIn, waitFor } from './e2e-harness.mjs';

const profile = await mkdtemp(join(tmpdir(), 'peerd-history-'));
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('<!doctype html><title>History check</title>', {
    headers: { 'Content-Type': 'text/html' },
  }),
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = Bun.spawn([process.env.CHROME_PATH ?? '/usr/bin/chromium', '--no-sandbox', '--no-first-run',
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
{ stdout: 'ignore', stderr: 'ignore' });
try {
  const port = await waitFor(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8')
    .then((data) => data.split('\n')[0]).catch(() => null));
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const token = crypto.randomUUID();
  const calls = [];
  const tab = await attach(targets.find((target) => target.type === 'page').webSocketDebuggerUrl,
    (method, { payload } = {}) => {
      if (method === 'Runtime.bindingCalled' && typeof payload === 'string' && payload.startsWith(token)) {
        calls.push(JSON.parse(payload.slice(token.length)));
      }
    });
  try {
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: gameNetPageScript(origin, token) });
    await tab.send('Runtime.addBinding', { name: '__peerdNetRaw' });
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      (() => {
        const id = crypto.randomUUID();
        globalThis.historyCheck = { id, api: typeof globalThis.peerd?.net };
        addEventListener('pageshow', (event) => {
          globalThis.historyCheck.persisted = event.persisted;
          globalThis.historyCheck.rawOnShow = typeof globalThis.__peerdNetRaw;
        }, { capture: true });
      })();
    ` });
    const read = () => evalIn(tab, `globalThis.historyCheck?.rawOnShow && {
      ...globalThis.historyCheck, path: location.pathname,
      rawNow: typeof globalThis.__peerdNetRaw
    }`).catch(() => null);
    await tab.send('Page.navigate', { url: `${origin}/one` });
    const initial = await waitFor(read);
    await tab.send('Page.navigate', { url: `${origin}/two` });
    await waitFor(async () => (await read())?.path === '/two');
    await evalIn(tab, 'history.back()');
    const restored = await waitFor(async () => {
      const current = await read();
      return current?.path === '/one' ? current : null;
    });
    assert.equal(initial.api, 'object');
    assert.equal(calls.length, 3);
    assert.equal(calls[0][1], 'hello');
    assert.equal(calls[2][1], 'hello');
    assert.equal(calls[2][0], calls[0][0]);
    assert.equal(calls[2][3], true);
    assert.equal(restored.id, initial.id);
    assert.equal(restored.persisted, true);
    assert.equal(restored.rawOnShow, 'undefined');
    assert.equal(restored.rawNow, 'undefined');
    await evalIn(tab, 'void peerd.net.join()');
    assert.ok(await waitFor(() => calls.find(([id, op]) => id === calls[0][0] && op === 'join')));
    console.log('Chromium restored the same document. The raw binding stayed hidden and the API sent hello and join.');
  } finally {
    tab.close();
  }
} finally {
  browser.kill();
  await browser.exited;
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
