// @ts-check
// why: only this trusted host can create Wasmer workers or persist their files.
// Runtime workers receive bytes. They receive no browser or filesystem handles.

import { reconcileWorkspaceFiles } from '../notebook-tab/notebook-wasi.js';
import { wasmerThreadPayload } from './wasmer-worker-proxy.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_WORKERS = 8;
const MAX_WORKER_STARTS = 32;
/** @type {Promise<WebAssembly.Module>|undefined} */
let runtimeModule;

export class WasmerHostError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'WasmerHostError'; }
}

/** @param {unknown} value @returns {string} */
export const checkedWasmerPath = (value) => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || value.split('/').length > MAX_DEPTH
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new WasmerHostError('Wasmer returned an unsafe workspace path.');
  }
  return value;
};

/** @param {unknown} value @returns {Record<string,Uint8Array>} */
export const checkedWasmerFiles = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WasmerHostError('Wasmer returned invalid files.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new WasmerHostError('Wasmer returned invalid files.');
  const entries = Object.entries(value);
  if (entries.length > MAX_FILES) throw new WasmerHostError('Wasmer workspace has too many files.');
  const paths = new Set(entries.map(([path]) => checkedWasmerPath(path)));
  let total = 0;
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  for (const [path, bytes] of entries) {
    const parents = path.split('/').slice(0, -1);
    while (parents.length) {
      if (paths.has(parents.join('/'))) throw new WasmerHostError('Wasmer returned conflicting workspace paths.');
      parents.pop();
    }
    // why: shared buffers can change after validation, including during a write.
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new WasmerHostError('Wasmer returned invalid file bytes.');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new WasmerHostError('Wasmer workspace file exceeds its byte limit.');
    total += bytes.byteLength;
    if (total > MAX_BYTES) throw new WasmerHostError('Wasmer workspace exceeds its byte limit.');
    files[path] = bytes;
  }
  return files;
};

/** @typedef {{id:string,state:string,settling:boolean,children:Set<Worker>,workspaceOps:{assertAccepting:()=>void}}} Job */

/** @param {Job} job */
const assertRunning = (job) => {
  if (job.state !== 'running' || job.settling) throw new WasmerHostError('Wasmer job stopped.');
  job.workspaceOps.assertAccepting();
};

/** @param {Job} job @param {Record<string,any>} input */
const runWorkers = (job, input) => new Promise((resolve, reject) => {
  assertRunning(job);
  const worker = new Worker(new URL('./wasmer-worker.js', import.meta.url), { type: 'module', name: `peerd-wasmer-${job.id}` });
  const terminate = worker.terminate.bind(worker);
  /** @type {Map<number,Worker>} */ const threads = new Map();
  let starts = 0;
  let settled = false;
  const finish = (/** @type {any} */ result, /** @type {Error|undefined} */ error) => {
    if (settled) return;
    settled = true;
    terminate();
    job.children.delete(worker);
    for (const thread of threads.values()) { thread.terminate(); job.children.delete(thread); }
    threads.clear();
    if (error) reject(error); else resolve(result);
  };
  // why: cancellation must also release the pending workspace transaction.
  worker.terminate = () => finish(null, new WasmerHostError('Wasmer job stopped.'));
  job.children.add(worker);
  worker.addEventListener('error', (event) => finish(null, new WasmerHostError(event.message || 'Wasmer worker failed.')));
  worker.addEventListener('message', (event) => {
    if (settled) return;
    try {
      assertRunning(job);
      const message = event.data;
      if (message?.type === 'wasmer-done') {
        finish(message.result, message.error ? new WasmerHostError(String(message.error)) : undefined);
        return;
      }
      if (!Number.isSafeInteger(message?.id) || message.id < 1) throw new WasmerHostError('Invalid Wasmer worker request.');
      if (message.type === 'wasmer-thread-create') {
        const expected = new URL('../../vendor/wasmer/dist/browser-worker.js', import.meta.url).href;
        if (message.url !== expected || message.options?.type !== 'module' || threads.has(message.id)
            || threads.size >= MAX_WORKERS || ++starts > MAX_WORKER_STARTS) {
          throw new WasmerHostError('Wasmer worker request exceeds its fixed capability.');
        }
        const thread = new Worker(new URL('./wasmer-thread-worker.js', import.meta.url), { type: 'module', name: `peerd-wasmer-thread-${job.id}-${message.id}` });
        threads.set(message.id, thread);
        job.children.add(thread);
        thread.addEventListener('message', (reply) => {
          if (!settled && threads.get(message.id) === thread) worker.postMessage({ type: 'wasmer-thread-event', id: message.id, event: 'message', data: reply.data });
        });
        thread.addEventListener('error', (failure) => finish(null, new WasmerHostError(failure.message || 'Wasmer thread failed.')));
      } else if (message.type === 'wasmer-thread-post') {
        const thread = threads.get(message.id);
        if (!thread) throw new WasmerHostError('Unknown Wasmer worker.');
        // why: the SDK unwraps this envelope before it imports sdkUrl.
        const payload = wasmerThreadPayload(message.data);
        if (payload?.type === 'init'
            && payload.sdkUrl !== new URL('../../vendor/wasmer/pkg/wasmer_sdk_js.js', import.meta.url).href) {
          throw new WasmerHostError('Wasmer requested an untrusted SDK module.');
        }
        thread.postMessage(message.data);
      } else if (message.type === 'wasmer-thread-terminate') {
        const thread = threads.get(message.id);
        if (thread) { thread.terminate(); job.children.delete(thread); threads.delete(message.id); }
      } else throw new WasmerHostError('Wasmer requested an unsupported host operation.');
    } catch (error) { finish(null, error instanceof Error ? error : new WasmerHostError(String(error))); }
  });
  worker.postMessage({ ...input, type: 'wasmer-run' });
});

