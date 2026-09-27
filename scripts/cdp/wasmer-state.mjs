// Real Pod execution. The interpreter comes from a fixed upstream WASI release.
// Run with: bun run e2e:verify --only=pod-wasmer
// Visible demo: bun scripts/cdp/wasmer-state.mjs --demo
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { evalIn, openWidePage, waitFor, sleep, launchPeerd, unlockAndReady, capturePage } from './e2e-harness.mjs';

const ASSET_DIR = new URL('../../artifacts/wasmer-demo/', import.meta.url);
const INTERPRETERS = [
  {
    name: 'QuickJS', file: 'quickjs-ng-v0.17.0.wasm', path: 'quickjs.wasm',
    url: 'https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-wasi.wasm',
    hash: '42a732a676ec2d93488c19411e0fad283bf72658fdad746f089914b523c783b1',
    // MIT license: https://github.com/quickjs-ng/quickjs/blob/v0.17.0/LICENSE.
  },
  {
    name: 'Lua', file: 'lua-v0.1.0.wasm', path: 'lua.wasm',
    url: 'https://github.com/andy-emerson/lua.wasm/releases/download/v0.1.0/lua.wasm',
    hash: 'a2e407691b975e8e501955b2ebb0092c30033b561777ea1fd7bce4ed26c8eebe',
    // MIT license: https://github.com/andy-emerson/lua.wasm/blob/v0.1.0/LICENSE.
  },
];

const loadInterpreter = async (asset) => {
  const path = new URL(asset.file, ASSET_DIR);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${asset.name} download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.hash) {
    throw new Error(`${asset.name} demo package failed its SHA-256 check`);
  }
  await mkdir(ASSET_DIR, { recursive: true });
  await writeFile(path, bytes);
  return { ...asset, bytes };
};

const QUICKJS_DEMO = `#!wasmer /quickjs.wasm --std
const limit = 100;
const primes = [];
for (let n = 2; n < limit; n += 1) {
  let prime = true;
  for (let d = 2; d * d <= n; d += 1) {
    if (n % d === 0) { prime = false; break; }
  }
  if (prime) primes.push(n);
}
const result = primes.join(', ');
const file = std.open('/workspace/primes.txt', 'w');
file.puts(result + '\\n');
file.close();
print('QuickJS on Wasmer: ' + primes.length + ' primes below ' + limit);
print(result);
`;

const LUA_DEMO = `#!wasmer /lua.wasm
local input = assert(io.open('/workspace/primes.txt', 'r'))
local count, sum = 0, 0
for value in input:read('*a'):gmatch('%d+') do
  count = count + 1
  sum = sum + tonumber(value)
end
input:close()
local summary = 'Lua on Wasmer: ' .. count .. ' primes; sum = ' .. sum
local output = assert(io.open('/workspace/summary.txt', 'w'))
output:write(summary .. '\\n')
output:close()
print(summary)
`;

// why: real guest modules test forbidden imports and WASIX sockets without a compiler.
// The socket probe exits 1 if sock_open fails. Otherwise it exits with sock_connect's errno.
// WASIX sockaddr: family tag, padding, little-endian port, then IPv4 bytes.
const importProbe = (namespace, field, port = 0) => {
  const string = (value) => [value.length, ...Buffer.from(value)];
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  const body = [0, 65, 1, 65, 1, 65, 6, 65, 0, 16, 0,
    ...(port ? [4, 64, 65, 1, 16, 1, 11, 65, 0, 40, 2, 0, 65, 32, 16, 2] : []), 16, 1, 11];
  return Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [4, 96, 4, 127, 127, 127, 127, 1, 127, 96, 1, 127, 0, 96, 0, 0, 96, 2, 127, 127, 1, 127]),
    ...section(2, [port ? 3 : 2, ...string(namespace), ...string(field), 0, 0,
      ...string('wasi_snapshot_preview1'), ...string('proc_exit'), 0, 1,
      ...(port ? [...string('wasix_32v1'), ...string('sock_connect'), 0, 3] : [])]),
    ...section(3, [1, 2]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...string('memory'), 2, 0, ...string('_start'), 0, port ? 3 : 2]),
    ...section(10, [1, body.length, ...body]),
    ...(port ? section(11, [1, 0, 65, 32, 11, 8, 1, 0, port & 255, port >> 8, 127, 0, 0, 1]) : []),
  ]);
};

