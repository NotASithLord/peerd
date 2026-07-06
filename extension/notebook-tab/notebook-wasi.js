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
} from '../vendor/browser-wasi-shim/index.js';

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

/**
 * Build the in-memory Inode tree the module sees, from flat caller paths
 * ('data/input.txt' → nested Directories). Pure; exported for tests.
 * @param {Record<string, string | Uint8Array | ArrayBuffer>} files
 * @returns {Map<string, import('../vendor/browser-wasi-shim/index.js').Inode>}
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
