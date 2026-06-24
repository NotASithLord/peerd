// @ts-check
// DESIGN-17 — message_resident: the channel to a tab-hosted instance's resident.
//
// You don't mutate an instance; you message its RESIDENT (the per-instance agent
// that exclusively holds that environment's tools). This orchestrator is the
// direct analog of async-subagents (subagent/async-subagents.js): a serializing
// mailbox over turnSlots that NEVER interrupts an in-flight turn, a SW-captured
// correlation (the sender is closed over, not trusted from the resident), a
// wrapUntrusted-fenced reply that re-enters the sender as a synthetic wake, and
// a per-sender runaway guard. Functional core / imperative shell: every IO
// surface is injected, so the spawn → run → reply flow is unit-testable.
//
// P0 posture (the spec's "attended-only"): a message is accepted ONLY from the
// active, attended, first-party chat — `!synthetic && senderSessionId ===
// getActiveSessionId()`. Synthetic/background senders (goal-mode continuations,
// async-subagent wakes, and the resident's own reply wake) are blocked, so the
// unattended path stays closed until the shared inbound clamp lands (P1) and a
// parent↔resident ping-pong can't run autonomously.

/**
 * @param {Object} deps
 * @param {(instanceId: string) => Promise<{ instanceId: string, kind: string, residentSessionId: string, name?: string, tabId?: number } | null>} deps.resolveResident
 *   Resolve an instance id to its (lazily-minted) resident. Returns null when no
 *   instance with that id exists across the three registries.
 * @param {(opts: { residentSessionId: string, message: string, residentTabId?: number, instanceId: string, kind: string }) => Promise<{ result: string }>} deps.runResidentTurn
 *   Drive ONE resident turn (runAgentTurn against the resident session) and
 *   resolve with its final assistant text. Contracted to CLAIM the resident's
 *   turn slot (so runWhenIdle drains correctly).
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean }) => Promise<unknown>} deps.reenter
 *   Re-enter a session with a (synthetic) turn — the SW's runAgentTurn.
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void }} deps.turnSlots
 * @param {() => Promise<string | null>} deps.getActiveSessionId
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {() => number} [deps.now]
 * @param {{ outstanding?: number, rateCap?: number, rateWindowMs?: number, resultChars?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]
 */
