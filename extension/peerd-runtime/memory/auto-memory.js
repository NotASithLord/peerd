// @ts-check
// Auto-memory — pure functional core (no IO).
//
// When a session wraps up (archive, or the user switches away from a
// chat with real substance), a cheap clean-context model call proposes
// candidate durable notes about the USER and ongoing work. Proposals
// are NEVER auto-written: they land as pending suggestions in the
// Context → Memory tab, where the user approves or dismisses each.
// Approval appends to the user doc (memory scope 'user') through the
// existing write machinery — the click IS the consent, the same
// contract the Context-tab editor and onboarding seeding follow.
//
// This file owns the decisions and the text shaping: when extraction
// is worth firing, what the transcript digest looks like, the
// extraction prompt, the parse of the model's output, and the
// append-into-user-doc body builder. The orchestrator
// (auto-memory-orchestrator.js) binds the IO.
//
// why "very frugal" everywhere: the user doc loads into EVERY prompt
// under the always-loaded line budget (owner's standing instruction —
// user-doc growth stays frugal). The prompt demands few, high-
// durability notes (often zero); parse caps clamp whatever comes back;
// substring dedupe drops anything the doc already knows.

/** @typedef {import('../../peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * The extraction watermark the orchestrator stamps on a session before
 * each call (auto-memory-orchestrator.js: `sessions.update(..., {
 * autoMemory })`). Not part of the base Session shape — bookkeeping this
 * subsystem owns.
 * @typedef {Object} AutoMemoryWatermark
 * @property {number} [at]          epoch ms of the last extraction
 * @property {number} [userTurns]   user-turn count covered by it
 */


// "A handful of substantive turns" before extraction is worth a model
// call — and a floor on total prose so five "hi"-grade messages don't
// qualify.
export const AUTO_MEMORY_MIN_USER_TURNS = 4;
export const AUTO_MEMORY_MIN_CHARS = 400;
// Re-extraction on a later switch-away needs this many NEW user turns
// past the stored watermark — switching back and forth must not refire.
export const AUTO_MEMORY_MIN_NEW_USER_TURNS = 3;

export const MAX_NOTES_PER_EXTRACTION = 3;
export const NOTE_MAX_CHARS = 240;
export const MAX_PENDING_SUGGESTIONS = 20;

/**
 * Count the SUBSTANTIVE content of a session: real user turns (typed
 * text — not tool-result carriers, not synthetic trim summaries),
 * assistant replies with text, and total prose volume.
 *
 * @param {readonly InternalMessage[] | undefined} messages
 * @returns {{ userTurns: number, assistantReplies: number, chars: number }}
 */
export const substantiveStats = (messages) => {
  let userTurns = 0;
  let assistantReplies = 0;
  let chars = 0;
  for (const m of messages ?? []) {
    // why: `synthetic` is declared on UserMessage only; read it on the
    // union without widening to any — synthetic trim summaries are skipped.
    if (!m || /** @type {{ synthetic?: boolean }} */ (m).synthetic) continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (m.role === 'user') {
      if (Array.isArray(m.toolResults) && m.toolResults.length > 0) continue;
      if (!text) continue;
      userTurns++;
      chars += text.length;
    } else if (m.role === 'assistant' && text) {
      assistantReplies++;
      chars += text.length;
    }
  }
  return { userTurns, assistantReplies, chars };
};

/**
 * Should extraction fire for this session right now? Pure decision over
 * the session record — the lifecycle trigger (archive / switch-away)
 * and the autoMemoryEnabled gate are the caller's job; this answers
 * "does the session have enough NEW substance to be worth a call?".
 *
 * The watermark (`session.autoMemory.userTurns`, written by the
 * orchestrator before each extraction) is what makes the trigger
 * idempotent across repeated switches and SW restarts.
 *
 * @param {Object} input
 * @param {{ kind?: string, messages?: readonly object[],
 *   autoMemory?: AutoMemoryWatermark } | null | undefined} input.session
 *   The slice this reads — kept loose (all fields optional, messages
 *   un-narrowed) so callers and tests can pass a partial record;
 *   substantiveStats narrows each message at runtime.
 * @param {number} [input.minUserTurns]
 * @param {number} [input.minNewUserTurns]
 * @param {number} [input.minChars]
 * @returns {{ extract: true, reason?: string, stats: ReturnType<typeof substantiveStats> }
 *   | { extract: false, reason: string, stats?: ReturnType<typeof substantiveStats> }}
 *   Discriminated on `extract`: a fire always carries stats; `reason` is
 *   readable on either branch (absent on a fire).
 */
