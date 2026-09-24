// @ts-check

import browser from '../shared/browser-api.js';
import { BACKGROUND_MODULE_PATH } from '../shared/build-config.js';

export const backgroundScriptUrl = browser.runtime.getURL(BACKGROUND_MODULE_PATH);
const runtimeId = browser.runtime?.id;
const extensionOrigin = browser.runtime?.getURL?.('') ?? '';
const backgroundPageUrl = browser.runtime?.getURL?.('_generated_background_page.html') ?? '';

/** @param {{id?:string,url?:string}|null|undefined} sender */
export const isTrustedSender = (sender) => !!sender && !!runtimeId
  && sender.id === runtimeId && !!extensionOrigin
  && typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin);

/** @param {{id?:string,url?:string,tab?:unknown,documentId?:string}|null|undefined} sender */
export const isServiceWorkerSender = (sender) => {
  if (!isTrustedSender(sender) || !backgroundScriptUrl || !backgroundPageUrl
      || (sender && 'tab' in sender)) return false;
  if (sender?.url === backgroundPageUrl) return true;
  return sender?.url === backgroundScriptUrl && !(sender && 'documentId' in sender);
};
