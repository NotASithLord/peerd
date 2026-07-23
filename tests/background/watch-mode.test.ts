// Watch mode's only non-IO decision: given the live state, do we foreground the
// agent's tab right now? The guard matters because the effect steals window
// focus — so it must fire ONLY when the user opted in AND the tab isn't already
// front. Kept pure so "when do we yank focus" is a tested value, not an effect.

import { describe, test, expect } from 'bun:test';
import { shouldFollowAgentTab } from '../../extension/background/watch-mode.js';

describe('shouldFollowAgentTab', () => {
  test('follows only when watch is ON', () => {
    expect(shouldFollowAgentTab({ watchOn: true, agentTabId: 7, activeTabId: 3 })).toBe(true);
    expect(shouldFollowAgentTab({ watchOn: false, agentTabId: 7, activeTabId: 3 })).toBe(false);
  });

  test('never follows a tab that is already active (no needless focus steal / no-op update)', () => {
    expect(shouldFollowAgentTab({ watchOn: true, agentTabId: 7, activeTabId: 7 })).toBe(false);
  });

  test('never follows when there is no known agent tab', () => {
    expect(shouldFollowAgentTab({ watchOn: true, agentTabId: null, activeTabId: 3 })).toBe(false);
    expect(shouldFollowAgentTab({ watchOn: true, agentTabId: undefined, activeTabId: 3 })).toBe(false);
  });

  test('follows even before any tab is active (activeTabId null → differs from the agent tab)', () => {
    expect(shouldFollowAgentTab({ watchOn: true, agentTabId: 7, activeTabId: null })).toBe(true);
  });

  test('watchOn is strict — only literal true arms it', () => {
    // The setting is a strict boolean; a truthy non-true must not arm focus-steal.
    expect(shouldFollowAgentTab({ watchOn: 1 as unknown as boolean, agentTabId: 7, activeTabId: 3 })).toBe(false);
    expect(shouldFollowAgentTab({ watchOn: 'yes' as unknown as boolean, agentTabId: 7, activeTabId: 3 })).toBe(false);
  });
});
