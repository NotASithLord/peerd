// @ts-check
// Trusted host for one Pod. It owns rooted OPFS, brokered Git/fetch, and the
// job table; every command runs in a fresh sealed Worker with only RPC handles.
//
// Product boundary: Script is disposable JS, Notebook is a persistent JS
// workspace, Pod is this shell/WASI/Git layer, and WebVM is Linux compatibility.
// why: keeping Pod as a thin composition of existing hosts avoids owning a
// second filesystem, Node/POSIX compatibility layer, or browser Linux runtime.

import browser from '/vendor/browser-polyfill.js';
import { buildModule, createEditor, opfsHelpers, podGitRemoteOperation, POD_OPFS_ROOT } from '/peerd-engine/index.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';
import { isServiceWorkerSender } from '/shared/messaging.js';
import { buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS } from '../notebook-tab/worker-source.js';
import { createExternalWorkspaceLockManager } from './external-workspace-lock.js';
import { createPodJobOperationTracker, podJobState, podJobStatusMessage } from './job-state.js';

const podId = location.hash.slice(1).split(/[?&]/)[0];
const validPodId = /^pod-[a-z0-9-]+$/i.test(podId);

const MAX_JOB_OUTPUT = 512 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const JOB_HISTORY = 16;
const TERMINAL_ENTRY_HISTORY = 500;
const workspace = opfsHelpers([POD_OPFS_ROOT, podId]);
const firefoxRuntime = typeof browser.runtime.getBrowserInfo === 'function'
  ? browser.runtime.getBrowserInfo().then((info) => info.name === 'Firefox').catch(() => false)
  : Promise.resolve(false);
/** @typedef {{id:string,command:string,state:'running'|'completed'|'failed'|'cancelled',settling:boolean,completion:Promise<any>,workspaceOps:ReturnType<typeof createPodJobOperationTracker>,stdout:string,stderr:string,stdoutTruncated?:boolean,stderrTruncated?:boolean,exitCode:number|null,startedAt:number,finishedAt?:number,durationMs?:number,timeoutMs:number,worker:Worker,children:Set<Worker>,resolve?:(value:any)=>void,timer?:ReturnType<typeof setTimeout>,remoteGitGrant:true|{op:string,url:string}|null,remoteGitGrantConsumed:boolean,background:boolean,render:boolean,restoreTerminalFocus?:boolean,editorRevision?:number,settle?:(result:any)=>Promise<any>}} PodJob */
/** @type {Map<string, PodJob>} */ const jobs = new Map();
let jobSequence = 0;
let workspaceTail = Promise.resolve();
/** @type {Map<Worker,{release:()=>void,owned:boolean,cancelled:boolean,operationTail:Promise<void>}>} */ const workspaceLocks = new Map();
/** @type {string|null} */ let activeForegroundJobId = null;
let podRecord = { id: podId, name: podId, persistent: true };
let cwd = '/';
/** @type {Record<string,string>} */ let environment = { HOME: '/', PATH: '/.peerd/tools:/bin' };
/** @type {Awaited<ReturnType<typeof createEditor>>} */ let editor;

mountPullInPeerd();

/** @param {string} id */
const element = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const output = element('terminal-output');
const status = element('pod-status');
const jobStatus = element('pod-job-status');
const promptLabel = element('prompt-label');
const input = /** @type {HTMLInputElement} */ (element('terminal-input'));
const form = /** @type {HTMLFormElement} */ (element('terminal-form'));
const runButton = /** @type {HTMLButtonElement} */ (element('run-button'));
const stopButton = /** @type {HTMLButtonElement} */ (element('stop-button'));

/** @param {string} className @param {string} text */
const append = (className, text) => {
  if (!text) return;
  const node = document.createElement('span');
  node.className = `entry ${className}`;
  node.textContent = text;
  output.appendChild(node);
  while (output.childElementCount > TERMINAL_ENTRY_HISTORY) output.firstElementChild?.remove();
  output.scrollTop = output.scrollHeight;
};

