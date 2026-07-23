// Watch mode's only non-IO decision: given the live state, do we foreground the
// agent's tab right now? Every clause below exists because a focus-steal audit
// found a concrete way to pull the user's window with nobody watching — so these
// cases are the regression net for a feature whose failure mode is "peerd yanked
// my browser over the app I was working in".

import { describe, test, expect } from 'bun:test';
import { shouldFollowAgentTab } from '../../extension/background/watch-mode.js';

// The only state in which following is legitimate: watching, the panel is open,
// the user is actually in the browser, and the agent's tab isn't already in front.
const watching = {
  watchOn: true, panelOpen: true, chromeFocused: true, agentTabId: 7, alreadyInFront: false,
};

describe('shouldFollowAgentTab — the happy path', () => {
  test('follows when watching, panel open, browser focused, tab not in front', () => {
    expect(shouldFollowAgentTab(watching)).toBe(true);
  });

  test('never follows with watch off', () => {
    expect(shouldFollowAgentTab({ ...watching, watchOn: false })).toBe(false);
  });

  test('never follows without a known agent tab', () => {
    expect(shouldFollowAgentTab({ ...watching, agentTabId: null })).toBe(false);
    expect(shouldFollowAgentTab({ ...watching, agentTabId: undefined })).toBe(false);
  });
});

// The bug that started the audit: watchAgentTab PERSISTS, and background Routines
// run unattended "even while the side panel is closed" (schedule-create.js),
// catching up on wake. Flipping watch on once must not sign you up for every
// future scheduled run stealing focus.
describe('shouldFollowAgentTab — the unattended-Routine guard', () => {
  test('NEVER follows when the side panel is closed, even with watch on', () => {
    expect(shouldFollowAgentTab({ ...watching, panelOpen: false })).toBe(false);
  });

  test('a persisted toggle cannot resurrect focus-steal for an unattended run', () => {
    // The field case: setting still true from last week, Routine fires, panel closed.
    for (const agentTabId of [1, 42, 999]) {
      expect(shouldFollowAgentTab({ ...watching, panelOpen: false, agentTabId })).toBe(false);
    }
  });

  // why panelOpen and not "any peerd surface": the full-page home is the front
  // door, and its port self-reconnects across every SW respawn — so a home tab
  // parked in a background window would otherwise keep "someone is watching" true
  // forever. The guard takes only the panel, so a parked home tab reads as absent
  // (the caller passes uiPorts.hasNamed('sidepanel'), never 'home').
  test('a parked home tab does not count as watching — only the panel arms the follow', () => {
    expect(shouldFollowAgentTab({ ...watching, panelOpen: false })).toBe(false);
  });
});

// The worst symptom of every path the audit found: peerd hauling Chrome over the
// app the user had alt-tabbed to. If they aren't in the browser, nothing peerd
// does is being watched.
describe('shouldFollowAgentTab — never raise the browser over another app', () => {
  test('NEVER follows while the browser is not the focused application', () => {
    expect(shouldFollowAgentTab({ ...watching, chromeFocused: false })).toBe(false);
  });

  test('the browser-focus guard holds even with watch on and the panel open', () => {
    expect(shouldFollowAgentTab({
      watchOn: true, panelOpen: true, chromeFocused: false, agentTabId: 7, alreadyInFront: false,
    })).toBe(false);
  });
});

// alreadyInFront is resolved by the caller from LIVE tab state (tabs.get →
// tab.active && tab.windowId === lastFocusedWindowId) rather than a remembered
// activeTabId, which was unseeded after an MV3 respawn AND global while `active`
// is per-window — defeating the no-op guard in exactly the two-window layout
// watch mode encourages.
describe('shouldFollowAgentTab — no needless focus grab', () => {
  test('never follows a tab already frontmost in the focused window', () => {
    expect(shouldFollowAgentTab({ ...watching, alreadyInFront: true })).toBe(false);
  });

  test('a settled agent (tab already in front) stays silent across repeated touches', () => {
    // noteAgentTab fires per tool call; a watching user must not get their window
    // re-raised on every one of them.
    for (let i = 0; i < 5; i++) {
      expect(shouldFollowAgentTab({ ...watching, alreadyInFront: true })).toBe(false);
    }
  });
});

describe('shouldFollowAgentTab — strict booleans (a truthy non-true never arms focus-steal)', () => {
  test('each gate requires literal true', () => {
    expect(shouldFollowAgentTab({ ...watching, watchOn: 1 as unknown as boolean })).toBe(false);
    expect(shouldFollowAgentTab({ ...watching, watchOn: 'yes' as unknown as boolean })).toBe(false);
    expect(shouldFollowAgentTab({ ...watching, panelOpen: 1 as unknown as boolean })).toBe(false);
    expect(shouldFollowAgentTab({ ...watching, chromeFocused: 1 as unknown as boolean })).toBe(false);
  });
});
