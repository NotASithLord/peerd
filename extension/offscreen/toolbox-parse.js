// @ts-check
// Toolbox write-time parser host. The SW remains the storage authority; this
// document performs only syntax/import-graph validation and reads existing
// sibling bodies through the SW's execute-only toolbox/read route.

import browser from '/vendor/browser-polyfill.js';
import { buildModule } from '/peerd-engine/offscreen.js';
import { makeToolboxParseCheck } from '/peerd-runtime/offscreen.js';
import { REMOTE_MODULE_IMPORTS_ENABLED } from '/shared/channel-config.js';
import { isServiceWorkerSender } from '/shared/messaging.js';

const parseCheck = makeToolboxParseCheck({
  buildModule,
  remoteModulesEnabled: REMOTE_MODULE_IMPORTS_ENABLED,
  readSibling: async (name) => {
    const reply = /** @type {{ ok?: boolean, body?: string, error?: string }} */ (
      await browser.runtime.sendMessage({ type: 'toolbox/read', name })
    );
    if (!reply?.ok || typeof reply.body !== 'string') {
      throw new Error(reply?.error ?? `unknown toolbox module '${name}'`);
    }
    return reply.body;
  },
});

/**
 * @param {any} message
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onToolboxParseCheck = (message, sender, sendResponse) => {
  if (message?.type !== 'toolbox/parse-check') return undefined;
  if (!isServiceWorkerSender(sender)) {
    sendResponse({ ok: false, error: 'unauthorized-command-sender' });
    return true;
  }
  parseCheck(message.name, message.body)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({
      ok: false,
      error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
    }));
  return true;
};

browser.runtime.onMessage.addListener(/** @type {any} */ (onToolboxParseCheck));
