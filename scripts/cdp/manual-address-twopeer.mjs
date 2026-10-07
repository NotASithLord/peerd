// Real Home → SW → offscreen → native WebRTC manual-address acceptance.
// Only the rendezvous service is redirected to loopback. No product bytes,
// route replies, signatures, storage writes or UI components are replaced.
import { createServer as httpServer } from 'node:http';
import { createServer as tlsServer } from 'node:tls';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { launchPeerd, attach, evalIn, rpc, unlockAndReady, waitFor, capturePage } from './e2e-harness.mjs';
import { digestTree, PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY } from './passkey-signup-lane.mjs';
import { GIT_FIXTURE_TLS_KEY, GIT_FIXTURE_TLS_CERT, GIT_FIXTURE_SPKI_SHA256_BASE64 } from '../acceptance/git-smart-http-fixture.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(repo, 'artifacts/manual-address-twopeer');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'peerd-manual-address-'));
const sockets = new Set(), servers = [], checks = [];
let ctx, publisher, signaling, stage = 'starting', failed = false, tunnels = 0;
const evidence = { scope: 'Actual packaged Preview Home, custody routes, storage and native loopback WebRTC. Open acceptance proves navigation to the installed App tab; iframe execution and public WAN are separate gates.' };
const report = () => writeFileSync(join(output, 'result.json'), JSON.stringify({ ok: !failed && stage === 'complete', stage, checks, evidence }, null, 2));
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); report(); if (!ok) throw new Error(name); };
const bounded = async (name, operation, ms = 20_000) => {
  stage = name; report(); let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const watchdog = setTimeout(() => { failed = true; evidence.error = `whole-run deadline at ${stage}`; report(); process.exit(1); }, 420_000);
const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
const listen = async server => { servers.push(server); server.on('connection', track); await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); return server.address().port; };
const bridge = (a, b) => { a.on('error', () => b.destroy()); b.on('error', () => a.destroy()); a.on('close', () => b.destroy()); b.on('close', () => a.destroy()); a.pipe(b); b.pipe(a); };
const evaluate = (page, expression) => bounded(stage, () => evalIn(page, expression, true));
// Peer-derived addresses and identities cross CDP as data, never source text.
const invoke = (page, functionDeclaration, values) => bounded(stage, async () => {
  const global = await page.send('Runtime.evaluate', { expression: 'globalThis' });
  const objectId = global.result?.objectId;
  if (!objectId) throw new Error('page global unavailable');
  try {
    const result = await page.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: values.map(value => ({ value })),
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  } finally { await page.send('Runtime.releaseObject', { objectId }); }
});
const call = message => bounded(stage, () => rpc(ctx.page, message));
const until = (name, probe, ms = 30_000) => bounded(name, async () => {
  const result = await waitFor(probe, { budgetMs: ms, pollMs: 100 });
  if (!result) throw new Error(`${name}: condition not reached`);
  return result;
}, ms + 1000);
const click = text => invoke(ctx.page, `function(text) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled);
  if (!button) throw new Error('missing enabled button: ' + text);
  button.click();
  // Each caller awaits its actual outcome. Open can hide Home and suspend RAF.
  return true;
}`, [text]);
const appTabs = () => bounded(stage, async () => (await (await fetch(`http://127.0.0.1:${ctx.port}/json/list`)).json())
  .filter(target => target.type === 'page' && target.url.startsWith(`chrome-extension://${ctx.sw.id}/engine-tabs/app-tab/`)));
const screenshot = name => bounded(`capture ${name}`, async () => writeFileSync(join(output, `${name}.png`), await capturePage(ctx.page)));
// Keep the original failed phase/error: diagnostics must never become a retry
// or foreground a hidden page before its visibility has been recorded.
const failureDiagnostic = async (name, operation) => {
  let timer;
  try { evidence[name] = await Promise.race([operation(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('diagnostic deadline')), 5000);
  })]); }
  catch (error) { evidence[name] = { unavailable: String(error?.message ?? error) }; }
  finally { clearTimeout(timer); report(); }
};
process.on('exit', () => { signaling?.kill('SIGKILL'); for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); rmSync(temp, { recursive: true, force: true }); });

