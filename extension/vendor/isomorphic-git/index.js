// Vendored browser bundle wrapper. The upstream UMD build deliberately writes
// `git` onto the extension global; static imports keep it usable in Chrome's
// MV3 service worker, where the HTML specification forbids runtime import().
// The side-effect dependency comes first so Buffer exists before the UMD
// factory evaluates.
import './install-buffer.js';
import './isomorphic-git.umd.min.js';

const git = globalThis.git;
if (!git) throw new Error('vendored isomorphic-git bundle failed to initialize');

export default git;
