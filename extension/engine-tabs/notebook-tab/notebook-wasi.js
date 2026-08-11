// @ts-check
// notebook-tab/notebook-wasi.js — `peerd:wasi`, WASI modules in the sealed worker.
//
// Imported EXPLICITLY in Notebook/script code — `import { runWasi } from
// 'peerd:wasi'` (same builtin pattern as peerd:std; the resolver maps the bare
// specifier to this file). It runs a wasm32-wasi COMMAND module — a compiled
// binary that reads stdin/files, computes, writes stdout/files, exits — against
// a virtual, IN-MEMORY filesystem, entirely inside the already-sealed worker
// realm. This is the engine spectrum's middle tier: heavier than plain JS
// compute, far lighter than booting the WebVM — "run a real compiled tool over
// some bytes" without a Linux.
//
// SECURITY — additive to the realm seal, never a hole through it:
//   • A wasm module has NO ambient capabilities. Its only imports are the WASI
//     preview1 syscalls the vendored shim implements (vendor/browser-wasi-shim,
//     audited: zero network/eval primitives), and every fd behind those
//     syscalls is an object THIS wrapper constructs — stdin bytes, two capped
//     stdout/stderr collectors, and an in-memory file tree seeded from the
//     caller's `files`. No OPFS handle, no bridge, no clock beyond what the
//     shim computes locally. Egress from wasm is not reduced-to-JS-parity; it
//     is STRUCTURALLY ABSENT.
//   • Module bytes are DATA (fetched via audited peerd.egress.fetch, read from
//     OPFS, or inlined) — running them adds no authority the sealed realm
//     didn't already have. CPU is bounded by the host's existing wall-clock
//     (the worker is terminated at timeout); memory by the module's own
//     declared memory + the collector caps below.
//   • Reactor modules (no _start) are refused: a command RUNS AND EXITS, which
//     keeps every run reproducible (fresh WASI state per call, like the fresh
//     worker per run).

import {
  WASI, File, Directory, OpenFile, PreopenDirectory, ConsoleStdout,
} from '../../vendor/browser-wasi-shim/index.js';

// Per-stream collector cap. Generous for tool output, small enough that a
// runaway printf loop can't balloon the 'done' postMessage payload.
const MAX_STREAM_BYTES = 512 * 1024;

/** why a named subclass: convention (CLAUDE.md) — lets calling code (and the
 * agent reading a stack) tell "this module can't run here" from a platform bug. */
export class WasiRunError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'WasiRunError';
  }
}

/** @param {unknown} v @returns {Uint8Array} */
const toBytes = (v) => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'string') return new TextEncoder().encode(v);
  throw new TypeError(`expected string, Uint8Array, or ArrayBuffer, got ${typeof v}`);
};

// A known-good wasm32-wasi command module, embedded so runWasi is
// SELF-TESTABLE from inside the sealed worker: `runWasi(demoModule())` →
// { exitCode: 0, stdout: "hello from wasi\n" } with no network, no toolchain,
// no hunting the web for a binary (a live agent burned a whole session on
// exactly that hunt). Hand-assembled — fd_write the message to stdout, then
// proc_exit 0 — and regenerable from source:
// tests/engine-tabs/notebook-tab/wasi-test-module.ts buildHelloModule('hello from wasi\n')
// (the bun suite pins these bytes against that builder, so blob and source
// cannot drift).
const DEMO_MODULE_B64 =
  'AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQ'
  + 'AAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0'
  + 'YXJ0AAIKIQEfAEEAQRA2AgBBBEEQNgIAQQFBAEEBQQwQABpBABABCwsWAQBBEAsQaGVsbG8gZnJvbSB3YXNpCg==';

/**
 * A tiny (187-byte) known-good WASI command module for smoke-testing runWasi.
 * `await runWasi(demoModule())` prints "hello from wasi\n" and exits 0.
 * @returns {Uint8Array}
 */
export const demoModule = () => Uint8Array.from(atob(DEMO_MODULE_B64), (c) => c.charCodeAt(0));

/**
 * Build the in-memory Inode tree the module sees, from flat caller paths
 * ('data/input.txt' → nested Directories). Pure; exported for tests.
 * @param {Record<string, string | Uint8Array | ArrayBuffer>} files
 * @returns {Map<string, import('../../vendor/browser-wasi-shim/index.js').Inode>}
 */
export const buildFileTree = (files) => {
  /** @type {Map<string, any>} */
  const root = new Map();
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (!segments.length) throw new TypeError(`invalid file path: ${JSON.stringify(path)}`);
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let node = dir.get(segment);
      if (!node) {
        node = new Directory(new Map());
        dir.set(segment, node);
      }
      if (!(node instanceof Directory)) {
        throw new TypeError(`file path conflict: ${segment} in ${path} is already a file`);
      }
      dir = node.contents;
    }
    dir.set(segments[segments.length - 1], new File(toBytes(content)));
  }
  return root;
};

