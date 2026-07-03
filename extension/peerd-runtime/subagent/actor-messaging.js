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
// Posture (PR #134 — subagents as async actors): a message is accepted when the
// turn is NOT `inbound` AND the sender passes the TRUSTED-LINEAGE gate
// (delegation-lineage.js mayMessageActor): the active foreground chat, or a
// descendant of it reached entirely through trusted spawn edges (spawn.js
// stamps `spawnedTrusted` per hop; one inbound spawn taints its subtree).
// `inbound` is the untrusted-ORIGIN signal the turn driver folds from
// synthetic + trusted: `inbound = synthetic && !trusted`. So a real user turn,
// an explicit first-party continuation (a goal turn, or the orchestrator
// reacting to an actor's reply — both set trusted:true), and a trusted-lineage
// subagent MAY delegate; an untrusted/external synthetic turn (future peer
// messages / scheduled tasks — never trusted) is refused. Fail-CLOSED: a
// missing/unwalkable ancestry admits only the foreground chat itself.
//
// The runaway guard + Stop bookkeeping are keyed by the lineage ROOT
// (messageProvenance) rather than the raw sender, so a parent↔child↔actor
// cycle shares ONE budget (phase 4) and a user Stop on the chat cascades to
// actor turns its descendants started (phase 5). Envelopes (durable mailbox
// entries) carry the provenance so a boot redrain can arbitrate: a reply whose
// awaiting sender was an EPHEMERAL subagent (dead after restart) is rerouted
// to the root instead of waking a headless child (phase 7).
//
// Reply modes: the ORCHESTRATOR (and any long-lived chat session) gets the
// async wake — deliver() re-enters it on a later turn. A SUBAGENT sender sets
// `awaitReply`: it is a fire-once call-site with no later turn, so its reply
// resolves INTO the message_actor tool result (still wrapUntrusted-fenced).
// why not wake a subagent like a chat: the reenter path runs sessions under
// the SW's main turn driver — waking a finished child would both run an
// orphan turn nobody consumes AND rebuild its context on the MAIN exposure
// surface, escalating past the child's narrowed toolset.

