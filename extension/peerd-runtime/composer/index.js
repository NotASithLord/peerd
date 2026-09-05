// @ts-check
// peerd-runtime/composer — public surface.
//
// Slash-command parsing, @-reference parsing, palette ranking, and the
// persisted command store. Turn composition and reference resolution live in
// the sealed controller plus the background's exact reference authority.

export {
  parseComposer, parseCommandName, parseCommandArgs, parseRefs, activeTrigger,
} from './parse.js';

export { score, filterCandidates } from './palette-filter.js';

export {
  createCommandStore, isValidCommandName, COMMAND_KEY_PREFIX,
} from './command-store.js';
