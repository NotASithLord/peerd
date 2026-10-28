// @ts-check
// home/first-tab.js - pure rules for "Keep peerd as the first tab": the
// one-time offer after the first setup (on Home or in the side panel), the
// one-time hint in the pinned tab, and the live state that Home's tab icon
// and title show.
//
// A pinned tab shows only its icon, so the icon carries the state: a ring
// while peerd works, and a dot when a reply came while you were elsewhere.
// No sends, no DOM: home.js applies the results. Bun tests pin each rule.

/** @typedef {'idle'|'working'|'reply'} TabPresence */
/**
 * @typedef {{ presence: TabPresence, streaming: boolean, sessionId: string|null,
 *   looked: boolean }} PresenceState
 *   looked - Home is in view as a turn ends, so the user saw the reply.
 */

/**
 * Home's first-run gate: onboarding, or the one network choice that an
 * existing profile still has to make.
 * @param {{ profile?: { onboardingComplete?: unknown } | null,
 *   settings?: { dwebChoiceMade?: unknown } | null } | null | undefined} state
 * @param {boolean} dwebEnabled
 */
export const setupPending = (state, dwebEnabled) =>
  state?.profile?.onboardingComplete === false
  || dwebEnabled && state?.settings?.dwebChoiceMade === false;

/**
 * The offer shows once: on the surface that saw setup finish, until the user
 * answers it there or the settings say it was answered.
 * @param {{ sawSetup: boolean, answered: boolean,
 *   settings?: { firstTabEnabled?: unknown, firstTabOffered?: unknown } | null }} input
 */
export const firstTabOfferVisible = ({ sawSetup, answered, settings }) => sawSetup && !answered
  && settings?.firstTabOffered !== true && settings?.firstTabEnabled !== true;

/**
 * In the side panel, "Keep it" opens the new tabs out of sight, so one line
 * says what changed. It goes once the chat starts.
 * @param {{ kept: boolean, messages: number }} input
 */
export const firstTabKeptVisible = ({ kept, messages }) => kept && messages === 0;

/** @param {'keep'|'later'} answer @returns {Record<string, boolean>} */
export const firstTabOfferPatch = (answer) => answer === 'keep'
  ? { firstTabEnabled: true, firstTabOffered: true }
  : { firstTabOffered: true };

/**
 * The hint shows in a pinned Home tab until the user says "Got it".
 * @param {{ pinned?: boolean, seen: boolean }} input
 */
export const firstTabHintVisible = ({ pinned, seen }) => pinned === true && !seen;

/** @type {PresenceState} */
export const INITIAL_PRESENCE = Object.freeze({
  presence: 'idle', streaming: false, sessionId: null, looked: false,
});

/**
 * A reply is ready only when a turn of the same chat ends while Home is out
 * of view and the side panel is closed. Coming back to Home, or opening the
 * panel, clears it. A chat switch also ends the streaming flag: it is not a
 * reply.
 * @param {PresenceState} prev
 * @param {{ streaming: boolean, sessionId: string|null, hidden: boolean,
 *   panelOpen: boolean }} now
 * @returns {PresenceState}
 */
export const nextPresence = (prev, { streaming, sessionId, hidden, panelOpen }) => {
  const turnEnded = prev.streaming && !streaming && prev.sessionId === sessionId;
  const unseen = hidden && !panelOpen;
  /** @type {TabPresence} */
  const presence = streaming ? 'working'
    : unseen && (turnEnded || prev.presence === 'reply') ? 'reply' : 'idle';
  return { presence, streaming, sessionId, looked: turnEnded && !hidden };
};

/** Another Home showed the reply. @param {PresenceState} state @returns {PresenceState} */
export const clearReply = (state) => state.presence === 'reply'
  ? { ...state, presence: 'idle', looked: false } : state;

/**
 * A lost port (the worker restarted) is not a reply, and it does not clear a
 * reply the user has not seen yet. Only the working state goes.
 * @param {PresenceState} state @returns {PresenceState}
 */