import { escapeAttr } from '/shared/util.js';
import { ASYNC_SUBAGENT_ACTORS, mayMessageActor, messageProvenance } from './delegation-lineage.js';

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
 * @param {(sessionId: string) => Promise<Array<import('./delegation-lineage.js').LineageHop>>} [deps.getAncestry]
 *   Build the sender's lineage chain (sender-first toward the root) from the
 *   session store — the shell walk mayMessageActor/messageProvenance read.
 *   Default returns [] — FAIL-CLOSED: without a chain only the foreground chat
 *   itself passes the gate, and provenance collapses to the sender.
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {() => number} [deps.now]
 * @param {{ outstanding?: number, rateCap?: number, rateWindowMs?: number, resultChars?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {{ append: (e: { id: string, senderSessionId: string, to: string, message: string, createdAt: number, provenance?: { rootSessionId: string, lineagePath: string[] }, oneShot?: boolean }) => Promise<unknown>, remove: (id: string) => Promise<unknown>, load: () => Promise<any[]> }} [deps.mailbox]
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
    getAncestry = async () => [],
    appendAudit = async () => {}, now = Date.now, caps = {}, log = () => {},
    mailbox = { append: async () => {}, remove: async () => {}, load: async () => [] },
  } = deps;

  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;

  // PR #134 phase 4: ALL of the bookkeeping below is keyed by the lineage ROOT
  // (messageProvenance.rootSessionId — the chat at the base of the sender's
  // lineage), not the raw sender. One budget bounds a whole delegation graph
  // (a parent↔child↔actor cycle can't multiply its caps by fanning out), and
  // stopActorsFor(chatId) — the user's Stop, which only knows the CHAT id —
  // reaches actor turns that a descendant subagent started. For a plain chat
  // sender, root === sender, so the pre-#134 behavior is unchanged.
  /** @type {Map<string, number>} rootSessionId → actor messages currently in flight */
  const inFlight = new Map();
  /** @type {Map<string, number[]>} rootSessionId → recent dispatch timestamps (the burst guard) */
  const recentSends = new Map();
  // rootSessionId → (actorSessionId → REFCOUNT). A set can't represent two
  // messages in flight to the SAME actor, so a Stop cascade would miss the
  // second once the first settled and cleared the entry. Refcount keeps the
  // actorSessionId visible to actorsFor() for the whole span ANY message to
  // it is in flight. @type {Map<string, Map<string, number>>}
  const inFlightActors = new Map();
  // rootSessionId → Stop generation. Bumped by stopActorsFor(); a queued
  // (not-yet-started) engine turn whose captured generation no longer matches skips
  // — so Stop reaches not just the RUNNING actor slot (turnSlots.stop) but also
  // actor turns still queued behind it on the same slot. @type {Map<string, number>}
  const stopGen = new Map();
  // Phase 7 (mechanical dedupe): rootSessionId → the (to + message) intents
  // currently in flight for that lineage. An IDENTICAL request while its twin is
  // still running is almost always a double-fire (a parent and its child both
  // asking, or a wake-loop re-asking) — refuse it loudly with an "await the
  // first" pointer instead of running the actor turn twice. Deliberately NOT a
  // supersede (auto-cancelling the older one is a policy call the mailbox has
  // provenance for, but nobody has asked for yet). @type {Map<string, Map<string, number>>}
  const inFlightIntents = new Map();
  /** @param {string} to @param {string} message */
  const intentKey = (to, message) => `${to}\u0000${message}`;
  /** @param {string} root @param {string} key */
  const trackIntent = (root, key) => {
    const m = inFlightIntents.get(root) ?? new Map();
    m.set(key, (m.get(key) ?? 0) + 1);
    inFlightIntents.set(root, m);
  };
  /** @param {string} root @param {string} key */
  const untrackIntent = (root, key) => {
    const m = inFlightIntents.get(root);
    if (!m) return;
    const c = (m.get(key) ?? 1) - 1;
    if (c <= 0) m.delete(key); else m.set(key, c);
    if (m.size === 0) inFlightIntents.delete(root);
  };
  // Monotonic correlation id — durable-mailbox key + de-dupe. Process-unique
  // (not now()-derived, which is fixed in tests and collides on same-ms sends).
  let seq = 0;

  /** @param {string} root @param {string} actorSessionId */
  const trackActor = (root, actorSessionId) => {
    const m = inFlightActors.get(root) ?? new Map();
    m.set(actorSessionId, (m.get(actorSessionId) ?? 0) + 1);
    inFlightActors.set(root, m);
  };
  /** @param {string} root @param {string} actorSessionId */
  const untrackActor = (root, actorSessionId) => {
    const m = inFlightActors.get(root);
    if (!m) return;
    const c = (m.get(actorSessionId) ?? 1) - 1;
    if (c <= 0) m.delete(actorSessionId); else m.set(actorSessionId, c);
    if (m.size === 0) inFlightActors.delete(root);
  };
  // `root` is the lineage root (a chat id) — for a plain chat sender it IS the
  // sender, so agent/stop's call with the current chat id covers the whole tree.
  /** @param {string} root @returns {string[]} the actor sessions this lineage has in flight */
  const actorsFor = (root) => [...(inFlightActors.get(root)?.keys() ?? [])];
  // Stop every actor this lineage has in flight: bump the generation (so QUEUED
  // turns skip) and return the RUNNING ones (so the caller aborts their slots).
  /** @param {string} root @returns {string[]} */
  const stopActorsFor = (root) => {
    stopGen.set(root, (stopGen.get(root) ?? 0) + 1);
    return actorsFor(root);
  };

  // Stop the ONE actor turn a subagent's awaitReply was waiting on, when that
  // subagent aborts (#1/#3). Bump the lineage's Stop generation so a still-
  // QUEUED actor turn skips when its slot frees, and abort a RUNNING one via
  // turnSlots.stop (optional — the pure-heap test harness injects no stop; the
  // await resolves either way). Scoped to the single actorSessionId the child
  // delegated to, not the whole lineage, so a sibling's in-flight actor is
  // untouched.
  /** @param {string} root @param {string} actorSessionId */
  const stopActorForAwait = (root, actorSessionId) => {
    stopGen.set(root, (stopGen.get(root) ?? 0) + 1);
    /** @type {{ stop?: (id: string) => boolean }} */ (turnSlots).stop?.(actorSessionId);
  };

  /** @param {string} root */
  const decInFlight = (root) => {
    const c = (inFlight.get(root) ?? 1) - 1;
    if (c <= 0) inFlight.delete(root); else inFlight.set(root, c);
  };

  // Build the ONE reply text shape (trusted lead + fenced body) both reply
  // modes share: deliver() re-enters a long-lived sender with it; the
  // awaitReply path (a subagent's call) resolves it into the tool result.
  /** @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] */
  const replyText = (instanceId, kind, name, body, failed = false) => {
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
    return `${lead}\n\n${wrapped}`;
  };

  // Re-enter the SENDER with the actor's reply as a synthetic, wrapUntrusted-
  // fenced wake — via runWhenIdle(senderSessionId) so it NEVER steer-aborts the
  // user's live turn (the focus/work-theft bug, DECISIONS #20). Only the one-line
  // lead is trusted; the actor's body is fenced (mandatory for App actors,
  // which render attacker content).
  /** @param {string} senderSessionId @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] */
  const deliver = (senderSessionId, instanceId, kind, name, body, failed = false) => {
    const text = replyText(instanceId, kind, name, body, failed);
    turnSlots.runWhenIdle(senderSessionId, () => {
      // trusted:true — the reply-wake is a FIRST-PARTY continuation (the sender's
      // own actor replied), so the sender's turn that reads it MAY fire a
      // follow-up message_actor. The reply BODY is still wrapUntrusted-fenced:
      // trusted is about the turn's ORIGIN (peerd's own loop), not its content.
      Promise.resolve(reenter({ userText: text, sessionId: senderSessionId, synthetic: true, trusted: true }))
        .catch((e) => log('reenter failed', e));
    });
  };

  // Queue ONE engine actor turn on its slot, route the fenced reply to the
  // sender, and clear the mailbox entry on settle. Shared by a fresh message and a
  // boot redrain() so the in-flight bookkeeping (count, Stop-cascade tracking,
  // durable entry) stays identical on both paths. parentToolUseId (absent on a
  // redrain — the orchestrator card is gone) keys the actor's display stream.
  //
  // Reply routing: `onReply` (the awaitReply path — a subagent's call) receives
  // the composed reply text and its failed flag INSTEAD of the deliver() wake;
  // the caller resolves it into the tool result. Every settle path — success,
  // thrown turn, Stop-skip — routes through exactly one of onReply/deliver, so
  // an awaiting caller is never left hanging.
  //
  // Bookkeeping is keyed by rootSessionId (phase 4/5): the lineage root shares
  // one budget and one Stop generation, whoever in the tree actually sent.
  /** @param {{ correlationId: string, senderSessionId: string, rootSessionId: string, actor: { instanceId: string, kind: string, actorSessionId: string, name?: string, tabId?: number }, message: string, parentToolUseId?: string, oneShot?: boolean, onReply?: (text: string, failed: boolean) => void }} o */
  const runEngineDelivery = ({ correlationId, senderSessionId, rootSessionId, actor, message, parentToolUseId, oneShot, onReply }) => {
    const { instanceId, kind, actorSessionId, name, tabId } = actor;
    trackActor(rootSessionId, actorSessionId);
    const intentK = intentKey(instanceId, message);
    // Capture the root's Stop generation NOW — if the user Stops while this turn is
    // queued behind another on the same actor slot, the generation advances and we
    // skip it when the slot finally frees (so Stop reaches queued work, not just the
    // running slot turnSlots.stop aborts). The bookkeeping is cleared either way.
    const genAtQueue = stopGen.get(rootSessionId) ?? 0;
    const clear = () => {
      decInFlight(rootSessionId);
      untrackActor(rootSessionId, actorSessionId);
      untrackIntent(rootSessionId, intentK);
      mailbox.remove(correlationId).catch(() => {});
    };
    // ONE reply seam for both modes (see routing note above).
    /** @param {string} body @param {boolean} failed */
    const settle = (body, failed) => {
      if (onReply) { onReply(replyText(instanceId, kind, name, body, failed), failed); return; }
      deliver(senderSessionId, instanceId, kind, name, body, failed);
    };
    // Serialize on the ACTOR's slot — runWhenIdle runs the turn the moment the
    // actor is idle (never interrupting an in-flight actor turn). A thrown/
    // failed actor turn STILL wakes the sender (with an error notice) so the
    // caller is never left hanging.
    turnSlots.runWhenIdle(actorSessionId, () => {
      // Stopped after we queued → don't start the turn. A woken sender would
      // re-start unwanted post-Stop activity, so the wake path stays silent —
      // but an AWAITING caller (onReply) must still resolve, or its tool call
      // would hang past the Stop that was meant to end it.
      if ((stopGen.get(rootSessionId) ?? 0) !== genAtQueue) {
        if (onReply) onReply(replyText(instanceId, kind, name, 'the request was stopped before the actor ran it.', true), true);
        clear();
        return;
      }
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
          return settle((res?.result || '(the actor produced no text reply)').slice(0, RESULT_CHARS), res?.stopped === true);
        })
        .catch((e) => settle(`the actor turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, true))
        .finally(clear);
    });
  };

  /**
   * @param {{ to?: string, message?: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean, awaitReply?: boolean, awaitSignal?: { aborted: boolean, addEventListener: (t: string, fn: () => void, opts?: object) => void } }} req
   *   awaitReply — the SUBAGENT reply mode (PR #134): resolve the fenced reply
   *   into this call's result instead of a later-turn wake. Set by the
   *   message_actor tool for a `kind:'subagent'` sender.
   *   awaitSignal — the awaiting subagent's AbortSignal (its wall-clock timeout
   *   / cancel). Only meaningful with awaitReply: the await races the reply
   *   against it so an aborted child unblocks instead of parking on a hung actor.
   * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
   */
  const messageActor = async (req) => {
    const { to, message, senderSessionId, inbound, toolUseId, oneShot, awaitReply, awaitSignal } = req;
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
    // background synthetic turn is refused. PR #134 phase 3: the second wall is
    // the TRUSTED-LINEAGE check (delegation-lineage.js) — the active chat OR a
    // descendant reached entirely through trusted spawn edges. The ancestry is
    // walked from the store ONLY for a non-active sender (the foreground fast
    // path costs nothing new); a walk failure yields [] — fail-closed, only the
    // foreground identity can then pass. The flag reverts to the strict
    // `=== active` identity gate if turned off.
    const active = await getActiveSessionId();
    /** @type {Array<import('./delegation-lineage.js').LineageHop>} */
    let ancestry = [];
    if (ASYNC_SUBAGENT_ACTORS && senderSessionId && senderSessionId !== active) {
      try { ancestry = await getAncestry(senderSessionId); }
      catch (e) { log('getAncestry failed (fail-closed)', e); ancestry = []; }
    }
    const senderAllowed = ASYNC_SUBAGENT_ACTORS
      ? mayMessageActor({ inbound: inbound === true, senderSessionId, activeSessionId: active, ancestry })
      : (inbound !== true && !!senderSessionId && senderSessionId === active);
    if (!senderAllowed) {
      log('REFUSED', { reason: 'sender_gate', senderSessionId, inbound });
      return { ok: false, error: 'message_actor: only the active foreground chat, its first-party autonomous continuation (a goal turn, or reacting to an actor reply), or a trusted-lineage subagent it spawned may message an actor; untrusted/background senders are blocked' };
    }

    // The gate refused every falsy sender above; bind the narrowed string once
    // so the sites below don't each re-assert it.
    const sender = /** @type {string} */ (senderSessionId);

    // Phase 4/7 — the lineage ROOT keys every budget below (one bound for the
    // whole delegation graph), and the provenance rides the durable envelope so
    // the mailbox can arbitrate (dedupe here; reroute on redrain).
    const provenance = messageProvenance({ senderSessionId: sender, ancestry });
    const rootSessionId = provenance.rootSessionId;

    // Runaway guard (per lineage ROOT) — a burst means a likely loop, so refuse
    // past the rate cap within the window; a long, legit session spreads out.
    // Root-keyed so a parent can't multiply its budget by fanning out children.
    const nowMs = now();
    const recent = (recentSends.get(rootSessionId) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_CAP) {
      log('REFUSED', { reason: 'rate_cap', senderSessionId, rootSessionId, recent: recent.length });
      return { ok: false, error: `message_actor: ${recent.length} actor messages in ${Math.round(RATE_WINDOW_MS / 1000)}s across this chat's delegation tree — refusing to prevent a runaway loop. Synthesize what you have, or wait a moment.` };
    }
    if ((inFlight.get(rootSessionId) ?? 0) >= OUTSTANDING_CAP) {
      return { ok: false, error: `message_actor: ${OUTSTANDING_CAP} actor messages already in flight across this chat's delegation tree — await their replies before sending more.` };
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
    const { instanceId, kind, name } = actor;

    // Phase 7 — mechanical dedupe. An IDENTICAL (instance, message) intent
    // already in flight for this lineage is a double-fire (a parent and its
    // child both asking, or a loop re-asking): refuse loudly, point at the
    // in-flight twin. Keyed on the RESOLVED instanceId so two aliases of the
    // same actor ('web' vs its tabId) can't slip a duplicate through.
    const intentK = intentKey(instanceId, message);
    if ((inFlightIntents.get(rootSessionId)?.get(intentK) ?? 0) > 0) {
      log('REFUSED', { reason: 'duplicate_intent', senderSessionId, rootSessionId, to: instanceId });
      // why this wording: the in-flight twin may have been sent by a DIFFERENT
      // session in this delegation tree (a sibling subagent, or the parent),
      // and its reply routes to THAT sender — never to this one. Telling this
      // caller to "await its reply" would be unactionable (a subagent has no
      // channel to observe another's reply). So the honest guidance is: this
      // work is already happening elsewhere in the tree — don't re-send; report
      // that and proceed / synthesize from what you have.
      return { ok: false, error: `message_actor: an identical request to '${to}' is already in flight elsewhere in this chat's delegation tree — do NOT re-send. That work is already happening; proceed with what you have or report that it's underway.` };
    }

    recent.push(nowMs);
    recentSends.set(rootSessionId, recent);
    inFlight.set(rootSessionId, (inFlight.get(rootSessionId) ?? 0) + 1);
    trackIntent(rootSessionId, intentK);
    appendAudit({ type: 'actor_message', details: { to: instanceId, kind, senderSessionId, rootSessionId, lineagePath: provenance.lineagePath } }).catch(() => {});

    // ASYNC for EVERY long-lived sender — web included. The orchestrator never
    // blocks: it hands a task to the actor and gets woken with the reply on a
    // later turn (the actor model, uniformly). Persist the correlation to the
    // durable mailbox FIRST (await the write so the record is on disk before any
    // actor side effect begins — closing the accept→persist window an SW death
    // could otherwise drop), then queue the wake. The actor's slot serializes its
    // turns (one actor per tab/instance), and deliver() wrapUntrusted-fences the
    // reply — so a web actor's page-derived reply is fenced like any other
    // untrusted content. A storage failure degrades to heap-only rather than
    // throwing.
    const correlationId = `${instanceId}:${++seq}:${nowMs}`;
    // Persist oneShot too, so a redrain after an SW restart re-runs the turn in the
    // same mode (a dropped flag would just fall back to a full summarize turn — safe,
    // but inconsistent). Older entries without the field redrain as full turns.
    // The provenance rides the envelope (phase 7) so a redrain can arbitrate —
    // notably rerouting a reply whose awaiting sender was an ephemeral subagent.
    await Promise.resolve(mailbox.append({
      id: correlationId, senderSessionId: sender, to: instanceId, message, createdAt: nowMs,
      provenance: { rootSessionId, lineagePath: provenance.lineagePath },
      ...(oneShot === true ? { oneShot: true } : {}),
    })).catch(() => {});

    // PR #134 — the SUBAGENT reply mode. An ephemeral child has no later turn
    // to wake (and waking its session would re-run it on the wrong exposure
    // surface — see the module header), so its reply resolves INTO this call.
    // The actor turn still queues/serializes on the actor's own slot exactly
    // like the async path; only the completion routing differs.
    if (awaitReply === true) {
      const settled = await new Promise((resolve) => {
        // Race the actor reply against the CALLING SUBAGENT's abort signal.
        // why: the subagent is suspended here in tool dispatch, and its loop
        // only observes the signal at wave boundaries — so its wall-clock
        // timeout / subagent_cancel (which fire this signal) cannot unwind this
        // await on their own. Without the race, a hung/queued actor turn parks
        // the child, its slot, and its parent's await indefinitely — the exact
        // "parked forever" failure the timeout exists to prevent. On abort we
        // ALSO stop the actor turn this child was waiting on (stopActorForAwait):
        // it is the child's delegate, so it should die with the child, not run
        // on orphaned. onReply and onAbort guard each other (first wins; the loser
        // is a no-op). runEngineDelivery is ALWAYS called so its trackActor/clear
        // bookkeeping stays symmetric and the mailbox entry is cleaned up even on
        // abort (its onReply is just a no-op by then).
        let done = false;
        const finish = (/** @type {{ text: string, failed: boolean }} */ v) => { if (!done) { done = true; resolve(v); } };
        // Queue the actor turn FIRST — so it captures the current Stop generation
        // BEFORE onAbort bumps it, letting the gen-skip actually cancel a queued turn.
        runEngineDelivery({
          correlationId, senderSessionId: sender, rootSessionId, actor, message,
          parentToolUseId: toolUseId, oneShot: oneShot === true,
          onReply: (text, failed) => finish({ text, failed }),
        });
        const onAbort = () => {
          stopActorForAwait(rootSessionId, actor.actorSessionId);
          finish({ text: replyText(instanceId, kind, name, 'the request was aborted (timeout or cancel) before the actor replied.', true), failed: true });
        };
        if (awaitSignal) {
          if (awaitSignal.aborted) onAbort();               // already aborted → resolve now
          else awaitSignal.addEventListener('abort', onAbort, { once: true });
        }
      });
      return settled.failed
        ? { ok: false, error: settled.text }
        : { ok: true, content: settled.text };
    }

    runEngineDelivery({ correlationId, senderSessionId: sender, rootSessionId, actor, message, parentToolUseId: toolUseId, oneShot: oneShot === true });

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
      // Phase 7 (envelope arbitration) — a redrained reply must reach a session
      // that can actually receive a wake. When the envelope's provenance says
      // the sender was NOT its own lineage root, the sender was an EPHEMERAL
      // subagent awaiting the reply in a tool call; that await died with the SW,
      // and waking the child's session would run an orphan turn on the wrong
      // exposure surface. Reroute to the ROOT — the chat that ultimately asked —
      // which handles it like any other fenced actor note. Entries without
      // provenance (pre-#134) keep the old sender-addressed behavior.
      const wakeTarget = (typeof e.provenance?.rootSessionId === 'string'
        && e.provenance.rootSessionId !== e.senderSessionId)
        ? e.provenance.rootSessionId
        : e.senderSessionId;
      if (wakeTarget !== e.senderSessionId) {
        appendAudit({ type: 'actor_reply_rerouted', details: { to: e.to, senderSessionId: e.senderSessionId, rootSessionId: wakeTarget } }).catch(() => {});
      }
      // The instance is gone (engine instance deleted, or a web actor's tab
      // closed) → abandon it; wake the target so it isn't left waiting on a reply
      // that can never come. A live instance (any kind, web included) re-runs.
      if (!actor) {
        deliver(wakeTarget, e.to, 'tab-hosted', undefined,
          'could not be reached after a restart (its instance may have been closed). Re-issue the request if it still matters.', true);
        mailbox.remove(e.id).catch(() => {});
        appendAudit({ type: 'actor_message_abandoned', details: { to: e.to, senderSessionId: e.senderSessionId } }).catch(() => {});
        continue;
      }
      inFlight.set(wakeTarget, (inFlight.get(wakeTarget) ?? 0) + 1);
      // Track the intent too (#4): runEngineDelivery's clear() unconditionally
      // untrackIntent()s on settle, so a redrained turn that never tracked would
      // decrement — and delete — a DIFFERENT live send's refcount, silently
      // defeating the dedupe guard. Mirror the live path's trackIntent here so
      // the ref is symmetric. Keyed on the resolved instanceId, as the live path.
      trackIntent(wakeTarget, intentKey(actor.instanceId, e.message));
      // senderSessionId here is the DELIVERY address (deliver() wakes it) and the
      // bookkeeping root on a redrain — for a rerouted entry both are the root.
      runEngineDelivery({ correlationId: e.id, senderSessionId: wakeTarget, rootSessionId: wakeTarget, actor, message: e.message, oneShot: e.oneShot === true });
      redrained += 1;
    }
    log('redrained', redrained);
    return { redrained };
  };

  return { messageActor, redrain, actorsFor, stopActorsFor };
};
