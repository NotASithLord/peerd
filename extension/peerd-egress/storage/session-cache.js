// @ts-check
// chrome.storage.session — SW-restart-survivable ephemeral state.
//
// Unlike chrome.storage.local, this storage area is cleared when the
// browser restarts. It survives the SW's own lifecycle (which can be
// killed by the 30s idle timer) so we can rehydrate active-session
// metadata after a restart without persisting anything across browser
// restarts.
//
// What we put here:
//   - currentSessionId          (so we can re-render the right session)
//   - vault.unlockedAt          (UI uses this to know if it should show
//                                "your session is older than auto-lock
//                                — please unlock" without trying to use
//                                the vault first)
//   - the unwrapped vault DK    (vault.js `_persistDK`, key `vault.unlocked.v1`)
//                                — exported as raw bytes so the vault survives
//                                an SW restart WITHOUT a re-unlock. This is a
//                                deliberate tradeoff: `storage.session` is
//                                RAM-only and cleared on browser restart, and
//                                the MV3 threat model is "anything running
//                                extension code already has the live DK." It
//                                is dropped on lock/auto-lock (`_clearPersistedDK`).
//                                NOTE: this is the one place the otherwise
//                                non-extractable DK is serialized — see the
//                                security note in vault.js. (Earlier revisions
//                                of this comment claimed the DK was never
//                                stored here; that is no longer true.)
//
// What we DO NOT put here:
//   - plaintext secrets (provider keys, git tokens — those stay vault-encrypted)
//   - long-term config (that's chrome.storage.local)

import browser from '/vendor/browser-polyfill.js';

// We resolve `browser.storage.session` per-call rather than caching it
// at module scope. The polyfill only proxies APIs that exist on the
// underlying `chrome` object — when this module is imported outside an
// extension context (test runner served via dev-server.sh), `chrome.storage`
// is undefined, and an eager `browser.storage.session` would throw at
// module evaluation. Per-call resolution defers that to runtime, where
// it would throw cleanly with "X is not a function" if anyone actually
// tried to call us outside an extension — but won't kill the static
// import graph just by being loaded.

/** @param {string} key */
export const sessionGet = async (key) => {
  const result = await browser.storage.session.get(key);
  return result[key];
};

/** @param {string} key @param {any} value */
export const sessionSet = (key, value) => browser.storage.session.set({ [key]: value });

/** @param {string} key */
export const sessionDelete = (key) => browser.storage.session.remove(key);
