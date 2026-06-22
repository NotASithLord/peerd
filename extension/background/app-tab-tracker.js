// @ts-check
// app-tab-tracker — which appId lives in which tab. Thin config over the
// shared createTabTracker.
//
// Mirror of vm-/js-tab-tracker for app-tab/index.html#<appId>. Apps are
// user-facing artifacts (the agent wrote a small UI for the user), so
// this kind also exposes reloadTab — the app body can be edited and the
// iframe re-rendered (app-client.reloadTab). It has no isReady consumer.
// Opening an app brings its tab to the foreground so the user sees it
// (DECISIONS #20, 2026-06-14); ensureTab early-returns for a live tab,
// so re-opening an existing app doesn't yank the user back.

import { createTabTracker } from './tab-tracker.js';
import { APP_TAB_PATH } from '/peerd-engine/index.js';

const READY_TIMEOUT_MS = 15_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'] }} [deps] */
export const createAppTabTracker = ({ announce } = {}) => {
  const tracker = createTabTracker({
    tabPath: APP_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('app tab closed before ready'),
    notReadyMessage: (id) => `app ${id} did not become ready`,
    announce,
    kindLabel: 'an App',
  });

  return {
    bootstrap: tracker.bootstrap,
    onTabReady: tracker.onTabReady,
    onTabRemoved: tracker.onTabRemoved,
    parseIdFromUrl: tracker.parseIdFromUrl,
    getTabId: tracker.getTabId,
    ensureTab: tracker.ensureTab,
    closeTab: tracker.closeTab,
    reloadTab: tracker.reloadTab,
    listLive: tracker.listLive,
  };
};
