// @ts-check

// The tokenizer is shared with the host's exact composer-reference policy so
// semantic expansion and authority admission cannot drift.
/** @typedef {'file'|'tab'} RefKind */
/** @typedef {{kind:RefKind,arg:string,raw:string,start:number,end:number}} RefToken */
export {
  parseComposer,
  parseComposerCommandArgs as parseCommandArgs,
  parseComposerCommandName as parseCommandName,
  parseComposerRefs as parseRefs,
} from '../../shared/composer-parser.js';

/**
 * Detect an in-progress token at the caret for live palette triggering.
 * @param {string} text
 * @param {number} caret
 * @returns {{type:'command'|'ref',query:string,kind?:RefKind,from:number,to:number}|null}
 */
export const activeTrigger = (text, caret) => {
  const source = typeof text === 'string' ? text : '';
  const position = Math.max(0, Math.min(caret ?? source.length, source.length));
  const before = source.slice(0, position);
  const command = /^(\s*)\/([a-zA-Z0-9_-]*)$/.exec(before);
  if (command) {
    return { type: 'command', query: command[2], from: command[1].length, to: position };
  }
  const at = before.lastIndexOf('@');
  if (at === -1 || !(at === 0 || /\s/.test(before[at - 1]))) return null;
  const fragment = before.slice(at + 1);
  if (/\s/.test(fragment)) return null;
  const colon = fragment.indexOf(':');
  if (colon === -1) {
    return { type: 'ref', kind: undefined, query: fragment, from: at, to: position };
  }
  const head = fragment.slice(0, colon);
  if (head === 'tab' || head === 'file') {
    return {
      type: 'ref', kind: head, query: fragment.slice(colon + 1), from: at, to: position,
    };
  }
  return { type: 'ref', kind: undefined, query: fragment, from: at, to: position };
};