/**
 * Read the tree back to flat paths after the run. A file that decodes as UTF-8
 * comes back as a string (the common case: tool output); anything else stays
 * Uint8Array. Pure; exported for tests.
 * @param {Map<string, any>} tree
 * @param {string} [prefix]
 * @param {Record<string, string | Uint8Array>} [out]
 * @returns {Record<string, string | Uint8Array>}
 */
export const readFileTree = (tree, prefix = '', out = {}) => {
  for (const [name, node] of tree) {
    if (node instanceof Directory) readFileTree(node.contents, `${prefix}${name}/`, out);
    else if (node instanceof File) {
      try {
        out[`${prefix}${name}`] = new TextDecoder('utf-8', { fatal: true }).decode(node.data);
      } catch {
        out[`${prefix}${name}`] = node.data;
      }
    }
  }
  return out;
};

/** A byte-capped stdout/stderr sink. Copies each chunk (the shim may hand us a
 * view into wasm memory that the module then overwrites).
 * @param {number} cap */
const makeStreamCollector = (cap) => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  let truncated = false;
  const fd = new ConsoleStdout((buffer) => {
    if (truncated) return;
    if (size + buffer.length > cap) {
      chunks.push(buffer.slice(0, cap - size));
      size = cap;
      truncated = true;
      return;
    }
    chunks.push(buffer.slice());
    size += buffer.length;
  });
  const text = () => {
    const all = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(all);
  };
  return { fd, text, wasTruncated: () => truncated };
};

/**
 * Run one wasm32-wasi command module to completion.
 *
 * @param {Uint8Array | ArrayBuffer | WebAssembly.Module} module  the wasm bytes
 *   (fetched, read from OPFS as bytes, or inlined) or a precompiled Module.
 * @param {Object} [opts]
 * @param {string[]} [opts.args]  argv INCLUDING argv[0] (defaults to ['main.wasm'])
 * @param {Record<string, string>} [opts.env]
 * @param {string | Uint8Array} [opts.stdin]
 * @param {Record<string, string | Uint8Array | ArrayBuffer>} [opts.files]
 *   seed files for the virtual FS, visible to the module under both '/' and
 *   '.' (precompiled binaries disagree on which they open; both preopens share
 *   ONE tree, so writes through either land in the same place).
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string,
 *   files: Record<string, string | Uint8Array>,
 *   stdoutTruncated: boolean, stderrTruncated: boolean }>}
 */
