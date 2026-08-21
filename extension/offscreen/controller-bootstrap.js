// @ts-check
// Lazy semantic-controller bootstrap. offscreen.js only captures the exact
// transferred offer synchronously; construction and the sealed Worker stay
// outside its cold graph.

import browser from '/shared/browser-api.js';
import { backgroundModuleUrl } from '/shared/background-entry.js';
import { CONTROLLER_BUILD_DIGEST } from '/shared/structured-clone-size.js';
import {
  makeControllerOfferHandler,
  makeSealedControllerLoader,
} from './controller-shell.js';

const loadController = makeSealedControllerLoader({
  workerUrl: browser.runtime.getURL('offscreen/controller-worker.js'),
});
const handleOffer = makeControllerOfferHandler({
  expectedWorkerUrl: backgroundModuleUrl(browser),
  expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
  supportedCaps: ['prompt.render', 'semantic.dispatch', 'turn.run'],
  loadController,
});

/** @param {MessageEvent} event */
export const acceptControllerOffer = (event) => {
  const port = event.ports?.[0];
  if (!handleOffer(event)) port?.close();
};

// The controller feature lease owns this lifecycle edge. Revocation closes the
// private channel and sealed Worker and permanently retires the prior kernel
// epoch before the offscreen document is allowed to go idle.
export const retireControllerHost = () => handleOffer.close();
