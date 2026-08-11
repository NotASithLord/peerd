// @ts-check
// Trusted host for one Pod. It owns rooted OPFS, brokered Git/fetch, and the
// job table; every command runs in a fresh sealed Worker with only RPC handles.
//
// Product boundary: Script is disposable JS, Notebook is a persistent JS
// workspace, Pod is this shell/WASI/Git layer, and WebVM is Linux compatibility.
// why: keeping Pod as a thin composition of existing hosts avoids owning a
// second filesystem, Node/POSIX compatibility layer, or browser Linux runtime.

import browser from '/vendor/browser-polyfill.js';
import { buildModule, createEditor, opfsHelpers, POD_OPFS_ROOT } from '/peerd-engine/index.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';
import { buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS } from '../notebook-tab/worker-source.js';

const podId = location.hash.slice(1).split(/[?&]/)[0];
if (!/^pod-[a-z0-9-]+$/i.test(podId)) throw new Error('No valid podId in URL hash');

const MAX_JOB_OUTPUT = 512 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const JOB_HISTORY = 64;
const workspace = opfsHelpers([POD_OPFS_ROOT, podId]);
const firefoxRuntime = typeof browser.runtime.getBrowserInfo === 'function'
  ? browser.runtime.getBrowserInfo().then((info) => info.name === 'Firefox').catch(() => false)
  : Promise.resolve(false);
/** @typedef {{id:string,command:string,state:'running'|'completed'|'failed',stdout:string,stderr:string,exitCode:number|null,startedAt:number,finishedAt?:number,durationMs?:number,timeoutMs:number,worker:Worker,children:Set<Worker>,resolve?:(value:any)=>void,timer?:ReturnType<typeof setTimeout>,remoteGitAuthorized:boolean,background:boolean}} PodJob */
/** @type {Map<string, any>} */ const jobs = new Map();
let jobSequence = 0;
let workspaceTail = Promise.resolve();
/** @type {Map<Worker,{release:()=>void,owned:boolean,cancelled:boolean}>} */ const workspaceLocks = new Map();
let cwd = '/';
/** @type {Record<string,string>} */ let environment = { HOME: '/', PATH: '/.peerd/tools:/bin' };
/** @type {Awaited<ReturnType<typeof createEditor>>} */ let editor;

mountPullInPeerd();

/** @param {string} id */
const element = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const output = element('terminal-output');
const status = element('pod-status');
const promptLabel = element('prompt-label');
const input = /** @type {HTMLInputElement} */ (element('terminal-input'));
const form = /** @type {HTMLFormElement} */ (element('terminal-form'));

/** @param {string} className @param {string} text */
const append = (className, text) => {
  if (!text) return;
  const node = document.createElement('span');
  node.className = `entry ${className}`;
  node.textContent = text;
  output.appendChild(node);
  output.scrollTop = output.scrollHeight;
};

const publicJob = (/** @type {any} */ job) => ({
  id: job.id, command: job.command, state: job.state,
  stdout: job.stdout ?? '', stderr: job.stderr ?? '', exitCode: job.exitCode ?? null,
  startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
  durationMs: job.durationMs ?? (Date.now() - job.startedAt),
  timeoutMs: job.timeoutMs,
});

const trimJobs = () => {
  const completed = [...jobs.values()].filter((/** @type {PodJob} */ job) => job.state !== 'running');
  for (const job of completed.slice(0, Math.max(0, completed.length - JOB_HISTORY))) jobs.delete(job.id);
};

/** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
const enqueueWorkspace = (operation) => {
  const result = workspaceTail.then(operation, operation);
  workspaceTail = result.then(() => undefined, () => undefined);
  return result;
};

/** @param {Worker} worker */
const acquireWorkspace = async (worker) => {
  if (workspaceLocks.has(worker)) throw new Error('workspace lock already requested');
  const previous = workspaceTail.catch(() => {});
  /** @type {()=>void} */ let release = () => {};
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  const record = { release, owned: false, cancelled: false };
  workspaceLocks.set(worker, record);
  workspaceTail = previous.then(() => held);
  await previous;
  if (record.cancelled) { release(); workspaceLocks.delete(worker); throw new Error('workspace lock cancelled'); }
  record.owned = true;
};

