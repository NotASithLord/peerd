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

import browser from '../vendor/browser-polyfill.js';
import { isFirstPartySender } from './sender-trust.js';

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
 * tool dispatch, subagent spawn) is otherwise trust-by-default. Today
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
export const isTrustedSender = (sender) => isFirstPartySender(sender, {
  runtimeId: browser.runtime?.id,
  extensionOrigin: browser.runtime?.getURL?.('') ?? '',
});

/**
 * Build a dispatcher from a `type → handler` table. Pass the result to
 * `browser.runtime.onMessage.addListener`.
 *
 * Untrusted senders (see isTrustedSender) are refused before any handler
 * runs. Handlers may return a value or a Promise; both are awaited and the
 * resolved value is sent back as the reply. If a handler throws, the
 * reply is `{ ok: false, error: e.message }` and the error is logged
 * to the console for debugging.
 *
 * @param {Record<string, (msg: any, sender: import('webextension-polyfill').Runtime.MessageSender) => any>} handlers
 */
export const makeDispatcher = (handlers) =>
  /**
   * @param {any} msg                  heterogeneous — one of ~80 route shapes
   * @param {import('webextension-polyfill').Runtime.MessageSender} sender
   * @param {(response?: any) => void} sendResponse
   */
  (msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') {
    sendResponse({ ok: false, error: 'malformed-message' });
    return false;
  }
  // Sender provenance — fail CLOSED for anything but a first-party
  // extension context. Every route this dispatcher fans out to is
  // privileged (vault/*, tool dispatch, subagent/spawn, sw/web-fetch, …).
  // The manifest currently exposes no external / content-script surface,
  // so this never rejects a real caller today; it is the single chokepoint
  // that keeps a FUTURE manifest change (a content script, an
  // externally_connectable entry) from silently making every route
  // web-reachable. See shared/sender-trust.js.
  if (!isFirstPartySender(sender, {
    runtimeId: browser.runtime?.id,
    extensionOrigin: browser.runtime?.getURL?.('') ?? '',
  })) {
    console.warn('[messaging] rejected untrusted sender for', msg?.type,
      '— url:', sender?.url ?? '(none)', 'id:', sender?.id ?? '(none)');
    sendResponse({ ok: false, error: 'untrusted-sender' });
    return false;
  }
  const handler = handlers[msg.type];
  if (!handler) {
    // Unknown type — not necessarily an error; multiple listeners may
    // coexist and each only handles its own types. Return false so the
    // runtime continues trying other listeners.
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((reply) => sendResponse(reply ?? { ok: true }))
    .catch((e) => {
      console.error('[messaging] handler threw for', msg.type, e);
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    });
  // Return true to keep the message channel open for the async reply.
  return true;
};

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
