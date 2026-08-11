// @ts-check
// Lightweight Pod shell core: parsing + pipeline/redirection orchestration.
//
// This is deliberately a shell, not POSIX emulation. It understands the small
// syntax agent workflows repeatedly need and delegates every command and byte of
// IO to injected capabilities. No browser globals, storage, network, or eval.

export class PodShellSyntaxError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PodShellSyntaxError';
  }
}

/** @typedef {{ text:string, expand:boolean }} WordSegment */
/** @typedef {{ type:'word', segments:WordSegment[] } | { type:'op', value:string }} ShellToken */
/** @typedef {{ type:'word', segments:WordSegment[] }} ShellWord */
/** @typedef {{ stdin?:ShellWord, stdout?:ShellWord, stdoutAppend?:boolean, stderr?:ShellWord, stderrAppend?:boolean }} Redirections */
/** @typedef {{ words:ShellWord[], redirections:Redirections }} ShellCommand */
/** @typedef {{ commands:ShellCommand[], connector:'always'|'and'|'or' }} ShellPipeline */
/** @typedef {{ pipelines:ShellPipeline[], background:boolean }} ShellProgram */
/** @typedef {{ stdout:string, stderr:string, exitCode:number, cwd?:string, env?:Record<string,string>, unsetEnv?:string[] }} CommandResult */

const OPERATORS = Object.freeze(['2>>', '2>', '>>', '&&', '||', '|', '>', '<', ';', '&']);

/** @param {WordSegment[]} segments @param {string} text @param {boolean} expand */
const appendSegment = (segments, text, expand) => {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.expand === expand) previous.text += text;
  else segments.push({ text, expand });
};

/**
 * Tokenize shell source without performing variable expansion. Quote origin is
 * retained per segment so expansion happens at execution time, after an earlier
 * `export` in the same program has taken effect.
 * @param {string} source
 * @returns {ShellToken[]}
 */
export const tokenizePodShell = (source) => {
  if (typeof source !== 'string') throw new PodShellSyntaxError('command must be a string');
  /** @type {ShellToken[]} */ const tokens = [];
  /** @type {WordSegment[]} */ let segments = [];
  let wordStarted = false;
  /** @type {'single'|'double'|null} */ let quote = null;

  const finishWord = () => {
    if (!wordStarted) return;
    tokens.push({ type: 'word', segments });
    segments = [];
    wordStarted = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === 'single') {
      if (char === "'") quote = null;
      else appendSegment(segments, char, false);
      wordStarted = true;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') { quote = null; wordStarted = true; continue; }
      if (char === '\\' && index + 1 < source.length) {
        index += 1;
        appendSegment(segments, source[index], false);
      } else appendSegment(segments, char, true);
      wordStarted = true;
      continue;
    }
    if (char === "'") { quote = 'single'; wordStarted = true; continue; }
    if (char === '"') { quote = 'double'; wordStarted = true; continue; }
    if (char === '\\') {
      if (index + 1 >= source.length) throw new PodShellSyntaxError('trailing backslash');
      index += 1;
      appendSegment(segments, source[index], false);
      wordStarted = true;
      continue;
    }
    if (/\s/.test(char)) { finishWord(); continue; }
    if (char === '#' && !wordStarted) break;
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      finishWord();
      tokens.push({ type: 'op', value: operator });
      index += operator.length - 1;
      continue;
    }
    appendSegment(segments, char, true);
    wordStarted = true;
  }
  if (quote) throw new PodShellSyntaxError(`unterminated ${quote} quote`);
  finishWord();
  return tokens;
};

/** @param {ShellToken|undefined} token @param {string} message @returns {ShellWord} */
const requireWord = (token, message) => {
  if (!token || token.type !== 'word') throw new PodShellSyntaxError(message);
  return token;
};

/**
 * Parse commands, pipelines, redirection, `;`, `&&`, `||`, and a trailing `&`.
 * @param {string} source
 * @returns {ShellProgram}
 */