/** @param {Worker} worker */
const releaseWorkspace = (worker) => {
  const record = workspaceLocks.get(worker);
  if (!record) return false;
  record.cancelled = true;
  if (record.owned) { record.release(); workspaceLocks.delete(worker); }
  return true;
};

/** @template T @param {Worker} worker @param {()=>Promise<T>} operation */
const withWorkspace = (worker, operation) => workspaceLocks.get(worker)?.owned
  ? operation()
  : enqueueWorkspace(operation);

/** @param {unknown} value */
const printable = (value) => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
};

/** @param {Map<string,{blobUrl:string}>} cache */
const revokeModuleCache = (cache) => {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.blobUrl);
};

const makePodResolverDeps = () => ({
  /** @param {string} path */
  readFile: (path) => workspace.read(path),
  /** @param {string} source */
  makeBlobUrl: (source) => URL.createObjectURL(new Blob([source], { type: 'application/javascript' })),
  // why omitted: fetchRemote and readToolboxModule are authority-bearing
  // resolver dependencies. Pod JS may use the named, audited pod.fetch bridge,
  // but source imports must already exist in this Pod's workspace.
  builtins: NOTEBOOK_BUILTINS,
});

/** @param {any} args */
const checkedFileContent = (args) => {
  const content = args.content;
  const size = typeof content === 'string' ? new TextEncoder().encode(content).byteLength
    : content instanceof ArrayBuffer || ArrayBuffer.isView(content) ? content.byteLength : -1;
  if (size < 0 || size > MAX_FILE_BYTES) {
    throw new Error(`file write exceeds Pod limit: ${size} > ${MAX_FILE_BYTES}`);
  }
  return content;
};

