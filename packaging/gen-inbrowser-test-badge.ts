// Generate badges/inbrowser-chrome.json from the real headless-Chrome run of
// the in-browser suite (scripts/cdp/run-inbrowser-tests.mjs). That suite is the
// tier the Bun functional badge cannot speak for: DOM, chrome.*, real IDB
// lifecycle, side-panel components, service-worker behavior.
//
// Run: bun run gen:badge:inbrowser   (CI's in-browser job runs this, then
// diffs the badge, so a committed count is always a run that happened)

import {
  parseSuiteSummary, runLane, suiteBadge, summaryFile, writeBadge,
} from './test-badges.ts';

export const INBROWSER_CHROME_BADGE = 'inbrowser-chrome.json';
export const INBROWSER_CHROME_LABEL = 'In-Browser (Chrome)';

const generate = () => {
  const totals = parseSuiteSummary(runLane(
    'in-browser suite (Chrome)',
    ['scripts/cdp/run-inbrowser-tests.mjs'],
    summaryFile,
  ));
  const badge = suiteBadge(INBROWSER_CHROME_LABEL, totals, 'googlechrome');
  console.log(`wrote ${writeBadge(INBROWSER_CHROME_BADGE, badge)} - ${badge.message}`);
};

if (import.meta.main) generate();