export const parsePodShell = (source) => {
  const tokens = tokenizePodShell(source);
  /** @type {ShellPipeline[]} */ const pipelines = [];
  let index = 0;
  /** @type {'always'|'and'|'or'} */ let connector = 'always';
  let background = false;

  while (index < tokens.length) {
    /** @type {ShellCommand[]} */ const commands = [];
    for (;;) {
      /** @type {ShellWord[]} */ const words = [];
      /** @type {Redirections} */ const redirections = {};
      while (index < tokens.length) {
        const token = tokens[index];
        if (token.type === 'word') { words.push(token); index += 1; continue; }
        if (['<', '>', '>>', '2>', '2>>'].includes(token.value)) {
          const target = requireWord(tokens[index + 1], `redirection ${token.value} needs a path`);
          if (token.value === '<') redirections.stdin = target;
          else if (token.value === '>') { redirections.stdout = target; redirections.stdoutAppend = false; }
          else if (token.value === '>>') { redirections.stdout = target; redirections.stdoutAppend = true; }
          else if (token.value === '2>') { redirections.stderr = target; redirections.stderrAppend = false; }
          else { redirections.stderr = target; redirections.stderrAppend = true; }
          index += 2;
          continue;
        }
        break;
      }
      if (!words.length) throw new PodShellSyntaxError('expected a command');
      commands.push({ words, redirections });
      const separator = tokens[index];
      if (separator?.type === 'op' && separator.value === '|') { index += 1; continue; }
      break;
    }
    pipelines.push({ commands, connector });
    const separator = tokens[index];
    if (!separator) break;
    if (separator.type !== 'op') throw new PodShellSyntaxError('unexpected token');
    if (separator.value === '&') {
      if (index !== tokens.length - 1) throw new PodShellSyntaxError('background `&` is supported only at the end');
      background = true;
      index += 1;
      break;
    }
    if (![';', '&&', '||'].includes(separator.value)) {
      throw new PodShellSyntaxError(`unexpected operator ${separator.value}`);
    }
    connector = separator.value === '&&' ? 'and' : separator.value === '||' ? 'or' : 'always';
    index += 1;
    if (index >= tokens.length) throw new PodShellSyntaxError(`trailing operator ${separator.value}`);
  }
  return { pipelines, background };
};

/**
 * Identify Git operations that cross the local-workspace boundary. This reads
 * the parsed literal argv, not a substring: a quoted `git push` in an echo does
 * not earn authority, while a variable-expanded command earns none and fails
 * closed at the host. Used only to decide whether an agent dispatch may mint a
 * one-job remote-Git grant; the host independently refuses remote operations
 * without that grant.
 * @param {string} source
 * @returns {{op:'clone'|'fetch'|'push'|'link', url:string|null}|null}
 */
