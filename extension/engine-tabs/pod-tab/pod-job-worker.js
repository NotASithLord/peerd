// @ts-check
// One fresh sealed Worker per Pod command. The host owns every capability and
// pins it to the Pod id; this realm owns only parsing, pure userland, JS, and
// WASI linear memory. Terminating this Worker is cancellation.

import { podFetch } from './pod-realm-seal.js'; // MUST remain the first import
// why direct: importing peerd-engine's broad public barrel into the UNTRUSTED
// command heap would link unrelated browser/extension modules before the job.
// This pure leaf carries no authority and is the execution host's shared core.
// eslint-disable-next-line no-restricted-imports
import { executePodShell, matchPodGrep } from '../../peerd-engine/pod-shell.js';
import { demoModule, runWasiWorkspace } from '../notebook-tab/notebook-wasi.js';

const OUTPUT_CAP = 512 * 1024;
const PIPELINE_CAP = 16 * 1024 * 1024;
/** @type {Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>} */
const pending = new Map();
let requestSequence = 0;

/** @param {string} op @param {Record<string,unknown>} [args] */
const hostCall = (op, args = {}) => new Promise((resolve, reject) => {
  const rid = ++requestSequence;
  pending.set(rid, { resolve, reject });
  postMessage({ type: 'pod-request', rid, op, args });
});

/** @param {string} path @param {string} cwd */
export const resolvePodPath = (path, cwd) => {
  const raw = String(path || '.');
  const parts = raw.startsWith('/') ? [] : String(cwd || '/').split('/').filter(Boolean);
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`path escapes Pod workspace: ${path}`);
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

/** @param {string} path */
const basename = (path) => path.replace(/\/+$/, '').split('/').at(-1) || '';
/** @param {string} value */
const line = (value) => value.endsWith('\n') ? value : `${value}\n`;
/** @param {string} text */
const capped = (text) => {
  const marker = '\n[output truncated]\n';
  return text.length <= OUTPUT_CAP ? text : `${text.slice(0, OUTPUT_CAP - marker.length)}${marker}`;
};

const fs = Object.freeze({
  /** @param {string} path */ read: (path) => hostCall('fs-read', { path }),
  /** @param {string} path */ readBytes: (path) => hostCall('fs-read-bytes', { path }),
  /** @param {string} path @param {string|Uint8Array|ArrayBuffer} content */ write: (path, content) => hostCall('fs-write', { path, content }),
  /** @param {string} path @param {string} content */ append: (path, content) => hostCall('fs-append', { path, content }),
  /** @param {string} path */ listDir: (path) => hostCall('fs-list-dir', { path }),
  list: () => hostCall('fs-list'),
  /** @param {string} path */ stat: (path) => hostCall('fs-stat', { path }),
  /** @param {string} path */ exists: (path) => hostCall('fs-exists', { path }),
  /** @param {string} path @param {boolean} recursive */ mkdir: (path, recursive) => hostCall('fs-mkdir', { path, recursive }),
  /** @param {string} path @param {boolean} recursive */ remove: (path, recursive) => hostCall('fs-remove', { path, recursive }),
  /** @param {string} from @param {string} to @param {boolean} recursive */ copy: (from, to, recursive) => hostCall('fs-copy', { from, to, recursive }),
  /** @param {string} from @param {string} to */ move: (from, to) => hostCall('fs-move', { from, to }),
});

/** @param {string} path @param {string} cwd */
const readText = (path, cwd) => /** @type {Promise<string>} */ (fs.read(resolvePodPath(path, cwd)));
/** @param {string} path @param {string} content @param {{append:boolean,cwd:string}} opts */
const writeText = async (path, content, { append, cwd }) => {
  const target = resolvePodPath(path, cwd);
  if (append) await fs.append(target, content);
  else await fs.write(target, content);
};

/** @param {string[]} argv */
const parseFlags = (argv) => {
  const flags = new Set();
  /** @type {string[]} */
  const values = [];
  for (const arg of argv) {
    if (arg.startsWith('-') && arg !== '-') for (const flag of arg.slice(1)) flags.add(flag);
    else values.push(arg);
  }
  return { flags, values };
};