export const WASMER_STATE = {
  name: 'pod-wasmer', kind: 'functional', phase: 'pre-unlock',
  async run(_ctx, rec, { demo = false } = {}) {
    const interpreters = await Promise.all(INTERPRETERS.map(loadInterpreter));
    // why: disabling browser web security also disables cross-origin isolation.
    const ctx = await launchPeerd({ enforceWebSecurity: true, headless: !demo });
    let keepOpen = false;
    try {
      const pod = await evalIn(ctx.page, `(async () => {
        const { createPodRegistry } = await import('/peerd-engine/background.js');
        const { idbKV } = await import('/peerd-egress/background.js');
        return createPodRegistry({ storage: idbKV('pods') }).create({ name: 'Wasmer multi-language IDE' });
      })()`, true);
      // why: the kernel starts the Pod host after the vault is ready.
      await unlockAndReady(ctx.page);
      const page = await openWidePage(ctx, `engine-tabs/pod-tab/index.html#${pod.id}`, { ready: '#pod-app:not([hidden])' });
      await page.send('Target.setDiscoverTargets', { discover: true });
      await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const call = async (message) => evalIn(ctx.swConn, `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((item) => item.url?.endsWith(${JSON.stringify(`#${pod.id}`)}));
        if (!tab?.id) throw new Error('Wasmer demo Pod tab is missing');
        return chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ ...message, podId: pod.id })});
      })()`, true);
      let sequence = 0;
      const run = async (command, options = {}) => {
        const response = await call({ type: 'pod/exec', jobId: `job-wasmer-${++sequence}`, command, timeoutMs: 30_000, ...options });
        if (!response?.ok) throw new Error(response?.error || 'Pod command failed');
        return response.job;
      };
      const put = async (path, content) => {
        const response = await call({ type: 'pod/write-file', path, content });
        if (!response?.ok) throw new Error(response?.error || 'Pod file write failed');
      };
      const selectFile = async (path) => {
        const row = `[...document.querySelectorAll('[role="treeitem"]')].find((item) => item.dataset.path === ${JSON.stringify(path)})`;
        await evalIn(page, `${row}?.click()`);
        if (!await waitFor(() => evalIn(page, `${row}?.getAttribute('aria-selected') === 'true'`))) {
          throw new Error(`The editor did not open ${path}`);
        }
      };
      const runFile = async (path) => {
        await selectFile(path);
        const before = (await call({ type: 'pod/status' })).status.jobs.map((job) => job.id);
        await evalIn(page, `document.querySelector('#run-file-button').click()`);
        let selected;
        if (!await waitFor(async () => {
          selected = (await call({ type: 'pod/status' })).status.jobs.find((job) => !before.includes(job.id));
          return selected && selected.state !== 'running';
        }, { budgetMs: 35_000 })) throw new Error(`Run file did not complete ${path}`);
        const stdout = await call({ type: 'pod/status', jobId: selected.id, stream: 'stdout' });
        const stderr = await call({ type: 'pod/status', jobId: selected.id, stream: 'stderr' });
        return { ...selected, stdout: stdout.status.job.output, stderr: stderr.status.job.output };
      };
      const editSource = async (source) => evalIn(page, `(async () => {
        const { EditorView } = await import('/vendor/codemirror/cm.js');
        const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(source)} } });
      })()`, true);
      const workers = async () => (await page.send('Target.getTargets')).targetInfos.filter((target) =>
        target.type === 'worker' && /\/pod-tab\/wasmer-(?:thread-)?worker\.js$/.test(target.url));
      const workersStopped = () => waitFor(async () => (await workers()).length === 0, { budgetMs: 5_000, pollMs: 50 });
      const threadsRunning = () => waitFor(async () => (await workers()).some((target) =>
        target.url.endsWith('/wasmer-thread-worker.js')), { budgetMs: 5_000, pollMs: 50 });
      try {
        const isolated = await evalIn(page, 'crossOriginIsolated && typeof SharedArrayBuffer === "function"');
        rec.check('Wasmer runs with browser cross-origin isolation', isolated === true);
        const smoke = await run('wasmer-demo');
        rec.check('the real Wasmer SDK executes the packaged WASI command',
          smoke.exitCode === 0 && smoke.stdout.includes('hello from wasi'), JSON.stringify(smoke));
        if (smoke.exitCode !== 0) return;
        // why: load fixed interpreter bytes through OPFS without a guest network grant.
        for (const interpreter of interpreters) {
          await evalIn(page, `(async () => {
            const { opfsHelpers, POD_OPFS_ROOT } = await import('/peerd-engine/index.js');
            const workspace = opfsHelpers([POD_OPFS_ROOT, ${JSON.stringify(pod.id)}]);
            await workspace.write(${JSON.stringify(interpreter.path)}, Uint8Array.from(atob(${JSON.stringify(interpreter.bytes.toString('base64'))}), (c) => c.charCodeAt(0)));
          })()`, true);
        }
        await put('primes.js', QUICKJS_DEMO);
        await put('summary.lua', LUA_DEMO);
        const computed = await runFile('primes.js');
        rec.check('Run file executes QuickJS in the real Wasmer worker', computed.exitCode === 0
          && computed.stdout.includes('25 primes below 100') && computed.stdout.includes('89, 97'), JSON.stringify(computed));
        const saved = await call({ type: 'pod/read-file', path: 'primes.txt' });
        rec.check('the completed language command saves its output in the Pod workspace', saved.ok === true
          && saved.content === '2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97\n');
        rec.check('completed commands leave no Wasmer workers', await workersStopped());
        const summary = await runFile('summary.lua');
        const summaryFile = await call({ type: 'pod/read-file', path: 'summary.txt' });
        rec.check('Run file executes Lua and reads the JavaScript output file', summary.exitCode === 0
          && summary.stdout.trim() === 'Lua on Wasmer: 25 primes; sum = 1060'
          && summaryFile.content === `${summary.stdout.trim()}\n`, JSON.stringify(summary));
        await selectFile('primes.js');
        await editSource(QUICKJS_DEMO.replace('const limit = 100;', 'const limit = 50;'));
        const edited = await runFile('primes.js');
        const editedSource = await call({ type: 'pod/read-file', path: 'primes.js' });
        rec.check('Run file saves editor changes before it executes QuickJS', edited.exitCode === 0
          && edited.stdout.includes('15 primes below 50') && editedSource.content.includes('const limit = 50;'), JSON.stringify(edited));
        const changedSummary = await runFile('summary.lua');
        const changedFile = await call({ type: 'pod/read-file', path: 'summary.txt' });
        rec.check('Lua reads the changed JavaScript output from the same workspace', changedSummary.exitCode === 0
          && changedSummary.stdout.trim() === 'Lua on Wasmer: 15 primes; sum = 328'
          && changedFile.content === `${changedSummary.stdout.trim()}\n`, JSON.stringify(changedSummary));
        for (const interpreter of interpreters) {
          await evalIn(page, `document.querySelector('[role="treeitem"][data-path="${interpreter.path}"]')?.click()`);
        }
        rec.check('binary runtimes stay read-only and leave the source editor open', await evalIn(page,
          `document.querySelector('[role="treeitem"][data-path="summary.lua"]')?.getAttribute('aria-selected') === 'true'
            && document.querySelector('.cm-content')?.textContent.includes('local count, sum')
            && ['quickjs.wasm', 'lua.wasm'].every((path) => document.querySelector('[data-path="' + path + '"]')?.classList.contains('is-readonly'))`));
        await selectFile('primes.js');
        await editSource(QUICKJS_DEMO.replace('#!wasmer /quickjs.wasm --std', '#!wasmer /quickjs.wasm --std; touch injected.txt'));
        const jobsBefore = (await call({ type: 'pod/status' })).status.jobs.length;
        await evalIn(page, `document.querySelector('#run-file-button').click()`);
        const invalidRejected = await waitFor(() => evalIn(page, `document.querySelector('#pod-job-status').textContent.includes('Start this file with #!wasmer')`));
        const injected = await call({ type: 'pod/read-file', path: 'injected.txt' });
        rec.check('Run file rejects shell operators in the interpreter directive', invalidRejected
          && (await call({ type: 'pod/status' })).status.jobs.length === jobsBefore && !injected.ok);
        const quotedPath = "quote's; touch injected-path.txt; x.lua";
        await put(quotedPath, "#!wasmer /lua.wasm\nprint('Lua safely runs a quoted source path')\n");
        const quoted = await runFile(quotedPath);
        const injectedPath = await call({ type: 'pod/read-file', path: 'injected-path.txt' });
        rec.check('Run file keeps a quoted source path as one shell argument', quoted.exitCode === 0
          && quoted.stdout.trim() === 'Lua safely runs a quoted source path' && !injectedPath.ok, JSON.stringify(quoted));
        await run(`rm "${quotedPath}"`);
        await put('primes.js', QUICKJS_DEMO);
        // why: a normal reload removes setup history from the visible demo.
        await page.send('Page.reload');
        if (!await waitFor(() => evalIn(page, `!!document.querySelector('#pod-app:not([hidden])')`))) {
          throw new Error('The demo Pod did not reload');
        }
        const restoredPrimes = await runFile('primes.js');
        const restoredSummary = await runFile('summary.lua');
        rec.check('the editable demo returns to the complete two-language result', restoredPrimes.exitCode === 0
          && restoredPrimes.stdout.includes('25 primes below 100') && restoredSummary.exitCode === 0
          && restoredSummary.stdout.trim() === 'Lua on Wasmer: 25 primes; sum = 1060', JSON.stringify(restoredSummary));
        await rec.shotPage('multi-language-ide', page);
        if (demo) {
          keepOpen = true;
          return { ctx, page, podId: pod.id };
        }
        const child = await run('mkdir work && cd work && wasmer ../quickjs.wasm --std -e \'const here = std.getenv("PWD"); const f = std.open(here + "/cwd.txt", "w"); f.puts(here); f.close(); print(here)\' && cd /');
        const childFile = await call({ type: 'pod/read-file', path: 'work/cwd.txt' });
        rec.check('the guest can write in the current empty Pod directory', child.exitCode === 0
          && child.stdout.trim() === '/workspace/work' && childFile.content === '/workspace/work', JSON.stringify(child));
        const selector = await run('wasmer saghul/quickjs');
        rec.check('registry selectors cannot grant network access', selector.exitCode === 2);
        let connections = 0;
        const server = createServer((socket) => { connections += 1; socket.destroy(); });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try { for (const [name, namespace, field] of [
          ['host-import', 'env', 'fetch'], ['socket', 'wasix_32v1', 'sock_open'],
        ]) {
          const bytes = importProbe(namespace, field, name === 'socket' ? server.address().port : 0);
          await WebAssembly.compile(bytes);
          await evalIn(page, `(async () => {
            const { opfsHelpers, POD_OPFS_ROOT } = await import('/peerd-engine/index.js');
            await opfsHelpers([POD_OPFS_ROOT, ${JSON.stringify(pod.id)}]).write(${JSON.stringify(`${name}.wasm`)}, new Uint8Array(${JSON.stringify([...bytes])}));
          })()`, true);
          const denied = await run(`wasmer ${name}.wasm`);
          rec.check(name === 'host-import' ? 'the guest cannot import browser fetch'
            : 'WASIX cannot connect to a real listening TCP socket', name === 'host-import'
              ? denied.exitCode !== 0 && /import/i.test(denied.stderr) && /"env"/.test(denied.stderr)
              : denied.exitCode === 58 && denied.stderr === '' && connections === 0, JSON.stringify(denied));
        } } finally { await new Promise((resolve) => server.close(resolve)); }
        await put('outside.js', `const f = std.open('/peerd-pods/${pod.id}/primes.js', 'r'); print(f === null ? 'host workspace blocked' : 'host workspace exposed');`);
        const outside = await run('wasmer quickjs.wasm --std /workspace/outside.js');
        rec.check('the interpreter cannot read the host OPFS tree', outside.exitCode === 0
          && outside.stdout.trim() === 'host workspace blocked', JSON.stringify(outside));
        await put('loop.js', "const f = std.open('/workspace/cancelled.txt', 'w'); f.puts('pending'); f.close(); while (true) {}");
        const looping = await run('wasmer quickjs.wasm --std /workspace/loop.js', { background: true, timeoutMs: 20_000 });
        rec.check('the infinite program starts real Wasmer threads', await threadsRunning(),
          JSON.stringify((await workers()).map((target) => target.title)));
        const queued = await run('wasmer quickjs.wasm --std -e \'const f = std.open("/workspace/queued.txt", "w"); f.puts(String(6 * 7)); f.close()\'', { background: true });
        await sleep(200);
        const cancelledQueued = call({ type: 'pod/cancel', jobId: queued.id });
        const promptCancel = await Promise.race([cancelledQueued, sleep(2_000).then(() => null)]);
        rec.check('a queued Wasmer command cancels while another command runs', promptCancel?.cancelled === true);
        const cancelled = await call({ type: 'pod/cancel', jobId: looping.id });
        rec.check('cancellation stops the Wasmer job and all its workers', cancelled.cancelled === true
          && cancelled.state === 'cancelled' && await workersStopped());
        const missing = await call({ type: 'pod/read-file', path: 'cancelled.txt' });
        rec.check('cancelled Wasmer writes do not reach the Pod workspace', missing.ok === false);
        await cancelledQueued;
        const queuedFile = await call({ type: 'pod/read-file', path: 'queued.txt' });
        rec.check('the cancelled queued command cannot write after the workspace unlocks', queuedFile.ok === false);
        const timedResult = run('wasmer quickjs.wasm --std /workspace/loop.js', { timeoutMs: 3_000 });
        rec.check('the timeout probe starts real Wasmer threads', await threadsRunning());
        const timed = await timedResult;
        rec.check('the Pod deadline stops an infinite program and all its workers', timed.exitCode !== 0
          && /timed out|timeout/i.test(timed.stderr) && await workersStopped(), JSON.stringify(timed));
        const recovered = await run('wasmer quickjs.wasm -e "print(6 * 7)"');
        rec.check('a new Wasmer command works after cancellation and timeout', recovered.exitCode === 0 && recovered.stdout.trim() === '42', JSON.stringify(recovered));
        await rec.shotPage('stopped-and-recovered', page);
        console.log(`[wasmer-demo] Verified interpreter assets: ${fileURLToPath(ASSET_DIR)}`);
      } finally {
        if (!keepOpen) {
          await page.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
          page.close();
        }
      }
    } finally { if (!keepOpen) await ctx.close(); }
  },
};

if (import.meta.main) {
  if (!process.argv.includes('--demo')) throw new Error('Use --demo to open the visible Wasmer demo.');
  const result = await WASMER_STATE.run(null, {
    check(name, pass, detail = '') {
      console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
      if (!pass) throw new Error(detail || name);
    },
    async shotPage(label, page) {
      await writeFile(new URL(`${label}.png`, ASSET_DIR), await capturePage(page));
    },
  }, { demo: true });
  console.log('Wasmer demo is open. Close its Pod tab or press Ctrl+C to end.');
  try {
    while (result) {
      await sleep(1_000);
      const targets = await fetch(`http://127.0.0.1:${result.ctx.port}/json/list`).then((response) => response.json()).catch(() => []);
      if (!targets.some((target) => target.url?.endsWith(`#${result.podId}`))) break;
    }
  } finally { await result?.ctx.close(); }
}
