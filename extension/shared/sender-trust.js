// @ts-check
// Sender-provenance check for the privileged service-worker RPC surface.
//
// why: makeDispatcher (shared/messaging.js) fans ONE
// browser.runtime.onMessage surface out to the SW's ~80 privileged routes
// (vault/*, tool dispatch, actor/spawn, sw/web-fetch, provider config,
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

/**
 * Is this sender specifically the OFFSCREEN DOCUMENT?
 *
 * why a second, narrower predicate: isFirstPartySender answers "one of ours",
 * which is every extension page — the side panel, the home tab, and the three
 * engine tab pages that host agent-authored code. For most routes that is the
 * right question. For the few that carry an actor's authority (the offscreen
 * relay: tool dispatch on a pinned instance, and a model call the service
 * worker adds the vault key to) it is far too wide: an engine tab is a
 * first-party page that shows untrusted content, and `runtime.sendMessage`
 * from the service worker BROADCASTS to every one of them, so anything the
 * relay job carries — including a per-run grant token — is visible there.
 * Binding those routes to the offscreen document is what makes the grant a
 * real boundary rather than a shared secret.
 *
 * Exact-match on the document URL, not a prefix: a prefix would also admit
 * `offscreen/offscreen.html.evil.html` or any deeper path under it. Query and
 * hash are tolerated (Chrome does not add them today, but a future
 * createDocument call might) by comparing only the part before `?` or `#`.
 *
 * @param {{ id?: string, url?: string } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, offscreenUrl?: string }} [trust]
 *   offscreenUrl = browser.runtime.getURL('offscreen/offscreen.html'). Missing or
 *   blank fails closed, so an unwired caller is "untrusted" rather than a crash.
 * @returns {boolean}
 */
export const isOffscreenSender = (sender, { runtimeId, extensionOrigin, offscreenUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof offscreenUrl !== 'string' || offscreenUrl.length === 0) return false;
  const url = /** @type {string} */ (sender?.url).split('?')[0].split('#')[0];
  return url === offscreenUrl;
};
