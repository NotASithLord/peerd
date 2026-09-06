// @ts-check

/** @typedef {'file'|'tab'} ComposerRefKind */
/** @typedef {{kind:ComposerRefKind,arg:string,raw:string,start:number,end:number}} ComposerRefToken */

const COMMAND_RE = /^\s*\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?=\s|$)/;
const REF_RE = /(^|\s)@(tab|file)(?::([^\s@]+))?/g;

/** @param {string} source */
export const parseComposerCommandName = (source) => COMMAND_RE.exec(source)?.[1] ?? null;

/** @param {string} source */
export const parseComposerCommandArgs = (source) => {
  const match = COMMAND_RE.exec(source);
  if (!match) return '';
  return source.slice(match.index + match[0].length).split('\n')[0].trim();
};

/** @param {string} source @returns {ComposerRefToken[]} */
export const parseComposerRefs = (source) => {
  /** @type {ComposerRefToken[]} */
  const refs = [];
  REF_RE.lastIndex = 0;
  let match;
  while ((match = REF_RE.exec(source)) !== null) {
    const lead = match[1];
    const kind = /** @type {ComposerRefKind} */ (match[2]);
    let arg = match[3] ?? '';
    let trimmed = 0;
    if (arg && /[.,;:!?)]$/.test(arg)) { arg = arg.slice(0, -1); trimmed = 1; }
    const start = match.index + lead.length;
    const end = match.index + match[0].length - trimmed;
    refs.push({ kind, arg, raw: source.slice(start, end), start, end });
  }
  return refs;
};

/** @param {string} text */
export const parseComposer = (text) => {
  const source = typeof text === 'string' ? text : '';
  return {
    command: parseComposerCommandName(source),
    commandArgs: parseComposerCommandArgs(source),
    refs: parseComposerRefs(source),
    text: source,
  };
};

/** @param {string} text @param {readonly {name:string,body:string}[]} commands */
export const expandComposerCommand = (text, commands) => {
  const parsed = parseComposer(text);
  if (!parsed.command) return { parsed, text: parsed.text, commandFound: false };
  const selected = commands.find((candidate) => candidate.name === parsed.command);
  if (!selected) return { parsed, text: parsed.text, commandFound: false };
  const lines = parsed.text.split('\n');
  lines.shift();
  const rest = lines.join('\n');
  return {
    parsed,
    commandFound: true,
    text: `${selected.body}${parsed.commandArgs ? `\n\n${parsed.commandArgs}` : ''}`
      + `${rest ? `\n${rest}` : ''}`,
  };
};