/** @param {PodJob} job @param {any} args */
const runPodJavaScript = async (job, args) => {
  if (await firefoxRuntime) {
    throw new Error('Web-standard JS is unavailable in Firefox Pods: Firefox MV3 forbids dynamic blob Workers. Use WASI or a WebVM for this command.');
  }
  const entryPath = String(args.entryPath || 'pod-command.js');
  const resolverDeps = makePodResolverDeps();
  const built = await enqueueWorkspace(() => buildWorkerSource(String(args.code ?? ''), {
    entryPath,
    notebookId: podId,
    resolverDeps,
    caps: { page: false, egress: false, subagent: false, opfs: true, provider: false, distributed: false },
    podCommand: {
      args: Array.isArray(args.args) ? args.args.map(String) : [],
      stdin: String(args.stdin ?? ''),
      cwd: String(args.cwd ?? '/'),
      env: args.env && typeof args.env === 'object' ? args.env : {},
    },
  }));
  const workerUrl = URL.createObjectURL(new Blob([built.source], { type: 'application/javascript' }));
  const worker = new Worker(workerUrl, { type: 'module', name: `peerd-pod-js-${job.id}` });
  job.children.add(worker);
  /** @type {string[]} */ const stdout = [];
  /** @type {string[]} */ const stderr = [];

  return new Promise((resolve) => {
    let settled = false;
    /** @param {{stdout:string,stderr:string,exitCode:number}} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      job.children.delete(worker);
      try { worker.terminate(); } catch {}
      URL.revokeObjectURL(workerUrl);
      revokeModuleCache(built.cache);
      resolve(result);
    };
    worker.addEventListener('message', async (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'log') {
        const target = message.level === 'warn' || message.level === 'error' ? stderr : stdout;
        target.push(`${String(message.text ?? '')}\n`);
        return;
      }
      if (message.type === 'fetch-request') { await answerFetch(worker, message); return; }
      if (message.type === 'opfs-request') {
        try {
          let result;
          if (message.op === 'read') result = await enqueueWorkspace(() => workspace.read(message.args.path));
          else if (message.op === 'write') {
            await enqueueWorkspace(() => workspace.write(message.args.path, checkedFileContent(message.args)));
            result = null;
          } else if (message.op === 'delete') {
            await enqueueWorkspace(() => workspace.remove(message.args.path));
            result = null;
          } else if (message.op === 'list') result = await enqueueWorkspace(() => workspace.list());
          else if (message.op === 'compose-module') {
            const module = await enqueueWorkspace(() => buildModule(message.args.path, resolverDeps, built.cache));
            result = module.source;
          } else throw new Error(`unknown Pod JS filesystem operation: ${message.op}`);
          worker.postMessage({ type: 'opfs-response', rid: message.rid, result });
        } catch (error) {
          worker.postMessage({ type: 'opfs-response', rid: message.rid, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
        }
        return;
      }
      if (message.type === 'done') {
        const error = message.error ? mapWorkerError(message.error, workerUrl, built.bodyLine, entryPath) : '';
        const value = !error ? printable(message.value) : '';
        if (value) stdout.push(`${value}${value.endsWith('\n') ? '' : '\n'}`);
        if (error) stderr.push(`${error}\n`);
        finish({ stdout: stdout.join(''), stderr: stderr.join(''), exitCode: error ? 1 : 0 });
      }
    });
    worker.addEventListener('error', (event) => {
      const detail = mapWorkerError(event.error?.stack || event.message || 'worker crashed', workerUrl, built.bodyLine, entryPath);
      finish({ stdout: stdout.join(''), stderr: `${stderr.join('')}worker error: ${detail}\n`, exitCode: 1 });
    });
  });
};

/** @param {any} worker @param {any} message @param {PodJob} job */
const answerWorkerRequest = async (worker, message, job) => {
  const reply = (/** @type {any} */ result) => worker.postMessage({ type: 'pod-response', rid: message.rid, result });
  const fail = (/** @type {any} */ error) => worker.postMessage({ type: 'pod-response', rid: message.rid, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
  try {
    const args = message.args ?? {};
    switch (message.op) {
      case 'workspace-lock': await acquireWorkspace(worker); reply(null); return;
      case 'workspace-unlock': releaseWorkspace(worker); reply(null); return;
      case 'fs-read': reply(await withWorkspace(worker, () => workspace.read(args.path))); return;
      case 'fs-read-bytes': reply(await withWorkspace(worker, () => workspace.readBytes(args.path))); return;
      case 'fs-write': {
        await withWorkspace(worker, () => workspace.write(args.path, checkedFileContent(args))); reply(null); return;
      }
      case 'fs-list': reply(await withWorkspace(worker, () => workspace.list())); return;
      case 'fs-list-dir': reply(await withWorkspace(worker, () => workspace.listDir(args.path))); return;
      case 'fs-stat': reply(await withWorkspace(worker, () => workspace.stat(args.path))); return;
      case 'fs-exists': reply(await withWorkspace(worker, () => workspace.exists(args.path))); return;
      case 'fs-mkdir': await withWorkspace(worker, () => workspace.mkdir(args.path, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-remove': await withWorkspace(worker, () => workspace.remove(args.path, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-copy': await withWorkspace(worker, () => workspace.copy(args.from, args.to, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-move': await withWorkspace(worker, () => workspace.move(args.from, args.to)); reply(null); return;
      case 'git': {
        const response = /** @type {any} */ (await withWorkspace(worker, () => browser.runtime.sendMessage({
          type: 'pod/git', podId, argv: args.argv, cwd: args.cwd,
          remoteAuthorized: job.remoteGitAuthorized === true,
        })));
        if (!response?.ok) throw new Error(response?.error ?? 'git failed');
        reply(response.result); return;
      }
      case 'js-run': reply(await runPodJavaScript(job, args)); return;
      case 'jobs': reply([...jobs.values()].map(publicJob)); return;
      case 'cancel-job': reply({ cancelled: cancelJob(String(args.jobId ?? '')) }); return;
      default: throw new Error(`unknown Pod host operation: ${message.op}`);
    }
  } catch (error) { fail(error); }
};

/** @param {any} worker @param {any} message */
const answerFetch = async (worker, message) => {
  try {
    const response = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'sw/web-fetch', url: message.url, method: message.method,
      headers: message.headers, body: message.body,
    }));
    worker.postMessage({ type: 'fetch-response', rid: message.rid, ...response });
  } catch (error) {
    worker.postMessage({ type: 'fetch-response', rid: message.rid, ok: false, status: 0, bodyB64: null, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
  }
};

/** @param {string} jobId */
const cancelJob = (jobId) => {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'running') return false;
  clearTimeout(job.timer);
  releaseWorkspace(job.worker);
  try { job.worker.terminate(); } catch {}
  for (const child of job.children) try { child.terminate(); } catch {}
  job.children.clear();
  job.state = 'failed';
  job.stderr = `${job.stderr ?? ''}cancelled\n`;
  job.exitCode = 130;
  job.finishedAt = Date.now();
  job.durationMs = job.finishedAt - job.startedAt;
  job.resolve?.(publicJob(job));
  status.textContent = [...jobs.values()].some((entry) => entry.state === 'running') ? 'running' : 'ready';
  return true;
};

/** @param {string} command @param {{timeoutMs?:number,background?:boolean,render?:boolean,remoteGitAuthorized?:boolean}} [options] */
const startJob = (command, { timeoutMs = 30_000, background = false, render = false, remoteGitAuthorized = false } = {}) => {
  const id = `job-${Date.now().toString(36)}-${(++jobSequence).toString(36)}`;
  const worker = new Worker('/engine-tabs/pod-tab/pod-job-worker.js', { type: 'module', name: `peerd-pod-${id}` });
  /** @type {(value:any)=>void} */ let resolve = () => {};
  const completion = new Promise((done) => { resolve = done; });
  const job = /** @type {PodJob} */ ({ id, command, state: 'running', stdout: '', stderr: '', exitCode: null, startedAt: Date.now(), timeoutMs, worker, children: new Set(), resolve, remoteGitAuthorized, background });
  jobs.set(id, job);
  trimJobs();
  status.textContent = 'running';
  if (render) append('entry-command', `${cwd} $ ${command}\n`);
  const settle = (/** @type {any} */ result) => {
    if (job.state !== 'running') return;
    clearTimeout(job.timer);
    releaseWorkspace(worker);
    try { worker.terminate(); } catch {}
    for (const child of job.children) try { child.terminate(); } catch {}
    job.children.clear();
    job.stdout = String(result?.stdout ?? '').slice(0, MAX_JOB_OUTPUT);
    job.stderr = String(result?.stderr ?? '').slice(0, MAX_JOB_OUTPUT);
    job.exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 1;
    job.state = job.exitCode === 0 ? 'completed' : 'failed';
    job.finishedAt = Date.now();
    job.durationMs = Number(result?.durationMs ?? job.finishedAt - job.startedAt);
    // Background commands run as independent subshells: finishing last must
    // not race the interactive session's cwd or environment.
    if (!job.background && typeof result?.cwd === 'string') cwd = result.cwd;
    if (!job.background && result?.env && typeof result.env === 'object') environment = result.env;
    promptLabel.textContent = `${cwd} $`;
    status.textContent = [...jobs.values()].some((entry) => entry.state === 'running') ? 'running' : 'ready';
    if (render) {
      append('entry-stdout', job.stdout);
      append('entry-stderr', job.stderr);
      append('entry-meta', `[${job.id} · exit ${job.exitCode} · ${Math.round(job.durationMs)}ms]\n`);
    }
    editor?.refreshTree?.().catch(() => {});
    resolve(publicJob(job));
  };
  job.timer = setTimeout(() => {
    if (job.state !== 'running') return;
    try { worker.terminate(); } catch {}
    for (const child of job.children) try { child.terminate(); } catch {}
    job.children.clear();
    settle({ stderr: `timed out after ${timeoutMs}ms\n`, exitCode: 124, durationMs: timeoutMs });
  }, Math.min(300_000, Math.max(1, timeoutMs)));
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'pod-request') { answerWorkerRequest(worker, message, job); return; }
    if (message?.type === 'fetch-request') { answerFetch(worker, message); return; }
    if (message?.type === 'done') settle(message.result);
  });
  worker.addEventListener('error', (event) => settle({ stderr: `worker error: ${event.message || 'unknown'}\n`, exitCode: 1 }));
  worker.postMessage({ type: 'run', command, cwd, env: environment });
  return background ? Promise.resolve(publicJob(job)) : completion;
};

const POD_ROUTES = new Set(['pod/exec', 'pod/status', 'pod/cancel', 'pod/read-file', 'pod/write-file', 'pod/list-files']);
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ message, /** @type {any} */ _sender, /** @type {(value:any)=>void} */ sendResponse) => {
  if (!message || !POD_ROUTES.has(message.type) || (message.podId && message.podId !== podId)) return false;
  (async () => {
    try {
      if (message.type === 'pod/exec') sendResponse({ ok: true, job: await startJob(String(message.command ?? ''), {
        timeoutMs: message.timeoutMs, background: message.background === true,
        remoteGitAuthorized: message.remoteGitAuthorized === true,
      }) });
      else if (message.type === 'pod/status') sendResponse({ ok: true, status: { podId, state: [...jobs.values()].some((job) => job.state === 'running') ? 'running' : 'ready', cwd, jobs: [...jobs.values()].map(publicJob) } });
      else if (message.type === 'pod/cancel') sendResponse({ ok: cancelJob(String(message.jobId ?? '')), cancelled: message.jobId });
      else if (message.type === 'pod/read-file') sendResponse({ ok: true, content: await enqueueWorkspace(() => workspace.read(message.path)) });
      else if (message.type === 'pod/write-file') { await enqueueWorkspace(() => workspace.write(message.path, checkedFileContent(message))); await editor.refreshTree(); sendResponse({ ok: true }); }
      else if (message.type === 'pod/list-files') sendResponse({ ok: true, files: await enqueueWorkspace(() => workspace.list()) });
    } catch (error) { sendResponse({ ok: false, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) }); }
  })();
  return true;
}));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  const background = /(?:^|\s)&\s*$/.test(command);
  // A command typed into the visible Pod terminal is the user's direct gesture;
  // agent-issued commands arrive through pod/exec and need a separately minted
  // one-job grant for Git remote operations.
  startJob(command, { background, render: true, remoteGitAuthorized: true }).catch((error) => append('entry-stderr', `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`));
});