export const makeResidentMessaging = (deps) => {
  const {
    resolveResident, runResidentTurn, reenter, turnSlots,
    getActiveSessionId, isVaultLocked, wrapUntrusted,
    appendAudit = async () => {}, now = Date.now, caps = {}, log = () => {},
  } = deps;

  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;

  /** @type {Map<string, number>} senderSessionId → resident messages currently in flight */
  const inFlight = new Map();
  /** @type {Map<string, number[]>} senderSessionId → recent dispatch timestamps (the burst guard) */
  const recentSends = new Map();

  /** @param {string} sender */
  const decInFlight = (sender) => {
    const c = (inFlight.get(sender) ?? 1) - 1;
    if (c <= 0) inFlight.delete(sender); else inFlight.set(sender, c);
  };

  // Re-enter the SENDER with the resident's reply as a synthetic, wrapUntrusted-
  // fenced wake — via runWhenIdle(senderSessionId) so it NEVER steer-aborts the
  // user's live turn (the focus/work-theft bug, DECISIONS #20). Only the one-line
  // lead is trusted; the resident's body is fenced (mandatory for App residents,
  // which render attacker content).
  /** @param {string} senderSessionId @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] */
  const deliver = (senderSessionId, instanceId, kind, name, body, failed = false) => {
    const wrapped = wrapUntrusted({
      origin: instanceId, tool: 'message_resident', body,
      retrievedAt: new Date(now()).toISOString(),
    });
    const who = name ? `${name} (${instanceId})` : instanceId;
    const lead = failed
      ? `The ${kind} resident ${who} could not complete your request:`
      : `The ${kind} resident ${who} you messaged has replied:`;
    turnSlots.runWhenIdle(senderSessionId, () => {
      Promise.resolve(reenter({ userText: `${lead}\n\n${wrapped}`, sessionId: senderSessionId, synthetic: true }))
        .catch((e) => log('reenter failed', e));
    });
  };

  /**
   * @param {{ to?: string, message?: string, senderSessionId?: string|null, synthetic?: boolean }} req
   * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
   */
  const messageResident = async (req) => {
    const { to, message, senderSessionId, synthetic } = req;
    if (typeof to !== 'string' || !to.trim()) {
      return { ok: false, error: 'message_resident: `to` (a tab-hosted instance id) is required' };
    }
    if (typeof message !== 'string' || !message.trim()) {
      return { ok: false, error: 'message_resident: `message` is required' };
    }
    // Vault gates the model key — a resident turn can't run while locked. Refuse
    // cleanly so the caller can retry (no defer/re-drain at P0 — that's P1).
    if (isVaultLocked()) {
      return { ok: false, error: 'message_resident: the vault is locked — unlock and retry' };
    }
    // P0 fail-closed sender gate: attended + first-party only. A synthetic turn
    // (goal continuation, async wake, the resident reply wake) is refused, so the
    // unattended path stays blocked and no autonomous ping-pong can run.
    const active = await getActiveSessionId();
    if (synthetic === true || !senderSessionId || senderSessionId !== active) {
      log('REFUSED', { reason: 'sender_gate', senderSessionId, synthetic });
      return { ok: false, error: 'message_resident: only the active, attended chat may message a resident (P0 — synthetic/background senders are blocked until the inbound clamp lands)' };
    }

    // Runaway guard (per sender) — a burst means a likely loop, so refuse past
    // the rate cap within the window; a long, legit session spreads out.
    const nowMs = now();
    const recent = (recentSends.get(senderSessionId) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_CAP) {
      log('REFUSED', { reason: 'rate_cap', senderSessionId, recent: recent.length });
      return { ok: false, error: `message_resident: ${recent.length} resident messages in ${Math.round(RATE_WINDOW_MS / 1000)}s — refusing to prevent a runaway loop. Synthesize what you have, or wait a moment.` };
    }
    if ((inFlight.get(senderSessionId) ?? 0) >= OUTSTANDING_CAP) {
      return { ok: false, error: `message_resident: ${OUTSTANDING_CAP} resident messages already in flight for this chat — await their replies before sending more.` };
    }

    // Resolve (+ lazy-mint) the resident for this instance.
    let resident;
    try {
      resident = await resolveResident(to);
    } catch (e) {
      return { ok: false, error: `message_resident: could not resolve instance '${to}': ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!resident) {
      return { ok: false, error: `message_resident: no tab-hosted instance found for id '${to}' (use the create/list tools to find one)` };
    }
    const { instanceId, kind, residentSessionId, name, tabId } = resident;

    recent.push(nowMs);
    recentSends.set(senderSessionId, recent);
    inFlight.set(senderSessionId, (inFlight.get(senderSessionId) ?? 0) + 1);
    appendAudit({ type: 'resident_message', details: { to: instanceId, kind, senderSessionId } }).catch(() => {});

    // Serialize on the RESIDENT's slot — runWhenIdle runs the turn the moment the
    // resident is idle (never interrupting an in-flight resident turn). The reply
    // re-enters the sender; a thrown/failed resident turn STILL wakes the sender
    // (with an error notice) so the caller is never left hanging.
    turnSlots.runWhenIdle(residentSessionId, () => {
      Promise.resolve(runResidentTurn({ residentSessionId, message, residentTabId: tabId, instanceId, kind }))
        .then((res) => deliver(senderSessionId, instanceId, kind, name, (res?.result || '(the resident produced no text reply)').slice(0, RESULT_CHARS)))
        .catch((e) => deliver(senderSessionId, instanceId, kind, name, `the resident turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, true))
        .finally(() => decInFlight(senderSessionId));
    });

    return {
      ok: true,
      content: `Message delivered to the ${kind} resident (${name ?? instanceId}). Its reply will arrive on a LATER turn as a fenced note — do NOT wait or poll; continue or end your turn.`,
    };
  };

  return { messageResident };
};
