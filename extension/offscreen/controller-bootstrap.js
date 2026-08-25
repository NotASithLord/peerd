// @ts-check
// Lazy semantic-controller bootstrap. offscreen.js only captures the exact
// transferred offer synchronously; construction and the sealed Worker stay
// outside its cold graph.

import browser from '/shared/browser-api.js';
import { backgroundModuleUrl } from '/shared/background-entry.js';
import { CONTROLLER_BUILD_DIGEST } from '/shared/structured-clone-size.js';
import { RUNTIME_DISPATCH_CAPABILITY } from '/shared/kernel-runtime-policy.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  KERNEL_FEATURE_EVENT_CAPABILITY,
} from '/shared/kernel-feature-policy.js';
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
  supportedCaps: [
    'prompt.render', RUNTIME_DISPATCH_CAPABILITY, 'semantic.dispatch', 'turn.run',
    KERNEL_FEATURE_DISPATCH_CAPABILITY, KERNEL_FEATURE_EVENT_CAPABILITY,
  ],
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
