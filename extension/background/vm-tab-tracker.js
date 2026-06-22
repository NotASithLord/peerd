// @ts-check
// vm-tab-tracker — which vmId lives in which tab. Thin config over the
// shared createTabTracker.
//
// Each WebVM is a discrete browser tab at
//   chrome-extension://<id>/vm-tab/index.html#<vmId>
// The tab streams a CheerpX disk image, so "ready" can take a while —
// hence the 30s timeout, longer than the Notebook / app trackers.
//
// VM is the one kind with an injectable `tabs` dep (the in-browser
// vm-tab-close test stubs it) and a dedicated VMTabClosedError carrying
// `.vmId`, so the SW can interrupt that VM's pending RPCs in vm-client.

import { createTabTracker } from './tab-tracker.js';
import { VM_TAB_PATH, VMTabClosedError } from '/peerd-engine/index.js';

const READY_TIMEOUT_MS = 30_000;

/**
 * @param {Object} [deps]
 * @param {import('webextension-polyfill').Tabs.Static} [deps.tabs]
 *   Injected tabs API; defaults to the real browser.tabs.
 * @param {import('./tab-tracker.js').TabTrackerConfig['announce']} [deps.announce]
 */
export const createVmTabTracker = ({ tabs, announce } = {}) => {
  const tracker = createTabTracker({
    tabPath: VM_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: (vmId) => new VMTabClosedError(vmId),
    notReadyMessage: (vmId) => `vm tab ${vmId} did not become ready in ${READY_TIMEOUT_MS}ms`,
    announce,
    kindLabel: 'a Linux VM',
    ...(tabs ? { tabs } : {}),
  });

  return {
    bootstrap: tracker.bootstrap,
    onTabReady: tracker.onTabReady,
    onTabRemoved: tracker.onTabRemoved,
    // why parseVmIdFromUrl: the VM tracker has always exposed the
    // vm-flavored name; keep it so existing callers don't have to change.
    parseVmIdFromUrl: tracker.parseIdFromUrl,
    getTabId: tracker.getTabId,
    isReady: tracker.isReady,
    ensureTab: tracker.ensureTab,
    closeTab: tracker.closeTab,
    listLive: tracker.listLive,
  };
};
