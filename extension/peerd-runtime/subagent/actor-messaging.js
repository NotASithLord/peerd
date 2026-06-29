// @ts-check
// DESIGN-17 — message_actor: the channel to a tab-hosted instance's actor.
//
// You don't mutate an instance; you message its ACTOR — a GenServer-style OTP
// process (started on demand, addressed by a registered name, the resolved actor
// session its live PID) that exclusively holds that environment's tools. This
// orchestrator is the direct analog of async-subagents (subagent/async-subagents.js):
// a MAILBOX over turnSlots processed one message at a time (never interrupts an
// in-flight turn), a SW-captured correlation (the sender is closed over, not trusted
// from the actor), a wrapUntrusted-fenced reply that re-enters the sender as a
// synthetic wake, and a per-sender runaway guard. Functional core / imperative shell:
// every IO surface is injected, so the spawn → run → reply flow is unit-testable.
//
// ONE reply shape for EVERY kind (web included). The orchestrator NEVER blocks: it
// hands a task to an actor and gets woken with the reply on a later turn via
// deliver()/runWhenIdle — the actor model, uniformly. The actor's own turn slot
// serializes its turns (one actor per tab/instance); deliver() wrapUntrusted-
// fences the reply, so a web actor's page-derived reply is fenced like any other
// untrusted content. (Web used to be a sync-await special case — collapsed into
// this path; it never blocked the orchestrator, and the fence is now uniform.)
//
// Durable mailbox (P1). The correlation is persisted (deps.mailbox): an SW death
// between accept and deliver() no longer drops the reply-wake — redrain() re-queues
// every pending message on boot (mirrors goalRunner.resume). The default no-op
// mailbox keeps the pure-heap behavior in tests.
//
// Posture: a message is accepted from the active foreground chat (`senderSessionId
// === getActiveSessionId()`) when it is NOT `inbound`. `inbound` is the
// untrusted-ORIGIN signal the turn driver folds from synthetic + trusted:
// `inbound = synthetic && !trusted`. So a real user turn (non-synthetic) and an
// explicit first-party continuation (a goal turn, or the orchestrator reacting to
// an actor's reply — both set trusted:true) MAY delegate; an untrusted/external
// synthetic turn (future peer messages / scheduled tasks — never trusted) is
// refused. Fail-CLOSED (default deny for synthetic) + the `=== active` second
// wall. The per-sender runaway guard bounds an autonomous parent↔actor loop.

import { escapeAttr } from '/shared/util.js';

/**
 * @param {Object} deps
 * @param {(instanceId: string, opts?: { senderSessionId?: string | null }) => Promise<{ instanceId: string, kind: string, actorSessionId: string, name?: string, tabId?: number } | null>} deps.resolveActor
 *   Resolve an instance id to its (lazily-minted) actor. Returns null when no
 *   instance with that id exists across the three registries. `senderSessionId` is the
 *   chat that sent this message — the chat-scoped WEB actor (to:'web') is owned by it,
 *   so it must be threaded (not re-derived from the ambient active chat, which is wrong
 *   on a boot redrain). Engine/per-tab kinds ignore it (globally/tab keyed).
 * @param {(opts: { actorSessionId: string, message: string, actorTabId?: number, instanceId: string, kind: string, parentToolUseId?: string, name?: string, oneShot?: boolean }) => Promise<{ result: string, stopped?: boolean }>} deps.runActorTurn
 *   Drive ONE actor turn (runAgentTurn against the actor session) and
 *   resolve with its final assistant text. parentToolUseId (the message_actor
 *   tool_use id, absent on a boot redrain) keys the actor's live DISPLAY stream
 *   to its card. Contracted to CLAIM the actor's
 *   turn slot (so runWhenIdle drains correctly).
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean, trusted?: boolean }) => Promise<unknown>} deps.reenter
 *   Re-enter a session with a (synthetic) turn — the SW's runAgentTurn. trusted:true
 *   marks a first-party continuation allowed to message actors (the reply-wake).
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void }} deps.turnSlots
 * @param {() => Promise<string | null>} deps.getActiveSessionId
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {() => number} [deps.now]
 * @param {{ outstanding?: number, rateCap?: number, rateWindowMs?: number, resultChars?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {{ append: (e: { id: string, senderSessionId: string, to: string, message: string, createdAt: number }) => Promise<unknown>, remove: (id: string) => Promise<unknown>, load: () => Promise<any[]> }} [deps.mailbox]
 *   DURABLE MAILBOX (DESIGN-17 P1). Persists EVERY actor's in-flight
 *   message→reply correlation — web included — so an SW death between accept and
 *   deliver() doesn't silently drop the reply-wake. append() on accept, remove()
 *   on settle, load() at boot (redrain). Default no-op = the pure-heap behavior
 *   tests run with. Mirrors goal-runner's persist/resume.
 */
