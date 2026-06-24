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

/**
 * Resident tab agents (DESIGN-17 P0). A per-tab `kind:'resident'` session that
 * OWNS one tab-hosted instance (WebVM / Notebook / App): it exclusively holds
 * that environment's mutating tools (behind a resident-keyed capability tier at
 * the dispatch gate) and is addressed only by `message_resident`. The
 * per-environment tooling leaves the main agent (context optimized, non-eroding)
 * and "who may touch this instance" becomes structural instead of conventional.
 *
 * ON for this branch: the actor structure is the default reality here — the
 * main agent orchestrates and delegates instance work to per-instance residents
 * via message_resident, the mutating tier leaves the main agent, and the prompt
 * surfaces (main orchestrator framing + per-kind resident prompts) render their
 * resident-world variants. Flip back to false to return to the status quo (the
 * gate/descriptor/prompt/orchestrator changes all go inert and instance tools
 * stay on the main agent exactly as before). Source-flip + reload (no runtime/UI
 * toggle, not channel-config).
 */
export const RESIDENT_TAB_AGENTS = true;