/**
 * The caller holds the Pod workspace queue through snapshot, run, and persistence.
 * @param {Job} job
 * @param {any} args
 * @param {ReturnType<typeof import('../../peerd-engine/opfs.js').opfsHelpers>} workspace
 */
export const runPodWasmer = async (job, args, workspace) => {
  assertRunning(job);
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    throw new WasmerHostError('Wasmer requires a browser with cross-origin isolation and SharedArrayBuffer.');
  }
  if (!(args.module instanceof Uint8Array) || !args.module.byteLength || args.module.byteLength > MAX_FILE_BYTES) {
    throw new WasmerHostError('Wasmer requires a local module within the Pod file limit.');
  }
  const cwd = args.cwd === '/' ? '/workspace' : `/workspace/${checkedWasmerPath(String(args.cwd ?? '').replace(/^\//, ''))}`;
  const entries = await workspace.list();
  if (entries.length > MAX_FILES || entries.some((entry) => entry.size > MAX_FILE_BYTES)
      || entries.reduce((size, entry) => size + entry.size, 0) > MAX_BYTES) {
    throw new WasmerHostError('Pod workspace exceeds the Wasmer snapshot limit.');
  }
  /** @type {Record<string,Uint8Array>} */ const before = Object.create(null);
  for (const entry of entries) {
    assertRunning(job);
    before[checkedWasmerPath(entry.path.replace(/^\//, ''))] = await workspace.readBytes(entry.path);
  }
  checkedWasmerFiles(before);
  // why: only the trusted host reads this fixed extension asset. No SDK runs here.
  // eslint-disable-next-line no-restricted-globals
  runtimeModule ??= fetch(new URL('../../vendor/wasmer/pkg/wasmer_sdk_js_bg.wasm', import.meta.url))
    .then((response) => {
      if (!response.ok) throw new WasmerHostError('Wasmer runtime could not load.');
      return response.arrayBuffer();
    }).then((bytes) => WebAssembly.compile(bytes)).catch((error) => { runtimeModule = undefined; throw error; });
  const compiled = await runtimeModule;
  assertRunning(job);
  const result = await runWorkers(job, {
    module: args.module, runtimeModule: compiled, cwd,
    args: Array.isArray(args.args) ? args.args.map(String) : [],
    stdin: String(args.stdin ?? ''), env: { ...args.env, PWD: cwd }, files: before,
    ...(typeof args.command === 'string' ? { command: args.command } : {}),
  });
  assertRunning(job);
  if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new WasmerHostError('Wasmer returned an invalid result.');
  }
  const after = checkedWasmerFiles(result.files);
  const changes = reconcileWorkspaceFiles(before, after);
  // why: validate the whole result before admitting the first persistent change.
  for (const path of changes.deletes) { assertRunning(job); await workspace.delete(path); }
  for (const [path, bytes] of Object.entries(changes.writes)) {
    assertRunning(job);
    await workspace.write(path, bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes);
  }
  return {
    stdout: result.stdout.slice(0, 512 * 1024), stderr: result.stderr.slice(0, 512 * 1024), exitCode: result.exitCode,
    stdoutTruncated: result.stdoutTruncated === true || result.stdout.length > 512 * 1024,
    stderrTruncated: result.stderrTruncated === true || result.stderr.length > 512 * 1024,
  };
};
