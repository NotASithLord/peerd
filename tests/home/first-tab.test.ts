import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INITIAL_PRESENCE,
  clearReply,
  firstTabAutoDue,
  firstTabHintVisible,
  firstTabNoticeVisible,
  firstTabPatch,
  firstTabsToClose,
  homeFirstTabInput,
  nextPresence,
  presenceAfterPortLoss,
  presenceIcon,
  presenceTitle,
  setupPending,
  viewBesidePanel,
} from '../../extension/home/first-tab.js';

type Presence = typeof INITIAL_PRESENCE;
const at = (presence: Presence, now: { streaming: boolean, sessionId?: string|null, hidden: boolean, panelOpen?: boolean }) =>
  nextPresence(presence, { sessionId: 's1', panelOpen: false, ...now });
const working = at(INITIAL_PRESENCE, { streaming: true, hidden: true });
const svg = (href: string) => decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, ''));

describe('first tab: the one-time turn-on', () => {
  test('setup is pending during onboarding, or while a network choice is owed where the network ships', () => {
    expect(setupPending({ profile: { onboardingComplete: false } }, false)).toBe(true);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: false } }, true)).toBe(true);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: false } }, false)).toBe(false);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: true } }, true)).toBe(false);
    // A locked vault has no profile: that is not setup.
    expect(setupPending({ profile: null, settings: {} }, true)).toBe(false);
    expect(setupPending(null, true)).toBe(false);
  });

  test('is due only on the surface that saw setup finish, once that surface is ready, and one time', () => {
    const settings = { firstTabEnabled: false, firstTabOffered: false };
    const due = { sawSetup: true, ready: true, phase: 'idle' as const, settings };
    expect(firstTabAutoDue(due)).toBe(true);
    // Existing users and every surface opened after setup get nothing.
    expect(firstTabAutoDue({ ...due, sawSetup: false })).toBe(false);
    expect(firstTabAutoDue({ ...due, ready: false })).toBe(false);
    for (const phase of ['turning', 'on', 'failed', 'done'] as const) {
      expect(firstTabAutoDue({ ...due, phase })).toBe(false);
    }
    // Another surface did it, or the profile has its answer from an older version.
    expect(firstTabAutoDue({ ...due, settings: { ...settings, firstTabOffered: true } })).toBe(false);
    expect(firstTabAutoDue({ ...due, settings: { ...settings, firstTabEnabled: true } })).toBe(false);
  });

  test('on Home only onboarding counts as setup, and only a kernel snapshot makes Home ready', () => {
    const none = { firstTabEnabled: false, firstTabOffered: false };
    const due = (input: ReturnType<typeof homeFirstTabInput>) => firstTabAutoDue({ ...input, phase: 'idle' });
    // A new profile: onboarding shows, then setup ends.
    const onboarding = homeFirstTabInput(
      { hydrated: true, profile: { onboardingComplete: false }, settings: { ...none, dwebChoiceMade: false } }, true, false);
    expect(onboarding).toMatchObject({ sawSetup: true, ready: false });
    const finished = { hydrated: true, profile: { onboardingComplete: true }, settings: { ...none, dwebChoiceMade: true } };
    expect(due(homeFirstTabInput(finished, true, onboarding.sawSetup))).toBe(true);
    // An existing profile that owes only the network choice gets no turn-on.
    const owes = homeFirstTabInput(
      { hydrated: true, profile: { onboardingComplete: true }, settings: { ...none, dwebChoiceMade: false } }, true, false);
    expect(owes).toMatchObject({ sawSetup: false, ready: false });
    expect(due(homeFirstTabInput(finished, true, owes.sawSetup))).toBe(false);
    // After a port loss Home has default state with no first tab keys. That is not ready.
    const beforeSnapshot = homeFirstTabInput(
      { hydrated: false, profile: { onboardingComplete: true }, settings: {} }, true, true);
    expect(beforeSnapshot).toMatchObject({ sawSetup: true, ready: false });
    expect(due(beforeSnapshot)).toBe(false);
    // Default state never counts as onboarding.
    expect(homeFirstTabInput({ hydrated: false, profile: { onboardingComplete: false } }, true, false).sawSetup).toBe(false);
    expect(homeFirstTabInput(null, true, false)).toMatchObject({ sawSetup: false, ready: false });
  });

  test('the turn-on records that the profile had it; "Turn off" keeps that record', () => {
    expect(firstTabPatch(true)).toEqual({ firstTabEnabled: true, firstTabOffered: true });
    expect(firstTabPatch(false)).toEqual({ firstTabEnabled: false });
  });

  test('the notice shows after the turn-on or its failure, until the chat starts', () => {
    expect(firstTabNoticeVisible({ phase: 'on', messages: 0 })).toBe(true);
    expect(firstTabNoticeVisible({ phase: 'failed', messages: 0 })).toBe(true);
    expect(firstTabNoticeVisible({ phase: 'on', messages: 1 })).toBe(false);
    for (const phase of ['idle', 'turning', 'done'] as const) {
      expect(firstTabNoticeVisible({ phase, messages: 0 })).toBe(false);
    }
  });

  test('"Turn off" closes the pinned Home tabs, never the tab that shows the notice or another page', () => {
    const home = 'chrome-extension://id/home/home.html';
    const tabs = [
      { id: 1, pinned: true, url: `${home}#chat` },
      { id: 2, pinned: true, url: home },
      { id: 3, pinned: true, pendingUrl: home },
      { id: 4, pinned: false, url: home },
      { id: 5, pinned: true, url: 'https://example.com/' },
      { pinned: true, url: home },
    ];
    expect(firstTabsToClose(tabs, home, 1)).toEqual([2, 3]);
    expect(firstTabsToClose(tabs, home)).toEqual([1, 2, 3]);
  });

  test('with chat in the side panel, a pinned Home tab shows the apps, other Home tabs show Actors', () => {
    expect(viewBesidePanel({ pinned: true, discover: true })).toBe('discover');
    expect(viewBesidePanel({ pinned: true, discover: false })).toBe('library');
    expect(viewBesidePanel({ pinned: false, discover: true })).toBe('actors');
    expect(viewBesidePanel({ pinned: undefined, discover: false })).toBe('actors');
  });

  test('the hint shows only in a pinned tab, until it was seen', () => {
    expect(firstTabHintVisible({ pinned: true, seen: false })).toBe(true);
    expect(firstTabHintVisible({ pinned: true, seen: true })).toBe(false);
    expect(firstTabHintVisible({ pinned: false, seen: false })).toBe(false);
    expect(firstTabHintVisible({ pinned: undefined, seen: false })).toBe(false);
  });
});