export const podGitRemoteIntent = (source) => {
  const program = parsePodShell(source);
  for (const pipeline of program.pipelines) {
    for (const command of pipeline.commands) {
      const words = command.words.map((word) => {
        const text = word.segments.map((segment) => segment.text).join('');
        return word.segments.some((segment) => segment.expand && segment.text.includes('$')) ? null : text;
      });
      if (words[0] !== 'git') continue;
      const subcommand = words[1];
      if (subcommand === 'clone') return { op: 'clone', url: words.find((word) => typeof word === 'string' && /^https:\/\//i.test(word)) ?? null };
      if (subcommand === 'fetch') return { op: 'fetch', url: null };
      if (subcommand === 'push') return { op: 'push', url: null };
      if (subcommand === 'remote' && (words[2] === 'add' || words[2] === 'set-url')) {
        return { op: 'link', url: words.find((word) => typeof word === 'string' && /^https:\/\//i.test(word)) ?? null };
      }
    }
  }
  return null;
};

/** @param {string} text @param {Record<string,string>} env @param {number} lastExit */
const expandText = (text, env, lastExit) => text.replace(
  /\$(\?|[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g,
  (_whole, raw) => raw === '?' ? String(lastExit) : (env[String(raw).replace(/^\{|\}$/g, '')] ?? ''),
);

/** @param {ShellToken} token @param {Record<string,string>} env @param {number} lastExit */
export const expandPodWord = (token, env, lastExit = 0) => {
  if (token.type !== 'word') throw new PodShellSyntaxError('expected word');
  let value = token.segments.map((segment) => segment.expand
    ? expandText(segment.text, env, lastExit)
    : segment.text).join('');
  if (value === '~') value = env.HOME ?? '/';
  else if (value.startsWith('~/')) value = `${env.HOME ?? '/'}${value.slice(1)}`;
  return value;
};

/** @param {unknown} result @returns {CommandResult} */
const normalizeResult = (result) => {
  const value = /** @type {Partial<CommandResult>|null} */ (result);
  return {
    stdout: typeof value?.stdout === 'string' ? value.stdout : '',
    stderr: typeof value?.stderr === 'string' ? value.stderr : '',
    exitCode: Number.isInteger(value?.exitCode) ? Number(value?.exitCode) : 0,
    ...(typeof value?.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(value?.env && typeof value.env === 'object' ? { env: value.env } : {}),
    ...(Array.isArray(value?.unsetEnv) ? { unsetEnv: value.unsetEnv.map(String) } : {}),
  };
};

/**
 * Execute a parsed shell program against injected command and file adapters.
 *
 * @param {ShellProgram|string} input
 * @param {Object} ctx
 * @param {string} [ctx.cwd]
 * @param {Record<string,string>} [ctx.env]
 * @param {number} [ctx.lastExit]
 * @param {(input:{ argv:string[], stdin:string, cwd:string, env:Record<string,string> })=>Promise<CommandResult>|CommandResult} ctx.runCommand
 * @param {(path:string,cwd:string)=>Promise<string>} ctx.readText
 * @param {(path:string,content:string,opts:{append:boolean,cwd:string})=>Promise<unknown>} ctx.writeText
 * @returns {Promise<CommandResult & { background:boolean }>}
 */
export const executePodShell = async (input, ctx) => {
  const program = typeof input === 'string' ? parsePodShell(input) : input;
  let cwd = ctx.cwd ?? '/';
  /** @type {Record<string,string>} */
  let env = { HOME: '/', PATH: '/.peerd/tools:/bin', ...(ctx.env ?? {}) };
  let lastExit = ctx.lastExit ?? 0;
  let stdout = '';
  let stderr = '';

  for (const pipeline of program.pipelines) {
    if (pipeline.connector === 'and' && lastExit !== 0) continue;
    if (pipeline.connector === 'or' && lastExit === 0) continue;
    let pipeInput = '';
    let pipelineStderr = '';
    for (const command of pipeline.commands) {
      const argv = command.words.map((word) => expandPodWord(word, env, lastExit));
      const redirections = command.redirections;
      let commandInput = pipeInput;
      if (redirections.stdin) {
        commandInput = await ctx.readText(expandPodWord(redirections.stdin, env, lastExit), cwd);
      }
      let result;
      try {
        result = normalizeResult(await ctx.runCommand({ argv, stdin: commandInput, cwd, env: { ...env } }));
      } catch (error) {
        result = {
          stdout: '',
          stderr: `${/** @type {{message?:string}} */ (error)?.message ?? String(error)}\n`,
          exitCode: 1,
        };
      }
      if (result.cwd) cwd = result.cwd;
      if (result.env) env = { ...env, ...result.env };
      for (const name of result.unsetEnv ?? []) delete env[name];
      lastExit = result.exitCode;
      if (redirections.stderr) {
        await ctx.writeText(expandPodWord(redirections.stderr, env, lastExit), result.stderr, {
          append: redirections.stderrAppend === true, cwd,
        });
      } else pipelineStderr += result.stderr;
      pipeInput = result.stdout;
      if (redirections.stdout) {
        await ctx.writeText(expandPodWord(redirections.stdout, env, lastExit), result.stdout, {
          append: redirections.stdoutAppend === true, cwd,
        });
        pipeInput = '';
      }
    }
    stdout += pipeInput;
    stderr += pipelineStderr;
  }
  return { stdout, stderr, exitCode: lastExit, cwd, env, background: program.background };
};
