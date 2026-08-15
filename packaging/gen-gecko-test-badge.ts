// Generate badges/inbrowser-gecko.json from the Firefox runtime job
// (scripts/firefox/run-runtime-tests.mjs): the packaged Store XPI smoke
// followed by the shared browser suite executed under Gecko, sharded.
//
// why its own badge next to the Chrome one: "the tests pass" in Chromium says
// nothing about the engine half our users run. The Gecko lane executes the same
// registered graph and asserts every test in it ran exactly once, so the two
// counts are directly comparable, and a Gecko-only regression shows up as two
// badges that disagree.
//
// Run: FIREFOX_PATH=... bun run gen:badge:gecko   (needs Firefox +
// geckodriver, per the pins in scripts/firefox/. CI's Firefox job runs this
// and diffs the badge.)

import {
  parseSuiteSummary, runLane, suiteBadge, summaryFile, writeBadge,
} from './test-badges.ts';

export const GECKO_BADGE = 'inbrowser-gecko.json';
export const GECKO_LABEL = 'In-Browser (Gecko)';

const generate = () => {
  const totals = parseSuiteSummary(runLane(
    'Firefox Store smoke + Gecko suite',
    ['scripts/firefox/run-runtime-tests.mjs'],
    summaryFile,
  ));
  const badge = suiteBadge(GECKO_LABEL, totals, 'firefoxbrowser');
  console.log(`wrote ${writeBadge(GECKO_BADGE, badge)} - ${badge.message}`);
};

if (import.meta.main) generate();
