// @ts-check
// The Pod `asc` command: the vendored AssemblyScript compiler runs in the
// command Worker, like `wasi`. All file access goes through the injected Pod
// workspace handles, so the compiler sees only this Pod and writes exact bytes.

/** @typedef {{write:(chunk:string|Uint8Array)=>boolean}} AscStream */
/** @typedef {{stdout:AscStream,stderr:AscStream,readFile:(name:string,baseDir:string)=>Promise<string|null>,writeFile:(name:string,contents:string|Uint8Array,baseDir:string)=>Promise<void>,listFiles:(dirname:string,baseDir:string)=>Promise<string[]|null>}} AscOptions */
/** @typedef {{main:(argv:string[],options:AscOptions)=>Promise<{error:Error|null}>}} AssemblyScriptCompiler */
/** @typedef {{read:(path:string)=>Promise<string>,write:(path:string,content:string|Uint8Array)=>Promise<unknown>,listDir:(path:string)=>Promise<Array<{name:string,kind:string}>>}} AscWorkspace */

export class AscCommandError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'AscCommandError'; }
}

const TRANSFORM_REFUSED = 'transforms run JavaScript, so a Pod does not allow them';

/** @param {string} text */
const configSetsTransform = (text) => {
  let config;
  try { config = JSON.parse(text); } catch { return false; }
  if (!config || typeof config !== 'object') return false;
  const sections = [config.options, ...Object.values(config.targets && typeof config.targets === 'object' ? config.targets : {})];
  return sections.some((section) => !!section && typeof section === 'object' && Object.hasOwn(section, 'transform'));
};

/** @param {string} name @param {string} baseDir */
const joined = (name, baseDir) => (name.startsWith('/') || !baseDir || baseDir === '.' ? name : `${baseDir}/${name}`);

/** @param {unknown} error */
const messageOf = (error) => /** @type {{message?:string}} */ (error)?.message ?? String(error);

/**
 * @param {string[]} argv
 * @param {{available:boolean, resolve:(path:string)=>string, workspace:AscWorkspace, loadCompiler:()=>Promise<AssemblyScriptCompiler>}} host
 * @returns {Promise<{stdout:string,stderr:string,exitCode:number}>}
 */
export const runAssemblyScript = async (argv, { available, resolve, workspace, loadCompiler }) => {
  if (!available) return { stdout: '', stderr: 'asc: the AssemblyScript compiler is only in the Preview build for Chrome.\n', exitCode: 127 };
  if (argv.some((arg) => arg === '--transform' || arg.startsWith('--transform='))) {
    return { stdout: '', stderr: `asc: ${TRANSFORM_REFUSED}.\n`, exitCode: 2 };
  }
  /** @type {string[]} */ const stdout = [];
  /** @type {string[]} */ const stderr = [];
  /** @param {string[]} chunks @returns {AscStream} */
  const stream = (chunks) => ({
    write: (chunk) => {
      // why: binary output to a terminal is unreadable; a file keeps the exact bytes.
      chunks.push(typeof chunk === 'string' ? chunk : 'asc: binary output is not shown here. Pass -o file.wasm.\n');
      return true;
    },
  });
  try {
    const compiler = await loadCompiler();
    // why --noColors: asc turns on ANSI colors when a CI variable is set.
    const { error } = await compiler.main(['--noColors', ...argv.map(String)], {
      stdout: stream(stdout),
      stderr: stream(stderr),
      readFile: async (name, baseDir) => {
        let text;
        // why null: asc probes candidate paths and expects null for a missing file.
        try { text = await workspace.read(resolve(joined(name, baseDir))); } catch { return null; }
        // why every file: --config and "extends" can name a config file with any name.
        if (configSetsTransform(text)) throw new AscCommandError(TRANSFORM_REFUSED);
        return text;
      },
      writeFile: async (name, contents, baseDir) => {
        // why copy: an output view can sit inside the compiler's whole memory buffer.
        await workspace.write(resolve(joined(name, baseDir)), typeof contents === 'string' ? contents : new Uint8Array(contents));
      },
      listFiles: async (dirname, baseDir) => {
        try {
          const entries = await workspace.listDir(resolve(joined(dirname, baseDir)));
          return entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
            .map((entry) => entry.name);
        } catch { return null; }
      },
    });
    const errorText = stderr.join('');
    return {
      stdout: stdout.join(''),
      stderr: error && !errorText ? `asc: ${messageOf(error)}\n` : errorText,
      exitCode: error ? 1 : 0,
    };
  } catch (error) {
    return { stdout: stdout.join(''), stderr: `${stderr.join('')}asc: ${messageOf(error)}\n`, exitCode: 1 };
  }
};