export const runWasi = async (module, { args = [], env = {}, stdin = '', files = {} } = {}) => {
  const compiled = module instanceof WebAssembly.Module
    ? module
    : await WebAssembly.compile(/** @type {BufferSource} */ (toBytes(module)));

  const tree = buildFileTree(files);
  const stdout = makeStreamCollector(MAX_STREAM_BYTES);
  const stderr = makeStreamCollector(MAX_STREAM_BYTES);
  const fds = [
    new OpenFile(new File(toBytes(stdin))),   // 0: stdin
    stdout.fd,                                // 1: stdout
    stderr.fd,                                // 2: stderr
    new PreopenDirectory('.', tree),          // 3+: the virtual FS, one shared
    new PreopenDirectory('/', tree),          //     tree under both names
  ];
  const argv = args.length ? args.map(String) : ['main.wasm'];
  const envp = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  // why debug:false explicitly: the shim's constructor calls
  // debug.enable(options.debug) unconditionally, and enable(undefined) turns
  // the logger ON — omitting the option floods the captured console with a
  // "wasi:" line per syscall.
  const wasiHost = new WASI(argv, envp, fds, { debug: false });

  let instance;
  try {
    instance = await WebAssembly.instantiate(compiled, {
      wasi_snapshot_preview1: wasiHost.wasiImport,
    });
  } catch (e) {
    // The one link failure worth translating: the module wants imports beyond
    // the WASI preview1 surface (emscripten env.*, wasi_unstable, …).
    throw new WasiRunError(`module instantiation failed — peerd:wasi provides the WASI preview1 syscalls and nothing else: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  }
  const exports = /** @type {{ memory?: WebAssembly.Memory, _start?: () => unknown }} */ (instance.exports);
  if (typeof exports._start !== 'function' || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new WasiRunError('not a WASI command module: expected exported `_start` and `memory` (reactor modules are not supported)');
  }

  // start() drives _start() and turns the module's proc_exit into a return
  // value; a genuine trap (unreachable, OOB) still throws and surfaces as the
  // run's error, same as a JS throw would.
  const exitCode = wasiHost.start(/** @type {any} */ (instance));

  return {
    exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    files: readFileTree(tree),
    stdoutTruncated: stdout.wasTruncated(),
    stderrTruncated: stderr.wasTruncated(),
  };
};

/** @param {string|Uint8Array|ArrayBuffer} left @param {string|Uint8Array|ArrayBuffer} right */
const sameFileBytes = (left, right) => {
  const a = toBytes(left);
  const b = toBytes(right);
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
};

/**
 * Compute the minimal write/delete reconciliation between two flat WASI trees.
 * Pure and exported so the workspace authority adapter is independently tested.
 *
 * @param {Record<string,string|Uint8Array|ArrayBuffer>} before
 * @param {Record<string,string|Uint8Array|ArrayBuffer>} after
 */
export const reconcileWorkspaceFiles = (before, after) => {
  /** @type {Record<string,string|Uint8Array|ArrayBuffer>} */
  const writes = Object.create(null);
  for (const [path, content] of Object.entries(after)) {
    if (!Object.hasOwn(before, path) || !sameFileBytes(before[path], content)) writes[path] = content;
  }
  const deletes = Object.keys(before).filter((path) => !Object.hasOwn(after, path));
  return { writes, deletes };
};

/**
 * Run a WASI command against a snapshot of a host-provided workspace and apply
 * only its resulting changes. The adapter is an explicit byte capability: no
 * OPFS handle, browser storage object, or network primitive enters WASM.
 *
 * The snapshot boundary is intentional: Preview 1 syscalls are synchronous,
 * while portable OPFS access is asynchronous. A synchronous OPFS mount would
 * require SharedArrayBuffer/Atomics (losing Firefox/extension portability) or a
 * second filesystem runtime. Snapshot + minimal reconciliation keeps one
 * durable filesystem and preserves the current `runWasi()` isolation contract.
 *
 * @param {Uint8Array|ArrayBuffer|WebAssembly.Module} module
 * @param {Object} opts
 * @param {{ list:()=>Promise<Array<{path:string,size?:number}>>, readBytes:(path:string)=>Promise<Uint8Array>, write:(path:string,content:string|Uint8Array|ArrayBuffer)=>Promise<unknown>, delete:(path:string)=>Promise<unknown> }} opts.workspace
 * @param {string[]} [opts.args]
 * @param {Record<string,string>} [opts.env]
 * @param {string|Uint8Array} [opts.stdin]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxFileBytes]
 */
export const runWasiWorkspace = async (module, {
  workspace, args = [], env = {}, stdin = '', maxFiles = 2_000,
  maxBytes = 128_000_000, maxFileBytes = 16 * 1024 * 1024,
}) => {
  if (!workspace?.list || !workspace?.readBytes || !workspace?.write || !workspace?.delete) {
    throw new TypeError('runWasiWorkspace: a byte workspace capability is required');
  }
  const entries = await workspace.list();
  if (entries.length > maxFiles) throw new WasiRunError(`workspace has too many files: ${entries.length} > ${maxFiles}`);
  /** @type {Record<string,Uint8Array>} */
  const before = Object.create(null);
  /** @param {unknown} value */
  const checkedPath = (value) => {
    const raw = String(value ?? '');
    const path = raw.replace(/^\/+/, '');
    if (!path || raw.includes('\\') || raw.includes('\0')
        || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new WasiRunError(`unsafe WASI workspace path: ${JSON.stringify(raw)}`);
    }
    return path;
  };
  let declaredBytes = 0;
  for (const entry of entries) {
    checkedPath(entry.path);
    if (typeof entry.size === 'number') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileBytes) {
        throw new WasiRunError(`workspace file exceeds the WASI per-file budget: ${entry.path}`);
      }
      declaredBytes += entry.size;
      if (declaredBytes > maxBytes) throw new WasiRunError(`workspace exceeds the WASI snapshot budget: ${declaredBytes} > ${maxBytes} bytes`);
    }
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const path = checkedPath(entry.path);
    const bytes = await workspace.readBytes(path);
    if (bytes.byteLength > maxFileBytes) throw new WasiRunError(`workspace file exceeds the WASI per-file budget: ${path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw new WasiRunError(`workspace exceeds the WASI snapshot budget: ${totalBytes} > ${maxBytes} bytes`);
    before[path] = bytes;
  }
  const result = await runWasi(module, { args, env, stdin, files: before });
  const outputEntries = Object.entries(result.files);
  if (outputEntries.length > maxFiles) throw new WasiRunError(`WASI output has too many files: ${outputEntries.length} > ${maxFiles}`);
  let outputBytes = 0;
  for (const [rawPath, content] of outputEntries) {
    checkedPath(rawPath);
    const size = toBytes(content).byteLength;
    if (size > maxFileBytes) throw new WasiRunError(`WASI output file exceeds the per-file budget: ${rawPath}`);
    outputBytes += size;
    if (outputBytes > maxBytes) throw new WasiRunError(`WASI output exceeds the workspace budget: ${outputBytes} > ${maxBytes} bytes`);
  }
  const changes = reconcileWorkspaceFiles(before, result.files);
  // why deletes first: a command may replace a file with a directory tree at
  // the same path. Removing stale leaves before writes mirrors command exit.
  for (const path of changes.deletes) await workspace.delete(path);
  for (const [path, content] of Object.entries(changes.writes)) await workspace.write(path, content);
  return {
    ...result,
    changedFiles: Object.keys(changes.writes).sort(),
    deletedFiles: changes.deletes.sort(),
  };
};
