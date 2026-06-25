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
// Two reply shapes by kind. The three ENGINE kinds (webvm/notebook/app) run
// potentially-long turns → ASYNC: the reply lands on a later sender turn via
// deliver()/runWhenIdle. The WEB kind drives a page in a request→response shape →
// SYNC-AWAIT: the orchestrator awaits the turn and the reply returns inline in the
// tool result (preserving the do/get/check ergonomics it replaces). Same gates,
// same guards, same untrusted-content posture — only the delivery differs.
//
// Durable mailbox (P1). The ASYNC correlation is persisted (deps.mailbox): an SW
// death between accept and deliver() no longer drops the reply-wake — redrain()
// re-queues every pending engine message on boot (mirrors goalRunner.resume). WEB
// is never persisted (sync within one turn; SW death there is turn-resume, not a
// lost wake). The default no-op mailbox keeps the pure-heap P0 behavior in tests.
//
// Posture: a message is accepted from the active foreground chat (`senderSessionId
// === getActiveSessionId()`) when it is NOT `inbound`. `inbound` is the
// untrusted-ORIGIN signal the turn driver folds from synthetic + trusted:
// `inbound = synthetic && !trusted`. So a real user turn (non-synthetic) and an
// explicit first-party continuation (a goal turn, or the orchestrator reacting to
// a resident's reply — both set trusted:true) MAY delegate; an untrusted/external
// synthetic turn (future peer messages / scheduled tasks — never trusted) is
// refused. Fail-CLOSED (default deny for synthetic) + the `=== active` second
// wall. The per-sender runaway guard bounds an autonomous parent↔resident loop.

/**
 * @param {Object} deps
 * @param {(instanceId: string) => Promise<{ instanceId: string, kind: string, residentSessionId: string, name?: string, tabId?: number } | null>} deps.resolveResident
 *   Resolve an instance id to its (lazily-minted) resident. Returns null when no
 *   instance with that id exists across the three registries.
 * @param {(opts: { residentSessionId: string, message: string, residentTabId?: number, instanceId: string, kind: string, parentToolUseId?: string, name?: string }) => Promise<{ result: string, stopped?: boolean }>} deps.runResidentTurn
 *   Drive ONE resident turn (runAgentTurn against the resident session) and
 *   resolve with its final assistant text. parentToolUseId (the message_resident
 *   tool_use id, absent on a boot redrain) keys the resident's live DISPLAY stream
 *   to its card. Contracted to CLAIM the resident's
 *   turn slot (so runWhenIdle drains correctly).
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean, trusted?: boolean }) => Promise<unknown>} deps.reenter
 *   Re-enter a session with a (synthetic) turn — the SW's runAgentTurn. trusted:true
 *   marks a first-party continuation allowed to message residents (the reply-wake).
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void }} deps.turnSlots
 * @param {() => Promise<string | null>} deps.getActiveSessionId
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {() => number} [deps.now]
 * @param {{ outstanding?: number, rateCap?: number, rateWindowMs?: number, resultChars?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {{ append: (e: { id: string, senderSessionId: string, to: string, message: string, createdAt: number }) => Promise<unknown>, remove: (id: string) => Promise<unknown>, load: () => Promise<any[]> }} [deps.mailbox]
 *   DURABLE MAILBOX (DESIGN-17 P1). Persists an ENGINE resident's in-flight
 *   message→reply correlation so an SW death between accept and deliver() doesn't
 *   silently drop the reply-wake. append() on accept, remove() on settle, load()
 *   at boot (redrain). Default no-op = the P0 pure-heap behavior (web is sync, so
 *   it is never persisted — its SW-death story is orchestrator turn-resume, not a
 *   wake). Mirrors goal-runner's persist/resume.
 */
