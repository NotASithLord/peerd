// @ts-check
// Cheap one-shot model calls — the shared helper behind auto-memory
// extraction and trim-summary enrichment.
//
// Reuses the EXISTING actor machinery (spawn.js): a `tools: []` spawn is a
// fresh child session whose only input is the task — clean context for free, no
// dispatcher/tool plumbing stood up at all, and an output cap riding
// spawnActor's maxOutputTokens guardrail. We do not build a second
// model-call path.
//
// What this adds on top of a bare spawn:
//   - the spend-limit PREFLIGHT: if the parent session has already
//     crossed the user's spendLimitUsd, the call is refused before any
//     tokens burn — background quality work must never push a capped
//     session further past its cap.
//   - the cost FOLD: the child's sealed-controller price projection is folded
//     into the PARENT session's persisted tally, so
//     the cost tracker / CostChip / the next turn's hard-limit check
//     all see these calls. Background spend is never invisible.
//
// All IO injected (spawnActor, sessions): Bun-testable.

import { normalizeTally, addUsage, limitExceeded } from '../cost/accumulator.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').TokenUsage} TokenUsage */

export const CHEAP_CALL_MAX_STEPS = 2;
export const CHEAP_CALL_MAX_OUTPUT_TOKENS = 700;

/**
 * @param {Object} deps
 * @param {(req: object) => Promise<{ result: string, sessionId: string|null, usage?: TokenUsage, price?:{cost:number,estimated:boolean}, refused?: true, durationMs?: number }>} deps.spawnActor
 *   The bound spawn from makeSpawnActor (SW passes its own bound fn).
 * @param {{ get: Function, setCost: Function }} deps.sessions
 * @param {() => number|undefined} [deps.getSpendLimitUsd]  settings.spendLimitUsd at call time
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 */
export const makeCheapCall = ({
  spawnActor,
  sessions,
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

    const out = await spawnActor({
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
      // (the SW's default forwarder would post orphan actor events),
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
      const price = out.price;
      if (!price || typeof price.cost !== 'number' || !Number.isFinite(price.cost)
          || price.cost < 0 || typeof price.estimated !== 'boolean') {
        appendAudit({
          type: 'cheap_call_price_invalid', sessionId,
          details: { label, performed: true, outcomeKnown: true },
        }).catch(() => {});
        return { ok: false, reason: 'price-invalid', usage: out.usage };
      }
      try {
        const fresh = await sessions.get(sessionId);
        const folded = addUsage(normalizeTally(fresh?.cost), out.usage, price.cost);
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
