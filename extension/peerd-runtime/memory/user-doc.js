// @ts-check
// The USER DOC — seeding for the durable "doc on the user".
//
// The user doc is NOT a new storage surface: it IS the memory system's
// existing 'user' scope (scope id 'user') — the global AGENTS.md-style
// doc that loads into {{MEMORY_BLOCK}} at the top of every session and
// is editable in Context → Memory like any other doc. Reusing that
// scope means the doc automatically rides everything memory already
// has: the always-loaded budget, export/import/deleteAll
// reversibility, the Context-tab editor, and — critically — the
// confirm gate on every AGENT-origin write (remember() with
// scope:'user' round-trips the exact diff to the user before anything
// persists; see store.js writeWithConfirm).
//
// Onboarding seeds it from two optional basic-facts fields ("what
// should I call you" + free-text notes — the separate legal-name field
// was folded into callMe, owner call 2026-06-12). Agent expansion over
// time is kept VERY frugal by prompt guidance next to the
// memory-writing guidance in peerd-provider/system-prompt.txt.
//
// Pure functions only — values in, markdown out. The SW owns the write.

/** The memory scope the user doc lives at. */
export const USER_DOC_SCOPE = Object.freeze({ kind: 'user' });

// One-line fields get whitespace collapsed; the free-text notes field
// keeps its line structure (it is the user's prose, not a label).
/** @param {unknown} s */
const cleanLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Build the seeded user-doc body from onboarding's basic facts.
 *
 * Returns '' when there is nothing to write (all fields empty — i.e.
 * Skip, or Start with everything blank), so the caller's "skip writes
 * nothing" is unconditional: empty seed → no memory write at all.
 *
 * why append-not-replace when priorBody exists: an install that
 * predates onboarding may already carry a curated user doc; the
 * onboarding facts must extend it, never clobber it.
 *
 * @param {Object} [facts]
 * @param {string} [facts.callMe]  what the peer should call them
 * @param {string} [facts.notes]   anything else about them, free text
 * @param {string} [priorBody]     existing user-doc body, if any
 * @returns {string}               new full body, or '' to write nothing
 */
export const seedUserDocBody = ({ callMe, notes } = {}, priorBody = '') => {
  const c = cleanLine(callMe);
  const extra = typeof notes === 'string' ? notes.trim() : '';

  const bullets = [];
  if (c) bullets.push(`- Prefers to be called: ${c}`);

  if (bullets.length === 0 && extra === '') return '';

  const section = ['## About the user', ...bullets, ...(extra ? ['', extra] : [])].join('\n');
  const prior = typeof priorBody === 'string' ? priorBody.trim() : '';
  if (prior) return `${prior}\n\n${section}\n`;
  // Fresh doc — same title the Context tab's "new user note" seeds, so
  // the two creation paths converge on one doc shape.
  return `# User memory\n\n${section}\n`;
};
