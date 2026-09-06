// @ts-check

import {
  isEvalSender,
  isFirstPartySender,
  isHomeSender,
  isOffscreenSender,
  isOptionsSender,
  isSidepanelPortSender,
  isSidepanelSender,
} from '../shared/sender-trust.js';

/** @param {Record<string,string>} target */
export const createKernelSenderPolicy = (target) => {
  const {
    runtimeId, extensionOrigin, sidepanelUrl, homeUrl, optionsUrl,
    evalRunnerUrl, notebookTabUrl, offscreenUrl, appTabUrl, micUrl,
  } = target;
  if ([
    runtimeId, extensionOrigin, sidepanelUrl, homeUrl, optionsUrl,
    evalRunnerUrl, notebookTabUrl, offscreenUrl, appTabUrl, micUrl,
  ].some((value) => typeof value !== 'string')) {
    throw new TypeError('kernel-sender-policy-config-invalid');
  }
  const trusted = (/** @type {any} */ sender) => isFirstPartySender(sender, {
    runtimeId, extensionOrigin,
  });
  const sidepanelUi = (/** @type {any} */ sender) => isSidepanelSender(sender, {
    runtimeId, extensionOrigin, sidepanelUrl,
  });
  const homeUi = (/** @type {any} */ sender) => isHomeSender(sender, {
    runtimeId, extensionOrigin, homeUrl,
  });
  const optionsUi = (/** @type {any} */ sender) => isOptionsSender(sender, {
    runtimeId, extensionOrigin, optionsUrl,
  });
  const evalUi = (/** @type {any} */ sender) => !homeUi(sender) && isEvalSender(sender, {
    runtimeId, extensionOrigin, homeUrl, evalRunnerUrl,
  });
  const notebookUi = (/** @type {any} */ sender) => {
    if (!trusted(sender)) return false;
    const senderUrl = sender?.url ?? sender?.tab?.url;
    return typeof sender?.tab?.id === 'number' && typeof senderUrl === 'string'
      && senderUrl.split(/[?#]/, 1)[0] === notebookTabUrl;
  };
  const appUi = (/** @type {any} */ sender, /** @type {string} */ appId) => {
    if (!trusted(sender) || typeof sender?.tab?.id !== 'number') return false;
    try {
      const url = new URL(sender.url ?? sender.tab.url);
      const expected = new URL(appTabUrl);
      return url.origin === expected.origin && url.pathname === expected.pathname
        && url.search === '' && decodeURIComponent(url.hash.slice(1).split('?', 1)[0]) === appId;
    } catch { return false; }
  };
  const offscreenUi = (/** @type {any} */ sender) => isOffscreenSender(sender, {
    runtimeId, extensionOrigin, offscreenUrl,
  });
  const micUi = (/** @type {any} */ sender) => trusted(sender)
    && typeof sender?.tab?.id === 'number' && sender.url === micUrl;
  return Object.freeze({
    trusted, sidepanelUi, homeUi,
    humanUi: (/** @type {any} */ sender) => sidepanelUi(sender) || homeUi(sender),
    optionsUi, evalUi,
    voiceUi: (/** @type {any} */ sender) => sidepanelUi(sender) || optionsUi(sender),
    notebookUi,
    appUi, offscreenUi, micUi,
    sidepanelPortUi: (/** @type {any} */ sender) => isSidepanelPortSender(sender, {
      runtimeId, extensionOrigin, sidepanelUrl,
    }),
  });
};
