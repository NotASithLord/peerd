// @ts-check
// Default (code) hooks — trusted, in-tree, registered by the chassis at
// boot. These are NOT user config: they can't be exported away or
// disabled through the user-hook surface. The egress allowlist hook in
// particular is the always-on floor the §10 design dogfoods.

import { egressAllowlistHook } from './egress-allowlist.js';
import { egressTripwireHook } from './egress-tripwire.js';

/** @type {readonly import('../runner.js').Hook[]} */
export const DEFAULT_HOOKS = Object.freeze([
  Object.freeze(egressAllowlistHook),
  // why the pair: the allowlist EXEMPTS browser-session (primitive 'tab')
  // tools, because reaching the user's own logged-in apps is the whole point.
  // The tripwire covers that exemption — an off-origin tab navigation carrying
  // a scraped-data payload in the URL. Not the WHOLE exemption: the allowlist
  // also skips non-mutate_external calls, and fetch_url falls in that gap
  // (egress-tripwire.js documents it). The two tile most of the surface, not
  // all of it.
  Object.freeze(egressTripwireHook),
]);

export { egressAllowlistHook, egressTripwireHook };
