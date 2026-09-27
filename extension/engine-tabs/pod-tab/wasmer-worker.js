// @ts-check
import { wasmerThreads } from './wasmer-realm-seal.js'; // MUST remain the first import.
import { Wasmer } from '../../vendor/wasmer/dist/index.js';

const FILE_CAP = 16 * 1024 * 1024;
const WORKSPACE_CAP = 128 * 1024 * 1024;
const ENTRY_CAP = 2000;
const DEPTH_CAP = 64;
const OUTPUT_CAP = 512 * 1024;

/** @param {string} path */
const checkedPath = (path) => {
  const parts = path.split('/');
  if (!path || path.includes('\0') || parts.length > DEPTH_CAP
      || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Invalid Wasmer workspace path');
  }
  return path;
};

/** @param {Record<string,Uint8Array>} files */
const checkedFiles = (files) => {
  let total = 0;
  if (!files || typeof files !== 'object' || Object.keys(files).length > ENTRY_CAP) {
    throw new RangeError('Wasmer workspace file limit reached');
  }
  for (const [path, bytes] of Object.entries(files)) {
    checkedPath(path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILE_CAP) {
      throw new RangeError('Wasmer workspace file is too large');
    }
    total += bytes.byteLength;
    if (total > WORKSPACE_CAP) throw new RangeError('Wasmer workspace is too large');
  }
  return files;
};

/** @param {import('../../vendor/wasmer/dist/index.js').SandboxFileSystem} fs */
const readWorkspace = async (fs) => {
  /** @type {Record<string,Uint8Array>} */ const files = Object.create(null);
  let count = 0;
  let total = 0;
  /** @param {string} path @param {number} depth */
  const visit = async (path, depth) => {
    if (depth > DEPTH_CAP) throw new RangeError('Wasmer workspace is too deep');
    for (const entry of await fs.readDir(`/workspace${path ? `/${path}` : ''}`)) {
      if (++count > ENTRY_CAP) throw new RangeError('Wasmer workspace entry limit reached');
      if (entry.name.includes('/')) throw new TypeError('Invalid Wasmer workspace entry');
      const relative = checkedPath(path ? `${path}/${entry.name}` : entry.name);
      if (entry.kind === 'directory') await visit(relative, depth + 1);
      else {
        if (entry.kind !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0
            || entry.size > FILE_CAP || total + entry.size > WORKSPACE_CAP) {
          throw new RangeError('Wasmer workspace file is too large');
        }
        const bytes = await fs.readFile(`/workspace/${relative}`);
        total += bytes.byteLength;
        if (bytes.byteLength > FILE_CAP || total > WORKSPACE_CAP) {
          throw new RangeError('Wasmer workspace is too large');
        }
        files[relative] = bytes;
      }
    }
  };
  await visit('', 0);
  return files;
};

/** @param {{module:Uint8Array,runtimeModule:WebAssembly.Module,args?:string[],stdin?:string,cwd?:string,env?:Record<string,string>,files:Record<string,Uint8Array>,command?:string}} input */
const run = async (input) => {
  if (!(input.module instanceof Uint8Array) || !(input.runtimeModule instanceof WebAssembly.Module)) {
    throw new TypeError('Wasmer requires local module bytes');
  }
  const files = checkedFiles(input.files);
  const cwd = input.cwd || '/workspace';
  if (cwd !== '/workspace') checkedPath(cwd.startsWith('/workspace/') ? cwd.slice(11) : '');
  const wasmer = new Wasmer({ wasm: input.runtimeModule, cache: false, parallelism: 2, outputBytes: OUTPUT_CAP });
  /** @type {import('../../vendor/wasmer/dist/index.js').Sandbox|undefined} */ let sandbox;
  try {
    // why: Names can trigger registry access. Only local bytes enter the SDK.
    const pkg = await wasmer.packages.load(input.module);
    sandbox = await wasmer.sandboxes.create({ packages: [pkg], files, env: input.env, network: { mode: 'disabled' } });
    // why: a file snapshot does not contain an empty working directory.
    await sandbox.fs.mkdir(cwd, { recursive: true });
    const output = await sandbox.command(input.command || pkg, input.args || [], { cwd }).run({
      stdin: input.stdin || '', outputBytes: OUTPUT_CAP, check: false,
    });
    return {
      stdout: output.stdout.text(), stderr: output.stderr.text(), exitCode: output.exitCode,
      stdoutTruncated: output.stdout.truncated, stderrTruncated: output.stderr.truncated,
      files: await readWorkspace(sandbox.fs),
    };
  } finally {
    try { await sandbox?.close(); } finally { await wasmer.close(); }
  }
};

let accepted = false;
addEventListener('message', (event) => {
  if (event.data?.type !== 'wasmer-run' || accepted) return;
  accepted = true;
  run(event.data).then((result) => postMessage({ type: 'wasmer-done', result }))
    .catch((error) => postMessage({ type: 'wasmer-done', error: error?.message || String(error) }))
    .finally(() => wasmerThreads.close());
});
