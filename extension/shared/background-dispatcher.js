// @ts-check
// Background-only runtime message authority. Keeping this separate from the
// all-context messaging client prevents the service worker from evaluating
// document-side background-entry discovery and outbound Port helpers on wake.

import browser from './browser-api.js';
import { isFirstPartySender } from './sender-trust.js';

const OUTCOME_UNKNOWN_MESSAGE = 'Peerd could not confirm whether the requested change finished. '
  + 'Refresh to reconcile before trying again.';

/** @param {unknown} value */
export const normalizeMessageFailureReply = (value) => {
  if (!value || typeof value !== 'object') return value;
  const reply = /** @type {Record<string, any>} */ (value);
  if (reply.ok !== false || reply.outcomeKnown !== false) return value;
  const code = typeof reply.code === 'string'
      && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(reply.code)
    ? reply.code : null;
  return {
    ...reply,
    error: OUTCOME_UNKNOWN_MESSAGE,
    ...(code ? { code } : {}),
    outcomeKnown: false,
    outcomeKind: reply.outcomeKind ?? 'unknown',
    retryable: false,
  };
};

/** @param {unknown} cause */
const dispatcherFailure = (cause) => {
  const detail = /** @type {{code?:unknown,message?:unknown,outcomeKnown?:unknown,
   * outcomeKind?:unknown}} */ (cause);
  const code = typeof detail?.code === 'string'
      && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(detail.code)
    ? detail.code : null;
  if (detail?.outcomeKnown === false) return normalizeMessageFailureReply({
    ok: false,
    ...(code ? { code } : {}),
    error: OUTCOME_UNKNOWN_MESSAGE,
    outcomeKnown: false,
    outcomeKind: typeof detail.outcomeKind === 'string' ? detail.outcomeKind : 'unknown',
  });
  return {
    ok: false,
    error: typeof detail?.message === 'string'
      ? detail.message.slice(0, 256) : String(cause).slice(0, 256),
    ...(code ? { code } : {}),
  };
};

/** @param {{ id?: string, url?: string } | undefined} sender */
export const isTrustedSender = (sender) => isFirstPartySender(sender, {
  runtimeId: browser.runtime?.id,
  extensionOrigin: browser.runtime?.getURL?.('') ?? '',
});

/**
 * @param {Record<string, (msg: any, sender: import('webextension-polyfill').Runtime.MessageSender) => any>} handlers
 */
export const makeDispatcher = (handlers) =>
  /**
   * @param {any} msg
   * @param {import('webextension-polyfill').Runtime.MessageSender} sender
   * @param {(response?: any) => void} sendResponse
   */
  (msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') {
    sendResponse({ ok: false, error: 'malformed-message' });
    return false;
  }
  if (!isTrustedSender(sender)) {
    console.warn('[messaging] rejected untrusted sender for', msg?.type,
      '— url:', sender?.url ?? '(none)', 'id:', sender?.id ?? '(none)');
    sendResponse({ ok: false, error: 'untrusted-sender' });
    return false;
  }
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((reply) => sendResponse(normalizeMessageFailureReply(reply ?? { ok: true })))
    .catch((error) => {
      if (error?.outcomeKnown === false) {
        console.error('[messaging] handler outcome unknown for', msg.type, error?.code ?? 'unknown');
      } else {
        console.error('[messaging] handler threw for', msg.type, error);
      }
      sendResponse(dispatcherFailure(error));
    });
  return true;
};