export const makeActorMessaging = (deps) => {
  const {
    resolveActor, runActorTurn, reenter, turnSlots,
    getActiveSessionId, isVaultLocked, wrapUntrusted,
    appendAudit = async () => {}, now = Date.now, caps = {}, log = () => {},
    mailbox = { append: async () => {}, remove: async () => {}, load: async () => [] },
  } = deps;

  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;

  /** @type {Map<string, number>} senderSessionId → actor messages currently in flight */
  const inFlight = new Map();
  /** @type {Map<string, number[]>} senderSessionId → recent dispatch timestamps (the burst guard) */
  const recentSends = new Map();
  // senderSessionId → (actorSessionId → REFCOUNT). A set can't represent two
  // messages in flight to the SAME actor, so a Stop cascade would miss the
  // second once the first settled and cleared the entry. Refcount keeps the
  // actorSessionId visible to actorsFor() for the whole span ANY message to
  // it is in flight. @type {Map<string, Map<string, number>>}
  const inFlightActors = new Map();
  // senderSessionId → Stop generation. Bumped by stopActorsFor(); a queued
  // (not-yet-started) engine turn whose captured generation no longer matches skips
  // — so Stop reaches not just the RUNNING actor slot (turnSlots.stop) but also
  // actor turns still queued behind it on the same slot. @type {Map<string, number>}
  const stopGen = new Map();
  // Monotonic correlation id — durable-mailbox key + de-dupe. Process-unique
  // (not now()-derived, which is fixed in tests and collides on same-ms sends).
  let seq = 0;

  /** @param {string} sender @param {string} actorSessionId */
  const trackActor = (sender, actorSessionId) => {
    const m = inFlightActors.get(sender) ?? new Map();
    m.set(actorSessionId, (m.get(actorSessionId) ?? 0) + 1);
    inFlightActors.set(sender, m);
  };
  /** @param {string} sender @param {string} actorSessionId */
  const untrackActor = (sender, actorSessionId) => {
    const m = inFlightActors.get(sender);
    if (!m) return;
    const c = (m.get(actorSessionId) ?? 1) - 1;
    if (c <= 0) m.delete(actorSessionId); else m.set(actorSessionId, c);
    if (m.size === 0) inFlightActors.delete(sender);
  };
  /** @param {string} sender @returns {string[]} the actor sessions this sender has in flight */
  const actorsFor = (sender) => [...(inFlightActors.get(sender)?.keys() ?? [])];
  // Stop every actor this sender has in flight: bump the generation (so QUEUED
  // turns skip) and return the RUNNING ones (so the caller aborts their slots).
  /** @param {string} sender @returns {string[]} */
  const stopActorsFor = (sender) => {
    stopGen.set(sender, (stopGen.get(sender) ?? 0) + 1);
    return actorsFor(sender);
  };

  /** @param {string} sender */
  const decInFlight = (sender) => {
    const c = (inFlight.get(sender) ?? 1) - 1;
    if (c <= 0) inFlight.delete(sender); else inFlight.set(sender, c);
  };

  // Re-enter the SENDER with the actor's reply as a synthetic, wrapUntrusted-
  // fenced wake — via runWhenIdle(senderSessionId) so it NEVER steer-aborts the
  // user's live turn (the focus/work-theft bug, DECISIONS #20). Only the one-line
  // lead is trusted; the actor's body is fenced (mandatory for App actors,
  // which render attacker content).
  /** @param {string} senderSessionId @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] */
  const deliver = (senderSessionId, instanceId, kind, name, body, failed = false) => {
    const wrapped = wrapUntrusted({
      origin: instanceId, tool: 'message_actor', body,
      retrievedAt: new Date(now()).toISOString(),
    });
    // `name` is UNTRUSTED in the lead: for a web actor it is the page's
    // document.title (fully page-controlled), for an engine actor it is an
    // agent-set label (injection-launderable). The lead sits OUTSIDE the fence in
    // a trusted:true wake, so an un-sanitized name is a clean fence break-out —
    // a newline-bearing title would inject prose into the orchestrator's trusted
    // turn, or forge a </untrusted_web_content> close to un-fence the body below.
    // Collapse whitespace (kill the newline vector), clamp, then escapeAttr (no
    // surviving angle bracket → no forged fence/close tag).
    const safeName = name ? escapeAttr(name.replace(/\s+/g, ' ').trim().slice(0, 80)) : '';
    // The chat-scoped web actor has instanceId === kind === 'web'; naming both would
    // double the word ("the web actor web …"). Render it as "the web actor". A per-tab
    // web actor keeps "the web actor 42 …" (instanceId is the meaningful tabId).
    // DESIGN-18: an API actor is a web actor whose instanceId is its ORIGIN — render it
    // "The <origin> integration". The origin is canonical (URL.origin: no space/newline/
    // bracket), so it's safe un-fenced in this trusted lead.
    const subject = (kind === 'web' && instanceId === 'web')
      ? 'The web actor'
      : (kind === 'web' && /^https?:\/\//.test(String(instanceId)))
        ? `The ${instanceId} integration`
        : `The ${kind} actor ${safeName ? `${safeName} (${instanceId})` : instanceId}`;
    const lead = failed
      ? `${subject} could not complete your request:`
      : `${subject} you messaged has replied:`;
    turnSlots.runWhenIdle(senderSessionId, () => {
      // trusted:true — the reply-wake is a FIRST-PARTY continuation (the sender's
      // own actor replied), so the sender's turn that reads it MAY fire a
      // follow-up message_actor. The reply BODY is still wrapUntrusted-fenced:
      // trusted is about the turn's ORIGIN (peerd's own loop), not its content.
      Promise.resolve(reenter({ userText: `${lead}\n\n${wrapped}`, sessionId: senderSessionId, synthetic: true, trusted: true }))
        .catch((e) => log('reenter failed', e));
    });
  };

  // Queue ONE engine actor turn on its slot, deliver the fenced reply to the
  // sender, and clear the mailbox entry on settle. Shared by a fresh message and a
  // boot redrain() so the in-flight bookkeeping (count, Stop-cascade tracking,
  // durable entry) stays identical on both paths. parentToolUseId (absent on a
  // redrain — the orchestrator card is gone) keys the actor's display stream.
  /** @param {{ correlationId: string, senderSessionId: string, actor: { instanceId: string, kind: string, actorSessionId: string, name?: string, tabId?: number }, message: string, parentToolUseId?: string, oneShot?: boolean }} o */
  const runEngineDelivery = ({ correlationId, senderSessionId, actor, message, parentToolUseId, oneShot }) => {
    const { instanceId, kind, actorSessionId, name, tabId } = actor;
    trackActor(senderSessionId, actorSessionId);
    // Capture the sender's Stop generation NOW — if the user Stops while this turn is
    // queued behind another on the same actor slot, the generation advances and we
    // skip it when the slot finally frees (so Stop reaches queued work, not just the
    // running slot turnSlots.stop aborts). The bookkeeping is cleared either way.
    const genAtQueue = stopGen.get(senderSessionId) ?? 0;
    const clear = () => {
      decInFlight(senderSessionId);
      untrackActor(senderSessionId, actorSessionId);
      mailbox.remove(correlationId).catch(() => {});
    };
    // Serialize on the ACTOR's slot — runWhenIdle runs the turn the moment the
    // actor is idle (never interrupting an in-flight actor turn). A thrown/
    // failed actor turn STILL wakes the sender (with an error notice) so the
    // caller is never left hanging.
    turnSlots.runWhenIdle(actorSessionId, () => {
      // Stopped after we queued → don't start the turn; just clean up silently (the
      // sender was stopped, so a wake would re-start unwanted post-Stop activity).
      if ((stopGen.get(senderSessionId) ?? 0) !== genAtQueue) { clear(); return; }
      // Instrumentation (temporary): the actor turn's wall-clock. It spans the
      // tool work (e.g. a VM command — logged separately as [vm.timing]) PLUS the
      // model inference to compose the reply. (actorTurnMs − the tool's own ms) is
      // that reply inference — the extra turn a delegation spends to summarize one
      // result, which (with the orchestrator's own turn) is the two-inference cost
      // a simple "run X and report" pays over running it inline.
      const turnStartedAt = now();
      Promise.resolve(runActorTurn({ actorSessionId, message, actorTabId: tabId, instanceId, kind, parentToolUseId, name, oneShot }))
        .then((res) => {
          log('actor.timing', { kind, instanceId, actorTurnMs: now() - turnStartedAt });
          return deliver(senderSessionId, instanceId, kind, name, (res?.result || '(the actor produced no text reply)').slice(0, RESULT_CHARS), res?.stopped === true);
        })
        .catch((e) => deliver(senderSessionId, instanceId, kind, name, `the actor turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, true))
        .finally(clear);
    });
  };

  /**
   * @param {{ to?: string, message?: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean }} req
   * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
   */
  const messageActor = async (req) => {
    const { to, message, senderSessionId, inbound, toolUseId, oneShot } = req;
    if (typeof to !== 'string' || !to.trim()) {
      return { ok: false, error: 'message_actor: `to` (a tab-hosted instance id) is required' };
    }
    if (typeof message !== 'string' || !message.trim()) {
      return { ok: false, error: 'message_actor: `message` is required' };
    }
    // Vault gates the model key — an actor turn can't run while locked. Refuse
    // cleanly so the caller can retry (no defer/re-drain at P0 — that's P1).
    if (isVaultLocked()) {
      return { ok: false, error: 'message_actor: the vault is locked — unlock and retry' };
    }
    // Fail-closed sender gate: the foreground chat, and not an untrusted-origin
    // (inbound) turn. A real user turn and an explicit first-party continuation
    // (goal turn / actor reply-wake — both non-inbound) pass; an untrusted or
    // background synthetic turn, or any non-active sender, is refused.
    const active = await getActiveSessionId();
    if (inbound === true || !senderSessionId || senderSessionId !== active) {
      log('REFUSED', { reason: 'sender_gate', senderSessionId, inbound });
      return { ok: false, error: 'message_actor: only the active foreground chat (or its first-party autonomous continuation — a goal turn, or reacting to an actor reply) may message an actor; untrusted/background senders and non-active chats are blocked' };
    }

    // Runaway guard (per sender) — a burst means a likely loop, so refuse past
    // the rate cap within the window; a long, legit session spreads out.
    const nowMs = now();
    const recent = (recentSends.get(senderSessionId) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_CAP) {
      log('REFUSED', { reason: 'rate_cap', senderSessionId, recent: recent.length });
      return { ok: false, error: `message_actor: ${recent.length} actor messages in ${Math.round(RATE_WINDOW_MS / 1000)}s — refusing to prevent a runaway loop. Synthesize what you have, or wait a moment.` };
    }
    if ((inFlight.get(senderSessionId) ?? 0) >= OUTSTANDING_CAP) {
      return { ok: false, error: `message_actor: ${OUTSTANDING_CAP} actor messages already in flight for this chat — await their replies before sending more.` };
    }

    // Resolve (+ lazy-mint) the actor for this instance. Thread the sender so the
    // chat-scoped web actor (to:'web') is owned by the SENDER, not the ambient active
    // chat (live path: they're equal — the gate above proved it; redrain: they differ).
    let actor;
    try {
      actor = await resolveActor(to, { senderSessionId });
    } catch (e) {
      return { ok: false, error: `message_actor: could not resolve instance '${to}': ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!actor) {
      return { ok: false, error: `message_actor: no tab-hosted instance found for id '${to}' (use the create/list tools to find one)` };
    }
    const { instanceId, kind, actorSessionId, name, tabId } = actor;

    recent.push(nowMs);
    recentSends.set(senderSessionId, recent);
    inFlight.set(senderSessionId, (inFlight.get(senderSessionId) ?? 0) + 1);
    appendAudit({ type: 'actor_message', details: { to: instanceId, kind, senderSessionId } }).catch(() => {});

    // ASYNC for EVERY kind — web included. The orchestrator never blocks: it hands a
    // task to the actor and gets woken with the reply on a later turn (the actor
    // model, uniformly). Persist the correlation to the durable mailbox FIRST (await
    // the write so the record is on disk before any actor side effect begins —
    // closing the accept→persist window an SW death could otherwise drop), then queue
    // the wake. The actor's slot serializes its turns (one actor per tab/
    // instance), and deliver() wrapUntrusted-fences the reply — so a web actor's
    // page-derived reply is fenced like any other untrusted content. A storage
    // failure degrades to heap-only rather than throwing.
    const correlationId = `${instanceId}:${++seq}:${nowMs}`;
    // Persist oneShot too, so a redrain after an SW restart re-runs the turn in the
    // same mode (a dropped flag would just fall back to a full summarize turn — safe,
    // but inconsistent). Older entries without the field redrain as full turns.
    await Promise.resolve(mailbox.append({ id: correlationId, senderSessionId, to: instanceId, message, createdAt: nowMs, ...(oneShot === true ? { oneShot: true } : {}) })).catch(() => {});
    runEngineDelivery({ correlationId, senderSessionId, actor, message, parentToolUseId: toolUseId, oneShot: oneShot === true });

    const recipient = (kind === 'web' && instanceId === 'web')
      ? 'the web actor'
      : (kind === 'web' && /^https?:\/\//.test(String(instanceId)))
        ? `the ${instanceId} integration`
        : `the ${kind} actor (${name ?? instanceId})`;
    return {
      ok: true,
      content: `Message delivered to ${recipient}. Its reply will arrive on a LATER turn as a fenced note — do NOT wait or poll; continue or end your turn.`,
    };
  };

  // DURABLE REDRAIN (DESIGN-17 P1). Called once on SW boot, after the registries
  // load + the vault unlocks (an actor turn needs the model key). Re-queues every
  // persisted message (any kind, web included) so its reply still reaches the
  // sender. Idempotent: a
  // stale entry whose instance is gone (or whose sender vanished) wakes the sender
  // with a failure note and clears; a still-live instance re-runs the turn normally
  // (resolveActor re-mints a dropped forward pointer). Mirrors goalRunner.resume.
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
      let actor = null;
      // Thread the ORIGINAL sender so a web-actor (to:'web') redrain re-attaches to the
      // sender's actor, not whatever chat is focused at boot.
      try { actor = await resolveActor(e.to, { senderSessionId: e.senderSessionId }); }
      catch { actor = null; }
      // The instance is gone (engine instance deleted, or a web actor's tab
      // closed) → abandon it; wake the sender so it isn't left waiting on a reply
      // that can never come. A live instance (any kind, web included) re-runs.
      if (!actor) {
        deliver(e.senderSessionId, e.to, 'tab-hosted', undefined,
          'could not be reached after a restart (its instance may have been closed). Re-issue the request if it still matters.', true);
        mailbox.remove(e.id).catch(() => {});
        appendAudit({ type: 'actor_message_abandoned', details: { to: e.to, senderSessionId: e.senderSessionId } }).catch(() => {});
        continue;
      }
      inFlight.set(e.senderSessionId, (inFlight.get(e.senderSessionId) ?? 0) + 1);
      runEngineDelivery({ correlationId: e.id, senderSessionId: e.senderSessionId, actor, message: e.message, oneShot: e.oneShot === true });
      redrained += 1;
    }
    log('redrained', redrained);
    return { redrained };
  };

  return { messageActor, redrain, actorsFor, stopActorsFor };
};
