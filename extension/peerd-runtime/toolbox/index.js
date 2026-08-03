// @ts-check
// peerd-runtime/toolbox — design js-superpower/06: the agent's TOOLBOX, a small
// named library of its own reusable ES modules (`peerd:toolbox/<name>`).
//
// Public surface, re-exported through /peerd-runtime/index.js. Functional-core /
// imperative-shell: core.js is pure over its inputs (validation, proposal,
// parse check, list rendering); store.js is a two-tier IDB adapter with IO
// injected. The SW owns the confirm round-trip, the resolution route
// (toolbox/read), and the run-outcome bookkeeping route (toolbox/record); the
// resolver branch lives in peerd-engine/module-resolver.js and is LANE-GATED by
// dep injection (script + notebook only).

export {
  MAX_TOOLBOX_BODY_CHARS,
  MAX_TOOLBOX_DESCRIPTION_CHARS,
  MAX_TOOLBOX_MODULES,
  validateToolboxName,
  isValidToolboxName,
  validateToolboxBody,
  validateToolboxDescription,
  extractToolboxExports,
  buildToolboxWriteProposal,
  stampToolboxMeta,
  makeToolboxParseCheck,
  renderToolboxList,
} from './core.js';

export {
  createToolboxStore,
} from './store.js';
