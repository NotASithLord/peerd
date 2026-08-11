// @ts-check
// First import of every Pod job Worker. It reuses the Notebook realm seal but
// keeps fetch off the global object: Pod networking is a named shell/JS
// capability (`curl` in the parent command worker), never ambient authority.

import { applyRealmSeal } from '../notebook-tab/notebook-neutralizers.js';

export const podFetch = applyRealmSeal(globalThis, {
  environment: 'Pod',
  exposeGlobalFetch: false,
  blockHostStorage: true,
  blockExtensionApis: true,
}).fetch;
