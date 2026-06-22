// @ts-check
// flags.js — source-level feature flags.
//
// Pure constants, no IO. Importable from any context (service worker,
// side panel, offscreen) because shared/ has no module-boundary lint
// restriction. Flip a flag here and reload the extension (there's no
// build step, and no runtime toggle).
//
// why these are OFF for the store V1 (see docs/store/OPEN-DECISIONS.md):
// each is a shipped-but-not-yet-V1 capability we deliberately keep out of
// the user's reach so the Chrome Web Store review has a smaller, honest
// surface. The code stays in the tree (and under test) so the feature
// returns in a later version with its own review — we just don't expose
// it from the UI or accept its messages.

/**
 * Remote skill installation (fetch a SKILL.md from a git/raw URL or a
 * manifest URL the user supplies). Local paste-in install is always on.
 *
 * OFF for V1: "fetch remote files the agent then acts on" is the textbook
 * remotely-hosted-code review question. With this false, the side panel
 * hides the git/manifest tabs and the service worker refuses the
 * `skills/installGit` / `skills/installManifest` routes — so the only
 * install path is user-pasted text. The installer code (install.js) still
 * ships and is still unit-tested; it's just unreachable from the product.
 */
export const REMOTE_SKILL_INSTALL = false;
