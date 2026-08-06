// Small Firefox WebDriver client for CI. It speaks directly to geckodriver so
// the runtime lane adds no Selenium dependency and keeps the browser boundary
// visible in one place.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REQUEST_BUDGET_MS = 30_000;
const SESSION_START_BUDGET_MS = 60_000;
const CLEANUP_BUDGET_MS = 5_000;

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not reserve a local geckodriver port');
  return port;
};

const parseResponse = async (response, method, path) => {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : { value: null }; }
  catch { throw new Error(`${method} ${path}: geckodriver returned invalid JSON`); }
  const remoteError = payload?.value?.error;
  if (!response.ok || remoteError) {
    const remoteMessage = payload?.value?.message;
    const message = typeof remoteMessage === 'string' && remoteMessage.length > 0
      ? remoteMessage
      : JSON.stringify(payload?.value ?? payload) || `${response.status} ${response.statusText}`;
    throw new Error(`${method} ${path}: ${message}`);
  }
  return payload?.value;
};

export const startGeckodriver = async ({
  binary, firefoxBinary, prefs = {}, acceptInsecureCerts = false, proxy = null,
}) => {
  const port = await reservePort();
  const logs = [];
  const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--log', 'info'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const origin = `http://127.0.0.1:${port}`;
  const request = async (method, path, body, budgetMs = REQUEST_BUDGET_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      return await parseResponse(response, method, path);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${method} ${path}: geckodriver did not respond within ${budgetMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`geckodriver exited during startup\n${logs.join('')}`);
      }
      try {
        const status = await request('GET', '/status', undefined, 2_000);
        if (status?.ready) break;
      } catch { /* startup is still in progress */ }
      await sleep(100);
    }
    const status = await request('GET', '/status', undefined, 2_000).catch(() => null);
    if (!status?.ready) throw new Error(`geckodriver did not become ready\n${logs.join('')}`);

    let session;
    try {
      session = await request('POST', '/session', {
        capabilities: {
          alwaysMatch: {
            browserName: 'firefox',
            acceptInsecureCerts,
            ...(proxy ? { proxy } : {}),
            'moz:firefoxOptions': {
              binary: firefoxBinary,
              args: ['-headless', '-no-remote'],
              prefs: {
                'browser.shell.checkDefaultBrowser': false,
                'browser.startup.page': 0,
                'browser.startup.homepage_override.mstone': 'ignore',
                ...prefs,
              },
            },
          },
        },
      }, SESSION_START_BUDGET_MS);
    } catch (error) {
      const detail = logs.join('').trim();
      throw new Error(`${error?.message ?? String(error)}${detail ? `\n${detail}` : ''}`);
    }
    const sessionId = session?.sessionId;
    if (!sessionId) throw new Error(`geckodriver did not return a session id\n${logs.join('')}`);
    const sessionPath = `/session/${sessionId}`;

    const command = (method, path = '', body) => request(method, `${sessionPath}${path}`, body);
    await command('POST', '/timeouts', { implicit: 0, pageLoad: 30_000, script: 30_000 });

    return {
      sessionId,
      logs,
      installAddon: (path) => command('POST', '/moz/addon/install', { path, temporary: true }),
      navigate: (url) => command('POST', '/url', { url }),
      execute: (script, args = []) => command('POST', '/execute/sync', { script, args }),
      executeAsync: (script, args = []) => command('POST', '/execute/async', { script, args }),
      setWindowRect: (rect) => command('POST', '/window/rect', rect),
      screenshot: () => command('GET', '/screenshot'),
      close: async () => {
        try {
          await request('DELETE', sessionPath, undefined, CLEANUP_BUDGET_MS);
        } catch { /* best-effort cleanup */ }
        finally { kill(); }
      },
    };
  } catch (error) {
    kill();
    throw error;
  }
};

export const waitFor = async (probe, { budgetMs = 15_000, pollMs = 200 } = {}) => {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(pollMs);
  }
  if (last instanceof Error) throw last;
  return null;
};