const publicJob = (/** @type {any} */ job, { includeOutput = true } = {}) => ({
  id: job.id, command: job.command, state: job.state,
  cancelled: job.state === 'cancelled',
  exitCode: job.exitCode ?? null,
  startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
  durationMs: job.durationMs ?? (Date.now() - job.startedAt),
  timeoutMs: job.timeoutMs,
  stdoutChars: String(job.stdout ?? '').length,
  stderrChars: String(job.stderr ?? '').length,
  stdoutTruncated: job.stdoutTruncated === true,
  stderrTruncated: job.stderrTruncated === true,
  ...(includeOutput ? { stdout: job.stdout ?? '', stderr: job.stderr ?? '' } : {}),
});

const updateForegroundControls = () => {
  const running = activeForegroundJobId && jobs.get(activeForegroundJobId)?.state === 'running';
  input.disabled = !!running;
  runButton.hidden = !!running;
  stopButton.hidden = !running;
  status.textContent = [...jobs.values()].some((entry) => entry.state === 'running') ? 'running' : 'ready';
};

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
  const record = { release, owned: false, cancelled: false, operationTail: Promise.resolve() };
  workspaceLocks.set(worker, record);
  workspaceTail = previous.then(() => held);
  await previous;
  if (record.cancelled) { release(); workspaceLocks.delete(worker); throw new Error('workspace lock cancelled'); }
  record.owned = true;
};

/** @param {Worker} worker */
const releaseWorkspace = (worker) => {
  const record = workspaceLocks.get(worker);
  if (!record) return Promise.resolve(false);
  record.cancelled = true;
  if (!record.owned) return Promise.resolve(true);
  return record.operationTail.finally(() => {
    record.release();
    workspaceLocks.delete(worker);
  }).then(() => true);
};

/** @template T @param {Worker} worker @param {()=>Promise<T>} operation */
const withWorkspace = (worker, operation) => {
  const record = workspaceLocks.get(worker);
  if (!record?.owned) return enqueueWorkspace(operation);
  const result = record.operationTail.then(operation, operation);
  record.operationTail = result.then(() => undefined, () => undefined);
  return result;
};

/**
 * Run workspace work on behalf of one job. The inner assertion happens when
 * the serialized lane actually starts, not merely when the Worker requested
 * it, which prevents queued writes from landing after cancellation.
 * @template T @param {PodJob} job @param {Worker|null} worker @param {()=>Promise<T>} operation
 */
const withJobWorkspace = (job, worker, operation) => job.workspaceOps.track(() => {
  const guarded = () => {
    job.workspaceOps.assertAccepting();
    return operation();
  };
  return worker ? withWorkspace(worker, guarded) : enqueueWorkspace(guarded);
});

