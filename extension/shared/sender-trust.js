// @ts-check
// Sender-provenance check for the privileged service-worker RPC surface.
//
// why: makeDispatcher (shared/messaging.js) fans ONE
// browser.runtime.onMessage surface out to the SW's ~80 privileged routes
// (vault/*, tool dispatch, subagent/spawn, sw/web-fetch, provider config,
// …). Today the only thing keeping a web page off that surface is the
// MANIFEST: it declares no `externally_connectable` and no content
// scripts, so onMessage only ever fires for first-party extension
// contexts. That is sound but invisible — the dispatcher itself is
// trust-by-default, so the day someone adds a content script or an
// externally_connectable entry, every route silently becomes reachable
// from the page that triggered it.
//
// This predicate makes the "first-party only" invariant EXPLICIT and
// enforces it at the chokepoint, so a future surface fails CLOSED here
// instead of reaching a handler. It is pure (IO — the runtime id and our
// own origin — is injected by the caller) so it is unit-testable without a
// browser, per the project's functional-core convention.

/**
 * Is this onMessage sender a trusted first-party extension context?
 *
 * Accepts only senders that are BOTH (a) this same extension
 * (`sender.id === runtimeId`) AND (b) running from our own packaged
 * origin (`sender.url` starts with `chrome-extension://<id>/`). That
 * admits every legitimate first-party surface — the side panel, the
 * offscreen document, and the vm/js/app tab pages (which legitimately
 * carry a `sender.tab`) — and rejects:
 *   - a hypothetical content script (its `sender.url` is the WEB page,
 *     not our extension origin — this is the case the manifest currently
 *     makes impossible and that this guard future-proofs),
 *   - any other extension (`sender.id` differs; such messages also reach
 *     onMessageExternal, not onMessage, but we assert it anyway),
 *   - a sender with no/odd url.
 *
 * The injected `extensionOrigin` ends in a trailing slash
 * (`browser.runtime.getURL('')` → `chrome-extension://<id>/`), so the
 * prefix check can't be fooled by `chrome-extension://<id>@evil/…` or a
 * sibling id that merely shares a prefix. Using getURL('') rather than a
 * hardcoded scheme keeps this correct on Firefox (`moz-extension://…`).
 *
 * @param {{ id?: string, url?: string } | null | undefined} sender
 *   the second argument browser.runtime.onMessage hands to a listener
 * @param {{ runtimeId?: string, extensionOrigin?: string }} [trust]
 *   runtimeId = browser.runtime.id; extensionOrigin = browser.runtime.getURL('').
 *   Both optional: a missing/blank value fails the guards below (returns false),
 *   so a no-arg call is a defensible "untrusted" rather than a crash.
 * @returns {boolean}
 */
export const isFirstPartySender = (sender, { runtimeId, extensionOrigin } = {}) => {
  if (!sender || typeof sender !== 'object') return false;
  if (!runtimeId || sender.id !== runtimeId) return false;
  if (typeof extensionOrigin !== 'string' || extensionOrigin.length === 0) return false;
  if (typeof sender.url !== 'string') return false;
  return sender.url.startsWith(extensionOrigin);
};