try {
  signaling = spawn(process.execPath, [join(repo, 'signaling-node/bun-server.mjs')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const signalPort = await bounded('local signaling', () => new Promise((yes, no) => {
    let out = '';
    signaling.stdout.on('data', chunk => { out = (out + String(chunk)).slice(-4096); const match = out.match(/ws:\/\/localhost:(\d+)\/rendezvous/); if (match) yes(Number(match[1])); });
    signaling.once('exit', () => no(new Error('signaling exited')));
  }), 10_000);
  const tlsPort = await listen(tlsServer({ key: GIT_FIXTURE_TLS_KEY, cert: GIT_FIXTURE_TLS_CERT }, socket => bridge(socket, track(connect(signalPort, '127.0.0.1')))));
  const proxy = httpServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connect', (req, client, head) => {
    if (req.url !== 'bootstrap.peerd.ai:443' || req.headers['proxy-authorization']) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    tunnels++;
    const target = track(connect(tlsPort, '127.0.0.1'));
    target.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); bridge(client, target); });
    target.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  const ext = join(repo, 'extension');
  const httpPort = await listen(httpServer((req, res) => {
    const path = resolve(ext, '.' + new URL(req.url, 'http://localhost').pathname);
    if (path === ext) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Manual address publisher</title>'); return; }
    if (!path.startsWith(ext + sep)) { res.writeHead(403); res.end(); return; }
    try { const bytes = readFileSync(path); res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'application/octet-stream' }); res.end(bytes); }
    catch { res.writeHead(404); res.end(); }
  }));
  await bounded('package Preview', () => packageArtifact({ channel: 'preview', browser: 'chrome', version: JSON.parse(readFileSync(join(repo, 'package.json'))).version, sign: false, verify: true, sourceRoot: repo, artifactRoot: join(temp, 'package') }), 60_000);
  const tree = join(temp, 'package/staging/preview-chrome');
  const originalDigest = await digestTree(tree);
  ctx = await bounded('launch actual Home', () => launchPeerd({ extensionDir: tree, panelPath: 'home/home.html', expectedBackgroundEntry: PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY,
    interceptModel: false, enforceWebSecurity: true, webRtcLoopbackAcceptance: true,
    proxyServer: { url: `http://127.0.0.1:${proxyPort}`, certificateSpkiSha256: GIT_FIXTURE_SPKI_SHA256_BASE64 } }), 45_000);
  await bounded('initialize vault', () => unlockAndReady(ctx.page), 160_000);
  await bounded('Home viewport', () => ctx.page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false }));
  // Completing the profile does not answer network consent: Home deliberately
  // withholds its navigation until this separate real user choice is recorded.
  await until('onboarding network choice visible', () => evalIn(ctx.page, `!!document.querySelector('[data-network-choice="skip"]:not(:disabled)')`));
  await click('Not now');
  const declined = await until('onboarding off choice persisted', async () => {
    const result = await rpc(ctx.page, { type: 'state/get' });
    const settings = result?.state?.settings;
    return settings?.dwebChoiceMade === true && settings.dwebEnabled === false ? settings : null;
  });
  check('onboarding Not now records consent without connecting', declined.dwebEnabled === false && tunnels === 0);
  await until('Home navigation ready', () => evalIn(ctx.page, `!!document.querySelector('[data-home-view="discover"]')`));
  await evaluate(ctx.page, `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discover'); if (!b) throw new Error('Discover navigation missing'); b.click(); })()`);
  await until('network choice visible', () => evalIn(ctx.page, `!!document.querySelector('[data-network-choice="enable"]')`));
  check('fresh Home remains network-off before explicit choice', (await call({ type: 'state/get' }))?.state?.settings?.dwebEnabled === false && tunnels === 0);
  await click('Enable peer network');
  const receiver = await until('actual offscreen network active', async () => { const r = await rpc(ctx.page, { type: 'dweb/distributed/info' }); return r?.running && r.did && r.rendezvous === 'up' ? r : null; });
  evidence.receiverDid = receiver.did;

  const created = await bounded('publisher tab', async () => (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json());
  publisher = await bounded('attach publisher', () => attach(created.webSocketDebuggerUrl));
  await bounded('publisher domains', async () => { await publisher.send('Runtime.enable'); await publisher.send('Page.enable'); await publisher.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` }); });
  await until('publisher document', () => evalIn(publisher, `location.origin === 'http://127.0.0.1:${httpPort}' && document.readyState === 'complete'`));
  const published = await bounded('publish real signed bundle', () => evalIn(publisher, `(async () => {
    const { generateIdentity, joinRoom } = await import('/peerd-distributed/index.js');
    const { createBaseNetwork } = await import('/peerd-distributed/base-network.js');
    const { createChannelClient } = await import('/peerd-distributed/content/transfer.js');
    const { formatDwappUri } = await import('/shared/address/dwapp-uri.js');
    const identity = await generateIdentity();
    const room = await joinRoom({ identity, roomId: 'peerd/base/1', url: 'ws://127.0.0.1:${signalPort}/rendezvous', iceServers: [] });
    const base = await createBaseNetwork({ identity, mesh: room.mesh, meta: () => ({ name: 'manual-address-publisher' }) });
    const html = '<!doctype html><title>Manual address acceptance</title><h1>Explicit Open executed this App</h1>';
    const app = await base.publishApp({ name: 'Manual address acceptance', entry: 'index.html', files: { 'index.html': html } });
    window.manualPublisher = { base, room, app, query: async did => {
      const client = createChannelClient(room.mesh.contentChannel(did), 5000);
      try { return await client.manifest(app.hash); } finally { client.close(); }
    } };
    return { ...app, publisher: identity.did, decodedBytes: new TextEncoder().encode(html).byteLength,
      address: formatDwappUri({ did: identity.did, hash: app.hash }) };
  })()`, true));
  evidence.published = published;
  await until('mutual authenticated link', async () => {
    const status = await rpc(ctx.page, { type: 'dweb/distributed/info' });
    const other = await invoke(publisher, 'function(did) { return window.manualPublisher.room.mesh.hasLink(did); }', [receiver.did]);
    return other && Array.isArray(status.peers) && status.peers.some(peer => peer.did === published.publisher && peer.linked);
  });
  const baselineApps = await call({ type: 'apps/list' });
  check('catalog readable before inspection', baselineApps?.ok && Array.isArray(baselineApps.apps));
  // Home can independently finish its built-in Commons seed. Compare user/peer
  // records so that unrelated first-run housekeeping is not an install receipt.
  const userApps = apps => apps.filter(app => !app.dweb?.seed).map(app => app.id).sort();
  const baselineIds = userApps(baselineApps.apps);
  const baselineTabs = await appTabs();
  evidence.homeBeforeInteraction = await evaluate(ctx.page, `({ visibility: document.visibilityState, focused: document.hasFocus() })`);
  // Opening the publisher tab can background Home. A real user returns to Home
  // before typing; its requestAnimationFrame-driven UI must be visible too.
  await bounded('foreground Home for user input', () => ctx.page.send('Page.bringToFront'));
  await until('Home visible for user input', () => evalIn(ctx.page, `document.visibilityState === 'visible'`));
  await until('manual input visible', () => evalIn(ctx.page, `!!document.querySelector('input[aria-label="App address"]')`));
  await invoke(ctx.page, `function(address) { const input = document.querySelector('input[aria-label="App address"]'); input.value = address; input.dispatchEvent(new Event('input', { bubbles: true })); }`, [published.address]);
  // Input updates Mithril state immediately, but the disabled button changes on
  // the next redraw. Await the actual control, not a guessed frame or delay.
  await until('Inspect enabled for entered address', () => invoke(ctx.page, `function(address) { return document.querySelector('input[aria-label="App address"]').value === address && [...document.querySelectorAll('button')].some(b => b.textContent === 'Inspect App' && !b.disabled); }`, [published.address]));
  await click('Inspect App');
  await until('verified inspection rendered', () => evalIn(ctx.page, `[...document.querySelectorAll('button')].some(b => b.textContent === 'Install and share' && !b.disabled)`));
  const inspection = await evaluate(ctx.page, `document.querySelector('section[aria-label="App address"]').textContent`);
  check('inspection binds exact signer hash and decoded size', inspection.includes(published.publisher) && inspection.includes(published.hash) && inspection.includes(`${published.decodedBytes} bytes in 1 files`), inspection);
  check('inspection does not install a user or peer catalog record', JSON.stringify(userApps((await call({ type: 'apps/list' })).apps)) === JSON.stringify(baselineIds));
  const query = () => invoke(publisher, 'function(did) { return window.manualPublisher.query(did); }', [receiver.did]);
  const before = await query(); evidence.beforeInstallContent = before;
  check('inspection does not seed bytes (explicit negative response)', before?.t === 'NOMANIFEST' && before.hash === published.hash, before);
  check('inspection does not execute an App', (await appTabs()).length === baselineTabs.length);
  await screenshot('inspected');
  await click('Install and share');
  await until('install receipt rendered', () => evalIn(ctx.page, `[...document.querySelectorAll('button')].some(b => b.textContent === 'Open installed App' && !b.disabled)`));
  const catalog = await call({ type: 'apps/list' });
  const installed = catalog.apps.filter(app => app.dweb?.uri === published.uri && app.dweb?.hash === published.hash && app.dweb?.publisher === published.publisher);
  check('one exact installed catalog record', installed.length === 1 && userApps(catalog.apps).length === baselineIds.length + 1, installed);
  evidence.installedAppId = installed[0].id;
  const after = await query();
  check('same content query positively observes installed seed', after?.t === 'MANIFEST' && after.hash === published.hash && after.manifest?.publisher === published.publisher, { type: after?.t, hash: after?.hash });
  check('Install and share does not execute', (await appTabs()).length === baselineTabs.length);
  // Re-entering the exact address clears the previous receipt through the real
  // input handler, so the next Open cannot be satisfied by stale installed DOM.
  await invoke(ctx.page, `function(address) { const input = document.querySelector('input[aria-label="App address"]'); input.value = address; input.dispatchEvent(new Event('input', { bubbles: true })); }`, [published.address]);
  await until('previous inspection cleared', () => evalIn(ctx.page, `[...document.querySelectorAll('button')].some(b => b.textContent === 'Inspect App' && !b.disabled) && ![...document.querySelectorAll('button')].some(b => b.textContent === 'Open installed App' || b.textContent === 'Install and share')`));
  await click('Inspect App');
  await until('reinspection preserves Open', () => evalIn(ctx.page, `[...document.querySelectorAll('button')].some(b => b.textContent === 'Open installed App' && !b.disabled) && ![...document.querySelectorAll('button')].some(b => b.textContent === 'Install and share')`));
  check('reinspection creates no duplicate', (await call({ type: 'apps/list' })).apps.filter(app => app.dweb?.uri === published.uri).length === 1);
  check('no execution before explicit Open', (await appTabs()).length === baselineTabs.length);
  await screenshot('installed-before-open');
  await click('Open installed App');
  const opened = await until('explicit Open creates App tab', async () => { const tabs = await appTabs(); return tabs.length === baselineTabs.length + 1 ? tabs : null; });
  check('explicit Open targets installed App', opened.some(tab => tab.url.includes(installed[0].id)), opened.map(tab => tab.url));
  check('packaged product bytes unchanged', (await digestTree(tree)).sha256 === originalDigest.sha256);
  evidence.packageDigest = originalDigest;
  stage = 'checks-complete'; report();
} catch (error) {
  failed = true; evidence.error = String(error?.stack ?? error); evidence.homeEvents = ctx?.page?.events?.slice(-30); evidence.publisherEvents = publisher?.events?.slice(-30); report(); console.error(evidence.error);
  if (ctx?.page) {
    await failureDiagnostic('failureDom', () => evalIn(ctx.page, `(() => {
      const section = document.querySelector('section[aria-label="App address"]');
      return { visibility: document.visibilityState, focused: document.hasFocus(), readyState: document.readyState,
        inputCount: document.querySelectorAll('input[aria-label="App address"]').length,
        inputs: [...document.querySelectorAll('input[aria-label="App address"]')].slice(0, 3).map(input => ({ value: input.value.slice(0, 4096), disabled: input.disabled })),
        buttons: [...(section || document).querySelectorAll('button')].slice(0, 24).map(button => ({ text: button.textContent.slice(0, 120), disabled: button.disabled })),
        sectionText: section?.textContent.slice(0, 3000) ?? null };
    })()`));
    await failureDiagnostic('failureNetworkChoice', async () => {
      const result = await rpc(ctx.page, { type: 'state/get' });
      return { ok: result?.ok, enabled: result?.state?.settings?.dwebEnabled,
        choiceMade: result?.state?.settings?.dwebChoiceMade, locked: result?.state?.vault?.locked };
    });
    await failureDiagnostic('failureScreenshot', async () => {
      const result = await ctx.page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, 'failed-home.png'), Buffer.from(result.data, 'base64'));
      return 'failed-home.png';
    });
  }
} finally {
  let cleanupTimer;
  try {
    publisher?.close();
    await Promise.race([ctx?.close(), new Promise((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error('browser cleanup deadline')), 7000);
    })]);
  } catch (error) {
    failed = true; evidence.cleanupError = String(error?.message ?? error);
  }
  finally { clearTimeout(cleanupTimer); }
  if (!failed) stage = 'complete';
  report();
  clearTimeout(watchdog);
  process.exit(failed ? 1 : 0);
}
