// One isolated browser on one host. JSON lines over SSH are control only;
// production WebRTC carries every tested peer message and content byte.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { sourceFingerprint, gitMetadata } from './dweb-cluster-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extension = join(root, 'extension');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, profile, server, socket;
const errors = [];
const pending = new Map();
let sequence = 0;
let closing = false;

const cleanup = async () => {
  if (closing) return;
  closing = true;
  socket?.close();
  server?.stop(true);
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill('SIGTERM');
    const force = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
  if (profile) rmSync(profile, { recursive: true, force: true });
};
const finish = async code => { await cleanup(); process.exit(code); };
process.once('SIGTERM', () => void finish(143));
process.once('SIGINT', () => void finish(130));
// why: an abandoned SSH connection must not leave a browser occupying a host.
setTimeout(() => void finish(1), 10 * 60_000).unref();

const fingerprint = () => {
  let machine;
  if (process.platform === 'darwin') {
    const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    machine = output.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1];
  } else if (process.platform === 'linux') machine = readFileSync('/etc/machine-id', 'utf8').trim();
  if (!machine) throw new Error('Cannot establish physical machine identity');
  return { host: hostname(), platform: process.platform, arch: process.arch,
    machine: createHash('sha256').update(machine).digest('hex'), source: sourceFingerprint(root), ...gitMetadata(root),
    runtime: Bun.version };
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45_000);
  pending.set(id, message => {
    clearTimeout(timeout);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

const launch = async ({ chrome, mdns = true, allInterfaces = false }) => {
  if (typeof chrome !== 'string' || !existsSync(chrome)) throw new Error('Configure an existing Chrome binary');
  if (browser) throw new Error('Browser already launched');
  const host = fingerprint();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === '/') return new Response('<!doctype html><script type="module" src="/__cluster.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    const file = path === '/__cluster.js' ? join(root, 'scripts/cdp/dweb-cluster-page.js') : resolve(extension, `.${path}`);
    if (path !== '/__cluster.js' && !file.startsWith(extension + sep)) return new Response(null, { status: 404 });
    const bytes = Bun.file(file);
    if (!await bytes.exists()) { errors.push(`HTTP 404: ${path}`); return new Response(null, { status: 404 }); }
    return new Response(bytes, { headers: { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : bytes.type } });
  } });
  profile = mkdtempSync(join(tmpdir(), 'peerd-cluster-'));
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    ...(allInterfaces ? ['--use-fake-device-for-media-stream'] : []),
    ...(!mdns ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : []),
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  browser.on('error', error => { launchError = error; });
  browser.stderr.on('data', bytes => { errors.push(String(bytes).slice(-2000)); if (errors.length > 20) errors.shift(); });
  let version;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${errors.join('')}`);
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      socket = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      break;
    } catch { await sleep(200); }
  }
  if (!socket) throw new Error(`Browser readiness deadline: ${errors.join('')}`);
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params));
    if (message.method === 'Runtime.consoleAPICalled') {
      errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      if (errors.length > 100) errors.shift();
    }
  };
  socket.onclose = () => {
    for (const settle of pending.values()) settle({ error: { message: 'CDP closed' } });
    pending.clear();
  };
  await send('Runtime.enable');
  // why: an HTTP fixture may otherwise see only the default interface.
  // Grant only this disposable origin; fake devices preclude real capture.
  if (allInterfaces) await send('Browser.grantPermissions', {
    origin: `http://127.0.0.1:${server.port}`, permissions: ['audioCapture'],
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });
  while (!await evaluate('!!window.cluster')) {
    if (Date.now() >= deadline) throw new Error(`Fixture readiness deadline: ${errors.join('')}`);
    await sleep(100);
  }
  return { ...host, browser: version.Browser, mdns, allInterfaces };
};

const lines = createInterface({ input: process.stdin });
lines.once('close', () => void finish(0));
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    const { id, method, args } = request;
    const result = method === 'launch' ? await launch(args)
      : method === 'diagnostics' ? { logs: errors, transports: await evaluate('window.cluster?.diagnostics()') }
      : await evaluate(`window.cluster[${JSON.stringify(method)}](${JSON.stringify(args ?? {})})`);
    process.stdout.write(`${JSON.stringify({ id, result: result ?? null })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request?.id, error: error.message })}\n`);
  }
}