const externalWorkspaceLocks = createExternalWorkspaceLockManager({
  appendHold: () => {
    const previous = workspaceTail.catch(() => {});
    /** @type {()=>void} */ let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    workspaceTail = previous.then(() => held);
    return { wait: previous, release };
  },
});

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
  // resolver dependencies. Pod JS is local-only; source imports must already
  // exist in this Pod's workspace and network remains the shell's curl lane.
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
    throw new Error('Web-standard JS is unavailable in Firefox Pods: Peerd disables dynamic blob Workers pending Firefox MV3 compatibility and policy validation. Use WASI or a WebVM for this command.');
  }
  const entryPath = String(args.entryPath || 'pod-command.js');
  const resolverDeps = makePodResolverDeps();
  const built = await withJobWorkspace(job, null, () => buildWorkerSource(String(args.code ?? ''), {
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
  let stdoutChars = 0;
  let stderrChars = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  /** @param {string[]} target @param {string} text @param {'stdout'|'stderr'} stream */
  const pushOutput = (target, text, stream) => {
    const size = stream === 'stdout' ? stdoutChars : stderrChars;
    const remaining = Math.max(0, MAX_JOB_OUTPUT - size);
    if (remaining > 0) target.push(text.slice(0, remaining));
    const next = size + Math.min(text.length, remaining);
    if (stream === 'stdout') { stdoutChars = next; stdoutTruncated ||= text.length > remaining; }
    else { stderrChars = next; stderrTruncated ||= text.length > remaining; }
  };

  return new Promise((resolve) => {
    let settled = false;
    /** @param {{stdout:string,stderr:string,stdoutTruncated?:boolean,stderrTruncated?:boolean,exitCode:number}} result */
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
        const stream = target === stdout ? 'stdout' : 'stderr';
        pushOutput(target, `${String(message.text ?? '')}\n`, stream);
        return;
      }
      if (message.type === 'fetch-request') {
        worker.postMessage({ type: 'fetch-response', rid: message.rid, ok: false, error: 'Pod JavaScript has no network capability; use the audited curl command.' });
        return;
      }
      if (message.type === 'opfs-request') {
        try {
          let result;
          if (message.op === 'read') result = await withJobWorkspace(job, null, () => workspace.read(message.args.path));
          else if (message.op === 'write') {
            await withJobWorkspace(job, null, () => workspace.write(message.args.path, checkedFileContent(message.args)));
            result = null;
          } else if (message.op === 'delete') {
            await withJobWorkspace(job, null, () => workspace.remove(message.args.path));
            result = null;
          } else if (message.op === 'list') result = await withJobWorkspace(job, null, () => workspace.list());
          else if (message.op === 'compose-module') {
            const module = await withJobWorkspace(job, null, () => buildModule(message.args.path, resolverDeps, built.cache));
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
        if (value) pushOutput(stdout, `${value}${value.endsWith('\n') ? '' : '\n'}`, 'stdout');
        if (error) pushOutput(stderr, `${error}\n`, 'stderr');
        finish({ stdout: stdout.join(''), stderr: stderr.join(''), stdoutTruncated, stderrTruncated, exitCode: error ? 1 : 0 });
      }
    });
    worker.addEventListener('error', (event) => {
      const detail = mapWorkerError(event.error?.stack || event.message || 'worker crashed', workerUrl, built.bodyLine, entryPath);
      pushOutput(stderr, `worker error: ${detail}\n`, 'stderr');
      finish({ stdout: stdout.join(''), stderr: stderr.join(''), stdoutTruncated, stderrTruncated, exitCode: 1 });
    });
  });
};

/** @param {any} worker @param {any} message @param {PodJob} job */
const answerWorkerRequest = async (worker, message, job) => {
  const reply = (/** @type {any} */ result) => worker.postMessage({ type: 'pod-response', rid: message.rid, result });
  const fail = (/** @type {any} */ error) => worker.postMessage({ type: 'pod-response', rid: message.rid, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
  try {
    if (job.state !== 'running' || job.settling) throw new Error('Pod job is no longer running');
    const args = message.args ?? {};
    switch (message.op) {
      case 'workspace-lock': await acquireWorkspace(worker); reply(null); return;
      case 'workspace-unlock': await releaseWorkspace(worker); reply(null); return;
      case 'fs-read': reply(await withJobWorkspace(job, worker, () => workspace.read(args.path))); return;
      case 'fs-read-bytes': reply(await withJobWorkspace(job, worker, () => workspace.readBytes(args.path))); return;
      case 'fs-write': {
        await withJobWorkspace(job, worker, () => workspace.write(args.path, checkedFileContent(args))); reply(null); return;
      }
      case 'fs-append': {
        if (typeof args.content !== 'string') throw new Error('append content must be text');
        await withJobWorkspace(job, worker, async () => {
          const previous = await workspace.exists(args.path) ? await workspace.read(args.path) : '';
          await workspace.write(args.path, checkedFileContent({ content: `${previous}${args.content}` }));
        });
        reply(null); return;
      }
      case 'fs-list': reply(await withJobWorkspace(job, worker, () => workspace.list())); return;
      case 'fs-list-dir': reply(await withJobWorkspace(job, worker, () => workspace.listDir(args.path))); return;
      case 'fs-stat': reply(await withJobWorkspace(job, worker, () => workspace.stat(args.path))); return;
      case 'fs-exists': reply(await withJobWorkspace(job, worker, () => workspace.exists(args.path))); return;
      case 'fs-mkdir': await withJobWorkspace(job, worker, () => workspace.mkdir(args.path, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-remove': await withJobWorkspace(job, worker, () => workspace.remove(args.path, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-copy': await withJobWorkspace(job, worker, () => workspace.copy(args.from, args.to, { recursive: args.recursive === true })); reply(null); return;
      case 'fs-move': await withJobWorkspace(job, worker, () => workspace.move(args.from, args.to)); reply(null); return;
      case 'git': {
        const remoteOp = podGitRemoteOperation(args.argv);
        let remoteGrant = null;
        if (remoteOp) {
          if (job.remoteGitGrant === true) remoteGrant = true;
          else if (!job.remoteGitGrantConsumed && job.remoteGitGrant?.op === remoteOp) {
            remoteGrant = job.remoteGitGrant;
            job.remoteGitGrantConsumed = true;
          }
        }
        const response = /** @type {any} */ (await withJobWorkspace(job, worker, () => browser.runtime.sendMessage({
          type: 'pod/git', podId, jobId: job.id, argv: args.argv, cwd: args.cwd,
          remoteGrant,
        })));
        if (!response?.ok) throw new Error(response?.error ?? 'git failed');
        reply(response.result); return;
      }
      case 'js-run': reply(await runPodJavaScript(job, args)); return;
      case 'jobs': reply([...jobs.values()].map((entry) => publicJob(entry, { includeOutput: false }))); return;
      case 'cancel-job': reply(await cancelJob(String(args.jobId ?? ''))); return;
      default: throw new Error(`unknown Pod host operation: ${message.op}`);
    }
  } catch (error) { fail(error); }
};

/** @param {any} worker @param {any} message @param {PodJob} job */
const answerFetch = async (worker, message, job) => {
  try {
    if (job.state !== 'running') throw new Error('Pod job is no longer running');
    const response = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'pod/web-fetch', podId, jobId: job.id, url: message.url, method: message.method,
      headers: message.headers, body: message.body,
    }));
    worker.postMessage({ type: 'fetch-response', rid: message.rid, ...response });
  } catch (error) {
    worker.postMessage({ type: 'fetch-response', rid: message.rid, ok: false, status: 0, bodyB64: null, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) });
  }
};

/** @param {string} jobId */
const cancelJob = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job) return { jobId, cancelled: false, state: 'not_found' };
  if (job.state !== 'running') return { jobId, cancelled: false, state: job.state };
  if (job.settling) {
    await job.completion;
    return { jobId, cancelled: false, state: job.state };
  }
  browser.runtime.sendMessage({ type: 'pod/cancel-io', podId, jobId }).catch(() => {});
  await job.settle?.({ cancelled: true, exitCode: 130, durationMs: Date.now() - job.startedAt });
  return { jobId, cancelled: true, state: job.state };
};