export const makeResidentMessaging = (deps) => {
  const {
    resolveResident, runResidentTurn, reenter, turnSlots,
    getActiveSessionId, isVaultLocked, wrapUntrusted,
    appendAudit = async () => {}, now = Date.now, caps = {}, log = () => {},
    mailbox = { append: async () => {}, remove: async () => {}, load: async () => [] },
  } = deps;

  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;

  /** @type {Map<string, number>} senderSessionId → resident messages currently in flight */
  const inFlight = new Map();
  /** @type {Map<string, number[]>} senderSessionId → recent dispatch timestamps (the burst guard) */
  const recentSends = new Map();
  /** @type {Map<string, Promise<unknown>>} web-resident sessionId → its serialization chain */
  const webChains = new Map();
  // senderSessionId → (residentSessionId → REFCOUNT). A set can't represent two
  // messages in flight to the SAME resident, so a Stop cascade would miss the
  // second once the first settled and cleared the entry. Refcount keeps the
  // residentSessionId visible to residentsFor() for the whole span ANY message to
  // it is in flight. @type {Map<string, Map<string, number>>}
  const inFlightResidents = new Map();
  // senderSessionId → Stop generation. Bumped by stopResidentsFor(); a queued
  // (not-yet-started) engine turn whose captured generation no longer matches skips
  // — so Stop reaches not just the RUNNING resident slot (turnSlots.stop) but also
  // resident turns still queued behind it on the same slot. @type {Map<string, number>}
  const stopGen = new Map();
  // Monotonic correlation id — durable-mailbox key + de-dupe. Process-unique
  // (not now()-derived, which is fixed in tests and collides on same-ms sends).
  let seq = 0;

  /** @param {string} sender @param {string} residentSessionId */
  const trackResident = (sender, residentSessionId) => {
    const m = inFlightResidents.get(sender) ?? new Map();
    m.set(residentSessionId, (m.get(residentSessionId) ?? 0) + 1);
    inFlightResidents.set(sender, m);
  };
  /** @param {string} sender @param {string} residentSessionId */
  const untrackResident = (sender, residentSessionId) => {
    const m = inFlightResidents.get(sender);
    if (!m) return;
    const c = (m.get(residentSessionId) ?? 1) - 1;
    if (c <= 0) m.delete(residentSessionId); else m.set(residentSessionId, c);
    if (m.size === 0) inFlightResidents.delete(sender);
  };
  /** @param {string} sender @returns {string[]} the resident sessions this sender has in flight */
  const residentsFor = (sender) => [...(inFlightResidents.get(sender)?.keys() ?? [])];
  // Stop every resident this sender has in flight: bump the generation (so QUEUED
  // turns skip) and return the RUNNING ones (so the caller aborts their slots).
  /** @param {string} sender @returns {string[]} */
  const stopResidentsFor = (sender) => {
    stopGen.set(sender, (stopGen.get(sender) ?? 0) + 1);
    return residentsFor(sender);
  };

  // Serialize web-resident turns per session: the sync-await relay below awaits the
  // turn, so two concurrent messages to the SAME tab would otherwise both call
  // runAgentTurn, whose turnSlots.claim aborts the in-flight one. A promise chain
  // runs each after the previous SETTLES; the stored link never rejects so the next
  // caller chains cleanly.
  /** @param {string} sessionId @param {() => Promise<any>} fn @returns {Promise<any>} */
  const runWebSerialized = (sessionId, fn) => {
    const prev = webChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    webChains.set(sessionId, run.then(() => {}, () => {}));
    return run;
  };

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
      // trusted:true — the reply-wake is a FIRST-PARTY continuation (the sender's
      // own resident replied), so the sender's turn that reads it MAY fire a
      // follow-up message_resident. The reply BODY is still wrapUntrusted-fenced:
      // trusted is about the turn's ORIGIN (peerd's own loop), not its content.
      Promise.resolve(reenter({ userText: `${lead}\n\n${wrapped}`, sessionId: senderSessionId, synthetic: true, trusted: true }))
        .catch((e) => log('reenter failed', e));
    });
  };

  // Queue ONE engine resident turn on its slot, deliver the fenced reply to the
  // sender, and clear the mailbox entry on settle. Shared by a fresh message and a
  // boot redrain() so the in-flight bookkeeping (count, Stop-cascade tracking,
  // durable entry) stays identical on both paths. parentToolUseId (absent on a
  // redrain — the orchestrator card is gone) keys the resident's display stream.
  /** @param {{ correlationId: string, senderSessionId: string, resident: { instanceId: string, kind: string, residentSessionId: string, name?: string, tabId?: number }, message: string, parentToolUseId?: string }} o */
  const runEngineDelivery = ({ correlationId, senderSessionId, resident, message, parentToolUseId }) => {
    const { instanceId, kind, residentSessionId, name, tabId } = resident;
    trackResident(senderSessionId, residentSessionId);
    // Capture the sender's Stop generation NOW — if the user Stops while this turn is
    // queued behind another on the same resident slot, the generation advances and we
    // skip it when the slot finally frees (so Stop reaches queued work, not just the
    // running slot turnSlots.stop aborts). The bookkeeping is cleared either way.
    const genAtQueue = stopGen.get(senderSessionId) ?? 0;
    const clear = () => {
      decInFlight(senderSessionId);
      untrackResident(senderSessionId, residentSessionId);
      mailbox.remove(correlationId).catch(() => {});
    };
    // Serialize on the RESIDENT's slot — runWhenIdle runs the turn the moment the
    // resident is idle (never interrupting an in-flight resident turn). A thrown/
    // failed resident turn STILL wakes the sender (with an error notice) so the
    // caller is never left hanging.
    turnSlots.runWhenIdle(residentSessionId, () => {
      // Stopped after we queued → don't start the turn; just clean up silently (the
      // sender was stopped, so a wake would re-start unwanted post-Stop activity).
      if ((stopGen.get(senderSessionId) ?? 0) !== genAtQueue) { clear(); return; }
      Promise.resolve(runResidentTurn({ residentSessionId, message, residentTabId: tabId, instanceId, kind, parentToolUseId, name }))
        .then((res) => deliver(senderSessionId, instanceId, kind, name, (res?.result || '(the resident produced no text reply)').slice(0, RESULT_CHARS), res?.stopped === true))
        .catch((e) => deliver(senderSessionId, instanceId, kind, name, `the resident turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, true))
        .finally(clear);
    });
  };

  /**
   * @param {{ to?: string, message?: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string }} req
   * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
   */
  const messageResident = async (req) => {
    const { to, message, senderSessionId, inbound, toolUseId } = req;
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
    // Fail-closed sender gate: the foreground chat, and not an untrusted-origin
    // (inbound) turn. A real user turn and an explicit first-party continuation
    // (goal turn / resident reply-wake — both non-inbound) pass; an untrusted or
    // background synthetic turn, or any non-active sender, is refused.
    const active = await getActiveSessionId();
    if (inbound === true || !senderSessionId || senderSessionId !== active) {
      log('REFUSED', { reason: 'sender_gate', senderSessionId, inbound });
      return { ok: false, error: 'message_resident: only the active foreground chat (or its first-party autonomous continuation — a goal turn, or reacting to a resident reply) may message a resident; untrusted/background senders and non-active chats are blocked' };
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

    // Web resident: SYNC-AWAIT relay (the do/get/check collapse). The three engine
    // kinds run potentially-long turns, so their reply arrives on a LATER turn via
    // deliver()/runWhenIdle. A web resident drives the page in a request→response
    // shape the orchestrator awaits inline — preserving the do/get/check ergonomics
    // it replaces (one tool call, one page result, same turn). No reenter wake: the
    // content returns in THIS tool result. Serialize per tab (runWebSerialized)
    // because runResidentTurn claims the resident's turn slot and turnSlots.claim
    // aborts an in-flight turn — concurrent messages to one tab must queue, not race.
    // NOT persisted to the mailbox: a web message lives inside one orchestrator turn,
    // so SW death there is the orchestrator's turn-resume story, not a lost wake.
    if (kind === 'web') {
      trackResident(senderSessionId, residentSessionId);
      try {
        const res = await runWebSerialized(residentSessionId, () =>
          runResidentTurn({ residentSessionId, message, residentTabId: tabId, instanceId, kind, parentToolUseId: toolUseId, name }));
        return { ok: true, content: (res?.result || '(the web resident produced no text reply)').slice(0, RESULT_CHARS) };
      } catch (e) {
        return { ok: false, error: `message_resident: the web resident turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
      } finally {
        decInFlight(senderSessionId);
        untrackResident(senderSessionId, residentSessionId);
      }
    }

    // ENGINE resident: persist the correlation to the durable mailbox, THEN queue
    // the async-wake delivery. AWAIT the write so the durable record is guaranteed
    // on disk before any resident side effect begins — closing the narrow accept→
    // persist window where an SW death would still drop the wake. A storage failure
    // degrades to P0 (heap-only) rather than throwing.
    const correlationId = `${instanceId}:${++seq}:${nowMs}`;
    await Promise.resolve(mailbox.append({ id: correlationId, senderSessionId, to: instanceId, message, createdAt: nowMs })).catch(() => {});
    runEngineDelivery({ correlationId, senderSessionId, resident, message, parentToolUseId: toolUseId });

    return {
      ok: true,
      content: `Message delivered to the ${kind} resident (${name ?? instanceId}). Its reply will arrive on a LATER turn as a fenced note — do NOT wait or poll; continue or end your turn.`,
    };
  };

  // DURABLE REDRAIN (DESIGN-17 P1). Called once on SW boot, after the registries
  // load + the vault unlocks (a resident turn needs the model key). Re-queues every
  // persisted ENGINE message so its reply still reaches the sender. Idempotent: a
  // stale entry whose instance is gone (or whose sender vanished) wakes the sender
  // with a failure note and clears; a still-live instance re-runs the turn normally
  // (resolveResident re-mints a dropped forward pointer). Mirrors goalRunner.resume.
  /** @returns {Promise<{ redrained: number }>} */
  const redrain = async () => {
    let entries;
    try { entries = await mailbox.load(); }
    catch (e) { log('redrain load failed', e); return { redrained: 0 }; }
    if (!Array.isArray(entries) || entries.length === 0) return { redrained: 0 };
    let redrained = 0;
    for (const e of entries) {
      if (!e?.id || typeof e.senderSessionId !== 'string' || typeof e.to !== 'string' || typeof e.message !== 'string') {
        if (e?.id) mailbox.remove(e.id).catch(() => {});
        continue;
      }
      let resident = null;
      try { resident = await resolveResident(e.to); }
      catch { resident = null; }
      // A web entry should never be in the mailbox (sync, never persisted); if one
      // is, or the instance is gone, abandon it — wake the sender so it isn't left
      // waiting on a reply that can never come.
      if (!resident || resident.kind === 'web') {
        deliver(e.senderSessionId, e.to, resident?.kind ?? 'tab-hosted', resident?.name,
          'could not be reached after a restart (its instance may have been closed). Re-issue the request if it still matters.', true);
        mailbox.remove(e.id).catch(() => {});
        appendAudit({ type: 'resident_message_abandoned', details: { to: e.to, senderSessionId: e.senderSessionId } }).catch(() => {});
        continue;
      }
      inFlight.set(e.senderSessionId, (inFlight.get(e.senderSessionId) ?? 0) + 1);
      runEngineDelivery({ correlationId: e.id, senderSessionId: e.senderSessionId, resident, message: e.message });
      redrained += 1;
    }
    log('redrained', redrained);
    return { redrained };
  };

  return { messageResident, redrain, residentsFor, stopResidentsFor };
};