(async () => {
  const bootStarted = performance.now();
  editor = await createEditor({
    mountEl: element('editor-mount'), opfsBase: [POD_OPFS_ROOT, podId],
    pinnedFile: 'README.md', onRun: () => { input.focus(); },
    fileSystem: {
      read: (path) => enqueueWorkspace(() => workspace.read(path)),
      write: (path, content) => enqueueWorkspace(() => workspace.write(path, checkedFileContent({ content }))),
      delete: (path) => enqueueWorkspace(() => workspace.delete(path)),
      list: () => enqueueWorkspace(() => workspace.list()),
    },
  });
  element('pod-id').textContent = podId;
  element('pod-boot').hidden = true;
  element('pod-app').hidden = false;
  document.title = `peerd · pod ${podId}`;
  promptLabel.textContent = `${cwd} $`;
  append('entry-meta', `Peerd Pod ready in ${Math.round(performance.now() - bootStarted)}ms. Run help.\n`);
  input.focus();
  browser.runtime.sendMessage({ type: 'pod/tab-ready', podId, bootMs: performance.now() - bootStarted }).catch(() => {});
})().catch((error) => {
  const boot = element('pod-boot');
  boot.hidden = false;
  boot.classList.add('is-failed');
  const title = boot.querySelector('h2');
  const detail = boot.querySelector('p');
  if (title) title.textContent = 'Pod failed to start';
  if (detail) detail.textContent = /** @type {{message?:string}} */ (error)?.message ?? String(error);
});
