// Dweb loader for packages without a dweb mesh host.
//
// The build script copies this file over shared/dweb-loader.js
// when staging a dweb-disabled artifact. It returns the stub unconditionally and
// contains no reference to the dweb module's path — the module
// directory itself is absent from the store tree, so there is nothing to
// load and no string that names it. Kept as a committed file (not a
// package-time text transform) so what ships is exactly what's reviewable
// here.

import { dwebStub } from '/shared/dweb-interface.js';

/** @typedef {import('/shared/dweb-interface.js').DwebClient} DwebClient */

/**
 * Dweb-disabled package: dweb is not part of this distribution. Callers get
 * the stub, whose status reads answer honestly and whose actions throw
 * DwebUnavailableError. Core gates dweb UI on
 * DWEB_ENABLED, so this should never surface to users.
 * @returns {Promise<DwebClient>}
 */
export const loadDweb = () => Promise.resolve(dwebStub);
