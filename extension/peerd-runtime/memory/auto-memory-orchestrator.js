// @ts-check
// Auto-memory orchestrator — the imperative shell over auto-memory.js.
//
// The SW calls maybeExtract() at the REAL session-lifecycle seams —
// session/archive and switching away (session/switch, session/reset) —
// never on a timer. The flow:
//
//   lifecycle seam → gate (setting, busy, substance, watermark)
//     → watermark the session (idempotence across repeats + SW restarts)
//     → ONE cheap clean-context model call (cheap-call.js: tools:[],
//       output cap, spend-limit preflight, cost folded into the session
//       tally so the tracker sees it)
//     → parse + dedupe against the current user doc
//     → land survivors as PENDING suggestions (suggestions.js)
//
// Nothing is auto-written to memory: the user approves each suggestion
// in Context → Memory, and only that approval writes the user doc.
//
// All IO injected — bun tests drive this with fakes end to end.

import {
  shouldExtract, transcriptDigest, buildExtractionTask,
  parseExtractionNotes, dedupeAgainstDoc,
} from './auto-memory.js';
import { USER_DOC_SCOPE } from './user-doc.js';

// Output cap for the extraction call: at most 3 telegraphic notes of
// JSON — anything longer is the model ignoring the prompt.
export const EXTRACTION_MAX_OUTPUT_TOKENS = 400;

/**
 * @param {Object} deps
 * @param {{ get: Function, update: Function }} deps.sessions
 * @param {{ readScope: Function }} deps.memory          the memory store
 * @param {ReturnType<typeof import('./suggestions.js').createSuggestionStore>} deps.suggestions
 * @param {(req: { sessionId: string, task: string, maxOutputTokens?: number, label?: string }) =>
 *   Promise<{ ok: boolean, text?: string, skipped?: boolean, reason?: string }>} deps.cheapCall
 * @param {() => { autoMemoryEnabled?: boolean }} [deps.getSettings]
 *   Read CURRENT settings at trigger time (they load async and change).
 * @param {(sessionId: string) => boolean} [deps.isBusy]
 *   Is a turn currently streaming on this session? Extraction skips a
 *   busy session — its cost tally is live and the chat isn't "wrapped
 *   up" in any meaningful sense.
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {(info: { pending: number }) => void} [deps.notify]
 *   Fired when new suggestions land (the SW pings the side panel so the
 *   Memory-tab badge refreshes without a manual reload).
 * @param {() => number} [deps.now]
 */
export const makeAutoMemory = ({
  sessions,
  memory,
  suggestions,
  cheapCall,
  getSettings = () => ({}),
  isBusy = () => false,
  appendAudit = async () => {},
  notify = () => {},
  now = Date.now,
}) => {
  // In-flight latch: archive + switch can both fire for the same
  // session in quick succession; one extraction at a time per session.
  const inFlight = new Set();

  /**
   * @param {string} sessionId
   * @param {'archive' | 'switch'} trigger
   * @returns {Promise<{ ok: boolean, skipped?: string, reason?: string, notes?: number }>}
   */
  const maybeExtract = async (sessionId, trigger) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: true, skipped: 'no-session' };
    if (inFlight.has(sessionId)) return { ok: true, skipped: 'in-flight' };
    // why `=== false`: default ON — absence of the key must not disable
    // the feature (CHANNEL_DEFAULTS carries true; a stored false is the
    // user's explicit opt-out).
    if (getSettings().autoMemoryEnabled === false) return { ok: true, skipped: 'disabled' };
    if (isBusy(sessionId)) return { ok: true, skipped: 'busy' };

    const session = await sessions.get(sessionId);
    const decision = shouldExtract({ session });
    if (!decision.extract) return { ok: true, skipped: decision.reason };

    inFlight.add(sessionId);
    try {
      // Watermark BEFORE the call: a repeat trigger (or a crash between
      // call and landing) re-fires only after genuinely new substance,
      // never as a duplicate of this extraction.
      await sessions.update(sessionId, {
        autoMemory: { at: now(), userTurns: decision.stats.userTurns },
      });

      const userDoc = await memory.readScope(USER_DOC_SCOPE);
      const userDocBody = userDoc?.body ?? '';
      const task = buildExtractionTask({
        digest: transcriptDigest(session.messages),
        userDocBody,
      });
      const out = await cheapCall({
        sessionId,
        task,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
        label: 'auto-memory',
      });
      if (!out.ok) {
        appendAudit({
          type: 'auto_memory_skipped',
          sessionId,
          details: { trigger, reason: out.reason ?? 'call-failed' },
        }).catch(() => {});
        return { ok: false, reason: out.reason ?? 'call-failed' };
      }

      const notes = dedupeAgainstDoc(parseExtractionNotes(out.text), userDocBody);
      if (notes.length === 0) {
        // The expected common case — frugality means usually nothing.
        return { ok: true, notes: 0 };
      }
      const res = await suggestions.addMany(notes, {
        sessionId,
        sessionTitle: session.title ?? null,
      });
      if (res.added > 0) {
        appendAudit({
          type: 'auto_memory_suggested',
          sessionId,
          details: { trigger, notes: res.added },
        }).catch(() => {});
        notify({ pending: res.total });
      }
      return { ok: true, notes: res.added };
    } finally {
      inFlight.delete(sessionId);
    }
  };

  return { maybeExtract };
};
