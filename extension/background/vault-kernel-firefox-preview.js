// @ts-check

import './kernel-firefox-contributor-addon.js';
// why: the contributor addon must enhance the Firefox guard before the shared
// Firefox entry installs the kernel with that exact runtime-module set.
import './vault-kernel-firefox.js';
