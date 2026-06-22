// @ts-check
// Default (code) hooks — trusted, in-tree, registered by the chassis at
// boot. These are NOT user config: they can't be exported away or
// disabled through the user-hook surface. The egress allowlist hook in
// particular is the always-on floor the §10 design dogfoods.

import { egressAllowlistHook } from './egress-allowlist.js';

/** @type {readonly import('../runner.js').Hook[]} */
export const DEFAULT_HOOKS = Object.freeze([
  egressAllowlistHook,
]);

export { egressAllowlistHook };
