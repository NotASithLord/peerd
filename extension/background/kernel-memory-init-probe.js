// @ts-check

import { disarmText } from '../shared/disarm-text.js';
import { probeMemoryInitTabInjected } from '../shared/memory-init-tab-probe.js';

const timed = (/** @type {Promise<any>} */ operation, /** @type {number} */ timeoutMs,
  /** @type {typeof setTimeout} */ setTimeoutFn, /** @type {typeof clearTimeout} */ clearTimeoutFn) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {Function} */ fn, /** @type {unknown} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      fn(value);
    };
    const timer = setTimeoutFn(() => finish(reject, new Error('memory-probe-timeout')), timeoutMs);
    operation.then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });

/** @param {{tabs:any,scripting:any,resolveTab:(tab:any)=>Promise<any>,timeoutMs?:number,
 * setTimeoutFn?:typeof setTimeout,clearTimeoutFn?:typeof clearTimeout}} deps */
export const createKernelMemoryInitProbe = ({
  tabs,
  scripting,
  resolveTab,
  timeoutMs = 2_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (typeof tabs?.query !== 'function' || typeof scripting?.executeScript !== 'function'
      || typeof resolveTab !== 'function') {
    throw new TypeError('kernel-memory-init-probe-config-invalid');
  }
  const step = (/** @type {Promise<any>} */ operation) => timed(
    operation, timeoutMs, setTimeoutFn, clearTimeoutFn,
  );
  const probeTab = async (/** @type {{activeTabSpecified?:boolean,activeTabId?:number|null}} */ binding = {}) => {
    try {
      if (binding.activeTabSpecified === true && binding.activeTabId === null) {
        return { tab: null };
      }
      const tab = binding.activeTabSpecified === true
        ? await step(Promise.resolve(tabs.get(binding.activeTabId)))
        : (await step(Promise.resolve(tabs.query({ active: true, currentWindow: true }))))[0];
      if (!tab?.id || !tab.url) return { tab: null };
      if (!/^https?:/.test(tab.url)) {
        return { tab: null, warning: '/init skipped the browser page because this URL type cannot be verified.' };
      }
      let target;
      try {
        target = await step(Promise.resolve(resolveTab(tab)));
      } catch {
        return { tab: null, warning: '/init skipped the browser page because its current document could not be verified.' };
      }
      const documentId = target?.peerdDocumentId ?? target?.documentId;
      if (!target || typeof target.id !== 'number' || typeof target.url !== 'string'
          || typeof documentId !== 'string') {
        return { tab: null, warning: '/init skipped the browser page because browser policy refused the target.' };
      }
      const tabResult = { url: target.url };
      try {
        const [response] = await step(Promise.resolve(scripting.executeScript({
          target: { tabId: target.id, documentIds: [documentId] },
          func: probeMemoryInitTabInjected,
        })));
        const result = response?.result;
        if (!result) return { tab: tabResult };
        const stillLive = await step(Promise.resolve(resolveTab({ id: target.id })));
        const stillDocumentId = stillLive?.peerdDocumentId ?? stillLive?.documentId;
        if (stillLive?.url !== target.url || stillDocumentId !== documentId) {
          return { tab: null, warning: '/init skipped the browser page because its current document changed.' };
        }
        return { tab: {
          ...tabResult,
          title: typeof result.title === 'string' ? disarmText(result.title) : undefined,
          headings: Array.isArray(result.headings)
            ? result.headings.map((/** @type {unknown} */ heading) => disarmText(String(heading)))
            : undefined,
          textSnippet: typeof result.textSnippet === 'string'
            ? disarmText(result.textSnippet) : undefined,
        } };
      } catch {
        return { tab: tabResult, warning: '/init skipped browser page details because the document probe did not finish.' };
      }
    } catch {
      return {
        tab: null,
        warning: binding.activeTabSpecified === true
          ? '/init skipped the browser page because the bound tab was unavailable.'
          : '/init skipped the browser page because the active-tab probe did not finish.',
      };
    }
  };
  return Object.freeze({ probeTab });
};
