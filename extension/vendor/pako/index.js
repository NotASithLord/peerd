// Static ESM entry for pako's audited codec. pako.esm.js is deterministically
// derived from the byte-locked upstream UMD by scripts/vendor-pako-esm.mjs;
// it contains the unchanged upstream factory body and no global/CJS branch.
export { Deflate, Inflate } from './pako.esm.js';
