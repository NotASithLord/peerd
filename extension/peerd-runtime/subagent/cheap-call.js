// @ts-check
// Cheap one-shot model calls — the shared helper behind auto-memory
// extraction and trim-summary enrichment.
//
// Reuses the EXISTING subagent machinery (spawn.js) the same way the
// review orchestrator does: a `tools: []` spawn is a fresh child
// session whose only input is the task — clean context for free, no
// dispatcher/tool plumbing stood up at all, and an output cap riding
// spawnSubagent's maxOutputTokens guardrail. We do not build a second
// model-call path.
//
// What this adds on top of a bare spawn:
//   - the spend-limit PREFLIGHT: if the parent session has already
//     crossed the user's spendLimitUsd, the call is refused before any
//     tokens burn — background quality work must never push a capped
//     session further past its cap.
//   - the cost FOLD: the child's usage is priced via the injected
//     costOf and folded into the PARENT session's persisted tally, so
//     the cost tracker / CostChip / the next turn's hard-limit check
//     all see these calls. Background spend is never invisible.
//
// All IO injected (spawnSubagent, sessions, costOf) — bun-testable.

import { normalizeTally, addUsage, limitExceeded } from '../cost/accumulator.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').TokenUsage} TokenUsage */

export const CHEAP_CALL_MAX_STEPS = 2;
export const CHEAP_CALL_MAX_OUTPUT_TOKENS = 700;

/**
 * @param {Object} deps
 * @param {(req: object) => Promise<{ result: string, sessionId: string|null, usage?: TokenUsage, refused?: true, durationMs?: number }>} deps.spawnSubagent
 *   The bound spawn from makeSpawnSubagent (SW passes its own bound fn).
 * @param {{ get: Function, setCost: Function }} deps.sessions
 * @param {(model: string|undefined, usage: TokenUsage) => { cost: number }} deps.costOf
 *   Pricing fn (peerd-provider's local table), pre-bound to the user's
 *   pricing overrides by the SW. Injected, never imported — DI rule.
 * @param {() => number|undefined} [deps.getSpendLimitUsd]  settings.spendLimitUsd at call time
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 */
export const makeCheapCall = ({
  spawnSubagent,
  sessions,
  costOf,
  getSpendLimitUsd = () => 0,
  appendAudit = async () => {},
}) => {
  /**
   * @param {Object} req
   * @param {string} req.sessionId         the session this work is FOR (cost attribution)
   * @param {string} req.task              the one-shot prompt
   * @param {number} [req.maxOutputTokens]
   * @param {number} [req.maxSteps]
   * @param {string} [req.label]           audit label ('auto-memory', 'trim-summary')
   * @returns {Promise<{ ok: boolean, text?: string, skipped?: boolean, reason?: string,
   *   usage?: object, childSessionId?: string|null }>}
   */
  return async ({
    sessionId,
    task,
    maxOutputTokens = CHEAP_CALL_MAX_OUTPUT_TOKENS,
    maxSteps = CHEAP_CALL_MAX_STEPS,
    label = 'cheap-call',
  }) => {
    const session = sessionId ? await sessions.get(sessionId) : null;
    if (!session) return { ok: false, skipped: true, reason: 'no-session' };

    const limit = getSpendLimitUsd();
    const tally = normalizeTally(session.cost);
    if (limitExceeded(tally.cost, limit)) {
      appendAudit({
        type: 'cheap_call_skipped',
        sessionId,
        details: { label, reason: 'spend-limit', spent: tally.cost, limitUsd: limit },
      }).catch(() => {});
      return { ok: false, skipped: true, reason: 'spend-limit' };
    }

    const out = await spawnSubagent({
      task,
      // why tools:[]: pure reasoning — spawn.js skips the dispatcher and
      // tool-context plumbing entirely for an empty subset, which is
      // exactly the "cheap, narrow, clean-context" contract.
      tools: [],
      maxSteps,
      maxOutputTokens,
      parentSessionId: sessionId,
      parentDepth: session.depth ?? 0,
      // why persistDeltas:false + a no-op onEvent: this child is
      // ephemeral background work — no side-panel card to stream into
      // (the SW's default forwarder would post orphan subagent events),
      // and per-delta IDB rewrites buy nothing for a one-shot answer.
      persistDeltas: false,
      onEvent: () => {},
    });
    if (out.refused) return { ok: false, reason: out.result };

    // Fold the child's spend into the parent session's persisted tally.
    // Re-read the record first: the tally may have advanced since our
    // snapshot (these calls run between turns by design — see the
    // queue-then-drain rationale in summary-enrichment.js).
    if (out.usage) {
      let cost = 0;
      try { cost = costOf(session.model, out.usage)?.cost ?? 0; } catch { cost = 0; }
      try {
        const fresh = await sessions.get(sessionId);
        const folded = addUsage(normalizeTally(fresh?.cost), out.usage, cost);
        await sessions.setCost(sessionId, folded);
      } catch { /* a persist hiccup must not fail the call */ }
    }

    return {
      ok: true,
      text: out.result,
      usage: out.usage,
      childSessionId: out.sessionId ?? null,
    };
  };
};
