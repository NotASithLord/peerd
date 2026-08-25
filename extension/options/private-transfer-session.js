// @ts-check
// One owner for the options page's private backup/restore transport.

import browser from '/shared/browser-api.js';
import { BACKGROUND_MODULE_PATH } from '/shared/build-config.js';
import { makePrivateTransferClient } from './private-transfer-client.js';

const serviceWorkerChannels = typeof navigator.serviceWorker?.addEventListener === 'function';
const client = makePrivateTransferClient(serviceWorkerChannels ? {
  requestChannel: async (requestId) => {
    const reply = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'private-transfer/open', requestId,
    }));
    if (!reply?.ok) throw new Error(reply?.error ?? 'backup channel refused');
  },
} : {
  connect: () => browser.runtime.connect({ name: 'private-transfer' }),
});

if (serviceWorkerChannels) navigator.serviceWorker.addEventListener('message', (event) => {
  const source = /** @type {{ scriptURL?: string } | null} */ (event.source);
  if (!event.isTrusted
      || source?.scriptURL !== browser.runtime.getURL(BACKGROUND_MODULE_PATH)
      || event.data?.type !== 'private-transfer/channel'
      || typeof event.data?.requestId !== 'string'
      || event.ports?.length !== 1) return;
  client.acceptChannel(event.data.requestId, event.ports[0]);
});

/** @param {{ type: string } & Record<string, any>} message */
export const callPrivateTransfer = (message) => client.call(message);
