// Real-Firefox Pod smoke. Creates a disposable copy of the store/Firefox
// staging tree, navigates one disposable tab to the actual Pod page, and receives the page's
// structured result over a loopback-only test endpoint.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProfile, run as launchFirefox } from '../../node_modules/web-ext/lib/firefox/index.js';
import { connectToFirefox } from '../../node_modules/web-ext/lib/firefox/rdp-client.js';

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
// web-ext always creates a disposable `-no-remote` profile; the currently
// installed stable binary is the browser under test.
const firefox = process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox';
const staging = join(root, 'artifacts/staging/store-firefox');
const source = await mkdtemp(join(tmpdir(), 'peerd-pod-firefox-'));
let firefoxProcess;
let profile;
let rdpClient;
let finish;
const result = new Promise((resolve) => { finish = resolve; });
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/pod-phase') {
      await request.text();
      return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.pathname !== '/pod-report') return new Response('not found', { status: 404 });
    try { finish(JSON.parse(await request.text())); }
    catch (error) { finish({ ok: false, phase: 'report-parse', error: error?.message ?? String(error) }); }
    return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
  },
});

const connectRdp = async (port, budgetMs = 15_000) => {
  const deadline = Date.now() + budgetMs;
  let lastError = new Error('Firefox RDP did not become ready');
  while (Date.now() < deadline) {
    try { return await connectToFirefox(port); }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
};

try {
  const packaged = Bun.spawnSync(['bun', 'packaging/package.ts', '--channel=store', '--browser=firefox'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (packaged.exitCode !== 0) throw new Error(`Firefox package failed (${packaged.exitCode})`);
  await cp(staging, source, { recursive: true });
  await cp(join(root, 'scripts/firefox/pod-smoke-page.js'), join(source, 'firefox-pod-smoke-page.js'));

  // Test-only public-create seam in the disposable copied extension. It uses
  // the production registry and trusted-sender check, but never enters either
  // source artifacts or a release package.
  const workerPath = join(source, 'background/service-worker.js');
  const workerSource = await readFile(workerPath, 'utf8');
  await writeFile(workerPath, `${workerSource}\n
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'firefox-smoke/create-pod' || !isTrustedSender(sender)) return false;
  return podRegistry.create({ name: 'Firefox smoke Pod', persistent: true })
    .then((record) => ({ ok: true, record }))
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
});\n`);

  const manifestPath = join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const origin = `http://127.0.0.1:${server.port}`;
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
    /connect-src ([^;]+)/, (_match, sources) => `connect-src ${sources} ${origin}`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const podHtmlPath = join(source, 'engine-tabs/pod-tab/index.html');
  const podHtml = await readFile(podHtmlPath, 'utf8');
  await writeFile(podHtmlPath, podHtml
    .replace("content=\"connect-src 'none'\"", `content=\"connect-src ${origin}\"`)
    .replace('  <script type="module" src="pod-tab.js"></script>',
      '  <script type="module" src="/firefox-pod-smoke-page.js"></script>\n  <script type="module" src="pod-tab.js"></script>'));

  profile = await createProfile();
  const running = await launchFirefox(profile, {
    firefoxBinary: firefox,
    binaryArgs: ['-headless', '--url', 'about:blank'],
    extensions: [{ sourceDir: source }],
    devtools: false,
  });
  firefoxProcess = running.firefox;

  // RDP inspection makes a silent navigation failure explicit and proves the
  // page under test is the extension's real Pod URL, not a web facsimile.
  setTimeout(async () => {
    try {
      // Firefox can publish its debugger port before the RDP listener accepts
      // connections on a cold start. Retry the bounded local handshake instead
      // of turning that ordinary startup race into a 60-second false timeout.
      const client = await connectRdp(running.debuggerPort);
      rdpClient = client;
      // Firefox sends forwardingCancelled when navigation replaces the old
      // content-process actor. It is expected during this one-tab handoff.
      client.on('error', (error) => {
        if (!error.message.includes('forwardingCancelled')) console.log(`FIREFOX POD RDP EVENT ${error.message}`);
      });
      const rootActor = await client.request('getRoot');
      const installed = await client.request({
        to: rootActor.addonsActor,
        type: 'installTemporaryAddon',
        addonPath: source,
      });
      const addons = await client.request('listAddons');
      const addon = addons.addons?.find((entry) => entry.id === 'peerd@peerd.ai');
      const addonOrigin = [addon?.manifestURL, addon?.url]
        .find((value) => typeof value === 'string' && value.startsWith('moz-extension://'));
      if (!addonOrigin) throw new Error(`installed add-on has no moz-extension origin: ${JSON.stringify(installed.addon)}`);
      const podUrl = `${new URL('/engine-tabs/pod-tab/index.html', addonOrigin).href}#pod-firefox-smoke?report=${encodeURIComponent(`${origin}/pod-report`)}`;
      console.log(`FIREFOX POD INSTALLED ${installed.addon.id} · ${new URL(addonOrigin).host}`);
      const tabs = await client.request('listTabs');
      const tab = tabs.tabs?.[0];
      if (!tab) throw new Error('Firefox created no disposable tab');
      const target = await client.request({ to: tab.actor, type: 'getTarget' });
      const targetActor = target.frame?.actor ?? target.target?.actor ?? target.actor;
      await client.request({ to: targetActor, type: 'navigateTo', url: podUrl });
    } catch (error) {
      console.log(`FIREFOX POD RDP ${error?.message ?? String(error)}`);
    }
  }, 3_000);

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, phase: 'timeout', error: 'Firefox did not report within 60s' }), 60_000));
  const exited = new Promise((resolve) => firefoxProcess.once('close', (exitCode) => resolve({ ok: false, phase: 'firefox-exit', error: `Firefox exited before a report (${exitCode})` })));
  const smoke = await Promise.race([result, timeout, exited]);
  console.log(`FIREFOX POD SMOKE ${JSON.stringify(smoke)}`);
  if (!smoke?.ok && rdpClient) {
    try {
      const tabs = await rdpClient.request('listTabs');
      const tab = tabs.tabs?.find((entry) => String(entry.url).includes('/engine-tabs/pod-tab/')) ?? tabs.tabs?.[0];
      const target = tab ? await rdpClient.request({ to: tab.actor, type: 'getTarget' }) : null;
      const consoleActor = target?.frame?.consoleActor;
      if (consoleActor) {
        const messages = await rdpClient.request({
          to: consoleActor,
          type: 'getCachedMessages',
          messageTypes: ['PageError', 'ConsoleAPI'],
        });
        console.log(`FIREFOX POD FAILURE CONSOLE ${JSON.stringify(messages)}`);
      }
    } catch (error) {
      console.log(`FIREFOX POD FAILURE RDP ${error?.message ?? String(error)}`);
    }
  }
  if (!smoke?.ok) process.exitCode = 1;
} finally {
  try { rdpClient?.disconnect(); } catch {}
  const closed = firefoxProcess && firefoxProcess.exitCode == null
    ? new Promise((resolve) => firefoxProcess.once('close', resolve))
    : Promise.resolve();
  try { firefoxProcess?.kill(); } catch {}
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  server.stop(true);
  const profilePath = profile?.path?.();
  if (typeof profilePath === 'string' && profilePath.startsWith(tmpdir()) && profilePath.includes('firefox-profile')) {
    await rm(profilePath, { recursive: true, force: true });
  }
  await rm(source, { recursive: true, force: true });
}