describe('first tab: what the tab shows', () => {
  test('working while a turn runs, in view or not', () => {
    expect(working.presence).toBe('working');
    expect(at(INITIAL_PRESENCE, { streaming: true, hidden: false }).presence).toBe('working');
    expect(at(INITIAL_PRESENCE, { streaming: false, hidden: true }).presence).toBe('idle');
  });

  test('a reply is ready when the turn ends while Home is out of view and the panel is closed', () => {
    const reply = at(working, { streaming: false, hidden: true });
    expect(reply).toEqual({ presence: 'reply', streaming: false, sessionId: 's1', looked: false });
    // It stays while the user is elsewhere, and a new turn shows working again.
    expect(at(reply, { streaming: false, hidden: true }).presence).toBe('reply');
    expect(at(reply, { streaming: true, hidden: true }).presence).toBe('working');
  });

  test('no reply dot when the user can see the reply', () => {
    const inView = at(working, { streaming: false, hidden: false });
    expect(inView.presence).toBe('idle');
    // The other Home tabs learn that the user saw it.
    expect(inView.looked).toBe(true);
    expect(at(working, { streaming: false, hidden: true, panelOpen: true }).presence).toBe('idle');
  });

  test('looking at Home, opening the panel, or another Home showing it clears the dot', () => {
    const reply = at(working, { streaming: false, hidden: true });
    expect(at(reply, { streaming: false, hidden: false }).presence).toBe('idle');
    expect(at(reply, { streaming: false, hidden: true, panelOpen: true }).presence).toBe('idle');
    expect(clearReply(reply).presence).toBe('idle');
    expect(clearReply(working)).toBe(working);
  });

  test('a chat switch is not a reply', () => {
    expect(at(working, { streaming: false, hidden: true, sessionId: 's2' }).presence).toBe('idle');
    expect(at(working, { streaming: false, hidden: true, sessionId: null }).presence).toBe('idle');
  });

  test('a lost port is not a reply, and it keeps a reply the user has not seen', () => {
    // A turn that was running when the worker restarted is not a reply.
    const lost = presenceAfterPortLoss(working);
    expect(lost).toEqual(INITIAL_PRESENCE);
    expect(at(lost, { streaming: false, hidden: true }).presence).toBe('idle');
    // A reply the user has not seen stays after the port comes back.
    const reply = at(working, { streaming: false, hidden: true });
    const kept = presenceAfterPortLoss(reply);
    expect(kept.presence).toBe('reply');
    expect(kept.streaming).toBe(false);
    expect(at(kept, { streaming: false, hidden: true }).presence).toBe('reply');
    expect(at(kept, { streaming: false, hidden: false }).presence).toBe('idle');
  });

  test('icons: the packaged icon at rest, the ring while working, the dot for a reply', () => {
    expect(presenceIcon('idle')).toBe('/icons/icon32.png');
    expect(presenceIcon('working')).toStartWith('data:image/svg+xml,');
    expect(presenceIcon('reply')).toStartWith('data:image/svg+xml,');
    const ring = svg(presenceIcon('working'));
    const dot = svg(presenceIcon('reply'));
    for (const icon of [ring, dot]) {
      // The icon's five stripes and its white p.
      for (const stripe of ['#00bce5', '#ef4444', '#f59e0b', '#22c55e', '#db2777']) {
        expect(icon).toContain(`fill="${stripe}"`);
      }
      expect(icon).toContain('<path fill="#fff"');
    }
    expect(ring.match(/<circle /g)).toHaveLength(5);
    for (const stroke of ['#00b7eb', '#d946ef', '#f59e0b', '#22c55e', '#ef4444']) {
      expect(ring).toContain(`stroke="${stroke}"`);
    }
    expect(dot).toContain('<mask id="m">');
    expect(dot).toContain('<circle class="d" cx="27" cy="5" r="5"/>');
    expect(dot).toContain('@media (prefers-color-scheme:dark){.d{fill:#f3f3ef}}');
    expect(dot).not.toContain('stroke=');
  });

  test('titles say the state in plain words and restore the page title at rest', () => {
    expect(presenceTitle('working', 'home', false)).toBe('peerd is working…');
    expect(presenceTitle('reply', 'home', false)).toBe('peerd has a reply');
    expect(presenceTitle('idle', 'home', false)).toBe('home');
  });

  test('in Firefox the title stays put, so Firefox draws no mark that only a click clears', () => {
    for (const presence of ['idle', 'working', 'reply'] as const) {
      expect(presenceTitle(presence, 'home', true)).toBe('home');
    }
  });

  test('Home names its icon from the first paint, the same one the tab shows at rest', () => {
    // why: Firefox draws a blank globe for a page that names no icon, and a
    // pinned tab shows only its icon.
    const html = readFileSync(join(import.meta.dir, '..', '..', 'extension', 'home', 'home.html'), 'utf8');
    expect(html).toContain(`<link rel="icon" href="${presenceIcon('idle')}">`);
  });
});
