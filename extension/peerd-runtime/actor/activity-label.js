// @ts-check
// peerd-runtime/actor — what to SAY the agent is doing, in the page it drives.
//
// PURE (tool name + args in → one short phrase out), so the wording is testable
// without a browser and the imperative shell (background/page-activity.js) only
// decides WHEN to show something, never WHAT it says.
//
// why a phrase and not the tool name: this is read by the person whose browser
// is being driven, mid-task, out of the corner of their eye, while they decide
// whether it is safe to touch the keyboard. "type" is jargon and "running tool:
// type" is worse. "Typing…" is the thing they actually need.
//
// WHAT IS DELIBERATELY NOT IN THE PHRASE, and why — this is the part to keep
// when editing:
//
//   1. NEVER the typed text. `type` carries the value going into the field,
//      which is exactly where a password, a card number or a 2FA code lives.
//      Painting it into an on-screen banner would put secrets on the user's
//      monitor (and into any screen recording or shared window) that the page
//      itself was masking. The phrase says "Typing…", never what.
//
//   2. NEVER page-derived text — no click selectors, no element labels, no
//      titles. "Clicking Submit" reads better, but a selector is chosen from
//      content the page authored, so echoing it lets a hostile page write the
//      sentence the user reads while deciding whether to intervene. That is the
//      same reasoning the origin-lock handoff report uses when it names an
//      ORIGIN and never a path (actor/origin-lock-report.js).
//
//   3. Only the HOST of a navigation, never the full URL. Same rule: the host
//      is what tells the user where they are going; the path and query are
//      attacker-shaped and carry no extra meaning at a glance.
//
// So every phrase this returns is drawn from a FIXED vocabulary, with at most a
// hostname interpolated. Nothing the model or the page writes reaches the user's
// screen through this surface.

/**
 * Hostname of a URL, or null when it isn't a parseable absolute URL.
 * why not a regex: `new URL` is the same parse the navigation itself will do, so
 * the phrase can never name a host the browser would disagree about.
 * @param {unknown} value
 * @returns {string | null}
 */
const hostOf = (value) => {
  try {
    const { hostname } = new URL(String(value ?? ''));
    return hostname || null;
  } catch {
    return null;
  }
};

/**
 * The fixed vocabulary. Anything acting on the page gets an entry; a tool absent
 * from this map and not `primitive:'tab'` gets no indicator at all.
 * @type {Readonly<Record<string, string>>}
 */
const PHRASES = Object.freeze({
  click: 'Clicking',
  type: 'Typing',
  page_keys: 'Pressing keys',
  read_page: 'Reading the page',
  read_pdf: 'Reading a PDF',
  snapshot: 'Looking at the page',
  query_dom: 'Looking at the page',
  read_state: 'Looking at the page',
  watch_changes: 'Watching for changes',
  page_exec: 'Running a script on the page',
  page_eval: 'Running a script on the page',
});

/** What the indicator says when a tab tool has no specific phrase. */
export const GENERIC_ACTIVITY = 'Working on the page';

/**
 * The origin, as the pill's second line should read it: host only.
 *
 * why strip the scheme: the line above it already names hosts bare ("Opening
 * github.com"), and `https://` on every pill is eight characters of noise on a
 * surface whose whole job is to be readable at a glance in peripheral vision. A
 * NON-https scheme is kept, because "http" on a page being driven with your
 * session is worth seeing.
 *
 * @param {unknown} origin  a canonical origin, e.g. https://github.com
 * @returns {string}  '' when there is nothing usable to show
 */
export const displayOrigin = (origin) => {
  const raw = String(origin ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return raw;
  }
};

/**
 * Describe one tool call as a phrase for the in-page indicator.
 *
 * @param {string} name   the tool name
 * @param {Record<string, unknown> | null} [args]  the tool's arguments
 * @param {{ isTabTool?: boolean }} [opts]
 *   isTabTool marks a `primitive:'tab'` call the map doesn't name, so a tool
 *   added later still shows SOMETHING rather than silently going dark. why it is
 *   passed in rather than looked up: this file stays pure and free of the tool
 *   registry, which reaches IO.
 * @returns {string | null}  the phrase, or null when nothing should be shown
 */
export const describeToolActivity = (name, args = null, opts = {}) => {
  const tool = String(name ?? '');

  // Navigation names its destination host — the one thing worth interpolating.
  if (tool === 'navigate' || tool === 'open_tab') {
    const host = hostOf(/** @type {Record<string, unknown>} */ (args ?? {}).url);
    return host ? `Opening ${host}` : 'Opening a page';
  }

  const phrase = Object.hasOwn(PHRASES, tool) ? PHRASES[tool] : null;
  if (phrase) return phrase;
  return opts.isTabTool === true ? GENERIC_ACTIVITY : null;
};
