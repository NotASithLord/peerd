// @ts-check
// Dweb loader — DEV/PREVIEW VARIANT.
//
// This is the ONLY file in the codebase (outside peerd-distributed/
// itself) allowed to reference the dweb module's path, and the
// reference is a dynamic import gated on the package-time flag. The store
// package replaces this whole file with packaging/templates/
// dweb-loader.store.js (stub-only, no path string), and prunes
// peerd-distributed/ from the artifact — two structural layers plus the
// post-package string check. packaging/check-dweb-boundary.ts enforces
// the single-reference rule in CI.

import { DWEB_ENABLED } from '/shared/channel-config.js';
import { dwebStub } from '/shared/dweb-interface.js';

/** @typedef {import('/shared/dweb-interface.js').DwebClient} DwebClient */

let clientPromise = null;

/**
 * Resolve the dweb client for this channel: the live implementation
 * when DWEB_ENABLED, the stub otherwise. Idempotent; the live
 * module is loaded at most once per SW/page lifetime.
 * @returns {Promise<DwebClient>}
 */
export const loadDweb = () => {
  if (!DWEB_ENABLED) return Promise.resolve(dwebStub);
  clientPromise ??= import('/peerd-distributed/index.js')
    .then((mod) => mod.createDwebClient());
  return clientPromise;
};
