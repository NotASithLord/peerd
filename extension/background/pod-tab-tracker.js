// @ts-check
// Pod tab lifecycle — thin configuration over the shared tracker.

import { createTabTracker } from './tab-tracker.js';
import { POD_TAB_PATH } from '/peerd-engine/index.js';

const READY_TIMEOUT_MS = 15_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'], onAdopt?: import('./tab-tracker.js').TabTrackerConfig['onAdopt'], onDrop?: import('./tab-tracker.js').TabTrackerConfig['onDrop'], tabs?:import('./tab-tracker.js').TabTrackerConfig['tabs'] }} [deps] */
export const createPodTabTracker = ({ announce, onAdopt, onDrop, tabs } = {}) => {
  const tracker = createTabTracker({
    tabPath: POD_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('Pod tab closed before ready'),
    notReadyMessage: (id) => `Pod ${id} did not become ready in ${READY_TIMEOUT_MS}ms`,
    announce, onAdopt, onDrop, tabs, kindLabel: 'a Pod',
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
