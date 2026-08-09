// @ts-check
// Disposable Firefox Notebook compiler host.

import { linkSingleModuleWorkerDetailed } from '/peerd-engine/index.js';

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || message.type !== 'link') return;
  try {
    const linked = await linkSingleModuleWorkerDetailed(
      String(message.source),
      new Map(Array.isArray(message.cache) ? message.cache : []),
      Array.isArray(message.packagedEntryUrls) ? message.packagedEntryUrls : [],
      undefined, undefined, Number(message.entryBodyLine),
    );
    self.postMessage({ type: 'linked', ...linked });
  } catch (error) {
    self.postMessage({
      type: 'link-failed',
      error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
      errorCode: /** @type {{ code?: string }} */ (error)?.code,
    });
  }
});