/** @param {string} path @param {string} cwd */
const destinationFor = async (path, cwd, /** @type {string} */ source) => {
  const target = resolvePodPath(path, cwd);
  try {
    const stat = /** @type {{kind?:string}} */ (await fs.stat(target));
    return stat.kind === 'directory' ? `${target.replace(/\/$/, '')}/${basename(source)}` : target;
  } catch { return target; }
};

/** @param {string[]} argv @param {string} stdin @param {string} cwd @param {Record<string,string>} env */
const runJavaScript = async (argv, stdin, cwd, env) => {
  let code = '';
  let entryPath = 'pod-command.js';
  /** @type {string[]} */ let args = [];
  if (argv[0] === '-e') { code = argv[1] ?? ''; args = argv.slice(2); }
  else if (argv[0]) {
    const resolved = resolvePodPath(argv[0], cwd);
    code = await readText(resolved, '/');
    entryPath = resolved.slice(1) || 'pod-command.js';
    args = argv.slice(1);
  }
  else code = stdin;
  if (!code.trim()) return { stdout: '', stderr: 'js: pass -e <code>, a file, or stdin\n', exitCode: 2 };
  try {
    return /** @type {Promise<{stdout:string,stderr:string,exitCode:number}>} */ (hostCall('js-run', { code, entryPath, args, stdin, cwd, env }));
  } catch (error) {
    return { stdout: '', stderr: `js: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 };
  }
};

/** @param {Uint8Array} module @param {string[]} args @param {string} stdin @param {string} cwd @param {Record<string,string>} env */
const runWasiTool = async (module, args, stdin, cwd, env) => {
  // Snapshot + reconcile must be one filesystem transaction: another job may
  // still compute concurrently, but its OPFS/Git operations queue until this
  // command has applied the WASI tree. Cancellation releases the host lock.
  await hostCall('workspace-lock');
  try {
    return await runWasiWorkspace(module, {
      args,
      stdin,
      env: { ...env, PWD: cwd },
      workspace: {
        list: () => /** @type {Promise<Array<{path:string,size:number}>>} */ (fs.list()),
        readBytes: (path) => /** @type {Promise<Uint8Array>} */ (fs.readBytes(`/${path}`)),
        write: (path, content) => fs.write(`/${path}`, content),
        delete: (path) => fs.remove(`/${path}`, false),
      },
    });
  } finally {
    await hostCall('workspace-unlock').catch(() => {});
  }
};

/** @param {{argv:string[],stdin:string,cwd:string,env:Record<string,string>}} input */
const runCommand = async ({ argv, stdin, cwd, env }) => {
  const [command = '', ...args] = argv;
  if (!command) return { stdout: '', stderr: '', exitCode: 0 };
  if (command === 'help') return { stdout: [
    'Peerd Pod commands:',
    '  pwd cd ls cat echo printf mkdir rm cp mv touch',
    '  head tail wc grep [-F] pattern [file] sort uniq env export unset sleep',
    '  js [-e code|file]   local Web-standard JavaScript on Chromium; no Node/network',
    '  wasi file.wasm ...  run a WASI Preview 1 command',
    '  install-tool name file.wasm; installed tools run by name',
    '  git <init|status|add|commit|log|branch|checkout|clone|fetch|push|remote>',
    '  curl <https-url>    audited, brokered HTTPS',
    '  jobs | kill <id>    inspect/cancel Pod jobs',
  ].join('\n').concat('\n'), stderr: '', exitCode: 0 };
  if (command === 'pwd') return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 };
  if (command === 'echo') {
    const newline = args[0] !== '-n';
    const values = newline ? args : args.slice(1);
    return { stdout: `${values.join(' ')}${newline ? '\n' : ''}`, stderr: '', exitCode: 0 };
  }
  if (command === 'printf') {
    const format = args.shift() ?? '';
    let valueIndex = 0;
    const stdout = format.replace(/%[sd]|\\[ntr]/g, (match) => {
      if (match === '\\n') return '\n';
      if (match === '\\t') return '\t';
      if (match === '\\r') return '\r';
      const value = args[valueIndex++] ?? '';
      return match === '%d' ? String(Number(value) || 0) : value;
    });
    return { stdout, stderr: '', exitCode: 0 };
  }
  if (command === 'cd') {
    const target = resolvePodPath(args[0] ?? env.HOME ?? '/', cwd);
    try {
      const stat = /** @type {{kind?:string}} */ (await fs.stat(target));
      if (stat.kind !== 'directory') throw new Error('not a directory');
      return { stdout: '', stderr: '', exitCode: 0, cwd: target };
    } catch (error) { return { stdout: '', stderr: `cd: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'ls') {
    const { flags, values } = parseFlags(args);
    const targets = values.length ? values : ['.'];
    const chunks = [];
    for (const raw of targets) {
      const target = resolvePodPath(raw, cwd);
      try {
        const stat = /** @type {{kind?:string,size?:number}} */ (await fs.stat(target));
        if (stat.kind === 'file') chunks.push(flags.has('l') ? `${stat.size ?? 0}\t${basename(target)}` : basename(target));
        else {
          const entries = /** @type {Array<{name:string,kind:string,size:number}>} */ (await fs.listDir(target));
          const visible = flags.has('a') ? entries : entries.filter((entry) => !entry.name.startsWith('.'));
          chunks.push(visible.map((entry) => flags.has('l')
            ? `${entry.kind === 'directory' ? 'd' : '-'}\t${entry.size}\t${entry.name}${entry.kind === 'directory' ? '/' : ''}`
            : `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join(flags.has('l') ? '\n' : '  '));
        }
      } catch (error) { return { stdout: '', stderr: `ls: ${raw}: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
    }
    return { stdout: chunks.filter(Boolean).map(line).join(''), stderr: '', exitCode: 0 };
  }
  if (command === 'cat') {
    if (!args.length) return { stdout: stdin, stderr: '', exitCode: 0 };
    try { return { stdout: (await Promise.all(args.map((path) => readText(path, cwd)))).join(''), stderr: '', exitCode: 0 }; }
    catch (error) { return { stdout: '', stderr: `cat: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'mkdir') {
    const { flags, values } = parseFlags(args);
    if (!values.length) return { stdout: '', stderr: 'mkdir: path required\n', exitCode: 2 };
    try { for (const path of values) await fs.mkdir(resolvePodPath(path, cwd), flags.has('p')); return { stdout: '', stderr: '', exitCode: 0 }; }
    catch (error) { return { stdout: '', stderr: `mkdir: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'rm') {
    const { flags, values } = parseFlags(args);
    if (!values.length) return { stdout: '', stderr: 'rm: path required\n', exitCode: 2 };
    try {
      for (const path of values) {
        const target = resolvePodPath(path, cwd);
        try { await fs.remove(target, flags.has('r') || flags.has('R')); }
        catch (error) { if (!flags.has('f')) throw error; }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (error) { return { stdout: '', stderr: `rm: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'cp' || command === 'mv') {
    const { flags, values } = parseFlags(args);
    if (values.length !== 2) return { stdout: '', stderr: `${command}: source and destination required\n`, exitCode: 2 };
    try {
      const source = resolvePodPath(values[0], cwd);
      const target = await destinationFor(values[1], cwd, source);
      if (command === 'cp') await fs.copy(source, target, flags.has('r') || flags.has('R'));
      else await fs.move(source, target);
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (error) { return { stdout: '', stderr: `${command}: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'touch') {
    if (!args.length) return { stdout: '', stderr: 'touch: path required\n', exitCode: 2 };
    try {
      for (const path of args) {
        const target = resolvePodPath(path, cwd);
        const content = await fs.exists(target) ? await fs.readBytes(target) : '';
        await fs.write(target, content);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (error) { return { stdout: '', stderr: `touch: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'env') return { stdout: `${Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, stderr: '', exitCode: 0 };
  if (command === 'export') {
    /** @type {Record<string,string>} */ const patch = {};
    for (const assignment of args) {
      const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (!match) return { stdout: '', stderr: `export: invalid assignment: ${assignment}\n`, exitCode: 2 };
      patch[match[1]] = match[2];
    }
    return { stdout: '', stderr: '', exitCode: 0, env: patch };
  }
  if (command === 'unset') return { stdout: '', stderr: '', exitCode: 0, unsetEnv: args.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) };
  if (command === 'sleep') {
    const milliseconds = Math.max(0, Math.min(300_000, Number(args[0] ?? 1) * 1000));
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (['head', 'tail', 'wc', 'grep', 'sort', 'uniq'].includes(command)) {
    const sourceArgs = [...args];
    let text = stdin;
    if (sourceArgs.at(-1) && !String(sourceArgs.at(-1)).startsWith('-') && command !== 'grep') {
      const possible = String(sourceArgs.at(-1));
      if (await fs.exists(resolvePodPath(possible, cwd))) { sourceArgs.pop(); text = await readText(possible, cwd); }
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (command === 'head' || command === 'tail') {
      const nIndex = sourceArgs.indexOf('-n');
      const count = Math.max(0, Number(nIndex >= 0 ? sourceArgs[nIndex + 1] : 10) || 10);
      const selected = command === 'head' ? lines.slice(0, count) : lines.slice(-count);
      return { stdout: selected.length ? `${selected.join('\n')}\n` : '', stderr: '', exitCode: 0 };
    }
    if (command === 'wc') {
      const bytes = new TextEncoder().encode(text).byteLength;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      return { stdout: `${lines.length} ${words} ${bytes}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'grep') {
      let fixed = false;
      while (sourceArgs[0]?.startsWith('-')) {
        const option = sourceArgs.shift();
        if (option === '-F' || option === '--fixed-strings') fixed = true;
        else return { stdout: '', stderr: `grep: unsupported option ${option}\n`, exitCode: 2 };
      }
      const pattern = sourceArgs.shift();
      if (!pattern) return { stdout: '', stderr: 'grep: pattern required\n', exitCode: 2 };
      if (sourceArgs[0]) text = await readText(sourceArgs[0], cwd);
      let matches;
      try { matches = matchPodGrep(text, pattern, { fixed }); }
      catch (error) { return { stdout: '', stderr: `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 2 }; }
      return { stdout: matches.length ? `${matches.join('\n')}\n` : '', stderr: '', exitCode: matches.length ? 0 : 1 };
    }
    if (command === 'sort') return { stdout: lines.length ? `${lines.sort((a, b) => a.localeCompare(b)).join('\n')}\n` : '', stderr: '', exitCode: 0 };
    const unique = lines.filter((value, index) => index === 0 || value !== lines[index - 1]);
    return { stdout: unique.length ? `${unique.join('\n')}\n` : '', stderr: '', exitCode: 0 };
  }
  if (command === 'true' || command === 'false') return { stdout: '', stderr: '', exitCode: command === 'true' ? 0 : 1 };
  if (command === 'js') return runJavaScript(args, stdin, cwd, env);
  if (command === 'wasi' || command === 'wasi-demo') {
    try {
      const module = command === 'wasi-demo' ? demoModule() : /** @type {Uint8Array} */ (await fs.readBytes(resolvePodPath(args.shift() ?? '', cwd)));
      const result = await runWasiTool(module, [command === 'wasi-demo' ? 'wasi-demo' : 'main.wasm', ...args], stdin, cwd, env);
      return {
        stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
        stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
      };
    } catch (error) { return { stdout: '', stderr: `wasi: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'install-tool') {
    const [name, source] = args;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name ?? '') || !source) return { stdout: '', stderr: 'install-tool: name and .wasm path required\n', exitCode: 2 };
    try {
      await fs.mkdir('/.peerd/tools', true);
      await fs.copy(resolvePodPath(source, cwd), `/.peerd/tools/${name}.wasm`, false);
      return { stdout: `installed ${name}\n`, stderr: '', exitCode: 0 };
    } catch (error) { return { stdout: '', stderr: `install-tool: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'git') {
    const result = /** @type {{stdout?:string,stderr?:string,exitCode?:number}} */ (await hostCall('git', { argv: args, cwd }));
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  }
  if (command === 'curl') {
    let method = 'GET';
    /** @type {Record<string,string>} */ const headers = {};
    let body;
    let outputPath = null;
    let url = '';
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-X' || arg === '--request') method = (args[++index] ?? 'GET').toUpperCase();
      else if (arg === '-H' || arg === '--header') {
        const header = args[++index] ?? '';
        const colon = header.indexOf(':');
        if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
      } else if (arg === '-d' || arg === '--data') { body = args[++index] ?? ''; if (method === 'GET') method = 'POST'; }
      else if (arg === '-o' || arg === '--output') outputPath = args[++index] ?? '';
      else if (arg === '-I' || arg === '--head') method = 'HEAD';
      else if (!arg.startsWith('-')) url = arg;
      else return { stdout: '', stderr: `curl: unsupported option ${arg}\n`, exitCode: 2 };
    }
    if (!url) return { stdout: '', stderr: 'curl: HTTPS URL required\n', exitCode: 2 };
    try {
      const response = await podFetch(url, { method, headers, body });
      const bytes = await response.bytes();
      if (outputPath) {
        await fs.write(resolvePodPath(outputPath, cwd), bytes);
        return { stdout: '', stderr: '', exitCode: response.ok ? 0 : 22 };
      }
      const truncated = bytes.byteLength > OUTPUT_CAP;
      const text = new TextDecoder().decode(truncated ? bytes.slice(0, OUTPUT_CAP) : bytes);
      return {
        stdout: text, stderr: response.ok ? '' : `curl: HTTP ${response.status}\n`,
        stdoutTruncated: truncated, exitCode: response.ok ? 0 : 22,
      };
    } catch (error) { return { stdout: '', stderr: `curl: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  if (command === 'jobs' || command === 'ps') {
    const jobs = /** @type {Array<any>} */ (await hostCall('jobs'));
    return { stdout: jobs.length ? `${jobs.map((job) => `${job.id}\t${job.state}\t${job.command}`).join('\n')}\n` : '', stderr: '', exitCode: 0 };
  }
  if (command === 'kill') {
    if (!args[0]) return { stdout: '', stderr: 'kill: job id required\n', exitCode: 2 };
    const result = /** @type {{cancelled?:boolean}} */ (await hostCall('cancel-job', { jobId: args[0] }));
    return { stdout: '', stderr: result.cancelled ? '' : `kill: no running job ${args[0]}\n`, exitCode: result.cancelled ? 0 : 1 };
  }
  const toolPath = `/.peerd/tools/${command}.wasm`;
  if (await fs.exists(toolPath)) {
    try {
      const result = await runWasiTool(/** @type {Uint8Array} */ (await fs.readBytes(toolPath)), [command, ...args], stdin, cwd, env);
      return {
        stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
        stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
      };
    } catch (error) { return { stdout: '', stderr: `${command}: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 1 }; }
  }
  return { stdout: '', stderr: `${command}: command not found\n`, exitCode: 127 };
};

let runAccepted = false;
addEventListener('message', (event) => {
  // A DedicatedWorker can only receive messages from its creator. Browsers
  // expose those messages with an empty origin; reject any non-empty origin
  // unless it is this exact extension origin as an additional fail-closed rail.
  if (event.origin !== '' && event.origin !== location.origin) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'pod-response') {
    const waiter = pending.get(message.rid);
    if (!waiter) return;
    pending.delete(message.rid);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);
    return;
  }
  if (message.type !== 'run' || runAccepted) return;
  runAccepted = true;
  const startedAt = performance.now();
  executePodShell(String(message.command ?? ''), {
    cwd: typeof message.cwd === 'string' ? message.cwd : '/',
    env: message.env && typeof message.env === 'object' ? message.env : {},
    runCommand,
    readText,
    writeText,
    maxOutputChars: OUTPUT_CAP,
    maxPipelineChars: PIPELINE_CAP,
  }).then((result) => {
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    postMessage({
      type: 'done',
      result: {
        ...result, stdout: capped(stdout), stderr: capped(stderr),
        stdoutTruncated: result.stdoutTruncated === true || stdout.length > OUTPUT_CAP,
        stderrTruncated: result.stderrTruncated === true || stderr.length > OUTPUT_CAP,
        durationMs: performance.now() - startedAt,
      },
    });
  }).catch((error) => {
    postMessage({ type: 'done', result: { stdout: '', stderr: `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`, exitCode: 2, durationMs: performance.now() - startedAt } });
  });
});