export const presenceAfterPortLoss = (state) => ({
  ...INITIAL_PRESENCE, presence: state.presence === 'reply' ? 'reply' : 'idle',
});

/**
 * With chat in the side panel, a pinned Home tab shows the apps: the "open
 * your apps" half of its hint. Other Home tabs show Actors.
 * @param {{ pinned?: boolean, discover: boolean }} input
 */
export const viewBesidePanel = ({ pinned, discover }) => pinned !== true ? 'actors'
  : discover ? 'discover' : 'library';

// The extension icon: five stripes and a white "p", traced from
// icons/icon128.png on its 128-unit grid. The colors are the icon's own.
const STRIPES = ['#00bce5', '#ef4444', '#f59e0b', '#22c55e', '#db2777'].map((fill, index) =>
  `<rect y="${(index * 128) / 5}" width="128" height="25.6" fill="${fill}"/>`).join('');
// The stem, then the bowl drawn one way and its hole the other way round.
const GLYPH = 'M26 14h20v103H26zM36.5 53a32.5 42 0 1 1 65 0a32.5 42 0 1 1-65 0z'
  + 'M45.5 53a17.5 24.5 0 1 0 35 0a17.5 24.5 0 1 0-35 0z';
const MARK = `<clipPath id="c"><rect width="128" height="128" rx="12"/></clipPath>`
  + `<g clip-path="url(#c)">${STRIPES}</g><path fill="#fff" d="${GLYPH}"/>`;
/** @param {number} x @param {number} y @param {number} size */
const mark = (x, y, size) =>
  `<g transform="translate(${x} ${y}) scale(${size / 128})">${MARK}</g>`;

// The working ring: the five brand colors, as on the spinner. Chrome does not
// animate a tab icon, so the ring is still.
const RING_RADIUS = 14.4;
const RING_SEGMENT = (2 * Math.PI * RING_RADIUS) / 5;
const RING = ['#00b7eb', '#d946ef', '#f59e0b', '#22c55e', '#ef4444'].map((stroke, index) =>
  `<circle cx="16" cy="16" r="${RING_RADIUS}" fill="none" stroke="${stroke}" stroke-width="2.6"`
  + ` stroke-dasharray="${RING_SEGMENT.toFixed(3)} ${(RING_SEGMENT * 4).toFixed(3)}"`
  + ` stroke-dashoffset="${(-index * RING_SEGMENT).toFixed(3)}" transform="rotate(-90 16 16)"/>`)
  .join('');

// The reply dot sits on the mark's top right corner. A clear ring cut from
// the mark lets the tab strip's own color show around it.
const DOT = '<style>.d{fill:#1a1a1a}@media (prefers-color-scheme:dark){.d{fill:#f3f3ef}}</style>'
  + '<mask id="m"><rect width="32" height="32" fill="#fff"/><circle cx="27" cy="5" r="7.4"/></mask>'
  + `<g mask="url(#m)">${mark(0, 4, 28)}</g><circle class="d" cx="27" cy="5" r="5"/>`;

/** @param {string} body */
const svgIcon = (body) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;

/**
 * The tab icon for each state. Idle is the packaged extension icon, the one
 * the tab shows before Home sets any icon.
 * @param {TabPresence} presence
 */
export const presenceIcon = (presence) => presence === 'working'
  ? svgIcon(mark(7, 7, 18) + RING)
  : presence === 'reply' ? svgIcon(DOT) : '/icons/icon32.png';

/**
 * The tab title: the tooltip of a pinned tab and its name for screen readers.
 * Firefox marks a pinned tab whose title changes in the background, and the
 * mark stays until the user selects that tab. So in Firefox the title stays
 * put, and the icon alone shows the state.
 * @param {TabPresence} presence @param {string} idleTitle @param {boolean} firefox
 */
export const presenceTitle = (presence, idleTitle, firefox) => firefox ? idleTitle
  : presence === 'working' ? 'peerd is working…'
    : presence === 'reply' ? 'peerd has a reply' : idleTitle;
