// @ts-check
// peerd-runtime/composer — public surface.
//
// Slash commands + @-references + the command-palette logic. The composer
// is the seam between what the user TYPES and what becomes an agent turn:
//   - parse.js          tokenize a message into command + @-refs (pure)
//   - palette-filter.js fuzzy filter/rank palette candidates (pure)
//   - command-store.js  the `.peerd/commands/` workspace store (KV-backed)
//   - command-sources.js source aggregation + the feature-07 adapter
//   - resolvers.js      @file / @tab resolution (untrusted-wrapped, gated)
//   - apply.js          the one orchestrator the SW calls per turn
//
// This module never imports concrete IO. The store takes a KV; the
// resolvers take the runtime tool context. That keeps the core pure and
// Bun-testable without a browser.

export {
  parseComposer, parseCommandName, parseCommandArgs, parseRefs, activeTrigger,
} from './parse.js';

export { score, filterCandidates } from './palette-filter.js';

export {
  createCommandStore, isValidCommandName, COMMAND_KEY_PREFIX,
} from './command-store.js';

export {
  localStoreSource, skillRegistrySource, mergeSources,
} from './command-sources.js';

export {
  originOfUrl, decideTabGate, buildTabPayload, buildFilePayload,
  resolveTabRef, resolveFileRef, resolveAllRefs,
} from './resolvers.js';

export { applyComposer } from './apply.js';
