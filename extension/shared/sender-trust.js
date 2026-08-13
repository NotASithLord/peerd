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
 * offscreen document, and the vm/js/pod/app tab pages (which legitimately
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
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
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
 * which is every extension page: the side panel, the home tab, and the
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
 * hash are rejected because the browser-owned document is created at one exact
 * URL. A sender with `tab` provenance is also rejected because a real offscreen
 * document is not hosted by a user-visible tab.
 *
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, offscreenUrl?: string }} [trust]
 *   offscreenUrl = browser.runtime.getURL('offscreen/offscreen.html'). Missing or
 *   blank fails closed, so an unwired caller is "untrusted" rather than a crash.
 * @returns {boolean}
 */
export const isOffscreenSender = (sender, { runtimeId, extensionOrigin, offscreenUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof offscreenUrl !== 'string' || offscreenUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  return sender?.url === offscreenUrl;
};

/**
 * Is this sender specifically the browser-owned BACKGROUND HOST?
 *
 * why: runtime.sendMessage reaches extension contexts broadly. An engine tab is
 * first-party but hosts agent-authored or untrusted state, so exact source pins
 * remain necessary for the headless jobs that still use runtime messaging.
 * Chrome actor runs and private backup transfers use targeted MessageChannels.
 * Firefox actor relays stay inside its background page, while its backup Port
 * still requires an exact options-page sender.
 *
 * @param {{ id?: string, url?: string, tab?: unknown, documentId?: string } | null | undefined} sender
 * Chrome presents the MV3 worker script URL. Firefox implements the same
 * manifest entry as a generated background page and presents its exact
 * `_generated_background_page.html` URL. Firefox's host is a real document and
 * may therefore carry `documentId`; the exact generated URL plus absence of a
 * tab is its boundary. Chrome's worker must carry neither tab nor document.
 *
 * @param {{ runtimeId?: string, extensionOrigin?: string, serviceWorkerUrl?: string, backgroundPageUrl?: string }} [trust]
 */
export const isServiceWorkerSender = (sender, {
  runtimeId, extensionOrigin, serviceWorkerUrl, backgroundPageUrl,
} = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof serviceWorkerUrl !== 'string' || serviceWorkerUrl.length === 0) return false;
  if (typeof backgroundPageUrl !== 'string' || backgroundPageUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  if (sender?.url === backgroundPageUrl) return true;
  return sender?.url === serviceWorkerUrl
    && !(sender && typeof sender === 'object' && 'documentId' in sender);
};

/**
 * Is this sender the full-tab options page that owns backup and restore?
 * Hash routes are part of the trusted page URL. Queries and sibling paths are
 * not, and open_in_tab means legitimate callers carry tab provenance.
 * @param {{ id?: string, url?: string, tab?: { id?: number } } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, optionsUrl?: string }} [trust]
 */
export const isOptionsSender = (sender, { runtimeId, extensionOrigin, optionsUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof optionsUrl !== 'string' || optionsUrl.length === 0) return false;
  if (typeof sender?.tab?.id !== 'number') return false;
  const url = /** @type {string} */ (sender.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?') && documentUrl === optionsUrl;
};

/**
 * Is this sender specifically the browser-owned peerd panel/sidebar page?
 *
 * why separate from first-party: the binary feedback route is a HUMAN click,
 * not an agent capability. Engine tabs also have first-party extension URLs
 * while hosting agent-authored state, so admitting all first-party senders
 * would let an App/Notebook forge task verdicts. Exact URL and no tab
 * provenance identifies Chrome's side panel and Firefox's sidebar document.
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, sidepanelUrl?: string }} [trust]
 */
export const isSidepanelSender = (sender, { runtimeId, extensionOrigin, sidepanelUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof sidepanelUrl !== 'string' || sidepanelUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  return sender?.url === sidepanelUrl;
};

/**
 * Is this sender the full-tab Home SPA that owns human feedback and
 * instance-wide observability?
 *
 * why separate from first-party: Home renders the same human chat controls as
 * the side panel, including binary task feedback, but an engine tab must not
 * inherit that human-only route merely because it shares the extension origin.
 * Hashes are one-shot Home deep links and are safe; queries and sibling paths
 * are not. A real Home caller is tab-hosted, unlike the browser side panel.
 * @param {{ id?: string, url?: string, tab?: { id?: number } } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, homeUrl?: string }} [trust]
 */
export const isHomeSender = (sender, { runtimeId, extensionOrigin, homeUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof homeUrl !== 'string' || homeUrl.length === 0) return false;
  if (typeof sender?.tab?.id !== 'number') return false;
  const url = /** @type {string} */ (sender.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?') && documentUrl === homeUrl;
};