/** @param {string} command @param {{jobId?:string,timeoutMs?:number,background?:boolean,render?:boolean,source?:'agent'|'user',remoteGitGrant?:true|{op:string,url:string}|null}} [options] */
const startJob = (command, { jobId, timeoutMs = 30_000, background = false, render = false, source = 'user', remoteGitGrant = null } = {}) => {
  if (!background && activeForegroundJobId && jobs.get(activeForegroundJobId)?.state === 'running') {
    throw new Error(`foreground job already running: ${activeForegroundJobId}; use background:true or cancel it first`);
  }
  const id = typeof jobId === 'string' && /^job-[a-z0-9-]{1,100}$/i.test(jobId)
    ? jobId : `job-${Date.now().toString(36)}-${(++jobSequence).toString(36)}`;
  if (jobs.has(id)) throw new Error(`duplicate Pod job id: ${id}`);
  const worker = new Worker('/engine-tabs/pod-tab/pod-job-worker.js', { type: 'module', name: `peerd-pod-${id}` });
  /** @type {(value:any)=>void} */ let resolve = () => {};
  const completion = new Promise((done) => { resolve = done; });
  const restoreTerminalFocus = !background && source === 'user' && document.activeElement === input;
  const job = /** @type {PodJob} */ ({
    id, command, state: 'running', settling: false, workspaceOps: createPodJobOperationTracker(),
    completion, stdout: '', stderr: '', exitCode: null,
    startedAt: Date.now(), timeoutMs, worker, children: new Set(), resolve,
    remoteGitGrant, remoteGitGrantConsumed: false, background, render, restoreTerminalFocus,
  });
  jobs.set(id, job);
  trimJobs();
  if (!background) activeForegroundJobId = id;
  updateForegroundControls();
  if (restoreTerminalFocus) stopButton.focus({ preventScroll: true });
  if (render) {
    append('entry-command', `${source === 'agent' ? '[agent] ' : ''}${cwd} $ ${command}\n`);
    append('entry-meta', `[${id} · running${background ? ' in background' : ''}]\n`);
  }
  const settle = async (/** @type {any} */ result) => {
    if (job.settling) return completion;
    if (job.state !== 'running') return publicJob(job);
    job.settling = true;
    clearTimeout(job.timer);
    try { worker.terminate(); } catch {}
    for (const child of job.children) try { child.terminate(); } catch {}
    job.children.clear();
    // Close admission before draining. OPFS writes cannot be interrupted once
    // started, so the terminal result is not observable until every admitted
    // host mutation has either completed or been refused at its queued gate.
    const release = releaseWorkspace(worker);
    await Promise.allSettled([release, job.workspaceOps.closeAndDrain()]);
    const rawStdout = String(result?.stdout ?? '');
    const rawStderr = String(result?.stderr ?? '');
    job.stdout = rawStdout.slice(0, MAX_JOB_OUTPUT);
    job.stderr = rawStderr.slice(0, MAX_JOB_OUTPUT);
    job.stdoutTruncated = result?.stdoutTruncated === true || rawStdout.length > MAX_JOB_OUTPUT;
    job.stderrTruncated = result?.stderrTruncated === true || rawStderr.length > MAX_JOB_OUTPUT;
    const exitCode = Number.isInteger(result?.exitCode) ? Number(result.exitCode) : 1;
    const terminalState = podJobState({ cancelled: result?.cancelled === true, exitCode });
    job.exitCode = exitCode;
    job.state = terminalState;
    job.finishedAt = Date.now();
    job.durationMs = Number(result?.durationMs ?? job.finishedAt - job.startedAt);
    // Background commands run as independent subshells: finishing last must
    // not race the interactive session's cwd or environment.
    if (!job.background && typeof result?.cwd === 'string') cwd = result.cwd;
    if (!job.background && result?.env && typeof result.env === 'object') environment = result.env;
    promptLabel.textContent = `${cwd} $`;
    const shouldRestoreTerminalFocus = job.restoreTerminalFocus === true
      && (document.activeElement === stopButton || document.activeElement === document.body);
    if (activeForegroundJobId === id) activeForegroundJobId = null;
    updateForegroundControls();
    jobStatus.textContent = podJobStatusMessage({
      id: job.id, state: terminalState, exitCode,
      stdout: job.stdout, stderr: job.stderr,
    });
    if (shouldRestoreTerminalFocus) input.focus({ preventScroll: true });
    if (render) {
      append('entry-stdout', job.stdout);
      append('entry-stderr', job.stderr);
      if (job.stdoutTruncated || job.stderrTruncated) append('entry-meta', '[output truncated in this terminal; redirect to a file before displaying large output, or ask the owning agent to page retained output]\n');
      append('entry-meta', job.state === 'cancelled'
        ? `[${job.id} · cancelled · ${Math.round(job.durationMs)}ms]\n`
        : `[${job.id} · exit ${job.exitCode} · ${Math.round(job.durationMs)}ms]\n`);
    }
    editor?.refreshExternalChanges?.({ ifRevision: job.editorRevision }).then((sync) => {
      if (sync?.conflict && render) append('entry-meta', `[${job.id} · editor changed during the command; active file was not reloaded]\n`);
    }).catch(() => editor?.refreshTree?.().catch(() => {}));
    resolve(publicJob(job));
    return publicJob(job);
  };
  job.settle = settle;
  job.timer = setTimeout(() => {
    if (job.state !== 'running') return;
    browser.runtime.sendMessage({ type: 'pod/cancel-io', podId, jobId: id }).catch(() => {});
    settle({ stderr: `timed out after ${timeoutMs}ms\n`, exitCode: 124, durationMs: timeoutMs }).catch(() => {});
  }, Math.min(300_000, Math.max(1, timeoutMs)));
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'pod-request') { answerWorkerRequest(worker, message, job); return; }
    if (message?.type === 'fetch-request') { answerFetch(worker, message, job); return; }
    if (message?.type === 'done') settle(message.result).catch(() => {});
  });
  worker.addEventListener('error', (event) => settle({ stderr: `worker error: ${event.message || 'unknown'}\n`, exitCode: 1 }).catch(() => {}));
  Promise.resolve(editor?.flushSave?.()).then(() => {
    job.editorRevision = editor?.getRevision?.();
    if (job.state === 'running') worker.postMessage({ type: 'run', command, cwd, env: environment });
  }).catch((error) => settle({ stderr: `editor save failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }).catch(() => {}));
  return background ? Promise.resolve(publicJob(job)) : completion;
};

const POD_ROUTES = new Set(['pod/exec', 'pod/status', 'pod/cancel', 'pod/read-file', 'pod/write-file', 'pod/list-files', 'pod/workspace-lock']);
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ message, /** @type {any} */ sender, /** @type {(value:any)=>void} */ sendResponse) => {
  if (!message || !isServiceWorkerSender(sender)
      || !POD_ROUTES.has(message.type) || message.podId !== podId) return false;
  (async () => {
    try {
      if (message.type === 'pod/exec') sendResponse({ ok: true, job: await startJob(String(message.command ?? ''), {
        jobId: message.jobId, timeoutMs: message.timeoutMs, background: message.background === true,
        remoteGitGrant: message.remoteGitGrant ?? null, render: true, source: 'agent',
      }) });
      else if (message.type === 'pod/status') {
        const selected = typeof message.jobId === 'string' ? jobs.get(message.jobId) : null;
        if (message.jobId && !selected) throw new Error(`Pod job not found: ${message.jobId}`);
        /** @type {any} */ let job = selected ? publicJob(selected, { includeOutput: false }) : null;
        if (selected && (message.stream === 'stdout' || message.stream === 'stderr')) {
          const stream = /** @type {'stdout'|'stderr'} */ (message.stream);
          const text = String(selected[stream] ?? '');
          const offset = Math.min(text.length, Math.max(0, Number(message.offset) || 0));
          const limit = Math.min(16_000, Math.max(1, Number(message.limit) || 8_000));
          const end = Math.min(text.length, offset + limit);
          job = { ...job, stream, offset, end, totalChars: text.length, remainingChars: text.length - end, output: text.slice(offset, end) };
        }
        sendResponse({ ok: true, status: {
          podId, name: podRecord.name, persistent: podRecord.persistent,
          state: [...jobs.values()].some((entry) => entry.state === 'running') ? 'running' : 'ready', cwd,
          ...(job ? { job } : { jobs: [...jobs.values()].map((entry) => publicJob(entry, { includeOutput: false })) }),
        } });
      }
      else if (message.type === 'pod/cancel') sendResponse({ ok: true, podId, ...(await cancelJob(String(message.jobId ?? ''))) });
      else if (message.type === 'pod/read-file') sendResponse({ ok: true, content: await enqueueWorkspace(() => workspace.read(message.path)) });
      else if (message.type === 'pod/write-file') {
        const content = checkedFileContent(message);
        let activeWrite = await editor.writeExternalActiveFile(message.path, content);
        if (activeWrite.conflict) {
          throw new Error(`active editor changed; read ${activeWrite.path} and retry the write`);
        }
        if (!activeWrite.handled) {
          await editor.flushSave();
          activeWrite = await editor.writeExternalActiveFile(message.path, content);
          if (activeWrite.conflict) {
            throw new Error(`active editor changed; read ${activeWrite.path} and retry the write`);
          }
        }
        if (!activeWrite.handled) {
          const revision = editor.getRevision();
          const fileRevision = editor.getFileRevision(message.path);
          await enqueueWorkspace(async () => {
            if (editor.getFileRevision(message.path) !== fileRevision) {
              throw new Error(`active editor changed; read ${activeWrite.path} and retry the write`);
            }
            await workspace.write(message.path, content);
          });
          const sync = await editor.refreshExternalChanges({ ifRevision: revision });
          if (editor.getFileRevision(message.path) !== fileRevision
              || (sync?.conflict && sync.path === activeWrite.path)) {
            await editor.flushSave();
            throw new Error(`active editor changed; read ${activeWrite.path} and retry the write`);
          }
        }
        sendResponse({ ok: true });
      }
      else if (message.type === 'pod/list-files') sendResponse({ ok: true, files: await enqueueWorkspace(() => workspace.list()) });
      else if (message.type === 'pod/workspace-lock') {
        const token = String(message.token ?? '');
        if (message.action === 'acquire') {
          sendResponse({ ok: true, ...(await externalWorkspaceLocks.acquire(token)) });
        } else if (message.action === 'renew') {
          if (!externalWorkspaceLocks.renew(token)) throw new Error('workspace lock lease not found');
          sendResponse({ ok: true });
        } else if (message.action === 'release') {
          sendResponse({ ok: true, released: externalWorkspaceLocks.release(token) });
        } else throw new Error('workspace lock action must be acquire, renew, or release');
      }
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
  try {
    startJob(command, { background, render: true, source: 'user', remoteGitGrant: true })
      .catch((error) => append('entry-stderr', `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`));
  } catch (error) {
    append('entry-stderr', `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`);
  }
});

stopButton.addEventListener('click', () => {
  if (activeForegroundJobId) cancelJob(activeForegroundJobId).catch(() => {});
});

(async () => {
  const bootStarted = performance.now();
  if (!validPodId) throw new Error('No valid podId in URL hash');
  const adopted = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'pod/tab-adopt', podId }));
  if (!adopted?.ok) throw new Error(adopted?.error ?? 'Pod tab could not be adopted');
  const meta = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'pod/get-meta', podId }));
  if (!meta?.ok) throw new Error(meta?.error ?? 'Pod metadata unavailable');
  podRecord = meta.record;
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
  element('pod-id').textContent = podRecord.name === podId ? podId : `${podRecord.name} · ${podId}`;
  if (!podRecord.persistent) {
    const lifecycle = element('pod-lifecycle');
    lifecycle.hidden = false;
    lifecycle.textContent = 'ephemeral · closing deletes files';
  }
  element('pod-boot').hidden = true;
  element('pod-app').hidden = false;
  document.title = `peerd · pod ${podRecord.name}`;
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
