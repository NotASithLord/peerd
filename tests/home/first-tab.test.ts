import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INITIAL_PRESENCE,
  clearReply,
  firstTabHintVisible,
  firstTabKeptVisible,
  firstTabOfferPatch,
  firstTabOfferVisible,
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

describe('first tab: the one-time offer', () => {
  test('setup is pending during onboarding, or while a network choice is owed where the network ships', () => {
    expect(setupPending({ profile: { onboardingComplete: false } }, false)).toBe(true);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: false } }, true)).toBe(true);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: false } }, false)).toBe(false);
    expect(setupPending({ profile: { onboardingComplete: true }, settings: { dwebChoiceMade: true } }, true)).toBe(false);
    // A locked vault has no profile: that is not setup.
    expect(setupPending({ profile: null, settings: {} }, true)).toBe(false);
    expect(setupPending(null, true)).toBe(false);
  });

  test('shows only in the Home that saw setup finish, and only until it is answered', () => {
    const settings = { firstTabEnabled: false, firstTabOffered: false };
    expect(firstTabOfferVisible({ sawSetup: true, answered: false, settings })).toBe(true);
    // Existing users and every Home opened after setup never see it.
    expect(firstTabOfferVisible({ sawSetup: false, answered: false, settings })).toBe(false);
    expect(firstTabOfferVisible({ sawSetup: true, answered: true, settings })).toBe(false);
    expect(firstTabOfferVisible({ sawSetup: true, answered: false, settings: { ...settings, firstTabOffered: true } })).toBe(false);
    expect(firstTabOfferVisible({ sawSetup: true, answered: false, settings: { ...settings, firstTabEnabled: true } })).toBe(false);
  });

  test('"Keep it" turns the setting on; "Not now" only records the answer', () => {
    expect(firstTabOfferPatch('keep')).toEqual({ firstTabEnabled: true, firstTabOffered: true });
    expect(firstTabOfferPatch('later')).toEqual({ firstTabOffered: true });
  });

  test('in the side panel, the line after "Keep it" stays until the chat starts', () => {
    expect(firstTabKeptVisible({ kept: true, messages: 0 })).toBe(true);
    expect(firstTabKeptVisible({ kept: true, messages: 1 })).toBe(false);
    expect(firstTabKeptVisible({ kept: false, messages: 0 })).toBe(false);
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
