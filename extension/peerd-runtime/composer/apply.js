// @ts-check
// applyComposer — the one entry point the service worker calls.
//
// Takes the raw composer text and turns it into the final user-turn text:
//   1. If it starts with /command, look the command up and PREPEND its
//      markdown body, then append the user's free-text argument as the
//      task. (Claude Code semantics: the command body is the instruction;
//      anything after `/name` is the input it operates on.)
//   2. Resolve every @-reference (file/tab) and splice the inlined,
//      untrusted-wrapped payloads in place.
//
// Returns the rewritten text plus a small report (which command ran,
// which refs resolved/failed) so the SW can audit and the UI can show
// chips. Order matters: command expansion first (so a command body can
// itself be the frame around @-refs that follow), refs second.

import { parseComposer } from './parse.js';
import { resolveAllRefs } from './resolvers.js';

/**
 * @param {Object} args
 * @param {string} args.text                      raw composer text
 * @param {import('./command-sources.js').CommandSource} args.commandSources
 * @param {import('./resolvers.js').ComposerRefCtx} args.ctx   runtime tool context (for refs)
 * @returns {Promise<{
 *   text: string,
 *   command: string|null,
 *   commandFound: boolean,
 *   refs: Array<{ raw: string, ok: boolean, error?: string }>,
 * }>}
 */
export const applyComposer = async ({ text, commandSources, ctx }) => {
  const parsed = parseComposer(text);

  // 1. Command expansion. Strip the `/name [args]` portion from the line,
  //    substitute the command body, and keep whatever came after as the
  //    task input.
  let working = parsed.text;
  let commandFound = false;
  if (parsed.command) {
    const all = commandSources ? await safeList(commandSources) : [];
    const match = all.find((c) => c.name === parsed.command);
    if (match) {
      commandFound = true;
      // Drop the command token + its same-line args from the original
      // text; replace the whole first line with the command body, then
      // re-attach the rest of the message (multi-line input survives).
      const lines = parsed.text.split('\n');
      lines.shift(); // remove the `/name args` line
      const rest = lines.join('\n');
      const argSuffix = parsed.commandArgs ? `\n\n${parsed.commandArgs}` : '';
      working = `${match.body}${argSuffix}${rest ? `\n${rest}` : ''}`;
    }
    // If not found, we leave the text as-is — `/typo` just goes through as
    // literal text rather than silently dropping the user's message.
  }

  // 2. Reference resolution. Re-parse refs against the (possibly rewritten)
  //    working text so offsets line up with what we're about to splice.
  const refTokens = parseComposer(working).refs;
  const { text: finalText, resolved } = refTokens.length
    ? await resolveAllRefs(refTokens, working, ctx)
    : { text: working, resolved: [] };

  return {
    text: finalText,
    command: parsed.command,
    commandFound,
    refs: resolved,
  };
};

/** @param {import('./command-sources.js').CommandSource} src */
const safeList = async (src) => {
  try { return await src.list(); } catch { return []; }
};
