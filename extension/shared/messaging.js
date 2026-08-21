// @ts-check
// Cross-context messaging helpers.
//
// Every message between contexts (sidepanel ↔ SW, offscreen ↔ SW,
// content ↔ SW) is a discriminated union with a `type: string` tag.
// Feature code never calls `browser.runtime.sendMessage` or
// `port.postMessage` directly — it goes through one of the helpers
// below. That keeps the message surface auditable in one place.
//
// Schema discipline:
//   - `type` field is required, kebab-or-slash-delimited (e.g. 'vault/unlock')
//   - payload fields are JSON-serialisable (structured-clone-safe)
//   - replies follow `{ ok: true, ... }` or `{ ok: false, error: string }`

import browser from './browser-api.js';
import { isServiceWorkerSender as isServiceWorkerSenderCore } from './sender-trust.js';
import { backgroundModuleUrl } from './background-entry.js';

/**
 * Send a fire-and-forget message to whatever context owns the receiver
 * for this type. Returns the reply if any.
 *
 * @template {{ type: string }} Msg
 * @template Reply
 * @param {Msg} msg
 * @returns {Promise<Reply>}
 */
export const send = (msg) => browser.runtime.sendMessage(msg);

/**
 * Is this message/port sender first-party (THIS extension), not a web page?
 *
 * The SW dispatch surface (~80 routes incl. vault/setSecret, provider keys,
 * tool dispatch, actor spawn) is otherwise trust-by-default. Today
 * nothing untrusted can reach it — no content_scripts, no
 * externally_connectable — but that safety rests on one manifest fact. This
 * guard makes the boundary explicit so adding a content script (which would
 * sendMessage with a WEB-PAGE url) or wiring externally_connectable later
 * can't silently expose every route:
 *
 *   - sender.id must equal our own runtime id (rejects other extensions;
 *     external messages would arrive on onMessageExternal, which we never
 *     register, but assert it anyway).
 *   - if a frame url is present (page/content-script senders set it), it
 *     must be one of OUR extension pages. The SW itself and extension
 *     pages pass; a content script running in a web page does not.
 *
 * Delegates to sender-trust.js's isFirstPartySender — the stricter of the
 * two predicates this codebase has had (fails closed on a missing
 * sender.url, Firefox-safe via getURL('') rather than a hardcoded
 * chrome-extension:// scheme).
 *
 * @param {{ id?: string, url?: string } | undefined} sender
 * @returns {boolean}
 */
/** Exact SW command-source pin for privileged offscreen receivers. */
/** @param {{ id?: string, url?: string, tab?: unknown, documentId?: string } | undefined} sender */
export const isServiceWorkerSender = (sender) => isServiceWorkerSenderCore(sender, {
  runtimeId: browser.runtime?.id,
  extensionOrigin: browser.runtime?.getURL?.('') ?? '',
  serviceWorkerUrl: backgroundModuleUrl(browser),
  backgroundPageUrl: browser.runtime?.getURL?.('_generated_background_page.html') ?? '',
});

/**
 * Long-lived port helper. Wraps `browser.runtime.connect` with a
 * type-discriminated `onMessage` dispatch and a structured `postMessage`.
 * Used by the side panel ↔ SW channel and the offscreen ↔ SW channel.
 *
 * @param {string} name             port name (matches receiver expectation)
 * @param {Record<string, (msg: any) => void>} handlers
 */
export const connectPort = (name, handlers = {}) => {
  const port = browser.runtime.connect({ name });
  port.onMessage.addListener((raw) => {
    const msg = /** @type {{ type?: unknown } | null} */ (raw);
    if (!msg || typeof msg.type !== 'string') return;
    const handler = handlers[msg.type];
    if (handler) {
      try { handler(msg); }
      catch (e) { console.error('[messaging] port handler threw for', msg.type, e); }
    }
  });
  return {
    /** @param {any} msg */
    post: (msg) => port.postMessage(msg),
    disconnect: () => port.disconnect(),
    /** @param {(port: import('webextension-polyfill').Runtime.Port) => void} fn */
    onDisconnect: (fn) => port.onDisconnect.addListener(fn),
    raw: port,
  };
};
