// @ts-check
// notebook-tab-tracker — which notebookId lives in which tab. Thin config
// over the shared createTabTracker.
//
// Mirrors vm-tab-tracker but for chrome-extension://<id>/
// notebook-tab/index.html#<notebookId>. The Notebook tab boots a Web Worker
// inline (no CheerpX), so "ready" fires within a few ms of tab load —
// no streaming disk image like VMs, hence the tighter 15s timeout. The
// closed-tab rejection is a plain Error (no per-instance interrupt lane
// like VMs have).

import { createTabTracker } from './tab-tracker.js';
import { NOTEBOOK_TAB_PATH } from '/peerd-engine/index.js';

const READY_TIMEOUT_MS = 15_000;       // Notebooks boot fast; tighter than VMs

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'] }} [deps] */
export const createJsTabTracker = ({ announce } = {}) => {
  const tracker = createTabTracker({
    tabPath: NOTEBOOK_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('Notebook tab closed before ready'),
    notReadyMessage: (id) => `Notebook ${id} did not become ready in ${READY_TIMEOUT_MS}ms`,
    announce,
    kindLabel: 'a Notebook',
  });

  return {
    bootstrap: tracker.bootstrap,
    onTabReady: tracker.onTabReady,
    onTabRemoved: tracker.onTabRemoved,
    parseIdFromUrl: tracker.parseIdFromUrl,
    getTabId: tracker.getTabId,
    isReady: tracker.isReady,
    ensureTab: tracker.ensureTab,
    closeTab: tracker.closeTab,
    listLive: tracker.listLive,
  };
};