export const shouldExtract = ({
  session,
  minUserTurns = AUTO_MEMORY_MIN_USER_TURNS,
  minNewUserTurns = AUTO_MEMORY_MIN_NEW_USER_TURNS,
  minChars = AUTO_MEMORY_MIN_CHARS,
}) => {
  if (!session) return { extract: false, reason: 'no-session' };
  // Subagent/runner sessions are decomposition scratch — their parent
  // chat is the one that wraps up.
  if ((session.kind ?? 'chat') !== 'chat') return { extract: false, reason: 'not-a-chat' };
  // why cast: the param keeps `messages` un-narrowed for caller/test
  // flexibility; substantiveStats narrows each entry at runtime.
  const stats = substantiveStats(/** @type {readonly InternalMessage[] | undefined} */ (session.messages));
  if (stats.userTurns < minUserTurns) return { extract: false, reason: 'too-few-turns', stats };
  if (stats.chars < minChars) return { extract: false, reason: 'too-little-content', stats };
  const watermark = session.autoMemory?.userTurns;
  const covered = Number.isFinite(watermark) ? /** @type {number} */ (watermark) : 0;
  if (covered > 0 && stats.userTurns - covered < minNewUserTurns) {
    return { extract: false, reason: 'no-new-substance', stats };
  }
  return { extract: true, stats };
};

/**
 * Render the session transcript as a plain-text digest for the
 * extraction call. User/assistant text only — tool results and
 * synthetic trim summaries stay out (page-derived bulk must not ride
 * into the extractor's context).
 *
 * @param {readonly InternalMessage[] | undefined} messages
 * @param {Object} [opts]
 * @param {number} [opts.maxChars=7000]
 * @param {number} [opts.perMessageChars=300]
 * @returns {string}
 */
