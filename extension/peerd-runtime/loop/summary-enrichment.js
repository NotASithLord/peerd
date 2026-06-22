// @ts-check
// Trim-summary enrichment — the imperative shell over rolling-summary.js.
//
// The agent loop's trim path folds dropped turns into the rolling state
// MECHANICALLY (counts + tool stats) and fires the injected
// `enrichTrimSummary` seam fire-and-forget. This module is what the SW
// binds behind that seam: queue the request during the turn, run ONE
// cheap clean-context model call AFTER the turn ends, merge the
// structured facts/decisions/open-threads into the persisted state for
// FUTURE turns.
//
// why queue-then-drain instead of calling at trim time: the trim fires
// inside the streaming loop; a model call there would (a) add latency
// to every step of an over-cap session and (b) race the loop's own
// session-record writes. Draining after the turn keeps the loop's
// "never block on summarization" guarantee structural rather than
// best-effort — the mechanical summary is already persisted and in use
// before the enrichment call even starts. Failure anywhere below
// degrades to exactly the current mechanical collapse.
//
// All IO is injected (cheapCall, sessions, audit) so bun tests exercise
// this without a browser.

import {
  normalizeSummaryState, mergeEnrichment, digestMessages,
  buildSummarizationTask, parseSummarizationResult,
} from './rolling-summary.js';

/** @typedef {import('./rolling-summary.js').TrimSummaryState} TrimSummaryState */
/** @typedef {import('./rolling-summary.js').DigestMessage} DigestMessage */

/**
 * The trim event the agent loop fires through the enrichTrimSummary seam.
 * `newlyDropped` is only ever handed to digestMessages, which reads it
 * defensively — hence the loose DigestMessage element type.
 *
 * @typedef {Object} TrimEnrichRequest
 * @property {string} sessionId
 * @property {TrimSummaryState} state
 * @property {ReadonlyArray<DigestMessage | null | undefined>} newlyDropped
 */

// Output cap for the summarisation call — a few structured lists, not
// an essay. Rides spawnSubagent's maxOutputTokens guardrail.
export const ENRICHMENT_MAX_OUTPUT_TOKENS = 600;

/**
 * @param {Object} deps
 * @param {(req: { sessionId: string, task: string, maxOutputTokens?: number, label?: string }) =>
 *   Promise<{ ok: boolean, text?: string, skipped?: boolean, reason?: string }>} deps.cheapCall
 *   The shared cheap-call helper (subagent/cheap-call.js): clean-context
 *   tools:[] spawn with the spend-limit preflight + cost fold built in.
 * @param {{ get: Function, setTrimSummary: Function }} deps.sessions
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 */
export const makeTrimEnricher = ({ cheapCall, sessions, appendAudit = async () => {} }) => {
  /** @type {Map<string, TrimEnrichRequest>} */
  const pending = new Map();

  /**
   * Record a trim event for later enrichment. Latest-wins per session:
   * a multi-step turn can trim several times, and only the final state
   * (which already folds every earlier drop) is worth a model call.
   *
   * @param {TrimEnrichRequest} req
   */
  const queue = (req) => {
    if (!req || typeof req.sessionId !== 'string' || !req.sessionId) return;
    pending.set(req.sessionId, req);
  };

  /**
   * Run the enrichment for a session's queued trim, if any. Called by
   * the SW after a turn finishes (fire-and-forget). Every failure path
   * returns a reason instead of throwing — the mechanical summary is
   * already in place, so there is nothing to recover.
   *
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, skipped?: string, reason?: string }>}
   */
  const drain = async (sessionId) => {
    const req = pending.get(sessionId);
    if (!req) return { ok: true, skipped: 'nothing-pending' };
    pending.delete(sessionId);
    try {
      const task = buildSummarizationTask({
        state: req.state,
        droppedDigest: digestMessages(req.newlyDropped),
      });
      const out = await cheapCall({
        sessionId,
        task,
        maxOutputTokens: ENRICHMENT_MAX_OUTPUT_TOKENS,
        label: 'trim-summary',
      });
      if (!out.ok) return { ok: false, reason: out.reason ?? 'call-failed' };
      // why ?? '': parseSummarizationResult treats undefined and '' alike
      // (both → null), so this is runtime-identical and just satisfies the
      // string param.
      const parsed = parseSummarizationResult(out.text ?? '');
      if (!parsed) return { ok: false, reason: 'unparseable' };
      // why re-read: the loop may have folded MORE drops since this was
      // queued; merge onto the freshest persisted state so mechanical
      // counts are never rolled back. A session with no state anymore
      // (deleted, reset) just skips.
      const session = await sessions.get(sessionId);
      if (!session?.trimSummary) return { ok: true, skipped: 'no-state' };
      const merged = mergeEnrichment(normalizeSummaryState(session.trimSummary), parsed);
      await sessions.setTrimSummary(sessionId, merged);
      appendAudit({
        type: 'trim_summary_enriched',
        sessionId,
        details: {
          facts: merged.facts.length,
          decisions: merged.decisions.length,
          threads: merged.threads.length,
        },
      }).catch(() => {});
      return { ok: true };
    } catch (e) {
      // why swallow: enrichment is advisory; an exception here must
      // never surface to the chat or the caller's finally block.
      return { ok: false, reason: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
    }
  };

  return { queue, drain, pendingCount: () => pending.size };
};
