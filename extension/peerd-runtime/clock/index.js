// @ts-check
// peerd-runtime/clock — temporal grounding.
//
// Public surface of the clock submodule. Other peerd-runtime files
// reach in here for the tool list and the temporal block formatter.
// The SW imports via peerd-runtime/index.js.

export { buildTemporalBlock } from './context.js';
export { CLOCK_TOOLS } from './tools.js';