export const transcriptDigest = (messages, { maxChars = 7000, perMessageChars = 300 } = {}) => {
  const lines = [];
  for (const m of messages ?? []) {
    if (!m || /** @type {{ synthetic?: boolean }} */ (m).synthetic) continue;
    const text = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    if (m.role === 'user') {
      if (Array.isArray(m.toolResults) && m.toolResults.length > 0) continue;
      lines.push(`User: ${text.slice(0, perMessageChars)}`);
    } else if (m.role === 'assistant') {
      lines.push(`Assistant: ${text.slice(0, perMessageChars)}`);
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    // why head+tail: openings carry who the user is and what they came
    // for; endings carry where the work landed. The middle compresses.
    const head = out.slice(0, Math.floor(maxChars * 0.6));
    const tail = out.slice(-Math.floor(maxChars * 0.35));
    out = `${head}\n[... elided ...]\n${tail}`;
  }
  return out;
};

/**
 * Build the narrow extraction task. Deliberately strict: most sessions
 * should yield ZERO notes — the prompt says so in as many words, shows
 * the current user doc so the model never re-proposes what's already
 * known, and demands strict JSON for a dumb parse.
 *
 * @param {Object} input
 * @param {string} input.digest        transcriptDigest output
 * @param {string} [input.userDocBody] current user-doc body ('' if none)
 * @param {number} [input.maxNotes]
 * @returns {string}
 */
export const buildExtractionTask = ({ digest, userDocBody = '', maxNotes = MAX_NOTES_PER_EXTRACTION }) => [
  'You review a finished chat session and propose DURABLE memory notes',
  'about the user — facts worth knowing in every future session.',
  '',
  'Be extremely frugal. Most sessions contain NOTHING durable: respond',
  '{"notes": []} unless a note clearly passes ALL of these bars:',
  '  - durable: still true and useful months from now (identity, role,',
  '    standing preferences, long-running projects) — never one-off',
  '    task details, page contents, or anything the session resolved;',
  '  - about the USER or their ongoing work, not about the assistant;',
  '  - not already covered by the current notes below.',
  `Never propose more than ${maxNotes}; one short line each (max`,
  `${NOTE_MAX_CHARS} characters), telegraphic, no preamble.`,
  '',
  'CURRENT NOTES ON THE USER:',
  userDocBody.trim() ? userDocBody.trim() : '(none)',
  '',
  'SESSION TRANSCRIPT (digest):',
  digest || '(empty)',
  '',
  'Respond with ONLY a JSON object: {"notes": ["..."]} — or',
  '{"notes": []} when nothing qualifies.',
].join('\n');

/** @param {unknown} s */
const cleanNote = (s) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim().slice(0, NOTE_MAX_CHARS) : '';

/**
 * Parse the extraction call's output into candidate note strings.
 * Primary path: the strict JSON the prompt demands (tolerating fences
 * and stray prose around it). Fallback: bullet lines, for a model that
 * ignored the format. Caps + dedupe always apply; anything unparseable
 * yields [] — never an error, zero notes is the expected common case.
 *
 * @param {string | undefined} text   the model's raw output (may be absent)
 * @param {Object} [opts]
 * @param {number} [opts.maxNotes]
 * @returns {string[]}
 */
export const parseExtractionNotes = (text, { maxNotes = MAX_NOTES_PER_EXTRACTION } = {}) => {
  if (typeof text !== 'string' || !text.trim()) return [];
  let raw = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(obj?.notes)) raw = obj.notes;
    } catch { /* fall through to the bullet fallback */ }
  }
  if (raw.length === 0 && (start < 0 || end <= start)) {
    raw = text.split('\n').filter((l) => /^\s*[-•*]\s+/.test(l));
  }
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const note = cleanNote(r);
    if (!note) continue;
    const key = note.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(note);
    if (out.length >= maxNotes) break;
  }
  return out;
};

/** @param {string} s */
const collapse = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Drop notes the user doc already covers (collapsed-whitespace,
 * case-insensitive substring). Crude on purpose — a near-duplicate that
 * survives still rides the approve gate, so the only cost of a miss is
 * one extra pending chip.
 *
 * @param {string[]} notes
 * @param {string} docBody
 * @returns {string[]}
 */
export const dedupeAgainstDoc = (notes, docBody) => {
  const doc = collapse(typeof docBody === 'string' ? docBody : '');
  if (!doc) return [...notes];
  return notes.filter((n) => !doc.includes(collapse(n)));
};

/**
 * Append one approved note to the user-doc body, under a `## Notes`
 * section (created when missing; appended to in place when present —
 * the bullet lands at the END of the existing section, before any later
 * section, so the doc's structure survives repeated approvals). Pure.
 *
 * @param {string} priorBody  existing user-doc body ('' if none)
 * @param {string} note
 * @returns {string}
 */
export const appendNoteToUserDoc = (priorBody, note) => {
  const clean = cleanNote(note);
  if (!clean) return typeof priorBody === 'string' ? priorBody : '';
  const bullet = `- ${clean}`;
  const prior = typeof priorBody === 'string' ? priorBody.trim() : '';
  if (!prior) {
    // Fresh doc — same title the Context tab's "new user note" and the
    // onboarding seed converge on, so every creation path shares one shape.
    return `# User memory\n\n## Notes\n${bullet}\n`;
  }
  const lines = prior.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+Notes\s*$/.test(l));
  if (headingIdx < 0) {
    return `${prior}\n\n## Notes\n${bullet}\n`;
  }
  // Insert before the next heading after ## Notes (or at the end).
  let insertAt = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { insertAt = i; break; }
  }
  // Back up over blank separator lines so the bullet joins the list.
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, bullet);
  return `${lines.join('\n')}\n`;
};
